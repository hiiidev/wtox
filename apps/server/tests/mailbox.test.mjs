import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openSqliteMailbox } from "../src/sqlite-mailbox.ts";
import { MESSAGE_TTL_MS, MAX_PENDING } from "../../../packages/protocol/src/mailbox.ts";

const alice = "a".repeat(64);
const bob = "b".repeat(64);
const ciphertext = "c".repeat(64);
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wtox-v1-"));
  let time = 100000;
  const store = openSqliteMailbox(join(dir, "mailbox.sqlite"), () => time);
  return {
    store, time: () => time, advance: n => { time += n; },
    cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); }
  };
}
test("separate recipients, de-duplication, idempotent ACK and encrypted payload", async () => {
  const f = fixture();
  try {
    const item = { id: "1".repeat(32), ciphertext };
    assert.deepEqual(await f.store.put(alice, item), { status: "stored" });
    assert.deepEqual(await f.store.put(alice, item), { status: "duplicate" });
    assert.deepEqual(await f.store.put(bob, item), { status: "stored" });
    assert.equal((await f.store.list(alice))[0].ciphertext, ciphertext);
    assert.equal((await f.store.list(bob)).length, 1);
    await f.store.ack(alice, [item.id, item.id]);
    assert.deepEqual(await f.store.list(alice), []);
    assert.equal((await f.store.list(bob)).length, 1);
  } finally { f.cleanup(); }
});
test("expiry, pruning and validation are enforced", async () => {
  const f = fixture();
  try {
    await f.store.put(alice, { id: "2".repeat(32), ciphertext });
    f.advance(MESSAGE_TTL_MS);
    assert.deepEqual(await f.store.list(alice), []);
    assert.equal(await f.store.pruneExpired(), 1);
    await assert.rejects(f.store.put("bad", { id: "3".repeat(32), ciphertext }), /invalid_recipient/);
    await assert.rejects(f.store.put(alice, { id: "3".repeat(32), ciphertext: "hello" }), /invalid_ciphertext/);
    await assert.rejects(f.store.list(alice, 101), /invalid_limit/);
    await assert.rejects(f.store.ack(alice, ["../bad"]), /invalid_ack_ids/);
  } finally { f.cleanup(); }
});
test("quota rejects new messages, existing ID stays idempotent", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < MAX_PENDING; i++) {
      const id = i.toString(16).padStart(32, "0");
      await f.store.put(alice, { id, ciphertext });
    }
    assert.deepEqual(await f.store.put(alice, { id: "0".repeat(32), ciphertext }), { status: "duplicate" });
    await assert.rejects(
      f.store.put(alice, { id: "f".repeat(32), ciphertext }),
      /mailbox_full/
    );
    assert.equal((await f.store.list(alice, 100)).length, 100);
  } finally { f.cleanup(); }
});
test("self-hosted routing matches Cloudflare fail-closed behavior", async () => {
  const { routeRequest } = await import("../../../packages/protocol/src/router.ts");
  const health = routeRequest(new Request("https://test.example/api/v1/health"), "node-selfhost");
  assert.equal(health.status, 200);
  const caps = await routeRequest(new Request("https://test.example/api/v1/capabilities"), "node-selfhost").json();
  assert.equal(caps.runtime, "node-selfhost");
  assert.equal(caps.public_mailbox_api, "disabled");
  const mailbox = routeRequest(new Request("https://test.example/api/v1/mailboxes/x", { method: "POST" }), "node-selfhost");
  assert.equal(mailbox.status, 501);
});
