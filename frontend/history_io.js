// Browser-only wTox JSON history backup. aTox has an export feature,
// but its proprietary file schema has not been validated; never mislabel
// these JSON backups as directly importable by aTox.
export const MAX_HISTORY_IMPORT = 8 * 1024 * 1024;
const MAX_RECORDS = 20000;
const KEY_RE = /^[0-9A-F]{64}$/;

function validTime(iso) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time) || time < 0 || time > Date.now() + 86400000) {
    throw new Error("历史记录包含无效日期");
  }
  return time;
}
function validateRecord(row, owner, forcedPeer) {
  if (!row || typeof row !== "object") throw new Error("历史消息格式错误");
  const key=(forcedPeer || row.public_key || "").toUpperCase();
  if (!KEY_RE.test(key)) throw new Error("好友公钥必须是 64 位十六进制");
  const direction=row.direction;
  if (!["incoming","outgoing"].includes(direction)) throw new Error("消息方向无效");
  const text=row.text;
  if (typeof text!=="string" || text.length>65536) throw new Error("消息文本不符合长度限制");
  const at=typeof row.at==="number" ? row.at : validTime(row.at);
  if (!Number.isFinite(at)||at<0||at>Date.now()+86400000)throw new Error("时间无效");
  return {type:"message",direction,public_key:key,text,at};
}
export function toWtoxJson(records, owner) {
  if (!KEY_RE.test(owner)) throw new Error("当前 Tox 身份无效");
  const rows=records.filter(r=>r.type==="message").map(r=>validateRecord(r,owner));
  return JSON.stringify({format:"wtox-chat-history",version:1,owner,exported:new Date().toISOString(),messages:rows},null,2);
}
export function fromWtoxJson(text, owner) {
  const obj=JSON.parse(text);
  if (obj.format!=="wtox-chat-history"||obj.version!==1||obj.owner!==owner||!Array.isArray(obj.messages))
    throw new Error("这不是当前 Tox 身份的 wtox 聊天历史备份");
  if (obj.messages.length>MAX_RECORDS)throw new Error("记录数量过多");
  return obj.messages.map(r=>validateRecord(r,owner));
}
