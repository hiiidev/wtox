/**
 * Actual Chromium Dedicated Worker -> compiled C WASM virtual TCP FIFO ->
 * browser WebSocket -> loopback Node TCP byte echo.
 * Not a Tox relay/peer interoperability test.
 */
const result = document.querySelector("#result");
const worker = new Worker(new URL("../browser/virtual-tcp-test.worker.mjs", import.meta.url), { type: "module" });
let sequence = 0;
function rpc(action, args = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { clean(); reject(Error("vtcp_worker_timeout")); }, 12000);
    const onMsg = ({ data }) => {
      if (data?.id !== id) return;
      clean();
      if (data.ok) resolve(data);
      else reject(Error(data.error || "vtcp_worker_failed"));
    };
    const onError = () => { clean(); reject(Error("vtcp_worker_load_failed")); };
    function clean() {
      clearTimeout(timer);
      worker.removeEventListener("message", onMsg);
      worker.removeEventListener("error", onError);
    }
    worker.addEventListener("message", onMsg);
    worker.addEventListener("error", onError);
    worker.postMessage({ id, action, ...args });
  });
}
async function run() {
  const url = "ws://" + location.host + "/__wtox_vtcp_experiment";
  const token = "a".repeat(64); // local test-only value, never user credentials
  await rpc("OPEN", { url, token });
  const bytes = Uint8Array.from({ length: 8199 }, (_, i) => i % 256);
  bytes.set([0, 1, 127, 128, 255], 400);
  const reply = await rpc("SEND", { bytes });
  if (reply.written !== bytes.length || reply.queued !== bytes.length) {
    throw Error("vtcp_wasm_stream_not_queued");
  }
  let got = [];
  let size = 0;
  const end = Date.now() + 8000;
  while (size < bytes.length && Date.now() < end) {
    const next = await rpc("READ");
    if (next.pending) {
      await new Promise(resolve => setTimeout(resolve, 20));
      continue;
    }
    if (!(next.bytes instanceof Uint8Array)) throw Error("invalid_vtcp_received_bytes");
    got.push(next.bytes);
    size += next.bytes.length;
  }
  if (size !== bytes.length) throw Error("vtcp_incomplete_echo");
  const received = new Uint8Array(size);
  let i = 0;
  for (const chunk of got) { received.set(chunk, i); i += chunk.length; }
  if (!received.every((value, index) => value === bytes[index])) {
    throw Error("vtcp_binary_bytes_corrupted");
  }
  received.fill(0);
  bytes.fill(0);
  await rpc("CLOSE");
  result.dataset.state = "passed";
  result.textContent = "PASS: WASM virtual TCP + browser Worker + WebSocket localhost byte echo";
}
run().catch(error => {
  result.dataset.state = "failed";
  result.textContent = "FAIL: " + String(error.message).replace(/[^a-zA-Z0-9_:.-]/g, "_");
}).finally(() => worker.terminate());
