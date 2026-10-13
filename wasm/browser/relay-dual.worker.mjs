/**
 * One native c-toxcore WASM instance per Chromium Dedicated Worker.
 * Strictly opt-in localhost research fixture, NEVER production transport.
 */
import createModule from "../dist/tox_identity.mjs";
import { RelayResearchHarness } from "./relay-research-client.mjs";

const TOKEN = "d".repeat(64); // loopback test-only credential
const PAYLOAD = {
  a: Uint8Array.from([0, 1, 128, 255, 7]),
  b: Uint8Array.from([255, 128, 1, 0, 9])
};
const hex = data => Array.from(data, value => value.toString(16).padStart(2, "0")).join("");
function fromHex(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw Error("invalid_dual_peer_public_key");
  }
  return Uint8Array.from({ length: 32 }, (_, i) =>
    parseInt(value.slice(i * 2, i * 2 + 2), 16));
}
let h, role, timer, phase = "new", started = false, terminated = false;
let cryptoMode = false;
function announce(type, extra = {}) {
  self.postMessage({ type, role, ...extra });
}
function abort(error) {
  if (terminated) return;
  terminated = true;
  if (timer !== undefined) clearInterval(timer);
  try { h?.close(); } catch { /* teardown */ }
  announce("ERROR", { error: String(error?.message || error).replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 110) });
}
function tick() {
  if (terminated || !h) return;
  try {
    h.iterate();
    if (phase === "connecting" && h.connectedRelays() === 1) {
      phase = "ready";
      announce("READY", { publicKey: hex(h.dhtPublicKey()),
        cryptoPublicKey: cryptoMode ? hex(h.netCryptoPublicKey()) : null });
    }
    if (phase === "routing") {
      if (cryptoMode) {
        const state = h.netCryptoState();
        if (state.online === 1 && state.routes === 1) {
          phase = "routed";
          announce("ROUTED", { cryptoOnline: true });
        }
      } else if (h.routeOnlineCount() === 1) {
        h.enableRouteCapture();
        phase = "routed";
        announce("ROUTED");
      }
    }
    if (phase === "routed" || phase === "sent") {
      const packet = cryptoMode ? h.takeNetCryptoPayload() : h.takeRoutePayload();
      if (packet) {
        phase = "received";
        announce("RECEIVED", { bytes: Array.from(packet) });
      }
    }
    const stats = h.stats();
    if (stats.closes || stats.socketState !== 2) {
      throw Error("dual_native_connection_closed");
    }
  } catch (error) { abort(error); }
}
self.addEventListener("message", async ({data}) => {
  if (terminated) return;
  const action = data?.action;
  try {
    if (action === "START") {
      if (started || !["a", "b"].includes(data?.role) ||
          !/^http:\/\/127\.0\.0\.1:[0-9]{2,5}$/.test(self.location.origin)) {
        throw Error("invalid_dual_worker_start");
      }
      started = true;
      role = data.role;
      if (data.mode !== "raw" && data.mode !== "crypto") throw Error("invalid_dual_mode");
      cryptoMode = data.mode === "crypto";
      const response = await fetch("/__wtox_dual_public", {
        credentials: "omit", cache: "no-store", redirect: "error"
      });
      if (!response.ok) throw Error("dual_relay_key_unavailable");
      const publicKey = fromHex((await response.text()).trim());
      h = new RelayResearchHarness(await createModule());
      h.startWithRelayPublicKey(publicKey);
      await h.attach("ws://" + self.location.host +
                     "/__wtox_dual_relay?role=" + role, TOKEN);
      if (terminated) { h.close(); return; }
      phase = "connecting";
      timer = setInterval(tick, 15);
      tick();
    } else if (action === "ROUTE" && phase === "ready") {
      if (cryptoMode)
        h.beginNetCrypto(fromHex(data?.peerCryptoPublicKey),
                         fromHex(data?.peerPublicKey));
      else
        h.registerSyntheticRoute(fromHex(data?.peerPublicKey));
      phase = "routing";
    } else if (action === "SEND" && phase === "routed") {
      if (cryptoMode) h.sendNetCryptoPayload(PAYLOAD[role]);
      else h.sendRoutePayload(PAYLOAD[role]);
      phase = "sent";
      announce("SENT");
    } else if (action === "STOP" && started) {
      terminated = true;
      clearInterval(timer);
      h?.close();
      announce("STOPPED");
    } else {
      throw Error("invalid_dual_worker_transition");
    }
  } catch (error) { abort(error); }
});
