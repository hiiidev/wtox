/**
 * Experimental Dedicated Worker entrypoint. No API calls and no private key
 * leaves the browser, except an *already encrypted* .tox backup on request.
 * Not imported by the production frontend until WASM build is verified.
 */
import createModule from "../dist/tox_identity.mjs";
import { BrowserToxIdentity } from "./identity-client.mjs";

let instancePromise;
async function core() {
  if (!instancePromise) {
    instancePromise = createModule().then(wasm => new BrowserToxIdentity(wasm));
  }
  return instancePromise;
}

self.addEventListener("message", async event => {
  const message = event.data;
  if (!message || !Number.isSafeInteger(message.id)) return;
  try {
    const identity = await core();
    if (message.action === "CREATE_ENCRYPTED_BACKUP") {
      const { toxId, encryptedBackup } =
        await identity.createEncryptedBackup(message.password);
      self.postMessage({
        id: message.id, ok: true, toxId, encryptedBackup
      }, [encryptedBackup.buffer]);
    } else if (message.action === "INSPECT_ENCRYPTED_BACKUP") {
      const result = await identity.inspectEncryptedBackup(
        message.encryptedBackup, message.password
      );
      self.postMessage({ id: message.id, ok: true, ...result });
    } else {
      throw new TypeError("unsupported_identity_action");
    }
  } catch (error) {
    self.postMessage({ id: message.id, ok: false, error: String(error.message || "operation_failed") });
  }
});
