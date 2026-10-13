/** Orchestrate two independent WASM Toxcore clients, never fake an echo. */
const result = document.querySelector("#result");
const requestedMode = new URL(location.href).searchParams.get("mode");
const mode = ["raw", "crypto", "friend", "restart"].includes(requestedMode)
  ? requestedMode : "raw";
const FRIEND_TEXT = {
  a: "From-A: original Tox friend message",
  b: "From-B: original Tox friend message"
};
const RESTORED_TEXT = {
  a: "From-A: after encrypted .tox restore",
  b: "From-B: after encrypted .tox restore"
};
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

const nap = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitForFullDisconnect() {
  const deadline = Date.now() + 8000;
  do {
    const response = await fetch("/__wtox_dual_round_status", {
      cache:"no-store",credentials:"omit"
    });
    if (!response.ok) throw Error("round_status_unavailable");
    const state = await response.json();
    if (state.roles === 0 && state.sessions === 0 &&
        state.sockets === 0 && state.websockets === 0) return;
    await nap(35);
  } while (Date.now() < deadline);
  throw Error("first_round_sockets_not_drained");
}
async function runPersistedFriendRound(backups = null, previousKeys = null) {
  const clients = [spawn("a"),spawn("b")];
  for (const c of clients) instances.set(c.role,c);
  const restored = backups !== null;
  let clean = false;
  try {
    for (const c of clients) {
      const input = {role:c.role,mode:"restart",restored};
      if (restored) input.backup = Uint8Array.from(backups[c.role]);
      c.post("START", input);
      if (input.backup) input.backup.fill(0);
    }
    const keys = await Promise.all(clients.map(c=>c.wait("READY")));
    const [ar,br] = keys;
    for (const info of keys) {
      if (!/^[0-9a-f]{64}$/.test(info.publicKey) ||
          !/^[0-9a-f]{64}$/.test(info.cryptoPublicKey) ||
          info.restored !== restored) throw Error("invalid_restored_native_identity");
    }
    if (ar.cryptoPublicKey === br.cryptoPublicKey ||
        ar.publicKey === br.publicKey) throw Error("duplicate_native_identity");
    if (previousKeys) {
      if (ar.cryptoPublicKey !== previousKeys[0].cryptoPublicKey ||
          br.cryptoPublicKey !== previousKeys[1].cryptoPublicKey)
        throw Error("encrypted_backup_changed_real_tox_identity");
    }
    clients[0].post("ROUTE",{peerPublicKey:br.publicKey,
                             peerCryptoPublicKey:br.cryptoPublicKey});
    clients[1].post("ROUTE",{peerPublicKey:ar.publicKey,
                             peerCryptoPublicKey:ar.cryptoPublicKey});
    await Promise.all(clients.map(c=>c.wait("ROUTED")));
    for (const c of clients) c.post("SEND");
    await Promise.all(clients.map(c=>c.wait("SENT")));
    const messages = await Promise.all(clients.map(c=>c.wait("RECEIVED")));
    for (const [i,c] of clients.entries()) {
      const peer = c.role === "a" ? "b" : "a";
      const expected = Array.from(new TextEncoder().encode(
        restored ? RESTORED_TEXT[peer] : FRIEND_TEXT[peer]));
      const received = messages[i].bytes;
      if (!Array.isArray(received) || received.length !== expected.length ||
          !received.every((byte,j)=>byte===expected[j]))
        throw Error("restored_native_friend_message_mismatch_"+c.role);
    }
    let newBackups=null;
    if (!restored) {
      for (const c of clients) c.post("SAVE");
      const saved = await Promise.all(clients.map(c=>c.wait("SAVED")));
      newBackups={};
      for (const [i,c] of clients.entries()) {
        const ciphertext=saved[i].backup;
        if (!Array.isArray(ciphertext) || ciphertext.length < 100 ||
            ciphertext.length > 1048576+256 ||
            !ciphertext.every(x=>Number.isInteger(x)&&x>=0&&x<=255))
          throw Error("invalid_native_encrypted_backup_"+c.role);
        const backup=Uint8Array.from(ciphertext);
        if (new TextDecoder().decode(backup.subarray(0,8)) !== "toxEsave")
          throw Error("not_standard_encrypted_tox_"+c.role);
        newBackups[c.role]=backup;
      }
    }
    for (const c of clients) c.post("STOP");
    await Promise.all(clients.map(c=>c.wait("STOPPED")));
    clean=true;
    return {backups:newBackups, keys};
  } finally {
    for (const c of clients) c.stop();
    if (!clean) for (const c of clients) instances.delete(c.role);
  }
}
async function runSavedataRestart() {
  const initial = await runPersistedFriendRound();
  try {
    await waitForFullDisconnect();
    await runPersistedFriendRound(initial.backups,initial.keys);
    result.dataset.state="passed";
    result.textContent="PASS: encrypted .tox saved identities restored both native friends, reconnected and exchanged text";
  } finally {
    for (const ciphertext of Object.values(initial.backups||{}))
      ciphertext.fill(0);
  }
}

(async () => {
  if (mode === "restart") {
    await runSavedataRestart();
    return;
  }
  const a = spawn("a"), b = spawn("b");
  instances.set("a", a); instances.set("b", b);
  const all = [a, b];
  try {
    for (const c of all) c.post("START", {role:c.role, mode});
    const [ar, br] = await Promise.all(all.map(c => c.wait("READY")));
    if (!/^[0-9a-f]{64}$/.test(ar.publicKey) ||
        !/^[0-9a-f]{64}$/.test(br.publicKey) ||
        ar.publicKey === br.publicKey) throw Error("duplicate_or_invalid_native_dht_id");
    if (mode !== "raw" &&
        (!/^[0-9a-f]{64}$/.test(ar.cryptoPublicKey) ||
         !/^[0-9a-f]{64}$/.test(br.cryptoPublicKey) ||
         ar.cryptoPublicKey === br.cryptoPublicKey)) {
      throw Error("duplicate_or_invalid_native_net_crypto_public");
    }
    a.post("ROUTE", {peerPublicKey:br.publicKey,peerCryptoPublicKey:br.cryptoPublicKey});
    b.post("ROUTE", {peerPublicKey:ar.publicKey,peerCryptoPublicKey:ar.cryptoPublicKey});
    await Promise.all(all.map(c => c.wait("ROUTED")));
    for (const c of all) c.post("SEND");
    await Promise.all(all.map(c => c.wait("SENT")));
    const packets = await Promise.all(all.map(c => c.wait("RECEIVED")));
    for (const [i, c] of all.entries()) {
      const got = packets[i].bytes;
      const expected = mode === "friend"
        ? Array.from(new TextEncoder().encode(FRIEND_TEXT[c.role === "a" ? "b" : "a"]))
        : EXPECTED[c.role];
      if (!Array.isArray(got) || got.length !== expected.length ||
          !got.every((v, j) => v === expected[j])) {
        throw Error("dual_native_route_payload_mismatch_" + c.role);
      }
    }
    result.dataset.state = "passed";
    result.textContent = mode === "friend"
      ? "PASS: two original Tox friends online and tox_friend_send_message callback delivered text"
      : mode === "crypto"
      ? "PASS: two original Net_Crypto sessions authenticated end-to-end and exchanged lossless packets"
      : "PASS: two independent native WASM clients exchanged routed binary data";
  } finally {
    for (const c of all) c.stop();
  }
})().catch(error => {
  result.dataset.state = "failed";
  result.textContent = "FAIL: " + String(error?.message || error).replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 140);
  for (const c of instances.values()) c.stop();
});
