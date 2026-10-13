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
  "_wtox_research_make_reply", "_wtox_research_stop",
  "_wtox_research_add_route", "_wtox_research_route_online_count",
  "_wtox_research_enable_route_capture", "_wtox_research_send_route_packet",
  "_wtox_research_take_route_packet", "_wtox_research_get_dht_public",
  "_wtox_research_connected_relays", "_wtox_research_get_crypto_public",
  "_wtox_research_begin_crypto", "_wtox_research_crypto_status_get",
  "_wtox_research_crypto_send", "_wtox_research_crypto_recv"];
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
  /** Original client DHT identity; the native TCP hello uses the same key. */
  dhtPublicKey() {
    if (!this.#started) throw new Error("relay_research_not_started");
    const m = this.#module;
    const ptr = m._malloc(32);
    if (!ptr) throw new Error("relay_research_out_of_memory");
    try {
      const code = m._wtox_research_get_dht_public(ptr);
      if (code !== 0) throw new Error("relay_research_dht_key_failed:" + code);
      return m.HEAPU8.slice(ptr, ptr + 32);
    } finally {
      m.HEAPU8.fill(0, ptr, ptr + 32);
      m._free(ptr);
    }
  }
  connectedRelays() {
    if (!this.#started) throw new Error("relay_research_not_started");
    return this.#module._wtox_research_connected_relays();
  }
  /** Original native Net_Crypto public key, not the DHT route key. */
  netCryptoPublicKey() {
    if (!this.#started) throw Error("relay_research_not_started");
    const m=this.#module, p=m._malloc(32);
    if (!p) throw Error("relay_research_out_of_memory");
    try {
      if (m._wtox_research_get_crypto_public(p,32)!==0) throw Error("crypto_public_failed");
      return m.HEAPU8.slice(p,p+32);
    } finally {m.HEAPU8.fill(0,p,p+32);m._free(p);}
  }
  beginNetCrypto(realKey,dhtKey) {
    if (!this.#started) throw Error("relay_research_not_started");
    if (![realKey,dhtKey].every(k=>k instanceof Uint8Array&&k.length===32))
      throw TypeError("invalid_net_crypto_peer_keys");
    const m=this.#module,p=m._malloc(64);
    if (!p) throw Error("relay_research_out_of_memory");
    try {
      m.HEAPU8.set(realKey,p);m.HEAPU8.set(dhtKey,p+32);
      const code=m._wtox_research_begin_crypto(p,p+32,32);
      if(code!==0)throw Error("begin_net_crypto_failed:"+code);
    } finally {m.HEAPU8.fill(0,p,p+64);m._free(p);}
  }
  netCryptoState() {
    if (!this.#started) throw Error("relay_research_not_started");
    const m=this.#module,p=m._malloc(16);
    if (!p) throw Error("relay_research_out_of_memory");
    try {
      if(m._wtox_research_crypto_status_get(p)!==0)throw Error("net_crypto_state_failed");
      const v=new DataView(m.HEAPU8.buffer);
      return {online:v.getUint32(p,true),connects:v.getUint32(p+4,true),
        disconnects:v.getUint32(p+8,true),routes:v.getUint32(p+12,true)};
    } finally {m.HEAPU8.fill(0,p,p+16);m._free(p);}
  }
  sendNetCryptoPayload(bytes) {
    if (!this.#started) throw Error("relay_research_not_started");
    if (!(bytes instanceof Uint8Array)||bytes.length<1||bytes.length>=128)
      throw TypeError("invalid_net_crypto_payload");
    const m=this.#module,p=m._malloc(bytes.length);
    if(!p)throw Error("relay_research_out_of_memory");
    try {
      m.HEAPU8.set(bytes,p);
      const c=m._wtox_research_crypto_send(p,bytes.length);
      if(c!==0)throw Error("net_crypto_send_failed:"+c);
    } finally {m.HEAPU8.fill(0,p,p+bytes.length);m._free(p);}
  }
  takeNetCryptoPayload() {
    if (!this.#started) throw Error("relay_research_not_started");
    const m=this.#module,p=m._malloc(128);
    if(!p)throw Error("relay_research_out_of_memory");
    try {
      const n=m._wtox_research_crypto_recv(p,128);
      if(n<0||n>128)throw Error("net_crypto_receive_failed:"+n);
      return n?m.HEAPU8.slice(p,p+n):null;
    } finally {m.HEAPU8.fill(0,p,p+128);m._free(p);}
  }
  /** Test-only one-target route registration via ORIGINAL c-toxcore. */
  registerSyntheticRoute(peerPublicKey) {
    if (!this.#started) throw new Error("relay_research_not_started");
    if (!(peerPublicKey instanceof Uint8Array) || peerPublicKey.length !== 32) {
      throw new TypeError("invalid_synthetic_peer_key");
    }
    const m = this.#module;
    const ptr = m._malloc(32);
    if (!ptr) throw new Error("relay_research_out_of_memory");
    try {
      m.HEAPU8.set(peerPublicKey, ptr);
      const code = m._wtox_research_add_route(ptr, 32);
      if (code !== 0) throw new Error("relay_research_route_failed:" + code);
    } finally {
      m.HEAPU8.fill(0, ptr, ptr + 32);
      m._free(ptr);
    }
  }
  routeOnlineCount() {
    if (!this.#started) throw new Error("relay_research_not_started");
    return this.#module._wtox_research_route_online_count();
  }
  /** Take over the native TCP data callback ONLY for this isolated fixture. */
  enableRouteCapture() {
    if (!this.#started) throw new Error("relay_research_not_started");
    const code = this.#module._wtox_research_enable_route_capture();
    if (code !== 0) throw new Error("relay_research_capture_failed:" + code);
  }
  /** Send opaque research bytes using original TCP_Connections routing. */
  sendRoutePayload(bytes) {
    if (!this.#started) throw new Error("relay_research_not_started");
    if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > 128) {
      throw new TypeError("invalid_relay_route_payload");
    }
    const m = this.#module;
    const ptr = m._malloc(bytes.length);
    if (!ptr) throw new Error("relay_research_out_of_memory");
    try {
      m.HEAPU8.set(bytes, ptr);
      const code = m._wtox_research_send_route_packet(ptr, bytes.length);
      if (code !== 0) throw new Error("relay_research_route_send_failed:" + code);
    } finally {
      m.HEAPU8.fill(0, ptr, ptr + bytes.length);
      m._free(ptr);
    }
  }
  /** A null result means no callback packet yet, not an empty packet. */
  takeRoutePayload() {
    if (!this.#started) throw new Error("relay_research_not_started");
    const m = this.#module;
    const ptr = m._malloc(128);
    if (!ptr) throw new Error("relay_research_out_of_memory");
    try {
      const n = m._wtox_research_take_route_packet(ptr, 128);
      if (n < 0 || n > 128) throw new Error("relay_research_route_receive_failed:" + n);
      return n ? m.HEAPU8.slice(ptr, ptr + n) : null;
    } finally {
      m.HEAPU8.fill(0, ptr, ptr + 128);
      m._free(ptr);
    }
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
