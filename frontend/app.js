// wtox browser client. Tox .tox savedata is the only personal login credential.
const $ = (selector) => document.querySelector(selector);
let profileKey = null;
let socket = null;
let historyDb = null;
let historyKey = null;
let selectedPeer = null;
let contacts = [];
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
async function unlockLocal() {
  const pass = $("#historyPass").value;
  if (pass.length < 12) throw new Error("本地历史口令至少需要 12 位");
  const saltEntry = await getMeta("salt");
  const salt = saltEntry ? new Uint8Array(saltEntry.value) : crypto.getRandomValues(new Uint8Array(16));
  const material = await crypto.subtle.importKey("raw", te.encode(pass), "PBKDF2", false, ["deriveKey"]);
  const derived = await crypto.subtle.deriveKey(
    {name:"PBKDF2",salt,iterations:250000,hash:"SHA-256"},
    material,{name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
  const check = await getMeta("check");
  if (check) {
    let marker;
    try { marker = await unseal(check.value, derived); }
    catch { throw new Error("本地历史口令不正确"); }
    if (marker !== "wtox-history-v1") throw new Error("本地历史文件校验失败");
  } else {
    await putMeta({id:"salt",value:b64(salt)});
    await putMeta({id:"check",value:await seal("wtox-history-v1",derived)});
  }
  historyKey=derived;
  $("#historyPass").value="";
  $("#historyLock").hidden=true;
  $("#historyActive").hidden=false;
  await recoverPending();
  await renderHistory();
}
async function persistEvent(event) {
  if (!historyDb || !historyKey) return false;
  if (!["message","friend_request"].includes(event.type)) return false;
  const id=event.id || crypto.randomUUID().replaceAll("-","");
  const record={
    id,
    at:event.created ? event.created*1000 : Date.now(),
    type:event.type,
    direction:event.direction || "incoming",
    public_key:event.public_key || "",
    text:event.text || "",
  };
  const enc=await seal(record,historyKey);
  const tx=historyDb.transaction("events","readwrite");
  tx.objectStore("events").put({id, ...enc});
  await txnDone(tx);
  // Only acknowledge after IndexedDB transaction completed successfully.
  if (event.id) await post("/api/ack",{ids:[event.id]});
  return true;
}
async function recoverPending() {
  if (!historyKey) return;
  const {pending}=await json("/api/pending");
  for(const record of pending) {
    try { await persistEvent({...record.event,id:record.id,created:record.created}); }
    catch(e){error("部分消息尚未保存："+e.message);break;}
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
  if(!historyDb||!historyKey){blankChat("聊天记录已加密","请先解锁本地历史以查看及发送消息","▣");return}
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
    stamp.textContent=new Date(e.at).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"})+(mine?" · 已提交发送接口":"");
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
    :!online(f)?"好友离线或尚未接受请求；Tox 目前只能向在线好友即时发送。草稿会保留。"
    :!historyKey?"好友在线，请先解锁本地加密历史。":"好友在线 · Enter 发送，Shift + Enter 换行。";
}
function selectPeer(key){
  selectedPeer=key;$("#peer").value=key;
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
    profileKey=null;historyKey=null;selectedPeer=null;contacts=[];
    $("#account").classList.remove("chat-open");
    if(historyDb)historyDb.close();historyDb=null;
    $("#login").hidden=false;$("#account").hidden=true;
    return;
  }
  if(!info.public_key){error("没有有效的 Tox 身份信息");return}
  if(profileKey!==info.public_key){
    historyKey=null;selectedPeer=null;contacts=[];
    $("#peer").value="";
    $("#account").classList.remove("chat-open");
    $("#selected").textContent="选择一个好友开始聊天";
    if(historyDb)historyDb.close();
    try{historyDb=await openHistory(info.public_key)}
    catch(e){historyDb=null;error("无法打开浏览器本地历史："+e.message)}
    $("#historyLock").hidden=false;$("#historyActive").hidden=true;
    $("#messages").replaceChildren();
  }
  profileKey=info.public_key;
  $("#login").hidden=true;$("#account").hidden=false;
  $("#welcome").textContent="当前身份："+profileKey.slice(0,18)+"…";
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
    await unlockLocal();updateComposer();closeDialog("#historyDialog");
    error("本地历史已解锁",false);
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
  const peer=selectedPeer,text=$("#message").value;
  if(!peer){error("请先选择一个好友");return}
  if(!historyKey){showDialog("#historyDialog");error("请先解锁本地加密历史");return}
  if(!online(selectedFriend())){
    error("好友离线或尚未接受请求。Tox 无法发送，草稿已保留。");return
  }
  if(!text.trim()){error("请输入消息内容");return}
  $("#send").disabled=true;
  try{
    await post("/api/messages",{public_key:peer,text});
    await persistEvent({type:"message",direction:"outgoing",public_key:peer,text});
    $("#message").value="";
    await renderHistory();
    error("");
  }catch(e){
    // An offline race means this message was NOT sent; keep it in the editor.
    error(e.message);
    await refreshFriends().catch(()=>{});
  }finally{updateComposer()}
}
$("#send").onclick=sendNow;
$("#message").onkeydown=event=>{
  if(event.key==="Enter"&&!event.shiftKey&&!event.isComposing){
    event.preventDefault();sendNow().catch(e=>error(e.message));
  }
};
window.addEventListener("focus",()=>{
  if(profileKey){refreshFriends().catch(()=>{});refreshNetwork().catch(()=>{})}
});
updateState();
