/**
 * Stage 25b genuine first-contact DHT/Onion baseline.
 * Launch unmodified original c-toxcore public APIs with three native identities
 * (a separate bootstrap node and two user peers) constrained to loopback UDP.
 *
 * Success REQUIRES a real remote tox_callback_friend_request,
 * tox_friend_add_norequest acceptance, both online callbacks and dual text.
 * There is no manual recipient DHT key or synthetic callback.
 *
 * Deliberately not browser WASM DHT connectivity yet.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {createSocket} from "node:dgram";
import {existsSync} from "node:fs";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
const directory=dirname(fileURLToPath(import.meta.url));
const binary=join(directory,"../dist/tox-local-discovery");
async function port() {
  const socket=createSocket("udp4");
  await new Promise((resolve,reject) => {
    socket.once("error",reject);
    socket.bind(0,"127.0.0.1",resolve);
  });
  const value=socket.address().port;
  await new Promise(resolve=>socket.close(resolve));
  return value;
}
test("native original c-toxcore DHT/Onion delivers first real Tox ID friend request and messages without peer DHT injection",{
  timeout:125000
},async()=>{
  assert.ok(existsSync(binary),"pinned original native discovery fixture must be built");
  const unique=new Set();
  while(unique.size<3)unique.add(await port());
  const child=spawn(binary,Array.from(unique,String),{
    stdio:["ignore","pipe","pipe"]
  });
  let output="",stderr="";
  child.stdout.on("data",b=>{output=(output+b.toString()).slice(-3500);});
  child.stderr.on("data",b=>{stderr=(stderr+b.toString()).slice(-3500);});
  let timer;
  try {
    const outcome=await Promise.race([
      new Promise((resolve,reject)=>{
        child.once("error",reject);
        child.once("exit",(code,signal)=>resolve({code,signal}));
      }),
      new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(Error("native_discovery_timeout")),115000);
      })
    ]);
    assert.equal(outcome.code,0,
      "original DHT/Onion test failed: "+JSON.stringify(outcome)+
      "; stdout="+output+"; stderr="+stderr);
    assert.match(output,/REQUEST_QUEUED_ORIGINAL/);
    assert.match(output,/REQUEST_RECEIVED_ORIGINAL/);
    assert.match(output,/PASS DHT_ONION_REQUEST=1 ACCEPTED=1 TEXT_A=1 TEXT_B=1 BOOTSTRAP=1/);
  } finally {
    if(timer)clearTimeout(timer);
    if(child.exitCode===null && child.signalCode===null) {
      const stopped=new Promise(resolve=>child.once("exit",resolve));
      child.kill("SIGTERM");
      await Promise.race([
        stopped,
        new Promise(resolve=>setTimeout(()=>{child.kill("SIGKILL");resolve();},1700))
      ]);
    }
  }
});
