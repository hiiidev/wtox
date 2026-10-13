/**
 * Runs four real-browser synthetic Relay scenarios, one Worker per mode.
 * Nodes/servers listen to localhost exclusively, never the Internet.
 */
const result = document.querySelector("#result");
async function exercise(mode) {
  const worker = new Worker(
    new URL("../browser/relay-browser-research.worker.mjs", import.meta.url),
    { type: "module" }
  );
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { clean(); reject(Error("research_worker_timeout")); }, 22000);
      const onMessage = ({ data }) => {
        if (data?.id !== mode + 1) return;
        clean();
        if (data.ok) resolve(data);
        else reject(Error(String(data.error || "research_failed")));
      };
      const onError = () => { clean(); reject(Error("research_worker_script_error")); };
      function clean() {
        clearTimeout(timer);
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
      }
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
      worker.postMessage({
        id: mode + 1, action: "RUN", mode,
        url: "ws://" + location.host + "/__wtox_relay_research"
      });
    });
  } finally { worker.terminate(); }
}
(async () => {
  for (const mode of [0, 3, 1, 2]) {
    const stats = await exercise(mode);
    if (stats.nativeSocketCalls !== 1 || stats.nativeRecvCalls < 1 ||
        !stats.noPeerOnline || ((mode === 0 || mode === 3) !== (stats.nativeClosed === 0))) {
      throw Error("research_browser_mode_failed_" + mode);
    }
  }
  result.dataset.state = "passed";
  result.textContent = "PASS: original Toxcore in Chromium Worker, WS and Node TCP synthetic encrypted relay";
})().catch(error => {
  result.dataset.state = "failed";
  result.textContent = "FAIL:" + String(error?.message || error).replace(/[^a-zA-Z0-9_:.-]/g, "_").slice(0, 100);
});
