/**
 * TEST ONLY. Genuine c-toxcore WASM runs in Chromium Dedicated Worker.
 * Synthetic Relay private key stays inside its native WASM memory.
 *
 * The test-only encrypted server ciphertext is sent via a same-origin
 * localhost fixture endpoint, which uses a local TCP socket to return it.
 * No real relay, public proxy or identity application uses this module.
 */
import createModule from "../dist/tox_identity.mjs";
import { RelayResearchHarness } from "./relay-research-client.mjs";

const TOKEN = "b".repeat(64); // test fixture only, not a real credential
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let used = false;
self.addEventListener("message", async ({ data }) => {
  const { id, action, mode, url } = data || {};
  if (!Number.isSafeInteger(id)) return;
  if (used || action !== "RUN" || !Number.isInteger(mode) || mode < 0 || mode > 3 ||
      typeof url !== "string" || !/^ws:\/\/127\.0\.0\.1:[0-9]{2,5}\/__wtox_relay_research$/.test(url) ||
      url !== self.location.origin.replace(/^http/, "ws") + "/__wtox_relay_research") {
    self.postMessage({ id, ok: false, error: "invalid_research_request" });
    return;
  }
  used = true; // single-use worker, no reentrant native instance
  let harness, response;
  try {
    const wasm = await createModule();
    harness = new RelayResearchHarness(wasm);
    harness.start();
    if (harness.stats().connects !== 1) throw Error("native_did_not_connect");
    await harness.attach(url, TOKEN);
    // Genuine native Toxcore creates its hello after the async WS handshake.
    harness.iterate({ pump: false });
    if (harness.pending !== 128) throw Error("incorrect_native_hello_length");
    response = harness.makeSyntheticReply(mode === 3 ? 0 : mode);
    const registered = await fetch("/__wtox_relay_fixture", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Wtox-Research-Token": TOKEN,
        "X-Wtox-Research-Mode": String(mode)
      },
      body: response
    });
    if (registered.status !== 204) throw Error("fixture_registration_failed");
    response.fill(0);
    response = null;
    if (harness.pump() !== 128) throw Error("native_hello_not_sent");
    const end = Date.now() + 5000;
    let stats;
    do {
      await sleep(25); // WebSocket receive callback runs BETWEEN iterations
      harness.iterate();
      stats = harness.stats();
      if (stats.recvs > 0 && stats.rxBuffered === 0 &&
          (mode === 0 || mode === 3 ? stats.closes === 0 : stats.closes > 0)) break;
    } while (Date.now() < end);
    if (!stats || stats.recvs < 1 || stats.rxBuffered !== 0 ||
        stats.sockets !== 1 || stats.connects !== 1 || stats.toxConnection !== 0) {
      throw Error("relay_response_not_processed");
    }
    if (mode === 0 || mode === 3) {
      if (stats.closes !== 0 || stats.socketState !== 2) {
        throw Error("valid_relay_response_rejected");
      }
    } else if (stats.closes < 1 || stats.socketState === 2) {
      throw Error("invalid_relay_response_accepted");
    }
    self.postMessage({
      id, ok: true, mode, nativeSocketCalls: stats.sockets,
      nativeRecvCalls: stats.recvs, nativeClosed: stats.closes,
      noPeerOnline: stats.toxConnection === 0
    });
  } catch (error) {
    self.postMessage({
      id, ok: false,
      error: String(error?.message || "research_error").replace(/[^a-zA-Z0-9_:-]/g, "_").slice(0, 100)
    });
  } finally {
    response?.fill(0);
    harness?.close();
  }
});
