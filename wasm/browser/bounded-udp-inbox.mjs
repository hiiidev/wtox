/**
 * Browser-side, test-only UDP datagram admission queue.
 *
 * This is a fixed-capacity handoff to the 16-slot original native
 * Network_Funcs UDP FIFO. Unlike TCP, lost UDP frames aren't retried by
 * this shim. A temporary native EWOULDBLOCK (-11) is *not* a transport
 * failure: keep the entire datagram for a later original tox_iterate().
 * The JS queue never stores keys or plaintext savedata.
 */
export class BoundedUdpInbox {
  constructor(limit=128,maxDatagram=2048){
    if(!Number.isInteger(limit)||limit<1||limit>128 ||
       !Number.isInteger(maxDatagram)||maxDatagram<1||maxDatagram>2048)
      throw RangeError("invalid_bounded_udp_limits");
    this.limit=limit;
    this.maxDatagram=maxDatagram;
    this.queue=[];
    this.dropped=0;
    this.accepted=0;
    this.delivered=0;
  }
  push(bytes,sourcePort){
    if(!(bytes instanceof Uint8Array) || !bytes.length ||
       bytes.length>this.maxDatagram || !Number.isInteger(sourcePort) ||
       sourcePort<1025 || sourcePort>65535)
      throw RangeError("invalid_udp_datagram");
    if(this.queue.length>=this.limit){
      ++this.dropped;
      return false; // bounded UDP packet loss, NOT a fatal app error
    }
    this.queue.push({bytes:Uint8Array.from(bytes),port:sourcePort});
    ++this.accepted;
    return true;
  }
  drain(write,maxPackets=64){
    if(typeof write!=="function" || !Number.isInteger(maxPackets) ||
       maxPackets<1 || maxPackets>128)
      throw RangeError("invalid_udp_drain_arguments");
    let moved=0;
    while(this.queue.length && moved<maxPackets){
      const packet=this.queue[0];
      const status=write(packet.bytes,packet.port);
      if(status===-11)break; // original WASM is full; preserve packet
      if(status!==packet.bytes.length)
        throw Error("original_native_udp_push_failed:"+status);
      packet.bytes.fill(0);
      this.queue.shift();
      ++this.delivered;
      ++moved;
    }
    return moved;
  }
  clear(){
    for(const packet of this.queue)packet.bytes.fill(0);
    this.queue.length=0;
  }
  get pending(){return this.queue.length;}
}
