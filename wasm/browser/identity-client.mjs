/**
 * JS boundary for native WASM ToxEncryptSave. Never uses network or uploads
 * backups. Not connected to the old Python login UI.
 *
 * Password is a JavaScript string: JS memory cannot be perfectly scrubbed.
 * Sensitive copies inside WASM memory are explicitly wiped before freeing.
 */
const ADDRESS_BYTES = 38;
const MAX_BACKUP_BYTES = 1024 * 1024 + 80;
const MAX_PASSWORD_BYTES = 1024;
const MIN_PASSWORD_BYTES = 8;
const MAX_CREATE_BUFFER = 64 * 1024;

function makeBuffer(module, bytes) {
  const pointer = module._malloc(Math.max(bytes.length, 1));
  if (!pointer) throw new Error("wasm_out_of_memory");
  module.HEAPU8.set(bytes, pointer);
  return { ptr: pointer, size: bytes.length };
}
function wipeFree(module, buffer) {
  if (!buffer) return;
  module.HEAPU8.fill(0, buffer.ptr, buffer.ptr + Math.max(buffer.size, 1));
  module._free(buffer.ptr);
}
const hex = bytes => [...bytes].map(v => v.toString(16).padStart(2, "0")).join("").toUpperCase();

export class BrowserToxIdentity {
  constructor(module) {
    if (!module || typeof module._wtox_create_encrypted !== "function" ||
        typeof module._wtox_inspect_encrypted !== "function" ||
        typeof module._malloc !== "function" ||
        typeof module._free !== "function" ||
        !(module.HEAPU8 instanceof Uint8Array)) {
      throw new TypeError("invalid_wasm_module");
    }
    this.module = module;
  }

  #password(password) {
    if (typeof password !== "string") throw new TypeError("password_required");
    const bytes = new TextEncoder().encode(password);
    if (bytes.length < MIN_PASSWORD_BYTES || bytes.length > MAX_PASSWORD_BYTES) {
      bytes.fill(0);
      throw new RangeError("password_length_out_of_range");
    }
    return bytes;
  }

  async createEncryptedBackup(password) {
    const module = this.module;
    const secret = this.#password(password);
    let pass, address, backup, outLength;
    try {
      pass = makeBuffer(module, secret);
      address = makeBuffer(module, new Uint8Array(ADDRESS_BYTES));
      backup = makeBuffer(module, new Uint8Array(MAX_CREATE_BUFFER));
      outLength = makeBuffer(module, new Uint8Array(4));
      const code = module._wtox_create_encrypted(
        pass.ptr, pass.size, address.ptr, backup.ptr, backup.size, outLength.ptr
      );
      if (code !== 0) throw new Error("tox_wasm_create_failed:" + code);
      const length = new DataView(
        module.HEAPU8.buffer
      ).getUint32(outLength.ptr, true);
      if (length < 81 || length > MAX_CREATE_BUFFER) throw new Error("invalid_backup_length");
      const toxId = hex(module.HEAPU8.slice(address.ptr, address.ptr + ADDRESS_BYTES));
      const encryptedBackup = module.HEAPU8.slice(backup.ptr, backup.ptr + length);
      if (!encryptedBackup.slice(0, 8).every((byte, i) =>
          byte === "toxEsave".charCodeAt(i))) {
        encryptedBackup.fill(0);
        throw new Error("not_toxencryptsave_backup");
      }
      return { toxId, encryptedBackup };
    } finally {
      secret.fill(0);
      for (const buffer of [outLength, backup, address, pass]) wipeFree(module, buffer);
    }
  }

  async inspectEncryptedBackup(bytes, password) {
    if (!(bytes instanceof Uint8Array) ||
        bytes.byteLength < 81 || bytes.byteLength > MAX_BACKUP_BYTES) {
      throw new TypeError("invalid_backup");
    }
    const module = this.module;
    const secret = this.#password(password);
    let pass, backup, address;
    try {
      pass = makeBuffer(module, secret);
      backup = makeBuffer(module, bytes);
      address = makeBuffer(module, new Uint8Array(ADDRESS_BYTES));
      const code = module._wtox_inspect_encrypted(
        backup.ptr, backup.size, pass.ptr, pass.size, address.ptr
      );
      if (code !== 0) throw new Error("tox_wasm_import_failed:" + code);
      return { toxId: hex(module.HEAPU8.slice(address.ptr, address.ptr + ADDRESS_BYTES)) };
    } finally {
      secret.fill(0);
      for (const buffer of [address, backup, pass]) wipeFree(module, buffer);
    }
  }
}
