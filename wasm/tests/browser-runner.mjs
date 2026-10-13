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
  // A real persistent instance, not the create/kill-only identity helper.
  const active = await rpc("SESSION_START_NEW", {});
  if (!/^[0-9A-F]{76}$/.test(active.toxId)) throw Error("invalid_live_tox_id");
  const nickname = "wTox 网页身份";
  const named = await rpc("SESSION_SET_NAME", { name: nickname });
  if (named.name !== nickname) throw Error("tox_live_name_failed");
  const exported = await rpc("SESSION_EXPORT_ENCRYPTED", { password });
  if (!(exported.encryptedBackup instanceof Uint8Array) ||
      exported.encryptedBackup.length <= 80) throw Error("invalid_live_export");
  await rpc("SESSION_CLOSE", {});
  let denied = false;
  try {
    await rpc("SESSION_RESTORE_ENCRYPTED", {
      encryptedBackup: exported.encryptedBackup, password: "not-the-right-password"
    });
  } catch (error) {
    denied = String(error.message).startsWith("tox_session_restore_failed");
  }
  if (!denied) throw Error("live_wrong_password_not_rejected");
  const reopened = await rpc("SESSION_RESTORE_ENCRYPTED", {
    encryptedBackup: exported.encryptedBackup, password
  });
  const readName = await rpc("SESSION_GET_NAME", {});
  if (reopened.toxId !== active.toxId || readName.name !== nickname) {
    throw Error("live_tox_identity_not_restored");
  }
  await rpc("SESSION_CLOSE", {});
  exported.encryptedBackup.fill(0);
  result.dataset.state = "passed";
  result.textContent = "PASS: real browser Dedicated Worker + native Toxcore WASM encrypted-backup roundtrip";
}
smoke().catch(error => {
  result.dataset.state = "failed";
  // Do not include arbitrary secret-bearing exception fields.
  result.textContent = "FAIL: " + String(error.message).replace(/[^a-zA-Z0-9_:.-]/g, "_");
}).finally(() => worker.terminate());
