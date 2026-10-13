/**
 * ISOLATED RESEARCH ONLY. A persistent original Toxcore TCP Relay client
 * drives the native virtual socket, and an async transport drives the
 * response between two native tox_iterate() calls.
 *
 * The C injected Network_Funcs permits only one synthetic TEST-NET relay.
 * This module is intentionally NOT imported by the identity worker or app.
 */
import { NativeVirtualTcp, VirtualTcpState } from "./native-virtual-tcp.mjs";

const required = ["_malloc", "_free", "_wtox_research_start",
  "_wtox_research_tick", "_wtox_research_stats",
  "_wtox_research_start_with_relay_public_key",
  "_wtox_research_make_reply", "_wtox_research_stop"];
const statsNames = ["sockets", "connects", "sends", "recvs", "closes",
  "txPending", "rxBuffered", "socketState", "toxConnection"];

export class RelayResearchHarness {
  #module;
  #tcp;
  #started = false;
  constructor(module) {
    if (!module || required.some(name => typeof module[name] !== "function")) {
      throw new TypeError("invalid_relay_research_wasm");
    }
    this.#module = module;
    this.#tcp = new NativeVirtualTcp(module);
  }
  get state() { return this.#tcp.state; }
  get pending() { return this.#tcp.pending; }
  start() {
    if (this.#started) throw new Error("relay_research_already_started");
    const code = this.#module._wtox_research_start();
    if (code !== 0) throw new Error("relay_research_start_failed:" + code);
    this.#started = true;
    if (this.state !== VirtualTcpState.CONNECTING) {
      this.close();
      throw new Error("relay_research_no_native_connect");
    }
  }
  /** Use only the independent localhost Relay's PUBLIC key; never a secret. */
  startWithRelayPublicKey(publicKey) {
    if (this.#started) throw new Error("relay_research_already_started");
    if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32) {
      throw new TypeError("invalid_relay_public_key");
    }
    const m = this.#module;
    const ptr = m._malloc(32);
    if (!ptr) throw new Error("relay_research_out_of_memory");
    try {
      m.HEAPU8.set(publicKey, ptr);
      const code = m._wtox_research_start_with_relay_public_key(ptr, 32);
      if (code !== 0) throw new Error("relay_research_start_failed:" + code);
      this.#started = true;
      if (this.state !== VirtualTcpState.CONNECTING) {
        this.close();
        throw new Error("relay_research_no_native_connect");
      }
    } finally {
      m.HEAPU8.fill(0, ptr, ptr + 32);
      m._free(ptr);
    }
  }
  async attach(url, token, options = {}) {
    if (!this.#started) throw new Error("relay_research_not_started");
    await this.#tcp.attachNativeConnect(url, token, options);
  }
  iterate({ pump = true } = {}) {
    if (!this.#started) throw new Error("relay_research_not_started");
    const code = this.#module._wtox_research_tick();
    if (code !== 0) throw new Error("relay_research_iterate_failed:" + code);
    return pump ? this.#tcp.pump() : 0;
  }
  pump() {
    if (!this.#started) throw new Error("relay_research_not_started");
    return this.#tcp.pump();
  }
  /** Native-only ephemeral fake server. No secret/private key crosses to JS. */
  makeSyntheticReply(mode = 0) {
    if (!this.#started) throw new Error("relay_research_not_started");
    if (!Number.isInteger(mode) || mode < 0 || mode > 2) {
      throw new TypeError("invalid_synthetic_reply_mode");
    }
    const m = this.#module;
    const capacity = 96;
    const ptr = m._malloc(capacity);
    if (!ptr) throw new Error("relay_research_out_of_memory");
    try {
      const n = m._wtox_research_make_reply(mode, ptr, capacity);
      if (n !== capacity) throw new Error("relay_research_reply_failed:" + n);
      return m.HEAPU8.slice(ptr, ptr + n);
    } finally {
      m.HEAPU8.fill(0, ptr, ptr + capacity);
      m._free(ptr);
    }
  }
  stats() {
    if (!this.#started) throw new Error("relay_research_not_started");
    const m = this.#module;
    const ptr = m._malloc(9 * 4);
    if (!ptr) throw new Error("relay_research_out_of_memory");
    try {
      if (m._wtox_research_stats(ptr) !== 0) throw new Error("relay_research_stats_failed");
      const view = new DataView(m.HEAPU8.buffer);
      return Object.fromEntries(statsNames.map((name, i) =>
        [name, view.getUint32(ptr + 4 * i, true)]));
    } finally {
      m.HEAPU8.fill(0, ptr, ptr + 36);
      m._free(ptr);
    }
  }
  close() {
    // The native Tox object must be destroyed while injected callback
    // context is still alive, before resetting/closing the socket bridge.
    this.#module._wtox_research_stop();
    this.#tcp.close();
    this.#started = false;
  }
}
