import test from "node:test";
import assert from "node:assert/strict";
import { BrowserToxIdentity } from "../browser/identity-client.mjs";

class FakeModule {
  HEAPU8 = new Uint8Array(400000);
  next = 1024;
  freeCalls = [];
  allocations = new Map();
  _malloc(n) {
    const ptr = this.next;
    this.next += n;
    this.allocations.set(ptr, n);
    return ptr;
  }
  _free(ptr) { this.freeCalls.push(ptr); }
  _wtox_create_encrypted(pass, len, addr, backup, cap, written) {
    assert.equal(new TextDecoder().decode(this.HEAPU8.slice(pass, pass + len)), "strong-test-passphrase");
    this.HEAPU8.fill(7, addr, addr + 38);
    const magic = new TextEncoder().encode("toxEsave");
    this.HEAPU8.set(magic, backup);
    this.HEAPU8.fill(100, backup + magic.length, backup + 96);
    new DataView(this.HEAPU8.buffer).setUint32(written, 96, true);
    return 0;
  }
  _wtox_inspect_encrypted(_backup, _size, pass, len, address) {
    assert.equal(new TextDecoder().decode(this.HEAPU8.slice(pass, pass + len)), "strong-test-passphrase");
    this.HEAPU8.fill(7, address, address + 38);
    return 0;
  }
}
test("encrypted backup generation copies output and scrubs transient WASM memory", async () => {
  const wasm = new FakeModule();
  const client = new BrowserToxIdentity(wasm);
  const result = await client.createEncryptedBackup("strong-test-passphrase");
  assert.match(result.toxId, /^[0-9A-F]{76}$/);
  assert.deepEqual(new TextDecoder().decode(result.encryptedBackup.slice(0, 8)), "toxEsave");
  assert.equal(result.encryptedBackup.length, 96);
  for (const [ptr, len] of wasm.allocations) {
    assert.deepEqual(wasm.HEAPU8.slice(ptr, ptr + len), new Uint8Array(len),
      "not wiped: " + ptr);
  }
  assert.equal(wasm.freeCalls.length, 4);
  const importResult = await client.inspectEncryptedBackup(result.encryptedBackup, "strong-test-passphrase");
  assert.equal(importResult.toxId, result.toxId);
  for (const [ptr, len] of wasm.allocations) {
    assert.deepEqual(wasm.HEAPU8.slice(ptr, ptr + len), new Uint8Array(len));
  }
});
test("reject invalid passwords and unencrypted backup", async () => {
  const client = new BrowserToxIdentity(new FakeModule());
  await assert.rejects(client.createEncryptedBackup("short"), /password_length/);
  await assert.rejects(client.inspectEncryptedBackup(new Uint8Array([1]), "strong-test-passphrase"),
    /invalid_backup/);
  assert.throws(() => new BrowserToxIdentity({}), /invalid_wasm_module/);
});
