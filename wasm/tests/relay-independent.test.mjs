/**
 * Test-only independent Node TCP Relay crypto fixture. Node owns the
 * long-term Relay SECRET; Chromium obtains only its 32-byte public key.
 * Node decrypts the original c-toxcore hello via standard TweetNaCl
 * X25519/XSalsa20-Poly1305 and returns its own authenticated response.
 * No Internet egress or user identity is involved.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createTcpServer, connect as connectTcp } from "node:net";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { WebSocketServer } from "ws";
import nacl from "tweetnacl";
import puppeteer from "puppeteer-core";

const base = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "c".repeat(64); // test-only local fixture token
const mime = new Map([
  ["/tests/relay-independent.html", "text/html; charset=utf-8"],
  ["/tests/relay-independent-runner.mjs", "text/javascript; charset=utf-8"],
  ["/browser/relay-independent.worker.mjs", "text/javascript; charset=utf-8"],
  ["/browser/relay-research-client.mjs", "text/javascript; charset=utf-8"],
  ["/browser/native-virtual-tcp.mjs", "text/javascript; charset=utf-8"],
  ["/browser/tcp-tunnel.mjs", "text/javascript; charset=utf-8"],
  ["/dist/tox_identity.mjs", "text/javascript; charset=utf-8"],
  ["/dist/tox_identity.wasm", "application/wasm"]
]);
function chrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  for (const n of ["google-chrome", "google-chrome-stable", "chromium"]) {
    try { return execFileSync("which", [n], { encoding: "utf8" }).trim(); }
    catch { /* next */ }
  }
  throw Error("chromium_not_installed");
}
function wsFrame(chunk) {
  const frame = Buffer.allocUnsafe(chunk.length + 6);
  frame[0] = 1;
  frame[1] = 1;
  frame.writeUInt32BE(chunk.length, 2);
  Buffer.from(chunk).copy(frame, 6);
  return frame;
}
test("Chromium Toxcore authenticates an independently keyed Node TCP Relay fixture and rejects false keys", {
  timeout: 160000
}, async () => {
  assert.ok(existsSync(join(base, "dist/tox_identity.wasm")), "WASM build is required");
  const relayKey = nacl.box.keyPair(); // private key NEVER sent to Chromium
  let validClientHellos = 0;
  let incomingHellos = 0;
  const requestedModes = new Map();
  let origin = "";
  const web = createServer(async (req, res) => {
    let pathname;
    try { pathname = new URL(req.url, "http://127.0.0.1").pathname; }
    catch { res.writeHead(400); res.end(); return; }
    if (req.method === "GET" && pathname === "/__wtox_independent_public") {
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      });
      res.end(Buffer.from(relayKey.publicKey).toString("hex"));
      return;
    }
    if (req.method !== "GET" || !mime.has(pathname)) {
      res.writeHead(404); res.end(); return;
    }
    try {
      const body = await readFile(join(base, pathname.slice(1)));
      res.writeHead(200, {
        "Content-Type": mime.get(pathname),
        "Cache-Control": "no-store",
        "Cross-Origin-Resource-Policy": "same-origin",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' ws:; base-uri 'none'; form-action 'none'"
      });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  const tcpServer = createTcpServer(socket => {
    let hello = Buffer.alloc(0);
    let answered = false;
    socket.on("data", data => {
      if (answered) return;
      hello = Buffer.concat([hello, data]);
      if (hello.length > 128) { socket.destroy(); return; }
      if (hello.length < 128) return;
      answered = true;
      incomingHellos++;
      const mode = requestedModes.get(socket.remotePort);
      if (![0, 1, 2, 3].includes(mode)) { socket.destroy(); return; }
      let shared, replyShared, wrongSecret, nonce, plain, ciphertext, ephemeral;
      try {
        shared = nacl.box.before(hello.subarray(0,32), relayKey.secretKey);
        const clientPayload = nacl.box.open.after(
          hello.subarray(56,128), hello.subarray(32,56), shared);
        assert.ok(clientPayload && clientPayload.length === 56,
          "Independent Node Relay must decrypt original Toxcore client handshake");
        validClientHellos++;
        clientPayload.fill(0);
        ephemeral = nacl.box.keyPair();
        plain = new Uint8Array(56);
        plain.set(ephemeral.publicKey);
        plain.set(nacl.randomBytes(24),32);
        nonce = nacl.randomBytes(24);
        if (mode === 2) {
          wrongSecret = nacl.box.keyPair().secretKey;
          replyShared = nacl.box.before(hello.subarray(0,32), wrongSecret);
        } else {
          replyShared = shared;
        }
        ciphertext = nacl.box.after(plain, nonce, replyShared);
        assert.equal(ciphertext.length, 72);
        const reply = Buffer.concat([Buffer.from(nonce), Buffer.from(ciphertext)]);
        if (mode === 3) reply[reply.length-1] ^= 1;
        if (mode === 1) {
          const tail = Buffer.from(reply.subarray(23));
          socket.write(Buffer.from(reply.subarray(0,23)));
          setTimeout(() => {
            if (!socket.destroyed) socket.write(tail);
            tail.fill(0);
          }, 35);
        } else {
          socket.write(reply);
        }
        reply.fill(0);
      } catch {
        socket.destroy();
      } finally {
        hello.fill(0);
        if (shared) shared.fill(0);
        if (replyShared && replyShared !== shared) replyShared.fill(0);
        if (wrongSecret) wrongSecret.fill(0);
        if (nonce) nonce.fill(0);
        if (plain) plain.fill(0);
        if (ciphertext) ciphertext.fill(0);
        if (ephemeral) ephemeral.secretKey.fill(0);
      }
    });
  });
  const wss = new WebSocketServer({ noServer:true, perMessageDeflate:false, maxPayload:65542 });
  await new Promise(resolve => web.listen(0, "127.0.0.1", resolve));
  await new Promise(resolve => tcpServer.listen(0, "127.0.0.1", resolve));
  origin = "http://127.0.0.1:" + web.address().port;
  web.on("upgrade", (req, socket, head) => {
    let pathname, mode;
    try {
      const url = new URL(req.url, origin);
      pathname = url.pathname;
      const value = url.searchParams.get("mode");
      mode = value !== null && /^[0-3]$/.test(value) ? Number(value) : null;
      if (url.searchParams.size !== 1) mode = null;
    } catch { socket.destroy(); return; }
    if (pathname !== "/__wtox_independent_relay" || mode === null ||
        req.headers.origin !== origin ||
        req.headers["sec-websocket-protocol"] !== "wtox-v1") {
      socket.destroy(); return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      let authed = false;
      let tcp = null;
      ws.on("close", () => tcp?.destroy());
      ws.on("error", () => tcp?.destroy());
      ws.on("message", (input, binary) => {
        if (!authed) {
          if (binary || input.length > 512) { ws.close(1008); return; }
          try {
            const request = JSON.parse(input.toString());
            if (request.type !== "authenticate" || request.token !== TOKEN) {
              ws.close(1008); return;
            }
          } catch { ws.close(1008); return; }
          authed = true;
          tcp = connectTcp(tcpServer.address().port, "127.0.0.1");
          tcp.on("connect", () => {
            requestedModes.set(tcp.localPort, mode);
            if (ws.readyState === 1) ws.send(JSON.stringify({ type:"ready" }));
          });
          tcp.on("data", chunk => {
            if (ws.readyState !== 1) return;
            for (let i=0; i<chunk.length; i+=16384) {
              ws.send(wsFrame(chunk.subarray(i,i+16384)));
            }
          });
          tcp.on("error", () => { if (ws.readyState === 1) ws.close(1011); });
          tcp.on("close", () => {
            requestedModes.delete(tcp.localPort);
            if (ws.readyState === 1) ws.close(1000);
          });
          return;
        }
        if (!binary || !tcp?.writable || tcp.writableLength > 512*1024) {
          ws.close(1008); return;
        }
        const frame = Buffer.from(input);
        if (frame.length < 7 || frame[0] !== 1 || frame[1] !== 1 ||
            frame.readUInt32BE(2) !== frame.length-6) {
          ws.close(1008); return;
        }
        tcp.write(frame.subarray(6));
      });
    });
  });
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: chrome(), headless:true,
      args:["--no-sandbox","--disable-gpu","--disable-dev-shm-usage"]
    });
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", e => pageErrors.push(String(e.message).slice(0,140)));
    await page.goto(origin+"/tests/relay-independent.html", { waitUntil:"load" });
    await page.waitForFunction(
      () => document.querySelector("#result")?.dataset.state !== "pending",
      { timeout:115000 }
    );
    const state = await page.$eval("#result", el => ({
      state:el.dataset.state, message:el.textContent
    }));
    assert.equal(state.state, "passed", state.message+"; pageErrors="+pageErrors.join("/"));
    assert.equal(incomingHellos, 4, "all handshake scenarios must reach Node TCP");
    assert.equal(validClientHellos, 4, "Node must independently decrypt all genuine client hellos");
    await page.close();
  } finally {
    if (browser) await browser.close();
    for (const client of wss.clients) client.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => web.close(resolve));
    await new Promise(resolve => tcpServer.close(resolve));
    relayKey.secretKey.fill(0);
  }
});
