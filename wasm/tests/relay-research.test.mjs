/**
 * Real c-toxcore WASM TCP client remains alive across async JS transport
 * callbacks, with a synthetic local Relay (no public network).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { RelayResearchHarness } from "../browser/relay-research-client.mjs";
import { VirtualTcpState } from "../browser/native-virtual-tcp.mjs";

for (const [mode, name, expectedValid] of [
  [0, "matching authenticated local Relay key", true],
  [1, "wrong synthetic Relay secret key", false],
  [2, "authenticated response with altered MAC", false]
]) {
  test("original Toxcore native TCP client handles asynchronous " + name, async () => {
    const { default: createModule } = await import("../dist/tox_identity.mjs");
    const wasm = await createModule();
    const harness = new RelayResearchHarness(wasm);
    let callbacks, response, disconnect;
    const sent = [];
    const transport = {
      closed: false,
      send(bytes) {
        // Browser WS send consumes queued bytes immediately. Do not ever
        // retain pointers to the buffer the WASM adapter will wipe.
        sent.push(bytes.slice());
        if (sent.length === 1) queueMicrotask(() => callbacks.onBytes(response.slice()));
      },
      close() { this.closed = true; }
    };
    try {
      harness.start();
      assert.equal(harness.state, VirtualTcpState.CONNECTING);
      assert.equal(harness.stats().connects, 1);
      await harness.attach("ws://127.0.0.1:18000/research", "test-only", {
        tunnelFactory: async (_url, _token, hooks) => {
          callbacks = hooks;
          return transport;
        }
      });
      assert.equal(harness.state, VirtualTcpState.OPEN);
      harness.iterate({ pump: false });
      assert.equal(harness.pending, 128);
      response = harness.makeSyntheticReply(mode);
      assert.equal(response.length, 96);
      assert.throws(() => harness.makeSyntheticReply(mode), /relay_research_reply_failed/);
      assert.equal(harness.pump(), 128);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].length, 128);
      assert.equal(harness.pending, 0);
      // The inbound response arrives later, not re-entrantly inside
      // the original Toxcore's iterate() stack.
      await new Promise(resolve => setImmediate(resolve));
      for (let i = 0; i < 5; i++) harness.iterate();
      const stats = harness.stats();
      assert.ok(stats.recvs >= 1, "native original Toxcore read synthetic reply");
      assert.equal(stats.rxBuffered, 0);
      assert.equal(stats.toxConnection, 0, "fake relay does not mean peer online");
      if (expectedValid) {
        assert.equal(stats.closes, 0, "valid response must not disconnect");
        assert.equal(stats.socketState, VirtualTcpState.OPEN);
        disconnect = callbacks.onDisconnected;
      } else {
        assert.ok(stats.closes >= 1, "bad key/MAC must disconnect");
        assert.notEqual(stats.socketState, VirtualTcpState.OPEN);
      }
      response.fill(0);
    } finally {
      harness.close();
    }
    assert.equal(harness.state, VirtualTcpState.CLOSED);
    assert.throws(() => harness.iterate(), /relay_research_not_started/);
    if (disconnect) disconnect(1006); // stale callback must not revive closed session
    assert.equal(harness.state, VirtualTcpState.CLOSED);
  });
}

test("research-only socket rejects attach before native connect and cleans up a cancelled handshake", async () => {
  const { default: createModule } = await import("../dist/tox_identity.mjs");
  const wasm = await createModule();
  const h = new RelayResearchHarness(wasm);
  let resolveTransport;
  try {
    await assert.rejects(h.attach("ws://127.0.0.1", "test"), /relay_research_not_started/);
    h.start();
    const pending = h.attach("ws://127.0.0.1", "test", {
      tunnelFactory: () => new Promise(resolve => { resolveTransport = resolve; })
    });
    h.close();
    let closed = false;
    resolveTransport({ send() {}, close() { closed = true; } });
    await assert.rejects(pending, /vtcp_connect_failed/);
    assert.equal(closed, true);
    assert.equal(h.state, VirtualTcpState.CLOSED);
  } finally {
    h.close();
  }
});

/* Stage 25: genuine Tox ID request semantics and encrypted persistence.
 * An authenticated TCP Relay is not an Onion bootstrap path. Never treat
 * acceptance of tox_friend_add as a delivered request or online friend. */
test("real Tox ID request is pending without discovery; encrypted backup retains the exact peer", async () => {
  const {default:createModule}=await import("../dist/tox_identity.mjs");
  const relayPublic=Uint8Array.from({length:32},(_,i)=>i+27);
  const sender=new RelayResearchHarness(await createModule());
  const receiver=new RelayResearchHarness(await createModule());
  let restored=null,backup=null;
  const password=new TextEncoder().encode("isolated-stage25-encrypted-test");
  const message=new TextEncoder().encode("Original Tox friend request");
  try {
    sender.startWithRelayPublicKey(relayPublic);
    receiver.startWithRelayPublicKey(relayPublic);
    const recipient=receiver.toxAddress();
    const previous=sender.toxAddress();
    assert.equal(recipient.length,38);
    assert.equal(previous.length,38);
    assert.notDeepEqual(Array.from(recipient),Array.from(previous));
    const bad=recipient.slice();
    bad[37]^=1;
    assert.throws(()=>sender.requestFriendByToxId(bad,message),
                  /native_tox_friend_request_failed/);
    assert.equal(sender.nativeToxRequestState().friends,0,
                 "bad standard Tox checksum must not create friend");
    sender.requestFriendByToxId(recipient,message);
    const waiting=sender.nativeToxRequestState();
    assert.equal(waiting.friends,1);
    assert.equal(waiting.queued,1);
    assert.equal(waiting.connection,0);
    assert.equal(waiting.onlineEvents,0);
    assert.equal(waiting.routeAttached,0);
    assert.equal(receiver.nativeToxRequestState().friends,0);
    assert.equal(receiver.takeRealFriendRequest(),null);
    assert.throws(()=>sender.sendNativeFriendText(message),
                  /native_friend_send_failed/);
    backup=sender.exportEncryptedSavedata(password);
    assert.equal(new TextDecoder().decode(backup.subarray(0,8)),"toxEsave");
    sender.close();
    restored=new RelayResearchHarness(await createModule());
    restored.startWithRelayEncrypted(relayPublic,backup,password);
    assert.deepEqual(Array.from(restored.toxAddress()),Array.from(previous),
                     "restoring encrypted savedata must retain original Tox ID");
    const after=restored.nativeToxRequestState();
    assert.equal(after.friends,1,"the original queued friend remains persisted");
    assert.equal(after.connection,0,"restored friend is not falsely online");
    assert.equal(after.onlineEvents,0);
    assert.equal(after.routeAttached,0);
    assert.equal(restored.takeRealFriendRequest(),null);
  } finally {
    sender.close();receiver.close();restored?.close();
    password.fill(0);message.fill(0);backup?.fill(0);
  }
});
