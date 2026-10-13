/**
 * Research UI. Never imports production app or uploads any .tox backups.
 * Controls are wired to genuine original Toxcore WASM event results.
 * A queued request is never displayed as delivered or accepted.
 */
const $=id=>document.getElementById(id);
const status=$("network-status"),friendStatus=$("friend-status");
const friendButton=$("request-button"),sendButton=$("send-button");
const messageInput=$("message-text"),feedback=$("feedback");
const worker=new Worker(new URL("../browser/local-chat.worker.mjs",import.meta.url),
                        {type:"module"});
let ready=false,requested=false,online=false,closed=false;
function appendMessage(sender,body,kind){
  const item=document.createElement("li");
  item.className=kind||"";
  item.textContent=sender+": "+body;
  $("messages").append(item);
  $("messages").scrollTop=$("messages").scrollHeight;
}
function updateControls(){
  friendButton.disabled=!ready||requested||closed;
  const allowed=ready&&requested&&online&&!closed;
  sendButton.disabled=!allowed;
  messageInput.disabled=!allowed;
}
function alertUser(text){
  feedback.textContent=text;
  appendMessage("System",text,"system");
}
function closeSession(){
  if(closed)return;
  closed=true;
  ready=false;
  online=false;
  updateControls();
  status.textContent="Disconnected";
  friendStatus.textContent="Offline";
  worker.postMessage({action:"STOP"});
}
worker.onmessage=({data})=>{
  switch(data?.type){
    case "BOOTSTRAPPING":
      status.textContent="Discovering local DHT node";
      break;
    case "READY":
      ready=true;
      status.textContent="Local DHT neighbor verified";
      $("my-tox-id").dataset.state="ready";
      $("my-tox-id").textContent=data.toxId;
      updateControls();
      break;
    case "REQUEST_QUEUED":
      requested=true;
      friendStatus.textContent="Request queued — awaiting peer";
      alertUser("Native Toxcore queued the friend request; delivery is not yet confirmed.");
      updateControls();
      break;
    case "FRIEND_STATUS":
      online=data.online===true;
      friendStatus.textContent=online?
        (data.connection===2?"Friend online (UDP)":"Friend online (TCP)") :
        "Friend offline — waiting for native connection";
      appendMessage("System",online?"Friend connected through native Toxcore":"Friend offline","system");
      updateControls();
      break;
    case "MESSAGE_SENT":
      appendMessage("You",data.text,"me");
      feedback.textContent="Sent to Toxcore while friend was online (not a delivery receipt).";
      break;
    case "MESSAGE_RECEIVED":
      appendMessage("Friend",data.text,"peer");
      feedback.textContent="Received from original native Tox message callback.";
      break;
    case "ACTION_ERROR":
      alertUser(data.message||"Native action rejected.");
      updateControls(); // Failed Tox checksum must remain correctable.
      break;
    case "ERROR":
      alertUser(data.message||"Worker failed");
      closeSession();
      break;
    case "STOPPED":
      closeSession();
      break;
  }
};
worker.onerror=()=>{alertUser("Dedicated Worker failed");closeSession();};
$("friend-form").addEventListener("submit",event=>{
  event.preventDefault();
  if(!ready||requested||closed)return;
  const toxId=$("friend-id").value.trim().toUpperCase();
  const message=$("request-text").value.trim();
  if(!/^[A-F0-9]{76}$/.test(toxId) ||
     new TextEncoder().encode(message).length<1 ||
     new TextEncoder().encode(message).length>128){
    alertUser("Enter a valid full Tox ID and request message up to 128 UTF-8 bytes.");
    return;
  }
  friendButton.disabled=true;
  worker.postMessage({action:"REQUEST",toxId,message});
});
$("message-form").addEventListener("submit",event=>{
  event.preventDefault();
  if(!online||closed)return;
  const message=messageInput.value.trim();
  if(!message||new TextEncoder().encode(message).length>128){
    alertUser("Message must be 1–128 UTF-8 bytes.");return;
  }
  messageInput.value="";
  worker.postMessage({action:"SEND",message});
});
$("disconnect").addEventListener("click",closeSession);
(async()=>{
  try{
    const res=await fetch("/__wtox_dht_target",{cache:"no-store",credentials:"omit"});
    if(!res.ok)throw Error("local_fixture_unavailable");
    const config=await res.json();
    worker.postMessage({action:"START",
      url:"ws://127.0.0.1:"+location.port+"/__wtox_dht_bridge",...config});
  }catch(e){alertUser(String(e?.message||e));closeSession();}
})();
