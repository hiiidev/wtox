/**
 * Cross-runtime interop: Chromium c-toxcore WASM friend and a SECOND,
 * independently running Linux-native c-toxcore Tox process via a THIRD,
 * original pinned Linux TCP_Server. The Node bridge does NOT implement,
 * authenticate, decrypt, inspect or route Tox protocol payloads.
 *
 * Peer DHT public keys are injected for localhost discovery only. This is
 * not qTox/aTox interop, internet discovery, nor a public gateway.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {createServer as httpServer} from "node:http";
import {createServer as tcpServer, connect} from "node:net";
import {spawn, execFileSync} from "node:child_process";
import {readFile} from "node:fs/promises";
import {existsSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {WebSocketServer} from "ws";
import puppeteer from "puppeteer-core";

const base = join(dirname(fileURLToPath(import.meta.url)),"..");
const relayBinary = join(base,"dist/tox-relay-loopback");
const nativeBinary = join(base,"dist/tox-linux-peer");
const token="d".repeat(64); // localhost CI-only WS authentication token
const expectedBrowserText="From-A: original Tox friend message";
const expectedLinuxText="From-B: independent Linux native Tox client";
const assets = new Map([
  ["/tests/relay-linux.html","text/html; charset=utf-8"],
  ["/tests/relay-linux-runner.mjs","text/javascript; charset=utf-8"],
  ["/browser/relay-dual.worker.mjs","text/javascript; charset=utf-8"],
  ["/browser/relay-research-client.mjs","text/javascript; charset=utf-8"],
  ["/browser/native-virtual-tcp.mjs","text/javascript; charset=utf-8"],
  ["/browser/tcp-tunnel.mjs","text/javascript; charset=utf-8"],
  ["/dist/tox_identity.mjs","text/javascript; charset=utf-8"],
  ["/dist/tox_identity.wasm","application/wasm"]
]);
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
async function port() {
  const server=tcpServer();
  await new Promise((resolve,reject)=>
    server.once("error",reject).listen(0,"127.0.0.1",resolve));
  const number=server.address().port;
  await new Promise(resolve=>server.close(resolve));
  return number;
}
function binaryChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  for(const bin of ["google-chrome","google-chrome-stable","chromium"]){
    try{return execFileSync("which",[bin],{encoding:"utf8"}).trim();}
    catch{/* try another */}
  }
  throw Error("chromium_unavailable");
}
function frame(bytes){
  const b=Buffer.from(bytes),f=Buffer.alloc(b.length+6);
  f[0]=1;f[1]=1;f.writeUInt32BE(b.length,2);b.copy(f,6);
  return f;
}
function createLines(child) {
  const events=[];
  let stdout="",stderr="";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data",chunk=>{
    stdout+=chunk;
    if(stdout.length>8192) throw Error("native_stdout_unbounded");
    let end;
    while((end=stdout.indexOf("\n"))>=0){
      const line=stdout.slice(0,end).replace(/\r$/,"");
      stdout=stdout.slice(end+1);
      if(line.length>260)events.push("ERROR native_line_too_long");
      else events.push(line);
    }
  });
  child.stderr.on("data",chunk=>{stderr=(stderr+chunk).slice(-2000);});
  child.on("error",e=>events.push("ERROR spawn_"+e.message));
  child.on("exit",code=>events.push("EXIT "+code));
  async function get(prefix,timeoutMs=35000){
    const deadline=Date.now()+timeoutMs;
    do {
      const problem=events.find(x=>x.startsWith("ERROR ")||x.startsWith("EXIT "));
      if(problem)throw Error("native_process_"+problem+" "+stderr);
      const found=events.find(x=>x===prefix || x.startsWith(prefix+" "));
      if(found)return found;
      await sleep(25);
    }while(Date.now()<deadline);
    throw Error("native_event_timeout_"+prefix+" "+stderr);
  }
  return {events,get};
}
async function browserEvent(page,type,timeout=35000) {
  await page.waitForFunction(wanted =>
    window.__crossEvents?.some(e=>e.type===wanted || e.type==="ERROR"),
    {timeout},type);
  const events=await page.evaluate(()=>window.__crossEvents);
  const error=events.find(e=>e.type==="ERROR");
  if(error)throw Error("chromium_peer_"+error.error);
  const event=events.find(e=>e.type===type);
  if(!event)throw Error("browser_event_missing_"+type);
  return event;
}
async function terminateChild(child) {
  if(!child || child.exitCode!==null || child.signalCode!==null)return;
  const exited=new Promise(resolve=>child.once("exit",resolve));
  child.kill("SIGTERM");
  await Promise.race([exited,sleep(2000).then(()=>child.kill("SIGKILL"))]);
}

test("original TCP_Server interop: Linux OS-network Tox friend exchanges messages with Chromium WASM Tox friend",{
  timeout:110000
},async()=>{
  assert.ok(existsSync(relayBinary) && existsSync(nativeBinary),
            "both independent native binaries must come from pinned c-toxcore build");
  assert.ok(existsSync(join(base,"dist/tox_identity.wasm")),
            "compiled original WASM required");

  const relayPort=await port();
  const relay=spawn(relayBinary,[String(relayPort)],
                    {stdio:["ignore","pipe","pipe"]});
  const relayOutput=createLines(relay);
  let linux=null, browser=null, http=null, wss=null;
  const tcpSockets=new Set();
  const metrics={connections:0,up:0,down:0,rejected:0};
  try {
    const ready=await relayOutput.get("READY",12000);
    const match=/^READY ([0-9a-f]{64})$/.exec(ready);
    assert.ok(match,"original upstream server must expose just its public key");
    const relayPublicKey=match[1];
    let origin="";
    wss=new WebSocketServer({noServer:true,perMessageDeflate:false,maxPayload:65542});
    http=httpServer(async(req,res)=>{
      let path;
      try {path=new URL(req.url,"http://127.0.0.1").pathname;}
      catch {res.writeHead(400);res.end();return;}
      if(req.method==="GET" && path==="/__wtox_dual_public"){
        res.writeHead(200,{"Content-Type":"text/plain; charset=utf-8",
          "Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});
        res.end(relayPublicKey);return;
      }
      if(req.method!=="GET" || !assets.has(path)){
        res.writeHead(404);res.end();return;
      }
      try{
        const bytes=await readFile(join(base,path.slice(1)));
        res.writeHead(200,{"Content-Type":assets.get(path),
          "Cache-Control":"no-store",
          "X-Content-Type-Options":"nosniff",
          "Cross-Origin-Resource-Policy":"same-origin",
          "Content-Security-Policy":
          "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' ws:; base-uri 'none'; form-action 'none'"});
        res.end(bytes);
      }catch{res.writeHead(404);res.end();}
    });
    await new Promise(resolve=>http.listen(0,"127.0.0.1",resolve));
    origin="http://127.0.0.1:"+http.address().port;
    let used=false;
    http.on("upgrade",(req,sock,head)=>{
      try {
        const u=new URL(req.url,origin);
        if(u.pathname!=="/__wtox_dual_relay" ||
           u.searchParams.size!==1 || u.searchParams.get("role")!=="a" ||
           used || req.headers.origin!==origin ||
           req.headers["sec-websocket-protocol"]!=="wtox-v1"){
          sock.destroy();return;
        }
      }catch{sock.destroy();return;}
      used=true;
      wss.handleUpgrade(req,sock,head,ws=>{
        let linked=null,authed=false;
        ws.on("close",()=>linked?.destroy());
        ws.on("error",()=>linked?.destroy());
        ws.on("message",(message,isBinary)=>{
          if(!authed){
            try{
              const auth=JSON.parse(message.toString());
              if(isBinary || auth.type!=="authenticate" ||
                 auth.token!==token || message.length>512)
                throw Error("invalid_auth");
            }catch{ws.close(1008);return;}
            authed=true;
            linked=connect(relayPort,"127.0.0.1");
            tcpSockets.add(linked);
            linked.on("connect",()=>{
              ++metrics.connections;
              if(ws.readyState===1)ws.send(JSON.stringify({type:"ready"}));
            });
            linked.on("data",b=>{
              metrics.down+=b.length;
              if(ws.readyState!==1)return;
              for(let i=0;i<b.length;i+=16384)
                ws.send(frame(b.subarray(i,i+16384)));
            });
            linked.on("error",()=>{
              if(ws.readyState===1)ws.close(1011);
            });
            linked.on("close",()=>{
              tcpSockets.delete(linked);
              if(ws.readyState===1)ws.close(1000);
            });
            return;
          }
          const b=Buffer.from(message);
          if(!isBinary || !linked?.writable || linked.writableLength>512*1024 ||
             b.length<7 || b[0]!==1 || b[1]!==1 ||
             b.readUInt32BE(2)!==b.length-6){
            ++metrics.rejected;ws.close(1008);return;
          }
          metrics.up+=b.length-6;
          linked.write(b.subarray(6));
        });
      });
    });

    linux=spawn(nativeBinary,[String(relayPort),relayPublicKey],
                 {stdio:["pipe","pipe","pipe"]});
    const linuxIO=createLines(linux);
    browser=await puppeteer.launch({
      executablePath:binaryChrome(),headless:true,
      args:["--no-sandbox","--disable-gpu","--disable-dev-shm-usage"]
    });
    const page=await browser.newPage();
    const pageErrors=[];
    page.on("pageerror",e=>pageErrors.push(e.message.slice(0,150)));
    await page.goto(origin+"/tests/relay-linux.html",{waitUntil:"load"});
    const [linuxReady,browserReady]=await Promise.all([
      linuxIO.get("READY"),
      browserEvent(page,"READY")
    ]);
    const linuxMatch=/^READY ([0-9a-f]{64}) ([0-9a-f]{64})$/.exec(linuxReady);
    assert.ok(linuxMatch,"native Linux peer must expose distinct public identity and DHT keys");
    assert.match(browserReady.cryptoPublicKey,/^[0-9a-f]{64}$/);
    assert.match(browserReady.publicKey,/^[0-9a-f]{64}$/);
    assert.notEqual(linuxMatch[1],browserReady.cryptoPublicKey);
    assert.notEqual(linuxMatch[2],browserReady.publicKey);
    // Only PUBLIC DHT and public identity keys are exchanged locally.
    linux.stdin.write("PEER "+browserReady.cryptoPublicKey+
                      " "+browserReady.publicKey+"\n");
    await page.evaluate((real,dht)=>{
      window.__crossSend("ROUTE",{peerCryptoPublicKey:real,peerPublicKey:dht});
    },linuxMatch[1],linuxMatch[2]);
    await Promise.all([
      linuxIO.get("PEER_SET"),linuxIO.get("ONLINE",50000),
      browserEvent(page,"ROUTED",50000)
    ]);
    linux.stdin.write("SEND\n");
    await page.evaluate(()=>window.__crossSend("SEND"));
    const [linuxMsg,received]=await Promise.all([
      linuxIO.get("MESSAGE",35000),browserEvent(page,"RECEIVED",35000)
    ]);
    await linuxIO.get("SENT",35000);
    assert.equal(linuxMsg,
                 "MESSAGE "+Buffer.from(expectedBrowserText,"utf8").toString("hex"),
                 "independent Linux Tox callback must receive original browser friend text");
    assert.deepEqual(received.bytes,Array.from(new TextEncoder().encode(expectedLinuxText)),
      "browser's original Tox friend callback must receive Linux native text");
    assert.ok(metrics.up>200 && metrics.down>200 &&
              metrics.connections===1 && metrics.rejected===0,
              "browser and native server must exchange well-formed transport ciphertext");
    assert.equal(pageErrors.length,0,"browser should not have page errors");
    assert.ok(!relayOutput.events.some(x=>x.startsWith("EXIT ")),
              "original upstream TCP_Server must remain running");
  }finally{
    if(browser)await browser.close();
    if(wss){
      for(const ws of wss.clients)ws.terminate();
      await new Promise(resolve=>wss.close(resolve));
    }
    for(const sock of tcpSockets)sock.destroy();
    if(http)await new Promise(resolve=>http.close(resolve));
    await terminateChild(linux);
    await terminateChild(relay);
  }
});
