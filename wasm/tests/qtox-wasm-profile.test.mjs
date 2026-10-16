/*
 * Pinned original WASM Toxcore versus unmodified upstream TokTok/qTox
 * ToxEncrypt C++ implementation linked with Qt5Core:
 * upstream qTox profile encryption/decryption <-> real browser WASM.
 *
 * This exercises ACTUAL qTox ToxEncrypt source (pinned and hash-verified),
 * not a simulated qTox parser or the unmodified complete qTox GUI.
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
const native=join(root,"dist/qtox-profile-interop");
const wasm=join(root,"dist/tox_identity.wasm");
const TEST_PASSWORD="wtox-qtox-Qt-test-only-interoperability";
const identityHex=bytes=>Buffer.from(bytes).toString("hex");
function originalLinux(...args){
  const proc=spawnSync(native,args,{encoding:"utf8",timeout:15000,maxBuffer:8192});
  assert.equal(proc.error,undefined,"native fixture failed: "+String(proc.error));
  return proc;
}
function strictNative(...args){
  const proc=originalLinux(...args);
  assert.equal(proc.status,0,"upstream qTox Qt/C++: "+
              proc.stderr+" "+proc.stdout);
  return proc.stdout;
}
test("unchanged upstream qTox Qt ToxEncrypt source <-> original browser WASM exchange genuine encrypted Tox identities and saved friends",{
  timeout:75000
},async()=>{
  assert.ok(existsSync(native),"separately compiled Linux Toxcore CLI required");
  assert.ok(existsSync(wasm),"real original browser-targeted c-toxcore WASM required");
  const directory=await mkdtemp(join(tmpdir(),"wtox-qtox-wasm-profile-"));
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
    assert.ok(match,"real pinned qTox must expose public Tox ID and public friend key");
    const nativeId=match[1],nativeFriend=match[2];
    const originalCipher=await readFile(nativeFile);
    assert.ok(originalCipher.length<65536,"upstream qTox profile fixture size");
    assert.match(strictNative("verify",nativeFile,nativeId,nativeFriend),
      /unmodified upstream qTox ToxEncrypt/,
      "Qt qTox's own ToxEncrypt profile-load code must verify the native file");
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
    const hello=new TextEncoder().encode("qTox-Qt-original-WASM-savedata-interop");
    m.HEAPU8.set(hello,message.p);
    assert.equal(m._wtox_vudp_native_friend_request(
                 destination.p,38,message.p,hello.length),0);
    assert.equal(getFriend(),nativeId.slice(0,64));
    await exportTo(browserFile);
    assert.match(strictNative("verify",browserFile,wasmId,nativeId.slice(0,64)),
                 /VERIFIED/,"unmodified qTox ToxEncrypt must read WASM identity");
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


/* Stage 32: Both real, unchanged qTox C++ paths must handle non-ASCII UTF-8:
 * standard makeToxEncrypt cached-key profile and encryptPass/decryptPass.
 * qTox performs QString::toUtf8() and measures QByteArray bytes. */
for(const mode of [
  {label:"cached-key profile",create:"create-unicode",verify:"verify-unicode"},
  {label:"direct-password profile",create:"create-unicode-direct",verify:"verify-unicode-direct"}
]){
test("unmodified upstream qTox "+mode.label+" and browser-targeted WASM exchange real saved identities with a multilingual UTF-8 password",{
  timeout:90000
},async()=>{
  assert.ok(existsSync(native)&&existsSync(wasm),
            "real upstream qTox Qt fixture and original WASM required");
  const passwordText="wtox-互通🔐-пароль-安全-2026";
  const password=new TextEncoder().encode(passwordText);
  assert.notEqual(password.length,passwordText.length,
    "must exercise multibyte UTF-8, not an ASCII-only passphrase");
  const wrong=new TextEncoder().encode("wtox-互通🔐-пароль-安全-2027");
  const directory=await mkdtemp(join(tmpdir(),"wtox-qtox-unicode-"));
  const fromQt=join(directory,"qtox-unicode-created.tox");
  const fromWasm=join(directory,"wasm-unicode-created.tox");
  const corrupted=join(directory,"qtox-unicode-tampered.tox");
  const {default:make}=await import("../dist/tox_identity.mjs");
  const m=await make();
  const alloc=n=>{const p=m._malloc(n);assert.ok(p);return {p,n};};
  const free=o=>{m.HEAPU8.fill(0,o.p,o.p+o.n);m._free(o.p);};
  const pass=alloc(256),badpass=alloc(256),bytes=alloc(65536),
        identity=alloc(38),friend=alloc(32),stats=alloc(16),written=alloc(4);
  const read32=p=>new DataView(m.HEAPU8.buffer).getUint32(p,true);
  try{
    assert.ok(password.length<pass.n&&wrong.length<badpass.n);
    m.HEAPU8.set(password,pass.p);
    m.HEAPU8.set(wrong,badpass.p);
    if(mode.create==="create-unicode"){
      assert.match(strictNative("probe-unicode-cache"),
                   /UPSTREAM_QTOX_UNICODE_CACHED_KEY_ROUNDTRIP_OK/,
        "upstream qTox cached-key must use UTF-8 bytes for multilingual passwords");
    }
    const output=strictNative(mode.create,fromQt);
    const created=output.match(/^CREATED ([0-9a-f]{76}) ([0-9a-f]{64})\s*$/);
    assert.ok(created,"actual qTox QString->UTF8 encryption must create a Tox profile");
    const [,nativeId,friendKey]=created;
    assert.match(strictNative(mode.verify,fromQt,nativeId,friendKey),
                 /VERIFIED/,"upstream qTox direct decryptPass must read its own UTF-8 profile");
    assert.notEqual(originalLinux("verify",fromQt,nativeId,friendKey).status,0,
      "ASCII cached-key qTox mode must not accidentally accept Unicode ciphertext");
    const qtoxEncrypted=await readFile(fromQt);
    assert.equal(qtoxEncrypted.subarray(0,8).toString(),"toxEsave");
    assert.ok(qtoxEncrypted.length>80&&qtoxEncrypted.length<=bytes.n);
    m.HEAPU8.set(qtoxEncrypted,bytes.p);
    assert.equal(m._wtox_vudp_restore_encrypted(bytes.p,qtoxEncrypted.length,
                 badpass.p,wrong.length),-4,
                 "wrong multilingual password must not install identity");
    assert.equal(m._wtox_vudp_savedata_size(),0);
    assert.equal(m._wtox_vudp_restore_encrypted(bytes.p,qtoxEncrypted.length,
                 pass.p,password.length),0,
                 "browser-targeted WASM must decrypt unmodified qTox Unicode fixture");
    assert.equal(m._wtox_vudp_native_address(identity.p,38),0);
    assert.equal(identityHex(m.HEAPU8.slice(identity.p,identity.p+38)),nativeId);
    assert.equal(m._wtox_vudp_native_friend_public_key(friend.p,32),0);
    assert.equal(identityHex(m.HEAPU8.slice(friend.p,friend.p+32)),friendKey);
    assert.equal(m._wtox_vudp_native_friend_state(stats.p),0);
    assert.equal(read32(stats.p),1,"actual friend roster must survive");
    assert.equal(read32(stats.p+4),0,"imported friend must remain offline");
    const rawSize=m._wtox_vudp_savedata_size();
    assert.ok(rawSize>0&&rawSize+80<=bytes.n);
    assert.equal(m._wtox_vudp_export_encrypted(pass.p,password.length,
                 bytes.p,bytes.n,written.p),0);
    const n=read32(written.p);
    assert.ok(n>80&&n<=bytes.n);
    await writeFile(fromWasm,m.HEAPU8.slice(bytes.p,bytes.p+n),{mode:0o600});
    assert.match(strictNative(mode.verify,fromWasm,nativeId,friendKey),
                 /VERIFIED/,
                 "actual upstream qTox direct decryptPass must load WASM Unicode profile");
    const tampered=Buffer.from(qtoxEncrypted);
    tampered[tampered.length-19]^=0x80;
    await writeFile(corrupted,tampered,{mode:0o600});
    assert.notEqual(originalLinux(mode.verify,corrupted,nativeId,friendKey).status,0,
      "upstream Qt qTox must reject corrupted authenticated UTF-8 backup");
    m._wtox_vudp_probe_stop();
  }finally{
    m._wtox_vudp_probe_stop();
    for(const o of [written,stats,friend,identity,bytes,badpass,pass])free(o);
    password.fill(0);wrong.fill(0);
    await rm(directory,{recursive:true,force:true});
  }
});
}
