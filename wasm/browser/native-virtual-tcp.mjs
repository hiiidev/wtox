/**
 * Single-stream WASM/native synchronous socket <-> asynchronous WebSocket
 * bridge. RESEARCH ONLY: not injected into c-toxcore Network_Funcs.
 * The gateway is an operator-allowlisted TCP byte relay, NOT a public proxy.
 */
import { openExperimentalTcpTunnel } from "./tcp-tunnel.mjs";

const LIMIT = 65536;
const CHUNK = 16384;
const REQUIRED = ["reset", "begin", "connected", "fail", "close",
  "peer_closed", "state", "send", "tx_pending", "tx_peek", "tx_consume",
  "rx_free", "rx_push", "recv"].map(s => "_wtox_vtcp_" + s);
const alloc = (m, length) => {
  const ptr = m._malloc(length);
  if (!ptr) throw new Error("vtcp_out_of_memory");
  return { ptr, length };
};
function release(m, b) {
  if (!b) return;
  m.HEAPU8.fill(0, b.ptr, b.ptr + b.length);
  m._free(b.ptr);
}

export const VirtualTcpState = Object.freeze({
  IDLE: 0, CONNECTING: 1, OPEN: 2, CLOSED: 3, FAILED: 4
});

const ownedModules = new WeakSet();

export class NativeVirtualTcp {
  #m;
  #transport = null;
  #generation = 0;
  constructor(module) {
    if (!module || !(module.HEAPU8 instanceof Uint8Array) ||
        typeof module._malloc !== "function" || typeof module._free !== "function" ||
        REQUIRED.some(fn => typeof module[fn] !== "function") || ownedModules.has(module)) {
      throw new TypeError("invalid_or_owned_virtual_tcp_wasm");
    }
    this.#m = module;
    ownedModules.add(module);
    module._wtox_vtcp_reset();
  }
  get state() { return this.#m._wtox_vtcp_state(); }
  get pending() { return this.#m._wtox_vtcp_tx_pending(); }
  get rxFree() { return this.#m._wtox_vtcp_rx_free(); }

  #broken(generation) {
    if (generation !== this.#generation) return;
    this.#m._wtox_vtcp_fail();
    const transport = this.#transport;
    this.#transport = null;
    try { transport?.close(); } catch { /* already disconnected */ }
  }
  #onBytes(bytes, generation) {
    if (generation !== this.#generation || this.state !== VirtualTcpState.OPEN) return;
    if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > LIMIT ||
        bytes.length > this.rxFree) {
      this.#broken(generation);
      return;
    }
    const b = alloc(this.#m, bytes.length);
    try {
      this.#m.HEAPU8.set(bytes, b.ptr);
      if (this.#m._wtox_vtcp_rx_push(b.ptr, bytes.length) !== bytes.length) {
        this.#broken(generation);
      }
    } finally { release(this.#m, b); }
  }
  #onDisconnected(code, generation) {
    if (generation !== this.#generation) return;
    const state = this.state;
    if (code === 1000 && state === VirtualTcpState.OPEN) {
      this.#m._wtox_vtcp_peer_closed(); // buffered RX remains readable
    } else if (state === VirtualTcpState.OPEN || state === VirtualTcpState.CONNECTING) {
      this.#m._wtox_vtcp_fail();
    }
    this.#transport = null;
  }

  async connect(url, token, { tunnelFactory = openExperimentalTcpTunnel } = {}) {
    if (this.state !== VirtualTcpState.IDLE &&
        this.state !== VirtualTcpState.CLOSED &&
        this.state !== VirtualTcpState.FAILED) {
      throw new Error("vtcp_already_open");
    }
    if (typeof tunnelFactory !== "function") throw new TypeError("invalid_tunnel_factory");
    const generation = ++this.#generation;
    const started = this.#m._wtox_vtcp_begin();
    if (started !== 0) throw new Error("vtcp_begin_failed");
    try {
      const transport = await tunnelFactory(url, token, {
        onBytes: bytes => this.#onBytes(bytes, generation),
        onDisconnected: code => this.#onDisconnected(code, generation)
      });
      if (generation !== this.#generation || this.state !== VirtualTcpState.CONNECTING) {
        transport.close();
        throw new Error("vtcp_connect_cancelled");
      }
      if (!transport || typeof transport.send !== "function" ||
          typeof transport.close !== "function" || transport.closed) {
        throw new Error("vtcp_transport_not_ready");
      }
      this.#transport = transport;
      if (this.#m._wtox_vtcp_connected() !== 0) {
        this.#broken(generation);
        throw new Error("vtcp_connected_failed");
      }
    } catch {
      this.#broken(generation);
      throw new Error("vtcp_connect_failed");
    }
  }

  /** Analogous to native nonblocking send: returns written byte count. */
  send(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > LIMIT) {
      throw new TypeError("invalid_vtcp_send");
    }
    const b = alloc(this.#m, bytes.length);
    try {
      this.#m.HEAPU8.set(bytes, b.ptr);
      const written = this.#m._wtox_vtcp_send(b.ptr, bytes.length);
      if (written === -11) return 0; // would-block
      if (written <= 0 || written > bytes.length) throw new Error("vtcp_not_connected");
      return written;
    } finally { release(this.#m, b); }
  }

  /**
   * Accept native TX into the browser WebSocket send queue. Backpressure
   * preserves bytes in WASM for a later pump() rather than dropping them.
   * This is NOT a network-delivery acknowledgement.
   */
  pump({ maxChunks = 8 } = {}) {
    if (!Number.isInteger(maxChunks) || maxChunks < 1 || maxChunks > 32) {
      throw new TypeError("invalid_vtcp_pump_limit");
    }
    if (this.state !== VirtualTcpState.OPEN || !this.#transport) return 0;
    const generation = this.#generation;
    let queued = 0;
    const b = alloc(this.#m, CHUNK);
    try {
      for (let n = 0; n < maxChunks; n++) {
        const length = this.#m._wtox_vtcp_tx_peek(b.ptr, CHUNK);
        if (length === 0) break;
        if (length < 0 || length > CHUNK) throw new Error("vtcp_invalid_tx_length");
        const bytes = this.#m.HEAPU8.slice(b.ptr, b.ptr + length);
        try {
          this.#transport.send(bytes);
        } catch (error) {
          bytes.fill(0);
          if (error?.message === "tcp_tunnel_backpressure") break;
          this.#broken(generation);
          throw new Error("vtcp_transport_send_failed");
        }
        bytes.fill(0);
        if (this.#m._wtox_vtcp_tx_consume(length) !== 0) {
          this.#broken(generation);
          throw new Error("vtcp_tx_consume_failed");
        }
        queued += length;
      }
      return queued;
    } finally { release(this.#m, b); }
  }

  /**
   * No bytes yet => null (EWOULDBLOCK), clean EOF => empty Uint8Array,
   * peer failure => throws, data => Uint8Array.
   */
  read(maxBytes = CHUNK) {
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > LIMIT) {
      throw new TypeError("invalid_vtcp_read_limit");
    }
    const b = alloc(this.#m, maxBytes);
    try {
      const count = this.#m._wtox_vtcp_recv(b.ptr, maxBytes);
      if (count === -11) return null;
      if (count === 0) return new Uint8Array(0);
      if (count < 0 || count > maxBytes) throw new Error("vtcp_read_failed");
      return this.#m.HEAPU8.slice(b.ptr, b.ptr + count);
    } finally { release(this.#m, b); }
  }

  close() {
    this.#generation++;
    this.#m._wtox_vtcp_close();
    const transport = this.#transport;
    this.#transport = null;
    try { transport?.close(); } catch { /* cleanup best-effort */ }
  }
}
