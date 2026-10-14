import test from "node:test";
import assert from "node:assert/strict";
import {existsSync} from "node:fs";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";

/*
 * Exact original c-toxcore WASM, not a mocked savedata parser.
 * Exercises the SAME UDP-enabled native Tox instance used by Chromium UI.
 */
test("real network-enabled original Toxcore WASM exports encrypted .tox and restores identical identity and friend roster",async()=>{
  assert.ok(existsSync(join(dirname(fileURLToPath(import.meta.url)),
                            "../dist/tox_identity.wasm")));
  const {default:load}=await import("../dist/tox_identity.mjs");
  const m=await load();
  const alloc=size=>{
    const p=m._malloc(size);assert.ok(p);
    return {p,size};
  };
  const dispose=b=>{
    m.HEAPU8.fill(0,b.p,b.p+b.size);
    m._free(b.p);
  };
  const address=alloc(38),recipient=alloc(38),pass=alloc(64),
        wrong=alloc(64),msg=alloc(128),outLen=alloc(4),
        info=alloc(32),enc=alloc(65536);
  const password=new TextEncoder().encode("stage27-bounded-original-tox-save-passphrase");
  const wrongPassword=new TextEncoder().encode("stage27-definitely-wrong-passphrase");
  m.HEAPU8.set(password,pass.p);
  m.HEAPU8.set(wrongPassword,wrong.p);
  const read32=p=>new DataView(m.HEAPU8.buffer).getUint32(p,true);
  const getId=()=>{
    assert.equal(m._wtox_vudp_native_address(address.p,38),0);
    return Buffer.from(m.HEAPU8.slice(address.p,address.p+38)).toString("hex");
  };
  try{
    assert.equal(m._wtox_vudp_probe_start(),0);
    const originalId=getId();
    assert.match(originalId,/^[a-f0-9]{76}$/);
    assert.equal(m._wtox_vudp_export_encrypted(pass.p,password.length,
      enc.p,5,outLen.p),-2,"cannot export a truncated encrypted identity");
    assert.equal(m._wtox_vudp_savedata_size()>0,true);
    // Generate a SECOND genuine Tox address entirely in original native WASM.
    // It is used ONLY as the destination of an original tox_friend_add call.
    assert.equal(m._wtox_create_encrypted(pass.p,password.length,
      recipient.p,enc.p,enc.size,outLen.p),0);
    const peer=Buffer.from(m.HEAPU8.slice(recipient.p,recipient.p+38)).toString("hex");
    assert.notEqual(peer,originalId);
    const request=new TextEncoder().encode("stage27-test-original-friend-request");
    m.HEAPU8.set(request,msg.p);
    assert.equal(m._wtox_vudp_native_friend_request(recipient.p,38,
      msg.p,request.length),0);
    assert.equal(m._wtox_vudp_native_friend_state(info.p),0);
    assert.equal(read32(info.p),1,"genuine original friend stored before export");
    assert.equal(read32(info.p+4),0,"new friend remains offline");
    assert.equal(m._wtox_vudp_export_encrypted(pass.p,password.length,
      enc.p,enc.size,outLen.p),0);
    const n=read32(outLen.p);
    assert.ok(n>80&&n<=enc.size,"bounded complete encrypted Tox savedata");
    const ciphertext=m.HEAPU8.slice(enc.p,enc.p+n);
    assert.equal(Buffer.from(ciphertext.subarray(0,8)).toString(),"toxEsave");
    // Decryption errors must never instantiate a guest identity or
    // replace the current Tox identity.
    m._wtox_vudp_probe_stop();
    assert.equal(m._wtox_vudp_restore_encrypted(enc.p,n,
      wrong.p,wrongPassword.length),-4,"wrong password rejected");
    assert.equal(m._wtox_vudp_savedata_size(),0,"wrong password cannot create instance");
    m.HEAPU8[enc.p+35]^=1;
    assert.equal(m._wtox_vudp_restore_encrypted(enc.p,n,
      pass.p,password.length),-4,"tampered authenticated ciphertext rejected");
    m.HEAPU8[enc.p+35]^=1;
    assert.equal(m._wtox_vudp_restore_encrypted(enc.p,n,
      pass.p,password.length),0,"standard encrypted original Toxcore file restored");
    assert.equal(getId(),originalId,"same original key, full NoSpam and checksum");
    assert.equal(m._wtox_vudp_native_friend_state(info.p),0);
    assert.equal(read32(info.p),1,"friend relationship restored, not re-added");
    assert.equal(read32(info.p+4),0,"recovered offline friend not fabricated as online");
    assert.equal(m._wtox_vudp_probe_stats(info.p),0);
    assert.equal(read32(info.p),1,"fresh UDP socket reopened");
    assert.equal(read32(info.p+4),33447,"original bounded UDP bind restored");
    m._wtox_vudp_probe_stop();
    assert.equal(m._wtox_vudp_savedata_size(),0);
    // After close the raw password/ciphertext is scrubbed from our WASM allocations.
  } finally {
    m._wtox_vudp_probe_stop();
    for(const b of [enc,info,outLen,msg,wrong,pass,recipient,address])dispose(b);
  }
});
