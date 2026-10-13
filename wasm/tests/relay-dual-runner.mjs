/** Orchestrate two independent WASM Toxcore clients, never fake an echo. */
const result = document.querySelector("#result");
const EXPECTED = {
  a: [255, 128, 1, 0, 9],
  b: [0, 1, 128, 255, 7]
};
const instances = new Map();
function spawn(role) {
  const worker = new Worker(new URL("../browser/relay-dual.worker.mjs", import.meta.url),
                            { type: "module" });
  const handlers = [];
  let failed = null;
  worker.addEventListener("error", () => {
    failed = Error("worker_script_error_" + role);
    for (const reject of handlers.splice(0)) reject(failed);
  });
  const queues = new Map();
  worker.addEventListener("message", ({data}) => {
    if (data?.type === "ERROR") {
      failed = Error(role + ":" + data.error);
      for (const reject of handlers.splice(0)) reject(failed);
      return;
    }
    if (!data?.type) return;
    const waiters = queues.get(data.type);
    if (waiters?.length) waiters.shift()(data);
    else {
      const stored = queues.get("queued:" + data.type) || [];
      stored.push(data);
      queues.set("queued:" + data.type, stored);
    }
  });
  return {
    role, worker,
    post(action, extra = {}) { worker.postMessage({ action, ...extra }); },
    wait(type) {
      if (failed) return Promise.reject(failed);
      const stored = queues.get("queued:" + type);
      if (stored?.length) return Promise.resolve(stored.shift());
      return new Promise((resolve, reject) => {
        const waiters = queues.get(type) || [];
        waiters.push(resolve);
        queues.set(type, waiters);
        handlers.push(reject);
      });
    },
    stop() { worker.terminate(); }
  };
}
(async () => {
  const a = spawn("a"), b = spawn("b");
  instances.set("a", a); instances.set("b", b);
  try {
    const all = [a, b];
    for (const c of all) c.post("START", {role:c.role});
    const [ar, br] = await Promise.all(all.map(c => c.wait("READY")));
    if (!/^[0-9a-f]{64}$/.test(ar.publicKey) ||
        !/^[0-9a-f]{64}$/.test(br.publicKey) ||
        ar.publicKey === br.publicKey) throw Error("duplicate_or_invalid_native_dht_id");
    a.post("ROUTE", {peerPublicKey:br.publicKey});
    b.post("ROUTE", {peerPublicKey:ar.publicKey});
    await Promise.all(all.map(c => c.wait("ROUTED")));
    for (const c of all) c.post("SEND");
    await Promise.all(all.map(c => c.wait("SENT")));
    const packets = await Promise.all(all.map(c => c.wait("RECEIVED")));
    for (const [i, c] of all.entries()) {
      const got = packets[i].bytes;
      if (!Array.isArray(got) || got.length !== EXPECTED[c.role].length ||
          !got.every((v, j) => v === EXPECTED[c.role][j])) {
        throw Error("dual_native_route_payload_mismatch_" + c.role);
      }
    }
    result.dataset.state = "passed";
    result.textContent = "PASS: two independent native WASM clients exchanged routed binary data";
  } finally {
    for (const c of all) c.stop();
  }
})().catch(error => {
  result.dataset.state = "failed";
  result.textContent = "FAIL: " + String(error?.message || error).replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 140);
  for (const c of instances.values()) c.stop();
});
