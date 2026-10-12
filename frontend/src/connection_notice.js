/** A single bounded Ant Design message for the realtime WebSocket.
 * It never loops "正在连接" indefinitely while retries continue in the
 * background, and a fresh disconnection starts a new notice episode.
 */
export function createConnectionNotice(messageApi, {
  timeoutMs=8000,
  schedule=(handler,ms)=>setTimeout(handler,ms),
  cancel=handle=>clearTimeout(handle)
}={}){
  const key="wtox-server-connection";
  let connectedOnce=false;
  let pending=false;
  let stopped=false;
  let timer=null;

  function clearTimer(){
    if(timer!==null){cancel(timer);timer=null}
  }
  function connecting(){
    // Re-attempts every few seconds must not re-open the same indefinite toast.
    if(stopped||pending)return;
    pending=true;
    messageApi.open({
      key,type:"loading",duration:0,
      content:connectedOnce?"连接中断，正在重新连接…":"正在连接服务器…"
    });
    timer=schedule(()=>{
      timer=null;
      if(stopped||!pending)return;
      // Updating the same keyed message avoids duplicate stacked notices.
      messageApi.open({
        key,type:"warning",duration:4,
        content:"实时连接暂不可用，正在后台重试"
      });
    },timeoutMs);
  }
  function connected(){
    if(stopped)return;
    connectedOnce=true;
    pending=false;
    clearTimer();
    messageApi.destroy(key);
  }
  function stop(){
    stopped=true;
    pending=false;
    clearTimer();
    messageApi.destroy(key);
  }
  return {connecting,connected,stop};
}
