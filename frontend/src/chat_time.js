/** Compact timestamps for chat bubbles, file transfers and long-lived history.
 * Same local calendar day: 21:10; yesterday: 昨天 21:10;
 * earlier this year: 09月25日 21:10; prior years: 2025年09月25日 21:10.
 */
export function chatTime(value, now=Date.now()){
  const date=new Date(value),today=new Date(now);
  if(!Number.isFinite(date.getTime()))return "";
  const time=date.toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",hour12:false});
  const start=new Date(today.getFullYear(),today.getMonth(),today.getDate()).getTime();
  const previous=new Date(today.getFullYear(),today.getMonth(),today.getDate()-1).getTime();
  if(date.getTime()>=start&&date.getTime()<=now)return time;
  if(date.getTime()>=previous&&date.getTime()<start)return "昨天 "+time;
  const day=String(date.getDate()).padStart(2,"0");
  const month=String(date.getMonth()+1).padStart(2,"0");
  const year=date.getFullYear()!==today.getFullYear()?date.getFullYear()+"年":"";
  return year+month+"月"+day+"日 "+time;
}
