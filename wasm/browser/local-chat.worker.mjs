/**
 * Isolated manual-first-contact UI Worker. Real original Toxcore WASM
 * running UDP DHT/Onion over a single-destination localhost test bridge.
 * No private key, savedata, or user message is sent as a worker control
 * message except the user-entered standard public Tox ID and plaintext.
 * NOT connected to production React/Python login.
 */
import createModule from "../dist/tox_identity.mjs";
const MAX=2048, MAX_TEXT=128;
const encode=new TextEncoder(), decode=new TextDecoder("utf-8",{fatal:true});
const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,"0")).join("").toUpperCase();
const ensure=(ok,msg)=>{if(!ok)throw Error(msg);};
const hexBytes=(value,len)=>{
  ensure(typeof value==="string"&&new RegExp("^[0-9a-fA-F]{"+(len*2)+"}$").test(value),
         "invalid_hex_identifier");
  return Uint8Array.from({length:len},(_,i)=>parseInt(value.slice(i*2,i*2+2),16));
};
const notice=(type,details={})=>self.postMessage({type,...details});
let commandQueue=[], active=false, closeRequested=false;
self.onmessage=({data})=>{
  if(data?.action==="START" && !active) {
    active=true;
    main(data).then(()=>notice("STOPPED")).catch(e=>notice("ERROR",{
      message:String(e?.message||e)
    })).finally(()=>{active=false;});
  } else if(data?.action==="STOP") {
    closeRequested=true;
  } else if(["REQUEST","SEND","EXPORT","RESTORE"].includes(data?.action)) {
    if(commandQueue.length<8)commandQueue.push(data);
  }
};
async function openBridge(url,token){
  const ws=new WebSocket(url,"wtox-udp-v1");
  ws.binaryType="arraybuffer";
  await new Promise((resolve,reject)=>{
    let settled=false;
    const timeout=setTimeout(()=>{if(!settled){settled=true;reject(Error("bridge_timeout"));ws.close();}},8000);
    const fail=e=>{if(!settled){settled=true;clearTimeout(timeout);reject(e);}};
    ws.onerror=()=>fail(Error("bridge_error"));
    ws.onclose=()=>fail(Error("bridge_closed_during_authentication"));
    ws.onopen=()=>ws.send(JSON.stringify({type:"authenticate",token}));
    ws.onmessage=({data})=>{
      if(typeof data!=="string")return;
      try{
        ensure(JSON.parse(data).type==="ready","bridge_authentication_failed");
        if(!settled){settled=true;clearTimeout(timeout);resolve();}
      }catch(e){fail(e);}
    };
  });
  return ws;
}
async function main(config){
  const {url,token,port,proxyPort,receiverPort,publicKey}=config;
  ensure(/^ws:\/\/127\.0\.0\.1:\d+\/__wtox_dht_bridge$/.test(url),
         "network_target_must_be_loopback");
  ensure(typeof token==="string"&&/^[0-9a-f]{64}$/.test(token),"invalid_test_token");
  const ports=[port,proxyPort,receiverPort];
  ensure(ports.every(p=>Number.isInteger(p)&&p>=1025&&p<=65535) &&
         new Set(ports).size===3,"invalid_loopback_port_set");
  const allowed=new Set(ports);
  const bootstrapKey=hexBytes(publicKey,32);
  let m=null,ws=null,started=false;
  let buffer=0,meta=0,keyPtr=0,addressPtr=0;
  let requested=false,online=false,verified=false;
  let sent=0,received=0;
  closeRequested=false;
  commandQueue=[];
  try {
    m=await createModule();
    buffer=m._malloc(MAX);
    meta=m._malloc(16);
    keyPtr=m._malloc(32);
    addressPtr=m._malloc(38);
    ensure(buffer&&meta&&keyPtr&&addressPtr,"wasm_allocation_failed");
    ensure(m._wtox_vudp_probe_start()===0,"original_udp_tox_start_failed");
    started=true;
    ws=await openBridge(url,token);
    ws.onmessage=({data})=>{
      if(!(data instanceof ArrayBuffer)) {
        notice("ERROR",{message:"unexpected_transport_frame"});closeRequested=true;return;
      }
      const packet=new Uint8Array(data);
      const source=(packet[1]<<8)|packet[2];
      const length=(packet[3]<<8)|packet[4];
      if(packet.length<6 || packet[0]!==1 || !allowed.has(source) ||
         length!==packet.length-5 || length>MAX) {
        notice("ERROR",{message:"invalid_udp_transport_frame"});
        closeRequested=true;return;
      }
      m.HEAPU8.set(packet.subarray(5),buffer);
      const result=m._wtox_vudp_probe_push(buffer,length,source);
      if(result!==length){
        notice("ERROR",{message:"incoming_udp_queue_overflow"});
        closeRequested=true;
      } else ++received;
    };
    ws.onerror=()=>{notice("ERROR",{message:"transport_socket_error"});closeRequested=true;};
    ws.onclose=()=>{closeRequested=true;};
    m.HEAPU8.set(bootstrapKey,keyPtr);
    ensure(m._wtox_vudp_native_bootstrap(port,keyPtr,32)===0,
           "native_dht_bootstrap_failed");
    notice("BOOTSTRAPPING");

    // Never send unencrypted savedata to the page or over the transport.
    const passwordBytes=password=>{
      ensure(typeof password==="string","backup_password_required");
      const secret=encode.encode(password);
      if(secret.length<8 || secret.length>1024){
        secret.fill(0);throw Error("backup_password_length_invalid");
      }
      return secret;
    };
    function exportEncrypted(password){
      const secret=passwordBytes(password);
      let p=0,out=0,lengthPtr=0;
      try{
        const saved=m._wtox_vudp_savedata_size();
        ensure(saved>0 && saved<=1024*1024,"savedata_size_invalid");
        p=m._malloc(secret.length);
        out=m._malloc(saved+80);
        lengthPtr=m._malloc(4);
        ensure(p&&out&&lengthPtr,"backup_wasm_allocation_failed");
        m.HEAPU8.set(secret,p);
        const ret=m._wtox_vudp_export_encrypted(p,secret.length,
                             out,saved+80,lengthPtr);
        ensure(ret===0,"original_tox_encrypt_failed:"+ret);
        const n=new DataView(m.HEAPU8.buffer).getUint32(lengthPtr,true);
        ensure(n>80&&n<=saved+80,"encrypted_backup_size_invalid");
        const ciphertext=m.HEAPU8.slice(out,out+n);
        ensure(Array.from("toxEsave").every((ch,i)=>ciphertext[i]===ch.charCodeAt(0)),
               "not_standard_tox_encryptsave");
        notice("ENCRYPTED_BACKUP",{encryptedBackup:ciphertext});
      }finally{
        secret.fill(0);
        if(p){m.HEAPU8.fill(0,p,p+secret.length);m._free(p);}
        if(out){m.HEAPU8.fill(0,out,out+m._wtox_vudp_savedata_size()+80);m._free(out);}
        if(lengthPtr){m.HEAPU8.fill(0,lengthPtr,lengthPtr+4);m._free(lengthPtr);}
      }
    }
    function restoreEncrypted(command){
      ensure(command.backup instanceof Uint8Array &&
             command.backup.length>80 &&
             command.backup.length<=1024*1024+80,"invalid_encrypted_backup");
      const secret=passwordBytes(command.password);
      let p=0,b=0,id=0;
      try{
        p=m._malloc(secret.length);
        b=m._malloc(command.backup.length);
        id=m._malloc(38);
        ensure(p&&b&&id,"restore_wasm_allocation_failed");
        m.HEAPU8.set(secret,p);
        m.HEAPU8.set(command.backup,b);
        // Preflight against original c-toxcore BEFORE terminating online identity.
        const checked=m._wtox_inspect_encrypted(
          b,command.backup.length,p,secret.length,id);
        ensure(checked===0,"encrypted_backup_validation_failed:"+checked);
        ensure(m._wtox_vudp_native_address(addressPtr,38)===0,
               "original_network_identity_missing");
        const expected=hex(m.HEAPU8.slice(addressPtr,addressPtr+38));
        const recovered=hex(m.HEAPU8.slice(id,id+38));
        ensure(recovered===expected,"backup_identity_mismatch");
        m._wtox_vudp_probe_stop();
        started=false;
        const status=m._wtox_vudp_restore_encrypted(
          b,command.backup.length,p,secret.length);
        ensure(status===0,"native_network_savedata_restore_failed:"+status);
        started=true;
        ensure(m._wtox_vudp_native_address(addressPtr,38)===0,
               "restored_network_identity_missing");
        ensure(hex(m.HEAPU8.slice(addressPtr,addressPtr+38))===expected,
               "native_identity_changed_after_restore");
        ensure(m._wtox_vudp_native_friend_state(meta)===0,
               "restored_friend_query_failed");
        const listCount=new DataView(m.HEAPU8.buffer).getUint32(meta,true);
        requested=listCount===1;
        online=false;
        verified=false;
        sent=received=0;
        ensure(m._wtox_vudp_native_bootstrap(port,keyPtr,32)===0,
               "restored_native_dht_bootstrap_failed");
        notice("RESTORED",{toxId:expected,friendRestored:requested});
      }finally{
        secret.fill(0);
        if(p){m.HEAPU8.fill(0,p,p+secret.length);m._free(p);}
        if(b){m.HEAPU8.fill(0,b,b+command.backup.length);m._free(b);}
        if(id){m.HEAPU8.fill(0,id,id+38);m._free(id);}
        command.backup?.fill(0);
      }
    }

    const deadline=Date.now()+100000;
    while(!closeRequested){
      ensure(Date.now()<deadline,"local_manual_chat_session_timeout");
      ensure(ws.readyState===WebSocket.OPEN,"transport_disconnected");
      ensure(m._wtox_vudp_native_tick()===0,"native_tox_iterate_failed");
      for(let i=0;i<16;i++){
        const n=m._wtox_vudp_probe_take(buffer,MAX,meta);
        ensure(n>=0&&n<=MAX,"invalid_native_udp_datagram");
        if(n===0)break;
        const dest=new DataView(m.HEAPU8.buffer).getUint16(meta,true);
        ensure(allowed.has(dest),"udp_destination_not_authorized");
        const packet=new Uint8Array(5+n);
        packet[0]=1;packet[1]=dest>>>8;packet[2]=dest&255;
        packet[3]=n>>>8;packet[4]=n&255;
        packet.set(m.HEAPU8.subarray(buffer,buffer+n),5);
        ws.send(packet);
        ++sent;
      }
      if(!verified){
        const state=m._wtox_vudp_native_bootstrap_verified(keyPtr,32);
        ensure(state>=0,"dht_neighbor_query_failed");
        if(state===1&&sent>=2&&received>=2){
          verified=true;
          ensure(m._wtox_vudp_native_address(addressPtr,38)===0,
                 "native_tox_identity_missing");
          notice("READY",{toxId:hex(m.HEAPU8.slice(addressPtr,addressPtr+38))});
        }
      }
      if(verified){
        while(commandQueue.length){
          const command=commandQueue.shift();
          if(command.action==="EXPORT" || command.action==="RESTORE"){
            try{
              if(command.action==="EXPORT")exportEncrypted(command.password);
              else restoreEncrypted(command);
            }catch(err){notice("ACTION_ERROR",{message:String(err?.message||err)});}
            continue;
          }
          if(command.action==="REQUEST"){
            if(requested){notice("ACTION_ERROR",{message:"friend_request_already_queued"});continue;}
            try{
              const id=hexBytes(command.toxId,38);
              const text=encode.encode(command.message);
              ensure(text.length>=1&&text.length<=MAX_TEXT,"invalid_request_message_length");
              m.HEAPU8.set(id,addressPtr);
              m.HEAPU8.set(text,buffer);
              const ret=m._wtox_vudp_native_friend_request(
                addressPtr,38,buffer,text.length);
              ensure(ret===0,"original_friend_add_rejected:"+ret);
              requested=true;
              notice("REQUEST_QUEUED");
            }catch(err){notice("ACTION_ERROR",{message:String(err?.message||err)});}
          } else if(command.action==="SEND"){
            try {
              ensure(requested&&online,"friend_is_not_online");
              ensure(typeof command.message==="string","invalid_message");
              const bytes=encode.encode(command.message);
              ensure(bytes.length>=1&&bytes.length<=MAX_TEXT,"invalid_text_length");
              m.HEAPU8.set(bytes,buffer);
              const ret=m._wtox_vudp_native_friend_send(buffer,bytes.length);
              ensure(ret===0,"original_tox_send_failed:"+ret);
              notice("MESSAGE_SENT",{text:command.message});
            }catch(err){notice("ACTION_ERROR",{message:String(err?.message||err)});}
          }
        }
        if(requested && verified){
          ensure(m._wtox_vudp_native_friend_state(meta)===0,
                 "native_friend_query_failed");
          const status=new DataView(m.HEAPU8.buffer).getUint32(meta+4,true);
          const currentlyOnline=status!==0;
          if(online!==currentlyOnline){
            online=currentlyOnline;
            notice("FRIEND_STATUS",{online,connection:status});
          }
          const length=m._wtox_vudp_native_friend_take(buffer,MAX);
          ensure(length>=0,"native_friend_message_error");
          if(length>0){
            let text;
            try{text=decode.decode(m.HEAPU8.slice(buffer,buffer+length));}
            catch{text="[Non-UTF8 message]";}
            notice("MESSAGE_RECEIVED",{text});
          }
        }
      }
      await new Promise(resolve=>setTimeout(resolve,16));
    }
  } finally {
    ws?.close();
    if(started)m._wtox_vudp_probe_stop();
    if(m){
      if(buffer){m.HEAPU8.fill(0,buffer,buffer+MAX);m._free(buffer);}
      if(meta){m.HEAPU8.fill(0,meta,meta+16);m._free(meta);}
      if(keyPtr){m.HEAPU8.fill(0,keyPtr,keyPtr+32);m._free(keyPtr);}
      if(addressPtr){m.HEAPU8.fill(0,addressPtr,addressPtr+38);m._free(addressPtr);}
    }
    bootstrapKey.fill(0);
    commandQueue=[];
  }
}
