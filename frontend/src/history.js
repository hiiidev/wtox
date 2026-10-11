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
    const req=indexedDB.open("wtox-local-"+owner,1);
    req.onupgradeneeded=()=>{
      const db=req.result;
      if(!db.objectStoreNames.contains("meta")) db.createObjectStore("meta",{keyPath:"id"});
      if(!db.objectStoreNames.contains("events"))db.createObjectStore("events",{keyPath:"id"});
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
      const row={
        id,type:event.type,at:event.created?event.created*1000:(event.at||Date.now()),
        direction:event.direction||"incoming",
        public_key:event.public_key||"",
        text:event.text||"",
        message_id:event.direction==="outgoing"?event.message_id:undefined,
        session_id:event.direction==="outgoing"?event.session_id:undefined,
        delivery_status:event.direction==="outgoing"?(event.delivery_status||"sent"):undefined
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
      migrate,read,persist,deliverReceipt,importMessages,close:()=>db.close()};
  }catch(error){db.close();throw error}
}
