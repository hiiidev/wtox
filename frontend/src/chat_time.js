/** Always show complete local date and time for chat messages and files.
 * Example: 2026年10月12日 21:10. No relative today/yesterday labels.
 */
export function chatTime(value){
  const date=new Date(value);
  if(!Number.isFinite(date.getTime()))return "";
  const two=n=>String(n).padStart(2,"0");
  return `${date.getFullYear()}年${two(date.getMonth()+1)}月${two(date.getDate())}日 `+
    `${two(date.getHours())}:${two(date.getMinutes())}`;
}
