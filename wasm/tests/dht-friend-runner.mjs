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
    if(!response.ok)throw Error("native_receiver_target_unavailable");
    const config=await response.json();
    worker=new Worker(new URL("../browser/dht-friend.worker.mjs",import.meta.url),
                      {type:"module"});
    worker.onmessage=({data})=>{
      if(data?.type==="ERROR"){fail(data.error);return;}
      if(data?.type!=="DONE")return;
      const r=data.outcome;
      if(r?.authenticatedDhtNeighbor!==true ||
         r.requestQueued!==true || r.browserSent!==true ||
         r.gotText!==true || !/^[0-9a-f]{64}$/.test(r.publicKey)){
        fail("real_native_friend_callbacks_not_verified");return;
      }
      result.dataset.state="passed";
      result.dataset.publicKey=r.publicKey;
      result.textContent="PASS: browser original Onion request and two-way native Tox text";
      worker.terminate();
    };
    worker.onerror=e=>fail("dht_friend_worker_exception:"+e.message);
    worker.postMessage({action:"START",
      url:"ws://127.0.0.1:"+location.port+"/__wtox_dht_bridge",...config});
  }catch(e){fail(e);}
})();