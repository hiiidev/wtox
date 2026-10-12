export async function api(url, init={}) {
  const { raw=false, headers:extraHeaders={}, ...options }=init;
  const response=await fetch(url,{
    credentials:"same-origin",cache:"no-store",...options,
    headers:{...(!raw && options.body!=null?{"Content-Type":"application/json"}:{}),...extraHeaders}
  });
  if(!response.ok){
    let message="请求失败 ("+response.status+")";
    try{const data=await response.json();message=typeof data.detail==="string"?data.detail:message}
    catch {}
    const error=new Error(message);error.status=response.status;throw error;
  }
  return response;
}
export async function getJson(url,init={}){return(await api(url,init)).json()}
export async function postJson(url,data={}){return(await api(url,{method:"POST",body:JSON.stringify(data)})).json()}
export function downloadBlob(blob,name){
  const objectUrl=URL.createObjectURL(blob);
  const a=document.createElement("a");a.href=objectUrl;a.download=name;
  document.body.append(a);a.click();a.remove();
  // Keep Safari blob URLs alive long enough for the OS download handoff.
  setTimeout(()=>URL.revokeObjectURL(objectUrl),60000);
}
/** Save a Tox identity with an explicit .tox filename on iOS/Android.
 * application/octet-stream is the correct MIME for binary savedata; it is not
 * the filename suffix. The native file share sheet is more reliable than a
 * blob: URL download for mobile Files apps.
 * @returns {"shared"|"downloaded"|"cancelled"}
 */
export async function downloadToxFile(blob, name){
  const filename=String(name||"wtox-profile.tox").replace(/[\/\\]/g,"_");
  const safeName=/\.tox$/i.test(filename)?filename:filename+".tox";
  const file=new File([blob],safeName,{type:"application/octet-stream"});
  const mobile=/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    navigator.userAgentData?.mobile===true;
  if(mobile&&typeof navigator.share==="function"&&
     typeof navigator.canShare==="function"&&navigator.canShare({files:[file]})){
    try{
      await navigator.share({files:[file],title:"wTox 身份备份 (.tox)"});
      return "shared";
    }catch(error){
      if(error?.name==="AbortError")return "cancelled";
      // Web Share requires a transient user gesture on some browsers;
      // if it has expired, retain the explicit filename in a normal download.
    }
  }
  downloadBlob(file,safeName);
  return "downloaded";
}
export function shortKey(value=""){return value.length>16?value.slice(0,9)+"…"+value.slice(-5):value}
export function statusLabel(status){return status===2?"UDP 在线":status===1?"TCP 在线":"离线"}
