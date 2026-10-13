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
      if (stats.recvs > 0 && stats.rxBuffered === 0) {
        if (mode > 1 && stats.closes > 0) break;
        if (mode <= 1 && stats.closes === 0 && stats.sends >= 2) {
          // Independent Node owns the post-handshake ephemeral key and
          // validates original Toxcore's encrypted PONG, not just bytes.
          const proof = await fetch("/__wtox_independent_stats?mode=" + mode, {
            cache: "no-store", credentials: "omit"
          });
          if (proof.status !== 200) throw Error("encrypted_pong_proof_unavailable");
          const counts = await proof.json();
          if (counts.pings === 1 && counts.pongs === 1 &&
              counts.nativePingReplies >= 1) break;
        }
      }
    } while (Date.now() < end);
    if (!stats || stats.recvs < 1 || stats.rxBuffered !== 0 ||
        stats.sockets !== 1 || stats.connects !== 1 || stats.toxConnection !== 0 ||
        stats.sends < 1) throw Error("independent_handshake_not_processed");
    if (mode <= 1) {
      if (stats.closes !== 0 || stats.socketState !== 2 ||
          stats.sends < 2 || stats.recvs < 2) {
        const p = await fetch("/__wtox_independent_stats?mode=" + mode, {cache:"no-store"});
        const counts = p.ok ? await p.json() : {pings:-1,pongs:-1};
        throw Error("independent_encrypted_ping_pong_failed:s" + stats.sends +
          ":r" + stats.recvs + ":c" + stats.closes + ":v" + stats.socketState +
          ":p" + counts.pings + ":o" + counts.pongs);
      }
      const p = await fetch("/__wtox_independent_stats?mode=" + mode, {cache:"no-store"});
      const counters = await p.json();
      if (counters.pings !== 1 || counters.pongs !== 1 ||
          counters.nativePingReplies < 1) {
        throw Error("independent_pong_not_authenticated");
      }

      // Ask ORIGINAL c-toxcore TCP_Connections to emit a real encrypted
      // ROUTING_REQUEST for one synthetic peer key, and wait for the
      // Node-owned relay's ROUTING_RESPONSE + CONNECTION_NOTIFICATION.
      const syntheticPeer = Uint8Array.from({length:32}, (_,i) => i+41);
      h.registerSyntheticRoute(syntheticPeer);
      const until = Date.now() + 4000;
      let routeProof;
      do {
        h.iterate();
        const proof = await fetch("/__wtox_independent_stats?mode=" + mode, {cache:"no-store"});
        routeProof = await proof.json();
        if (routeProof.routeRequests === 1 &&
            routeProof.routeNotifications === 1 &&
            h.routeOnlineCount() === 1) break;
        await wait(20);
      } while (Date.now() < until);
      if (routeProof.routeRequests !== 1 ||
          routeProof.routeNotifications !== 1 || h.routeOnlineCount() !== 1) {
        throw Error("independent_routing_exchange_failed:q" +
          routeProof.routeRequests + ":n" + routeProof.routeNotifications +
          ":online" + h.routeOnlineCount());
      }
      // The original native TCP_Connections layer (not a JS WebSocket
      // frame) now sends this bounded binary route payload. The Node
      // fixture must independently decrypt it, then encrypt an echo.
      // Capture intentionally replaces the Net_Crypto callback ONLY in
      // this single-use synthetic test instance.
      h.enableRouteCapture();
      const payload = Uint8Array.from([0, 1, 127, 128, 254, 255]);
      h.sendRoutePayload(payload);
      const dataDeadline = Date.now() + 4000;
      let received = null, dataProof;
      do {
        h.iterate();
        received = h.takeRoutePayload();
        const proof = await fetch("/__wtox_independent_stats?mode=" + mode,
                                  {cache: "no-store"});
        if (!proof.ok) throw Error("route_payload_stats_unavailable");
        dataProof = await proof.json();
        if (received !== null && dataProof.routePayloads === 1 &&
            dataProof.routeEchoes === 1) break;
        await wait(20);
      } while (Date.now() < dataDeadline);
      if (!received || received.length !== payload.length ||
          !received.every((value, index) => value === payload[index]) ||
          dataProof.routePayloads !== 1 || dataProof.routeEchoes !== 1) {
        throw Error("independent_routed_binary_exchange_failed");
      }
      // This is *transport-level* route data: Node can decrypt the bytes.
      // It does not establish Tox friend status or E2E message delivery.
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
