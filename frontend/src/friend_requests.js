/** Surface request copies saved by older PWAs after their premature ack.
 * The server inbox is authoritative. Local-only records are explicitly marked
 * for review and never silently accepted as actionable server requests.
 */
export function recoverableFriendRequests(events, serverRequests, friends, now=Date.now()) {
  const active=new Set((serverRequests||[]).map(row=>String(row.public_key||"").toUpperCase()));
  const accepted=new Set((friends||[]).map(row=>String(row.public_key||"").toUpperCase()));
  const seen=new Set();
  const since=now-7*24*60*60*1000;
  return (events||[]).filter(event=>{
    if(event?.type!=="friend_request"||
       typeof event.id!=="string"||event.id.length>200||
       !/^[0-9a-f]{64}$/i.test(event.public_key||"")||
       !Number.isFinite(event.at)||event.at<since||event.at>now+86400000)
      return false;
    const key=event.public_key.toUpperCase();
    if(active.has(key)||accepted.has(key)||seen.has(key))return false;
    seen.add(key);
    return true;
  }).map(event=>({
    id:event.id,public_key:event.public_key.toUpperCase(),
    text:event.text||"",created:Math.floor(event.at/1000),recovered:true
  }));
}
