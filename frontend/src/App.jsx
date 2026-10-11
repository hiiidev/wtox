import React, {useCallback,useEffect,useMemo,useRef,useState} from "react";
import {
  MainContainer, Sidebar, ConversationList, Conversation,
  ChatContainer, ConversationHeader, MessageList, Message, MessageInput, InputToolbox
} from "@chatscope/chat-ui-kit-react";
import {api,getJson,postJson,downloadBlob,shortKey,statusLabel} from "./api.js";
import {openIdentityHistory} from "./history.js";
import {MAX_HISTORY_IMPORT,toWtoxJson,fromWtoxJson,toQtoxTsv,fromQtoxTsv} from "../history_io.js";

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
  if(record.delivery_status==="queued"||record.delivery_status==="dispatching")return "正在发送";
  return "已发送";
}
function Button({children,onClick,kind="",disabled=false}){
  return <button type="button" className={"wtox-btn "+kind} onClick={onClick} disabled={disabled}>{children}</button>;
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
function StatusDot({active}){return <i className={"wtox-dot "+(active?"on":"")}/>;}

export default function App(){
  const [user,setUser]=useState(null),[loading,setLoading]=useState(true);
  const [friends,setFriends]=useState([]),[network,setNetwork]=useState(-1);
  const [selected,setSelected]=useState(null),[mobileChat,setMobileChat]=useState(false);
  const [filter,setFilter]=useState(""),[draft,setDraft]=useState("");
  const [messages,setMessages]=useState([]),[historyReady,setHistoryReady]=useState(false);
  const [migrateRequired,setMigrateRequired]=useState(false),[legacyPass,setLegacyPass]=useState("");
  const [offlineQueue,setOfflineQueue]=useState(true),[sending,setSending]=useState(false);
  const [modal,setModal]=useState(""),[notice,setNotice]=useState("");
  const [loginFile,setLoginFile]=useState(null),[busy,setBusy]=useState(false);
  const [friendId,setFriendId]=useState(""),[requestKey,setRequestKey]=useState("");
  const [requestText,setRequestText]=useState("你好，我想添加你为 Tox 好友");
  const [historyFile,setHistoryFile]=useState(null),[ownName,setOwnName]=useState("");
  const [uploadFile,setUploadFile]=useState(null),[transfers,setTransfers]=useState([]);
  const history=useRef(null),socket=useRef(null),selectedRef=useRef(null),sendBusy=useRef(false);
  const drafts=useRef(new Map()),noticeTimer=useRef(null),lastMessage=useRef(0);
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
    setTransfers((await getJson("/api/files")).files||[]);
  },[]);
  const refreshHistory=useCallback(async(h=history.current)=>{
    if(h?.ready())setMessages(await h.read());
  },[]);
  const refreshOutbox=useCallback(async(h=history.current)=>{
    if(!h?.ready())return;
    const result=await getJson("/api/outbox");
    if(await h.applyOutboxStatuses(result.messages||[]))await refreshHistory(h);
  },[refreshHistory]);
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
        if(h.ready())await recoverPending(h);
      }catch(error){if(!dead)alert("无法打开本地加密历史："+error.message)}
    })();
    return()=>{dead=true;history.current?.close();history.current=null};
  },[user?.public_key,recoverPending,alert]);

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
        Promise.allSettled([refreshFriends(),refreshNetwork(),recoverPending()]);
      };
      ws.onmessage=msg=>{
        lastMessage.current=Date.now();
        try{onRealtime(JSON.parse(msg.data))}catch(error){alert("无法解析实时事件："+error.message)}
      };
      ws.onclose=()=>{if(!dead)retry=setTimeout(connect,3500)};
    };
    connect();
    const friendTimer=setInterval(()=>{
      if(!dead){refreshFriends().catch(()=>{});refreshNetwork().catch(()=>{})}
    },12000);
    const pendingTimer=setInterval(()=>{
      if(!dead)recoverPending().catch(()=>{});
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
  },[user?.public_key,onRealtime,recoverPending,refreshFriends,refreshNetwork,alert]);

  useEffect(()=>{
    if(!user?.public_key)return;
    Promise.allSettled([refreshFriends(),refreshNetwork(),getJson("/api/settings")
      .then(settings=>setOfflineQueue(settings.offline_queue!==false))]);
  },[user?.public_key,refreshFriends,refreshNetwork]);
  const selectedFriend=friends.find(f=>f.public_key===selected);
  const thread=useMemo(()=>messages.filter(e=>e.public_key===selected&&e.type==="message")
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
    if(!history.current?.ready()){setModal("history");alert("请先完成本地加密历史迁移");return}
    if(!offlineQueue&&!online(friends.find(f=>f.public_key===peer))){
      alert("好友离线且已关闭离线排队，消息未发送");return;
    }
    sendBusy.current=true;setSending(true);
    const client_id=crypto.randomUUID().replaceAll("-","");
    try{
      const res=await postJson("/api/messages",{public_key:peer,text,client_id});
      // Native send or durable encrypted VPS enqueue must succeed first.
      drafts.current.set(peer,"");
      if(selectedRef.current===peer)setDraft("");
      try{
        await history.current.persist({
          id:client_id,type:"message",direction:"outgoing",
          public_key:peer,text,at:Date.now(),
          outbox_id:res.id||undefined,
          session_id:res.session_id,message_id:res.message_id,
          delivery_status:res.status==="queued"?"queued":"sent"
        });
        await recoverPending();
      }catch(error){alert("消息已进入服务器，但本地历史保存失败："+error.message)}
    }catch(error){
      drafts.current.set(peer,text);
      if(selectedRef.current===peer)setDraft(text);
      alert(error.message);
      refreshFriends().catch(()=>{});
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
  async function changeOfflineQueue(next){
    try{
      const setting=await api("/api/settings",{method:"PUT",body:JSON.stringify({offline_queue:next})});
      setOfflineQueue((await setting.json()).offline_queue);
      alert(next?"已启用 VPS 离线排队":"已关闭新消息的 VPS 离线排队，旧队列仍会继续发送");
    }catch(error){alert(error.message)}
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
  async function exportQtox(){
    try{
      if(!selected)throw Error("请先选择要导出的好友");
      if(!history.current?.ready())throw Error("本地历史未就绪");
      if(!confirm("导出的 TXT 是明文聊天记录。确定导出吗？"))return;
      const name=selectedFriend?.name||"Tox Friend";
      const data=toQtoxTsv(await history.current.read(),selected,name);
      downloadBlob(new Blob([data],{type:"text/plain;charset=utf-8"}),
        "wtox-qtox-"+selected.slice(0,12)+".txt");
    }catch(error){alert(error.message)}
  }
  async function importHistory(){
    try{
      if(!historyFile||historyFile.size>MAX_HISTORY_IMPORT)throw Error("请选择小于 8 MiB 的文件");
      if(!history.current?.ready())throw Error("本地历史未就绪");
      const text=await historyFile.text();
      const rows=historyFile.name.toLowerCase().endsWith(".json")
        ?fromWtoxJson(text,user.public_key):
        historyFile.name.toLowerCase().endsWith(".txt")
          ?fromQtoxTsv(text,selected,ownName.trim())
          :(()=>{throw Error("只接受 JSON 或 qTox TXT")})();
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
      const blob=await(await api("/api/files/"+encodeURIComponent(file.id)+"/download")).blob();
      downloadBlob(blob,file.name);
    }catch(error){alert(error.message)}
  }

  if(loading)return <div className="wtox-loading">正在加载 wtox…</div>;
  if(!user)return <div className="wtox-auth-layout">
    <div className="wtox-auth-card"><span className="wtox-mark">w</span>
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

  return <div className={"wtox-shell "+(mobileChat?"show-chat":"")}>
    <header className="wtox-top">
      <div className="wtox-brand"><span className="wtox-mark">w</span>
        <div><strong>wtox</strong><small>React · Tox 网络</small></div></div>
      <nav className="wtox-tools">
        <span className="wtox-network"><StatusDot active={network>0}/>{network>0?statusLabel(network):"Tox 连接中"}</span>
        <button title="设置" onClick={()=>setModal("settings")}>⚙</button>
        <button title="聊天历史" onClick={()=>setModal("history")}>▤</button>
        <button title="我的 Tox ID" onClick={()=>setModal("identity")}>◎</button>
        <button title="退出" onClick={logout}>⇥</button>
      </nav>
    </header>
    <div className="wtox-workspace">
      <MainContainer responsive={false}>
        <Sidebar position="left" scrollable={false} className="wtox-sidebar">
          <div className="wtox-sidebar-top">
            <div className="wtox-heading"><h2>消息</h2><span>{friends.length} 位好友</span></div>
            <input value={filter} placeholder="搜索联系人或公钥" aria-label="搜索好友"
              onChange={e=>setFilter(e.target.value)}/>
          </div>
          <ConversationList className="wtox-conversations">
            {visibleFriends.map(friend=><Conversation key={friend.public_key}
              name={friend.name||"Tox 好友 "+shortKey(friend.public_key)}
              info={statusLabel(friend.status)} active={selected===friend.public_key}
              onClick={()=>selectFriend(friend.public_key)}/>)}
          </ConversationList>
          {!visibleFriends.length&&<p className="wtox-empty-friends">还没有联系人，点击下方添加好友。</p>}
          <div className="wtox-sidebar-bottom">
            <Button kind="primary" onClick={()=>setModal("add")}>＋ 添加好友</Button>
            <span className="wtox-secondary-note">好友状态每 12 秒更新</span>
          </div>
        </Sidebar>
        <ChatContainer className="wtox-chat">
          <ConversationHeader>
            <ConversationHeader.Back onClick={()=>setMobileChat(false)}/>
            <ConversationHeader.Content
              userName={selectedFriend?.name|| (selected?"Tox 好友 "+shortKey(selected):"选择一个好友")}
              info={selectedFriend?statusLabel(selectedFriend.status):"安全的 Tox 通讯"}/>
            <ConversationHeader.Actions>
              <button className="wtox-header-action" title="附件" onClick={()=>{setModal("files");refreshTransfers().catch(()=>{})}}>📎</button>
              <button className="wtox-header-action" title="删除好友" disabled={!selected} onClick={removeFriend}>⋯</button>
            </ConversationHeader.Actions>
          </ConversationHeader>
          <MessageList className="wtox-message-list">
            {!thread.length
              ? <MessageList.Content><div className="wtox-empty-thread">
                  {selected?"暂无聊天记录":"选择左侧联系人开始聊天"}
                </div></MessageList.Content>
              : thread.map(item=><Message key={item.id} className="wtox-message-item"
                  model={{message:String(item.text||""),type:"text",
                    direction:item.direction==="outgoing"?"outgoing":"incoming",
                    position:"single"}}>
                  <Message.Footer sentTime={
                    new Date(item.at).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"})+
                    (item.direction==="outgoing"?" · "+stateText(item):"")
                  }/>
                </Message>)}
          </MessageList>
          <MessageInput className="wtox-send-input" placeholder="输入消息…" attachButton={false}
            value={draft} onChange={value=>{setDraft(value);if(selected)drafts.current.set(selected,value)}}
            onSend={sendText} disabled={!selected||!historyReady||sending||
              (!offlineQueue&&!online(selectedFriend))}/>
          <InputToolbox className="wtox-send-tip">
            {!selected?"先选择好友"
              :!historyReady?"请完成本地历史迁移"
              :offlineQueue&&!online(selectedFriend)?"对方离线，点击发送会进入 VPS 队列（正在发送）"
              :!online(selectedFriend)?"对方离线，已关闭离线排队"
              :sending?"正在处理发送请求":"Enter 发送 · Shift + Enter 换行"}
          </InputToolbox>
        </ChatContainer>
      </MainContainer>
    </div>

    {modal==="settings"&&<Modal title="聊天设置" close={closeModal}>
      <label className="wtox-toggle">
        <input type="checkbox" checked={offlineQueue} onChange={e=>changeOfflineQueue(e.target.checked)}/>
        <span><strong>允许向离线好友发送</strong>
        <small>默认开启。VPS 加密暂存消息，好友上线后自动发送；队列消息显示「正在发送」。</small></span>
      </label>
      <p className="wtox-info">发送队列每 3 秒检查；待发送消息最多 250 条，最长暂存 7 天。服务器重启时无法确认结果的消息不会自动重复发送。</p>
      <p className="wtox-info">好友在线状态每 12 秒刷新，未领取消息每 8 秒补领；WebSocket 断线自动重连。</p>
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

    {modal==="identity"&&<Modal title="我的 Tox 身份" close={closeModal}>
      <p>当前 Tox ID 可以分享，但 .tox 备份含私钥，不要分享。</p>
      <div className="wtox-tox-id">{user.tox_id}</div>
      <Button onClick={()=>navigator.clipboard.writeText(user.tox_id).then(()=>alert("Tox ID 已复制")).catch(e=>alert(e.message))}>复制 Tox ID</Button>
      <Button kind="primary" onClick={async()=>{
        try{downloadBlob(await(await api("/api/profile/export")).blob(),"wtox-profile.tox")}
        catch(e){alert(e.message)}
      }}>下载最新 .tox 备份</Button>
    </Modal>}

    {modal==="history"&&<Modal title="本地加密历史" close={closeModal}>
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
  </div>;
}
