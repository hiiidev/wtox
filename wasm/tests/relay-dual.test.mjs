/**
 * Test-only two-client c-toxcore TCP Relay. Both actual browser WASM clients
 * authenticate to ONE Node-owned ephemeral Relay. Node forwards opaque route
 * payloads only between distinct client sockets, never to the sender.
 * No arbitrary TCP proxy, Cloudflare, or public network. Friend messaging
 * is original Toxcore only in a dedicated loopback fixture.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createTcpServer, connect as connectTcp } from "node:net";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { WebSocketServer } from "ws";
import nacl from "tweetnacl";
import puppeteer from "puppeteer-core";

const base = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "d".repeat(64); // test-only, never ship as an access credential
const mime = new Map([
  ["/tests/relay-dual.html", "text/html; charset=utf-8"],
  ["/tests/relay-dual-runner.mjs", "text/javascript; charset=utf-8"],
  ["/browser/relay-dual.worker.mjs", "text/javascript; charset=utf-8"],
  ["/browser/relay-research-client.mjs", "text/javascript; charset=utf-8"],
  ["/browser/native-virtual-tcp.mjs", "text/javascript; charset=utf-8"],
  ["/browser/tcp-tunnel.mjs", "text/javascript; charset=utf-8"],
  ["/dist/tox_identity.mjs", "text/javascript; charset=utf-8"],
  ["/dist/tox_identity.wasm", "application/wasm"]
]);
function chromiumPath() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  for (const bin of ["google-chrome", "google-chrome-stable", "chromium"]) {
    try { return execFileSync("which", [bin], {encoding:"utf8"}).trim(); }
    catch { /* try next */ }
  }
  throw Error("chromium_not_installed");
}
function nextNonce(nonce) {
  for (let i=nonce.length-1; i>=0; --i) {
    nonce[i] = (nonce[i] + 1) & 255;
    if (nonce[i]) break;
  }
}
function tunnelFrame(bytes) {
  const b = Buffer.alloc(bytes.length + 6);
  b[0] = 1; b[1] = 1;
  b.writeUInt32BE(bytes.length, 2);
  Buffer.from(bytes).copy(b, 6);
  return b;
}
async function checkIndependentClients(mode) {
  assert.ok(existsSync(join(base, "dist/tox_identity.wasm")), "real compiled WASM required");
  const relay = nacl.box.keyPair();
  const sessions = new Map();
  const pendingRoles = new Map();
  const sockets = new Set();
  const metrics = { authenticated:0, routeRequests:0, notifications:0,
                    forwardAtoB:0, forwardBtoA:0, nativePings:0,
                    rejected:0 };
  let origin = "";
  const web = createServer(async (req, res) => {
    let pathname;
    try { pathname = new URL(req.url, "http://127.0.0.1").pathname; }
    catch { res.writeHead(400); res.end(); return; }
    if (req.method === "GET" && pathname === "/__wtox_dual_round_status" &&
        mode === "restart") {
      res.writeHead(200, {"Content-Type":"application/json",
                          "Cache-Control":"no-store"});
      res.end(JSON.stringify({roles:usedRoles.size,sessions:sessions.size,
        sockets:sockets.size,websockets:wss.clients.size}));
      return;
    }
    if (req.method === "GET" && pathname === "/__wtox_dual_public") {
      res.writeHead(200, {"Content-Type":"text/plain; charset=utf-8",
                          "Cache-Control":"no-store", "X-Content-Type-Options":"nosniff"});
      res.end(Buffer.from(relay.publicKey).toString("hex"));
      return;
    }
    if (req.method !== "GET" || !mime.has(pathname)) {
      res.writeHead(404); res.end(); return;
    }
    try {
      const bytes = await readFile(join(base, pathname.slice(1)));
      res.writeHead(200, {
        "Content-Type": mime.get(pathname),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Content-Security-Policy":
          "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' ws:; base-uri 'none'; form-action 'none'"
      });
      res.end(bytes);
    } catch { res.writeHead(404); res.end(); }
  });
  function shutdownBad(socket) { metrics.rejected++; socket.destroy(); }
  function bothRegistered() {
    return sessions.get("a")?.routeRequested && sessions.get("b")?.routeRequested;
  }
  const tcpServer = createTcpServer(socket => {
    sockets.add(socket);
    let hello = Buffer.alloc(0);
    let input = Buffer.alloc(0);
    let s = null;
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      sockets.delete(socket);
      if (s) {
        if (sessions.get(s.role) === s) sessions.delete(s.role);
        s.sessionKey?.fill(0);
        s.recvNonce?.fill(0);
        s.sendNonce?.fill(0);
        s.publicKey?.fill(0);
      }
      hello.fill(0);
      input.fill(0);
    });
    function sendSecure(target, packet) {
      if (!target || !target.sessionKey || target.socket.destroyed) return false;
      const cipher = nacl.box.after(packet, target.sendNonce, target.sessionKey);
      const frame = Buffer.alloc(2 + cipher.length);
      frame.writeUInt16BE(cipher.length, 0);
      frame.set(cipher, 2);
      target.socket.write(Buffer.from(frame)); // clone before wiping
      nextNonce(target.sendNonce);
      frame.fill(0); cipher.fill(0);
      return true;
    }
    function processSecure(chunk) {
      input = Buffer.concat([input, chunk]);
      if (input.length > 4096) { shutdownBad(socket); return; }
      while (input.length >= 2 && !socket.destroyed) {
        const n = input.readUInt16BE(0);
        if (n < 17 || n > 2048) { shutdownBad(socket); return; }
        if (input.length < n + 2) break;
        const message = nacl.box.open.after(input.subarray(2, n+2),
                                            s.recvNonce, s.sessionKey);
        if (!message || !message.length) { shutdownBad(socket); return; }
        const kind = message[0];
        if (kind === 4 && message.length === 9) {
          if (!sendSecure(s, Uint8Array.from([5, ...message.subarray(1)]))) {
            shutdownBad(socket); return;
          }
          metrics.nativePings++;
        } else if (kind === 0 && message.length === 33 && !s.routeRequested) {
          const peer = sessions.get(s.role === "a" ? "b" : "a");
          if (!peer || !Buffer.from(message.subarray(1)).equals(peer.publicKey)) {
            shutdownBad(socket); return;
          }
          s.routeRequested = true;
          metrics.routeRequests++;
          sendSecure(s, Uint8Array.from([1, 16, ...peer.publicKey]));
          if (bothRegistered() && !s.notified) {
            for (const target of sessions.values()) {
              target.notified = true;
              sendSecure(target, Uint8Array.from([2, 16]));
              metrics.notifications++;
            }
          }
        } else if (kind === 16 && message.length >= 2 &&
                   s.notified && bothRegistered()) {
          const otherRole = s.role === "a" ? "b" : "a";
          const other = sessions.get(otherRole);
          if (!other?.notified || !sendSecure(other, message)) {
            shutdownBad(socket); return;
          }
          if (s.role === "a") metrics.forwardAtoB++;
          else metrics.forwardBtoA++;
        } else {
          shutdownBad(socket); return;
        }
        nextNonce(s.recvNonce);
        message.fill(0);
        const remain = Buffer.from(input.subarray(n+2));
        input.fill(0);
        input = remain;
      }
    }
    socket.on("data", chunk => {
      if (socket.destroyed) return;
      if (s) { processSecure(chunk); return; }
      hello = Buffer.concat([hello, chunk]);
      if (hello.length > 512) { shutdownBad(socket); return; }
      if (hello.length < 128) return;
      const role = pendingRoles.get(socket.remotePort);
      if (!["a", "b"].includes(role) || sessions.has(role)) {
        shutdownBad(socket); return;
      }
      let longShared, clientPlain, ephemeral, plain, nonce, cipher;
      try {
        const clientKey = Uint8Array.from(hello.subarray(0, 32));
        longShared = nacl.box.before(clientKey, relay.secretKey);
        clientPlain = nacl.box.open.after(hello.subarray(56,128),
                                           hello.subarray(32,56), longShared);
        assert.ok(clientPlain && clientPlain.length === 56, "authenticated native hello");
        ephemeral = nacl.box.keyPair();
        plain = new Uint8Array(56);
        plain.set(ephemeral.publicKey);
        plain.set(nacl.randomBytes(24), 32);
        nonce = nacl.randomBytes(24);
        cipher = nacl.box.after(plain, nonce, longShared);
        assert.equal(cipher.length, 72);
        const reply = Buffer.concat([Buffer.from(nonce), Buffer.from(cipher)]);
        socket.write(Buffer.from(reply));
        reply.fill(0);
        s = {
          role, socket, publicKey:Buffer.from(clientKey),
          sessionKey:nacl.box.before(clientPlain.subarray(0,32), ephemeral.secretKey),
          recvNonce:Uint8Array.from(clientPlain.subarray(32,56)),
          sendNonce:Uint8Array.from(plain.subarray(32,56)),
          routeRequested:false, notified:false
        };
        sessions.set(role,s);
        metrics.authenticated++;
        const leftover = Buffer.from(hello.subarray(128));
        hello.fill(0); hello = Buffer.alloc(0);
        if (leftover.length) processSecure(leftover);
      } catch {
        shutdownBad(socket);
      } finally {
        longShared?.fill(0);
        clientPlain?.fill(0);
        ephemeral?.secretKey.fill(0);
        plain?.fill(0);
        nonce?.fill(0);
        cipher?.fill(0);
      }
    });
  });
  const wss = new WebSocketServer({noServer:true,perMessageDeflate:false,maxPayload:65542});
  await new Promise(resolve => web.listen(0, "127.0.0.1", resolve));
  await new Promise(resolve => tcpServer.listen(0, "127.0.0.1", resolve));
  origin = "http://127.0.0.1:" + web.address().port;
  const usedRoles = new Set();
  web.on("upgrade", (req, socket, head) => {
    let role;
    try {
      const parsed = new URL(req.url,origin);
      role = parsed.searchParams.get("role");
      if (parsed.pathname !== "/__wtox_dual_relay" ||
          parsed.searchParams.size !== 1 || !["a","b"].includes(role) ||
          usedRoles.has(role) || req.headers.origin !== origin ||
          req.headers["sec-websocket-protocol"] !== "wtox-v1") {
        socket.destroy(); return;
      }
    } catch { socket.destroy(); return; }
    usedRoles.add(role);
    wss.handleUpgrade(req,socket,head,ws => {
      let authed = false, tcp = null;
      ws.on("close",()=>usedRoles.delete(role));
      ws.on("close", () => tcp?.destroy());
      ws.on("error", () => tcp?.destroy());
      ws.on("message", (input, binary) => {
        if (!authed) {
          if (binary || input.length > 512) { ws.close(1008); return; }
          try {
            const parsed = JSON.parse(input.toString());
            if (parsed.type !== "authenticate" || parsed.token !== TOKEN) {
              ws.close(1008); return;
            }
          } catch { ws.close(1008); return; }
          authed = true;
          tcp = connectTcp(tcpServer.address().port, "127.0.0.1");
          tcp.on("connect", () => {
            pendingRoles.set(tcp.localPort, role);
            if (ws.readyState === 1) ws.send(JSON.stringify({type:"ready"}));
          });
          tcp.on("data", b => {
            if (ws.readyState !== 1) return;
            for (let i=0;i<b.length;i+=16384) {
              ws.send(tunnelFrame(b.subarray(i,i+16384)));
            }
          });
          tcp.on("error", () => {if(ws.readyState===1)ws.close(1011);});
          tcp.on("close", () => {
            pendingRoles.delete(tcp.localPort);
            if(ws.readyState===1)ws.close(1000);
          });
          return;
        }
        if (!binary || !tcp?.writable || tcp.writableLength > 512*1024) {
          ws.close(1008); return;
        }
        const b = Buffer.from(input);
        if (b.length < 7 || b[0] !== 1 || b[1] !== 1 ||
            b.readUInt32BE(2) !== b.length - 6) {
          ws.close(1008); return;
        }
        tcp.write(b.subarray(6));
      });
    });
  });
  let browser;
  try {
    browser = await puppeteer.launch({executablePath:chromiumPath(),headless:true,
      args:["--no-sandbox","--disable-gpu","--disable-dev-shm-usage"]});
    const page = await browser.newPage(), pageErrors = [];
    page.on("pageerror", e => pageErrors.push(String(e.message).slice(0,110)));
    await page.goto(origin + "/tests/relay-dual.html?mode=" + mode, {waitUntil:"load"});
    await page.waitForFunction(() =>
      document.querySelector("#result")?.dataset.state !== "pending",
      {timeout:65000});
    const state = await page.$eval("#result", el => ({
      state:el.dataset.state, message:el.textContent
    }));
    assert.equal(state.state,"passed",state.message+"; "+pageErrors.join("/"));
    const rounds = mode === "restart" ? 2 : 1;
    assert.equal(metrics.authenticated,2*rounds,
                 "two original authenticated Tox TCP handshakes in each round");
    assert.equal(metrics.routeRequests,2*rounds,
                 "two native reciprocal routing requests per round");
    assert.equal(metrics.notifications,2*rounds,
                 "both native routes connected in each round");
    if (mode === "raw") {
      assert.equal(metrics.forwardAtoB,1,"A payload forwarded to B, not echoed");
      assert.equal(metrics.forwardBtoA,1,"B payload forwarded to A, not echoed");
    } else {
      assert.ok(metrics.forwardAtoB >= 3, "native Tox A must exchange multiple E2E packets");
      assert.ok(metrics.forwardBtoA >= 3, "native Tox B must exchange multiple E2E packets");
    }
    assert.equal(metrics.rejected,0,"no protocol-invalid packets");
  } finally {
    if(browser)await browser.close();
    for(const ws of wss.clients)ws.terminate();
    for(const socket of sockets)socket.destroy();
    await new Promise(resolve=>wss.close(resolve));
    await new Promise(resolve=>web.close(resolve));
    await new Promise(resolve=>tcpServer.close(resolve));
    relay.secretKey.fill(0);
  }
}
for (const mode of ["raw", "crypto", "friend", "restart"]) {
  test("two original Chromium Toxcore clients: " + mode +
       " reciprocal Relay communication", {timeout:105000}, async () =>
       checkIndependentClients(mode));
}
