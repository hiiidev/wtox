const result=document.querySelector("#result");
const worker=new Worker(new URL("../browser/udp-probe.worker.mjs",import.meta.url),
                        {type:"module"});
worker.onmessage=({data})=>{
  if(data?.type==="DONE"){
    result.dataset.state="passed";
    result.textContent="PASS: original Network_Funcs UDP "
      +data.info.datagrams+" lossless datagrams via Chromium + OS UDP echo";
  }else if(data?.type==="ERROR"){
    result.dataset.state="failed";
    result.textContent="FAIL: "+data.error;
  }
  worker.terminate();
};
worker.onerror=(event)=>{
  result.dataset.state="failed";
  result.textContent="FAIL: udp_worker_error:"+event.message;
  worker.terminate();
};
(async()=>{
  try{
    const response=await fetch("/__wtox_udp_target",{cache:"no-store",credentials:"omit"});
    if(!response.ok)throw Error("udp_local_fixture_unavailable");
    const {token,port}=await response.json();
    const url="ws://127.0.0.1:"+location.port+"/__wtox_udp_bridge";
    worker.postMessage({action:"START",url,token,port});
  }catch(e){
    result.dataset.state="failed";
    result.textContent="FAIL: "+String(e.message);
    worker.terminate();
  }
})();
