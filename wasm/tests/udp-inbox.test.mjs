import test from "node:test";
import assert from "node:assert/strict";
import {BoundedUdpInbox} from "../browser/bounded-udp-inbox.mjs";

test("bounded datagrams retry native EWOULDBLOCK instead of disconnecting or corrupting packet boundaries",()=>{
  const inbox=new BoundedUdpInbox(128,2048);
  const input=Array.from({length:64},(_,i)=>{
    const data=Uint8Array.from({length:i===63?2048:25+i},
      (_,j)=>(17*i+31*j)&255);
    data[0]=i;
    return data;
  });
  for(const bytes of input)assert.equal(inbox.push(bytes,33448),true);
  assert.equal(inbox.pending,64);
  let nativeQueued=0;
  let pushed=[],steps=0;
  // Model actual native fixed 16-slot FIFO. Each tox_iterate consumes
  // precisely one fill; JS must keep pending *whole* UDP packets.
  while(inbox.pending){
    ++steps;
    assert.ok(steps<=10);
    const n=inbox.drain((bytes,source)=>{
      assert.equal(source,33448);
      if(nativeQueued===16)return -11;
      pushed.push(Uint8Array.from(bytes));
      ++nativeQueued;
      return bytes.length;
    });
    assert.equal(n,16);
    nativeQueued=0; // original tox_iterate consumed its native FIFO
  }
  assert.equal(steps,4);
  assert.equal(inbox.dropped,0);
  assert.equal(inbox.accepted,64);
  assert.equal(inbox.delivered,64);
  assert.deepEqual(pushed.map(x=>Buffer.from(x)),
                   input.map(x=>Buffer.from(x)));
  assert.equal(pushed.at(-1).length,2048);
  assert.equal(inbox.pending,0);
});
test("bounded UDP queue never exceeds its limit and clears held bytes",()=>{
  const inbox=new BoundedUdpInbox(2,2048);
  const original=Uint8Array.of(0,255,0,128);
  assert.equal(inbox.push(original,56000),true);
  original.fill(99); // ownership requires defensive copy
  assert.equal(inbox.push(Uint8Array.of(4,5),56001),true);
  assert.equal(inbox.push(Uint8Array.of(6,7),56002),false);
  assert.equal(inbox.pending,2);
  assert.equal(inbox.dropped,1);
  let attempt=0;
  assert.equal(inbox.drain(()=>{
    ++attempt;return -11;
  }),0);
  assert.equal(attempt,1);
  assert.equal(inbox.pending,2,"native pressure must not discard packets");
  const held=inbox.queue[0].bytes;
  assert.deepEqual([...held],[0,255,0,128]);
  inbox.clear();
  assert.equal(inbox.pending,0);
  assert.deepEqual([...held],[0,0,0,0],"clear scrubs held data");
  assert.equal(inbox.push(Uint8Array.of(42),33448),true);
  assert.equal(inbox.drain((bytes,port)=>{
    assert.equal(port,33448);return bytes.length;
  }),1);
  assert.equal(inbox.pending,0);
  assert.throws(()=>inbox.push(new Uint8Array(2049),33448),RangeError);
  assert.throws(()=>inbox.push(Uint8Array.of(1),80),RangeError);
  assert.throws(()=>new BoundedUdpInbox(100000),RangeError);
});
