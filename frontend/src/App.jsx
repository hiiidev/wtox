import React, {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from "react";
import { ConfigProvider, theme as antdTheme, Button as AntButton, Input,
  Space, Tooltip, Segmented, Avatar, Divider, Popconfirm, Modal as AntModal, notification,
  Dropdown, Badge, List, Typography, Form, Select, Drawer, Grid, Card, Image, Upload, QRCode, message } from "antd";
import { Bubble, Sender, FileCard } from "@ant-design/x";
import { PaperClipOutlined, SettingOutlined, ArrowLeftOutlined,
  UserAddOutlined, DeleteOutlined, MessageOutlined, ContactsOutlined,
  UserOutlined, PlusOutlined, QrcodeOutlined, SmileOutlined, FolderOutlined,
  ArrowDownOutlined, CopyOutlined, CheckSquareOutlined, SettingFilled
  } from "@ant-design/icons";
import PushSettings from "./PushSettings.jsx";
import PwaPushWelcome from "./PwaPushWelcome.jsx";
import {isStandalone} from "./push_client.js";
import {LOGO_URL} from "./versioned_assets.js";
import {disablePushBeforeLogout} from "./push_client.js";
import {api,getJson,postJson,downloadBlob,downloadToxFile,shortKey} from "./api.js";
import {openIdentityHistory} from "./history.js";
import {avatarLabel,avatarFallbackColor,ensureAvatarColors} from "./avatar_utils.js";
import {isNearBottom,countNewEntries} from "./thread_scroll.js";
import {chatTime} from "./chat_time.js";
import {clearIdentityBrowserData} from "./identity_cleanup.js";
import {shouldNotifyMessage,messageNotificationId} from "./message_notifications.js";
import {unreadCountsByPeer,totalUnreadForFriends} from "./unread_counts.js";
import {MAX_HISTORY_IMPORT,toWtoxJson,fromWtoxJson} from "../history_io.js";

const online=friend=>friend && (friend.status===1||friend.status===2);
const transferText={uploading:"正在上传",uncertain:"发送已受理，状态待确认",offered:"等待接受",waiting:"等待对方接受",receiving:"接收中",sending:"发送中",
  completed:"已完成",failed:"失败",cancelled:"已取消"};
function stateText(record){
  if(record.delivery_status==="delivered"||record.delivery_status==="read")return "已送达";
  if(record.delivery_status==="failed")return "发送失败";
  if(record.delivery_status==="uncertain")return "发送结果待确认";
  if(record.delivery_status==="queued_local")return "正在提交";
  if(record.delivery_status==="queued")return "等待发送";
  if(["dispatching","dispatching_local"].includes(record.delivery_status))return "正在发送";
  if(record.message_id===undefined&&!record.outbox_id&&!record.delivery_status)return "历史消息";
  return "已发送";
}
function Button({children,onClick,kind="",disabled=false}){
  return <AntButton type={kind==="primary"?"primary":"default"}
    onClick={onClick} disabled={disabled} className="wtox-ant-btn">{children}</AntButton>;
}
async function decodedImage(blob){
  // A filename extension is not proof that arbitrary bytes are a JPEG/PNG.
  // Verify decodability before displaying or caching a thumbnail.
  if(typeof createImageBitmap==="function"){
    try{
      const image=await createImageBitmap(blob);
      image.close();return true;
    }catch{return false}
  }
  const url=URL.createObjectURL(blob);
  try{
    const image=new globalThis.Image();
    image.src=url;
    await image.decode();
    return true;
  }catch{return false}
  finally{URL.revokeObjectURL(url)}
}

function AttachmentBubble({file,accept,reject,download,historyHandle,imageCacheRevision}){
  const [preview,setPreview]=useState("");
  const [previewMissing,setPreviewMissing]=useState(false);
  const isPicture=/\.(?:png|jpe?g|webp|gif)$/i.test(file.file_name||"");
  const completed=file.file_state==="completed";
  const canDownload=file.direction==="incoming"&&completed;
  useEffect(()=>{
    if(!isPicture)return;
    let alive=true,url="";
    setPreview("");setPreviewMissing(false);
    (async()=>{
      try{
        let blob=file.previewBlob||(
          file.file_id&&historyHandle?.ready()
            ? await historyHandle.cachedImage(file.file_id):null);
        if(!blob&&canDownload){
          const response=await api("/api/files/"+encodeURIComponent(file.file_id)+"/download");
          blob=await response.blob();
          if(blob.size>5*1024*1024)return;
          const mime=/\.png$/i.test(file.file_name)?"image/png":
            /\.webp$/i.test(file.file_name)?"image/webp":
            /\.gif$/i.test(file.file_name)?"image/gif":"image/jpeg";
          blob=new Blob([blob],{type:mime});
          if(!await decodedImage(blob))throw new Error("附件不是可解码的图片");
          if(historyHandle?.ready())await historyHandle.cacheImage(file.file_id,blob);
        }
        if(!blob){
          if(alive&&completed)setPreviewMissing(true);
          return;
        }
        if(!await decodedImage(blob))throw new Error("图片解码失败");
        if(!alive)return;
        url=URL.createObjectURL(blob);
        setPreview(url);
      }catch{
        if(alive)setPreviewMissing(true);
      }
    })();
    return()=>{alive=false;if(url)URL.revokeObjectURL(url)};
  },[canDownload,isPicture,file.file_id,file.file_name,file.previewBlob,
     historyHandle,imageCacheRevision]);
  const percentage=file.file_size>0?Math.min(100,Math.floor(
    (file.file_progress||0)/file.file_size*100)):0;
  const mine=file.direction==="outgoing";
  const state=transferText[file.file_state]||file.file_state;
  return <div className={"wtox-attachment-row "+(mine?"out":"")} role="group"
     aria-label={"附件 "+file.file_name}>
    <Card size="small" className="wtox-attachment-bubble">
      {isPicture
        ? <>
            {preview&&<Image className="wtox-attachment-image" src={preview}
              alt={file.file_name} width={220} preview={{mask:"查看图片"}}/>}
            <Typography.Text className="wt-attachment-filename" title={file.file_name}>
              {file.file_name}
            </Typography.Text>
          </>
        : <FileCard name={file.file_name} byte={file.file_size} size="small"/>}
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
      {completed&&!preview&&previewMissing&&isPicture&&<Typography.Text type="secondary">
        图片预览不可用或已过期
      </Typography.Text>}
    </Card>
    <time>{chatTime(file.at)}</time>
  </div>;
}
function StatusDot({active}){return <i className={"wtox-dot "+(active?"on":"")}/>;}
/* Embedded SVGs: no external Iconify requests. Align optical sizes with
 * SettingFilled's 25px glyph using type-specific icon boxes.
 */
function RailIcon({kind}){
  if(kind==="settings"){
    return <SettingFilled className="wt-rail-glyph wt-rail-glyph-settings"
      aria-hidden="true"/>;
  }
  if(kind==="contacts"){
    return <svg xmlns="http://www.w3.org/2000/svg"
      className="wt-rail-glyph wt-rail-glyph-contacts"
      width="1.25em" height="1em" viewBox="0 0 640 512"
      aria-hidden="true" focusable="false">
      <path fill="currentColor"
        d="M96 128a128 128 0 1 1 256 0a128 128 0 1 1-256 0M0 482.3C0 383.8 79.8 304 178.3 304h91.4c98.5 0 178.3 79.8 178.3 178.3c0 16.4-13.3 29.7-29.7 29.7H29.7C13.3 512 0 498.7 0 482.3M609.3 512H471.5c5.4-9.4 8.6-20.3 8.6-32v-8c0-60.7-27.1-115.2-69.8-151.8c2.4-.1 4.7-.2 7.1-.2h61.4c89 0 161.2 72.2 161.2 161.3c0 17-13.8 30.7-30.7 30.7M432 256c-31 0-59-12.6-79.3-32.9c19.7-26.6 31.3-59.5 31.3-95.1c0-26.8-6.6-52.1-18.3-74.3C384.3 40.1 407.2 32 432 32c61.9 0 112 50.1 112 112s-50.1 112-112 112"/>
    </svg>;
  }
  return <svg xmlns="http://www.w3.org/2000/svg"
    className="wt-rail-glyph wt-rail-glyph-chats"
    width="1em" height="1em" viewBox="0 0 24 24"
    aria-hidden="true" focusable="false">
    <path fill="currentColor"
      d="M12 2C6.49 2 2 6.49 2 12c0 2.12.68 4.19 1.93 5.9l-1.75 2.53c-.21.31-.24.7-.06 1.03c.17.33.51.54.89.54h9c5.51 0 10-4.49 10-10S17.51 2 12 2M8 13c-.55 0-1-.45-1-1s.45-1 1-1s1 .45 1 1s-.45 1-1 1m4 0c-.55 0-1-.45-1-1s.45-1 1-1s1 .45 1 1s-.45 1-1 1m4 0c-.55 0-1-.45-1-1s.45-1 1-1s1 .45 1 1s-.45 1-1 1"/>
  </svg>;
}

export default function App(){
  const [user,setUser]=useState(null),[loading,setLoading]=useState(true);
  const [bootstrapError,setBootstrapError]=useState("");
  const [friends,setFriends]=useState([]),[network,setNetwork]=useState(-1);
  const [networkDiagnostics,setNetworkDiagnostics]=useState(null);
  const [selected,setSelected]=useState(null),[mobileChat,setMobileChat]=useState(false);
  const [section,setSection]=useState("chats");
  const [friendRequests,setFriendRequests]=useState([]);
  const [friendMessageApi,friendMessageContext]=message.useMessage({top:24,maxCount:2});
  const [friendNotificationApi,friendNotificationContext]=notification.useNotification({
    placement:"topRight",top:22,maxCount:2
  });
  const [uiMessageApi,uiMessageContext]=message.useMessage({top:76,maxCount:4});
  const dismissedFriendIds=useRef(null);
  const notificationPromptShown=useRef(false);
  const [peerDetailsOpen,setPeerDetailsOpen]=useState(false);
  const [deleteFriendOpen,setDeleteFriendOpen]=useState(false);
  const [removingFriend,setRemovingFriend]=useState(false);
  const [seen,setSeen]=useState({});
  const seenHydration=useRef(null);
  const [filter,setFilter]=useState(""),[draft,setDraft]=useState("");
  const [messages,setMessages]=useState([]),[historyReady,setHistoryReady]=useState(false);
  const [avatarColors,setAvatarColors]=useState({});
  const [newBelowCount,setNewBelowCount]=useState(0);
  const [threadScrolling,setThreadScrolling]=useState(false);
  const [selectedMessageIds,setSelectedMessageIds]=useState(()=>new Set());
  const [deletingMessages,setDeletingMessages]=useState(false);
  const [singleDeleteId,setSingleDeleteId]=useState(null);
  const threadEl=useRef(null);
  const swipeStart=useRef(null);
  const followLatest=useRef(true);
  const previousThread=useRef({peer:null,ids:[]});
  const scrollIdleTimer=useRef(null);
  const [migrateRequired,setMigrateRequired]=useState(false),[legacyPass,setLegacyPass]=useState("");
  const [sending,setSending]=useState(false);
  const [logoutOpen,setLogoutOpen]=useState(false);
  const [logoutBusy,setLogoutBusy]=useState(false);
  const [ownProfile,setOwnProfile]=useState({name:"",status_message:"",user_status:0});
  const [profileSaving,setProfileSaving]=useState(false);
  // Permission is only requested from the explicit settings button, never on load.
  const [notificationsEnabled,setNotificationsEnabled]=useState(()=>{
    try{return localStorage.getItem("wtox-browser-notifications")==="1"}catch{return false}
  });
  const [notificationPermission,setNotificationPermission]=useState(()=>
    typeof Notification==="undefined"?"unsupported":Notification.permission);
  const notificationsEnabledRef=useRef(notificationsEnabled);
  const installedPwa=isStandalone();
  const notifiedMessageIds=useRef(new Set());
  const friendsRef=useRef([]);
  useEffect(()=>{friendsRef.current=friends},[friends]);
  const selfAvatarText=avatarLabel(ownProfile.name?.trim()||"我",user?.public_key);
  // Native Tox status: 0 available, 1 away, 2 busy. When the Tox network
  // connection is down, show a neutral offline dot instead of false green.
  const ownStatus=ownProfile.user_status;
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
  // Use the reference messenger palette for all surfaces, not just AntD popups.
  // The CSS custom properties drive rail, sidebar, chat, composer and bubbles.
  const uiColors=effectiveTheme==="dark"?{
    bg:"#1e1e1f",rail:"#232424",sidebar:"#2f2f30",chat:"#1e1e1f",
    search:"#3a3a3b",hover:"#3b3b3d",border:"#373739",
    text:"#f3f3f3",muted:"#9b9b9f",primary:"#16ac71",
    selected:"#294b3e",own:"#35d18c",incoming:"#303032",
    ownText:"#09291d",incomingText:"#f3f3f3"
  }:{
    bg:"#f5f5f5",rail:"#e6e8ea",sidebar:"#eeeef0",chat:"#f5f5f5",
    search:"#ffffff",hover:"#e3e3e5",border:"#e3e3e5",
    text:"#222326",muted:"#96969c",primary:"#16ac71",
    selected:"#dcece4",own:"#9df29f",incoming:"#eeeeef",
    ownText:"#182d1e",incomingText:"#222326"
  };
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
  const [modal,setModal]=useState("");
  const [loginFile,setLoginFile]=useState(null),[busy,setBusy]=useState(false);
  const [authMode,setAuthMode]=useState("create");
  const [createPassword,setCreatePassword]=useState("");
  const [loginPassword,setLoginPassword]=useState("");
  const [backupPassword,setBackupPassword]=useState("");
  const [friendId,setFriendId]=useState("");
  const [requestText,setRequestText]=useState("你好，我想添加你为 Tox 好友");
  const [historyFile,setHistoryFile]=useState(null);
  const [uploadFile,setUploadFile]=useState(null),[transfers,setTransfers]=useState([]);
  const [pendingFiles,setPendingFiles]=useState([]);
  const [imageCacheRevision,setImageCacheRevision]=useState(0);
  const history=useRef(null),socket=useRef(null),selectedRef=useRef(null),sendBusy=useRef(false);
  const drafts=useRef(new Map()),lastMessage=useRef(0);
  // Persist a random color for each self identity before the first visible
  // frame; returning to an identity reuses its saved color.
  useLayoutEffect(()=>{
    if(!user?.public_key){setAvatarColors({});return}
    const keys=[user.public_key,...friends.map(f=>f.public_key)];
    setAvatarColors(ensureAvatarColors(user.public_key,keys,
      typeof localStorage!=="undefined"?localStorage:null));
  },[user?.public_key,friends]);
  const avatarColor=useCallback(key=>avatarColors[key]||avatarFallbackColor(key),[avatarColors]);
  const longPressTimer=useRef(null);
  const suppressSelectionClick=useRef(false);
  const cancelLongPress=()=>{if(longPressTimer.current)clearTimeout(longPressTimer.current);longPressTimer.current=null};
  const clearSelection=()=>{cancelLongPress();setSelectedMessageIds(new Set())};
  function toggleMessageSelection(id){
    setSelectedMessageIds(previous=>{
      const next=new Set(previous);
      if(next.has(id))next.delete(id);else next.add(id);
      return next;
    });
  }
  function startLongPress(item,event){
    cancelLongPress();
    if(!item?.id||deletingMessages||!history.current?.ready()||
       (event?.pointerType==="mouse"&&event.button!==0)||
       event?.target?.closest?.("button,a,input,textarea,[role=button]"))return;
    longPressTimer.current=setTimeout(()=>{
      suppressSelectionClick.current=true;
      setSelectedMessageIds(previous=>new Set([...previous,item.id]));
      longPressTimer.current=null;
    },650);
  }
  function messageSelectionClick(event,id){
    if(suppressSelectionClick.current){
      suppressSelectionClick.current=false;event.preventDefault();event.stopPropagation();return;
    }
    if(selectedMessageIds.size){
      event.preventDefault();event.stopPropagation();
      toggleMessageSelection(id);
    }
  }
  async function copyMessage(item){
    const text=item.type==="file" ? item.file_name||item.name||"文件" : String(item.text||"");
    if(!text){alert("没有可复制的消息内容");return}
    try{
      await navigator.clipboard.writeText(text);
      alert(item.type==="file"?"已复制文件名":"已复制消息","success");
    }catch{alert("复制失败，请检查浏览器剪贴板权限","error")}
  }
  const messageMenu=item=>({
    items:[
      {key:"copy",label:item.type==="file"?"复制文件名":"复制",icon:<CopyOutlined/>},
      {type:"divider"},
      {key:"delete",label:"删除",icon:<DeleteOutlined/>,danger:true,
        disabled:!historyReady||deletingMessages},
      {key:"multi",label:"多选",icon:<CheckSquareOutlined/>,
        disabled:!historyReady||deletingMessages}
    ],
    onClick:({key,domEvent})=>{
      domEvent?.stopPropagation();
      if(key==="copy")void copyMessage(item);
      if(key==="delete")setSingleDeleteId(item.id);
      if(key==="multi")setSelectedMessageIds(previous=>new Set([...previous,item.id]));
    }
  });
  async function deleteSingleMessage(){
    if(!singleDeleteId||deletingMessages||!history.current?.ready())return;
    const h=history.current;
    const item=messages.find(record=>record.id===singleDeleteId);
    if(!item){setSingleDeleteId(null);return}
    setDeletingMessages(true);
    try{
      await h.deleteEvent(item.id);
      if(item.type==="file"&&item.file_id)await h.deleteCachedImage(item.file_id);
      await refreshHistory(h);
      setSelectedMessageIds(previous=>{
        const next=new Set(previous);next.delete(item.id);return next;
      });
      setSingleDeleteId(null);
      alert("已删除当前浏览器中的记录","success");
    }catch(error){await refreshHistory(h).catch(()=>{});alert("删除失败："+error.message,"error")}
    finally{setDeletingMessages(false)}
  }
  async function requestDelete(){
    const h=history.current;
    if(!h?.ready()||!selectedMessageIds.size||deletingMessages)return;
    setDeletingMessages(true);
    try{
      const records=messages.filter(item=>selectedMessageIds.has(item.id));
      for(const item of records){
        await h.deleteEvent(item.id);
        if(item.type==="file"&&item.file_id)await h.deleteCachedImage(item.file_id);
      }
      await refreshHistory(h);
      setSelectedMessageIds(new Set());
      alert("已从当前浏览器删除 "+records.length+" 条聊天记录");
    }catch(e){await refreshHistory(h).catch(()=>{});alert("批量删除失败："+e.message)}
    finally{setDeletingMessages(false)}
  }
  const notifyIncoming=useCallback((event,recovered=false)=>{
    // Installed PWAs use only service-worker Web Push; avoid double alerts.
    if(isStandalone())return;
    if(!notificationsEnabledRef.current||typeof Notification==="undefined"||
       Notification.permission!=="granted")return;
    const isViewing=document.visibilityState==="visible"&&document.hasFocus?.()&&
      selectedRef.current===event.public_key;
    if(!shouldNotifyMessage(event,{recovered,isViewing}))return;
    const id=messageNotificationId(event);
    if(notifiedMessageIds.current.has(id))return;
    notifiedMessageIds.current.add(id);
    if(notifiedMessageIds.current.size>300){
      notifiedMessageIds.current.delete(notifiedMessageIds.current.values().next().value);
    }
    const peer=friendsRef.current.find(friend=>friend.public_key===event.public_key);
    try{
      const notification=new Notification("wTox · 新消息",{
        body:(peer?.name||"Tox 好友")+" 发来一条新消息",
        tag:"wtox-message-"+event.public_key,
        icon:LOGO_URL
      });
      notification.onclick=()=>{
        window.focus();
        selectedRef.current=event.public_key;
        setSection("chats");setSelected(event.public_key);setMobileChat(true);
        notification.close();
      };
    }catch{
      // Some mobile browsers grant permission but do not expose Notification
      // construction without a service worker. Do not crash message syncing.
    }
  },[]);
  async function toggleBrowserNotifications(){
    if(isStandalone())return;
    uiMessageApi.destroy("notification-permission-invite");
    if(notificationsEnabled){
      notificationsEnabledRef.current=false;
      setNotificationsEnabled(false);
      try{localStorage.setItem("wtox-browser-notifications","0")}catch{}
      return;
    }
    if(typeof Notification==="undefined"||!window.isSecureContext){
      setNotificationPermission("unsupported");
      alert("当前浏览器或访问方式不支持系统通知，请使用 HTTPS 环境中的兼容浏览器");
      return;
    }
    try{
      // requestPermission() is called directly inside the user click handler.
      const permission=await Notification.requestPermission();
      setNotificationPermission(permission);
      if(permission!=="granted"){
        alert(permission==="denied"?"通知已被浏览器拒绝，请到浏览器网站权限中开启":"尚未获得通知权限");
        return;
      }
      notificationsEnabledRef.current=true;
      setNotificationsEnabled(true);
      try{localStorage.setItem("wtox-browser-notifications","1")}catch{}
    }catch(error){alert("无法启用浏览器通知："+error.message)}
  }
  const closeModal=useCallback(()=>setModal(""),[]);
  const alert=useCallback((text,type)=>{
    const content=String(text||"");
    const level=type||(/失败|错误|无效|拒绝|不可|无法|超出|超过|未就绪/.test(content)?"error":
      /成功|已保存|已接受|已删除|已导入|已完成|已加入/.test(content)?"success":"info");
    uiMessageApi.open({type:level,content,duration:4});
  },[uiMessageApi]);

  useEffect(()=>{
    // Browsers require a user gesture to show the native permission dialog.
    if(isStandalone() || !user?.public_key || notificationPromptShown.current ||
       notificationPermission!=="default" || !window.isSecureContext ||
       typeof Notification==="undefined")return;
    notificationPromptShown.current=true;
    uiMessageApi.open({
      key:"notification-permission-invite",type:"info",duration:0,
      className:"wt-permission-invite",
      content:<span className="wt-permission-message">
        <span>开启浏览器新消息通知？</span>
        <AntButton type="link" size="small" onClick={toggleBrowserNotifications}>开启</AntButton>
        <AntButton type="text" size="small" onClick={()=>
          uiMessageApi.destroy("notification-permission-invite")}>稍后</AntButton>
      </span>
    });
  },[user?.public_key,notificationPermission,uiMessageApi]);

  const refreshFriends=useCallback(async()=>{
    setFriends((await getJson("/api/friends")).friends||[]);
  },[]);
  const refreshFriendRequests=useCallback(async()=>{
    const data=await getJson("/api/friend-requests");
    setFriendRequests(data.requests||[]);
  },[]);
  useEffect(()=>{
    if(!user?.public_key||!friendRequests.length){
      friendMessageApi.destroy("friend-request-notice");
      friendNotificationApi.destroy("friend-request-notice");
      dismissedFriendIds.current=null;
      return;
    }
    const signature=user.public_key+":"+friendRequests.map(item=>item.id).sort().join(",");
    if(dismissedFriendIds.current===signature)return;
    const view=()=>{
      dismissedFriendIds.current=signature;
      friendNotificationApi.destroy("friend-request-notice");
      friendMessageApi.destroy("friend-request-notice");
      setModal("requests");
    };
    if(window.matchMedia("(min-width:768px)").matches){
      friendNotificationApi.open({
        key:"friend-request-notice",message:"好友请求",
        description:`你有 ${friendRequests.length} 条待处理的好友请求。`,
        duration:0,placement:"topRight",
        btn:<AntButton type="primary" size="small" onClick={view}>查看</AntButton>,
        onClose:()=>{dismissedFriendIds.current=signature;}
      });
    }else{
      friendMessageApi.open({
        key:"friend-request-notice",type:"info",duration:0,
        className:"wt-friend-request-message",
        content:<span className="wt-request-message-content">
          <span>收到 {friendRequests.length} 条好友请求</span>
          <AntButton type="link" size="small" onClick={view}>查看</AntButton>
          <AntButton type="text" size="small" aria-label="关闭好友请求提示"
            onClick={()=>{dismissedFriendIds.current=signature;
              friendMessageApi.destroy("friend-request-notice")}}>关闭</AntButton>
        </span>
      });
    }
  },[user?.public_key,friendRequests,friendMessageApi,friendNotificationApi]);
  const refreshNetwork=useCallback(async()=>{
    const data=await getJson("/api/network");
    setNetwork(data.status??-1);
    setNetworkDiagnostics(data);
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
  // Legacy-only migration for old, browser-owned messages. New messages are
  // always encrypted into the server outbox by POST /api/messages.
  // Run this once when the local identity history unlocks, not in timers.
  const migrateLegacyBrowserQueue=useCallback(async(h=history.current)=>{
    if(!h?.ready())return;
    try{
      const pending=(await h.read()).filter(item=>item.type==="message" &&
        item.direction==="outgoing" && item.delivery_status==="queued_local");
      if(!pending.length)return; // Most accounts never need this migration.
      let blocked=0;
      for(const item of pending){
        if(history.current!==h)break;
        // An interrupted request may have been submitted already; mark it
        // uncertain rather than silently retrying and duplicating Tox messages.
        await h.patchEvent(item.id,{delivery_status:"dispatching_local"});
        try{
          const result=await postJson("/api/messages",{
            public_key:item.public_key,text:item.text,client_id:item.id
          });
          await h.patchEvent(item.id,{
            delivery_status:["queued","sent","failed","uncertain"].includes(result.status)
              ?result.status:"uncertain",
            outbox_id:result.id||item.id,
            session_id:result.session_id,
            message_id:result.message_id
          });
        }catch(error){
          const definiteRejection=error.status>=400 && error.status<500;
          await h.patchEvent(item.id,{
            delivery_status:definiteRejection?"queued_local":"uncertain",
            delivery_error:error.message
          });
          blocked++;
        }
      }
      if(history.current===h){
        await refreshHistory(h);
        if(blocked)alert(`有 ${blocked} 条旧版待发消息未能迁移，请检查好友关系；不会自动重复发送`,"warning");
      }
    }catch(error){
      if(history.current===h)alert("旧版本地待发消息迁移失败："+error.message,"error");
    }
  },[alert,refreshHistory]);
  const recoverPending=useCallback(async(h=history.current)=>{
    if(!h?.ready())return;
    const data=await getJson("/api/pending");
    // Match durable send IDs before applying delayed Tox receipt callbacks.
    // This matters when the server sends and receives a receipt while the
    // browser is closed: the local queued message has no native ID yet.
    await refreshOutbox(h);
    for(const row of data.pending||[]){
      const e={...row.event,id:row.id,created:row.created};
      try{
        if(e.type==="message_receipt"){
          if(await h.deliverReceipt(e))await postJson("/api/ack",{ids:[row.id]});
        }else if(e.type==="message"){
          await h.persist(e);
          await postJson("/api/ack",{ids:[row.id]});
          notifyIncoming(e,true);
        }else if(e.type==="friend_request"){
          // Friend requests remain encrypted in the server inbox
          // until accepted/rejected or their seven-day expiry.
          await refreshFriendRequests();
        }
      }catch(error){alert("消息暂存处理失败："+error.message);break}
    }
    await refreshHistory(h);
  },[alert,refreshHistory,refreshOutbox,refreshFriendRequests,notifyIncoming]);

  const onRealtime=useCallback(async e=>{
    const h=history.current;
    if(["message","friend_request"].includes(e.type)){
      if(e.type==="friend_request"){
        refreshFriendRequests().catch(()=>{});
      }
      if(h?.ready()){
        try{
          await h.persist(e);
          if(e.id)await postJson("/api/ack",{ids:[e.id]});
          await refreshHistory(h);
          notifyIncoming(e);
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
    }else if(e.type==="friend_profile"){
      // Native name, status-message and away/busy callbacks are immediate.
      refreshFriends().catch(()=>{});
    }else if(["connection","friend_connection"].includes(e.type)){
      refreshNetwork().catch(()=>{});refreshFriends().catch(()=>{});
    }
  },[alert,refreshHistory,refreshFriends,refreshNetwork,refreshTransfers,refreshFriendRequests,notifyIncoming]);

  const loadIdentity=useCallback(async()=>{
    setLoading(true);setBootstrapError("");
    try{
      const info=await getJson("/api/me",{signal:AbortSignal.timeout(12000)});
      setUser(info);
    }catch(error){
      if(error.status===401){setUser(null);return}
      setBootstrapError(error.name==="TimeoutError"
        ?"连接超时，请检查网络后重试。"
        :"无法连接服务："+error.message);
    }finally{setLoading(false)}
  },[]);
  useEffect(()=>{loadIdentity()},[loadIdentity]);

  // React reuses the existing wtox-local-<public-key> IndexedDB database and
  // the same non-extractable AES-GCM key; no history migration is necessary.
  useEffect(()=>{
    if(!user?.public_key)return;
    let initial={};
    try{
      const saved=JSON.parse(localStorage.getItem("wtox-seen-"+user.public_key)||"{}");
      if(saved && typeof saved==="object" && !Array.isArray(saved)) initial=saved;
    }catch{}
    // Avoid overwriting persisted read positions with the previous identity's
    // state before the newly loaded values have reached React state.
    seenHydration.current={owner:user.public_key,initial,ready:false};
    setSeen(initial);
  },[user?.public_key]);
  useEffect(()=>{
    if(!user?.public_key)return;
    const hydrated=seenHydration.current;
    if(!hydrated || hydrated.owner!==user.public_key)return;
    if(!hydrated.ready){
      if(seen!==hydrated.initial)return;
      hydrated.ready=true;
    }
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
          // Native Toxcore could receive attachments while this browser was
          // closed. Completed encrypted files are listed by the service.
          await refreshTransfers();
          await migrateLegacyBrowserQueue(h);
        }
      }catch(error){if(!dead)alert("无法打开本地加密历史："+error.message)}
    })();
    return()=>{dead=true;history.current?.close();history.current=null};
  },[user?.public_key,recoverPending,refreshTransfers,migrateLegacyBrowserQueue,alert]);

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
    let dead=false,ws=null,retry=null,connectedOnce=false;
    const toastKey="wtox-server-connection";
    const connecting=()=>{
      if(dead)return;
      uiMessageApi.open({
        key:toastKey,type:"loading",duration:0,
        content:connectedOnce?"连接中断，正在重新连接…":"正在连接服务器…"
      });
    };
    const connect=()=>{
      if(dead)return;
      connecting();
      ws=new WebSocket((location.protocol==="https:"?"wss:":"ws:")+"//"+location.host+"/ws");
      socket.current=ws;
      lastMessage.current=Date.now();
      ws.onopen=()=>{
        connectedOnce=true;
        uiMessageApi.destroy(toastKey);
        lastMessage.current=Date.now();
        Promise.allSettled([refreshFriends(),refreshNetwork(),recoverPending(),
          refreshTransfers()]);
      };
      ws.onmessage=msg=>{
        lastMessage.current=Date.now();
        try{onRealtime(JSON.parse(msg.data))}catch(error){alert("无法解析实时事件："+error.message)}
      };
      ws.onclose=()=>{
        if(!dead){
          connecting();
          retry=setTimeout(connect,3500);
        }
      };
    };
    connect();
    const friendTimer=setInterval(()=>{
      if(!dead){refreshFriends().catch(()=>{});refreshNetwork().catch(()=>{})}
    },12000);
    const pendingTimer=setInterval(()=>{
      if(!dead)recoverPending().catch(()=>{});
    },8000);
    // Recover missed file events after disconnects, even without text events.
    const transferTimer=setInterval(()=>{
      if(!dead)refreshTransfers().catch(()=>{});
    },30000);
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
        Promise.allSettled([refreshFriends(),refreshNetwork(),recoverPending(),refreshTransfers()]);
      }
    };
    document.addEventListener("visibilitychange",wake);
    window.addEventListener("focus",wake);
    return()=>{
      dead=true;uiMessageApi.destroy(toastKey);
      clearTimeout(retry);clearInterval(friendTimer);
      clearInterval(pendingTimer);clearInterval(transferTimer);clearInterval(pingTimer);
      document.removeEventListener("visibilitychange",wake);
      window.removeEventListener("focus",wake);
      if(ws){ws.onclose=null;ws.close()}
      socket.current=null;
    };
  },[user?.public_key,onRealtime,recoverPending,refreshFriends,
    refreshNetwork,refreshTransfers,alert,uiMessageApi]);

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
              <div className="wt-peer-profile-heading">
                <Typography.Text className="wt-peer-profile-eyebrow" type="secondary">
                  好友昵称
                </Typography.Text>
                <div className="wt-peer-profile-heading-main">
                  <Typography.Title level={5} className="wt-peer-profile-name">
                    {selectedFriend.name||"Tox 好友"}
                  </Typography.Title>
                  <span className="wt-peer-profile-presence">
                    <Badge status={peerStatusColor} text={peerStatus}/>
                  </span>
                </div>
              </div>
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
  const thread=useMemo(()=>[...messages,...pendingFiles]
    .filter(e=>e.public_key===selected&&["message","file"].includes(e.type))
    .sort((a,b)=>a.at-b.at).slice(-250),[selected,messages,pendingFiles]);
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
    (f.name||"").toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()))
    .sort((a,b)=>{
      if(section==="contacts")return (a.name||a.public_key).localeCompare(b.name||b.public_key,"zh-CN");
      const left=latestByPeer.get(a.public_key)?.at||0;
      const right=latestByPeer.get(b.public_key)?.at||0;
      return right-left || Number(online(b))-Number(online(a));
    }),[friends,filter,latestByPeer,section]);
  const unreadByPeer=useMemo(()=>unreadCountsByPeer(messages,seen),[messages,seen]);
  const unreadFor=useCallback(peer=>unreadByPeer.get(peer)||0,[unreadByPeer]);
  const totalUnread=useMemo(()=>totalUnreadForFriends(unreadByPeer,friends),
    [unreadByPeer,friends]);
  const chatNavLabel=totalUnread>0?`聊天，${totalUnread} 条未读消息`:"聊天";

  // The extra in-app History entry allows native iOS back-swipe and the
  // physical/software back button to return to the conversation list.
  // Returning to the conversation list must clear selection so no friend
  // retains the desktop-style highlighted card on iOS/Android.
  function clearMobileConversation(){
    selectedRef.current=null;
    setSelected(null);
    setMobileChat(false);
    setPeerDetailsOpen(false);
    clearSelection();
  }
  function returnFromMobileChat(){
    if(window.history.state?.wtoxChat)window.history.back();
    else clearMobileConversation();
  }
  useEffect(()=>{
    const onPop=()=>{
      if(!window.matchMedia("(max-width:767px)").matches)return;
      selectedRef.current=null;
      setSelected(null);
      setMobileChat(false);
      setPeerDetailsOpen(false);
      clearSelection();
    };
    window.addEventListener("popstate",onPop);
    return()=>window.removeEventListener("popstate",onPop);
  },[]);
  function onChatTouchStart(event){
    if(!isMobile||!mobileChat||!isStandalone()||
       !/iPhone|iPad|iPod/.test(navigator.userAgent))return;
    const touch=event.touches?.[0];
    swipeStart.current=touch&&touch.clientX<32
      ?{x:touch.clientX,y:touch.clientY}:null;
  }
  function onChatTouchEnd(event){
    const origin=swipeStart.current;
    swipeStart.current=null;
    const touch=event.changedTouches?.[0];
    if(origin&&touch&&touch.clientX-origin.x>90 &&
       Math.abs(touch.clientY-origin.y)<70)returnFromMobileChat();
  }
  function selectFriend(key){
    if(selectedRef.current)drafts.current.set(selectedRef.current,draft);
    selectedRef.current=key;setSelected(key);
    clearSelection();
    setPeerDetailsOpen(false);setDeleteFriendOpen(false);
    setDraft(drafts.current.get(key)||"");
    if(isMobile&&!mobileChat&&!(window.history.state?.wtoxChat)){
      window.history.pushState({...window.history.state,wtoxChat:true},"",window.location.href);
    }
    setMobileChat(true);
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
    if(!createPassword){alert("请输入密码");return}
    setBusy(true);
    try{
      const response=await api("/api/tox/create",{method:"POST",
        body:JSON.stringify({password:createPassword})});
      const result=await downloadToxFile(await response.blob(),
        "wtox-"+(response.headers.get("X-Tox-ID")||"new").slice(0,16)+".tox");
      setCreatePassword("");
      alert(result==="cancelled"
        ? "身份创建成功，但已取消保存备份。请进入设置重新导出加密的 .tox 文件。"
        : "身份创建成功！请确认已将 .tox 备份存入手机“文件”或安全位置，并保管密码。",
        result==="cancelled"?"warning":"success");
      await loadIdentity();
    }catch(error){alert(error.message)}finally{setBusy(false)}
  }
  async function loginIdentity(){
    if(!loginFile){alert("请选择 .tox 配置文件");return}
    if(loginFile.size>8*1024*1024+80){alert("Tox 配置超过大小限制");return}
    setBusy(true);
    try{
      const magic=new TextDecoder().decode(await loginFile.slice(0,8).arrayBuffer());
      const encrypted=magic==="toxEsave";
      if(encrypted&&!loginPassword)throw Error("这是加密的 .tox 文件，请输入密码");
      const secret=encrypted?new TextEncoder().encode(loginPassword):new Uint8Array();
      const upload=secret.length?new Blob([secret,loginFile]):loginFile;
      await api("/api/tox/login",{method:"POST",raw:true,
        headers:{"Content-Type":"application/octet-stream",
          "X-Tox-Password-Bytes":String(secret.length)},body:upload});
      setLoginPassword("");
      await loadIdentity();
    }catch(error){alert(error.message)}finally{setBusy(false)}
  }
  async function logout(clearLocalData=false){
    if(logoutBusy)return;
    setLogoutBusy(true);
    const owner=user?.public_key;
    let pushError=null;
    try{
      try{await disablePushBeforeLogout()}
      catch(error){pushError=error}
      // Both choices permanently remove the server-side private key, friends,
      // outbox messages, files and device push subscriptions. Only local
      // browser history differs between the two choices.
      await api("/api/profile",{
        method:"DELETE",
        headers:{"X-WTox-Delete":"delete-current-identity"}
      });
      // Close this identity's IndexedDB before issuing deleteDatabase().
      history.current?.close();history.current=null;
      let cleanupError=null;
      if(clearLocalData){
        try{await clearIdentityBrowserData(owner)}
        catch(error){cleanupError=error}
      }
      drafts.current.clear();setUser(null);setMessages([]);setPendingFiles([]);setFriends([]);
      setSelected(null);selectedRef.current=null;setModal("");
      setLogoutOpen(false);setHistoryReady(false);
      setSeen({});setAvatarColors({});
      if(cleanupError)alert("已退出，但部分浏览器数据未删除："+cleanupError.message,"warning");
      else if(pushError)alert("已退出，但离线推送可能仍在该设备上启用。请检查通知权限。","warning");
    }catch(error){
      alert("退出失败："+error.message,"error");
    }finally{setLogoutBusy(false)}
  }
  async function sendText(innerHtml,textContent,innerText){
    if(sendBusy.current||!selectedRef.current)return;
    const peer=selectedRef.current;
    const text=String(innerText||textContent||innerHtml||"").replace(/<[^>]+>/g,"").trim();
    if(!text)return;
    const h=history.current;
    if(!h?.ready()){setModal("settings");alert("请先完成旧聊天历史迁移");return}
    const client_id=crypto.randomUUID().replaceAll("-","");
    const optimistic={
      id:client_id,type:"message",direction:"outgoing",public_key:peer,
      text,at:Date.now(),outbox_id:client_id,delivery_status:"queued_local"
    };
    sendBusy.current=true;setSending(true);
    drafts.current.set(peer,"");
    if(selectedRef.current===peer)setDraft("");
    // Render immediately: neither HTTPS latency nor IndexedDB encryption
    // should delay the outgoing message bubble.
    setMessages(previous=>[...previous,optimistic]);
    try{
      // Always store the client ID before submitting, so an ambiguous network
      // failure cannot silently duplicate an already-accepted server message.
      await h.persist(optimistic);
    }catch(error){
      setMessages(previous=>previous.filter(item=>item.id!==client_id));
      drafts.current.set(peer,text);
      if(selectedRef.current===peer)setDraft(text);
      sendBusy.current=false;setSending(false);
      alert("无法保存本地加密消息："+error.message);return;
    }
    try{
      // The native worker sends asynchronously from the encrypted VPS outbox.
      const res=await postJson("/api/messages",{public_key:peer,text,client_id});
      await h.patchEvent(client_id,{
        outbox_id:res.id||client_id,
        session_id:res.session_id,message_id:res.message_id,
        delivery_status:res.status==="sent"?"sent":"queued"
      });
      await refreshHistory(h);
      recoverPending(h).catch(error=>console.warn("消息状态同步失败",error));
    }catch(error){
      // Network errors may occur AFTER the server accepted the request:
      // retain the same client ID and do not auto-retry or ask for a resend.
      const definitive=error.status>=400&&error.status<500;
      const state=definitive?"failed":"uncertain";
      try{
        await h.patchEvent(client_id,{delivery_status:state,delivery_error:error.message});
        await refreshHistory(h);
      }catch{setMessages(previous=>previous.map(item=>item.id===client_id
        ? {...item,delivery_status:state}:item))}
      if(definitive)alert("消息发送失败："+error.message);
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
    if(!selected||removingFriend)return;
    const publicKey=selected;
    setRemovingFriend(true);
    try{
      await api("/api/friends/"+encodeURIComponent(publicKey),{method:"DELETE"});
      setDeleteFriendOpen(false);
      if(selectedRef.current===publicKey){
        setSelected(null);selectedRef.current=null;setMobileChat(false);clearSelection();
      }
      await refreshFriends();
      alert("已删除好友，本地聊天记录仍然保留");
    }catch(error){alert("删除好友失败："+error.message)}
    finally{setRemovingFriend(false)}
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
    const peer=selectedRef.current;
    if(!peer||!online(friends.find(friend=>friend.public_key===peer))){
      alert("附件要求双方在线");return;
    }
    if(!file||file.size<1||file.size>5*1024*1024){
      alert("附件大小需为 1 字节至 5 MiB");return;
    }
    if(busy)return;
    const localId="pending-file-"+crypto.randomUUID();
    const optimistic={
      id:localId,type:"file",direction:"outgoing",public_key:peer,
      file_id:null,file_name:file.name,file_size:file.size,file_progress:0,
      file_state:"uploading",at:Date.now(),previewBlob:file
    };
    setPendingFiles(previous=>[...previous,optimistic]);
    setUploadFile(null);
    // File size can take seconds to upload: show bubble before the request.
    setBusy(true);
    let transfer;
    try{
      const url="/api/files/send?peer="+encodeURIComponent(peer)+
        "&name="+encodeURIComponent(file.name);
      const response=await api(url,{
        method:"POST",raw:true,
        headers:{"Content-Type":"application/octet-stream"},
        body:file
      });
      transfer=await response.json();
    }catch(error){
      setPendingFiles(previous=>previous.map(entry=>entry.id===localId
        ? {...entry,file_state:"failed"}:entry));
      alert("提交附件失败："+error.message);
      setBusy(false);return;
    }
    // The native API already accepted the send. Never imply retry just
    // because local encrypted history/caching fails after acceptance.
    if(attachmentInput.current)attachmentInput.current.value="";
    const h=history.current;
    let stored=false;
    try{
      if(!h?.ready())throw new Error("本地加密历史尚未就绪");
      await h.persistFile(transfer);
      if(/\.(png|jpe?g|webp|gif)$/i.test(file.name)){
        const mime=file.type.startsWith("image/")?file.type:
          /\.png$/i.test(file.name)?"image/png":
          /\.webp$/i.test(file.name)?"image/webp":
          /\.gif$/i.test(file.name)?"image/gif":"image/jpeg";
        const blob=new Blob([file],{type:mime});
        if(await decodedImage(blob)){
          await h.cacheImage(transfer.id,blob);
          setImageCacheRevision(n=>n+1);
        }
      }
      await refreshHistory(h);
      stored=true;
    }catch(error){
      alert("附件已被 Toxcore 接受，但本地记录或图片缓存失败："+error.message);
    }
    if(stored){
      setPendingFiles(previous=>previous.filter(entry=>entry.id!==localId));
    }else{
      // Keep the user-visible bubble instead of silently losing an accepted
      // attachment; do not recommend resending to avoid duplicate files.
      setPendingFiles(previous=>previous.map(entry=>entry.id===localId
        ? {...entry,file_state:"uncertain"}:entry));
    }
    try{await refreshTransfers()}catch(error){
      console.warn("附件列表同步失败",error);
    }
    setBusy(false);
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

  // Shared Ant Design settings: mobile full page and desktop side drawer.
  const settingsContent=<div className="wt-settings-content">
    <Card size="small" title="连接与消息队列" className="wt-settings-card wt-settings-network-card"
      extra={<Badge status={network>0?"success":network===0?"default":"processing"}
        text={network>0?"已连接":network===0?"未连接":"检查中"}/>}>
      <Space orientation="vertical" size="small" style={{width:"100%"}}>
        <Typography.Text className="wt-network-status">
          <span className={"wt-network-indicator "+(network>0?"connected":"disconnected")} aria-hidden="true"/>
          Tox 网络：{network===2?"UDP 已连接":network===1?"TCP 已连接":
            network===0?"未连接（暂时无法接收消息）":"正在启动或检查"}
        </Typography.Text>
        <Typography.Text type="secondary" className="wt-network-diagnostics">
          在线好友：{networkDiagnostics?.online_friends??"-"}/
          {networkDiagnostics?.total_friends??"-"} · 
          待发送：{networkDiagnostics?.queued??"-"} ·
          正在发送：{networkDiagnostics?.dispatching??"-"}
        </Typography.Text>
        {!!networkDiagnostics?.uncertain&&
          <Typography.Text type="warning">
            有 {networkDiagnostics.uncertain} 条消息发送结果待确认，请避免重复发送
          </Typography.Text>}
        <Typography.Paragraph type="secondary" style={{marginBottom:0}}>
          关闭浏览器不影响后台的 Tox 连接。好友离线时，文字会进入加密待发队列；
          好友上线并恢复连接后自动尝试发送。
        </Typography.Paragraph>
        <AntButton onClick={()=>refreshNetwork().catch(error=>alert(error.message))}>
          刷新网络状态
        </AntButton>
      </Space>
    </Card>
    <Card size="small" title="外观" className="wt-settings-card">
      <Segmented block value={visualStyle} onChange={setVisualStyle}
        options={[{label:"跟随系统",value:"system"},{label:"浅色",value:"light"},
          {label:"深色",value:"dark"}]}/>
    </Card>
    {!installedPwa&&<Card size="small" title="新消息通知" className="wt-settings-card"
      extra={<Badge
        status={notificationPermission==="denied"?"error":
          notificationsEnabled&&notificationPermission==="granted"?"success":"default"}
        text={notificationPermission==="unsupported"?"不支持":
          notificationPermission==="denied"?"权限受限":
          notificationsEnabled&&notificationPermission==="granted"?"已启用":"未启用"}/>}>
      <Typography.Paragraph type="secondary">
        授权后，新消息可显示浏览器系统通知。需要 HTTPS 和浏览器支持；
        网页需保持打开，关闭网页后无法接收此类通知。
      </Typography.Paragraph>
      <Space wrap>
        <AntButton onClick={toggleBrowserNotifications}
          disabled={notificationPermission==="unsupported"||notificationPermission==="denied"&&!notificationsEnabled}
          type={notificationsEnabled&&notificationPermission==="granted"?"default":"primary"}>
          {notificationsEnabled&&notificationPermission==="granted"?"关闭新消息通知":"开启新消息通知"}
        </AntButton>
      </Space>
    </Card>}
    <PushSettings userId={user?.public_key}/>
    <Card size="small" title="Tox 身份备份" className="wt-settings-card">
      <Typography.Paragraph type="secondary">
        .tox 文件包含身份私钥，请妥善保管，切勿分享。
      </Typography.Paragraph>
      <Typography.Text type="secondary">新备份的加密密码</Typography.Text>
      <Input.Password autoComplete="new-password" value={backupPassword}
        placeholder="为这份 .tox 备份设置密码" aria-label="新备份的加密密码"
        onChange={e=>setBackupPassword(e.target.value)}/>
      <Typography.Paragraph type="secondary" className="wt-settings-footnote">
        此处设置的是本次导出文件的新密码，并非验证创建身份时的旧密码。
        已登录的身份可以重新加密导出；请妥善保护登录设备。
      </Typography.Paragraph>
      <AntButton block onClick={async()=>{
        if(!backupPassword){alert("请设置这份备份的新密码");return}
        try{
          const response=await api("/api/profile/export/encrypted",{
            method:"POST",body:JSON.stringify({password:backupPassword})});
          const result=await downloadToxFile(await response.blob(),"wTox-profile.tox");
          if(result!=="cancelled")setBackupPassword("");
          else alert("已取消保存，请重新点击下载 .tox 配置。","warning");
        }catch(e){alert(e.message)}
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
    <AntButton danger block className="wt-settings-signout" onClick={()=>setLogoutOpen(true)}>退出当前身份</AntButton>
  </div>;

  if(loading)return <div className="wtox-loading" role="status" aria-label="正在加载"><span className="wtox-boot-ring" aria-hidden="true"/></div>;
  if(bootstrapError)return <div className="wtox-error-page" role="alert">
    <p>{bootstrapError}</p><AntButton type="primary" onClick={loadIdentity}>重试</AntButton>
  </div>;
  if(!user)return <ConfigProvider theme={{
    algorithm:effectiveTheme==="dark"?antdTheme.darkAlgorithm:antdTheme.defaultAlgorithm,
    token:{colorPrimary:"#16ac71",borderRadius:12}
  }}>
    {uiMessageContext}
    <main className="wtox-auth-layout" data-theme={effectiveTheme}>
      <section className="wtox-auth-card" aria-label="进入 wTox">
        <div className="wtox-auth-card-header">
          <img src={LOGO_URL} className="wtox-auth-small-mark" alt="" />
          <strong>wTox</strong>
        </div>
        <Typography.Paragraph type="secondary" className="wtox-auth-subtitle">
          创建新身份，或导入已有的 .tox 文件。
        </Typography.Paragraph>
          <Segmented block size="middle" className="wtox-auth-switch"
            value={authMode} onChange={mode=>setAuthMode(mode)}
            options={[
              {label:"创建身份",value:"create"},
              {label:"导入身份",value:"import"}
            ]}/>
          {authMode==="create"?
            <Form layout="vertical" className="wtox-auth-form" onFinish={createIdentity}>
              <Typography.Paragraph type="secondary" className="wtox-auth-step-note">
                创建后会下载加密的 .tox 文件，请保管好文件和密码。
              </Typography.Paragraph>
              <Form.Item label="密码" required>
                <Input.Password autoComplete="new-password"
                  size="large" value={createPassword}
                  onChange={e=>setCreatePassword(e.target.value)}
                  placeholder="请输入密码（不限位数）"/>
              </Form.Item>
              <AntButton htmlType="submit" type="primary" block size="large"
                loading={busy} disabled={busy||!createPassword}>
                创建身份并下载 .tox 文件
              </AntButton>
            </Form>:
            <Form layout="vertical" className="wtox-auth-form" onFinish={loginIdentity}>
              <Typography.Paragraph type="secondary" className="wtox-auth-step-note">
                选择其他 Tox 客户端导出的 .tox 文件。
              </Typography.Paragraph>
              <Form.Item label=".tox 文件" required>
                <Upload.Dragger accept=".tox,application/octet-stream"
                  maxCount={1} multiple={false} className="wtox-auth-upload"
                  beforeUpload={file=>{
                    if(file.size>8*1024*1024+80){
                      alert("配置文件不能超过 8 MiB","error");
                      return Upload.LIST_IGNORE;
                    }
                    setLoginFile(file);setLoginPassword("");
                    return false;
                  }}
                  onRemove={()=>{setLoginFile(null);setLoginPassword("")}}
                  fileList={loginFile?[{uid:"login-tox",name:loginFile.name,status:"done"}]:[]}>
                  <div className="wtox-auth-upload-symbol"><PaperClipOutlined/></div>
                  <p>点击或拖拽选择 .tox 文件</p>
                  <Typography.Text type="secondary">最大 8 MiB · 原始或加密的 Tox Savedata</Typography.Text>
                </Upload.Dragger>
              </Form.Item>
              <Form.Item label="密码" extra="未设置密码的 .tox 文件可留空">
                <Input.Password autoComplete="current-password" size="large"
                  value={loginPassword} onChange={e=>setLoginPassword(e.target.value)}
                  placeholder="密码（可选）"/>
              </Form.Item>
              <AntButton htmlType="submit" type="primary" block size="large"
                disabled={busy||!loginFile} loading={busy}>
                导入并进入聊天
              </AntButton>
            </Form>}
      </section>
    </main>
  </ConfigProvider>;

  return <ConfigProvider theme={{
    algorithm:effectiveTheme==="dark"?antdTheme.darkAlgorithm:antdTheme.defaultAlgorithm
  }}>
  {friendMessageContext}
  {friendNotificationContext}
  {uiMessageContext}
  <PwaPushWelcome userId={user?.public_key}/>
  <div className={"wtox-shell ant-messenger "+(mobileChat?"show-chat ":"")+(section==="me"?"show-me":"")}
    data-theme={effectiveTheme}
    style={{
      "--wt-bg":uiColors.bg,
      "--wt-panel":uiColors.sidebar,
      "--wt-rail":uiColors.rail,
      "--wt-sidebar":uiColors.sidebar,
      "--wt-chat":uiColors.chat,
      "--wt-search":uiColors.search,
      "--wt-hover":uiColors.hover,
      "--wt-border":uiColors.border,
      "--wt-text":uiColors.text,
      "--wt-muted":uiColors.muted,
      "--wt-primary":uiColors.primary,
      "--wt-selected":uiColors.selected,
      "--wt-own":uiColors.own,
      "--wt-incoming":uiColors.incoming,
      "--wt-own-text":uiColors.ownText,
      "--wt-incoming-text":uiColors.incomingText,
      "--wt-scroll-thumb":effectiveTheme==="dark"?"rgba(255,255,255,.16)":"rgba(55,60,65,.17)",
      "--wt-scroll-hover":effectiveTheme==="dark"?"rgba(255,255,255,.28)":"rgba(55,60,65,.28)"
    }}>
    <div className="wtox-workspace ant-workspace wechat-layout">
      <nav className="wechat-rail" aria-label="主导航">
        <AntButton type="text" className="wechat-rail-avatar" aria-label="我的 Tox 资料"
          onClick={()=>setModal("profile")}>
          <Badge dot color={ownBadgeColor} offset={[-2,35]}>
            <Avatar size={44} shape="square" gap={3} className="wechat-self-avatar"
              style={{backgroundColor:avatarColor(user.public_key)}}>
              {selfAvatarText}
            </Avatar>
          </Badge>
        </AntButton>
        <div className="wechat-rail-primary">
          <button type="button" className={"wechat-rail-button "+(section==="chats"?"is-active":"")}
            aria-label={chatNavLabel} aria-current={section==="chats"?"page":undefined}
            onClick={()=>{setSection("chats");setMobileChat(false)}}>
            <Badge count={totalUnread} overflowCount={99} size="small" className="wt-nav-chat-badge">
              <RailIcon kind="chats"/>
            </Badge>
          </button>
          <button type="button" className={"wechat-rail-button "+(section==="contacts"?"is-active":"")}
            aria-label="通讯录" aria-current={section==="contacts"?"page":undefined}
            onClick={()=>{setSection("contacts");setMobileChat(false)}}>
            <RailIcon kind="contacts"/>
          </button>
        </div>
        <div className="wechat-rail-bottom">
          <button type="button" className="wechat-rail-button"
            aria-label="设置与备份" onClick={()=>setModal("settings")}>
            <RailIcon kind="settings"/>
          </button>
        </div>
      </nav>
      <aside className="ant-contact-sidebar">
        <div className="wechat-list-head">
          <div className="wechat-mobile-heading">
            <AntButton type="text" className="wechat-mobile-avatar" aria-label="我的 Tox 资料"
              onClick={()=>setModal("profile")}>
              <Badge dot color={ownBadgeColor} offset={[-3,35]}>
                <Avatar size={40} shape="square" gap={3}
                  style={{backgroundColor:avatarColor(user.public_key)}}>
                  {selfAvatarText}
                </Avatar>
              </Badge>
            </AntButton>
            <strong>{section==="contacts"?"通讯录":"聊天"}</strong>
          </div>
          <h2 className="wechat-desktop-heading">{section==="contacts"?"通讯录":"聊天"}</h2>
          <div className="wt-list-actions" role="group" aria-label="好友操作">
            <Badge count={friendRequests.length} size="small" color="#ef4444" title="">
              <AntButton type="text" icon={<UserAddOutlined/>} aria-label="好友请求"
                onClick={()=>setModal("requests")}/>
            </Badge>
            <AntButton type="text" icon={<PlusOutlined/>} aria-label="添加好友"
              onClick={()=>setModal("add")}/>
          </div>
        </div>
        <div className="wechat-search">
          <Input allowClear value={filter} placeholder="搜索"
            prefix={<span className="wechat-search-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="18" height="18"
                fill="none" stroke="currentColor" strokeWidth="2"
                strokeLinecap="round" strokeLinejoin="round">
                <circle cx="10.8" cy="10.8" r="6.7"/>
                <path d="m16 16 4.3 4.3"/>
              </svg>
            </span>}
            aria-label="搜索联系人" onChange={e=>setFilter(e.target.value)}/>
        </div>
        <div className="wechat-list">
          {visibleFriends.map(friend=>{
            const recent=latestByPeer.get(friend.public_key);
            const draftsText=drafts.current.get(friend.public_key)||"";
            const friendStatusMessage=friend.status_message?.trim()||"暂无状态消息";
            const preview=section==="contacts"
              ?friendStatusMessage
              :draftsText?"[草稿] "+draftsText:
                recent?.type==="file"?"[附件] "+(recent.file_name||"文件"):
                recent?.text||friendStatusMessage;
            const when=recent?.at?new Date(recent.at):null;
            const clock=when ? (Date.now()-when.getTime()>86400000?
              when.toLocaleDateString("zh-CN",{month:"2-digit",day:"2-digit"}):
              when.toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"})):"";
            const unread=unreadFor(friend.public_key);
            return <button type="button" key={friend.public_key}
              className={"wechat-conversation "+(section==="chats"&&selected===friend.public_key?"is-selected":"")}
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
            aria-label={chatNavLabel} aria-current={section==="chats"?"page":undefined}
            onClick={()=>setSection("chats")}>
            <Badge count={totalUnread} overflowCount={99} size="small" className="wt-nav-chat-badge">
              <RailIcon kind="chats"/>
            </Badge>
            <span>聊天</span>
          </button>
          <button type="button" className={section==="contacts"?"active":""}
            aria-current={section==="contacts"?"page":undefined}
            onClick={()=>setSection("contacts")}><RailIcon kind="contacts"/><span>通讯录</span></button>
          <button type="button" onClick={()=>{setSection("me");setMobileChat(false)}}>
            <RailIcon kind="settings"/><span>设置</span>
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
          <button type="button" aria-label={chatNavLabel}
            onClick={()=>{setSection("chats");setMobileChat(false)}}>
            <Badge count={totalUnread} overflowCount={99} size="small" className="wt-nav-chat-badge">
              <RailIcon kind="chats"/>
            </Badge>
            <span>聊天</span>
          </button>
          <button type="button" onClick={()=>setSection("contacts")}>
            <RailIcon kind="contacts"/><span>通讯录</span>
          </button>
          <button type="button" className="active" aria-current="page">
            <RailIcon kind="settings"/><span>设置</span>
          </button>
        </nav>
      </section>
      <main className={"ant-chat-area"+(!selected?" is-empty-chat":"")}
        onTouchStart={onChatTouchStart} onTouchEnd={onChatTouchEnd}
        onTouchCancel={()=>{swipeStart.current=null}}>
        {selected&&<div className="ant-chat-toolbar">
          <div className="ant-chat-identity">
            <AntButton className="ant-mobile-back" aria-label="返回联系人"
              icon={<ArrowLeftOutlined/>} onClick={returnFromMobileChat}/>
            <AntButton type="text" className="wt-peer-avatar-button"
              aria-label="查看好友 Tox 资料" disabled={!selectedFriend}
              onClick={()=>setPeerDetailsOpen(true)}>
              <Badge dot color={peerStatusColor==="success"?"#16b977":
                  peerStatusColor==="warning"?"#faad14":
                  peerStatusColor==="error"?"#ff4d4f":"#929399"}
                offset={[-2,3]} className="wt-chat-presence-badge">
                <Avatar size={40} gap={4} className="ant-chat-avatar"
                  style={{backgroundColor:avatarColor(selectedFriend?.public_key||user.public_key)}}>
                  {selectedFriend?avatarLabel(selectedFriend.name,selectedFriend.public_key):"✦"}
                </Avatar>
              </Badge>
            </AntButton>
            <div className="ant-peer-title">
              <div className="wt-peer-name-row">
                <strong>{selectedFriend?.name|| (selected?"好友 "+shortKey(selected):"选择好友开始聊天")}</strong>
              </div>
              <small title={selectedFriend?.status_message||""}>
                {selectedFriend?.status_message?.trim()|| (selectedFriend?"暂无状态消息":"wTox")}
              </small>
            </div>
          </div>
          <Dropdown trigger={["click"]} disabled={!selectedFriend}
              menu={{
                items:[
                  {key:"profile",icon:<UserOutlined/>,label:"查看好友资料"},
                  {type:"divider"},
                  {key:"delete",icon:<DeleteOutlined/>,label:"删除好友",danger:true}
                ],
                onClick:({key})=>{
                  if(key==="profile")setPeerDetailsOpen(true);
                  if(key==="delete")setDeleteFriendOpen(true);
                }
              }}>
              <AntButton type="text" shape="circle" className="wt-chat-more-button"
                icon={<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true">
                  <circle cx="5" cy="12" r="2.25"/><circle cx="12" cy="12" r="2.25"/>
                  <circle cx="19" cy="12" r="2.25"/>
                </svg>} aria-label="更多操作" disabled={!selectedFriend}/>
            </Dropdown>
        </div>}
        <div className="wt-thread-shell">
          {selected&&selectedMessageIds.size>0&&<div className="wt-batch-toolbar" role="toolbar" aria-label="批量删除聊天记录">
            <strong>已选 {selectedMessageIds.size} 条</strong>
            <AntButton size="small" onClick={()=>setSelectedMessageIds(new Set(thread.map(m=>m.id)))}>
              全选
            </AntButton>
            <AntButton size="small" onClick={clearSelection}>取消</AntButton>
            <Popconfirm title={`删除选中的 ${selectedMessageIds.size} 条记录？`}
              description="仅删除此浏览器中的记录，不能撤回消息或取消待发队列。"
              okText="删除" cancelText="取消" okButtonProps={{danger:true}}
              onConfirm={requestDelete}>
              <AntButton size="small" danger loading={deletingMessages}>删除</AntButton>
            </Popconfirm>
          </div>}
          <div ref={threadEl}
            className={"ant-thread"+(threadScrolling?" wt-thread-scrolling":"")}
            onScroll={onThreadScroll} role="log" aria-label="聊天记录">
            <div className="wt-thread-content">
          {!selected&&<div className="ant-empty-chat">
            <img src={LOGO_URL} alt="" width="74" height="74"/>
            <h3>欢迎使用 wTox</h3><p>选择一位好友，开始私人对话</p>
          </div>}
          {selected&&!thread.length&&<div className="ant-empty-chat wt-empty-conversation">
            <div className="wt-empty-icon"><MessageOutlined/></div>
            <h3>还没有聊天记录</h3>
            <p>发送一条消息，开始你们的对话</p>
          </div>}
          {thread.map(item=>item.type==="file"
            ? <Dropdown key={item.id} trigger={["contextMenu"]} menu={messageMenu(item)}>
              <div className={"ant-timeline-file wt-selectable-message"+
                (selectedMessageIds.has(item.id)?" is-batch-selected":"")+
                (selectedMessageIds.size?" is-selecting":"")}
                onPointerDown={event=>startLongPress(item,event)}
                onPointerUp={cancelLongPress} onPointerCancel={cancelLongPress}
                onPointerLeave={cancelLongPress} onPointerMove={cancelLongPress}
                onClickCapture={event=>messageSelectionClick(event,item.id)}>
                <AttachmentBubble file={item}
                  accept={id=>controlFile(id,"accept")}
                  reject={id=>controlFile(id,"reject")}
                  download={downloadFile} historyHandle={history.current}
                  imageCacheRevision={imageCacheRevision}/>
              </div>
              </Dropdown>
            : <Dropdown key={item.id} trigger={["contextMenu"]} menu={messageMenu(item)}>
              <div className={"ant-message-wrap wt-message-row wt-selectable-message "+
                (item.direction==="outgoing"?"wt-message-outgoing":"wt-message-incoming")+
                (selectedMessageIds.has(item.id)?" is-batch-selected":"")+
                (selectedMessageIds.size?" is-selecting":"")}
                onPointerDown={event=>startLongPress(item,event)}
                onPointerUp={cancelLongPress} onPointerCancel={cancelLongPress}
                onPointerLeave={cancelLongPress} onPointerMove={cancelLongPress}
                onClickCapture={event=>messageSelectionClick(event,item.id)}>
                <Bubble className="wt-conversation-bubble" content={String(item.text||"")}
                  placement={item.direction==="outgoing"?"end":"start"}
                  shape="round" variant="filled"
                  footer={<span className="ant-message-status">
                    {chatTime(item.at)}
                    {item.direction==="outgoing"?" · "+stateText(item):""}
                  </span>}
                  footerPlacement={item.direction==="outgoing"?"outer-end":"outer-start"}/>
              </div>
              </Dropdown>)}
            </div>
          </div>
          {selected&&newBelowCount>0&&<AntButton type="primary" shape="round"
            className="wt-new-message-indicator" icon={<ArrowDownOutlined/>}
            onClick={scrollToLatest} aria-label={`查看下面的${newBelowCount}条新消息`}>
            {newBelowCount} 条新消息
          </AntButton>}
        </div>
        {selected&&<div className="ant-compose-area">
          <div className="wt-compose-tools">
            <Upload showUploadList={false} maxCount={1} className="wt-chat-file-upload"
              disabled={!selected||!online(selectedFriend)}
              beforeUpload={file=>{
                if(file.size<1||file.size>5*1024*1024){
                  alert("附件大小需要在 1 字节至 5 MiB 之间","error");
                  return Upload.LIST_IGNORE;
                }
                setUploadFile(file);
                return false;
              }}>
              <AntButton type="text" className="wt-compose-attach-button"
                icon={<PaperClipOutlined/>} aria-label="添加附件"
                disabled={!selected||!online(selectedFriend)}/>
            </Upload>
            {(!historyReady||!online(selectedFriend))&&
              <p className="ant-compose-status">
                {!historyReady?"本地加密历史尚未就绪":"对方离线"}
              </p>}
          </div>
          <Sender className="wt-chat-sender" value={draft}
            placeholder="输入消息…" autoSize={{minRows:2,maxRows:5}}
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
            suffix={(_,info)=>{
              const SendButton=info.components.SendButton;
              return <SendButton disabled={!draft.trim()||!selected||!historyReady||sending}
                aria-label="发送消息"/>;
            }}
            onSubmit={text=>{if(text.trim())sendText("",text,text)}}
            disabled={!selected||!historyReady||sending} submitType="enter"/>
        </div>}
      </main>
    </div>

    <AntModal open={logoutOpen} title="退出当前身份" footer={null}
      destroyOnHidden onCancel={()=>{if(!logoutBusy)setLogoutOpen(false)}}
      closable={!logoutBusy} maskClosable={!logoutBusy}>
      <Typography.Paragraph>
        你希望如何处理当前身份保存在此浏览器中的聊天记录和图片缓存？
      </Typography.Paragraph>
      <Typography.Paragraph type="warning">
        退出将永久删除服务器上的当前 Tox 身份、好友列表、待发送消息和附件。
        如需以后恢复身份，请先导出并保存 .tox 备份。
      </Typography.Paragraph>
      <Space orientation="vertical" size="middle" style={{width:"100%"}}>
        <AntButton block loading={logoutBusy} onClick={()=>logout(false)}>
          保留本地数据并退出
        </AntButton>
        <AntButton block danger type="primary" loading={logoutBusy}
          onClick={()=>logout(true)}>
          清除当前身份本地数据并退出
        </AntButton>
        <Typography.Text type="secondary" className="wt-settings-footnote">
          清除本地数据会永久删除当前身份在此浏览器中的加密消息、
          图片缓存、已读记录、头像颜色与其他身份关联数据。
          服务器数据无论选择哪项都会删除；请提前备份。
        </Typography.Text>
      </Space>
    </AntModal>

    <AntModal open={!!singleDeleteId} title="删除聊天记录"
      onCancel={()=>setSingleDeleteId(null)} onOk={deleteSingleMessage}
      okText="删除记录" cancelText="取消"
      okButtonProps={{danger:true,loading:deletingMessages}}
      cancelButtonProps={{disabled:deletingMessages}}
      closable={!deletingMessages} maskClosable={!deletingMessages}>
      <Typography.Paragraph>确定删除这条聊天记录吗？</Typography.Paragraph>
      <Typography.Text type="secondary">
        只删除当前浏览器中的记录，不会撤回对方已收到的消息，也不会取消待发队列。
      </Typography.Text>
    </AntModal>

    <AntModal open={deleteFriendOpen&&!!selectedFriend} title="删除好友"
      destroyOnHidden onCancel={()=>setDeleteFriendOpen(false)}
      onOk={removeFriend} okText="删除好友" cancelText="取消"
      okButtonProps={{danger:true,loading:removingFriend}}
      cancelButtonProps={{disabled:removingFriend}} closable={!removingFriend}
      maskClosable={!removingFriend}>
      <Typography.Paragraph>
        确定要删除「{selectedFriend?.name||"当前好友"}」吗？
      </Typography.Paragraph>
      <Typography.Text type="secondary">
        将从好友列表移除，当前浏览器保存的聊天记录不会被清除。
      </Typography.Text>
    </AntModal>

    {isMobile
        ? <Drawer open={peerDetailsOpen&&!!selectedFriend} title="好友资料" placement="bottom"
            height="auto" styles={{body:{maxHeight:"68dvh",overflowY:"auto"}}}
            onClose={()=>setPeerDetailsOpen(false)} destroyOnHidden>
            {peerProfileContent}
          </Drawer>
        : <AntModal open={peerDetailsOpen&&!!selectedFriend} title="好友资料"
            onCancel={()=>setPeerDetailsOpen(false)} footer={null}
            destroyOnHidden width={500}>
            {peerProfileContent}
          </AntModal>}
    <AntModal open={modal==="profile"} title="我的 Tox 资料"
      onCancel={closeModal} footer={null} destroyOnHidden width={520}>
      <div className="wt-own-tox-id-heading">
        <Typography.Text type="secondary">我的 Tox ID（可分享给好友）</Typography.Text>
        <AntButton type="text" size="small" icon={<QrcodeOutlined/>}
          aria-label="显示 Tox ID 二维码" onClick={()=>setModal("qrcode")}>二维码</AntButton>
      </div>
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
    </AntModal>

    <AntModal open={modal==="qrcode"} title="我的 Tox ID 二维码"
      onCancel={()=>setModal("profile")}
      footer={<AntButton onClick={()=>setModal("profile")}>返回我的资料</AntButton>}
      width={360} destroyOnHidden>
      <div className="wt-own-qr-content">
        <QRCode value={user.tox_id} size={240} type="svg" bordered={false}
          color="#161616" bgColor="#ffffff"/>
        <Typography.Text type="secondary">扫描二维码添加 Tox 好友</Typography.Text>
        <AntButton onClick={async()=>{
          try{
            await navigator.clipboard.writeText(user.tox_id);
            uiMessageApi.success("已复制 Tox ID");
          }catch{uiMessageApi.error("复制失败，请手动复制")}
        }}>复制 Tox ID</AntButton>
      </div>
    </AntModal>

    <Drawer open={modal==="settings"} title="设置" placement="right"
      onClose={closeModal} width={480} destroyOnHidden
      className="wt-settings-drawer" rootClassName="wt-settings-drawer-root">
      {settingsContent}
    </Drawer>

    <AntModal open={modal==="add"} title="添加 Tox 好友" onCancel={closeModal}
      footer={null} destroyOnHidden>
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
    </AntModal>
    <AntModal open={modal==="requests"} title={`好友请求（${friendRequests.length}）`}
      onCancel={closeModal} footer={null} destroyOnHidden>
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
    </AntModal>


  </div></ConfigProvider>;
}
