/**
 * Dedicated Worker: experimental original Toxcore WASM identity lifecycle.
 * No HTTP requests, no native Tox network access, no plaintext savedata RPC.
 */
import createModule from "../dist/tox_identity.mjs";
import { BrowserToxIdentity } from "./identity-client.mjs";
import { BrowserToxSession } from "./session-client.mjs";

let instancePromise;
function core() {
  if (!instancePromise) {
    instancePromise = createModule().then(wasm => ({
      identity: new BrowserToxIdentity(wasm),
      session: new BrowserToxSession(wasm)
    }));
  }
  return instancePromise;
}

let pollTimer = null;
function stopPolling() {
  if (pollTimer !== null) clearTimeout(pollTimer);
  pollTimer = null;
}
function schedulePolling(session) {
  stopPolling();
  if (!session.active) return;
  const poll = () => {
    pollTimer = null;
    if (!session.active) return;
    try {
      session.iterate();
      // Web Worker timers, NOT blocking emscripten socket calls.
      const delay = Math.min(1000, Math.max(50, session.iterationInterval()));
      pollTimer = setTimeout(poll, delay);
    } catch {
      stopPolling();
      session.close();
      // Do not leak error or secrets to a public API; worker remains idle.
    }
  };
  const delay = Math.min(1000, Math.max(50, session.iterationInterval()));
  pollTimer = setTimeout(poll, delay);
}

self.addEventListener("message", async event => {
  const message = event.data;
  if (!message || !Number.isSafeInteger(message.id)) return;
  try {
    const { identity, session } = await core();
    if (message.action === "CREATE_ENCRYPTED_BACKUP") {
      const result = await identity.createEncryptedBackup(message.password);
      self.postMessage({ id: message.id, ok: true, ...result }, [result.encryptedBackup.buffer]);
    } else if (message.action === "INSPECT_ENCRYPTED_BACKUP") {
      const result = await identity.inspectEncryptedBackup(message.encryptedBackup, message.password);
      self.postMessage({ id: message.id, ok: true, ...result });
    } else if (message.action === "SESSION_START_NEW") {
      const result = session.startNew();
      schedulePolling(session);
      self.postMessage({ id: message.id, ok: true, ...result });
    } else if (message.action === "SESSION_RESTORE_ENCRYPTED") {
      const result = session.restoreEncrypted(message.encryptedBackup, message.password);
      schedulePolling(session);
      self.postMessage({ id: message.id, ok: true, ...result });
    } else if (message.action === "SESSION_SET_NAME") {
      session.setName(message.name);
      self.postMessage({ id: message.id, ok: true, name: session.getName() });
    } else if (message.action === "SESSION_GET_NAME") {
      self.postMessage({ id: message.id, ok: true, name: session.getName() });
    } else if (message.action === "SESSION_EXPORT_ENCRYPTED") {
      const result = session.exportEncrypted(message.password);
      self.postMessage({ id: message.id, ok: true, ...result }, [result.encryptedBackup.buffer]);
    } else if (message.action === "SESSION_CLOSE") {
      stopPolling();
      session.close();
      self.postMessage({ id: message.id, ok: true, closed: true });
    } else {
      throw new TypeError("unsupported_identity_action");
    }
  } catch (error) {
    const code = String(error?.message || "operation_failed");
    // Only operation/error identifiers, never log password or backup content.
    self.postMessage({ id: message.id, ok: false, error: code.slice(0, 100) });
  }
});
