import {MAX_HISTORY_IMPORT,toWtoxJson,fromWtoxJson,toQtoxTsv,fromQtoxTsv} from "./history_io.js";
// wtox browser client. Tox .tox savedata is the only personal login credential.
const $ = (selector) => document.querySelector(selector);
let profileKey = null;
let socket = null;
let historyDb = null;
let historyKey = null;
let deviceHistoryKey = null; // Non-extractable WebCrypto key stored per Tox ID in IndexedDB
let selectedPeer = null;
let contacts = [];
let drafts = new Map();
let sending = false;
let toastTimer;
const te = new TextEncoder();
const td = new TextDecoder();

function error(message = "", warning = true) {
  const e=$("#error");e.textContent=message;e.hidden=!message;e.classList.toggle("warning",warning);
  clearTimeout(toastTimer);if(message)toastTimer=setTimeout(()=>e.hidden=true,6500);
}
async function api(url, opts = {}) {
  const response = await fetch(url, {
    ...opts,
    headers: { ...(!opts.raw ? {"Content-Type": "application/json"} : {}),
               ...(opts.headers || {}) }
  });
  if (!response.ok) {
    let message = "请求失败 (" + response.status + ")";
    try { message = (await response.json()).detail || message; } catch {}
    throw new Error(message);
  }
  return response;
}
async function json(url, options) { return (await api(url, options)).json(); }
function post(url, data) { return json(url, {method:"POST", body:JSON.stringify(data)}); }
const b64 = (array) => Array.from(array);

function reqResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function txnDone(txn) {
  return new Promise((resolve, reject) => {
    txn.oncomplete = resolve;
    txn.onerror = () => reject(txn.error);
    txn.onabort = () => reject(txn.error);
  });
}
async function openHistory(user) {
  return new Promise((resolve,reject) => {
    const request = indexedDB.open("wtox-local-" + user, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("meta", {keyPath:"id"});
      db.createObjectStore("events", {keyPath:"id"});
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function getMeta(id) {
  return reqResult(historyDb.transaction("meta").objectStore("meta").get(id));
}
async function putMeta(value) {
  const tx = historyDb.transaction("meta", "readwrite");
  tx.objectStore("meta").put(value);
  await txnDone(tx);
}
async function seal(data, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const output = await crypto.subtle.encrypt({name:"AES-GCM",iv}, key, te.encode(JSON.stringify(data)));
  return {iv:b64(iv),cipher:b64(new Uint8Array(output))};
}
async function unseal(data, key) {
  const plaintext = await crypto.subtle.decrypt(
    {name:"AES-GCM",iv:new Uint8Array(data.iv)}, key, new Uint8Array(data.cipher));
  return JSON.parse(td.decode(plaintext));
}
// Stored only in this browser's per-Tox-public-key database. The AES key is
// marked non-extractable, and is never sent to the server or derived from the
// PUBLIC Tox ID (public IDs alone are not cryptographic secrets).
const AUTO_KEY_ID = "device-key-v2";
const AUTO_MARKER = "wtox-history-device-v2";
async function beginHistoryForIdentity(){
  if(!historyDb)throw new Error("浏览器不支持或无法打开加密历史数据库");
  historyKey = null;
  deviceHistoryKey = null;
  $("#historyLock").hidden = true;
  $("#historyActive").hidden = true;

  const check = await getMeta("check");
  const count = await reqResult(historyDb.transaction("events").objectStore("events").count());
  if(!check && count>0){
    throw new Error("本地历史验证信息丢失，已保留现有记录，请先备份浏览器数据");
  }
  // If a previous password-based database exists, generate the new key
  // without replacing any old events or their validation record.
  let keyRecord = await getMeta(AUTO_KEY_ID);
  if(!keyRecord){
    const key = await crypto.subtle.generateKey(
      {name:"AES-GCM",length:256},false,["encrypt","decrypt"]
    );
    const marker = !check ? await seal(AUTO_MARKER,key) : null;
    const tx = historyDb.transaction("meta","readwrite");
    tx.objectStore("meta").put({id:AUTO_KEY_ID,value:key});
    if(marker)tx.objectStore("meta").put({id:"check",value:marker});
    await txnDone(tx);
    keyRecord = {value:key};
  }
  if(!keyRecord.value || keyRecord.value.type!=="secret" ||
     keyRecord.value.algorithm?.name!=="AES-GCM"){
    throw new Error("浏览器历史密钥不可用，已保留已有消息");
  }
  deviceHistoryKey = keyRecord.value;
  // The check read before key generation may be empty on a new database.
  const markerEntry = check || await getMeta("check");
  if(markerEntry){
    try{
      const marker = await unseal(markerEntry.value,deviceHistoryKey);
      if(marker !== AUTO_MARKER)throw new Error("marker mismatch");
    }catch(exc){
      if(await getMeta("salt")){
        // Old PBKDF2+passphrase history. Do not overwrite or acknowledge
        // pending messages until every old event is re-encrypted atomically.
        $("#historyLock").hidden = false;
        $("#historyActive").hidden = true;
        error("检测到旧版加密历史：请在「本地加密聊天记录」中输入一次旧口令完成迁移",false);
        return;
      }
      throw new Error("本地历史密钥与现有数据不匹配。已保留数据，不会覆盖或删除");
    }
  }
  historyKey = deviceHistoryKey;
  $("#historyLock").hidden=true;
  $("#historyActive").hidden=false;
  $("#historyPass").value="";
  await recoverPending();
  await renderHistory();
  updateComposer();
}
async function migrateLegacyHistory(){
  if(!historyDb||!deviceHistoryKey)throw new Error("请先登录 Tox 身份");
  if(historyKey)return;
  const password=$("#historyPass").value;
  if(!password)throw new Error("请输入旧版历史口令");
  const saltEntry=await getMeta("salt");
  const check=await getMeta("check");
  if(!saltEntry||!check)throw new Error("未发现可以迁移的旧版历史");
  const salt=new Uint8Array(saltEntry.value);
  const material=await crypto.subtle.importKey("raw",te.encode(password),"PBKDF2",false,["deriveKey"]);
  const oldKey=await crypto.subtle.deriveKey(
    {name:"PBKDF2",salt,iterations:250000,hash:"SHA-256"},
    material,{name:"AES-GCM",length:256},false,["decrypt"]
  );
  let oldMarker;
  try{oldMarker=await unseal(check.value,oldKey)}
  catch{throw new Error("旧版历史口令不正确，原始历史没有改变")}
  if(oldMarker!=="wtox-history-v1")throw new Error("旧版历史校验失败，记录已保留");
  // Work is staged entirely in memory until every event passes decryption.
  const oldRows=await reqResult(historyDb.transaction("events").objectStore("events").getAll());
  const converted=[];
  for(const row of oldRows){
    let plain;
    try{plain=await unseal(row,oldKey)}
    catch{throw new Error("部分旧记录无法解密，为避免丢失已取消迁移")}
    converted.push({id:row.id,...await seal(plain,deviceHistoryKey)});
  }
  const newCheck=await seal(AUTO_MARKER,deviceHistoryKey);
  const tx=historyDb.transaction(["meta","events"],"readwrite");
  for(const row of converted)tx.objectStore("events").put(row);
  tx.objectStore("meta").put({id:"check",value:newCheck});
  tx.objectStore("meta").delete("salt");
  await txnDone(tx); // All-or-nothing IndexedDB transaction.
  $("#historyPass").value="";
  historyKey=deviceHistoryKey;
  $("#historyLock").hidden=true;
  $("#historyActive").hidden=false;
  await recoverPending();
  await renderHistory();
  updateComposer();
}
async function persistEvent(event) {
  if (!historyDb || !historyKey) throw new Error("本地历史密钥不可用，消息未保存");
  if (!["message","friend_request"].includes(event.type)) return false;
  const id=event.id || crypto.randomUUID().replaceAll("-","");
  const record={
    id,
    at:event.created ? event.created*1000 : Date.now(),
    type:event.type,
    direction:event.direction || "incoming",
    public_key:event.public_key || "",
    text:event.text || "",
    // Only native outgoing messages have receipt identifiers.
    message_id: event.direction==="outgoing" ? event.message_id : undefined,
    session_id: event.direction==="outgoing" ? event.session_id : undefined,
    delivery_status: event.direction==="outgoing" ? (event.delivery_status||"sent") : undefined,
  };
  const enc=await seal(record,historyKey);
  const tx=historyDb.transaction("events","readwrite");
  tx.objectStore("events").put({id, ...enc});
  await txnDone(tx);
  // Only acknowledge after IndexedDB transaction completed successfully.
  if (event.id) await post("/api/ack",{ids:[event.id]});
  return true;
}
async function applyMessageReceipt(event) {
  if(!historyDb||!historyKey)return false;
  // Restrict matching to a single native Toxcore instance. Message IDs can
  // be reused when a Tox profile is restored after a process restart.
  if(event.type!=="message_receipt" || !["read","sent"].includes(event.status) ||
     typeof event.public_key!=="string" ||
     typeof event.session_id!=="string" ||
     !Number.isInteger(event.message_id))return false;
  const rows=await reqResult(historyDb.transaction("events").objectStore("events").getAll());
  for(const row of rows){
    const record=await unseal(row,historyKey);
    if(record.type==="message" && record.direction==="outgoing" &&
       record.public_key===event.public_key &&
       record.session_id===event.session_id &&
       record.message_id===event.message_id){
      if(record.delivery_status!=="read"){
        record.delivery_status="read";
        const encrypted=await seal(record,historyKey);
        const tx=historyDb.transaction("events","readwrite");
        tx.objectStore("events").put({id:row.id,...encrypted});
        await txnDone(tx);
      }
      // Server can discard the receipt only after local persistence succeeds.
      if(event.id)await post("/api/ack",{ids:[event.id]});
      await renderHistory();
      return true;
    }
  }
  // In-flight race: a receipt can precede the HTTP send response and local
  // history insert. Keep the server-side receipt pending for later retry.
  return false;
}
async function recoverPending() {
  if (!historyKey) return;
  const {pending}=await json("/api/pending");
  for(const record of pending) {
    try{
      const event={...record.event,id:record.id,created:record.created};
      if(event.type==="message_receipt"){
        await applyMessageReceipt(event);
      }else{
        await persistEvent(event);
      }
    }catch(e){error("部分消息或回执尚未保存："+e.message);break;}
  }
}

function blankChat(title, subtitle, icon="✦"){
  const pane=$("#messages");pane.replaceChildren();
  const block=document.createElement("div");block.className="conversation-empty";
  const sym=document.createElement("span");sym.className="empty-symbol";sym.textContent=icon;
  const strong=document.createElement("strong");strong.textContent=title;
  const desc=document.createElement("span");desc.textContent=subtitle;
  block.append(sym,strong,desc);pane.append(block);
}
async function renderHistory(){
  if(!selectedPeer){blankChat("你的私人通讯空间","从左侧选择好友，开始一段对话");return}
  if(!historyDb||!historyKey){blankChat("本地历史暂未就绪","如需迁移旧数据，请打开「本地加密聊天记录」","▣");return}
  const rows=await reqResult(historyDb.transaction("events").objectStore("events").getAll());
  const entries=[];
  for(const row of rows){
    try{const e=await unseal(row,historyKey);if(e.public_key===selectedPeer)entries.push(e)}
    catch{error("部分历史无法解密")}
  }
  entries.sort((a,b)=>a.at-b.at);
  if(!entries.length){blankChat("还没有聊天记录","好友接受请求并在线后可以发送消息","✉");return}
  const pane=$("#messages");pane.replaceChildren();let prevDay="";
  for(const e of entries.slice(-200)){
    const day=new Date(e.at).toLocaleDateString("zh-CN");
    if(prevDay!==day){const div=document.createElement("div");div.className="day-divider";div.textContent=day;pane.append(div);prevDay=day}
    if(e.type==="friend_request"){const div=document.createElement("div");div.className="bubble-request";div.textContent="好友请求 · "+e.text;pane.append(div);continue}
    const mine=e.direction==="outgoing";
    const row=document.createElement("div");row.className="bubble-row"+(mine?" mine":"");
    const bubble=document.createElement("div");bubble.className="bubble";bubble.textContent=e.text||"";
    const stamp=document.createElement("div");stamp.className="bubble-info";
    stamp.textContent=new Date(e.at).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"})+(mine?(e.delivery_status==="read"?" · 已读取":" · 已发送"):"");
    if(mine)stamp.title="已发送：本机 Toxcore 接受消息；已读取：对方 Tox 客户端回执，不保证本人阅读";
    row.append(bubble,stamp);pane.append(row);
  }
  pane.scrollTop=pane.scrollHeight;
}
function online(f){return f&&(f.status===1||f.status===2)}
function statusText(s){return s===2?"UDP 在线":s===1?"TCP 在线":"离线"}
function selectedFriend(){return contacts.find(f=>f.public_key===selectedPeer)}
function updateComposer(){
  const f=selectedFriend(),ready=!!f&&online(f)&&!!historyKey;
  $("#send").disabled=!ready;
  $("#deleteFriend").disabled=!f;
  $("#selectedStatus").textContent=!f?"选择一个好友开始聊天":statusText(f.status)+(online(f)?" · 可以发送":" · 等待对方上线");
  $("#peerAvatar").textContent=f?(f.name||f.public_key).slice(0,1).toUpperCase():"✦";
  const hint=$("#sendHint");hint.classList.toggle("warn",!!f&&!online(f));
  hint.textContent=!f?"选择联系人后可以发送消息。"
    :!online(f)?"好友离线或尚未接受请求；Tox 目前只能向在线好友即时发送。草稿会保留在当前页面。"
    :!historyKey?"好友在线，请先解锁本地加密历史。":"好友在线 · Enter 发送，Shift + Enter 换行。";
}
function selectPeer(key){
  if(selectedPeer && selectedPeer!==key) drafts.set(selectedPeer,$("#message").value);
  selectedPeer=key;$("#peer").value=key;
  $("#message").value=drafts.get(key)||"";
  const f=selectedFriend();$("#selected").textContent=f?(f.name||"Tox 好友 "+key.slice(0,10)+"…"):"Tox 好友";
  $("#account").classList.add("chat-open");
  renderContacts();updateComposer();renderHistory().catch(e=>error(e.message));
}
function renderContacts(){
  const list=$("#friends");list.replaceChildren();
  $("#friendCount").textContent=String(contacts.length);
  const q=$("#contactSearch").value.trim().toLowerCase();
  const sorted=[...contacts].sort((a,b)=>Number(online(b))-Number(online(a))||
    (a.name||a.public_key).localeCompare(b.name||b.public_key));
  const visible=sorted.filter(f=>(f.name+" "+f.public_key).toLowerCase().includes(q));
  if(!visible.length){
    const e=document.createElement("div");e.className="no-contacts";
    const title=document.createElement("strong");title.textContent=contacts.length?"没有匹配的好友":"还没有联系人";
    const sub=document.createElement("span");sub.textContent=contacts.length?"尝试其他搜索词":"点击下方添加好友";
    e.append(title,sub);list.append(e);
  }
  for(const f of visible){
    const btn=document.createElement("button");btn.className="contact"+(selectedPeer===f.public_key?" active":"");
    const avatar=document.createElement("span");avatar.className="avatar";avatar.textContent=(f.name||f.public_key).slice(0,1).toUpperCase();
    const body=document.createElement("span");body.className="contact-body";
    const name=document.createElement("span");name.className="contact-main";
    name.textContent=f.name||"Tox 好友 "+f.public_key.slice(0,9)+"…";
    const status=document.createElement("span");status.className="contact-sub"+(online(f)?" online":"");
    const dot=document.createElement("i");dot.className="presence"+(online(f)?" online":"");
    const label=document.createElement("span");label.textContent=statusText(f.status);
    status.append(dot,label);body.append(name,status);
    const arrow=document.createElement("span");arrow.className="contact-arrow";arrow.textContent="›";
    btn.title=f.public_key;btn.append(avatar,body,arrow);btn.onclick=()=>selectPeer(f.public_key);
    list.append(btn);
  }
}
async function refreshFriends(){
  const data=await json("/api/friends");contacts=data.friends||[];
  if(selectedPeer&&!selectedFriend()){
    drafts.delete(key);
    selectedPeer=null;$("#peer").value="";$("#selected").textContent="选择一个好友开始聊天";
    $("#account").classList.remove("chat-open");await renderHistory();
  }
  renderContacts();updateComposer();
}
async function refreshNetwork(){
  const data=await json("/api/network");
  $("#network").textContent=data.status===0?"Tox 连接中":statusText(data.status);
  $("#networkDot").classList.toggle("online",data.status===1||data.status===2);
  $("#networkDot").classList.toggle("pending",data.status===0||data.status===-1);
}

function connectWebsocket(){
  if(socket){socket.onclose=null;socket.close();}
  if(!profileKey)return;
  const owner=profileKey;
  const protocol=location.protocol==="https:"?"wss:":"ws:";
  socket=new WebSocket(protocol+"//"+location.host+"/ws");
  socket.onopen=()=>{
    refreshNetwork().catch(()=>{});refreshFriends().catch(()=>{});
  };
  socket.onmessage=async message=>{
    let event;
    try{event=JSON.parse(message.data)}catch{return}
    if(event.type==="message"||event.type==="friend_request"){
      if(event.type==="friend_request"){
        $("#friendKey").value=event.public_key||"";
        error("收到好友请求！点击「添加好友」中的接受按钮处理。",false);
      }
      if(historyKey){
        try{await persistEvent(event);await renderHistory()}
        catch(e){error("保存聊天记录失败："+e.message)}
      }else{
        error("收到新消息或好友请求：请先解锁本地加密历史。",false);
      }
    }
    if(event.type==="message_receipt"){
      try{await applyMessageReceipt(event)}
      catch(e){error("消息状态保存失败："+e.message)}
    }
    if(event.type==="file"){
      refreshFiles().catch(()=>{});
      if(event.state==="offered"){
        error("收到新的 Tox 附件请求："+event.name+"。打开📎附件窗口决定是否接收。",false);
      }
    }
    if(["friend_connection","connection"].includes(event.type)){
      refreshNetwork().catch(()=>{});
      refreshFriends().catch(()=>{});
    }
  };
  socket.onclose=()=>{
    if(profileKey===owner)setTimeout(()=>{if(profileKey===owner)connectWebsocket()},4500);
  };
}
async function refreshIdentity(){
  const info=await json("/api/profile/status");
  $("#toxid").textContent=info.tox_id||"";
  await Promise.all([
    refreshNetwork().catch(e=>error(e.message)),
    refreshFriends().catch(e=>error(e.message))
  ]);
  connectWebsocket();
}
async function updateState(){
  let info;
  try{info=await json("/api/me")}
  catch{
    if(socket){socket.onclose=null;socket.close();socket=null}
    profileKey=null;historyKey=null;deviceHistoryKey=null;selectedPeer=null;contacts=[];
    $("#account").classList.remove("chat-open");
    if(historyDb)historyDb.close();historyDb=null;
    $("#login").hidden=false;$("#account").hidden=true;
    return;
  }
  if(!info.public_key){error("没有有效的 Tox 身份信息");return}
  if(profileKey!==info.public_key){
    historyKey=null;deviceHistoryKey=null;selectedPeer=null;contacts=[];drafts=new Map();
    $("#peer").value="";
    $("#account").classList.remove("chat-open");
    $("#selected").textContent="选择一个好友开始聊天";
    if(historyDb)historyDb.close();
    try{historyDb=await openHistory(info.public_key)}
    catch(e){historyDb=null;error("无法打开浏览器本地历史："+e.message)}
    $("#messages").replaceChildren();
  }
  profileKey=info.public_key;
  $("#login").hidden=true;$("#account").hidden=false;
  $("#welcome").textContent="当前身份："+profileKey.slice(0,18)+"…";
  if(historyDb && !historyKey){
    try{await beginHistoryForIdentity()}
    catch(e){
      $("#historyLock").hidden = true;
      $("#historyActive").hidden = true;
      error("本地历史无法自动解锁："+e.message);
    }
  }
  await refreshIdentity();
}
function downloadBlob(blob,name){
  const url=URL.createObjectURL(blob);
  const link=document.createElement("a");link.href=url;link.download=name;
  document.body.append(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),3000);
}
function showDialog(selector){const element=$(selector);if(!element.open)element.showModal()}
function closeDialog(selector){const element=$(selector);if(element.open)element.close()}
$("#openAdd").onclick=()=>showDialog("#addDialog");
$("#closeAdd").onclick=()=>closeDialog("#addDialog");
$("#openIdentity").onclick=()=>showDialog("#identityDialog");
$("#closeIdentity").onclick=()=>closeDialog("#identityDialog");
$("#historyButton").onclick=()=>showDialog("#historyDialog");
$("#historyFromContacts").onclick=()=>showDialog("#historyDialog");
$("#closeHistory").onclick=()=>closeDialog("#historyDialog");
const FILE_LIMIT = 5*1024*1024;
const transferStates = {
  offered:"等待你接受",waiting:"等待对方接受",receiving:"正在接收",
  sending:"正在发送",completed:"已完成",failed:"传输失败",
  cancelled:"已取消"
};
async function refreshFiles(){
  const result=await json("/api/files");
  const box=$("#transferList");box.replaceChildren();
  const files=result.files||[];
  if(!files.length){
    const div=document.createElement("p");
    div.className="muted";div.textContent="当前没有附件传输";
    box.append(div);return;
  }
  for(const f of files){
    const card=document.createElement("div");card.className="transfer-card";
    const label=document.createElement("strong");label.textContent=f.name;
    const status=document.createElement("small");
    const bytes=Math.round(f.size/1024);
    status.textContent=(f.direction==="incoming"?"收件":"发件")+
      " · "+(transferStates[f.state]||f.state)+" · "+bytes+" KiB"+
      (f.progress ? " · "+Math.floor(f.progress/f.size*100)+"%" : "");
    card.append(label,status);
    if(f.direction==="incoming" && f.state==="offered"){
      const accept=document.createElement("button");accept.className="button primary";accept.textContent="接受";
      const reject=document.createElement("button");reject.className="button subtle";reject.textContent="拒绝";
      accept.onclick=async()=>{try{await post("/api/files/"+encodeURIComponent(f.id)+"/accept",{});await refreshFiles()}catch(e){error(e.message)}};
      reject.onclick=async()=>{try{await post("/api/files/"+encodeURIComponent(f.id)+"/reject",{});await refreshFiles()}catch(e){error(e.message)}};
      const actions=document.createElement("div");actions.className="button-row";actions.append(accept,reject);card.append(actions);
    }
    if(f.direction==="incoming" && f.state==="completed"){
      const btn=document.createElement("button");btn.className="button primary";btn.textContent="下载文件";
      btn.onclick=async()=>{try{
        const blob=await(await api("/api/files/"+encodeURIComponent(f.id)+"/download")).blob();
        downloadBlob(blob,f.name);
        error("文件已保存到浏览器下载目录。请检查文件安全性。",false);
      }catch(e){error(e.message)}};
      card.append(btn);
    }
    box.append(card);
  }
}
$("#openFiles").onclick=()=>{
  showDialog("#fileDialog");
  refreshFiles().catch(e=>error(e.message));
};
$("#closeFiles").onclick=()=>closeDialog("#fileDialog");
$("#refreshFiles").onclick=()=>refreshFiles().catch(e=>error(e.message));
$("#sendAttachment").onclick=async()=>{
  const file=$("#attachmentFile").files[0];
  if(!selectedPeer){error("先选择一个好友再发送附件");return}
  if(!online(selectedFriend())){error("好友不在线，无法开始附件传输");return}
  if(!file){error("请选择要发送的文件");return}
  if(!file.size || file.size>FILE_LIMIT){error("附件大小必须为 1 字节至 5 MiB");return}
  if(!confirm("发送 "+file.name+" 给当前 Tox 好友？"))return;
  const btn=$("#sendAttachment");btn.disabled=true;
  try{
    const url="/api/files/send?peer="+encodeURIComponent(selectedPeer)+"&name="+encodeURIComponent(file.name);
    await api(url,{method:"POST",raw:true,
      headers:{"Content-Type":"application/octet-stream"},body:file});
    $("#attachmentFile").value="";
    await refreshFiles();
    error("已发出附件请求，等待好友接受。",false);
  }catch(e){error(e.message)}
  finally{btn.disabled=false}
};

async function readDecryptedHistory(){
  if(!historyDb||!historyKey)throw new Error("当前身份的本地历史未就绪");
  const rows=await reqResult(historyDb.transaction("events").objectStore("events").getAll());
  if(rows.length>20000)throw new Error("记录太多，请先按好友分批备份");
  const output=[];
  for(const row of rows){
    const record=await unseal(row,historyKey);
    if(record.type==="message")output.push(record);
  }
  output.sort((a,b)=>a.at-b.at);
  return output;
}
function exportHistoryFile(body,name,type){
  if(!confirm("导出的聊天记录是未加密明文，可能包含敏感信息。确定导出并妥善保护文件吗？"))return;
  downloadBlob(new Blob([body],{type}),name);
}
$("#historyExportJson").onclick=async()=>{
  try{
    const data=await readDecryptedHistory();
    const json=toWtoxJson(data,profileKey);
    exportHistoryFile(json,"wtox-history-"+profileKey.slice(0,12)+".json","application/json");
  }catch(e){error(e.message)}
};
$("#historyExportQtox").onclick=async()=>{
  try{
    if(!selectedPeer)throw new Error("请先选择一个好友，再导出 qTox 聊天文本");
    const friend=selectedFriend();
    const text=toQtoxTsv(await readDecryptedHistory(),selectedPeer,friend?.name||"Tox Friend");
    exportHistoryFile(text,"wtox-qtox-"+selectedPeer.slice(0,12)+".txt","text/plain;charset=utf-8");
  }catch(e){error(e.message)}
};
$("#historyImport").onclick=async()=>{
  try{
    if(!historyDb||!historyKey)throw new Error("本地加密历史尚未就绪");
    const file=$("#historyImportFile").files[0];
    if(!file)throw new Error("请选择聊天记录文件");
    if(file.size>MAX_HISTORY_IMPORT)throw new Error("历史文件超过 8 MiB");
    const text=await file.text();
    let entries;
    if(file.name.toLowerCase().endsWith(".json")){
      entries=fromWtoxJson(text,profileKey);
    }else if(file.name.toLowerCase().endsWith(".txt")){
      if(!selectedPeer)throw new Error("导入 qTox TXT 前先选择目标好友");
      entries=fromQtoxTsv(text,selectedPeer,$("#historyOwnName").value.trim());
    }else{
      throw new Error("不支持此文件格式：请选择 wtox JSON 或 qTox 导出 TXT");
    }
    if(!entries.length)throw new Error("文件里没有可导入的聊天消息");
    if(!confirm("即将向此浏览器导入 "+entries.length+" 条消息，仅保存在当前 Tox 身份的本地历史。继续吗？"))return;
    const encrypted=[];
    // Precompute crypto results before opening a transaction, to ensure it
    // won't auto-commit while awaiting WebCrypto operations.
    for(const row of entries){
      const fingerprint=await crypto.subtle.digest("SHA-256",te.encode(
        profileKey+"\0"+row.public_key+"\0"+row.direction+"\0"+row.at+"\0"+row.text));
      const id="import-"+[...new Uint8Array(fingerprint)].slice(0,16)
        .map(x=>x.toString(16).padStart(2,"0")).join("");
      encrypted.push({id,...await seal({...row,id},historyKey)});
    }
    const tx=historyDb.transaction("events","readwrite");
    for(const row of encrypted)tx.objectStore("events").put(row);
    await txnDone(tx);
    await renderHistory();
    $("#historyImportFile").value="";
    error("已导入 "+encrypted.length+" 条消息。重复导入相同文件不会重复添加。",false);
  }catch(e){error("历史导入失败："+e.message)}
};

$("#backToContacts").onclick=()=>$("#account").classList.remove("chat-open");
$("#contactSearch").oninput=renderContacts;
$("#logout").onclick=async()=>{
  try{await post("/api/logout",{});error("");await updateState()}
  catch(e){error(e.message)}
};
$("#create").onclick=async()=>{
  if(!confirm("确定创建新 Tox 身份并下载 .tox 私钥备份？请安全保存该文件。"))return;
  try{
    const response=await api("/api/tox/create",{method:"POST"});
    const blob=await response.blob();
    downloadBlob(blob,"wtox-"+(response.headers.get("X-Tox-ID")||"new").slice(0,16)+".tox");
    await updateState();
    if(response.headers.get("X-Tox-Session-Started")!=="true")
      error("身份创建成功，但网络会话未启动。可检查容器日志。");
    else error("已创建 Tox 身份。请妥善保存刚下载的 .tox 备份！",false);
  }catch(e){error(e.message)}
};
$("#import").onclick=async()=>{
  const file=$("#profileFile").files[0];
  if(!file){error("请选择 .tox 配置文件");return}
  if(file.size>8*1024*1024){error("配置文件超过 8 MiB");return}
  try{
    const response=await api("/api/tox/login",{
      method:"POST",raw:true,
      headers:{"Content-Type":"application/octet-stream"},body:file
    });
    const result=await response.json();
    $("#profileFile").value="";
    await updateState();
    if(!result.session_started)error("身份已登录，但 Tox 网络会话未启动。");
  }catch(e){error(e.message)}
};
$("#legacyExport").onclick=async()=>{
  try{
    const blob=await(await api("/api/legacy/export")).blob();
    downloadBlob(blob,"wtox-legacy-backup.tox");
    error("已下载旧身份备份，请保存后使用上方 .tox 登录。",false);
  }catch(e){error(e.message)}
};
$("#copyid").onclick=async()=>{
  try{await navigator.clipboard.writeText($("#toxid").textContent);error("Tox ID 已复制",false)}
  catch(e){error(e.message)}
};
$("#export").onclick=async()=>{
  try{
    const blob=await(await api("/api/profile/export")).blob();
    downloadBlob(blob,"wtox-private-profile.tox");
    error("Tox 私钥备份已下载，请妥善保存。",false);
  }catch(e){error(e.message)}
};
$("#unlock").onclick=async()=>{
  try{
    await migrateLegacyHistory();
    closeDialog("#historyDialog");
    error("旧聊天历史已加密迁移，以后无需再输入本地口令",false);
  }catch(e){error(e.message)}
};
$("#refresh").onclick=async()=>{
  try{await refreshNetwork();await refreshFriends();error("联系人列表已刷新",false)}
  catch(e){error(e.message)}
};
$("#addFriend").onclick=async()=>{
  try{
    const data=await post("/api/friends",{
      address:$("#friendAddress").value.trim(),
      message:$("#requestText").value
    });
    await refreshFriends();selectPeer(data.public_key);
    closeDialog("#addDialog");
    error("好友请求已保存。需要对方接受并上线后才能发送消息。",false);
  }catch(e){error(e.message)}
};
$("#acceptFriend").onclick=async()=>{
  try{
    const data=await post("/api/friends/accept",{public_key:$("#friendKey").value.trim()});
    await refreshFriends();selectPeer(data.public_key);
    closeDialog("#addDialog");
    error("好友已添加，等待建立 Tox 连接。",false);
  }catch(e){error(e.message)}
};
$("#deleteFriend").onclick=async()=>{
  const key=selectedPeer;
  if(!key)return;
  if(!confirm("确定删除这个 Tox 好友？已保存的本地聊天历史不会被删除。"))return;
  try{
    await api("/api/friends/"+encodeURIComponent(key),{method:"DELETE"});
    selectedPeer=null;$("#peer").value="";
    $("#account").classList.remove("chat-open");
    $("#selected").textContent="选择一个好友开始聊天";
    await refreshFriends();await renderHistory();
    error("好友已从 Tox Savedata 删除",false);
  }catch(e){error(e.message)}
};
async function sendNow(){
  if(sending)return;
  const peer=selectedPeer,text=$("#message").value;
  if(!peer){error("请先选择一个好友");return}
  if(!historyKey){showDialog("#historyDialog");error("本地历史尚未就绪，如有旧历史请迁移");return}
  if(!online(selectedFriend())){
    error("好友离线或尚未接受请求。Tox 无法发送，草稿会保留在当前页面。");return
  }
  if(!text.trim()){error("请输入消息内容");return}
  sending=true;$("#send").disabled=true;
  try{
    const result=await post("/api/messages",{public_key:peer,text});
    // Native Toxcore accepted the send. Never leave the old draft in the
    // editor if IndexedDB fails, as re-sending could duplicate the message.
    drafts.delete(peer);
    if(selectedPeer===peer)$("#message").value="";
    try{
      await persistEvent({
        type:"message",direction:"outgoing",public_key:peer,text,
        session_id:result.session_id,
        message_id:result.message_id,
        delivery_status:result.status||"sent",
      });
      // Resolve receipts that arrived before the HTTP response or IndexedDB
      // write. A non-ACKed receipt remains in the seven-day pending queue.
      await recoverPending();
      await renderHistory();
      error("");
    }catch(e){error("已发送到 Tox 网络，但本地历史保存失败："+e.message)}
  }catch(e){
    // Tox error 3 means nothing was sent. Keep per-peer unsent draft.
    drafts.set(peer,text);
    if(selectedPeer===peer)$("#message").value=text;
    error(e.message);
    await refreshFriends().catch(()=>{});
  }finally{sending=false;updateComposer()}
}
$("#send").onclick=sendNow;
$("#message").oninput=()=>{if(selectedPeer) drafts.set(selectedPeer,$("#message").value)};
$("#message").onkeydown=event=>{
  if(event.key==="Enter"&&!event.shiftKey&&!event.isComposing){
    event.preventDefault();sendNow().catch(e=>error(e.message));
  }
};
window.addEventListener("focus",()=>{
  if(profileKey){refreshFriends().catch(()=>{});refreshNetwork().catch(()=>{})}
});
updateState();
