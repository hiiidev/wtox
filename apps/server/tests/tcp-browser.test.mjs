/**
 * Real Chromium browser -> WebSocket -> opt-in Node bridge -> TCP echo.
 * The Toxcore virtual socket implementation and native interoperability
 * are NOT part of this test. No internet egress or user identities involved.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer, connect } from "node:net";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import puppeteer from "puppeteer-core";
import { installExperimentalTcpBridge, EXPERIMENTAL_PATH } from "../src/experimental-tcp-bridge.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const token = "1".repeat(64);
const approved = { host: "1.1.1.1", port: 33445, publicKey: "a".repeat(64) };

function chromePath() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  for (const binary of ["google-chrome", "google-chrome-stable", "chromium"]) {
    try { return execFileSync("which", [binary], { encoding: "utf8" }).trim(); }
    catch { /* next */ }
  }
  throw Error("system_chromium_not_installed");
}

test("real Chromium page completes binary WSS/TCP loopback transport roundtrip", {
  timeout: 45000
}, async () => {
  const tcp = createTcpServer(socket => socket.pipe(socket));
  await new Promise(resolve => tcp.listen(0, "127.0.0.1", resolve));
  const server = createHttpServer(async (req, res) => {
    if (req.url !== "/browser/tcp-tunnel.mjs") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "default-src 'none'; script-src 'self'; connect-src 'self' ws:; base-uri 'none'; form-action 'none'",
        "X-Content-Type-Options": "nosniff"
      });
      res.end("<!doctype html><title>Tox tunnel research</title>");
      return;
    }
    try {
      const bytes = await readFile(join(root, "wasm/browser/tcp-tunnel.mjs"));
      res.writeHead(200, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      });
      res.end(bytes);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const origin = "http://127.0.0.1:" + port;
  const bridge = installExperimentalTcpBridge(server, {
    origin, token, endpoint: approved, allowlist: [approved],
    dial: () => connect(tcp.address().port, "127.0.0.1")
  });
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: chromePath(), headless: true,
      args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"]
    });
    const page = await browser.newPage();
    await page.goto(origin + "/", { waitUntil: "load" });
    const result = await page.evaluate(async ({ port, token, path }) => {
      const { openExperimentalTcpTunnel } = await import("/browser/tcp-tunnel.mjs");
      const expected = [0, 1, 127, 128, 255];
      let done;
      const reply = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("browser_tcp_timeout")), 4000);
        done = chunk => {
          clearTimeout(timer);
          resolve(Array.from(chunk));
        };
      });
      const tunnel = await openExperimentalTcpTunnel(
        "ws://127.0.0.1:" + port + path, token, { onBytes: done }
      );
      try {
        tunnel.send(Uint8Array.from(expected));
        return { bytes: await reply, closedBeforeClose: tunnel.closed };
      } finally {
        tunnel.close();
      }
    }, { port, token, path: EXPERIMENTAL_PATH });
    assert.deepEqual(result, { bytes: [0, 1, 127, 128, 255], closedBeforeClose: false });
    await page.close();
  } finally {
    if (browser) await browser.close();
    bridge.close();
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => tcp.close(resolve));
  }
});
