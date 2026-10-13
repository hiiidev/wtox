/**
 * Persistent, browser-only Toxcore WASM identity session. Offline until a
 * separately audited virtual socket bridge exists. Never returns plaintext
 * savedata, private keys, or secrets to the network.
 */
const MAX_SAVED = 1024 * 1024, EXTRA = 80, ADDRESS = 38, MAX_NAME = 128;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const required = ["_malloc", "_free", ...["start_new", "restore_encrypted", "savedata_size",
  "export_encrypted", "set_name", "get_name", "iterate", "iteration_interval",
  "close"].map(k => "_wtox_session_" + k)];
const hex = data => Array.from(data, n => n.toString(16).padStart(2, "0")).join("").toUpperCase();
function allocate(m, bytes) {
  const size = Math.max(1, bytes.byteLength);
  const ptr = m._malloc(size);
  if (!ptr) throw new Error("wasm_out_of_memory");
  m.HEAPU8.set(bytes, ptr);
  return { ptr, size };
}
function wipeFree(m, buffer) {
  if (!buffer) return;
  m.HEAPU8.fill(0, buffer.ptr, buffer.ptr + buffer.size);
  m._free(buffer.ptr);
}
function passwordBytes(password) {
  if (typeof password !== "string") throw new TypeError("password_required");
  const bytes = encoder.encode(password);
  if (bytes.length < 8 || bytes.length > 1024) {
    bytes.fill(0);
    throw new RangeError("invalid_password_length");
  }
  return bytes;
}
export class BrowserToxSession {
  #m;
  #active = false;
  constructor(m) {
    if (!m || !(m.HEAPU8 instanceof Uint8Array) ||
        required.some(name => typeof m[name] !== "function")) {
      throw new TypeError("invalid_session_wasm");
    }
    this.#m = m;
  }
  get active() { return this.#active; }
  #state(expected) {
    if (this.#active !== expected) {
      throw new Error(expected ? "tox_session_not_open" : "tox_session_already_open");
    }
  }
  startNew() {
    this.#state(false);
    const m = this.#m, address = allocate(m, new Uint8Array(ADDRESS));
    try {
      const code = m._wtox_session_start_new(address.ptr);
      if (code !== 0) throw new Error("tox_session_create_failed:" + code);
      this.#active = true;
      return { toxId: hex(m.HEAPU8.slice(address.ptr, address.ptr + ADDRESS)) };
    } finally { wipeFree(m, address); }
  }
  restoreEncrypted(backup, password) {
    this.#state(false);
    if (!(backup instanceof Uint8Array) || backup.byteLength <= EXTRA ||
        backup.byteLength > MAX_SAVED + EXTRA) {
      throw new TypeError("invalid_encrypted_tox_backup");
    }
    const m = this.#m, secret = passwordBytes(password);
    let pass, input, address;
    try {
      pass = allocate(m, secret);
      input = allocate(m, backup);
      address = allocate(m, new Uint8Array(ADDRESS));
      const code = m._wtox_session_restore_encrypted(
        input.ptr, backup.byteLength, pass.ptr, secret.length, address.ptr
      );
      if (code !== 0) throw new Error("tox_session_restore_failed:" + code);
      this.#active = true;
      return { toxId: hex(m.HEAPU8.slice(address.ptr, address.ptr + ADDRESS)) };
    } finally {
      secret.fill(0);
      for (const b of [address, input, pass]) wipeFree(m, b);
    }
  }
  setName(name) {
    this.#state(true);
    if (typeof name !== "string") throw new TypeError("invalid_name");
    const data = encoder.encode(name);
    if (data.length > MAX_NAME) { data.fill(0); throw new RangeError("name_too_long"); }
    const m = this.#m;
    let buf;
    try {
      buf = allocate(m, data);
      const code = m._wtox_session_set_name(buf.ptr, data.length);
      if (code !== 0) throw new Error("tox_session_set_name_failed:" + code);
    } finally {
      data.fill(0);
      wipeFree(m, buf);
    }
  }
  getName() {
    this.#state(true);
    const m = this.#m, name = allocate(m, new Uint8Array(MAX_NAME));
    try {
      const length = m._wtox_session_get_name(name.ptr, MAX_NAME);
      if (!Number.isInteger(length) || length < 0 || length > MAX_NAME) {
        throw new Error("tox_session_get_name_failed");
      }
      return decoder.decode(m.HEAPU8.slice(name.ptr, name.ptr + length));
    } finally { wipeFree(m, name); }
  }
  exportEncrypted(password) {
    this.#state(true);
    const m = this.#m, secret = passwordBytes(password);
    let pass, output, written;
    try {
      const size = m._wtox_session_savedata_size();
      if (!Number.isInteger(size) || size <= 0 || size > MAX_SAVED) {
        throw new Error("invalid_native_savedata_size");
      }
      const capacity = size + EXTRA;
      pass = allocate(m, secret);
      output = allocate(m, new Uint8Array(capacity));
      written = allocate(m, new Uint8Array(4));
      const code = m._wtox_session_export_encrypted(
        pass.ptr, secret.length, output.ptr, capacity, written.ptr
      );
      if (code !== 0) throw new Error("tox_session_export_failed:" + code);
      const resultLength = new DataView(m.HEAPU8.buffer).getUint32(written.ptr, true);
      if (resultLength !== capacity) throw new Error("invalid_native_export_size");
      const encryptedBackup = m.HEAPU8.slice(output.ptr, output.ptr + capacity);
      const magic = encoder.encode("toxEsave");
      if (!magic.every((n, i) => encryptedBackup[i] === n)) {
        encryptedBackup.fill(0);
        throw new Error("invalid_encrypted_backup_signature");
      }
      return { encryptedBackup };
    } finally {
      secret.fill(0);
      for (const b of [written, output, pass]) wipeFree(m, b);
    }
  }
  iterationInterval() {
    this.#state(true);
    const interval = this.#m._wtox_session_iteration_interval();
    if (!Number.isInteger(interval) || interval < 0 || interval > 60000) {
      throw new Error("invalid_tox_iteration_interval");
    }
    return interval;
  }
  iterate() {
    this.#state(true);
    if (this.#m._wtox_session_iterate() !== 0) throw new Error("tox_iterate_failed");
  }
  close() {
    if (!this.#active) return;
    this.#m._wtox_session_close();
    this.#active = false;
  }
}
