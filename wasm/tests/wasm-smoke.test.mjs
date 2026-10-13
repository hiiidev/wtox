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
