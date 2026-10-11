// Browser-only interoperable text-history import/export.
// qTox real "Export to file" layout: YYYY-MM-DD<TAB>hh:mm:ss<TAB>sender<TAB>text.
// aTox exports are NOT assumed identical; unsupported layouts are rejected.
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
export function toQtoxTsv(records, friendKey, friendName) {
  if (!KEY_RE.test(friendKey)) throw new Error("请选择一个有效好友");
  const name=(friendName||"Friend").replace(/[\t\r\n]/g," ");
  const lines=[];
  for(const r of records) {
    if (r.type!=="message"||r.public_key!==friendKey)continue;
    const date=new Date(r.at);
    const localDate=[date.getFullYear(),String(date.getMonth()+1).padStart(2,"0"),String(date.getDate()).padStart(2,"0")].join("-");
    const clock=[date.getHours(),date.getMinutes(),date.getSeconds()].map(n=>String(n).padStart(2,"0")).join(":");
    const sender=r.direction==="outgoing"?"wtox-me":name;
    lines.push([localDate,clock,sender,r.text.replace(/\r?\n/g,"\n")].join("\t"));
  }
  return lines.join("\n")+(lines.length?"\n":"");
}
export function fromQtoxTsv(text, peer, ownName) {
  if (!KEY_RE.test(peer)) throw new Error("请先选择目标好友");
  if (!ownName || !ownName.trim()) throw new Error("导入 qTox 历史需要填写导出文件中自己的昵称，才能正确区分收发方向");
  const lines=text.replace(/\r\n?/g,"\n").split("\n").filter(x=>x.trim());
  if(lines.length>MAX_RECORDS)throw new Error("记录数量过多");
  const records=[];
  for(const line of lines){
    const parts=line.split("\t");
    if(parts.length<4)throw new Error("不是 qTox 导出的制表符聊天日志（日期 / 时间 / 作者 / 内容）");
    const [date,clock,sender,...message]=parts;
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!/^\d{2}:\d{2}:\d{2}$/.test(clock)){
      throw new Error("qTox 时间格式不正确");
    }
    const at=validTime(date+"T"+clock);
    records.push({type:"message",direction:sender===ownName?"outgoing":"incoming",
                  public_key:peer,text:message.join("\t"),at});
  }
  return records;
}
