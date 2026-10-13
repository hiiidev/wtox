/**
 * Browser WebSocket to actual localhost OS UDP echo, original Toxcore
 * Network_Funcs sendto/recvfrom running inside a real Chromium Worker.
 * No simulated UDP echo in JS, no arbitrary UDP proxy, no DHT success claim.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {createSocket} from "node:dgram";
import {readFile} from "node:fs/promises";
import {existsSync} from "node:fs";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
import {execFileSync} from "node:child_process";
import {WebSocketServer} from "ws";
import puppeteer from "puppeteer-core";

const base=join(dirname(fileURLToPath(import.meta.url)),"..");
const TOKEN="b".repeat(64); // single-use localhost CI fixture only
const mime=new Map([
  ["/tests/udp-browser.html","text/html; charset=utf-8"],
  ["/tests/udp-browser-runner.mjs","text/javascript; charset=utf-8"],
  ["/browser/udp-probe.worker.mjs","text/javascript; charset=utf-8"],
  ["/dist/tox_identity.mjs","text/javascript; charset=utf-8"],
  ["/dist/tox_identity.wasm","application/wasm"]
]);
function chromium(){
  if(process.env.CHROME_BIN)return process.env.CHROME_BIN;
  for(const candidate of ["google-chrome","google-chrome-stable","chromium"]){
    try{return execFileSync("which",[candidate],{encoding:"utf8"}).trim();}
    catch{/* try another */}
  }
  throw Error("chromium_unavailable");
}
async function bindUdp(s){
  await new Promise((resolve,reject)=>{
    s.once("error",reject);
    s.bind(0,"127.0.0.1",resolve);
  });
}
test("actual Chromium native c-toxcore UDP Network_Funcs preserves 16 bounded datagrams across WebSocket and real OS UDP echo",{
  timeout:90000
},async()=>{
  assert.ok(existsSync(join(base,"dist/tox_identity.wasm")),
            "genuine compiled c-toxcore WASM required");
  const echo=createSocket("udp4"),proxy=createSocket("udp4");
  let server=null,wss=null,browser=null;
  const metrics={incoming:0,echoed:0,osReplies:0,invalid:0};
  try{
    await Promise.all([bindUdp(echo),bindUdp(proxy)]);
    const echoPort=echo.address().port;
    echo.on("message",(bytes,remote)=>{
      if(remote.address!=="127.0.0.1"){
        ++metrics.invalid;return;
      }
      ++metrics.echoed;
      echo.send(bytes,remote.port,"127.0.0.1");
    });
    server=createServer(async(req,res)=>{
      let path;
      try{path=new URL(req.url,"http://127.0.0.1").pathname;}
      catch{res.writeHead(400);res.end();return;}
      if(req.method==="GET"&&path==="/__wtox_udp_target"){
        res.writeHead(200,{"Content-Type":"application/json",
          "Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});
        res.end(JSON.stringify({token:TOKEN,port:echoPort}));
        return;
      }
      if(req.method!=="GET"||!mime.has(path)){
        res.writeHead(404);res.end();return;
      }
      try {
        const contents=await readFile(join(base,path.slice(1)));
        res.writeHead(200,{"Content-Type":mime.get(path),
          "Cache-Control":"no-store","Cross-Origin-Resource-Policy":"same-origin",
          "X-Content-Type-Options":"nosniff",
          "Content-Security-Policy":
          "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' ws:; base-uri 'none'; form-action 'none'"});
        res.end(contents);
      }catch{res.writeHead(404);res.end();}
    });
    await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
    const origin="http://127.0.0.1:"+server.address().port;
    wss=new WebSocketServer({noServer:true,perMessageDeflate:false,maxPayload:4096});
    server.on("upgrade",(req,sock,head)=>{
      if(req.url!=="/__wtox_udp_bridge" ||
         req.headers.origin!==origin ||
         req.headers["sec-websocket-protocol"]!=="wtox-udp-v1"){
        sock.destroy();return;
      }
      wss.handleUpgrade(req,sock,head,ws=>{
        let authed=false;
        const onOSMessage=(bytes,from)=>{
          if(!authed || ws.readyState!==1)return;
          if(from.address!=="127.0.0.1"||from.port!==echoPort ||
             !bytes.length||bytes.length>2048) {
            ++metrics.invalid;return;
          }
          ++metrics.osReplies;
          const frame=Buffer.alloc(5+bytes.length);
          frame[0]=1;frame.writeUInt16BE(from.port,1);
          frame.writeUInt16BE(bytes.length,3);bytes.copy(frame,5);
          ws.send(frame);
        };
        proxy.on("message",onOSMessage);
        ws.on("close",()=>proxy.off("message",onOSMessage));
        ws.on("message",(message,isBinary)=>{
          if(!authed){
            if(isBinary||message.length>256){ws.close(1008);return;}
            try{
              const auth=JSON.parse(message.toString());
              if(auth.type!=="authenticate"||auth.token!==TOKEN)
                throw Error("invalid_token");
            }catch{ws.close(1008);return;}
            authed=true;
            ws.send(JSON.stringify({type:"ready"}));
            return;
          }
          const bytes=Buffer.from(message);
          if(!isBinary||bytes.length<6||bytes.length>2053 ||
             bytes[0]!==1||bytes.readUInt16BE(1)!==echoPort ||
             bytes.readUInt16BE(3)!==bytes.length-5) {
            ++metrics.invalid;ws.close(1008);return;
          }
          ++metrics.incoming;
          proxy.send(bytes.subarray(5),echoPort,"127.0.0.1");
        });
      });
    });
    browser=await puppeteer.launch({executablePath:chromium(),headless:true,
      args:["--no-sandbox","--disable-gpu","--disable-dev-shm-usage"]});
    const page=await browser.newPage(), errors=[];
    page.on("pageerror",e=>errors.push(String(e.message).slice(0,200)));
    await page.goto(origin+"/tests/udp-browser.html",{waitUntil:"load"});
    await page.waitForFunction(()=>
      document.querySelector("#result")?.dataset.state!=="pending",
      {timeout:45000});
    const state=await page.$eval("#result",el=>({
      status:el.dataset.state, text:el.textContent
    }));
    assert.equal(state.status,"passed",
      "original native Network_Funcs UDP bridge: "+state.text+
      " page errors: "+errors.join("; "));
    assert.equal(metrics.incoming,16,"16 complete UDP datagrams from original ns_sendto");
    assert.equal(metrics.echoed,16,"16 datagrams reached actual OS UDP socket");
    assert.equal(metrics.osReplies,16,"16 datagrams traversed real OS UDP on return");
    assert.equal(metrics.invalid,0,"no malformed packets, forbidden destinations or off-loopback traffic");
    assert.equal(errors.length,0,"no browser JavaScript exception");
  }finally{
    if(browser)await browser.close();
    if(wss){
      for(const client of wss.clients)client.terminate();
      await new Promise(resolve=>wss.close(resolve));
    }
    if(server)await new Promise(resolve=>server.close(resolve));
    await Promise.all([new Promise(resolve=>echo.close(resolve)),
                       new Promise(resolve=>proxy.close(resolve))]);
  }
});
