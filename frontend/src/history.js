// Compatible with the original wtox-local-<TOX_PUBLIC_KEY> IndexedDB schema.
// No plaintext, private keys or device CryptoKeys are sent to the VPS.
const enc=new TextEncoder();
const dec=new TextDecoder();
const KEY_ID="device-key-v2";
const CHECK_TEXT="wtox-history-device-v2";
const OLD_CHECK="wtox-history-v1";

function request(request){
  return new Promise((resolve,reject)=>{
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
}
function completed(transaction){
  return new Promise((resolve,reject)=>{
    transaction.oncomplete=resolve;
    transaction.onerror=()=>reject(transaction.error);
    transaction.onabort=()=>reject(transaction.error||new Error("存储事务已取消"));
  });
}
function openDb(owner){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open("wtox-local-"+owner,2);
    req.onupgradeneeded=()=>{
      const db=req.result;
      if(!db.objectStoreNames.contains("meta")) db.createObjectStore("meta",{keyPath:"id"});
      if(!db.objectStoreNames.contains("events"))db.createObjectStore("events",{keyPath:"id"});
      if(!db.objectStoreNames.contains("attachments"))db.createObjectStore("attachments",{keyPath:"id"});
    };
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
    req.onblocked=()=>reject(new Error("本地历史数据库被其他页面占用"));
  });
}
async function meta(db,id){return request(db.transaction("meta").objectStore("meta").get(id))}
async function cryptoSeal(value,key){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const bytes=await crypto.subtle.encrypt({name:"AES-GCM",iv},key,enc.encode(JSON.stringify(value)));
  return {iv:Array.from(iv),cipher:Array.from(new Uint8Array(bytes))};
}
async function cryptoOpen(value,key){
  const bytes=await crypto.subtle.decrypt(
    {name:"AES-GCM",iv:new Uint8Array(value.iv)},key,new Uint8Array(value.cipher));
  return JSON.parse(dec.decode(bytes));
}
async function allEncrypted(db){
  return request(db.transaction("events").objectStore("events").getAll());
}

export async function openIdentityHistory(owner){
  if(!/^[A-F0-9]{64}$/.test(owner))throw new Error("Tox 公钥格式不正确");
  const db=await openDb(owner);
  let key=null,needsMigration=false;
  try{
    const original=await meta(db,"check");
    const count=await request(db.transaction("events").objectStore("events").count());
    if(!original&&count>0)throw new Error("历史校验数据缺失，为安全起见不会覆盖已有记录");
    let record=await meta(db,KEY_ID);
    if(!record){
      const generated=await crypto.subtle.generateKey(
        {name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
      const check=!original?await cryptoSeal(CHECK_TEXT,generated):null;
      const tx=db.transaction("meta","readwrite");
      tx.objectStore("meta").put({id:KEY_ID,value:generated});
      if(check)tx.objectStore("meta").put({id:"check",value:check});
      await completed(tx);
      record={value:generated};
    }
    const device=record.value;
    if(device?.type!=="secret"||device.algorithm?.name!=="AES-GCM"||device.extractable)
      throw new Error("本地设备加密密钥格式不兼容");
    const marker=original||(await meta(db,"check"));
    try{
      if((await cryptoOpen(marker.value,device))!==CHECK_TEXT)throw new Error("marker");
      key=device;
    }catch{
      if(!await meta(db,"salt"))throw new Error("历史密钥不匹配；已保留现有数据");
      needsMigration=true;
    }

    async function migrate(password){
      if(!needsMigration) return;
      const salt=await meta(db,"salt"),oldCheck=await meta(db,"check");
      if(!salt||!oldCheck)throw new Error("旧历史加密信息不存在");
      const passkey=await crypto.subtle.importKey("raw",enc.encode(password),"PBKDF2",false,["deriveKey"]);
      const oldKey=await crypto.subtle.deriveKey({
        name:"PBKDF2",salt:new Uint8Array(salt.value),iterations:250000,hash:"SHA-256"
      },passkey,{name:"AES-GCM",length:256},false,["decrypt"]);
      try{
        if((await cryptoOpen(oldCheck.value,oldKey))!==OLD_CHECK)throw new Error("marker");
      }catch{throw new Error("旧本地历史口令不正确")}
      const originalRows=await allEncrypted(db);
      const converted=[];
      // Decrypt every record BEFORE writing, to avoid partial migrations.
      for(const row of originalRows){
        const plaintext=await cryptoOpen(row,oldKey);
        converted.push({id:row.id,...await cryptoSeal(plaintext,device)});
      }
      const replacement=await cryptoSeal(CHECK_TEXT,device);
      const tx=db.transaction(["meta","events"],"readwrite");
      for(const row of converted)tx.objectStore("events").put(row);
      tx.objectStore("meta").put({id:"check",value:replacement});
      tx.objectStore("meta").delete("salt");
      await completed(tx);
      key=device;needsMigration=false;
    }
    function requireKey(){
      if(!key)throw new Error("本地历史尚未解锁，需要先完成旧历史迁移");
    }
    async function read(){
      requireKey();
      const rows=await allEncrypted(db);
      const output=[];
      for(const row of rows)output.push(await cryptoOpen(row,key));
      return output.sort((a,b)=>(a.at||0)-(b.at||0));
    }
    async function persist(event){
      requireKey();
      if(!["message","friend_request"].includes(event.type))return false;
      const id=event.id||crypto.randomUUID().replaceAll("-","");
      if(await meta(db,"deleted-"+id))return false;
      const row={
        id,type:event.type,at:event.created?event.created*1000:(event.at||Date.now()),
        direction:event.direction||"incoming",
        public_key:event.public_key||"",
        text:event.text||"",
        message_id:event.direction==="outgoing"?event.message_id:undefined,
        session_id:event.direction==="outgoing"?event.session_id:undefined,
        delivery_status:event.direction==="outgoing"?(event.delivery_status||"sent"):undefined,
        outbox_id:event.direction==="outgoing"?(event.outbox_id||event.client_id):undefined
      };
      const cipher=await cryptoSeal(row,key);
      const tx=db.transaction("events","readwrite");
      tx.objectStore("events").put({id,...cipher});
      await completed(tx);
      return true;
    }
    async function deliverReceipt(event){
      requireKey();
      if(event.type!=="message_receipt"||!["delivered","read","sent"].includes(event.status)||
         !Number.isInteger(event.message_id)||!event.session_id||!event.public_key)return false;
      const rows=await allEncrypted(db);
      for(const row of rows){
        const plain=await cryptoOpen(row,key);
        if(plain.direction==="outgoing"&&plain.type==="message"&&
           plain.public_key===event.public_key&&plain.message_id===event.message_id&&
           plain.session_id===event.session_id){
          if(!["read","delivered"].includes(plain.delivery_status)){
            plain.delivery_status="delivered";
            const cipher=await cryptoSeal(plain,key);
            const tx=db.transaction("events","readwrite");
            tx.objectStore("events").put({id:row.id,...cipher});
            await completed(tx);
          }
          return true;
        }
      }
      return false;
    }
    async function persistFile(file){
      requireKey();
      if(!file?.id||!file.public_key||!file.name)return false;
      const id="file-"+file.id;
      // A removed transfer must not reappear on the next server file poll.
      if(await meta(db,"deleted-"+id))return false;
      const prior=await request(db.transaction("events").objectStore("events").get(id));
      let old=null;
      if(prior)old=await cryptoOpen(prior,key);
      const row={
        id,type:"file",
        at:old?.at||(file.created?file.created*1000:Date.now()),
        direction:file.direction||"incoming",
        public_key:file.public_key,
        text:"",
        file_id:file.id,
        file_name:file.name,
        file_size:file.size||0,
        file_state:file.state||"offered",
        file_progress:file.progress||0
      };
      const cipher=await cryptoSeal(row,key);
      const tx=db.transaction("events","readwrite");
      tx.objectStore("events").put({id,...cipher});
      await completed(tx);
      return true;
    }
    const IMAGE_CACHE_TTL=7*86400*1000;
    async function cacheImage(id,blob){
      requireKey();
      if(typeof id!=="string"||!/^[a-f0-9]{32}$/i.test(id))
        throw new Error("无效附件 ID");
      if(!blob||blob.size<=0||blob.size>15_000_000)
        throw new Error("图片缓存不能超过 15 MB");
      const iv=crypto.getRandomValues(new Uint8Array(12));
      const bytes=await crypto.subtle.encrypt({name:"AES-GCM",iv},key,await blob.arrayBuffer());
      const item={id,iv:Array.from(iv),cipher:new Uint8Array(bytes),
                  created:Date.now(),mime:blob.type||"application/octet-stream"};
      const tx=db.transaction("attachments","readwrite");
      tx.objectStore("attachments").put(item);
      await completed(tx);
    }
    async function cachedImage(id){
      requireKey();
      if(!id)return null;
      const item=await request(db.transaction("attachments").objectStore("attachments").get(id));
      if(!item)return null;
      if(Date.now()-item.created>=IMAGE_CACHE_TTL){
        const tx=db.transaction("attachments","readwrite");
        tx.objectStore("attachments").delete(id);await completed(tx);
        return null;
      }
      const raw=await crypto.subtle.decrypt({name:"AES-GCM",
        iv:new Uint8Array(item.iv)},key,item.cipher);
      return new Blob([raw],{type:item.mime||"application/octet-stream"});
    }
    async function expireImages(){
      const items=await request(db.transaction("attachments").objectStore("attachments").getAll());
      const stale=items.filter(x=>Date.now()-x.created>=IMAGE_CACHE_TTL);
      if(!stale.length)return 0;
      const tx=db.transaction("attachments","readwrite");
      for(const item of stale)tx.objectStore("attachments").delete(item.id);
      await completed(tx);
      return stale.length;
    }
    async function deleteCachedImage(id){
      const tx=db.transaction("attachments","readwrite");
      tx.objectStore("attachments").delete(id);
      await completed(tx);
    }
    async function deleteEvent(id){
      requireKey();
      if(typeof id!=="string"||id.length>200)throw new Error("消息 ID 无效");
      // Delete only this device's encrypted IndexedDB entry. Nothing is
      // sent to the Tox peer, and server-queued messages are not revoked.
      const tx=db.transaction(["events","meta"],"readwrite");
      tx.objectStore("events").delete(id);
      tx.objectStore("meta").put({id:"deleted-"+id,at:Date.now()});
      await completed(tx);
    }
    async function deleteConversation(peer){
      requireKey();
      if(typeof peer!=="string"||!/^[0-9a-f]{64}$/i.test(peer))
        throw new Error("好友公钥无效");
      // Encrypted event rows cannot be indexed by peer without leaking peer
      // metadata. Decrypt first, then commit all deletions atomically.
      const rows=await allEncrypted(db);
      const remove=[];
      const cachedFiles=new Set();
      for(const encrypted of rows){
        const plain=await cryptoOpen(encrypted,key);
        if(plain.public_key!==peer||!["message","file"].includes(plain.type))continue;
        remove.push(encrypted.id);
        if(plain.type==="file"&&plain.file_id)cachedFiles.add(plain.file_id);
      }
      if(!remove.length)return 0;
      const tx=db.transaction(["events","meta","attachments"],"readwrite");
      const events=tx.objectStore("events");
      const tombstones=tx.objectStore("meta");
      const attachments=tx.objectStore("attachments");
      const now=Date.now();
      for(const id of remove){
        events.delete(id);
        // An unacknowledged server replay must not resurrect erased records.
        tombstones.put({id:"deleted-"+id,at:now});
      }
      for(const fileId of cachedFiles)attachments.delete(fileId);
      await completed(tx);
      return remove.length;
    }
    async function patchEvent(id,changes){
      requireKey();
      const row=await request(db.transaction("events").objectStore("events").get(id));
      if(!row)throw new Error("本地消息不存在");
      const original=await cryptoOpen(row,key);
      if(original.type!=="message"||original.direction!=="outgoing")
        throw new Error("只能更新自己发送的消息");
      const modified={...original,...changes,id,at:original.at,
                      text:original.text,public_key:original.public_key};
      const ciphertext=await cryptoSeal(modified,key);
      const tx=db.transaction("events","readwrite");
      tx.objectStore("events").put({id,...ciphertext});
      await completed(tx);
      return modified;
    }

    async function applyOutboxStatuses(statuses){
      requireKey();
      if(!Array.isArray(statuses)||!statuses.length)return 0;
      const mapping=new Map(statuses.map(s=>[s.id,s]));
      const rows=await allEncrypted(db);
      const updates=[];
      for(const row of rows){
        const plain=await cryptoOpen(row,key);
        const entry=plain.outbox_id && mapping.get(plain.outbox_id);
        if(!entry||plain.direction!=="outgoing"||plain.type!=="message")continue;
        // Never downgrade a confirmed receipt after a later stale status poll.
        if(["delivered","read"].includes(plain.delivery_status))continue;
        const next=entry.status==="sent"?"sent":
                   entry.status==="failed"?"failed":
                   entry.status==="expired"?"failed":
                   entry.status==="uncertain"?"uncertain":"queued";
        if(plain.delivery_status===next&&
           plain.session_id===entry.session_id&&plain.message_id===entry.message_id)continue;
        plain.delivery_status=next;
        plain.session_id=entry.session_id||plain.session_id;
        plain.message_id=Number.isInteger(entry.message_id)?entry.message_id:plain.message_id;
        if(entry.error)plain.delivery_error=entry.error;
        updates.push({id:row.id,...await cryptoSeal(plain,key)});
      }
      if(updates.length){
        const tx=db.transaction("events","readwrite");
        for(const row of updates)tx.objectStore("events").put(row);
        await completed(tx);
      }
      return updates.length;
    }
    async function importMessages(rows){
      requireKey();
      if(rows.length>20000)throw new Error("导入记录超过 20000 条");
      const encrypted=[];
      for(const value of rows){
        const digest=await crypto.subtle.digest("SHA-256",enc.encode(
          owner+"\0"+value.public_key+"\0"+value.direction+"\0"+value.at+"\0"+value.text));
        const id="import-"+Array.from(new Uint8Array(digest).slice(0,16))
          .map(b=>b.toString(16).padStart(2,"0")).join("");
        encrypted.push({id,...await cryptoSeal({id,...value},key)});
      }
      const tx=db.transaction("events","readwrite");
      for(const value of encrypted)tx.objectStore("events").put(value);
      await completed(tx);
      return encrypted.length;
    }
    return {owner,ready:()=>!!key,needsMigration:()=>needsMigration,
      migrate,read,persist,persistFile,deleteEvent,deleteConversation,patchEvent,cacheImage,cachedImage,expireImages,deleteCachedImage,deliverReceipt,applyOutboxStatuses,importMessages,close:()=>db.close()};
  }catch(error){db.close();throw error}
}
