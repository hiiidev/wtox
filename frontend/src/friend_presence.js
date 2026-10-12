/** Only display native Tox last-online timestamps when they are known. */
export function formatLastOnline(unixSeconds, now = Date.now()) {
  if (typeof unixSeconds !== "number" || !Number.isSafeInteger(unixSeconds) ||
      unixSeconds <= 0 || unixSeconds > Math.floor(now / 1000) + 86400) return "";
  const date = new Date(unixSeconds * 1000);
  if (!Number.isFinite(date.getTime())) return "";
  const two = n => String(n).padStart(2,"0");
  return `${date.getFullYear()}-${two(date.getMonth()+1)}-${two(date.getDate())} `+
    `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}
export function isFriendOnline(friend) {
  return !!friend && (friend.status === 1 || friend.status === 2);
}
export function contactPresenceText(friend) {
  const message = friend?.status_message?.trim() || "暂无状态消息";
  if (isFriendOnline(friend)) return message;
  const last = formatLastOnline(friend?.last_online);
  return last ? "最后在线:" + last : message;
}
export function chatPresenceText(friend) {
  if (!friend) return "wTox";
  const message = friend.status_message?.trim() || "暂无状态消息";
  if (isFriendOnline(friend)) return message;
  const last = formatLastOnline(friend.last_online);
  return last ? "最后在线:" + last + " · " + message : message;
}
