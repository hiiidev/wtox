/**
 * Runs in a real Chromium page. No API calls, no native server identity.
 * Never records a secret/passphrase or unencrypted .tox Savedata.
 */
const result = document.querySelector("#result");
const worker = new Worker(new URL("../browser/tox-identity.worker.mjs", import.meta.url), {
  type: "module"
});
let sequence = 0;
function rpc(action, payload) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("wasm_worker_timeout"));
    }, 30000);
    const onError = () => {
      cleanup();
      reject(new Error("wasm_worker_failed_to_load"));
    };
    const onMessage = event => {
      if (event.data?.id !== id) return;
      cleanup();
      if (event.data.ok) resolve(event.data);
      else reject(new Error(String(event.data.error || "wasm_worker_operation_failed")));
    };
    function cleanup() {
      clearTimeout(timeout);
      worker.removeEventListener("error", onError);
      worker.removeEventListener("message", onMessage);
    }
    worker.addEventListener("error", onError);
    worker.addEventListener("message", onMessage);
    worker.postMessage({ id, action, ...payload });
  });
}
async function smoke() {
  const password = "browser-WASM-only-test-passphrase-2026";
  const created = await rpc("CREATE_ENCRYPTED_BACKUP", { password });
  if (!/^[0-9A-F]{76}$/.test(created.toxId) ||
      !(created.encryptedBackup instanceof Uint8Array)) {
    throw new Error("tox_wasm_browser_invalid_created_identity");
  }
  const restored = await rpc("INSPECT_ENCRYPTED_BACKUP", {
    encryptedBackup: created.encryptedBackup,
    password
  });
  if (restored.toxId !== created.toxId) {
    throw new Error("tox_wasm_browser_identity_mismatch");
  }
  let wrongPasswordRejected = false;
  try {
    await rpc("INSPECT_ENCRYPTED_BACKUP", {
      encryptedBackup: created.encryptedBackup,
      password: "wrong-password-that-is-long-enough"
    });
  } catch (error) {
    wrongPasswordRejected = String(error.message).startsWith("tox_wasm_import_failed");
  }
  created.encryptedBackup.fill(0);
  if (!wrongPasswordRejected) throw new Error("tox_wasm_browser_password_failure");
  result.dataset.state = "passed";
  result.textContent = "PASS: real browser Dedicated Worker + native Toxcore WASM encrypted-backup roundtrip";
}
smoke().catch(error => {
  result.dataset.state = "failed";
  // Do not include arbitrary secret-bearing exception fields.
  result.textContent = "FAIL: " + String(error.message).replace(/[^a-zA-Z0-9_:.-]/g, "_");
}).finally(() => worker.terminate());
