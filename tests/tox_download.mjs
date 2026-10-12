import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

// Use the real frontend helper under Node 22 with minimal browser mocks.
const source=readFileSync("frontend/src/api.js","utf8");
const {downloadToxFile}=await import("data:text/javascript;base64,"+
  Buffer.from(source).toString("base64"));

const originalNavigator=Object.getOwnPropertyDescriptor(globalThis,"navigator");
const originalDocument=globalThis.document;
const originalSetTimeout=globalThis.setTimeout;
const originalCreateURL=URL.createObjectURL;
const originalRevokeURL=URL.revokeObjectURL;
let sharePayload=null;
let downloadName=null;
let clicks=0;

try{
  globalThis.setTimeout=()=>0;
  URL.createObjectURL=()=>"blob:mock-tox";
  URL.revokeObjectURL=()=>{};
  globalThis.document={
    createElement:()=>({
      href:"",download:"",
      click(){clicks++;downloadName=this.download;},
      remove(){}
    }),
    body:{append(){}}
  };
  Object.defineProperty(globalThis,"navigator",{
    configurable:true,
    value:{
      userAgent:"iPhone",
      canShare:({files})=>files?.[0]?.name.endsWith(".tox"),
      share:async payload=>{sharePayload=payload;}
    }
  });

  const result=await downloadToxFile(new Blob([Uint8Array.of(0,255,9)]),
    "my-identity");
  assert.equal(result,"shared");
  assert.equal(sharePayload.files[0].name,"my-identity.tox");
  assert.equal(sharePayload.files[0].type,"application/octet-stream");
  assert.deepEqual([...new Uint8Array(await sharePayload.files[0].arrayBuffer())],
    [0,255,9],"Binary identity backups must not be converted to text");
  assert.equal(clicks,0,"Native mobile file share should avoid a blob download");

  navigator.share=async()=>{throw Object.assign(new Error("cancelled"),{name:"AbortError"});};
  assert.equal(await downloadToxFile(new Blob(["x"]),"cancelled.tox"),"cancelled");
  assert.equal(clicks,0,"Do not download automatically if user cancels saving");

  navigator.userAgent="Android";
  navigator.canShare=()=>false;
  assert.equal(await downloadToxFile(new Blob(["x"]),"backup.tox"),"downloaded");
  assert.equal(downloadName,"backup.tox","Fallback preserves the .tox extension");
  assert.equal(clicks,1);

  navigator.userAgent="Desktop";
  assert.equal(await downloadToxFile(new Blob(["x"]),"backup.TOX"),"downloaded");
  assert.equal(downloadName,"backup.TOX","Do not append .tox twice");
  assert.equal(clicks,2);
}finally{
  if(originalNavigator)Object.defineProperty(globalThis,"navigator",originalNavigator);
  else delete globalThis.navigator;
  if(originalDocument===undefined)delete globalThis.document;
  else globalThis.document=originalDocument;
  globalThis.setTimeout=originalSetTimeout;
  URL.createObjectURL=originalCreateURL;
  URL.revokeObjectURL=originalRevokeURL;
}
console.log("iPhone/Android .tox share and fallback filenames OK");
