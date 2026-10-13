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
const ROUTE_PEER_KEY = Buffer.from(Array.from({length:32}, (_,i) => i+41));
const ROUTE_PAYLOAD = Buffer.from([0, 1, 127, 128, 254, 255]);
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
// Toxcore v0.2.23 increments the 24-byte nonce in BIG-endian order.
function incrementToxNonce(nonce) {
  for (let i = nonce.length - 1; i >= 0; --i) {
    nonce[i] = (nonce[i] + 1) & 255;
    if (nonce[i] !== 0) break;
  }
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
  let invalidPostHandshakePackets = 0;
  const validPongs = new Map();
  const encryptedPings = new Map();
  const respondedClientPings = new Map();
  const routedRequests = new Map();
  const routedNotifications = new Map();
  const routedPayloads = new Map();
  const routedEchoes = new Map();
  const requestedModes = new Map();
  let origin = "";
  const web = createServer(async (req, res) => {
    let pathname;
    try { pathname = new URL(req.url, "http://127.0.0.1").pathname; }
    catch { res.writeHead(400); res.end(); return; }
    if (req.method === "GET" && pathname === "/__wtox_independent_stats") {
      const url = new URL(req.url, origin);
      const mode = url.searchParams.get("mode");
      if (url.searchParams.size !== 1 || !/^[01]$/.test(mode)) {
        res.writeHead(404); res.end(); return;
      }
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      });
      res.end(JSON.stringify({
        pings: encryptedPings.get(Number(mode)) || 0,
        pongs: validPongs.get(Number(mode)) || 0,
        nativePingReplies: respondedClientPings.get(Number(mode)) || 0,
        routeRequests: routedRequests.get(Number(mode)) || 0,
        routeNotifications: routedNotifications.get(Number(mode)) || 0,
        routePayloads: routedPayloads.get(Number(mode)) || 0,
        routeEchoes: routedEchoes.get(Number(mode)) || 0
      }));
      return;
    }
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
    let postHandshake = Buffer.alloc(0);
    let answered = false;
    let mode;
    let sessionKey;
    let recvNonce;
    let sendNonce;
    let pingId;
    let pingTimer;
    // Encrypt one original Tox TCP control frame with Node-owned
    // ephemeral relay shared key and increment send nonce exactly once.
    function sendSecure(payload) {
      if (!sessionKey || !sendNonce || socket.destroyed) return;
      const sealed = nacl.box.after(payload, sendNonce, sessionKey);
      const frame = Buffer.alloc(2 + sealed.length);
      frame.writeUInt16BE(sealed.length, 0);
      frame.set(sealed, 2);
      socket.write(Buffer.from(frame));
      incrementToxNonce(sendNonce);
      frame.fill(0);
      sealed.fill(0);
    }
    socket.on("close", () => {
      if (pingTimer) clearTimeout(pingTimer);
      hello.fill(0);
      postHandshake.fill(0);
      sessionKey?.fill(0);
      recvNonce?.fill(0);
      sendNonce?.fill(0);
      pingId?.fill(0);
    });
    socket.on("data", data => {
      if (answered) {
        if (mode > 1 || !sessionKey || !recvNonce) return;
        postHandshake = Buffer.concat([postHandshake, data]);
        if (postHandshake.length > 4096) { socket.destroy(); return; }
        while (postHandshake.length >= 2) {
          const size = postHandshake.readUInt16BE(0);
          if (size < 17 || size > 2048) { socket.destroy(); return; }
          if (postHandshake.length < size + 2) break; // TCP partial frame
          const encrypted = postHandshake.subarray(2, size + 2);
          const decoded = nacl.box.open.after(encrypted, recvNonce, sessionKey);
          if (!decoded || decoded.length < 2) {
            invalidPostHandshakePackets++;
            socket.destroy();
            return;
          }
          if (decoded[0] === 0 && decoded.length === 33 &&
              Buffer.from(decoded.subarray(1)).equals(ROUTE_PEER_KEY)) {
            // Original c-toxcore (TCP_Connections) issued this encrypted
            // routing request, NOT the JS client. Assign the first route
            // id, 16, and send a server-owned encrypted confirmation.
            routedRequests.set(mode, (routedRequests.get(mode) || 0) + 1);
            if (routedRequests.get(mode) !== 1) {
              invalidPostHandshakePackets++; socket.destroy(); return;
            }
            sendSecure(Uint8Array.from([1,16,...ROUTE_PEER_KEY]));
            sendSecure(Uint8Array.from([2,16]));
            routedNotifications.set(mode, (routedNotifications.get(mode) || 0) + 1);
          } else if (decoded[0] === 16 && decoded.length === ROUTE_PAYLOAD.length + 1 &&
                     routedRequests.get(mode) === 1 &&
                     routedNotifications.get(mode) === 1 &&
                     Buffer.from(decoded.subarray(1)).equals(ROUTE_PAYLOAD)) {
            // The independent Node relay can decrypt transport-only route
            // data. Re-encrypt a reply with the next server nonce; native
            // Toxcore must dispatch it through its TCP routing callback.
            routedPayloads.set(mode, (routedPayloads.get(mode) || 0) + 1);
            if (routedPayloads.get(mode) !== 1) {
              invalidPostHandshakePackets++; socket.destroy(); return;
            }
            sendSecure(Uint8Array.from([16, ...ROUTE_PAYLOAD]));
            routedEchoes.set(mode, (routedEchoes.get(mode) || 0) + 1);
          } else if (decoded[0] === 4 && decoded.length === 9) {
            // Original c-toxcore initiates its own encrypted PING promptly
            // after confirmation. A real Relay must answer with the same
            // 8-byte identifier, before our delayed server-initiated PING.
            const pong = Uint8Array.from([5, ...decoded.subarray(1)]);
            const encryptedPong = nacl.box.after(pong, sendNonce, sessionKey);
            const response = Buffer.alloc(2 + encryptedPong.length);
            response.writeUInt16BE(encryptedPong.length, 0);
            response.set(encryptedPong, 2);
            socket.write(Buffer.from(response));
            incrementToxNonce(sendNonce);
            respondedClientPings.set(mode, (respondedClientPings.get(mode) || 0) + 1);
            response.fill(0);
            encryptedPong.fill(0);
            pong.fill(0);
          } else if (decoded[0] === 5 && decoded.length === 9 && pingId &&
                     Buffer.from(decoded.subarray(1)).equals(pingId)) {
            validPongs.set(mode, (validPongs.get(mode) || 0) + 1);
          } else {
            invalidPostHandshakePackets++;
            socket.destroy();
            return;
          }
          incrementToxNonce(recvNonce); // native uses big-endian 24-byte nonce
          postHandshake = Buffer.from(postHandshake.subarray(size + 2));
        }
        return;
      }
      hello = Buffer.concat([hello, data]);
      if (hello.length > 128) { socket.destroy(); return; }
      if (hello.length < 128) return;
      answered = true;
      incomingHellos++;
      mode = requestedModes.get(socket.remotePort);
      if (![0,1,2,3].includes(mode)) { socket.destroy(); return; }
      let shared, replyShared, wrongSecret, nonce, plain, ciphertext, ephemeral;
      try {
        shared = nacl.box.before(hello.subarray(0,32), relayKey.secretKey);
        const clientPayload = nacl.box.open.after(
          hello.subarray(56,128), hello.subarray(32,56), shared);
        assert.ok(clientPayload && clientPayload.length === 56,
          "Node must independently decrypt original Toxcore client hello");
        validClientHellos++;
        ephemeral = nacl.box.keyPair();
        plain = new Uint8Array(56);
        plain.set(ephemeral.publicKey);
        plain.set(nacl.randomBytes(24), 32);
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
        if (mode === 3) reply[reply.length - 1] ^= 1;
        if (mode === 1) {
          const tail = Buffer.from(reply.subarray(23));
          socket.write(Buffer.from(reply.subarray(0, 23)));
          setTimeout(() => {
            if (!socket.destroyed) socket.write(tail);
            tail.fill(0);
          }, 35);
        } else socket.write(Buffer.from(reply));
        reply.fill(0);
        if (mode <= 1) {
          // After the native handshake, the client and server derive a NEW
          // ephemeral shared key. The two nonce streams are independent.
          sessionKey = nacl.box.before(clientPayload.subarray(0,32), ephemeral.secretKey);
          recvNonce = Uint8Array.from(clientPayload.subarray(32,56));
          sendNonce = Uint8Array.from(plain.subarray(32,56));
          pingId = Buffer.from(nacl.randomBytes(8));
          pingTimer = setTimeout(() => {
            if (socket.destroyed) return;
            const command = Uint8Array.from([4, ...pingId]); // Tox TCP PING
            const body = nacl.box.after(command, sendNonce, sessionKey);
            const frame = Buffer.alloc(2 + body.length);
            frame.writeUInt16BE(body.length, 0);
            frame.set(body, 2);
            // Node may retain the write buffer until it reaches the kernel.
            // Clone it so immediate sensitive-buffer wiping cannot alter
            // an in-flight authenticated TCP control frame.
            socket.write(Buffer.from(frame));
            incrementToxNonce(sendNonce);
            encryptedPings.set(mode, (encryptedPings.get(mode) || 0) + 1);
            frame.fill(0);
            command.fill(0);
            body.fill(0);
          }, mode === 1 ? 210 : 160);
        }
        clientPayload.fill(0);
      } catch {
        socket.destroy();
      } finally {
        hello.fill(0);
        shared?.fill(0);
        if (replyShared && replyShared !== shared) replyShared.fill(0);
        wrongSecret?.fill(0);
        nonce?.fill(0);
        plain?.fill(0);
        ciphertext?.fill(0);
        ephemeral?.secretKey.fill(0);
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
    assert.equal(encryptedPings.get(0), 1, "independent Relay must send encrypted Tox PING");
    assert.equal(encryptedPings.get(1), 1, "fragmented handshake must support encrypted Tox PING");
    assert.equal(validPongs.get(0), 1, "Node must decrypt native Toxcore encrypted PONG");
    assert.equal(validPongs.get(1), 1, "Node must decrypt PONG after fragmented valid handshake");
    assert.ok((respondedClientPings.get(0) || 0) >= 1,
      "Node must answer original Toxcore-initiated encrypted PING");
    assert.ok((respondedClientPings.get(1) || 0) >= 1,
      "Node must also answer native PING after fragmented handshake");
    assert.equal(routedRequests.get(0), 1, "native Tox must request route over authenticated relay");
    assert.equal(routedRequests.get(1), 1, "fragmented handshake must still permit route request");
    assert.equal(routedNotifications.get(0), 1, "Node must send routing response and notification");
    assert.equal(routedNotifications.get(1), 1, "Node must notify after fragmented handshake");
    assert.equal(routedPayloads.get(0), 1, "Node must decrypt the original native binary route payload");
    assert.equal(routedPayloads.get(1), 1, "fragmented handshake must support native route data");
    assert.equal(routedEchoes.get(0), 1, "Node must respond with encrypted routed data");
    assert.equal(routedEchoes.get(1), 1, "fragmented handshake must support encrypted routed reply");
    assert.equal(invalidPostHandshakePackets, 0, "post-handshake frames must be authenticated");
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
