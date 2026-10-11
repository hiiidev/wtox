import React, {useCallback,useEffect,useMemo,useRef,useState} from "react";
import { ConfigProvider, theme as antdTheme, Button as AntButton, Input, Tag,
  Space, Tooltip, Segmented, Avatar, Divider, Popconfirm } from "antd";
import { Bubble, Conversations, Sender } from "@ant-design/x";
import { PaperClipOutlined, SettingOutlined, ArrowLeftOutlined,
  UserAddOutlined, DeleteOutlined, CloudOutlined, CloudSyncOutlined,
  MessageOutlined } from "@ant-design/icons";
import {api,getJson,postJson,downloadBlob,shortKey,statusLabel} from "./api.js";
import {openIdentityHistory} from "./history.js";
import {MAX_HISTORY_IMPORT,toWtoxJson,fromWtoxJson} from "../history_io.js";

const online=friend=>friend && (friend.status===1||friend.status===2);
const transferText={offered:"等待接受",waiting:"等待对方接受",receiving:"接收中",sending:"发送中",
  completed:"已完成",failed:"失败",cancelled:"已取消"};
function escapeHtml(text){
  return String(text||"").replace(/[&<>"']/g,ch=>({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[ch])).replace(/\r?\n/g,"<br/>");
}
function stateText(record){
  if(record.delivery_status==="delivered"||record.delivery_status==="read")return "已送达";
  if(record.delivery_status==="failed")return "发送失败";
  if(record.delivery_status==="uncertain")return "发送结果待确认";
  if(["queued","dispatching","queued_local","dispatching_local"].includes(record.delivery_status))return "正在发送";
  if(record.message_id===undefined&&!record.outbox_id&&!record.delivery_status)return "历史消息";
  return "已发送";
}
function Button({children,onClick,kind="",disabled=false}){
  return <AntButton type={kind==="primary"?"primary":"default"}
    onClick={onClick} disabled={disabled} className="wtox-ant-btn">{children}</AntButton>;
}
function Modal({title,close,children}){
  useEffect(()=>{
    const onKey=e=>{if(e.key==="Escape")close()};
    addEventListener("keydown",onKey);
    return()=>removeEventListener("keydown",onKey);
  },[close]);
  return <div className="wtox-overlay" onMouseDown={e=>{if(e.target===e.currentTarget)close()}}>
    <section className="wtox-modal" role="dialog" aria-modal="true" aria-label={title}>
      <header><h2>{title}</h2><button aria-label="关闭" onClick={close}>×</button></header>
      <div className="wtox-modal-scroll">{children}</div>
    </section>
  </div>;
}
function AttachmentBubble({file,accept,reject,download,historyHandle}){
  const [preview,setPreview]=useState("");
  const isPicture=/\.(?:png|jpe?g|webp|gif)$/i.test(file.file_name||"");
  const completed=file.file_state==="completed";
  const canDownload=file.direction==="incoming"&&completed;
  useEffect(()=>{
    if(!canDownload||!isPicture||!file.file_id)return;
    let alive=true,url="";
    (async()=>{
      try{
        let blob=historyHandle?.ready()?await historyHandle.cachedImage(file.file_id):null;
        if(!blob){
          blob=await(await api("/api/files/"+encodeURIComponent(file.file_id)+"/download")).blob();
          if(blob.size>5*1024*1024)return;
          const mime=/\.png$/i.test(file.file_name)?"image/png":
            /\.webp$/i.test(file.file_name)?"image/webp":
            /\.gif$/i.test(file.file_name)?"image/gif":"image/jpeg";
          blob=new Blob([blob],{type:mime});
          if(historyHandle?.ready())await historyHandle.cacheImage(file.file_id,blob);
        }
        url=URL.createObjectURL(blob);
        if(alive)setPreview(url);
        else URL.revokeObjectURL(url);
      }catch{
        // File may already have expired from the VPS memory.
      }
    })();
    return()=>{alive=false;if(url)URL.revokeObjectURL(url)};
  },[canDownload,isPicture,file.file_id,file.file_name,historyHandle]);
  const percentage=file.file_size>0?Math.min(100,Math.floor(
    (file.file_progress||0)/file.file_size*100)):0;
  const mine=file.direction==="outgoing";
  const state=transferText[file.file_state]||file.file_state;
  return <div className={"wtox-attachment-row "+(mine?"out":"")} role="group"
     aria-label={"附件 "+file.file_name}>
    <div className="wtox-attachment-bubble">
      {preview&&<img className="wtox-attachment-image" src={preview}
        alt={file.file_name} loading="lazy"/>}
      <strong>📎 {file.file_name}</strong>
      <small>{Math.round(file.file_size/1024)} KiB · {state}
        {percentage>0&&percentage<100?" · "+percentage+"%":""}</small>
      {file.direction==="incoming"&&file.file_state==="offered"&&
        <div className="wtox-attachment-actions">
          <Button onClick={()=>accept(file.file_id)}>接受</Button>
          <Button onClick={()=>reject(file.file_id)}>拒绝</Button>
        </div>}
      {canDownload&&<Button onClick={()=>download({id:file.file_id,name:file.file_name})}>
        下载文件
      </Button>}
      {completed&&mine&&<small>已由 Toxcore 完成文件传输</small>}
      {completed&&!preview&&isPicture&&<small>图片预览不可用或已过期</small>}
    </div>
    <time>{new Date(file.at).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"})}</time>
  </div>;
}
function StatusDot({active}){return <i className={"wtox-dot "+(active?"on":"")}/>;}

export default function App(){
  const [user,setUser]=useState(null),[loading,setLoading]=useState(true);
  const [friends,setFriends]=useState([]),[network,setNetwork]=useState(-1);
  const [selected,setSelected]=useState(null),[mobileChat,setMobileChat]=useState(false);
  const [filter,setFilter]=useState(""),[draft,setDraft]=useState("");
  const [messages,setMessages]=useState([]),[historyReady,setHistoryReady]=useState(false);
  const [migrateRequired,setMigrateRequired]=useState(false),[legacyPass,setLegacyPass]=useState("");
  const [sending,setSending]=useState(false);
  const [ownProfile,setOwnProfile]=useState({name:"",status_message:"",user_status:0});
  const [profileSaving,setProfileSaving]=useState(false);
  const [visualStyle,setVisualStyle]=useState(()=>{
    try{return localStorage.getItem("wtox-visual-style")||"mist"}catch{return "mist"}
  });
  useEffect(()=>{
    document.documentElement.setAttribute("data-wtox-theme",visualStyle);
    try{localStorage.setItem("wtox-visual-style",visualStyle)}catch{}
  },[visualStyle]);
  const [modal,setModal]=useState(""),[notice,setNotice]=useState("");
  const [loginFile,setLoginFile]=useState(null),[busy,setBusy]=useState(false);
  const [friendId,setFriendId]=useState(""),[requestKey,setRequestKey]=useState("");
  const [requestText,setRequestText]=useState("你好，我想添加你为 Tox 好友");
  const [historyFile,setHistoryFile]=useState(null);
  const [uploadFile,setUploadFile]=useState(null),[transfers,setTransfers]=useState([]);
  const history=useRef(null),socket=useRef(null),selectedRef=useRef(null),sendBusy=useRef(false);
  const drafts=useRef(new Map()),noticeTimer=useRef(null),lastMessage=useRef(0);
  const longPressTimer=useRef(null);
  const cancelLongPress=()=>{if(longPressTimer.current)clearTimeout(longPressTimer.current);longPressTimer.current=null};
  async function requestDelete(item){
    cancelLongPress();
    if(!item?.id || !history.current?.ready())return;
    const detail=item.delivery_status==="queued"
      ? "注意：已进入 VPS 队列的消息不会因为删除本地记录而自动撤回。"
      : "只删除这个浏览器中的聊天记录，不会撤回好友已经收到的消息。";
    if(!window.confirm("删除这条聊天记录？\n"+detail))return;
    try{
      await history.current.deleteEvent(item.id);
      if(item.type==="file"&&item.file_id){
        await history.current.deleteCachedImage(item.file_id);
      }
      await refreshHistory(history.current);
      alert("已删除当前浏览器中的该条消息");
    }catch(e){alert("删除失败："+e.message)}
  }
  function startLongPress(item){
    cancelLongPress();
    longPressTimer.current=setTimeout(()=>requestDelete(item),650);
  }
  const closeModal=useCallback(()=>setModal(""),[]);
  const alert=useCallback(message=>{
    setNotice(message);clearTimeout(noticeTimer.current);
    noticeTimer.current=setTimeout(()=>setNotice(""),7000);
  },[]);

  const refreshFriends=useCallback(async()=>{
    setFriends((await getJson("/api/friends")).friends||[]);
  },[]);
  const refreshNetwork=useCallback(async()=>{
    setNetwork((await getJson("/api/network")).status??-1);
  },[]);
  const refreshTransfers=useCallback(async()=>{
    const files=(await getJson("/api/files")).files||[];
    setTransfers(files);
    const h=history.current;
    if(h?.ready()){
      for(const file of files)await h.persistFile(file);
      if(files.length)setMessages(await h.read());
    }
  },[]);
  const refreshHistory=useCallback(async(h=history.current)=>{
    if(h?.ready())setMessages(await h.read());
  },[]);
  const refreshOutbox=useCallback(async(h=history.current)=>{
    if(!h?.ready())return;
    const result=await getJson("/api/outbox");
    if(await h.applyOutboxStatuses(result.messages||[]))await refreshHistory(h);
  },[refreshHistory]);
  const browserFlushBusy=useRef(false);
  const flushBrowserQueue=useCallback(async(list=null,h=history.current)=>{
    if(browserFlushBusy.current||!h?.ready())return;
    browserFlushBusy.current=true;
    try{
      const peers=list||(await getJson("/api/friends")).friends||[];
      const pending=(await h.read()).filter(m=>m.type==="message"&&
        m.direction==="outgoing"&&m.delivery_status==="queued_local");
      for(const item of pending.slice(0,30)){
        // Migrate historical browser-only queued records into the mandatory
        // encrypted VPS queue, even if the recipient is still offline.
        // Claim locally before an HTTP request. After an uncertain network
        // failure we must NOT resend silently (could duplicate a Tox message).
        await h.patchEvent(item.id,{delivery_status:"dispatching_local"});
        try{
          const result=await postJson("/api/messages",{
            public_key:item.public_key,text:item.text,client_id:item.id
          });
          await h.patchEvent(item.id,{
            delivery_status:result.status==="queued"?"queued":"sent",
            outbox_id:result.id||undefined,
            session_id:result.session_id,
            message_id:result.message_id
          });
        }catch(error){
          // A definite server-side status code means no native send occurred.
          // Network loss or 5xx can be ambiguous and require user action.
          await h.patchEvent(item.id,{
            delivery_status:(error.status>=400&&error.status<500)?"queued_local":"uncertain",
            delivery_error:error.message
          });
        }
      }
      await refreshHistory(h);
    }catch(error){alert("浏览器待发队列检查失败："+error.message)}
    finally{browserFlushBusy.current=false}
  },[alert,refreshHistory]);
  const recoverPending=useCallback(async(h=history.current)=>{
    if(!h?.ready())return;
    const data=await getJson("/api/pending");
    for(const row of data.pending||[]){
      const e={...row.event,id:row.id,created:row.created};
      try{
        if(e.type==="message_receipt"){
          if(await h.deliverReceipt(e))await postJson("/api/ack",{ids:[row.id]});
        }else if(e.type==="message"||e.type==="friend_request"){
          await h.persist(e);
          await postJson("/api/ack",{ids:[row.id]});
          if(e.type==="friend_request")setRequestKey(e.public_key);
        }
      }catch(error){alert("消息暂存处理失败："+error.message);break}
    }
    await refreshOutbox(h);
    await refreshHistory(h);
  },[alert,refreshHistory,refreshOutbox]);

  const onRealtime=useCallback(async e=>{
    const h=history.current;
    if(["message","friend_request"].includes(e.type)){
      if(e.type==="friend_request"){
        setRequestKey(e.public_key);
        alert("收到好友请求，请打开添加好友面板接受");
      }
      if(h?.ready()){
        try{
          await h.persist(e);
          if(e.id)await postJson("/api/ack",{ids:[e.id]});
          await refreshHistory(h);
        }catch(error){alert("实时消息本地保存失败："+error.message)}
      }else alert("收到消息，但本地加密历史尚未就绪，请先迁移旧数据");
    }else if(e.type==="message_receipt"){
      if(h?.ready()){
        try{
          if(await h.deliverReceipt(e)){
            if(e.id)await postJson("/api/ack",{ids:[e.id]});
            await refreshHistory(h);
          }
        }catch(error){alert("消息送达回执处理失败："+error.message)}
      }
    }else if(e.type==="file"){
      // Persist the attachment bubble even if the server expires its file buffer.
      if(h?.ready()){
        try{await h.persistFile(e);await refreshHistory(h)}
        catch(error){alert("附件状态保存失败："+error.message)}
      }
      refreshTransfers().catch(()=>{});
      if(e.state==="offered")alert("收到附件："+e.name+"。打开 📎 查看并接受。");
    }else if(["connection","friend_connection"].includes(e.type)){
      refreshNetwork().catch(()=>{});refreshFriends().catch(()=>{});
    }
  },[alert,refreshHistory,refreshFriends,refreshNetwork,refreshTransfers]);

  const loadIdentity=useCallback(async()=>{
    try{const info=await getJson("/api/me");setUser(info)}
    catch(error){setUser(null);if(error.status!==401)alert(error.message)}
    finally{setLoading(false)}
  },[alert]);
  useEffect(()=>{loadIdentity();return()=>clearTimeout(noticeTimer.current)},[loadIdentity]);

  // React reuses the existing wtox-local-<public-key> IndexedDB database and
  // the same non-extractable AES-GCM key; no history migration is necessary.
  useEffect(()=>{
    if(!user?.public_key)return;
    let dead=false;
    const previous=history.current;history.current=null;previous?.close();
    setHistoryReady(false);setMigrateRequired(false);setMessages([]);
    setSelected(null);selectedRef.current=null;setDraft("");setMobileChat(false);
    (async()=>{
      try{
        const h=await openIdentityHistory(user.public_key);
        if(dead){h.close();return}
        history.current=h;
        setHistoryReady(h.ready());setMigrateRequired(h.needsMigration());
        if(h.ready()){
          // A previous tab may have closed AFTER invoking Tox send but BEFORE
          // storing the API reply. Do not silently retry such messages.
          for(const item of await h.read()){
            if(item.direction==="outgoing"&&item.delivery_status==="dispatching_local"){
              await h.patchEvent(item.id,{
                delivery_status:"uncertain",
                delivery_error:"浏览器上次在发送途中关闭，需手动核对发送结果"
              });
            }
          }
          await h.expireImages();
          await recoverPending(h);
          await flushBrowserQueue(null,h);
        }
      }catch(error){if(!dead)alert("无法打开本地加密历史："+error.message)}
    })();
    return()=>{dead=true;history.current?.close();history.current=null};
  },[user?.public_key,recoverPending,alert]);

  // Encrypted image previews are temporary browser data too; remove after
  // seven days even when the user leaves the application open.
  useEffect(()=>{
    if(!user?.public_key)return;
    const sweep=()=>history.current?.expireImages().catch(()=>{});
    const timer=setInterval(sweep,60*60*1000);
    return()=>clearInterval(timer);
  },[user?.public_key]);

  // Poll always, including when websocket is interrupted. Visibility/wakeup
  // triggers immediate catch-up after mobile browser background suspension.
  useEffect(()=>{
    if(!user?.public_key)return;
    let dead=false,ws=null,retry=null;
    const connect=()=>{
      if(dead)return;
      ws=new WebSocket((location.protocol==="https:"?"wss:":"ws:")+"//"+location.host+"/ws");
      socket.current=ws;
      lastMessage.current=Date.now();
      ws.onopen=()=>{
        lastMessage.current=Date.now();
        Promise.allSettled([refreshFriends(),refreshNetwork(),recoverPending(),flushBrowserQueue()]);
      };
      ws.onmessage=msg=>{
        lastMessage.current=Date.now();
        try{onRealtime(JSON.parse(msg.data))}catch(error){alert("无法解析实时事件："+error.message)}
      };
      ws.onclose=()=>{if(!dead)retry=setTimeout(connect,3500)};
    };
    connect();
    const friendTimer=setInterval(()=>{
      if(!dead){refreshFriends().catch(()=>{});refreshNetwork().catch(()=>{});flushBrowserQueue().catch(()=>{})}
    },12000);
    const pendingTimer=setInterval(()=>{
      if(!dead){recoverPending().catch(()=>{});flushBrowserQueue().catch(()=>{})}
    },8000);
    const pingTimer=setInterval(()=>{
      if(ws?.readyState===WebSocket.OPEN){
        if(Date.now()-lastMessage.current>60000){
          ws.close();return;
        }
        try{ws.send(JSON.stringify({type:"ping"}))}catch{}
      }
    },25000);
    const wake=()=>{
      if(!dead&&document.visibilityState==="visible"){
        Promise.allSettled([refreshFriends(),refreshNetwork(),recoverPending()]);
      }
    };
    document.addEventListener("visibilitychange",wake);
    window.addEventListener("focus",wake);
    return()=>{
      dead=true;clearTimeout(retry);clearInterval(friendTimer);
      clearInterval(pendingTimer);clearInterval(pingTimer);
      document.removeEventListener("visibilitychange",wake);
      window.removeEventListener("focus",wake);
      if(ws){ws.onclose=null;ws.close()}
      socket.current=null;
    };
  },[user?.public_key,onRealtime,recoverPending,flushBrowserQueue,refreshFriends,refreshNetwork,alert]);

  useEffect(()=>{
    if(!user?.public_key)return;
    Promise.allSettled([
      refreshFriends(),refreshNetwork(),
      getJson("/api/profile/self").then(setOwnProfile).catch(error=>
        alert("无法获取 Tox 个人资料："+error.message))
    ]);
  },[user?.public_key,refreshFriends,refreshNetwork,alert]);
  const selectedFriend=friends.find(f=>f.public_key===selected);
  const thread=useMemo(()=>messages.filter(e=>e.public_key===selected&&["message","file"].includes(e.type))
    .sort((a,b)=>a.at-b.at).slice(-250),[selected,messages]);
  const visibleFriends=useMemo(()=>friends.filter(f=>
    (f.name+" "+f.public_key).toLowerCase().includes(filter.toLowerCase()))
    .sort((a,b)=>Number(online(b))-Number(online(a))),[friends,filter]);

  function selectFriend(key){
    if(selectedRef.current)drafts.current.set(selectedRef.current,draft);
    selectedRef.current=key;setSelected(key);
    setDraft(drafts.current.get(key)||"");setMobileChat(true);
  }
  useEffect(()=>{
    if(selected&&!friends.some(f=>f.public_key===selected)){
      setSelected(null);selectedRef.current=null;setMobileChat(false);
    }
  },[selected,friends]);
  async function createIdentity(){
    setBusy(true);
    try{
      const response=await api("/api/tox/create",{method:"POST"});
      downloadBlob(await response.blob(),
        "wtox-"+(response.headers.get("X-Tox-ID")||"new").slice(0,16)+".tox");
      alert("身份创建成功！请保存已下载的 .tox 私钥备份。");
      await loadIdentity();
    }catch(error){alert(error.message)}finally{setBusy(false)}
  }
  async function loginIdentity(){
    if(!loginFile){alert("请选择 .tox 配置文件");return}
    if(loginFile.size>8*1024*1024){alert("Tox 配置超过 8 MiB");return}
    setBusy(true);
    try{
      await api("/api/tox/login",{method:"POST",raw:true,
        headers:{"Content-Type":"application/octet-stream"},body:loginFile});
      await loadIdentity();
    }catch(error){alert(error.message)}finally{setBusy(false)}
  }
  async function logout(){
    try{
      await postJson("/api/logout");
      history.current?.close();history.current=null;
      drafts.current.clear();setUser(null);setMessages([]);setFriends([]);
      setSelected(null);setModal("");setHistoryReady(false);
    }catch(error){alert(error.message)}
  }
  async function sendText(innerHtml,textContent,innerText){
    if(sendBusy.current||!selectedRef.current)return;
    const peer=selectedRef.current;
    const text=String(innerText||textContent||innerHtml||"").replace(/<[^>]+>/g,"").trim();
    if(!text)return;
    const h=history.current;
    if(!h?.ready()){setModal("settings");alert("请先完成旧聊天历史迁移");return}
    const client_id=crypto.randomUUID().replaceAll("-","");
    sendBusy.current=true;setSending(true);
    try{
      // Every send enters the encrypted VPS outbox, even if the peer is
      // already online. The native worker sends asynchronously.
      const res=await postJson("/api/messages",{public_key:peer,text,client_id});
      drafts.current.set(peer,"");
      if(selectedRef.current===peer)setDraft("");
      try{
        await h.persist({
          id:client_id,type:"message",direction:"outgoing",
          public_key:peer,text,at:Date.now(),outbox_id:res.id||client_id,
          session_id:res.session_id,message_id:res.message_id,
          delivery_status:res.status==="sent"?"sent":"queued"
        });
        await recoverPending(h);
      }catch(error){alert("消息已加入 VPS 队列，但本地历史保存失败："+error.message)}
    }catch(error){
      drafts.current.set(peer,text);
      if(selectedRef.current===peer)setDraft(text);
      alert(error.message);
    }finally{sendBusy.current=false;setSending(false)}
  }
  async function addFriend(){
    try{
      const data=await postJson("/api/friends",{address:friendId.trim(),
        message:requestText});
      await refreshFriends();selectFriend(data.public_key);
      setModal("");alert("好友请求已保存，请等待对方接受");
    }catch(error){alert(error.message)}
  }
  async function acceptFriend(){
    try{
      const data=await postJson("/api/friends/accept",{public_key:requestKey.trim()});
      await refreshFriends();selectFriend(data.public_key);
      setModal("");alert("好友已接受，等待对方建立 Tox 连接");
    }catch(error){alert(error.message)}
  }
  async function removeFriend(){
    if(!selected||!confirm("删除当前 Tox 好友？本地历史不会被删除。"))return;
    try{
      await api("/api/friends/"+encodeURIComponent(selected),{method:"DELETE"});
      setSelected(null);selectedRef.current=null;setMobileChat(false);await refreshFriends();
    }catch(error){alert(error.message)}
  }
  async function saveOwnProfile(){
    setProfileSaving(true);
    try{
      const response=await api("/api/profile/self",{
        method:"PUT",
        body:JSON.stringify(ownProfile)
      });
      const updated=await response.json();
      setOwnProfile(updated);
      alert("Tox 昵称、状态消息和状态已保存，并同步到身份配置");
    }catch(error){alert(error.message)}
    finally{setProfileSaving(false)}
  }
  async function migrateHistory(){
    try{
      await history.current.migrate(legacyPass);
      setLegacyPass("");setHistoryReady(true);setMigrateRequired(false);
      await recoverPending();
      alert("旧历史迁移完成，以后会自动解锁");
    }catch(error){alert(error.message)}
  }
  async function exportJson(){
    try{
      if(!history.current?.ready())throw Error("本地历史未就绪");
      if(!confirm("导出的 JSON 是明文聊天记录，请妥善保护。确定导出吗？"))return;
      const records=(await history.current.read()).filter(r=>r.type==="message");
      downloadBlob(new Blob([toWtoxJson(records,user.public_key)],{type:"application/json"}),
        "wtox-"+user.public_key.slice(0,12)+".json");
    }catch(error){alert(error.message)}
  }
  async function importHistory(){
    try{
      if(!historyFile||historyFile.size>MAX_HISTORY_IMPORT)throw Error("请选择小于 8 MiB 的文件");
      if(!history.current?.ready())throw Error("本地历史未就绪");
      const text=await historyFile.text();
      if(!historyFile.name.toLowerCase().endsWith(".json")){
        throw Error("目前仅支持 wTox JSON；aTox 导出文件格式尚未验证");
      }
      const rows=fromWtoxJson(text,user.public_key);
      if(!rows.length)throw Error("文件不含可导入消息");
      if(!confirm("导入 "+rows.length+" 条消息到此浏览器的加密历史？"))return;
      await history.current.importMessages(rows);await refreshHistory();
      setHistoryFile(null);alert("聊天记录已导入；相同记录不会重复追加。");
    }catch(error){alert(error.message)}
  }
  async function sendFile(){
    if(!selected||!online(selectedFriend)){alert("附件要求双方在线");return}
    if(!uploadFile||uploadFile.size<1||uploadFile.size>5*1024*1024){
      alert("附件大小需为 1 字节至 5 MiB");return;
    }
    setBusy(true);
    try{
      const url="/api/files/send?peer="+encodeURIComponent(selected)+
        "&name="+encodeURIComponent(uploadFile.name);
      await api(url,{method:"POST",raw:true,headers:{"Content-Type":"application/octet-stream"},body:uploadFile});
      setUploadFile(null);await refreshTransfers();alert("已发送附件请求，等待对方接受");
    }catch(error){alert(error.message)}finally{setBusy(false)}
  }
  async function controlFile(id,action){
    try{
      await postJson("/api/files/"+encodeURIComponent(id)+"/"+action);
      await refreshTransfers();
    }catch(error){alert(error.message)}
  }
  async function downloadFile(file){
    try{
      let blob=null;
      const h=history.current;
      const isImage=/\.(png|jpe?g|gif|webp)$/i.test(file.name||"");
      if(isImage&&h?.ready())blob=await h.cachedImage(file.id);
      if(!blob)blob=await(await api("/api/files/"+encodeURIComponent(file.id)+"/download")).blob();
      if(isImage&&h?.ready()&&blob.size<=5*1024*1024)
        await h.cacheImage(file.id,blob);
      downloadBlob(blob,file.name);
    }catch(error){alert(error.message)}
  }

  if(loading)return <div className="wtox-loading">正在加载 wtox…</div>;
  if(!user)return <div className="wtox-auth-layout">
    <div className="wtox-auth-card"><img className="wtox-logo" src="/logo.svg" alt="wtox"/>
      <p className="wtox-kicker">PRIVATE MESSENGER</p><h1>你的私人 Tox 通讯</h1>
      <p>使用原始 .tox 配置文件登录，无需创建额外的网站账号。</p>
      <Button kind="primary" onClick={createIdentity} disabled={busy}>＋ 创建 Tox 身份并下载备份</Button>
      <div className="wtox-separator">已有身份</div>
      <label>选择 .tox 私钥文件
        <input type="file" accept=".tox,application/octet-stream"
          onChange={e=>setLoginFile(e.target.files?.[0]||null)}/></label>
      <Button kind="primary" disabled={!loginFile||busy} onClick={loginIdentity}>使用 .tox 配置登录</Button>
      <details><summary>旧版账号迁移</summary><p>如果旧 Cookie 尚未过期，可以下载原来的 .tox 身份备份。</p>
        <Button onClick={async()=>{
          try{downloadBlob(await(await api("/api/legacy/export")).blob(),"wtox-old-backup.tox")}
          catch(error){alert(error.message)}
        }}>下载旧身份备份</Button></details>
      <small>请妥善保存 .tox 私钥备份。Tox 身份本身不要求密码。</small>
    </div>
    {notice&&<div className="wtox-toast" role="status">{notice}</div>}
  </div>;

  return <ConfigProvider theme={{
    algorithm:visualStyle==="mist"?antdTheme.defaultAlgorithm:antdTheme.darkAlgorithm,
    token:{colorPrimary:visualStyle==="ocean"?"#06b6d4":visualStyle==="midnight"?"#818cf8":"#477ee8",
      borderRadius:12,fontFamily:"Inter, system-ui, -apple-system, sans-serif"}
  }}>
  <div className={"wtox-shell ant-messenger "+(mobileChat?"show-chat":"")}>
    <header className="wtox-top ant-topbar">
      <div className="wtox-brand">
        <img className="wtox-logo" src="/logo.svg" alt="wtox logo"/>
        <div><strong>wtox</strong><small>安全 Tox 即时通讯</small></div>
      </div>
      <nav className="wtox-tools">
        <Tag color={network>0?"success":"warning"} bordered={false}>
          <StatusDot active={network>0}/>
          {network>0?statusLabel(network):"网络连接中"}
        </Tag>
        <Tooltip title="设置与备份">
          <AntButton shape="circle" icon={<SettingOutlined/>}
            aria-label="设置与备份" onClick={()=>setModal("settings")}/>
        </Tooltip>
      </nav>
    </header>
    <div className="wtox-workspace ant-workspace">
      <aside className="ant-contact-sidebar">
        <div className="ant-sidebar-heading">
          <div><h2>消息</h2><span>{friends.length} 位联系人</span></div>
          <Tooltip title="添加好友">
            <AntButton shape="circle" type="primary" icon={<UserAddOutlined/>}
              aria-label="添加好友" onClick={()=>setModal("add")}/>
          </Tooltip>
        </div>
        <div className="ant-search-row">
          <Input.Search allowClear value={filter} placeholder="搜索好友、公钥"
            aria-label="搜索好友" onChange={e=>setFilter(e.target.value)}/>
        </div>
        <div className="ant-contacts-list">
          <Conversations items={visibleFriends.map(friend=>({
            key:friend.public_key,
            label:<span className="ant-contact-label">
              <strong>{friend.name||"Tox 好友 "+shortKey(friend.public_key)}</strong>
              <small>{statusLabel(friend.status)}</small>
            </span>,
            icon:<Avatar className="ant-contact-avatar" size={42}>
              {(friend.name||friend.public_key).slice(0,1).toUpperCase()}
            </Avatar>
          }))} activeKey={selected||""}
            onActiveChange={key=>selectFriend(key)}/>
          {!visibleFriends.length&&<div className="ant-list-empty">
            <MessageOutlined style={{fontSize:30}}/>
            <p>{friends.length?"没有匹配的好友":"还没有好友"}</p>
            <AntButton type="link" onClick={()=>setModal("add")}>添加好友</AntButton>
          </div>}
        </div>
        <div className="ant-sidebar-footer">
          <span>好友状态自动刷新 · 12 秒</span>
          <span>VPS 加密离线队列 · 自动发送</span>
        </div>
      </aside>
      <main className="ant-chat-area">
        <div className="ant-chat-toolbar">
          <div className="ant-chat-identity">
            <AntButton className="ant-mobile-back" aria-label="返回联系人"
              icon={<ArrowLeftOutlined/>} onClick={()=>setMobileChat(false)}/>
            <Avatar size={40} className="ant-chat-avatar">
              {selectedFriend?(selectedFriend.name||selectedFriend.public_key).slice(0,1).toUpperCase():"✦"}
            </Avatar>
            <div className="ant-peer-title">
              <strong>{selectedFriend?.name|| (selected?"好友 "+shortKey(selected):"选择好友开始聊天")}</strong>
              <small>{selectedFriend?statusLabel(selectedFriend.status):"端到端 Tox 网络"}</small>
            </div>
          </div>
          <Space>
            <Tooltip title="发送和接收附件">
              <AntButton shape="circle" icon={<PaperClipOutlined/>}
                aria-label="附件" onClick={()=>{setModal("files");refreshTransfers().catch(()=>{})}}/>
            </Tooltip>
            <Tooltip title="删除当前好友">
              <Popconfirm title="删除此 Tox 好友？" description="本地聊天记录不会被删除"
                onConfirm={removeFriend} okText="删除" cancelText="取消" disabled={!selected}>
                <AntButton danger shape="circle" disabled={!selected}
                  icon={<DeleteOutlined/>} aria-label="删除好友"/>
              </Popconfirm>
            </Tooltip>
          </Space>
        </div>
        <div className="ant-thread" role="log" aria-label="聊天记录">
          {!selected&&<div className="ant-empty-chat">
            <img src="/logo.svg" alt="" width="74" height="74"/>
            <h3>欢迎使用 wtox</h3><p>选择一位好友，开始私人对话</p>
          </div>}
          {selected&&!thread.length&&<div className="ant-empty-chat">
            <MessageOutlined style={{fontSize:42}}/><h3>还没有聊天记录</h3>
            <p>发送第一条消息，或等待好友回复</p>
          </div>}
          {thread.map(item=>item.type==="file"
            ? <div key={item.id} className="ant-timeline-file"
                onContextMenu={event=>{event.preventDefault();requestDelete(item)}}
                onTouchStart={()=>startLongPress(item)}
                onTouchEnd={cancelLongPress}
                onTouchMove={cancelLongPress}>
                <AttachmentBubble file={item}
                  accept={id=>controlFile(id,"accept")}
                  reject={id=>controlFile(id,"reject")}
                  download={downloadFile} historyHandle={history.current}/>
              </div>
            : <div key={item.id} className="ant-message-wrap"
                onContextMenu={event=>{event.preventDefault();requestDelete(item)}}
                onTouchStart={()=>startLongPress(item)}
                onTouchEnd={cancelLongPress}
                onTouchMove={cancelLongPress}>
                <Bubble content={String(item.text||"")}
                  placement={item.direction==="outgoing"?"end":"start"}
                  shape="round" variant="filled"
                  footer={<span className="ant-message-status">
                    {new Date(item.at).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"})}
                    {item.direction==="outgoing"?" · "+stateText(item):""}
                  </span>}
                  footerPlacement={item.direction==="outgoing"?"outer-end":"outer-start"}/>
              </div>)}
        </div>
        <div className="ant-compose-area">
          <p className="ant-compose-status">{!selected?"请先选择好友":
            !historyReady?"本地加密历史尚未就绪":
            !online(selectedFriend)?"对方离线，VPS 已准备好离线队列":
            sending?"正在发送请求":"Enter 发送 · Shift + Enter 换行"}</p>
          <Sender value={draft} placeholder="输入消息…"
            onChange={value=>{setDraft(value);if(selected)drafts.current.set(selected,value)}}
            onSubmit={text=>sendText("",text,text)}
            disabled={!selected||!historyReady||sending} submitType="enter"/>
        </div>
      </main>
    </div>

    {modal==="settings"&&<Modal title="设置与备份" close={closeModal}>
      <h3>界面风格</h3>
      <Segmented block size="large" value={visualStyle} onChange={setVisualStyle}
        options={[{label:"☀️ 雾白",value:"mist"},
          {label:"🌙 午夜",value:"midnight"},
          {label:"🌊 海蓝",value:"ocean"}]}/>
      <p className="wtox-info">风格只保存在当前浏览器，不影响 Tox 身份和聊天记录。</p>
      <div className="wtox-separator">消息与离线队列</div>
      <label className="wtox-toggle">
        <input type="checkbox" checked={offlineQueue}
          onChange={e=>changeOfflineQueue(e.target.checked)}/>
        <span><strong>通过 VPS 代发离线消息（可选）</strong>
          <small>默认关闭：消息加密留在当前浏览器，页面运行且好友在线时发送。
          开启后：VPS 加密保留队列，关闭页面也能等待好友上线后发送。</small>
        </span>
      </label>
      <p className="wtox-info">浏览器队列可跨刷新恢复，但手机锁屏或切到后台可能暂停网页，
      不保证持续运行。VPS 队列最长暂存 7 天、每个身份最多 250 条。
      已经进入 VPS 的消息在关闭此开关后仍会完成现有队列。</p>
      <p className="wtox-info">好友状态约每 12 秒刷新，消息每 8 秒补领，手机回到网页时主动同步。</p>
      <div className="wtox-separator">Tox 身份与私钥备份</div>
      <p>当前 Tox ID 可以分享，但 .tox 备份含私钥，不要分享。</p>
      <div className="wtox-tox-id">{user.tox_id}</div>
      <Button onClick={()=>navigator.clipboard.writeText(user.tox_id).then(()=>alert("Tox ID 已复制")).catch(e=>alert(e.message))}>复制 Tox ID</Button>
      <Button kind="primary" onClick={async()=>{
        try{downloadBlob(await(await api("/api/profile/export")).blob(),"wtox-profile.tox")}
        catch(e){alert(e.message)}
      }}>下载最新 .tox 备份</Button>
      <div className="wtox-separator">本地加密历史与导入导出</div>
      <p>当前身份的消息使用此浏览器不可导出的 AES-256-GCM 密钥保存，无需反复输入口令。</p>
      <div className="wtox-info">{historyReady?"✓ 加密历史已自动解锁":
        migrateRequired?"需要迁移旧版口令加密历史":"本地历史尚未就绪"}</div>
      {migrateRequired&&<><label>旧版历史密码
        <input type="password" value={legacyPass} onChange={e=>setLegacyPass(e.target.value)}/></label>
        <Button kind="primary" onClick={migrateHistory}>一次性迁移旧历史</Button></>}
      <div className="wtox-separator">历史导出</div>
      <Button onClick={exportJson}>导出 wtox JSON</Button>
      <Button onClick={exportQtox}>导出选中好友 qTox TXT</Button>
      <p className="wtox-warning">以上历史文件均为明文，请妥善加密保管。</p>
      <div className="wtox-separator">导入历史</div>
      <label>选择 JSON 或 qTox TXT 文件
        <input type="file" accept=".json,.txt" onChange={e=>setHistoryFile(e.target.files?.[0]||null)}/></label>
      <label>qTox TXT 导出时自己的昵称<input value={ownName} onChange={e=>setOwnName(e.target.value)}/></label>
      <Button kind="primary" onClick={importHistory}>导入到此浏览器</Button>
      <small>aTox 专有导出格式尚待样本验证。历史只保存在本机，换设备需自行导出导入。</small>
      <div className="wtox-separator">当前登录会话</div>
      <Button onClick={logout}>退出当前 Tox 身份</Button>
    </Modal>}

    {modal==="add"&&<Modal title="添加好友" close={closeModal}>
      <label>好友 Tox ID（76 位）
        <textarea rows="3" value={friendId} onChange={e=>setFriendId(e.target.value)} placeholder="完整 Tox ID"/></label>
      <label>好友请求内容<input value={requestText} onChange={e=>setRequestText(e.target.value)}/></label>
      <Button kind="primary" onClick={addFriend}>发送好友请求</Button>
      <div className="wtox-separator">接受请求</div>
      <label>请求者公钥（64 位）<input value={requestKey} onChange={e=>setRequestKey(e.target.value)}/></label>
      <Button onClick={acceptFriend}>接受好友</Button>
    </Modal>}

    {modal==="files"&&<Modal title="附件收发" close={closeModal}>
      <p>附件使用原生 Tox 协议，需好友在线，单文件最多 5 MiB；接收文件需要手动同意。</p>
      <label>选择发送文件
        <input type="file" onChange={e=>setUploadFile(e.target.files?.[0]||null)}/></label>
      <Button kind="primary" disabled={busy||!online(selectedFriend)} onClick={sendFile}>向当前好友发送</Button>
      <div className="wtox-separator">传输任务</div>
      <Button onClick={()=>refreshTransfers().catch(e=>alert(e.message))}>刷新附件列表</Button>
      {transfers.map(file=><div className="wtox-transfer" key={file.id}>
        <strong>{file.name}</strong><small>{file.direction==="incoming"?"收件":"发件"} ·
          {transferText[file.state]||file.state} · {Math.round(file.size/1024)} KiB
          {file.progress>0&&" · "+Math.round(file.progress/file.size*100)+"%"}</small>
        {file.direction==="incoming"&&file.state==="offered"&&
          <div><Button onClick={()=>controlFile(file.id,"accept")}>接受</Button>
            <Button onClick={()=>controlFile(file.id,"reject")}>拒绝</Button></div>}
        {file.direction==="incoming"&&file.state==="completed"&&
          <Button onClick={()=>downloadFile(file)}>下载文件</Button>}
      </div>)}
      <small>附件只在 VPS 内存短暂保留，不支持断线续传。</small>
    </Modal>}
    {notice&&<div className="wtox-toast" role="status">{notice}</div>}
  </div></ConfigProvider>;
}
