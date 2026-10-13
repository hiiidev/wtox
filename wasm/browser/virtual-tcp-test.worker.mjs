/**
 * Opt-in loopback-only experimental bridge proof. NOT the production Tox
 * identity Worker; native Tox network functions are NOT injected here.
 */
import createModule from "../dist/tox_identity.mjs";
import { NativeVirtualTcp } from "./native-virtual-tcp.mjs";
let vt;
let initializing;
function session() {
  if (!initializing) initializing = createModule().then(wasm => new NativeVirtualTcp(wasm));
  return initializing;
}
self.addEventListener("message", async event => {
  const { id, action } = event.data || {};
  if (!Number.isSafeInteger(id)) return;
  try {
    vt = await session();
    if (action === "OPEN") {
      // Strict test-only loopback endpoint. Never generalize to arbitrary URLs.
      const url = String(event.data.url || "");
      if (!/^ws:\/\/127\.0\.0\.1:[0-9]{2,5}\/__wtox_vtcp_experiment$/.test(url)) {
        throw new Error("loopback_only");
      }
      await vt.connect(url, event.data.token);
      self.postMessage({ id, ok: true, state: vt.state });
    } else if (action === "SEND") {
      const bytes = event.data.bytes;
      if (!(bytes instanceof Uint8Array)) throw new Error("invalid_bytes");
      const written = vt.send(bytes);
      const queued = vt.pump();
      self.postMessage({ id, ok: true, written, queued });
    } else if (action === "READ") {
      const bytes = vt.read();
      if (bytes === null) {
        self.postMessage({ id, ok: true, pending: true });
      } else {
        self.postMessage({ id, ok: true, bytes }, [bytes.buffer]);
      }
    } else if (action === "CLOSE") {
      vt.close();
      self.postMessage({ id, ok: true });
    } else {
      throw new Error("unsupported_action");
    }
  } catch (error) {
    self.postMessage({ id, ok: false,
      error: String(error?.message || "operation_failed").replace(/[^a-zA-Z0-9_.:-]/g, "").slice(0, 80) });
  }
});
