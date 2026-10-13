/**
 * Loopback-only actual Chromium + actual compiled WASM + Node TCP echo through an authenticated WebSocket.
 * The bridge uses the existing v1 auth/frame format; no Tox relay handshake.
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
const mime = new Map([
  ["/tests/vtcp-browser.html", "text/html; charset=utf-8"],
  ["/tests/vtcp-browser-runner.mjs", "text/javascript; charset=utf-8"],
  ["/browser/virtual-tcp-test.worker.mjs", "text/javascript; charset=utf-8"],
  ["/browser/native-virtual-tcp.mjs", "text/javascript; charset=utf-8"],
  ["/browser/tcp-tunnel.mjs", "text/javascript; charset=utf-8"],
  ["/dist/tox_identity.mjs", "text/javascript; charset=utf-8"],
  ["/dist/tox_identity.wasm", "application/wasm"]
]);
function chromePath() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  for (const name of ["google-chrome", "google-chrome-stable", "chromium"]) {
    try { return execFileSync("which", [name], { encoding: "utf8" }).trim(); }
    catch { /* try next binary */ }
  }
  throw Error("chromium_not_installed");
}
test("native WASM virtual TCP streams exact bytes through browser WebSocket and loopback echo", {
  timeout: 90000
}, async () => {
  assert.ok(existsSync(join(base, "dist/tox_identity.wasm")), "must compile original c-toxcore WASM");
  const server = createServer(async (req, res) => {
    let path;
    try { path = new URL(req.url, "http://127.0.0.1").pathname; }
    catch { res.writeHead(400); res.end(); return; }
    if (req.method !== "GET" || !mime.has(path)) {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      const contents = await readFile(join(base, path.slice(1)));
      res.writeHead(200, {
        "Content-Type": mime.get(path),
        "Cache-Control": "no-store",
        "Cross-Origin-Resource-Policy": "same-origin",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' ws:; base-uri 'none'; form-action 'none'"
      });
      res.end(contents);
    } catch {
      res.writeHead(404); res.end();
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const tcpServer = createTcpServer(socket => socket.pipe(socket));
  await new Promise(resolve => tcpServer.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 65542 });
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/__wtox_vtcp_experiment" ||
        request.headers.origin !== origin ||
        request.headers["sec-websocket-protocol"] !== "wtox-v1") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, ws => {
      let authenticated = false;
      let tcp = null;
      ws.on("close", () => tcp?.destroy());
      ws.on("error", () => tcp?.destroy());
      ws.on("message", (message, isBinary) => {
        if (!authenticated) {
          if (isBinary || message.length > 512) { ws.close(1008); return; }
          try {
            const auth = JSON.parse(message.toString());
            if (auth.type !== "authenticate" || auth.token !== "a".repeat(64)) {
              ws.close(1008); return;
            }
          } catch { ws.close(1008); return; }
          authenticated = true;
          // This is a genuine local Node TCP socket, not a JS-only echo.
          tcp = connectTcp(tcpServer.address().port, "127.0.0.1");
          tcp.once("connect", () => {
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: "ready" }));
          });
          tcp.on("data", chunk => {
            if (ws.readyState !== 1) return;
            for (let i = 0; i < chunk.length; i += 16384) {
              const payload = chunk.subarray(i, i + 16384);
              const frame = new Uint8Array(payload.length + 6);
              frame[0] = 1; frame[1] = 1;
              new DataView(frame.buffer).setUint32(2, payload.length, false);
              frame.set(payload, 6);
              ws.send(frame);
            }
          });
          tcp.on("error", () => ws.close(1011));
          tcp.on("close", () => { if (ws.readyState === 1) ws.close(1000); });
          return;
        }
        if (!isBinary || !tcp?.writable || tcp.writableLength > 512 * 1024) {
          ws.close(1008); return;
        }
        const data = new Uint8Array(message);
        const length = data.length >= 6 ?
          new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(2, false) : -1;
        if (data.length < 7 || data[0] !== 1 || data[1] !== 1 ||
            length !== data.length - 6) {
          ws.close(1008); return;
        }
        tcp.write(data.subarray(6));
      });
    });
  });
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: chromePath(), headless: true,
      args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"]
    });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(String(error.message).slice(0, 150)));
    await page.goto(origin + "/tests/vtcp-browser.html", { waitUntil: "load" });
    await page.waitForFunction(
      () => document.querySelector("#result")?.dataset.state !== "pending",
      { timeout: 45000 }
    );
    const state = await page.$eval("#result", node => ({
      state: node.dataset.state, text: node.textContent
    }));
    assert.equal(state.state, "passed", state.text + ": " + errors.join(" / "));
    await page.close();
  } finally {
    if (browser) await browser.close();
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => tcpServer.close(resolve));
  }
});
