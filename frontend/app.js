// wtox browser client. Tox .tox savedata is the only personal login credential.
const $ = (selector) => document.querySelector(selector);
let profileKey = null;
let socket = null;
let historyDb = null;
let historyKey = null;
let selectedPeer = null;
const te = new TextEncoder();
const td = new TextDecoder();

function error(message = "") { $("#error").textContent = message; }
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
async function renderHistory() {
  if (!historyDb || !historyKey) return;
  const rows=await reqResult(historyDb.transaction("events").objectStore("events").getAll());
  const records=[];
  for(const row of rows) {
    try { records.push(await unseal(row,historyKey)); }
    catch { error("本地历史存在无法解密的内容"); }
  }
  records.sort((a,b)=>a.at-b.at);
  const log=$("#messages");
  log.replaceChildren();
  for(const record of records.slice(-100)){
    if (selectedPeer && record.public_key!==selectedPeer) continue;
    const item=document.createElement("div");
    item.className="event";
    const time=document.createElement("time");
    time.textContent=new Date(record.at).toLocaleString();
    const from=document.createElement("strong");
    from.textContent=record.type==="friend_request" ? "好友请求" : (record.direction==="outgoing" ? "我" : "对方");
    const body=document.createTextNode(": "+record.text);
    item.append(time,from,body);
    log.append(item);
  }
  log.scrollTop=log.scrollHeight;
}
function selectPeer(key){
  selectedPeer=key;
  $("#peer").value=key;
  $("#selected").textContent="正在与 "+key.slice(0,16)+"… 通信";
  renderHistory().catch(e=>error(e.message));
}
async function refreshFriends(){
  const {friends}=await json("/api/friends");
  const holder=$("#friends");holder.replaceChildren();
  if(!friends.length){holder.textContent="还没有好友";return}
  for(const friend of friends){
    const button=document.createElement("button");
    button.className="friend";
    button.textContent=(friend.name || friend.public_key.slice(0,12)+"…") +
      " · "+(["离线","TCP 在线","UDP 在线"][friend.status] || "未知");
    button.title=friend.public_key;
    button.onclick=()=>selectPeer(friend.public_key);
    holder.append(button);
  }
}
async function refreshNetwork(){
  const data=await json("/api/network");
  $("#network").textContent=["离线 / 连接中","通过 TCP Relay 在线","通过 UDP 在线"][data.status]||"未知状态";
}
function connectWebsocket(){
  if(socket) {socket.onclose=null;socket.close();}
  if(!profileKey) return;
  const protocol=location.protocol==="https:"?"wss:":"ws:";
  socket=new WebSocket(protocol+"//"+location.host+"/ws");
  socket.onopen=()=>{refreshNetwork().catch(()=>{});refreshFriends().catch(()=>{});};
  socket.onmessage=async ev=>{
    let data;
    try{data=JSON.parse(ev.data)}catch{return}
    if(["message","friend_request"].includes(data.type)){
      if(data.type==="friend_request") {
        $("#friendKey").value=data.public_key||"";
      }
      if(historyKey){
        try{await persistEvent(data);await renderHistory()}catch(e){error(e.message)}
      } else {
        error("收到新消息或好友请求：请先解锁本地历史以保存并领取。");
      }
    }else if(data.type==="friend_connection" || data.type==="connection"){
      refreshNetwork().catch(()=>{});refreshFriends().catch(()=>{});
    }
  };
  socket.onclose=()=>{
    if(profileKey){setTimeout(()=>{if(profileKey)connectWebsocket()},4500);}
  };
}
async function refreshIdentity(){
  const profile=await json("/api/profile/status");
  $("#ready").hidden=false;
  $("#toxid").textContent=profile.tox_id||"";
  await refreshNetwork().catch(e=>error(e.message));
  await refreshFriends().catch(e=>error(e.message));
  connectWebsocket();
}
async function updateState(){
  try{
    const info=await json("/api/me");
    if(!info.public_key) throw new Error("身份未激活");
    if(profileKey!==info.public_key){
      historyKey=null;
      selectedPeer=null;
      $("#peer").value="";
      $("#selected").textContent="请选择好友";
      if(historyDb) historyDb.close();
      historyDb=await openHistory(info.public_key);
      $("#historyLock").hidden=false;
      $("#historyActive").hidden=true;
      $("#messages").replaceChildren();
    }
    profileKey=info.public_key;
    $("#login").hidden=true;$("#account").hidden=false;
    $("#welcome").textContent="已登录 Tox 身份： "+profileKey.slice(0,16)+"…";
    await refreshIdentity();
  }catch(e){
    if(socket){socket.onclose=null;socket.close();socket=null;}
    profileKey=null;historyKey=null;selectedPeer=null;
    if(historyDb)historyDb.close();historyDb=null;
    $("#login").hidden=false;$("#account").hidden=true;
  }
}
$("#logout").onclick=async()=>{
  try{await post("/api/logout",{});error("");await updateState();}
  catch(e){error(e.message)}
};
$("#create").onclick=async()=>{
  if(!confirm("创建新的 Tox 身份并下载私人 .tox 备份？丢失备份将无法在新设备使用这个身份登录。"))return;
  error("");
  try{
    const response=await api("/api/tox/create",{method:"POST"});
    const blob=await response.blob();
    const filename="wtox-"+(response.headers.get("X-Tox-ID")||"new").slice(0,16)+".tox";
    const url=URL.createObjectURL(blob);
    const link=document.createElement("a");link.href=url;link.download=filename;link.click();
    setTimeout(()=>URL.revokeObjectURL(url),2500);
    await updateState();
    if(response.headers.get("X-Tox-Session-Started")!=="true")
      error("配置已创建并下载，但 Tox 网络会话尚未启动，请检查服务器日志");
  }catch(e){error(e.message)}
};
$("#import").onclick=async()=>{
  const file=$("#profileFile").files[0];
  if(!file){error("请先选择 .tox 配置文件");return}
  if(file.size>8*1024*1024){error("配置文件超过 8 MiB");return}
  error("");
  try{
    const response=await api("/api/tox/login",{
      method:"POST",raw:true,
      headers:{"Content-Type":"application/octet-stream"},body:file
    });
    const result=await response.json();
    $("#profileFile").value="";
    await updateState();
    if(!result.session_started) error("身份登录成功，但 Toxcore 网络会话未启动，请检查服务器日志");
  }catch(e){error(e.message)}
};
$("#legacyExport").onclick=async()=>{
  error("");
  try{
    const response=await api("/api/legacy/export");
    const blob=await response.blob();
    const url=URL.createObjectURL(blob);
    const link=document.createElement("a");
    link.href=url;link.download="wtox-legacy-backup.tox";link.click();
    setTimeout(()=>URL.revokeObjectURL(url),2500);
    error("旧 Tox 备份已请求下载。保存好文件后，用上方“使用 .tox 登录”进入新版。");
  }catch(e){error(e.message)}
};
$("#copyid").onclick=()=>navigator.clipboard.writeText($("#toxid").textContent).catch(e=>error(e.message));
$("#export").onclick=async()=>{
  try{
    const blob=await (await api("/api/profile/export")).blob();
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=url;a.download="wtox-private-profile.tox";a.click();
    setTimeout(()=>URL.revokeObjectURL(url),2000);
  }catch(e){error(e.message)}
};
$("#unlock").onclick=async()=>{try{error("");await unlockLocal()}catch(e){error(e.message)}};
$("#refresh").onclick=async()=>{try{await refreshNetwork();await refreshFriends()}catch(e){error(e.message)}};
$("#addFriend").onclick=async()=>{
  try{const data=await post("/api/friends",{
    address:$("#friendAddress").value.trim(),
    message:$("#requestText").value
  });selectPeer(data.public_key);await refreshFriends();error("")}
  catch(e){error(e.message)}
};
$("#deleteFriend").onclick=async()=>{
  const peer=($("#peer").value||"").trim().toUpperCase();
  if(!peer){error("请先选择好友");return}
  if(!confirm("确定删除该 Tox 好友？这不会删除你本机的历史记录。"))return;
  try{
    await api("/api/friends/"+encodeURIComponent(peer),{method:"DELETE"});
    selectedPeer=null;$("#peer").value="";$("#selected").textContent="请选择好友";
    await refreshFriends();await renderHistory();error("");
  }catch(e){error(e.message)}
};
$("#acceptFriend").onclick=async()=>{
  try{const data=await post("/api/friends/accept",{
    public_key:$("#friendKey").value.trim()
  });selectPeer(data.public_key);await refreshFriends();error("")}
  catch(e){error(e.message)}
};
$("#send").onclick=async()=>{
  if(!historyKey){error("请先解锁本地加密历史");return}
  const peer=$("#peer").value.trim().toUpperCase();
  const text=$("#message").value;
  try{
    await post("/api/messages",{public_key:peer,text});
    await persistEvent({type:"message",direction:"outgoing",public_key:peer,text});
    $("#message").value="";
    selectPeer(peer);
    await renderHistory();error("");
  }catch(e){error(e.message)}
};
updateState();
