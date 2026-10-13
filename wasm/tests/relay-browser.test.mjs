/**
 * Isolated localhost-only genuine Chromium + original Toxcore WASM +
 * WebSocket -> real Node TCP -> WebSocket synthetic Relay handshake test.
 *
 * The "Relay" response ciphertext is prepared by ORIGINAL native crypto
 * inside the browser's research-only WASM. The Node loopback TCP fixture
 * simply returns those ciphertext bytes, proving async transport wiring,
 * NOT a real remote server's independent cryptographic identity.
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
import puppeteer from "puppeteer-core";

const base = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "b".repeat(64); // local fixture-only value, never an API token
const ALLOWED = new Map([
  ["/tests/relay-browser.html", "text/html; charset=utf-8"],
  ["/tests/relay-browser-runner.mjs", "text/javascript; charset=utf-8"],
  ["/browser/relay-browser-research.worker.mjs", "text/javascript; charset=utf-8"],
  ["/browser/relay-research-client.mjs", "text/javascript; charset=utf-8"],
  ["/browser/native-virtual-tcp.mjs", "text/javascript; charset=utf-8"],
  ["/browser/tcp-tunnel.mjs", "text/javascript; charset=utf-8"],
  ["/dist/tox_identity.mjs", "text/javascript; charset=utf-8"],
  ["/dist/tox_identity.wasm", "application/wasm"]
]);
function browserBinary() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  for (const name of ["google-chrome", "google-chrome-stable", "chromium"]) {
    try { return execFileSync("which", [name], { encoding: "utf8" }).trim(); }
    catch { /* continue */ }
  }
  throw Error("chromium_not_installed");
}
function responseFrame(chunk) {
  const frame = Buffer.alloc(chunk.length + 6);
  frame[0] = 1; frame[1] = 1;
  frame.writeUInt32BE(chunk.length, 2);
  chunk.copy(frame, 6);
  return frame;
}
test("original Toxcore WASM in Chromium validates synthetic Relay across local WebSocket and actual Node TCP", {
  timeout: 140000
}, async () => {
  assert.ok(existsSync(join(base, "dist/tox_identity.wasm")), "compile original WASM first");
  let origin;
  let fixture = null;
  let totalNativeHellos = 0;
  const server = createServer(async (req, res) => {
    let path;
    try { path = new URL(req.url, "http://127.0.0.1").pathname; }
    catch { res.writeHead(400); res.end(); return; }

    if (req.method === "POST" && path === "/__wtox_relay_fixture") {
      const mode = Number(req.headers["x-wtox-research-mode"]);
      if (req.headers.origin !== origin ||
          req.headers["x-wtox-research-token"] !== TOKEN ||
          req.headers["content-type"] !== "application/octet-stream" ||
          ![0, 1, 2, 3].includes(mode) || fixture !== null) {
        res.writeHead(403); res.end(); return;
      }
      const chunks = []; let len = 0;
      for await (const chunk of req) {
        len += chunk.length;
        if (len > 96) { res.writeHead(413); res.end(); return; }
        chunks.push(chunk);
      }
      if (len !== 96) { res.writeHead(400); res.end(); return; }
      fixture = { mode, response: Buffer.concat(chunks) };
      res.writeHead(204, { "Cache-Control": "no-store" });
      res.end();
      return;
    }
    if (req.method !== "GET" || !ALLOWED.has(path)) {
      res.writeHead(404); res.end(); return;
    }
    try {
      const bytes = await readFile(join(base, path.slice(1)));
      res.writeHead(200, {
        "Content-Type": ALLOWED.get(path),
        "Cache-Control": "no-store",
        "Cross-Origin-Resource-Policy": "same-origin",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' ws:; base-uri 'none'; form-action 'none'"
      });
      res.end(bytes);
    } catch { res.writeHead(404); res.end(); }
  });
  const tcpServer = createTcpServer(socket => {
    let hello = Buffer.alloc(0);
    let answered = false;
    socket.on("data", chunk => {
      if (answered) return; // ignore post-handshake bytes, never pretend to be a full relay
      hello = Buffer.concat([hello, chunk]);
      if (hello.length > 128) { socket.destroy(); return; }
      if (hello.length < 128) return;
      answered = true;
      totalNativeHellos++;
      if (fixture === null) { socket.destroy(); return; }
      const { mode, response } = fixture;
      fixture = null;
      if (mode === 3) {
        // Delayed real TCP fragments. They may be coalesced later by TCP;
        // original native socket parsing must be safe either way.
        const first = Buffer.from(response.subarray(0, 23));
        const second = Buffer.from(response.subarray(23));
        socket.write(first);
        setTimeout(() => {
          if (!socket.destroyed) socket.write(second);
          second.fill(0);
        }, 40);
      } else {
        socket.write(Buffer.from(response));
      }
      response.fill(0);
      hello.fill(0);
    });
  });
  const wss = new WebSocketServer({
    noServer: true, perMessageDeflate: false, maxPayload: 65542
  });
  let browser;
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  await new Promise(resolve => tcpServer.listen(0, "127.0.0.1", resolve));
  origin = "http://127.0.0.1:" + server.address().port;
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/__wtox_relay_research" ||
        req.headers.origin !== origin ||
        req.headers["sec-websocket-protocol"] !== "wtox-v1") {
      socket.destroy(); return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      let authorized = false;
      let tcp;
      ws.on("close", () => tcp?.destroy());
      ws.on("error", () => tcp?.destroy());
      ws.on("message", (input, binary) => {
        if (!authorized) {
          if (binary || input.length > 512) { ws.close(1008); return; }
          try {
            const data = JSON.parse(input.toString());
            if (data.type !== "authenticate" || data.token !== TOKEN) {
              ws.close(1008); return;
            }
          } catch { ws.close(1008); return; }
          authorized = true;
          // This gateway dials ONLY its own loopback TCP fixture.
          tcp = connectTcp(tcpServer.address().port, "127.0.0.1");
          tcp.on("connect", () => {
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: "ready" }));
          });
          tcp.on("data", chunk => {
            if (ws.readyState !== 1) return;
            for (let i = 0; i < chunk.length; i += 16384) {
              ws.send(responseFrame(chunk.subarray(i, i + 16384)));
            }
          });
          tcp.on("error", () => { if (ws.readyState === 1) ws.close(1011); });
          tcp.on("close", () => { if (ws.readyState === 1) ws.close(1000); });
          return;
        }
        if (!binary || !tcp?.writable || tcp.writableLength > 512 * 1024) {
          ws.close(1008); return;
        }
        const bytes = Buffer.from(input);
        if (bytes.length < 7 || bytes[0] !== 1 || bytes[1] !== 1 ||
            bytes.readUInt32BE(2) !== bytes.length - 6) {
          ws.close(1008); return;
        }
        tcp.write(bytes.subarray(6));
      });
    });
  });

  try {
    browser = await puppeteer.launch({
      executablePath: browserBinary(), headless: true,
      args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"]
    });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", err => errors.push(String(err.message).slice(0, 130)));
    await page.goto(origin + "/tests/relay-browser.html", { waitUntil: "load" });
    await page.waitForFunction(
      () => document.querySelector("#result")?.dataset.state !== "pending",
      { timeout: 105000 }
    );
    const result = await page.$eval("#result", el => ({
      state: el.dataset.state, text: el.textContent
    }));
    assert.equal(result.state, "passed", result.text + "; pageErrors=" + errors.join(" / "));
    assert.equal(totalNativeHellos, 4, "all four test modes must reach the real TCP fixture");
    await page.close();
  } finally {
    if (browser) await browser.close();
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => tcpServer.close(resolve));
    fixture?.response.fill(0);
  }
});
