import React, {useEffect, useRef, useState} from "react";
import {Button, Modal, Space, Typography} from "antd";
import {isStandalone, preparePush, savePushSubscription} from "./push_client.js";

/** Shown once per identity on its installed device. System permission is
 * requested only from the direct button click (required by iOS Web Push).
 * The service worker and VAPID key are prepared before the dialog opens.
 */
export default function PwaPushWelcome({userId}){
  const [open,setOpen]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const prepared=useRef(null);
  const dismissKey=userId&&"wtox-pwa-push-prompt-"+userId;
  useEffect(()=>{
    let active=true;
    prepared.current=null;
    setOpen(false);
    if(!userId||!isStandalone())return()=>{active=false};
    (async()=>{
      try{
        const context=await preparePush();
        if(!active)return;
        prepared.current=context;
        if(context.subscription){
          // Also restore a previously granted subscription for this identity.
          await savePushSubscription(context.subscription);
          window.dispatchEvent(new Event("wtox-push-changed"));
          return;
        }
        if(Notification.permission==="denied")return;
        if(localStorage.getItem(dismissKey)==="1")return;
        localStorage.setItem(dismissKey,"1");
        setOpen(true);
      }catch(error){
        // Unavailable push should not interrupt login or cause a permission loop.
        console.warn("Push introduction not available:",error);
      }
    })();
    return()=>{active=false};
  },[userId,dismissKey]);

  function close(){if(!busy)setOpen(false)}
  async function enable(){
    const context=prepared.current;
    if(!context||busy)return;
    setBusy(true);setError("");
    try{
      // subscribe must be initiated synchronously in the click handler.
      const promise=context.registration.pushManager.subscribe({
        userVisibleOnly:true,applicationServerKey:context.applicationServerKey
      });
      const sub=await promise;
      await savePushSubscription(sub);
      window.dispatchEvent(new Event("wtox-push-changed"));
      setOpen(false);
    }catch(error){setError("开启失败："+error.message)}
    finally{setBusy(false)}
  }
  return <Modal title="开启离线通知" open={open} destroyOnHidden
    onCancel={close} footer={null} closable={!busy} maskClosable={!busy}>
    <Typography.Paragraph>
      开启后，即使离开应用或锁定屏幕，也可以接收新消息和好友请求提醒。
      通知不会包含聊天正文。
    </Typography.Paragraph>
    {error&&<Typography.Paragraph type="danger">{error}</Typography.Paragraph>}
    <Space style={{width:"100%",justifyContent:"flex-end"}} wrap>
      <Button onClick={close} disabled={busy}>稍后</Button>
      <Button type="primary" loading={busy} disabled={!prepared.current} onClick={enable}>
        开启离线通知
      </Button>
    </Space>
  </Modal>;
}
