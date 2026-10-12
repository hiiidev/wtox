/** Only display native Tox last-online timestamps when they are known. */
export function formatLastOnline(unixSeconds, now = Date.now()) {
  if (typeof unixSeconds !== "number" || !Number.isSafeInteger(unixSeconds) ||
      unixSeconds <= 0 || unixSeconds > Math.floor(now / 1000) + 300) return "";
  const date = new Date(unixSeconds * 1000);
  if (!Number.isFinite(date.getTime())) return "";
  const two = n => String(n).padStart(2,"0");
  return `${date.getFullYear()}-${two(date.getMonth()+1)}-${two(date.getDate())} `+
    `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}
const DAY_MS = 24*60*60*1000;

/** <=24h: 近期在线; days 1..7: N天前在线; >7 days: exact date.
 * Based on elapsed 24-hour periods, not calendar-midnight boundaries.
 */
export function lastOnlineText(unixSeconds, now = Date.now()) {
  const exact=formatLastOnline(unixSeconds,now);
  if(!exact)return "";
  const elapsed=Math.max(0,now-unixSeconds*1000);
  if(elapsed<DAY_MS)return "近期在线";
  if(elapsed<=7*DAY_MS)return Math.floor(elapsed/DAY_MS)+"天前在线";
  return "最后在线："+exact;
}
export function isFriendOnline(friend) {
  return !!friend && (friend.status === 1 || friend.status === 2);
}
export function contactPresenceText(friend, now = Date.now()) {
  const message = friend?.status_message?.trim() || "暂无状态消息";
  if (isFriendOnline(friend)) return message;
  return lastOnlineText(friend?.last_online,now) || message;
}
export function chatPresenceText(friend, now = Date.now()) {
  if (!friend) return "wTox";
  const message = friend.status_message?.trim() || "暂无状态消息";
  if (isFriendOnline(friend)) return message;
  const last = lastOnlineText(friend.last_online,now);
  return last ? last + " · " + message : message;
}
