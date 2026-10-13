/**
 * Stage 25d: independent pinned native c-toxcore DHT bootstrap and genuine
 * Chromium WASM tox_bootstrap() / tox_iterate() / Network_Funcs UDP.
 * Node is a restricted byte-for-byte bridge only, not an emulated DHT peer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {createSocket} from "node:dgram";
import {spawn,execFileSync} from "node:child_process";
import {readFile} from "node:fs/promises";
import {existsSync} from "node:fs";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
import {WebSocketServer} from "ws";
import puppeteer from "puppeteer-core";

const root=join(dirname(fileURLToPath(import.meta.url)),"..");
const nativeBinary=join(root,"dist/tox-udp-friend-receiver");
const TOKEN="f".repeat(64);
const mime=new Map([
  ["/tests/dht-friend.html","text/html; charset=utf-8"],
  ["/tests/dht-friend-runner.mjs","text/javascript; charset=utf-8"],
  ["/browser/dht-friend.worker.mjs","text/javascript; charset=utf-8"],
  ["/dist/tox_identity.mjs","text/javascript; charset=utf-8"],
  ["/dist/tox_identity.wasm","application/wasm"]
]);
function chrome(){
  if(process.env.CHROME_BIN)return process.env.CHROME_BIN;
  for(const candidate of ["google-chrome","google-chrome-stable","chromium"]){
    try{return execFileSync("which",[candidate],{encoding:"utf8"}).trim();}
    catch{/* next */}
  }
  throw Error("chromium_not_installed");
}
async function openUdp(sock){
  await new Promise((resolve,reject)=>{
    sock.once("error",reject);
    sock.bind(0,"127.0.0.1",resolve);
  });
}
async function freePort(){
  const sock=createSocket("udp4");
  await openUdp(sock);
  const port=sock.address().port;
  await new Promise(resolve=>sock.close(resolve));
  return port;
}
async function launchNative(port,receiverPort){
  const child=spawn(nativeBinary,[String(port),String(receiverPort)],
                    {stdio:["ignore","pipe","pipe"]});
  let stdout="",stderr="";
  child.stderr.on("data",buf=>{stderr=(stderr+buf.toString()).slice(-2000);});
  const details=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error("native_dht_ready_timeout:"+stderr)),12000);
    const finish=(e,v)=>{clearTimeout(timer);e?reject(e):resolve(v);};
    child.on("error",finish);
    child.on("exit",code=>finish(Error("native_dht_exited_early:"+code+":"+stderr)));
    child.stdout.on("data",bytes=>{
      stdout=(stdout+bytes.toString()).slice(-1024);
      const found=stdout.match(/(?:^|\n)READY ([0-9a-f]{64}) ([0-9a-f]{76})\r?\n/);
      if(found)finish(null,{key:found[1],receiverToxId:found[2]});
    });
  }).catch(error=>{child.kill("SIGTERM");throw error;});
  return {child,...details,logs:()=>stdout};
}
async function stopNative(child) {
  if(!child || child.exitCode!==null || child.signalCode!==null)return;
  const done=new Promise(resolve=>child.once("exit",resolve));
  child.kill("SIGTERM");
  await Promise.race([done,new Promise(resolve=>
    setTimeout(()=>{child.kill("SIGKILL");resolve();},1600))]);
}
test("original Chromium WASM sends real Onion Tox ID friend request to independent Linux native receiver and exchanges text",{
  timeout:135000
},async()=>{
  assert.ok(existsSync(nativeBinary),"native original c-toxcore DHT bootstrap is required");
  assert.ok(existsSync(join(root,"dist/tox_identity.wasm")),
            "real original Toxcore WASM required");
  const nativePort=await freePort();
  let receiverPort=await freePort();
  while(receiverPort===nativePort)receiverPort=await freePort();
  const native=await launchNative(nativePort,receiverPort);
  const osSocket=createSocket("udp4");
  let server=null,wss=null,browser=null;
  const metrics={sent:0,received:0,invalid:0,clients:0};
  try {
    await openUdp(osSocket);
    wss=new WebSocketServer({noServer:true,perMessageDeflate:false,maxPayload:4096});
    server=createServer(async(req,res)=>{
      let path;
      try {path=new URL(req.url,"http://127.0.0.1").pathname;}
      catch {res.writeHead(400);res.end();return;}
      if(req.method==="GET"&&path==="/__wtox_dht_target"){
        res.writeHead(200,{"Content-Type":"application/json",
          "Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});
        res.end(JSON.stringify({token:TOKEN,port:nativePort,
          proxyPort:osSocket.address().port,receiverPort,
          receiverToxId:native.receiverToxId,publicKey:native.key}));
        return;
      }
      if(req.method!=="GET"||!mime.has(path)){res.writeHead(404);res.end();return;}
      try{
        const bytes=await readFile(join(root,path.slice(1)));
        res.writeHead(200,{"Content-Type":mime.get(path),
          "Cache-Control":"no-store","X-Content-Type-Options":"nosniff",
          "Cross-Origin-Resource-Policy":"same-origin",
          "Content-Security-Policy":
            "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' ws:; base-uri 'none'; form-action 'none'"});
        res.end(bytes);
      }catch{res.writeHead(404);res.end();}
    });
    await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
    const origin="http://127.0.0.1:"+server.address().port;
    let used=false;
    server.on("upgrade",(req,sock,head)=>{
      if(used || req.url!=="/__wtox_dht_bridge" ||
         req.headers.origin!==origin ||
         req.headers["sec-websocket-protocol"]!=="wtox-udp-v1"){
        sock.destroy();return;
      }
      used=true;
      wss.handleUpgrade(req,sock,head,ws=>{
        ++metrics.clients;
        let authed=false;
        const receive=(bytes,from)=>{
          if(from.address!=="127.0.0.1" ||
             ![nativePort,receiverPort,osSocket.address().port].includes(from.port) ||
             !bytes.length || bytes.length>2048) {
            ++metrics.invalid;return;
          }
          if(ws.readyState!==1 || !authed)return;
          const frame=Buffer.alloc(bytes.length+5);
          frame[0]=1;frame.writeUInt16BE(from.port,1);
          frame.writeUInt16BE(bytes.length,3);
          bytes.copy(frame,5);
          ++metrics.received;
          ws.send(frame);
        };
        osSocket.on("message",receive);
        ws.on("close",()=>osSocket.off("message",receive));
        ws.on("message",(message,binary)=>{
          if(!authed){
            if(binary||message.length>256){ws.close(1008);return;}
            try{
              const auth=JSON.parse(message.toString());
              if(auth.type!=="authenticate"||auth.token!==TOKEN)
                throw Error("invalid_auth");
            }catch{ws.close(1008);return;}
            authed=true;ws.send(JSON.stringify({type:"ready"}));return;
          }
          const bytes=Buffer.from(message);
          if(!binary || bytes.length<6 || bytes.length>2053 ||
             bytes[0]!==1 ||
             ![nativePort,receiverPort,osSocket.address().port].includes(bytes.readUInt16BE(1)) ||
             bytes.readUInt16BE(3)!==bytes.length-5) {
            ++metrics.invalid;ws.close(1008);return;
          }
          ++metrics.sent;
          osSocket.send(bytes.subarray(5),bytes.readUInt16BE(1),"127.0.0.1");
        });
      });
    });
    browser=await puppeteer.launch({headless:true,executablePath:chrome(),
      args:["--no-sandbox","--disable-dev-shm-usage","--disable-gpu"]});
    const page=await browser.newPage(),pageErrors=[];
    page.on("pageerror",e=>pageErrors.push(e.message.slice(0,200)));
    await page.goto(origin+"/tests/dht-friend.html",{waitUntil:"load"});
    await page.waitForFunction(()=>
      document.querySelector("#result")?.dataset.state!=="pending",
      {timeout:105000});
    const state=await page.$eval("#result",el=>({
      status:el.dataset.state,text:el.textContent,publicKey:el.dataset.publicKey
    }));
    assert.equal(state.status,"passed",
      "original Toxcore DHT bootstrap: "+state.text+" errors="+pageErrors.join(";"));
    assert.match(state.publicKey,/^[0-9a-f]{64}$/);
    // Native stdout is emitted by the ORIGINAL tox_callback_friend_request,
    // status and message callbacks, never synthesized by Node.
    for(let tries=0;tries<80;tries++){
      if(native.logs().includes("TEXT_SENT"))break;
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    const log=native.logs();
    assert.match(log,new RegExp("REQUEST_RECEIVED "+state.publicKey));
    assert.match(log,/FRIEND_ONLINE/);
    assert.match(log,/TEXT_RECEIVED/);
    assert.match(log,/TEXT_SENT/);
    assert.ok(metrics.sent>=2 && metrics.received>=2,
      "real Tox DHT handshake must traverse native OS UDP in both directions");
    assert.equal(metrics.clients,1,"a single isolated browser DHT client");
    assert.equal(metrics.invalid,0,"no forbidden datagrams or invalid UDP frames");
    assert.equal(pageErrors.length,0,"no browser JavaScript errors");
    assert.equal(native.child.exitCode,null,"original native DHT bootstrap stays alive");
  }finally{
    if(browser)await browser.close();
    if(wss){
      for(const client of wss.clients)client.terminate();
      await new Promise(resolve=>wss.close(resolve));
    }
    if(server)await new Promise(resolve=>server.close(resolve));
    await new Promise(resolve=>osSocket.close(resolve));
    await stopNative(native.child);
  }
});
