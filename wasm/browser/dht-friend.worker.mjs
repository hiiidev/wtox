/**
 * Stage 25d: an original Toxcore UDP-enabled instance bootstraps its real
 * DHT over the virtual Network_Funcs socket against independently running
 * original Linux Toxcore. This worker never generates or interprets a fake
 * DHT response. Bridge is explicitly restricted to a single localhost node.
 */
import createModule from "../dist/tox_identity.mjs";
const MAX=2048;
const fail=(ok,message)=>{if(!ok)throw Error(message);};
const hexToBytes=hex=>{
  fail(typeof hex==="string" && /^[0-9a-f]{64}$/.test(hex),"invalid_native_bootstrap_key");
  return Uint8Array.from({length:32},(_,i)=>parseInt(hex.slice(i*2,i*2+2),16));
};
async function connect(url,token) {
  const ws=new WebSocket(url,"wtox-udp-v1");
  ws.binaryType="arraybuffer";
  await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(Error("dht_ws_connect_timeout")),8000);
    ws.onopen=()=>ws.send(JSON.stringify({type:"authenticate",token}));
    ws.onerror=()=>{clearTimeout(timeout);reject(Error("dht_ws_failed"));};
    ws.onmessage=event=>{
      try{
        if(typeof event.data!=="string")return;
        const message=JSON.parse(event.data);
        fail(message.type==="ready","dht_ws_auth_rejected");
        clearTimeout(timeout);resolve();
      }catch(e){clearTimeout(timeout);reject(e);}
    };
  });
  return ws;
}
async function run({url,token,port,proxyPort,receiverPort,receiverToxId,publicKey}) {
  fail(/^ws:\/\/127\.0\.0\.1:\d+\/__wtox_dht_bridge$/.test(url),"dht_url_not_loopback");
  fail(typeof token==="string"&&/^[a-f0-9]{64}$/.test(token),"bad_test_token");
  fail(Number.isInteger(port)&&port>1024&&port<=65535,"invalid_local_dht_port");
  fail(Number.isInteger(proxyPort)&&proxyPort>1024&&proxyPort<=65535 &&
       proxyPort!==port,"invalid_loopback_mapping_port");
  fail(Number.isInteger(receiverPort)&&receiverPort>1024&&
       receiverPort<=65535&&!new Set([port,proxyPort]).has(receiverPort),
       "invalid_native_receiver_port");
  fail(typeof receiverToxId==="string"&&
       /^[0-9a-f]{76}$/.test(receiverToxId),"invalid_receiver_tox_id");
  const allowed=new Set([port,proxyPort,receiverPort]);
  const key=hexToBytes(publicKey);
  const m=await createModule();
  const buffer=m._malloc(MAX),meta=m._malloc(16),keyPtr=m._malloc(32);
  const addressPtr=m._malloc(38);
  fail(buffer && meta && keyPtr && addressPtr,"dht_wasm_allocation_failed");
  let ws,started=false;
  let sent=0,received=0,framesInvalid=0,requested=false,
      browserSent=false,gotText=false,nativeOnline=false;
  const requestText=new TextEncoder().encode("wTox stage25e original Onion browser request");
  const browserText=new TextEncoder().encode("wTox browser original friend text");
  const expectedReply=new TextEncoder().encode("wTox native original friend reply");
  const recipient=Uint8Array.from({length:38},(_,i)=>
    parseInt(receiverToxId.slice(2*i,2*i+2),16));
  try {
    fail(m._wtox_vudp_probe_start()===0,"original_dht_instance_creation_failed");
    started=true;
    ws=await connect(url,token);
    ws.onmessage=({data})=>{
      if(!(data instanceof ArrayBuffer)){++framesInvalid;return;}
      const frame=new Uint8Array(data);
      if(frame.length<6 || frame[0]!==1 ||
         !allowed.has((frame[1]<<8)|frame[2]) ||
         ((frame[3]<<8)|frame[4])!==frame.length-5 ||
         frame.length>MAX+5){++framesInvalid;return;}
      const bytes=frame.subarray(5);
      m.HEAPU8.set(bytes,buffer);
      if(m._wtox_vudp_probe_push(buffer,bytes.length,
          (frame[1]<<8)|frame[2])!==bytes.length)
        ++framesInvalid;
      else ++received;
    };
    m.HEAPU8.set(key,keyPtr);
    fail(m._wtox_vudp_native_bootstrap(port,keyPtr,32)===0,
         "original_tox_bootstrap_api_failed");
    const end=Date.now()+85000;
    while(Date.now()<end) {
      fail(ws.readyState===WebSocket.OPEN,"dht_tunnel_broken");
      fail(m._wtox_vudp_native_tick()===0,"original_tox_iterate_failed");
      for(let j=0;j<16;j++){
        const n=m._wtox_vudp_probe_take(buffer,MAX,meta);
        fail(n>=0 && n<=MAX,"original_native_dht_tx_invalid");
        if(n===0)break;
        const dest=new DataView(m.HEAPU8.buffer).getUint16(meta,true);
        fail(allowed.has(dest),"unexpected_native_udp_destination:"+dest);
        const packet=new Uint8Array(5+n);
        packet[0]=1;packet[1]=dest>>>8;packet[2]=dest&255;
        packet[3]=n>>>8;packet[4]=n&255;
        packet.set(m.HEAPU8.subarray(buffer,buffer+n),5);
        ws.send(packet);
        ++sent;
      }
      const state=m._wtox_vudp_native_connection();
      // This must be a REAL original Tox connection status, not a boolean
      // derived from packet counts or WebSocket ready state.
      const verified=m._wtox_vudp_native_bootstrap_verified(keyPtr,32);
      fail(verified>=0,"original_native_dht_closelist_query_failed");
      if(verified===1 && !requested){
        m.HEAPU8.set(recipient,addressPtr);
        m.HEAPU8.set(requestText,buffer);
        fail(m._wtox_vudp_native_friend_request(addressPtr,38,
             buffer,requestText.length)===0,"original_friend_add_failed");
        requested=true;
        self.postMessage({type:"REQUEST_QUEUED"});
      }
      if(requested) {
        fail(m._wtox_vudp_native_friend_state(meta)===0,"friend_state_failed");
        const f=new DataView(m.HEAPU8.buffer);
        const friendConnection=f.getUint32(meta+4,true);
        if(friendConnection!==0)nativeOnline=true;
        if(nativeOnline && !browserSent){
          m.HEAPU8.set(browserText,buffer);
          fail(m._wtox_vudp_native_friend_send(buffer,browserText.length)===0,
               "original_friend_text_send_failed");
          browserSent=true;
        }
        const n=m._wtox_vudp_native_friend_take(buffer,MAX);
        fail(n>=0,"native_friend_text_receive_failed");
        if(n!==0){
          fail(n===expectedReply.length &&
               expectedReply.every((v,i)=>m.HEAPU8[buffer+i]===v),
               "real_native_friend_reply_mismatch");
          gotText=true;
        }
      }
      if(verified===1 && requested && browserSent && gotText &&
         sent>=2 && received>=2 && framesInvalid===0){
        fail(m._wtox_vudp_native_address(addressPtr,38)===0,
             "browser_original_tox_id_missing");
        const publicKey=Array.from(m.HEAPU8.slice(addressPtr,addressPtr+32))
             .map(x=>x.toString(16).padStart(2,"0")).join("");
        return {state,sent,received,authenticatedDhtNeighbor:true,
                requestQueued:requested,browserSent,gotText,publicKey};
      }
      await new Promise(resolve=>setTimeout(resolve,16));
    }
    throw Error("original_dht_bootstrap_timeout:sent="+sent+
                ":received="+received+
                ":connection="+m._wtox_vudp_native_connection()+
                ":neighbor="+m._wtox_vudp_native_bootstrap_verified(keyPtr,32)+
                ":requested="+requested+
                ":online="+nativeOnline+
                ":textSent="+browserSent+
                ":textGot="+gotText+
                ":bad="+framesInvalid);
  } finally {
    ws?.close();
    if(started)m._wtox_vudp_probe_stop();
    if(buffer){m.HEAPU8.fill(0,buffer,buffer+MAX);m._free(buffer);}
    if(meta){m.HEAPU8.fill(0,meta,meta+16);m._free(meta);}
    if(addressPtr){m.HEAPU8.fill(0,addressPtr,addressPtr+38);m._free(addressPtr);}
    if(keyPtr){m.HEAPU8.fill(0,keyPtr,keyPtr+32);m._free(keyPtr);}
  }
}
self.onmessage=async({data})=>{
  if(data?.action!=="START")return;
  try{
    const outcome=await run(data);
    self.postMessage({type:"DONE",outcome});
  }catch(error){
    self.postMessage({type:"ERROR",error:String(error?.message||error)});
  }
};