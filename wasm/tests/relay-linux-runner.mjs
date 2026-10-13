/** Local test orchestration; no Tox protocol logic in the page. */
const worker = new Worker(new URL("../browser/relay-dual.worker.mjs", import.meta.url),
                          {type:"module"});
window.__crossEvents = [];
worker.addEventListener("message", ({data}) => {
  if (data && typeof data.type === "string") window.__crossEvents.push(data);
});
worker.addEventListener("error", () => {
  window.__crossEvents.push({type:"ERROR",error:"browser_worker_script_error"});
});
window.__crossSend = (action, extra = {}) => worker.postMessage({action,...extra});
window.__crossStop = () => worker.terminate();
worker.postMessage({action:"START",role:"a",mode:"friend"});
