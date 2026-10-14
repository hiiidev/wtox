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
import {readFile,mkdtemp,readdir,rm,stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {existsSync} from "node:fs";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
import {WebSocketServer} from "ws";
import puppeteer from "puppeteer-core";

const root=join(dirname(fileURLToPath(import.meta.url)),"..");
const nativeBinary=join(root,"dist/tox-udp-friend-receiver");
const TOKEN="f".repeat(64);
const mime=new Map([
  ["/tests/local-chat.html","text/html; charset=utf-8"],
  ["/tests/local-chat.css","text/css; charset=utf-8"],
  ["/tests/local-chat-ui.mjs","text/javascript; charset=utf-8"],
  ["/browser/local-chat.worker.mjs","text/javascript; charset=utf-8"],
  ["/browser/bounded-udp-inbox.mjs","text/javascript; charset=utf-8"],
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
test("local manual chat UI: genuine Chromium Tox ID form, friend online, typed message and native reply",{
  timeout:240000
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
  const downloadDir=await mkdtemp(join(tmpdir(),"wtox-original-tox-save-"));
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
            "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; worker-src 'self'; connect-src 'self' ws:; base-uri 'none'; form-action 'none'"});
        res.end(bytes);
      }catch{res.writeHead(404);res.end();}
    });
    await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
    const origin="http://127.0.0.1:"+server.address().port;
    let connected=false;
    server.on("upgrade",(req,sock,head)=>{
      if(connected || metrics.clients>=2 || req.url!=="/__wtox_dht_bridge" ||
         req.headers.origin!==origin ||
         req.headers["sec-websocket-protocol"]!=="wtox-udp-v1"){
        sock.destroy();return;
      }
      connected=true;
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
        ws.on("close",()=>{
          osSocket.off("message",receive);
          connected=false;
        });
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
    const cdp=await page.createCDPSession();
    await cdp.send("Page.setDownloadBehavior",{
      behavior:"allow",downloadPath:downloadDir
    });
    page.on("pageerror",e=>pageErrors.push(e.message.slice(0,200)));
    await page.goto(origin+"/tests/local-chat.html",{waitUntil:"load"});
    // The UI, not the fixture, must initiate the real original friend request.
    assert.equal(await page.$eval("#send-button",e=>e.disabled),true,
                 "sending while offline must be disabled");
    await page.waitForFunction(()=>
      document.querySelector("#my-tox-id")?.dataset.state==="ready",
      {timeout:60000});
    const ownId=await page.$eval("#my-tox-id",el=>el.textContent);
    assert.match(ownId,/^[0-9A-F]{76}$/);
    assert.notEqual(ownId,native.receiverToxId.toUpperCase());
    const statusBefore=await page.$eval("#friend-status",el=>el.textContent);
    assert.match(statusBefore,/No friend added/);
    assert.doesNotMatch(native.logs(),/REQUEST_RECEIVED/,
      "no native callback before the user clicks Add Friend");
    // A well-formed 76-character identifier with a tampered checksum
    // must be rejected by original tox_friend_add, without locking the UI.
    const corrupted=native.receiverToxId.slice(0,-1)+
      (native.receiverToxId.at(-1)==="0"?"1":"0");
    await page.type("#friend-id",corrupted);
    await page.click("#request-button");
    await page.waitForFunction(()=>
      document.querySelector("#feedback")?.textContent.includes(
        "original_friend_add_rejected"),{timeout:10000});
    assert.equal(await page.$eval("#request-button",el=>el.disabled),false,
      "native validation failure must permit retry");
    assert.doesNotMatch(native.logs(),/REQUEST_RECEIVED/,
      "invalid Tox checksum must not reach native receiver");
    await page.$eval("#friend-id",el=>{
      el.value="";
      el.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await page.type("#friend-id",native.receiverToxId);
    await page.click("#request-button");
    await page.waitForFunction(()=>
      /Request queued|Friend online/.test(
        document.querySelector("#friend-status")?.textContent||""),
      {timeout:8000});
    await page.waitForFunction(()=>
      document.querySelector("#send-button")?.disabled===false,
      {timeout:90000});
    const onlineLabel=await page.$eval("#friend-status",el=>el.textContent);
    assert.match(onlineLabel,/Friend online/);
    await page.type("#message-text","wTox browser original friend text");
    await page.click("#send-button");
    await page.waitForFunction(()=>
      [...document.querySelectorAll("#messages li")].some(el=>
        el.textContent.includes("Friend: wTox native original friend reply")),
      {timeout:30000});
    const bubbles=await page.$$eval("#messages li",all=>
      all.map(el=>({message:el.textContent,kind:el.className})));
    assert.ok(bubbles.some(x=>x.kind==="me" &&
      x.message==="You: wTox browser original friend text"),
      "user-entered message must be visibly sent only after online");
    assert.ok(bubbles.some(x=>x.kind==="peer" &&
      x.message==="Friend: wTox native original friend reply"),
      "the real native Tox receive callback must update the DOM");
    const feedback=await page.$eval("#feedback",el=>el.textContent);
    assert.match(feedback,/original native Tox message callback/);
    // End-to-end encrypted standard .tox backup initiated by the REAL UI.
    // Only ciphertext may leave WASM; the Chrome download stays on CI disk.
    const savePassword="stage27-end-to-end-browser-backup-password";
    await page.type("#backup-password",savePassword);
    await page.click("#export-backup");
    await page.waitForFunction(()=>
      document.querySelector("#export-state")?.dataset.state==="downloaded",
      {timeout:12000});
    let downloaded=null;
    for(let i=0;i<120;i++){
      const files=(await readdir(downloadDir)).filter(x=>x.endsWith(".tox"));
      if(files.length===1){
        const candidate=join(downloadDir,files[0]);
        const size=(await stat(candidate)).size;
        if(size>80){downloaded=candidate;break;}
      }
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert.ok(downloaded,"encrypted standard .tox must download from the user action");
    const blob=await readFile(downloaded);
    assert.ok(blob.length>80 && blob.length<=1024*1024+80);
    assert.equal(blob.subarray(0,8).toString(),"toxEsave");
    // Incorrect password MUST NOT destroy the original connected instance.
    await (await page.$("#restore-file")).uploadFile(downloaded);
    await page.type("#restore-password","incorrect-original-backup-password");
    await page.click("#restore-backup");
    await page.waitForFunction(()=>
      document.querySelector("#restore-state")?.dataset.state==="failed",
      {timeout:10000});
    assert.equal(await page.$eval("#send-button",el=>el.disabled),false,
      "incorrect password must leave live Toxcore and friend connected");
    assert.equal(await page.$eval("#my-tox-id",el=>el.textContent),ownId);
    await page.type("#restore-password",savePassword);
    await page.click("#restore-backup");
    await page.waitForFunction(()=>
      document.querySelector("#restore-state")?.dataset.state==="restored",
      {timeout:10000});
    assert.equal(await page.$eval("#my-tox-id",el=>el.textContent),ownId,
      "restored original identity must have identical full Tox ID");
    assert.match(await page.$eval("#friend-status",el=>el.textContent),
      /Saved friend restored/);
    assert.equal(await page.$eval("#request-button",el=>el.disabled),true,
      "saved friend must NOT be readded using a synthetic DHT identity");
    await page.waitForFunction(()=>
      document.querySelector("#my-tox-id")?.dataset.state==="ready" &&
      document.querySelector("#send-button")?.disabled===false,
      {timeout:65000});
    assert.match(await page.$eval("#friend-status",el=>el.textContent),
      /Friend online/);
    await page.type("#message-text","wTox browser message after restored identity");
    await page.click("#send-button");
    await page.waitForFunction(()=>
      [...document.querySelectorAll("#messages li")].some(el=>
        el.textContent==="Friend: wTox native reply after restored identity"),
      {timeout:30000});
    const history=await page.$$eval("#messages li",all=>
      all.map(x=>x.textContent));
    assert.ok(history.includes("You: wTox browser message after restored identity"));
    assert.ok(history.includes("Friend: wTox native reply after restored identity"));
    // Close entire document AND its Dedicated Worker. Restore from the
    // ciphertext downloaded earlier into an independently created new
    // native Toxcore session — not the previous in-page instance.
    await page.goto("about:blank",{waitUntil:"load"});
    for(let i=0;i<80&&connected;i++)
      await new Promise(resolve=>setTimeout(resolve,25));
    assert.equal(connected,false,
      "previous WebSocket and Worker must drain before new browser instance");
    assert.equal(wss.clients.size,0,
      "no retained authenticated bridge socket across browser reload");
    await page.goto(origin+"/tests/local-chat.html",{waitUntil:"load"});
    await page.waitForFunction(()=>
      document.querySelector("#my-tox-id")?.dataset.state==="ready",
      {timeout:65000});
    const freshId=await page.$eval("#my-tox-id",el=>el.textContent);
    assert.match(freshId,/^[0-9A-F]{76}$/);
    assert.notEqual(freshId,ownId,
      "fresh page must not secretly reuse an unsaved identity");
    assert.equal(await page.$eval("#send-button",el=>el.disabled),true);
    assert.equal(await page.$eval("#request-button",el=>el.disabled),false);
    await (await page.$("#restore-file")).uploadFile(downloaded);
    await page.type("#restore-password",savePassword);
    // Attempt WITHOUT explicit replacement approval must not destroy the
    // new identity, and cannot create a hidden friend.
    await page.click("#restore-backup");
    await page.waitForFunction(()=>
      document.querySelector("#restore-state")?.dataset.state==="failed",
      {timeout:12000});
    assert.equal(await page.$eval("#my-tox-id",el=>el.textContent),freshId);
    assert.match(await page.$eval("#feedback",el=>el.textContent),
      /backup_identity_mismatch/);
    assert.match(await page.$eval("#friend-status",el=>el.textContent),
      /No friend added/);
    await page.click("#replace-fresh");
    await page.type("#restore-password",savePassword);
    await page.click("#restore-backup");
    await page.waitForFunction(()=>
      document.querySelector("#restore-state")?.dataset.state==="restored",
      {timeout:12000});
    assert.equal(await page.$eval("#my-tox-id",el=>el.textContent),ownId,
      "the full original identity must survive complete browser page reload");
    assert.match(await page.$eval("#friend-status",el=>el.textContent),
      /Saved friend restored/);
    assert.equal(await page.$eval("#request-button",el=>el.disabled),true,
      "restored friend must exist without a second friend request");
    try{
      await page.waitForFunction(()=>
        document.querySelector("#my-tox-id")?.dataset.state==="ready" &&
        document.querySelector("#send-button")?.disabled===false,
        {timeout:95000});
    }catch(error){
      const snapshot=await page.evaluate(()=>({
        network:document.querySelector("#network-status")?.textContent,
        friend:document.querySelector("#friend-status")?.textContent,
        feedback:document.querySelector("#feedback")?.textContent,
        identityState:document.querySelector("#my-tox-id")?.dataset.state,
        sendDisabled:document.querySelector("#send-button")?.disabled,
        restore:document.querySelector("#restore-state")?.dataset.state,
        visibleMessages:[...document.querySelectorAll("#messages li")]
          .map(el=>el.textContent).slice(-4)
      }));
      throw Error("reloaded_original_tox_friend_reconnect_timeout "+
        JSON.stringify({snapshot,metrics,nativeLog:native.logs().slice(-1300),
                        pageErrors,pageStateError:String(error)}));
    }
    await page.type("#message-text","wTox message after full browser page reload");
    await page.click("#send-button");
    await page.waitForFunction(()=>
      [...document.querySelectorAll("#messages li")].some(el=>
        el.textContent==="Friend: wTox reply after full browser page reload"),
      {timeout:30000});
    const finalBubbles=await page.$$eval("#messages li",all=>all.map(x=>x.textContent));
    assert.ok(finalBubbles.includes("You: wTox message after full browser page reload"));
    assert.ok(finalBubbles.includes("Friend: wTox reply after full browser page reload"));
    const state={publicKey:ownId.slice(0,64).toLowerCase()};
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
    assert.equal((log.match(/TEXT_RECEIVED/g)||[]).length,3,
      "native original Toxcore must receive messages before and after restore");
    assert.equal((log.match(/TEXT_SENT/g)||[]).length,3,
      "native original Toxcore must send replies before and after restore");
    assert.equal((log.match(/REQUEST_RECEIVED /g)||[]).length,1,
      "restored Tox identity should not generate a second friend request");
    assert.ok(metrics.sent>=2 && metrics.received>=2,
      "real Tox DHT handshake must traverse native OS UDP in both directions");
    assert.equal(metrics.clients,2,"two sequential isolated browser DHT clients");
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
    await rm(downloadDir,{recursive:true,force:true});
  }
});
