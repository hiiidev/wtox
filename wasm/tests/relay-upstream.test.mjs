/**
 * Chromium interoperability against ORIGINAL pinned c-toxcore TCP_Server.
 * Unlike relay-dual.test.mjs this Node layer does NOT implement or decrypt
 * Tox TCP protocol. It only forwards authenticated browser WS bytes to a
 * loopback native TCP socket owned by unmodified upstream TCP_server.c.
 *
 * No production servers, Cloudflare, public listener or public Tox peer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {createServer as createHttpServer} from "node:http";
import {createServer as createTcpServer, connect} from "node:net";
import {spawn, execFileSync} from "node:child_process";
import {existsSync} from "node:fs";
import {readFile} from "node:fs/promises";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {WebSocketServer} from "ws";
import puppeteer from "puppeteer-core";

const base = join(dirname(fileURLToPath(import.meta.url)), "..");
const nativeRelay = join(base, "dist/tox-relay-loopback");
const testToken = "d".repeat(64);
const assets = new Map([
  ["/tests/relay-dual.html", "text/html; charset=utf-8"],
  ["/tests/relay-dual-runner.mjs", "text/javascript; charset=utf-8"],
  ["/browser/relay-dual.worker.mjs", "text/javascript; charset=utf-8"],
  ["/browser/relay-research-client.mjs", "text/javascript; charset=utf-8"],
  ["/browser/native-virtual-tcp.mjs", "text/javascript; charset=utf-8"],
  ["/browser/tcp-tunnel.mjs", "text/javascript; charset=utf-8"],
  ["/dist/tox_identity.mjs", "text/javascript; charset=utf-8"],
  ["/dist/tox_identity.wasm", "application/wasm"]
]);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function chromium() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  for (const bin of ["google-chrome", "google-chrome-stable", "chromium"]) {
    try { return execFileSync("which", [bin], {encoding:"utf8"}).trim(); }
    catch { /* try another */ }
  }
  throw Error("chromium_unavailable");
}
function tunnelFrame(buffer) {
  const bytes = Buffer.from(buffer);
  const frame = Buffer.alloc(6 + bytes.length);
  frame[0] = 1; frame[1] = 1; frame.writeUInt32BE(bytes.length, 2);
  bytes.copy(frame, 6);
  return frame;
}
async function freePort() {
  const socket = createTcpServer();
  await new Promise((resolve,reject) =>
    socket.once("error",reject).listen(0,"127.0.0.1",resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}
async function originalRelay(port) {
  const child = spawn(nativeRelay,[String(port)],{stdio:["ignore","pipe","pipe"]});
  let stdout = "", stderr = "";
  const key = await new Promise((resolve,reject) => {
    const timeout = setTimeout(() => reject(Error("original_relay_ready_timeout")), 15000);
    const finish = (error,value) => {
      clearTimeout(timeout);
      if (error) reject(error); else resolve(value);
    };
    child.once("error",error => finish(error));
    child.once("exit",code => finish(Error("original_relay_exited:" + code + ":" + stderr)));
    child.stderr.on("data",chunk => {stderr = (stderr + chunk.toString()).slice(-1000);});
    child.stdout.on("data",chunk => {
      stdout = (stdout + chunk.toString()).slice(-1024);
      const match = stdout.match(/(?:^|\n)READY ([0-9a-f]{64})\r?\n/);
      if (match) finish(null,match[1]);
    });
  }).catch(error => {child.kill("SIGTERM"); throw error;});
  return {child,key};
}

async function verifyAgainstUpstream(mode) {
  assert.ok(existsSync(nativeRelay), "compiled pinned original TCP_Server is mandatory");
  assert.ok(existsSync(join(base,"dist/tox_identity.wasm")), "actual WASM required");
  const port = await freePort();
  const relay = await originalRelay(port);
  let browser, http, wss;
  const used = new Set(), tcpConnections = new Set();
  const metrics = {authenticated:0, aToRelay:0,bToRelay:0,relayToA:0,relayToB:0,
                   refused:0, relayStopped:false};
  relay.child.on("exit", () => {metrics.relayStopped=true;});
  try {
    let origin = "";
    wss = new WebSocketServer({noServer:true,perMessageDeflate:false,maxPayload:65542});
    http = createHttpServer(async(req,res) => {
      let pathname;
      try {pathname = new URL(req.url,"http://127.0.0.1").pathname;}
      catch {res.writeHead(400);res.end();return;}
      if(req.method === "GET" && pathname === "/__wtox_dual_public"){
        res.writeHead(200,{"Content-Type":"text/plain; charset=utf-8",
                           "Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});
        res.end(relay.key);return;
      }
      if(req.method === "GET" && pathname === "/__wtox_dual_round_status"){
        res.writeHead(200,{"Content-Type":"application/json","Cache-Control":"no-store"});
        res.end(JSON.stringify({roles:used.size,sessions:tcpConnections.size,
          sockets:tcpConnections.size,websockets:wss.clients.size}));return;
      }
      if(req.method !== "GET" || !assets.has(pathname)){
        res.writeHead(404);res.end();return;
      }
      try {
        const bytes = await readFile(join(base,pathname.slice(1)));
        res.writeHead(200,{"Content-Type":assets.get(pathname),
          "Cache-Control":"no-store",
          "X-Content-Type-Options":"nosniff",
          "Cross-Origin-Resource-Policy":"same-origin",
          "Content-Security-Policy":"default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' ws:; base-uri 'none'; form-action 'none'"});
        res.end(bytes);
      } catch {res.writeHead(404);res.end();}
    });
    await new Promise(resolve => http.listen(0,"127.0.0.1",resolve));
    origin = "http://127.0.0.1:" + http.address().port;
    http.on("upgrade",(req,socket,head) => {
      let role;
      try {
        const u = new URL(req.url,origin);
        role = u.searchParams.get("role");
        if (u.pathname !== "/__wtox_dual_relay" || u.searchParams.size !== 1 ||
            !["a","b"].includes(role) || used.has(role) ||
            req.headers.origin !== origin ||
            req.headers["sec-websocket-protocol"] !== "wtox-v1") {
          socket.destroy();return;
        }
      } catch {socket.destroy();return;}
      used.add(role);
      wss.handleUpgrade(req,socket,head,ws => {
        let tcp=null, authed=false;
        ws.on("error",()=>tcp?.destroy());
        ws.on("close",()=>{used.delete(role);tcp?.destroy();});
        ws.on("message",(message,isBinary) => {
          if (!authed) {
            if(isBinary || message.length > 512){ws.close(1008);return;}
            try {
              const parsed = JSON.parse(message.toString());
              if(parsed.type !== "authenticate" || parsed.token !== testToken)
                throw Error("bad_test_token");
            } catch {ws.close(1008);return;}
            authed=true;
            tcp = connect(port,"127.0.0.1");
            tcpConnections.add(tcp);
            tcp.on("connect",() => {
              ++metrics.authenticated;
              if(ws.readyState===1)ws.send(JSON.stringify({type:"ready"}));
            });
            tcp.on("error",()=>{if(ws.readyState===1)ws.close(1011);});
            tcp.on("close",()=>{
              tcpConnections.delete(tcp);
              if(ws.readyState===1)ws.close(1000);
            });
            tcp.on("data",bytes=>{
              if(ws.readyState!==1)return;
              if(role==="a")metrics.relayToA+=bytes.length;
              else metrics.relayToB+=bytes.length;
              for(let i=0;i<bytes.length;i+=16384)
                ws.send(tunnelFrame(bytes.subarray(i,i+16384)));
            });
            return;
          }
          if(!isBinary || !tcp?.writable || tcp.writableLength>512*1024) {
            ++metrics.refused;ws.close(1008);return;
          }
          const b=Buffer.from(message);
          if(b.length<7 || b[0]!==1 || b[1]!==1 ||
             b.readUInt32BE(2)!==b.length-6){
            ++metrics.refused;ws.close(1008);return;
          }
          if(role==="a")metrics.aToRelay+=b.length-6;
          else metrics.bToRelay+=b.length-6;
          tcp.write(b.subarray(6));
        });
      });
    });
    browser=await puppeteer.launch({executablePath:chromium(),headless:true,
      args:["--no-sandbox","--disable-gpu","--disable-dev-shm-usage"]});
    const page=await browser.newPage(), pageErrors=[];
    page.on("pageerror",e=>pageErrors.push(String(e.message).slice(0,120)));
    await page.goto(origin+"/tests/relay-dual.html?mode="+mode,{waitUntil:"load"});
    await page.waitForFunction(() =>
      document.querySelector("#result")?.dataset.state !== "pending",
      {timeout:70000});
    const state=await page.$eval("#result",el=>({
      status:el.dataset.state,message:el.textContent
    }));
    assert.equal(state.status,"passed",
      "original TCP_Server interop failed: "+state.message+" "+pageErrors.join("; "));
    assert.equal(metrics.authenticated,mode==="restart"?4:2,
      "each independent Chromium client must authenticate to real Tox TCP Server");
    const minimumOutbound=mode==="request"?127:200;
    assert.ok(metrics.aToRelay>minimumOutbound &&
              metrics.bToRelay>minimumOutbound,
      "both browser clients must establish an authenticated native TCP session");
    assert.ok(metrics.relayToA>90 && metrics.relayToB>90,
      "original TCP_Server must send authenticated responses to both clients");
    assert.equal(metrics.refused,0,"WS framing was well-formed");
    assert.equal(metrics.relayStopped,false,"native upstream relay must remain alive");
  } finally {
    if(browser)await browser.close();
    if(wss){
      for(const client of wss.clients)client.terminate();
      await new Promise(resolve=>wss.close(resolve));
    }
    for(const tcp of tcpConnections)tcp.destroy();
    if(http)await new Promise(resolve=>http.close(resolve));
    relay.child.kill("SIGTERM");
    await Promise.race([
      new Promise(resolve=>relay.child.once("exit",resolve)),
      wait(2000).then(()=>relay.child.kill("SIGKILL"))
    ]);
  }
}
for(const mode of ["friend","restart","request"]){
  test("original c-toxcore native TCP_Server and two Chromium WASM peers: "+mode,
       {timeout:115000},async()=>verifyAgainstUpstream(mode));
}
