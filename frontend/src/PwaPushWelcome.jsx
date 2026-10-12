import React, {useEffect} from "react";
import {isStandalone, preparePush, savePushSubscription} from "./push_client.js";

/** Automatic PWA push setup without an in-app permission dialog.
 * iOS requires transient user activation before PushManager.subscribe can
 * show the native permission request. Preload the SW/VAPID asynchronously,
 * then subscribe from the user's first interaction inside the installed app.
 * If permission is already granted, subscriptions are restored immediately.
 */
export default function PwaPushWelcome({userId}){
  useEffect(()=>{
    if(!userId||!isStandalone())return undefined;
    let active=true;
    let busy=false;
    let registration=null;
    let applicationServerKey=null;
    const attemptKey="wtox-pwa-push-attempt-"+userId;
    const removeListeners=()=>{
      document.removeEventListener("click",onFirstGesture,true);
      document.removeEventListener("keydown",onFirstGesture,true);
    };
    const save=async subscription=>{
      await savePushSubscription(subscription);
      if(active)window.dispatchEvent(new Event("wtox-push-changed"));
    };
    const subscribe=()=>{
      if(!active||busy||!registration)return;
      busy=true;
      removeListeners();
      try{localStorage.setItem(attemptKey,"1")}catch{}
      // subscribe() is initiated synchronously during the actual user event.
      // Never await a network request before calling it from that event.
      const promise=registration.pushManager.subscribe({
        userVisibleOnly:true,applicationServerKey
      });
      Promise.resolve(promise).then(save).catch(error=>{
        console.warn("PWA push permission/subscription was not granted:",error);
      }).finally(()=>{busy=false});
    };
    function onFirstGesture(event){
      if(event.type==="keydown"&&(event.key==="Tab"||event.key==="Shift"))return;
      subscribe();
    }
    (async()=>{
      try{
        const prepared=await preparePush();
        if(!active)return;
        registration=prepared.registration;
        applicationServerKey=prepared.applicationServerKey;
        if(prepared.subscription){
          if(Notification.permission==="granted")await save(prepared.subscription);
          return;
        }
        if(Notification.permission==="denied")return;
        if(Notification.permission==="granted"){
          // No permission prompt is needed; re-create an expired subscription.
          subscribe();
          return;
        }
        // Default permission: the OS requires a user gesture (especially iOS).
        // No wTox modal appears, just the native system prompt on first tap.
        if(localStorage.getItem(attemptKey)==="1")return;
        document.addEventListener("click",onFirstGesture,true);
        document.addEventListener("keydown",onFirstGesture,true);
      }catch(error){
        console.warn("PWA push auto-setup is unavailable:",error);
      }
    })();
    return()=>{active=false;removeListeners()};
  },[userId]);
  return null;
}
