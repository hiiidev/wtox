const result=document.querySelector("#result");
let worker=null;
function fail(error) {
  result.dataset.state="failed";
  result.textContent="FAIL: "+String(error?.message||error);
  worker?.terminate();
}
(async()=>{
  try {
    const response=await fetch("/__wtox_dht_target",{credentials:"omit",cache:"no-store"});
    if(!response.ok)throw Error("native_dht_target_unavailable");
    const config=await response.json();
    worker=new Worker(new URL("../browser/dht-probe.worker.mjs",import.meta.url),
                      {type:"module"});
    worker.onmessage=({data})=>{
      if(data?.type==="ERROR"){fail(data.error);return;}
      if(data?.type!=="DONE")return;
      const r=data.outcome;
      if(r?.realToxUdpConnected!==true || r.state!==2){
        fail("original_tox_dht_not_connected");return;
      }
      result.dataset.state="passed";
      result.textContent="PASS: original Toxcore DHT UDP connected, sent="
        +r.sent+" received="+r.received+" against independent native bootstrap";
      worker.terminate();
    };
    worker.onerror=e=>fail("dht_worker_exception:"+e.message);
    worker.postMessage({action:"START",url:"ws://127.0.0.1:"+location.port+
      "/__wtox_dht_bridge",...config});
  }catch(e){fail(e);}
})();