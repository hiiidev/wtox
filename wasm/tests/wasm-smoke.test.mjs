/**
 * Real, compiled c-toxcore+libsodium WebAssembly smoke, not a mock.
 * This test is the first gate and MUST fail if identity creation,
 * ToxEncryptSave export and native backup restore do not roundtrip.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BrowserToxIdentity } from "../browser/identity-client.mjs";
import { BrowserToxSession } from "../browser/session-client.mjs";

const dir = dirname(fileURLToPath(import.meta.url));
const artifact = join(dir, "../dist/tox_identity.mjs");
test("compiled WASM locally creates and restores the same Tox ID", async () => {
  assert.ok(existsSync(artifact), "WASM artifact missing; run npm run build");
  const { default: createModule } = await import("../dist/tox_identity.mjs");
  const wasm = await createModule();
  const client = new BrowserToxIdentity(wasm);
  const password = "independent-long-WASM-only-backup-passphrase";
  const { toxId, encryptedBackup } = await client.createEncryptedBackup(password);
  assert.match(toxId, /^[A-F0-9]{76}$/);
  assert.equal(new TextDecoder().decode(encryptedBackup.slice(0, 8)), "toxEsave");
  assert.equal((await client.inspectEncryptedBackup(encryptedBackup, password)).toxId, toxId);
  await assert.rejects(client.inspectEncryptedBackup(encryptedBackup, "incorrect-long-password"),
    /tox_wasm_import_failed/);
});

test("real Toxcore WASM retains a live session, iterates and restores nickname from encrypted savedata", async () => {
  const { default: createModule } = await import("../dist/tox_identity.mjs");
  const wasm = await createModule();
  const session = new BrowserToxSession(wasm);
  const password = "temporary-secret-used-only-in-this-test";
  const original = session.startNew();
  assert.match(original.toxId, /^[0-9A-F]{76}$/);
  assert.throws(() => session.startNew(), /tox_session_already_open/);
  session.setName("wTox 浏览器身份");
  assert.equal(session.getName(), "wTox 浏览器身份");
  const interval = session.iterationInterval();
  assert.ok(interval >= 0 && interval <= 60000);
  session.iterate();
  const { encryptedBackup } = session.exportEncrypted(password);
  assert.equal(new TextDecoder().decode(encryptedBackup.slice(0, 8)), "toxEsave");
  session.close();
  assert.equal(session.active, false);
  assert.throws(() => session.iterate(), /tox_session_not_open/);
  assert.throws(() => session.exportEncrypted(password), /tox_session_not_open/);
  assert.throws(() => session.restoreEncrypted(encryptedBackup, "a-wrong-password-here"),
    /tox_session_restore_failed/);
  assert.equal(session.active, false);
  const restored = session.restoreEncrypted(encryptedBackup, password);
  assert.equal(restored.toxId, original.toxId);
  assert.equal(session.getName(), "wTox 浏览器身份");
  session.close();
  session.close();
  encryptedBackup.fill(0);
});
