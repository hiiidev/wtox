/**
 * Isolated Dedicated Worker: original c-toxcore Network_Funcs UDP socket
 * -> bounded WASM datagram FIFO -> authenticated localhost WebSocket ->
 * native OS UDP echo; reverse direction through original ns_recvfrom.
 *
 * No DHT bootstrap, no arbitrary UDP endpoints, no production transport.
 */
import createModule from "../dist/tox_identity.mjs";
const SIZE=2048, SLOTS=16;
let running=false;
function verify(condition,message) {
  if(!condition)throw Error(message);
}
function packetFor(index) {
  const length=index===15?SIZE:4+index*11;
  const bytes=new Uint8Array(length);
  bytes[0]=index;
  bytes[1]=0;
  bytes[2]=255;
  bytes[3]=128;
  for(let j=4;j<length;j++)bytes[j]=(j*19+index*37)&255;
  return bytes;
}
const readU16=(m,ptr)=>new DataView(m.HEAPU8.buffer).getUint16(ptr,true);
const readU32=(m,ptr)=>new DataView(m.HEAPU8.buffer).getUint32(ptr,true);
async function testUdp(url,token,port) {
  verify(/^ws:\/\/127\.0\.0\.1:\d+\/__wtox_udp_bridge$/.test(url),"non_loopback_ws_forbidden");
  verify(/^[a-f0-9]{64}$/.test(token),"bad_test_credential");
  verify(Number.isInteger(port)&&port>=1025&&port<=65535,"bad_udp_port");
  const m=await createModule();
  const ptr=m._malloc(SIZE), meta=m._malloc(32);
  verify(ptr && meta,"wasm_alloc_failed");
  let ws=null,started=false;
  try {
    verify(m._wtox_vudp_probe_start()===0,"original_tox_udp_start_failed");
    started=true;
    verify(m._wtox_vudp_probe_stats(meta)===0,"stats_failed");
    verify(readU32(m,meta)===1 && readU32(m,meta+4)===33447,
           "original_tox_did_not_bind_virtual_udp_socket");
    const original=Array.from({length:SLOTS},(_,i)=>packetFor(i));
    for(const pkt of original) {
      m.HEAPU8.set(pkt,ptr);
      verify(m._wtox_vudp_probe_send(ptr,pkt.length,port)===pkt.length,
             "original_ns_sendto_failed");
    }
    const denied=Uint8Array.of(1,2,3,4);
    m.HEAPU8.set(denied,ptr);
    verify(m._wtox_vudp_probe_reject_remote(ptr,4,port)===-1,
           "remote_udp_not_denied");
    verify(m._wtox_vudp_probe_send(ptr,4,port)===-1,
           "bounded_udp_queue_did_not_apply_backpressure");
    verify(m._wtox_vudp_probe_stats(meta)===0 &&
           readU32(m,meta+8)===SLOTS && readU32(m,meta+16)===1 &&
           readU32(m,meta+20)===1,"backpressure_counters_missing");
    ws=new WebSocket(url,"wtox-udp-v1");
    ws.binaryType="arraybuffer";
    await new Promise((resolve,reject)=>{
      const expiry=setTimeout(()=>reject(Error("ws_connect_timeout")),8000);
      ws.onopen=()=>{
        ws.send(JSON.stringify({type:"authenticate",token}));
      };
      ws.onmessage=event=>{
        if(typeof event.data!=="string")return;
        try {
          const msg=JSON.parse(event.data);
          if(msg.type!=="ready")throw Error("udp_bridge_auth_failed");
          clearTimeout(expiry);
          resolve();
        }catch(err){clearTimeout(expiry);reject(err);}
      };
      ws.onerror=()=>{clearTimeout(expiry);reject(Error("udp_bridge_socket_error"));};
    });
    const expected=new Map(original.map(pkt=>[pkt[0],pkt]));
    let received=0;
    const replies=new Promise((resolve,reject)=>{
      const expiry=setTimeout(()=>reject(Error("os_udp_echo_timeout_"+received)),12000);
      ws.onmessage=event=>{
        try {
          verify(event.data instanceof ArrayBuffer,"response_not_binary_udp_frame");
          const bytes=new Uint8Array(event.data);
          verify(bytes.length>=5 && bytes[0]===1,"udp_frame_invalid");
          const from=(bytes[1]<<8)|bytes[2];
          const length=(bytes[3]<<8)|bytes[4];
          verify(from===port && length===bytes.length-5 &&
                 length>0 && length<=SIZE,"udp_frame_source_or_size_invalid");
          const msg=bytes.subarray(5);
          const reference=expected.get(msg[0]);
          verify(reference!==undefined && reference.length===length &&
                 reference.every((v,i)=>v===msg[i]),"os_udp_payload_modified");
          m.HEAPU8.set(msg,ptr);
          verify(m._wtox_vudp_probe_push(ptr,length,from)===length,
                 "wasm_udp_rx_push_failed");
          verify(m._wtox_vudp_probe_read(ptr,SIZE,meta+24)===length,
                 "original_ns_recvfrom_failed");
          verify(readU16(m,meta+24)===from &&
                 reference.every((v,i)=>v===m.HEAPU8[ptr+i]),
                 "original_ns_recvfrom_corrupted_payload");
          expected.delete(msg[0]);
          received++;
          if(received===SLOTS) {clearTimeout(expiry);resolve();}
        }catch(err){clearTimeout(expiry);reject(err);}
      };
      ws.onerror=()=>{clearTimeout(expiry);reject(Error("udp_bridge_receive_error"));};
    });
    for(let i=0;i<SLOTS;i++){
      const n=m._wtox_vudp_probe_take(ptr,SIZE,meta+24);
      verify(n===original[i].length && readU16(m,meta+24)===port &&
             original[i].every((v,j)=>v===m.HEAPU8[ptr+j]),
             "udp_tx_datagram_boundary_lost");
      const frame=new Uint8Array(n+5);
      frame[0]=1;frame[1]=port>>8;frame[2]=port&255;
      frame[3]=n>>8;frame[4]=n&255;
      frame.set(m.HEAPU8.subarray(ptr,ptr+n),5);
      ws.send(frame);
    }
    await replies;
    verify(m._wtox_vudp_probe_stats(meta)===0,"post_udp_stats_failed");
    const counts=Array.from({length:8},(_,i)=>readU32(m,meta+i*4));
    verify(counts[2]===0 && counts[3]===0 && counts[4]===1 &&
           counts[5]===1 && counts[6]===SLOTS && counts[7]===SLOTS,
           "udp_datagram_stats_mismatch:"+counts.join(","));
    m._wtox_vudp_probe_stop();started=false;
    verify(m._wtox_vudp_probe_stats(meta)===0 &&
           readU32(m,meta)===0 && readU32(m,meta+8)===0,
           "udp_close_not_cleared");
    return {datagrams:SLOTS,largest:SIZE,bytes:original.reduce((a,b)=>a+b.length,0)};
  } finally {
    if(ws)ws.close();
    if(started)m._wtox_vudp_probe_stop();
    if(ptr){m.HEAPU8.fill(0,ptr,ptr+SIZE);m._free(ptr);}
    if(meta){m.HEAPU8.fill(0,meta,meta+32);m._free(meta);}
  }
}
self.onmessage=async({data})=>{
  if(running || data?.action!=="START")return;
  running=true;
  try {
    const info=await testUdp(data.url,data.token,data.port);
    self.postMessage({type:"DONE",info});
  }catch(err){
    self.postMessage({type:"ERROR",error:String(err?.message||err)});
  }
};
