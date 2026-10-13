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
