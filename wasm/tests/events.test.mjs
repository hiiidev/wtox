import test from "node:test";
import assert from "node:assert/strict";
import { BrowserToxSession } from "../browser/session-client.mjs";

function fakeModule({ malformed = false } = {}) {
  const m = {
    HEAPU8: new Uint8Array(8192),
    next: 256,
    eventCalls: 0,
    _malloc(n) { const p = this.next; this.next += n; return p; },
    _free() {},
    _wtox_session_start_new(ptr) {
      this.HEAPU8.fill(1, ptr, ptr + 38);
      return 0;
    },
    _wtox_session_restore_encrypted() { return 0; },
    _wtox_session_savedata_size() { return 100; },
    _wtox_session_export_encrypted() { return 0; },
    _wtox_session_set_name() { return 0; },
    _wtox_session_get_name() { return 0; },
    _wtox_session_iterate() { return 0; },
    _wtox_session_iteration_interval() { return 50; },
    _wtox_session_close() {},
    _wtox_session_friend_add() { return 0; },
    _wtox_session_friend_accept() { return 0; },
    _wtox_session_friend_count() { return 0; },
    _wtox_session_friend_list() { return 0; },
    _wtox_session_friend_public_key() { return 0; },
    _wtox_session_friend_delete() { return 0; },
    _wtox_session_send_text() { return 0; },
    _wtox_session_event_next(ptr, cap) {
      assert.equal(cap, 1412);
      if (this.eventCalls++ > 0) return 0;
      this.HEAPU8[ptr] = 2; // normal text message
      this.HEAPU8[ptr + 1] = 0;
      this.HEAPU8.set([0, 0, 0, 7], ptr + 2); // friend number
      this.HEAPU8.set([0, 2, 0x80, 0xff], ptr + 38);
      return malformed ? 41 : 42;
    },
    _wtox_session_events_dropped() { return 3; }
  };
  return m;
}
test("native callback queue decodes typed binary data and reports overflow", () => {
  const session = new BrowserToxSession(fakeModule());
  assert.throws(() => session.pollEvents(), /tox_session_not_open/);
  session.startNew();
  const result = session.pollEvents();
  assert.equal(result.dropped, 3);
  assert.equal(result.events.length, 1);
  const event = result.events[0];
  assert.equal(event.kind, 2);
  assert.equal(event.friendNumber, 7);
  assert.equal(event.publicKey, null);
  assert.deepEqual(event.payload, new Uint8Array([0x80, 0xff]));
  session.close();
});
test("mismatched native callback payload length is rejected", () => {
  const session = new BrowserToxSession(fakeModule({ malformed: true }));
  session.startNew();
  assert.throws(() => session.pollEvents(), /invalid_native_event/);
  session.close();
});
