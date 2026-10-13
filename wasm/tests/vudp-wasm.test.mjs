import test from "node:test";
import assert from "node:assert/strict";
import {existsSync} from "node:fs";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";

/* No Node UDP socket here: test real c-toxcore Network_Funcs against its
 * own bounded WASM datagram FIFO and lifecycle. Chromium/OS UDP is separate. */
test("real original c-toxcore UDP Network_Funcs binds, preserves datagrams, applies backpressure and zeroizes state",async()=>{
  const path=join(dirname(fileURLToPath(import.meta.url)),"../dist/tox_identity.wasm");
  assert.ok(existsSync(path),"actual WASM c-toxcore must be compiled");
  const {default:create}=await import("../dist/tox_identity.mjs");
  const m=await create(), p=m._malloc(2048), port=m._malloc(2), stats=m._malloc(32);
  assert.ok(p&&port&&stats);
  const u16=at=>new DataView(m.HEAPU8.buffer).getUint16(at,true);
  const u32=at=>new DataView(m.HEAPU8.buffer).getUint32(at,true);
  try{
    assert.equal(m._wtox_vudp_probe_start(),0);
    assert.equal(m._wtox_vudp_probe_start(),-1,"second start rejected");
    assert.equal(m._wtox_vudp_probe_stats(stats),0);
    assert.equal(u32(stats),1);
    assert.equal(u32(stats+4),33447,"original Tox UDP socket bound");
    const original=Array.from({length:16},(_,i)=>{
      const b=Uint8Array.from({length:i===15?2048:1+i},(_,j)=>(i*29+j*131)&255);
      b[0]=i;
      return b;
    });
    for(const bytes of original){
      m.HEAPU8.set(bytes,p);
      assert.equal(m._wtox_vudp_probe_send(p,bytes.length,40000),bytes.length);
    }
    m.HEAPU8[p]=7;
    assert.equal(m._wtox_vudp_probe_reject_remote(p,1,40000),-1);
    assert.equal(m._wtox_vudp_probe_send(p,1,40000),-1,"backpressure after 16");
    assert.equal(m._wtox_vudp_probe_stats(stats),0);
    assert.equal(u32(stats+8),16);
    assert.equal(u32(stats+16),1);
    assert.equal(u32(stats+20),1);
    for(const bytes of original){
      assert.equal(m._wtox_vudp_probe_take(p,2048,port),bytes.length);
      assert.equal(u16(port),40000);
      assert.deepEqual(Array.from(m.HEAPU8.slice(p,p+bytes.length)),Array.from(bytes));
    }
    assert.equal(m._wtox_vudp_probe_take(p,2048,port),0);
    assert.equal(m._wtox_vudp_probe_read(p,2048,port),0,"nonblocking recv empty");
    for(const bytes of original){
      m.HEAPU8.set(bytes,p);
      assert.equal(m._wtox_vudp_probe_push(p,bytes.length,40000),bytes.length);
    }
    m.HEAPU8[p]=5;
    assert.equal(m._wtox_vudp_probe_push(p,1,40000),-11,"bounded inbound backpressure");
    for(const bytes of original){
      assert.equal(m._wtox_vudp_probe_read(p,2048,port),bytes.length);
      assert.equal(u16(port),40000);
      assert.deepEqual(Array.from(m.HEAPU8.slice(p,p+bytes.length)),Array.from(bytes));
    }
    assert.equal(m._wtox_vudp_probe_read(p,2048,port),0);
    m._wtox_vudp_probe_stop();
    assert.equal(m._wtox_vudp_probe_stats(stats),0);
    assert.deepEqual(Array.from({length:8},(_,i)=>u32(stats+i*4)),Array(8).fill(0));
    assert.equal(m._wtox_vudp_probe_start(),0,"WASM UDP state can be reused after stop");
    assert.equal(m._wtox_vudp_probe_take(p,2048,port),0,"no stale data after restart");
  } finally {
    m._wtox_vudp_probe_stop();
    if(p){m.HEAPU8.fill(0,p,p+2048);m._free(p);}
    if(port){m.HEAPU8.fill(0,port,port+2);m._free(port);}
    if(stats){m.HEAPU8.fill(0,stats,stats+32);m._free(stats);}
  }
});
