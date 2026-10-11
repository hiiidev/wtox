import React, {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from "react";
import { ConfigProvider, theme as antdTheme, Button as AntButton, Input, Tag,
  Space, Tooltip, Segmented, Avatar, Divider, Popconfirm, Modal as AntModal,
  Dropdown, Badge, List, Typography, Empty, Form, Select, Drawer, Grid, Card, Image, Upload } from "antd";
import { Bubble, Sender, FileCard } from "@ant-design/x";
import { PaperClipOutlined, SettingOutlined, ArrowLeftOutlined,
  UserAddOutlined, DeleteOutlined, MessageOutlined, ContactsOutlined,
  UserOutlined, PlusOutlined, MoreOutlined, SmileOutlined, FolderOutlined, ArrowDownOutlined } from "@ant-design/icons";
import {api,getJson,postJson,downloadBlob,shortKey,statusLabel} from "./api.js";
import {openIdentityHistory} from "./history.js";
import {avatarLabel,avatarFallbackColor,ensureAvatarColors} from "./avatar_utils.js";
import {isNearBottom,countNewEntries} from "./thread_scroll.js";
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
function AttachmentBubble({file,accept,reject,download,historyHandle}){
  const [preview,setPreview]=useState("");
  const isPicture=/\.(?:png|jpe?g|webp|gif)$/i.test(file.file_name||"");
  const completed=file.file_state==="completed";
  const canDownload=file.direction==="incoming"&&completed;
  useEffect(()=>{
    if(!isPicture||!file.file_id)return;
    let alive=true,url="";
    (async()=>{
      try{
        let blob=historyHandle?.ready()?await historyHandle.cachedImage(file.file_id):null;
        if(!blob&&canDownload){
          blob=await(await api("/api/files/"+encodeURIComponent(file.file_id)+"/download")).blob();
          if(blob.size>5*1024*1024)return;
          const mime=/\.png$/i.test(file.file_name)?"image/png":
            /\.webp$/i.test(file.file_name)?"image/webp":
            /\.gif$/i.test(file.file_name)?"image/gif":"image/jpeg";
          blob=new Blob([blob],{type:mime});
          if(historyHandle?.ready())await historyHandle.cacheImage(file.file_id,blob);
        }
        if(!blob)return;
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
    <Card size="small" className="wtox-attachment-bubble">
      {preview&&<Image className="wtox-attachment-image" src={preview}
        alt={file.file_name} loading="lazy" width={220}
        preview={{mask:"查看图片"}}/>}
      <FileCard name={file.file_name} byte={file.file_size} size="small"/>
      <Typography.Text type="secondary">
        {state}{percentage>0&&percentage<100?" · "+percentage+"%":""}
      </Typography.Text>
      {file.direction==="incoming"&&file.file_state==="offered"&&
        <div className="wtox-attachment-actions">
          <Button onClick={()=>accept(file.file_id)}>接受</Button>
          <Button onClick={()=>reject(file.file_id)}>拒绝</Button>
        </div>}
      {canDownload&&<Button onClick={()=>download({id:file.file_id,name:file.file_name})}>
        下载文件
      </Button>}
      {completed&&mine&&<small>已由 Toxcore 完成文件传输</small>}
      {completed&&!preview&&isPicture&&<Typography.Text type="secondary">
        图片预览不可用或已过期
      </Typography.Text>}
    </Card>
    <time>{new Date(file.at).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"})}</time>
  </div>;
}
function StatusDot({active}){return <i className={"wtox-dot "+(active?"on":"")}/>;}

export default function App(){
  const [user,setUser]=useState(null),[loading,setLoading]=useState(true);
  const [friends,setFriends]=useState([]),[network,setNetwork]=useState(-1);
  const [selected,setSelected]=useState(null),[mobileChat,setMobileChat]=useState(false);
  const [section,setSection]=useState("chats");
  const [friendRequests,setFriendRequests]=useState([]);
  const [peerDetailsOpen,setPeerDetailsOpen]=useState(false);
  const [seen,setSeen]=useState({});
  const [filter,setFilter]=useState(""),[draft,setDraft]=useState("");
  const [messages,setMessages]=useState([]),[historyReady,setHistoryReady]=useState(false);
  const [avatarColors,setAvatarColors]=useState({});
  const [newBelowCount,setNewBelowCount]=useState(0);
  const [threadScrolling,setThreadScrolling]=useState(false);
  const threadEl=useRef(null);
  const followLatest=useRef(true);
  const previousThread=useRef({peer:null,ids:[]});
  const scrollIdleTimer=useRef(null);
  const [migrateRequired,setMigrateRequired]=useState(false),[legacyPass,setLegacyPass]=useState("");
  const [sending,setSending]=useState(false);
  const [ownProfile,setOwnProfile]=useState({name:"",status_message:"",user_status:0});
  const [profileSaving,setProfileSaving]=useState(false);
  // Native Tox status: 0 available, 1 away, 2 busy. When the Tox network
  // connection is down, show a neutral offline dot instead of false green.
  const ownStatus=ownProfile.user_status;
  const ownStatusLabel=network>0?["在线","离开","忙碌"][ownStatus]||"在线":"离线";
  const ownBadgeStatus=network>0?["success","warning","error"][ownStatus]||"success":"default";
  const ownBadgeColor=network>0?["#52c41a","#faad14","#ff4d4f"][ownStatus]||"#52c41a":"#8c8c8c";

  const [visualStyle,setVisualStyle]=useState(()=>{
    try{
      const saved=localStorage.getItem("wtox-visual-style");
      return ["system","light","dark"].includes(saved)?saved:"system";
    }catch{return "system"}
  });
  const [systemDark,setSystemDark]=useState(()=>
    typeof window!=="undefined"&&window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const effectiveTheme=visualStyle==="system"?(systemDark?"dark":"light"):visualStyle;
  const designTokens=useMemo(()=>antdTheme.getDesignToken({
    algorithm:effectiveTheme==="dark"?antdTheme.darkAlgorithm:antdTheme.defaultAlgorithm
  }),[effectiveTheme]);
  useEffect(()=>{
    const mq=window.matchMedia("(prefers-color-scheme: dark)");
    const listener=event=>setSystemDark(event.matches);
    setSystemDark(mq.matches);
    mq.addEventListener?.("change",listener);
    return()=>mq.removeEventListener?.("change",listener);
  },[]);
  useEffect(()=>{
    document.documentElement.setAttribute("data-wtox-theme",effectiveTheme);
    try{localStorage.setItem("wtox-visual-style",visualStyle)}catch{}
  },[visualStyle,effectiveTheme]);
  const [modal,setModal]=useState(""),[notice,setNotice]=useState("");
  const [loginFile,setLoginFile]=useState(null),[busy,setBusy]=useState(false);
  const [friendId,setFriendId]=useState("");
  const [requestText,setRequestText]=useState("你好，我想添加你为 Tox 好友");
  const [historyFile,setHistoryFile]=useState(null);
  const [uploadFile,setUploadFile]=useState(null),[transfers,setTransfers]=useState([]);
  const attachmentInput=useRef(null);
  const history=useRef(null),socket=useRef(null),selectedRef=useRef(null),sendBusy=useRef(false);
  const drafts=useRef(new Map()),noticeTimer=useRef(null),lastMessage=useRef(0);
  useEffect(()=>{
    if(!user?.public_key)return;
    const keys=[user.public_key,...friends.map(f=>f.public_key)];
    setAvatarColors(ensureAvatarColors(user.public_key,keys,
      typeof localStorage!=="undefined"?localStorage:null));
  },[user?.public_key,friends]);
  const avatarColor=useCallback(key=>avatarColors[key]||avatarFallbackColor(key),[avatarColors]);
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
  const refreshFriendRequests=useCallback(async()=>{
    const data=await getJson("/api/friend-requests");
    setFriendRequests(data.requests||[]);
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
        }else if(e.type==="message"){
          await h.persist(e);
          await postJson("/api/ack",{ids:[row.id]});
        }else if(e.type==="friend_request"){
          // Friend requests remain encrypted in the server inbox
          // until accepted/rejected or their seven-day expiry.
          await refreshFriendRequests();
        }
      }catch(error){alert("消息暂存处理失败："+error.message);break}
    }
    await refreshOutbox(h);
    await refreshHistory(h);
  },[alert,refreshHistory,refreshOutbox,refreshFriendRequests]);

  const onRealtime=useCallback(async e=>{
    const h=history.current;
    if(["message","friend_request"].includes(e.type)){
      if(e.type==="friend_request"){
        refreshFriendRequests().catch(()=>{});
        alert("收到新的 Tox 好友请求");
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
  },[alert,refreshHistory,refreshFriends,refreshNetwork,refreshTransfers,refreshFriendRequests]);

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
    try{setSeen(JSON.parse(localStorage.getItem("wtox-seen-"+user.public_key)||"{}"))}
    catch{setSeen({})}
  },[user?.public_key]);
  useEffect(()=>{
    if(!user?.public_key)return;
    try{localStorage.setItem("wtox-seen-"+user.public_key,JSON.stringify(seen))}catch{}
  },[user?.public_key,seen]);
  useEffect(()=>{
    if(selected&&mobileChat&&messages.length){
      const last=Math.max(0,...messages.filter(m=>m.public_key===selected&&
        m.direction==="incoming").map(m=>m.at||0));
      if(last>(seen[selected]||0))setSeen(previous=>({...previous,[selected]:last}));
    }
  },[selected,mobileChat,messages,seen]);
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
      refreshFriends(),refreshNetwork(),refreshFriendRequests(),
      getJson("/api/profile/self").then(setOwnProfile).catch(error=>
        alert("无法获取 Tox 个人资料："+error.message))
    ]);
  },[user?.public_key,refreshFriends,refreshNetwork,refreshFriendRequests,alert]);
  const screens=Grid.useBreakpoint();
  const isMobile=(!!screens.xs||!!screens.sm)&&!screens.md;
  const selectedFriend=friends.find(f=>f.public_key===selected);
  const peerStatus=selectedFriend?.status===0||!selectedFriend?"离线":
    ["在线","离开","忙碌"][selectedFriend.user_status]||"在线";
  const peerStatusColor=selectedFriend?.status===0||!selectedFriend?"default":
    ["success","warning","error"][selectedFriend.user_status]||"success";
  const peerProfileContent=selectedFriend?(
<div className="wt-peer-profile">
              <Space size="middle" align="center">
                <Badge dot color={selectedFriend.status===0?"#8c8c8c":
                  ["#52c41a","#faad14","#ff4d4f"][selectedFriend.user_status]||"#52c41a"}
                  offset={[-2,37]}>
                  <Avatar size={48} shape="square" gap={4}
                    style={{backgroundColor:avatarColor(selectedFriend.public_key)}}>
                    {avatarLabel(selectedFriend.name,selectedFriend.public_key)}
                  </Avatar>
                </Badge>
                <div>
                  <Typography.Title level={5} style={{margin:0}}>
                    {selectedFriend.name||"Tox 好友"}
                  </Typography.Title>
                  <Badge status={peerStatusColor} text={peerStatus}/>
                </div>
              </Space>
              <Divider/>
              <Typography.Text type="secondary">状态消息</Typography.Text>
              <Typography.Paragraph className="wt-peer-status-message">
                {selectedFriend.status_message||"对方暂未设置状态消息"}
              </Typography.Paragraph>
              <Typography.Text type="secondary">
                {selectedFriend.tox_id?"完整 Tox ID（76 位）":"好友公钥（64 位）"}
              </Typography.Text>
              <Typography.Paragraph className="wt-peer-id" copyable={{
                text:selectedFriend.tox_id||selectedFriend.public_key,
                tooltips:["复制","已复制"]
              }}>
                {selectedFriend.tox_id||selectedFriend.public_key}
              </Typography.Paragraph>
              {!selectedFriend.tox_id&&<Typography.Text type="secondary">
                只有公钥时无法还原完整 Tox ID。
              </Typography.Text>}
            </div>
  ):null;
  const thread=useMemo(()=>messages.filter(e=>e.public_key===selected&&["message","file"].includes(e.type))
    .sort((a,b)=>a.at-b.at).slice(-250),[selected,messages]);
  const scrollToLatest=useCallback(()=>{
    const element=threadEl.current;
    followLatest.current=true;
    setNewBelowCount(0);
    if(element)element.scrollTop=element.scrollHeight;
  },[]);
  const onThreadScroll=useCallback(()=>{
    const element=threadEl.current;
    if(!element)return;
    const atBottom=isNearBottom(element);
    followLatest.current=atBottom;
    if(atBottom)setNewBelowCount(count=>count===0?count:0);
    setThreadScrolling(true);
    if(scrollIdleTimer.current)clearTimeout(scrollIdleTimer.current);
    scrollIdleTimer.current=setTimeout(()=>setThreadScrolling(false),950);
  },[]);
  useEffect(()=>()=>{if(scrollIdleTimer.current)clearTimeout(scrollIdleTimer.current)},[]);
  useLayoutEffect(()=>{
    const element=threadEl.current;
    const ids=thread.map(item=>item.id);
    const previous=previousThread.current;
    if(previous.peer!==selected){
      previousThread.current={peer:selected,ids};
      followLatest.current=true;
      setNewBelowCount(0);
      if(element)element.scrollTop=element.scrollHeight;
      return;
    }
    const newlyAdded=countNewEntries(previous.ids,ids);
    previousThread.current={peer:selected,ids};
    if(followLatest.current){
      if(element)element.scrollTop=element.scrollHeight;
      setNewBelowCount(count=>count===0?count:0);
    }else if(newlyAdded>0){
      // Updating delivery receipts does not add IDs, so it cannot inflate
      // this badge while the reader is looking at earlier messages.
      setNewBelowCount(count=>count+newlyAdded);
    }
  },[selected,thread]);
  useEffect(()=>{
    const element=threadEl.current;
    const content=element?.firstElementChild;
    if(!content||typeof ResizeObserver==="undefined")return;
    const observer=new ResizeObserver(()=>{
      // Images and delayed attachment previews may change message height
      // after the message itself was rendered.
      if(followLatest.current)element.scrollTop=element.scrollHeight;
    });
    observer.observe(content);
    return()=>observer.disconnect();
  },[selected]);

  const latestByPeer=useMemo(()=>{
    const latest=new Map();
    for(const item of messages){
      if(!["message","file"].includes(item.type) || !item.public_key)continue;
      const prior=latest.get(item.public_key);
      if(!prior||item.at>prior.at)latest.set(item.public_key,item);
    }
    return latest;
  },[messages]);
  const visibleFriends=useMemo(()=>friends.filter(f=>
    ((f.name||"")+" "+f.public_key).toLowerCase().includes(filter.toLowerCase()))
    .sort((a,b)=>{
      if(section==="contacts")return (a.name||a.public_key).localeCompare(b.name||b.public_key,"zh-CN");
      const left=latestByPeer.get(a.public_key)?.at||0;
      const right=latestByPeer.get(b.public_key)?.at||0;
      return right-left || Number(online(b))-Number(online(a));
    }),[friends,filter,latestByPeer,section]);
  const unreadFor=useCallback(peer=>messages.filter(m=>m.type==="message" &&
    m.direction==="incoming"&&m.public_key===peer&&(m.at||0)>(seen[peer]||0)).length,
    [messages,seen]);

  function selectFriend(key){
    if(selectedRef.current)drafts.current.set(selectedRef.current,draft);
    selectedRef.current=key;setSelected(key);
    setPeerDetailsOpen(false);
    setDraft(drafts.current.get(key)||"");setMobileChat(true);
    // Opening the same conversation again also restores bottom following.
    requestAnimationFrame(scrollToLatest);
    setSeen(previous=>({...previous,[key]:Date.now()}));
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
  async function acceptRequest(item){
    try{
      const result=await postJson("/api/friend-requests/"+encodeURIComponent(item.id)+"/accept");
      await Promise.all([refreshFriendRequests(),refreshFriends()]);
      selectFriend(result.public_key);setModal("");
      alert("已接受好友请求");
    }catch(error){alert(error.message)}
  }
  async function rejectRequest(item){
    try{
      await api("/api/friend-requests/"+encodeURIComponent(item.id),{method:"DELETE"});
      await refreshFriendRequests();
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
      setModal("");
      alert("Tox 个人资料已保存");
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
    const file=uploadFile;
    if(!selected||!online(selectedFriend)){alert("附件要求双方在线");return}
    if(!file||file.size<1||file.size>5*1024*1024){
      alert("附件大小需为 1 字节至 5 MiB");return;
    }
    setBusy(true);
    try{
      const url="/api/files/send?peer="+encodeURIComponent(selected)+
        "&name="+encodeURIComponent(file.name);
      const response=await api(url,{
        method:"POST",raw:true,
        headers:{"Content-Type":"application/octet-stream"},
        body:file
      });
      const transfer=await response.json();
      const h=history.current;
      // Directly persist the returned transfer, independently of WebSocket
      // timing; then it always appears among the current chat bubbles.
      if(h?.ready()){
        await h.persistFile(transfer);
        if(/\.(png|jpe?g|webp|gif)$/i.test(file.name) && file.size<=5*1024*1024){
          const mime=file.type.startsWith("image/")?file.type:
            /\.png$/i.test(file.name)?"image/png":"image/jpeg";
          await h.cacheImage(transfer.id,new Blob([file],{type:mime}));
        }
        await refreshHistory(h);
      }
      setUploadFile(null);
      if(attachmentInput.current)attachmentInput.current.value="";
      await refreshTransfers();
      alert("附件已加入聊天，等待对方接受");
    }catch(error){alert("发送附件失败："+error.message)}
    finally{setBusy(false)}
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

  // Shared Ant Design settings, rendered as a full mobile "Me" page or
  // a desktop modal; do not duplicate form state or export controls.
  const settingsContent=<div className="wt-settings-content">
    <Card size="small" title="外观" className="wt-settings-card">
      <Segmented block value={visualStyle} onChange={setVisualStyle}
        options={[{label:"跟随系统",value:"system"},{label:"浅色",value:"light"},
          {label:"深色",value:"dark"}]}/>
    </Card>
    <Card size="small" title="Tox 身份备份" className="wt-settings-card">
      <Typography.Paragraph type="secondary">
        .tox 文件包含身份私钥，请妥善保管，切勿分享。
      </Typography.Paragraph>
      <AntButton block onClick={async()=>{
        try{downloadBlob(await(await api("/api/profile/export")).blob(),"wTox-profile.tox")}
        catch(e){alert(e.message)}
      }}>下载 .tox 配置</AntButton>
    </Card>
    <Card size="small" title="聊天记录" className="wt-settings-card">
      {migrateRequired&&<Form layout="vertical">
        <Form.Item label="迁移旧版加密历史">
          <Input.Password value={legacyPass} onChange={e=>setLegacyPass(e.target.value)}/>
        </Form.Item>
        <AntButton type="primary" onClick={migrateHistory}>迁移旧历史</AntButton>
      </Form>}
      <Space orientation="vertical" style={{width:"100%"}} size="middle">
        <AntButton block onClick={exportJson}>导出聊天记录（wTox JSON）</AntButton>
        <Upload accept=".json,application/json" maxCount={1}
          beforeUpload={file=>{setHistoryFile(file);return false}}
          onRemove={()=>setHistoryFile(null)}
          fileList={historyFile?[{uid:"import",name:historyFile.name,status:"done"}]:[]}>
          <AntButton block>选择历史记录文件</AntButton>
        </Upload>
        <AntButton type="primary" block disabled={!historyFile} onClick={importHistory}>
          导入聊天记录
        </AntButton>
      </Space>
      <Typography.Paragraph type="secondary" className="wt-settings-footnote">
        历史 JSON 导出文件是明文，需自行妥善保存。
      </Typography.Paragraph>
    </Card>
    <AntButton danger block onClick={logout}>退出当前身份</AntButton>
  </div>;

  if(loading)return <div className="wtox-loading">正在加载 wTox…</div>;
  if(!user)return <div className="wtox-auth-layout">
    <div className="wtox-auth-card"><img className="wtox-logo" src="/logo.svg" alt="wtox"/>
      <h1>wTox</h1>
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
    algorithm:effectiveTheme==="dark"?antdTheme.darkAlgorithm:antdTheme.defaultAlgorithm
  }}>
  <div className={"wtox-shell ant-messenger "+(mobileChat?"show-chat ":"")+(section==="me"?"show-me":"")}
    data-theme={effectiveTheme}
    style={{
      "--wt-bg":designTokens.colorBgLayout,
      "--wt-panel":designTokens.colorBgContainer,
      "--wt-hover":designTokens.colorFillSecondary,
      "--wt-border":designTokens.colorBorderSecondary,
      "--wt-text":designTokens.colorText,
      "--wt-muted":designTokens.colorTextSecondary,
      "--wt-primary":designTokens.colorPrimary,
      "--wt-own":designTokens.colorPrimaryBg,
      "--wt-incoming":designTokens.colorBgElevated
    }}>
    <div className="wtox-workspace ant-workspace wechat-layout">
      <nav className="wechat-rail" aria-label="主导航">
        <AntButton type="text" className="wechat-rail-avatar" aria-label="我的 Tox 资料"
          title="我的 Tox 资料" onClick={()=>setModal("profile")}>
          <Tooltip title={ownStatusLabel}>
            <Badge dot color={ownBadgeColor} offset={[-2,35]}>
              <Avatar size={44} shape="square" gap={3} className="wechat-self-avatar"
                style={{backgroundColor:avatarColor(user.public_key)}}
                icon={!ownProfile.name?<UserOutlined/>:undefined}>
                {ownProfile.name?avatarLabel(ownProfile.name):undefined}
              </Avatar>
            </Badge>
          </Tooltip>
        </AntButton>
        <div className="wechat-rail-primary">
          <button type="button" className={"wechat-rail-button "+(section==="chats"?"is-active":"")}
            aria-label="聊天" aria-current={section==="chats"?"page":undefined}
            onClick={()=>{setSection("chats");setMobileChat(false)}}>
            <MessageOutlined/><span>聊天</span>
          </button>
          <button type="button" className={"wechat-rail-button "+(section==="contacts"?"is-active":"")}
            aria-label="通讯录" aria-current={section==="contacts"?"page":undefined}
            onClick={()=>{setSection("contacts");setMobileChat(false)}}>
            <ContactsOutlined/><span>通讯录</span>
          </button>
        </div>
        <div className="wechat-rail-bottom">
          <button type="button" className="wechat-rail-button"
            aria-label="设置与备份" onClick={()=>setModal("settings")}>
            <SettingOutlined/><span>设置</span>
          </button>
        </div>
      </nav>
      <aside className="ant-contact-sidebar">
        <div className="wechat-list-head">
          <div className="wechat-mobile-heading">
            <AntButton type="text" className="wechat-mobile-avatar" aria-label="我的 Tox 资料"
              onClick={()=>setModal("profile")}>
              <Tooltip title={ownStatusLabel}>
                <Badge dot color={ownBadgeColor} offset={[-2,25]}>
                  <Avatar size={32} shape="square" gap={3} style={{backgroundColor:avatarColor(user.public_key)}}
                    icon={!ownProfile.name?<UserOutlined/>:undefined}>
                    {ownProfile.name?avatarLabel(ownProfile.name):undefined}
                  </Avatar>
                </Badge>
              </Tooltip>
            </AntButton>
            <strong>wTox</strong>
          </div>
          <h2 className="wechat-desktop-heading">{section==="contacts"?"通讯录":"聊天"}</h2>
          <Tooltip title="添加好友">
            <AntButton type="text" icon={<PlusOutlined/>} aria-label="添加好友"
              onClick={()=>setModal("add")}/>
          </Tooltip>
        </div>
        <div className="wechat-search">
          <Input allowClear value={filter} placeholder="搜索"
            prefix={<span className="wechat-search-icon">⌕</span>}
            aria-label="搜索联系人" onChange={e=>setFilter(e.target.value)}/>
        </div>
        <div className="wechat-list">
          {visibleFriends.map(friend=>{
            const recent=latestByPeer.get(friend.public_key);
            const draftsText=drafts.current.get(friend.public_key)||"";
            const preview=section==="contacts"
              ?statusLabel(friend.status)
              :draftsText?"[草稿] "+draftsText:
                recent?.type==="file"?"[附件] "+(recent.file_name||"文件"):
                recent?.text||statusLabel(friend.status);
            const when=recent?.at?new Date(recent.at):null;
            const clock=when ? (Date.now()-when.getTime()>86400000?
              when.toLocaleDateString("zh-CN",{month:"2-digit",day:"2-digit"}):
              when.toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"})):"";
            const unread=unreadFor(friend.public_key);
            return <button type="button" key={friend.public_key}
              className={"wechat-conversation "+(selected===friend.public_key?"is-selected":"")}
              onClick={()=>selectFriend(friend.public_key)}>
              <Avatar size={45} shape="square" gap={4} className="wechat-contact-avatar"
                style={{backgroundColor:avatarColor(friend.public_key)}}>
                {avatarLabel(friend.name,friend.public_key)}
              </Avatar>
              <span className="wechat-conversation-text">
                <span className="wechat-conversation-name">{friend.name||"Tox 好友 "+shortKey(friend.public_key)}</span>
                <span className="wechat-conversation-preview">{preview}</span>
              </span>
              <span className="wechat-conversation-side">
                <time>{clock}</time>
                {unread>0?<span className="wechat-unread">{unread>99?"99+":unread}</span>
                  :<i className={"wechat-presence "+(online(friend)?"online":"")} />}
              </span>
            </button>;
          })}
          {!visibleFriends.length&&<div className="wechat-no-contacts">
            <ContactsOutlined style={{fontSize:30}}/>
            <p>{friends.length?"没有找到联系人":"还没有联系人"}</p>
            <AntButton type="link" onClick={()=>setModal("add")}>添加 Tox 好友</AntButton>
          </div>}
        </div>
        <nav className="wechat-mobile-tabs" aria-label="手机导航">
          <button type="button" className={section==="chats"?"active":""}
            aria-current={section==="chats"?"page":undefined}
            onClick={()=>setSection("chats")}><MessageOutlined/><span>聊天</span></button>
          <button type="button" className={section==="contacts"?"active":""}
            aria-current={section==="contacts"?"page":undefined}
            onClick={()=>setSection("contacts")}><ContactsOutlined/><span>通讯录</span></button>
          <button type="button" onClick={()=>{setSection("me");setMobileChat(false)}}>
            <SettingOutlined/><span>设置</span>
          </button>
        </nav>
      </aside>
      <section className="wt-mobile-me-page" aria-label="设置">
        <header className="wt-mobile-me-header">
          <Typography.Title level={4}>设置</Typography.Title>
        </header>
        <div className="wt-mobile-settings-scroll">
          {settingsContent}
        </div>
        <nav className="wechat-mobile-tabs" aria-label="手机导航">
          <button type="button" onClick={()=>setSection("chats")}>
            <MessageOutlined/><span>聊天</span>
          </button>
          <button type="button" onClick={()=>setSection("contacts")}>
            <ContactsOutlined/><span>通讯录</span>
          </button>
          <button type="button" className="active" aria-current="page">
            <SettingOutlined/><span>设置</span>
          </button>
        </nav>
      </section>
      <main className="ant-chat-area">
        <div className="ant-chat-toolbar">
          <div className="ant-chat-identity">
            <AntButton className="ant-mobile-back" aria-label="返回联系人"
              icon={<ArrowLeftOutlined/>} onClick={()=>setMobileChat(false)}/>
            <Tooltip title={selectedFriend?"查看好友资料":""}>
              <AntButton type="text" className="wt-peer-avatar-button"
                aria-label="查看好友 Tox 资料" disabled={!selectedFriend}
                onClick={()=>setPeerDetailsOpen(true)}>
                <Avatar size={40} gap={4} className="ant-chat-avatar"
                  style={{backgroundColor:avatarColor(selectedFriend?.public_key||user.public_key)}}>
                  {selectedFriend?avatarLabel(selectedFriend.name,selectedFriend.public_key):"✦"}
                </Avatar>
              </AntButton>
            </Tooltip>
            <div className="ant-peer-title">
              <div className="wt-peer-name-row">
                <strong>{selectedFriend?.name|| (selected?"好友 "+shortKey(selected):"选择好友开始聊天")}</strong>
                {selectedFriend&&<Badge status={peerStatusColor} text={peerStatus}/>}
              </div>
              <small title={selectedFriend?.status_message||""}>
                {selectedFriend?.status_message?.trim()|| (selectedFriend?"暂无状态消息":"wTox")}
              </small>
            </div>
          </div>
          <Space>
            <Tooltip title="删除当前好友">
              <Popconfirm title="删除此 Tox 好友？" description="本地聊天记录不会被删除"
                onConfirm={removeFriend} okText="删除" cancelText="取消" disabled={!selected}>
                <AntButton danger shape="circle" disabled={!selected}
                  icon={<DeleteOutlined/>} aria-label="删除好友"/>
              </Popconfirm>
            </Tooltip>
          </Space>
        </div>
        <div className="wt-thread-shell">
          <div ref={threadEl}
            className={"ant-thread"+(threadScrolling?" wt-thread-scrolling":"")}
            onScroll={onThreadScroll} role="log" aria-label="聊天记录">
            <div className="wt-thread-content">
          {!selected&&<div className="ant-empty-chat">
            <img src="/logo.svg" alt="" width="74" height="74"/>
            <h3>欢迎使用 wTox</h3><p>选择一位好友，开始私人对话</p>
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
            : <div key={item.id} className={"ant-message-wrap wt-message-row "+
                (item.direction==="outgoing"?"wt-message-outgoing":"wt-message-incoming")}
                onContextMenu={event=>{event.preventDefault();requestDelete(item)}}
                onTouchStart={()=>startLongPress(item)}
                onTouchEnd={cancelLongPress}
                onTouchMove={cancelLongPress}>
                {item.direction!=="outgoing"&&<AntButton type="text"
                  className="wt-message-peer-avatar" aria-label="查看好友 Tox 资料"
                  onClick={event=>{event.stopPropagation();setPeerDetailsOpen(true)}}
                  onTouchStart={event=>event.stopPropagation()}
                  onContextMenu={event=>event.stopPropagation()}>
                  <Avatar size={34} shape="square" gap={3}
                    style={{backgroundColor:avatarColor(item.public_key)}}>
                    {avatarLabel(selectedFriend?.name,item.public_key)}
                  </Avatar>
                </AntButton>}
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
          </div>
          {selected&&newBelowCount>0&&<AntButton type="primary" shape="round"
            className="wt-new-message-indicator" icon={<ArrowDownOutlined/>}
            onClick={scrollToLatest} aria-label={`查看下面的${newBelowCount}条新消息`}>
            {newBelowCount} 条新消息
          </AntButton>}
        </div>
        <div className="ant-compose-area">
          <p className="ant-compose-status">{!selected?"请先选择好友":
            !historyReady?"本地加密历史尚未就绪":
            !online(selectedFriend)?"对方离线，VPS 已准备好离线队列":
            sending?"正在发送请求":"Enter 发送 · Shift + Enter 换行"}</p>
          <input type="file" hidden ref={attachmentInput}
            aria-label="选择要发送的附件"
            onChange={e=>setUploadFile(e.target.files?.[0]||null)}/>
          <Sender className="wt-chat-sender" value={draft}
            placeholder="输入消息…" autoSize={{minRows:2,maxRows:5}}
            prefix={<Tooltip title="添加附件">
              <AntButton type="text" icon={<PaperClipOutlined/>}
                aria-label="添加附件" disabled={!selected||!online(selectedFriend)}
                onClick={()=>attachmentInput.current?.click()}/>
            </Tooltip>}
            header={<Sender.Header title="准备发送附件" open={!!uploadFile}
              onOpenChange={open=>{if(!open)setUploadFile(null)}}>
              {uploadFile&&<Space orientation="vertical" size="small"
                className="wt-send-file-preview">
                <FileCard name={uploadFile.name} byte={uploadFile.size} size="small"/>
                <Space>
                  <AntButton type="primary" size="small" loading={busy}
                    disabled={!online(selectedFriend)} onClick={sendFile}>
                    发送附件
                  </AntButton>
                  <AntButton size="small" onClick={()=>setUploadFile(null)}>取消</AntButton>
                </Space>
              </Space>}
            </Sender.Header>}
            onPasteFile={files=>{
              const file=files?.[0];
              if(file)setUploadFile(file);
            }}
            onChange={value=>{setDraft(value);if(selected)drafts.current.set(selected,value)}}
            onSubmit={text=>sendText("",text,text)}
            disabled={!selected||!historyReady||sending} submitType="enter"/>
        </div>
      </main>
    </div>

    {selectedFriend&&<>
      {isMobile
        ? <Drawer open={peerDetailsOpen} title="好友资料" placement="bottom"
            height="auto" styles={{body:{maxHeight:"68dvh",overflowY:"auto"}}}
            onClose={()=>setPeerDetailsOpen(false)} destroyOnHidden>
            {peerProfileContent}
          </Drawer>
        : <AntModal open={peerDetailsOpen} title="好友资料"
            onCancel={()=>setPeerDetailsOpen(false)} footer={null}
            centered destroyOnHidden width={500}>
            {peerProfileContent}
          </AntModal>}
    </>}

    {modal==="profile"&&<AntModal open title="我的 Tox 资料"
      onCancel={closeModal} footer={null} centered destroyOnHidden width={520}>
      <Typography.Text type="secondary">我的 Tox ID（可分享给好友）</Typography.Text>
      <Typography.Paragraph className="wtox-profile-id"
        copyable={{text:user.tox_id,tooltips:["复制 Tox ID","已复制"]}}>
        {user.tox_id}
      </Typography.Paragraph>
      <Form layout="vertical" className="profile-editor" onFinish={saveOwnProfile}>
        <Form.Item label="昵称">
          <Input value={ownProfile.name} maxLength={128} showCount
            placeholder="昵称（其他 Tox 客户端可见）"
            onChange={e=>setOwnProfile(p=>({...p,name:e.target.value}))}/>
        </Form.Item>
        <Form.Item label="状态消息">
          <Input.TextArea rows={2} value={ownProfile.status_message} maxLength={1007}
            placeholder="向好友展示的状态消息"
            onChange={e=>setOwnProfile(p=>({...p,status_message:e.target.value}))}/>
        </Form.Item>
        <Form.Item label="状态">
          <Select value={ownProfile.user_status}
            onChange={value=>setOwnProfile(p=>({...p,user_status:value}))}
            options={[{label:"在线",value:0},{label:"离开",value:1},{label:"忙碌",value:2}]}/>
        </Form.Item>
        <AntButton type="primary" htmlType="submit" loading={profileSaving} block>
          保存 Tox 个人资料
        </AntButton>
      </Form>
    </AntModal>}

    {modal==="settings"&&<AntModal open title="设置与备份" onCancel={closeModal} footer={null} centered destroyOnHidden width={640}>
      {settingsContent}
    </AntModal>}

    {modal==="add"&&<AntModal open title="添加 Tox 好友" onCancel={closeModal}
      footer={null} centered destroyOnHidden>
      <Form layout="vertical" onFinish={addFriend}>
        <Form.Item label="好友 Tox ID（76 位）" required>
          <Input.TextArea rows={3} value={friendId} onChange={e=>setFriendId(e.target.value)}
            placeholder="输入好友完整 Tox ID"/>
        </Form.Item>
        <Form.Item label="附言">
          <Input value={requestText} onChange={e=>setRequestText(e.target.value)}/>
        </Form.Item>
        <AntButton type="primary" htmlType="submit" block>发送好友请求</AntButton>
      </Form>
    </AntModal>}
    {modal==="requests"&&<AntModal open title={`好友请求（${friendRequests.length}）`}
      onCancel={closeModal} footer={null} centered destroyOnHidden>
      <List dataSource={friendRequests} locale={{emptyText:"暂无待处理的好友请求"}}
        renderItem={item=><List.Item actions={[
          <AntButton key="accept" type="primary" size="small" onClick={()=>acceptRequest(item)}>接受</AntButton>,
          <AntButton key="reject" size="small" danger onClick={()=>rejectRequest(item)}>拒绝</AntButton>
        ]}>
          <List.Item.Meta title={<Typography.Text copyable={{text:item.public_key}}>
            {shortKey(item.public_key)}</Typography.Text>}
            description={<><div>{item.text||"希望添加你为好友"}</div>
              <Typography.Text type="secondary">
                {new Date(item.created*1000).toLocaleString("zh-CN")}
              </Typography.Text></>}/>
        </List.Item>}/>
    </AntModal>}

    {notice&&<div className="wtox-toast" role="status">{notice}</div>}
  </div></ConfigProvider>;
}
