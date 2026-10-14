/*
 * Two independent builds of ORIGINAL pinned c-toxcore:
 * native Linux CLI <-> browser-targeted WebAssembly Toxcore.
 *
 * This tests real standard Tox savedata + ToxEncryptSave, not a fake JSON
 * fixture, a generated-from-WASM-only backup, or an unmodified qTox GUI.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {existsSync} from "node:fs";
import {readFile,writeFile,mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";

const root=join(dirname(fileURLToPath(import.meta.url)),"..");
const native=join(root,"dist/tox-save-interop");
const wasm=join(root,"dist/tox_identity.wasm");
const TEST_PASSWORD="wtox-stage29-test-only-native-interoperability";
const identityHex=bytes=>Buffer.from(bytes).toString("hex");
function originalLinux(...args){
  const proc=spawnSync(native,args,{encoding:"utf8",timeout:15000,maxBuffer:8192});
  assert.equal(proc.error,undefined,"native fixture failed: "+String(proc.error));
  return proc;
}
function strictNative(...args){
  const proc=originalLinux(...args);
  assert.equal(proc.status,0,"independent c-toxcore: "+
              proc.stderr+" "+proc.stdout);
  return proc.stdout;
}
test("independent original Linux c-toxcore <-> original WASM ToxEncryptSave exchange retains full identity and real friend key",{
  timeout:45000
},async()=>{
  assert.ok(existsSync(native),"separately compiled Linux Toxcore CLI required");
  assert.ok(existsSync(wasm),"real original browser-targeted c-toxcore WASM required");
  const directory=await mkdtemp(join(tmpdir(),"wtox-native-wasm-profile-"));
  const nativeFile=join(directory,"native-created.tox");
  const browserFile=join(directory,"wasm-created.tox");
  const nativeRoundTrip=join(directory,"wasm-reencrypted-native.tox");
  const corruptedFile=join(directory,"tampered.tox");
  const {default:make}=await import("../dist/tox_identity.mjs");
  const m=await make();
  const alloc=n=>{const p=m._malloc(n);assert.ok(p);return {p,n};};
  const free=o=>{m.HEAPU8.fill(0,o.p,o.p+o.n);m._free(o.p);};
  const pass=alloc(1024),badpass=alloc(1024),bytes=alloc(65536),
        destination=alloc(38),friend=alloc(32),message=alloc(128),
        info=alloc(32),written=alloc(4);
  const read32=p=>new DataView(m.HEAPU8.buffer).getUint32(p,true);
  const password=new TextEncoder().encode(TEST_PASSWORD);
  const wrong=new TextEncoder().encode("stage29-incorrect-native-test-password");
  m.HEAPU8.set(password,pass.p);
  m.HEAPU8.set(wrong,badpass.p);
  const getId=()=>{
    assert.equal(m._wtox_vudp_native_address(destination.p,38),0);
    return identityHex(m.HEAPU8.slice(destination.p,destination.p+38));
  };
  const getFriend=()=>{
    assert.equal(m._wtox_vudp_native_friend_public_key(friend.p,32),0);
    return identityHex(m.HEAPU8.slice(friend.p,friend.p+32));
  };
  const exportTo=async path=>{
    assert.ok(m._wtox_vudp_savedata_size()>0);
    assert.equal(m._wtox_vudp_export_encrypted(pass.p,password.length,
                 bytes.p,bytes.n,written.p),0);
    const n=read32(written.p);
    assert.ok(n>80&&n<=bytes.n);
    const encrypted=Buffer.from(m.HEAPU8.slice(bytes.p,bytes.p+n));
    assert.equal(encrypted.subarray(0,8).toString(),"toxEsave");
    await writeFile(path,encrypted,{mode:0o600});
    return encrypted;
  };
  try{
    const generated=strictNative("create",nativeFile);
    const match=generated.match(/^CREATED ([a-f0-9]{76}) ([a-f0-9]{64})\s*$/);
    assert.ok(match,"independent native must expose public Tox ID and public friend key");
    const nativeId=match[1],nativeFriend=match[2];
    const originalCipher=await readFile(nativeFile);
    assert.equal(originalCipher.subarray(0,8).toString(),"toxEsave");
    assert.ok(originalCipher.length>80&&originalCipher.length<bytes.n);
    assert.notEqual(nativeId.slice(0,64),nativeFriend,
                    "friend must have a different original Tox identity");
    // Original native CLI can reopen its own encrypted file.
    assert.match(strictNative("verify",nativeFile,nativeId,nativeFriend),/VERIFIED/);
    m.HEAPU8.set(originalCipher,bytes.p);
    assert.equal(m._wtox_vudp_restore_encrypted(bytes.p,originalCipher.length,
                  badpass.p,wrong.length),-4,
                 "invalid native fixture password must not create a guest");
    assert.equal(m._wtox_vudp_savedata_size(),0);
    assert.equal(m._wtox_vudp_restore_encrypted(bytes.p,originalCipher.length,
                  pass.p,password.length),0,
                 "WASM must import ORIGINAL NATIVE encrypted .tox");
    assert.equal(getId(),nativeId,"native full Tox ID must survive WASM import");
    assert.equal(getFriend(),nativeFriend,
                 "native friend public key must survive WASM import");
    assert.equal(m._wtox_vudp_native_friend_state(info.p),0);
    assert.equal(read32(info.p),1,"original native friend roster preserved");
    assert.equal(read32(info.p+4),0,"import must not fabricate online status");
    // The reverse codec: ciphertext produced by original WASM decrypts
    // inside original independently compiled Linux C Toxcore.
    const reencrypted=await exportTo(nativeRoundTrip);
    assert.notDeepEqual(reencrypted,originalCipher,
      "ToxEncryptSave uses a fresh nonce/salt on each encryption");
    assert.match(strictNative("verify",nativeRoundTrip,nativeId,nativeFriend),
                 /VERIFIED/);
    m._wtox_vudp_probe_stop();
    assert.equal(m._wtox_vudp_probe_start(),0);
    const wasmId=getId();
    assert.notEqual(wasmId,nativeId,
                    "new original WASM identity must be independently generated");
    // Add exactly one genuine original friend using a standard 38-byte ID.
    m.HEAPU8.set(Buffer.from(nativeId,"hex"),destination.p);
    const hello=new TextEncoder().encode("native-WASM-standard-savedata-interop");
    m.HEAPU8.set(hello,message.p);
    assert.equal(m._wtox_vudp_native_friend_request(
                 destination.p,38,message.p,hello.length),0);
    assert.equal(getFriend(),nativeId.slice(0,64));
    await exportTo(browserFile);
    assert.match(strictNative("verify",browserFile,wasmId,nativeId.slice(0,64)),
                 /VERIFIED/,"independent Linux Toxcore must read WASM identity");
    // Even independent Linux implementation refuses tampered authenticated
    // ciphertext; the file must never be used as a Tox profile.
    const broken=Buffer.from(await readFile(browserFile));
    broken[broken.length-23]^=0x80;
    await writeFile(corruptedFile,broken,{mode:0o600});
    assert.notEqual(originalLinux("verify",corruptedFile,
                   wasmId,nativeId.slice(0,64)).status,0);
    assert.notEqual(originalLinux("verify",browserFile,
                   nativeId,nativeId.slice(0,64)).status,0,
                   "wrong public identity should fail independently");
    m._wtox_vudp_probe_stop();
    assert.equal(m._wtox_vudp_probe_stats(info.p),0);
    assert.equal(read32(info.p),0,"native virtual socket closed");
  }finally{
    m._wtox_vudp_probe_stop();
    for(const o of [written,info,message,friend,destination,bytes,badpass,pass])free(o);
    await rm(directory,{recursive:true,force:true});
  }
});
