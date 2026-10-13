/**
 * Standalone, single-use Chromium research Worker.
 * Relay long-term secret key lives ONLY in an independent Node TCP fixture.
 * Browser receives 32-byte public key via same-origin localhost GET.
 *
 * Not imported by the normal Tox identity Worker or any shipped UI.
 */
import createModule from "../dist/tox_identity.mjs";
import { RelayResearchHarness } from "./relay-research-client.mjs";

const TOKEN = "c".repeat(64); // fixture constant, never a production secret
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let used = false;

self.addEventListener("message", async ({ data }) => {
  const { id, action, mode } = data || {};
  if (!Number.isSafeInteger(id)) return;
  if (used || action !== "RUN" || !Number.isInteger(mode) || mode < 0 || mode > 3 ||
      !/^http:\/\/127\.0\.0\.1:[0-9]{2,5}$/.test(self.location.origin)) {
    self.postMessage({ id, ok: false, error: "invalid_independent_relay_request" });
    return;
  }
  used = true;
  let h;
  try {
    const keyResponse = await fetch("/__wtox_independent_public", {
      cache: "no-store", credentials: "omit", redirect: "error"
    });
    if (keyResponse.status !== 200) throw Error("relay_public_key_unavailable");
    const hex = await keyResponse.text();
    if (!/^[a-f0-9]{64}$/i.test(hex)) throw Error("invalid_remote_relay_public_key");
    const key = new Uint8Array(32);
    for (let i = 0; i < 32; i++) key[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    const wasm = await createModule();
    h = new RelayResearchHarness(wasm);
    h.startWithRelayPublicKey(key);
    if (h.stats().connects !== 1 || h.state !== 1) throw Error("native_relay_connect_failed");
    await h.attach(
      "ws://" + self.location.host + "/__wtox_independent_relay?mode=" + mode,
      TOKEN
    );
    h.iterate();
    const end = Date.now() + 8000;
    let stats;
    do {
      await wait(20); // ws data arrives between native iterations
      h.iterate();
      stats = h.stats();
      if (stats.recvs > 0 && stats.rxBuffered === 0 &&
          (mode <= 1 ? stats.closes === 0 : stats.closes > 0)) break;
    } while (Date.now() < end);
    if (!stats || stats.recvs < 1 || stats.rxBuffered !== 0 ||
        stats.sockets !== 1 || stats.connects !== 1 || stats.toxConnection !== 0 ||
        stats.sends < 1) throw Error("independent_handshake_not_processed");
    if (mode <= 1) {
      if (stats.closes !== 0 || stats.socketState !== 2)
        throw Error("independent_valid_relay_rejected");
    } else if (stats.closes < 1 || stats.socketState === 2) {
      throw Error("independent_invalid_relay_accepted");
    }
    self.postMessage({
      id, ok: true, mode, sends: stats.sends, recvs: stats.recvs,
      closed: stats.closes, noPeerOnline: stats.toxConnection === 0
    });
  } catch (error) {
    self.postMessage({
      id, ok: false,
      error: String(error?.message || "independent_relay_failed").replace(/[^a-zA-Z0-9_:.-]/g,"_").slice(0,105)
    });
  } finally {
    h?.close();
  }
});
