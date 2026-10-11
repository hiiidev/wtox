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
export async function getJson(url){return(await api(url)).json()}
export async function postJson(url,data={}){return(await api(url,{method:"POST",body:JSON.stringify(data)})).json()}
export function downloadBlob(blob,name){
  const objectUrl=URL.createObjectURL(blob);
  const a=document.createElement("a");a.href=objectUrl;a.download=name;
  document.body.append(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(objectUrl),4000);
}
export function shortKey(value=""){return value.length>16?value.slice(0,9)+"…"+value.slice(-5):value}
export function statusLabel(status){return status===2?"UDP 在线":status===1?"TCP 在线":"离线"}
