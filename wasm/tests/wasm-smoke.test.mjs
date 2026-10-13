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


test("native friend request persists in encrypted savedata, and offline send fails closed", async () => {
  const { default: createModule } = await import("../dist/tox_identity.mjs");
  const m = await createModule();
  const identity = new BrowserToxIdentity(m);
  const password = "native-tox-friend-persistence-test-passphrase";
  // Distinct genuine Tox identity, never a fabricated 38-byte ID.
  const peer = await identity.createEncryptedBackup(password);
  const session = new BrowserToxSession(m);
  try {
    const own = session.startNew();
    assert.notEqual(own.toxId, peer.toxId);
    const number = session.addFriend(peer.toxId, "Hello from browser WASM");
    assert.equal(Number.isInteger(number), true);
    assert.deepEqual(session.friends(), [{
      number, publicKey: peer.toxId.slice(0, 64)
    }]);
    assert.throws(() => session.addFriend(peer.toxId, "again"), /tox_friend_add_failed/);
    assert.throws(() => session.addFriend(own.toxId, "self"), /tox_friend_add_failed/);
    assert.throws(() => session.addFriend("bogus", "test"), /invalid_tox_identifier/);
    assert.throws(() => session.addFriend(peer.toxId, ""), /invalid_friend_request_length/);
    assert.throws(() => session.sendText(number, "Offline: must not fake success"), /tox_friend_send_failed/);
    const backup = session.exportEncrypted(password).encryptedBackup;
    session.close();
    const restored = session.restoreEncrypted(backup, password);
    assert.equal(restored.toxId, own.toxId);
    assert.deepEqual(session.friends(), [{
      number, publicKey: peer.toxId.slice(0, 64)
    }]);
    session.deleteFriend(number);
    assert.deepEqual(session.friends(), []);
    assert.throws(() => session.deleteFriend(number), /tox_friend_delete_failed/);
    // An explicitly trusted public key may be accepted without an outbound
    // friend request. Production UI must require the user's consent.
    const accepted = session.acceptFriend(peer.toxId.slice(0, 64));
    assert.equal(session.friends().some(f => f.number === accepted), true);
    session.deleteFriend(accepted);
    backup.fill(0);
  } finally {
    session.close();
    peer.encryptedBackup.fill(0);
  }
});

test("native Toxcore callback queue API is available on persistent sessions", async () => {
  const { default: createModule } = await import("../dist/tox_identity.mjs");
  const wasm = await createModule();
  const session = new BrowserToxSession(wasm);
  try {
    session.startNew();
    session.iterate();
    const batch = session.pollEvents();
    assert.equal(Array.isArray(batch.events), true);
    assert.equal(batch.dropped >= 0, true);
    for (const e of batch.events) {
      assert.ok(e.kind >= 1 && e.kind <= 5);
      assert.ok(e.payload instanceof Uint8Array);
      assert.ok(e.payload.length <= 1372);
    }
  } finally { session.close(); }
});

test("genuine Toxcore v0.2.23 accepts isolated Network_Funcs injection, dispatches virtual socket callbacks", async () => {
  const { default: createModule } = await import("../dist/tox_identity.mjs");
  const wasm = await createModule();
  assert.equal(typeof wasm._wtox_network_injection_probe, "function");
  const ptr = wasm._malloc(6 * 4);
  assert.notEqual(ptr, 0);
  try {
    wasm.HEAPU8.fill(0xff, ptr, ptr + 24);
    const code = wasm._wtox_network_injection_probe(ptr);
    assert.equal(code, 0, "native Tox_System.ns injected probe failed code " + code);
    const result = Array.from(
      { length: 6 },
      (_, i) => new DataView(wasm.HEAPU8.buffer).getUint32(ptr + i * 4, true)
    );
    assert.ok(result[0] >= 1, "Tox-owned Network_Funcs socket callback not called");
    assert.ok(result[1] >= 1, "Tox-owned Network_Funcs connect callback not called");
    assert.ok(result[2] >= 2, "virtual socket send and would-block path not called");
    assert.ok(result[3] >= 2, "virtual socket recv and would-block path not called");
    assert.ok(result[4] >= 1, "fake socket close callback not called");
    assert.equal(result[5], 0, "offline probe must never report an active Tox peer");
    // The probe never activates the independent persistent browser session.
    const session = new BrowserToxSession(wasm);
    const { toxId } = session.startNew();
    assert.match(toxId, /^[0-9A-F]{76}$/);
    session.close();
  } finally {
    wasm.HEAPU8.fill(0, ptr, ptr + 24);
    wasm._free(ptr);
  }
});

test("internal pinned c-toxcore TCP relay originates a virtual connect and handshake bytes without network egress", async () => {
  const { default: createModule } = await import("../dist/tox_identity.mjs");
  const wasm = await createModule();
  assert.equal(typeof wasm._wtox_network_relay_dial_probe, "function");
  const ptr = wasm._malloc(8 * 4);
  assert.ok(ptr);
  try {
    const code = wasm._wtox_network_relay_dial_probe(ptr);
    const counters = Array.from({length:8}, (_, i) =>
      new DataView(wasm.HEAPU8.buffer).getUint32(ptr + i * 4, true));
    assert.equal(code, 0, "internal TCP relay probe failed: " + code + "; " + counters.join(","));
    assert.equal(counters[0], 1, "only one synthetic TCP socket is allowed");
    assert.equal(counters[1], 1, "Toxcore must originate the fake connect");
    assert.ok(counters[2] >= 1, "Toxcore must emit its own TCP handshake");
    assert.equal(counters[5], 1, "native tox_add_tcp_relay must accept synthetic route");
    assert.ok(counters[7] > 0, "the original crypto TCP handshake must reach the virtual TX FIFO");
  } finally {
    wasm.HEAPU8.fill(0, ptr, ptr + 32);
    wasm._free(ptr);
  }
});

test("original Tox TCP relay rejects incomplete and tampered synthetic server handshakes", async () => {
  const { default: createModule } = await import("../dist/tox_identity.mjs");
  const wasm = await createModule();
  assert.equal(typeof wasm._wtox_network_relay_rejection_probe, "function");
  const ptr = wasm._malloc(10 * 4);
  assert.ok(ptr);
  try {
    for (const mode of [0, 1, 2]) {
      wasm.HEAPU8.fill(0, ptr, ptr + 40);
      const code = wasm._wtox_network_relay_rejection_probe(mode, ptr);
      const values = Array.from({ length: 10 },
        (_, i) => new DataView(wasm.HEAPU8.buffer).getUint32(ptr + i * 4, true));
      assert.equal(code, 0,
        "native Toxcore must not accept synthetic relay handshake mode " +
        mode + ": code=" + code + " counters=" + values.join(","));
      assert.equal(values[0], 1);
      assert.equal(values[1], 1);
      assert.ok(values[9] > 0, "original Toxcore must produce the client handshake");
      assert.equal(values[7], 0, "no synthetic relay must make Tox report online");
      if (mode === 0) {
        assert.equal(values[6], 17, "incomplete server handshake is buffered");
        assert.equal(values[3], 0, "incomplete frame must not be read");
      } else {
        assert.equal(values[6], 0, "full malformed handshake must be consumed");
        assert.ok(values[3] > 0, "original Toxcore must read the full invalid handshake");
        assert.ok(values[4] > 0, "Toxcore must close invalid relay connection");
      }
    }
  } finally {
    wasm.HEAPU8.fill(0, ptr, ptr + 40);
    wasm._free(ptr);
  }
});

test("real Toxcore verifies authenticated synthetic Relay handshake; rejects wrong key and altered MAC", async () => {
  const { default: createModule } = await import("../dist/tox_identity.mjs");
  const wasm = await createModule();
  assert.equal(typeof wasm._wtox_network_relay_authenticated_probe, "function");
  const ptr = wasm._malloc(40);
  assert.ok(ptr);
  try {
    for (const [mode, label] of [[0,"valid"],[1,"fragmented valid"],[2,"wrong relay key"],[3,"tampered MAC"]]) {
      wasm.HEAPU8.fill(0, ptr, ptr + 40);
      const code = wasm._wtox_network_relay_authenticated_probe(mode, ptr);
      const counts = Array.from({length:10}, (_,i) =>
        new DataView(wasm.HEAPU8.buffer).getUint32(ptr+i*4,true));
      assert.equal(code, 0, label + ": native probe=" + code + " counters=" + counts.join(","));
      assert.equal(counts[0], 1);
      assert.equal(counts[1], 1);
      assert.ok(counts[2] >= 1, label + ": original client emitted handshake");
      assert.ok(counts[3] >= 1, label + ": original client read server response");
      assert.equal(counts[7], 0, label + ": native receive queue was consumed");
      assert.equal(counts[9], 0, label + ": a fake relay is not an online Tox peer");
      if (mode <= 1) {
        assert.equal(counts[4], 0, label + ": authenticated handshake remains open");
        assert.equal(counts[8], 2, label + ": virtual stream remains OPEN");
      } else {
        assert.ok(counts[4] >= 1, label + ": invalid response must close the socket");
      }
      if (mode === 1) {
        assert.equal(counts[5], 0, "partial authenticated reply cannot be read");
        assert.equal(counts[6], 23, "first 23 bytes must remain buffered");
      }
    }
  } finally {
    wasm.HEAPU8.fill(0, ptr, ptr + 40);
    wasm._free(ptr);
  }
});
