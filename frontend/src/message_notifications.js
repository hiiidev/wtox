/** Message-notification eligibility, independent of browser APIs and React. */
export const RECENT_MESSAGE_MS = 2*60*1000;

/** Recovering old server inbox entries must not create a flood of stale alerts. */
export function shouldNotifyMessage(event,{recovered=false,now=Date.now(),isViewing=false}={}){
  if(!event || event.type!=="message" || event.direction!=="incoming" ||
     !event.public_key || isViewing)return false;
  if(!recovered)return true;
  const timestamp=event.created?Number(event.created)*1000:Number(event.at||0);
  const millis=timestamp>1e11?timestamp:timestamp*1000;
  return Number.isFinite(millis) && millis>0 &&
    millis<=now+60*1000 && now-millis<=RECENT_MESSAGE_MS;
}

/** Tox event IDs are stable across websocket and queued-inbox delivery. */
export function messageNotificationId(event){
  return String(event.id||[event.public_key,event.created||event.at||"",event.text||""].join(":"));
}
