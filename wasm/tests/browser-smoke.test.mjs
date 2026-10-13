/**
 * Drive a genuine Google Chrome / Chromium browser preinstalled on hosted
 * GitHub Actions runners. No downloads of third-party browser binaries.
 * Serve ONLY research artifacts from 127.0.0.1 with strict same-origin CSP.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import puppeteer from "puppeteer-core";

const base = join(dirname(fileURLToPath(import.meta.url)), "..");
const resources = new Map([
  ["/tests/browser-smoke.html", "text/html; charset=utf-8"],
  ["/tests/browser-runner.mjs", "text/javascript; charset=utf-8"],
  ["/browser/tox-identity.worker.mjs", "text/javascript; charset=utf-8"],
  ["/browser/identity-client.mjs", "text/javascript; charset=utf-8"],
  ["/dist/tox_identity.mjs", "text/javascript; charset=utf-8"],
  ["/dist/tox_identity.wasm", "application/wasm"]
]);

function executablePath() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  for (const cmd of ["google-chrome", "google-chrome-stable", "chromium"]) {
    try { return execFileSync("which", [cmd], { encoding: "utf8" }).trim(); }
    catch { /* try next */ }
  }
  throw Error("system_chrome_not_available");
}

test("real Chromium Dedicated Worker loads compiled WASM and restores an encrypted native Tox identity", {
  timeout: 90000
}, async () => {
  assert.ok(existsSync(join(base, "dist/tox_identity.wasm")), "Compile with npm run build first");
  const server = createServer(async (request, response) => {
    const path = new URL(request.url || "/", "http://127.0.0.1").pathname;
    if (request.method !== "GET" || !resources.has(path)) {
      response.writeHead(404);
      response.end();
      return;
    }
    try {
      const body = await readFile(join(base, path.slice(1)));
      response.writeHead(200, {
        "Content-Type": resources.get(path),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Content-Security-Policy": "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'"
      });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: executablePath(),
      headless: true,
      args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"]
    });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(String(error.message).slice(0, 180)));
    await page.goto(
      "http://127.0.0.1:" + server.address().port + "/tests/browser-smoke.html",
      { waitUntil: "load", timeout: 30000 }
    );
    await page.waitForFunction(
      () => document.querySelector("#result")?.dataset.state !== "pending",
      { timeout: 45000 }
    );
    const state = await page.$eval("#result", node => ({
      state: node.dataset.state,
      message: node.textContent
    }));
    assert.equal(state.state, "passed", state.message + "; pageErrors=" + errors.join(" / "));
    await page.close();
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
