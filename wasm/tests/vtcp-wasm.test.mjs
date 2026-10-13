/**
 * Genuine compiled c-toxcore+libsodium module, native synchronous FIFO +
 * asynchronous transport adapter. Fake transport only; no real Tox network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { NativeVirtualTcp, VirtualTcpState } from "../browser/native-virtual-tcp.mjs";

test("native WASM virtual TCP: ordering, partial I/O, backpressure, EOF and reconnect", async () => {
  const { default: createModule } = await import("../dist/tox_identity.mjs");
  const wasm = await createModule();
  const vt = new NativeVirtualTcp(wasm);
  assert.equal(vt.state, VirtualTcpState.IDLE);
  assert.throws(() => vt.read(), /vtcp_read_failed/);
  const callbacks = [];
  const sent = [];
  let blocked = true;
  const transport = {
    closed: false,
    send(bytes) {
      if (blocked) throw new Error("tcp_tunnel_backpressure");
      // The transport takes ownership synchronously, like WebSocket.send:
      // the adapter wipes its temporary copy after send() returns.
      const echoed = bytes.slice();
      sent.push(echoed.slice());
      queueMicrotask(() => callbacks[0].onBytes(echoed));
    },
    close() { this.closed = true; }
  };
  await vt.connect("ws://127.0.0.1/example", "f".repeat(64), {
    tunnelFactory: async (_url, _token, options) => {
      callbacks.push(options);
      return transport;
    }
  });
  assert.equal(vt.state, VirtualTcpState.OPEN);
  assert.equal(vt.read(), null);
  const payload = Uint8Array.from({ length: 32770 }, (_, i) => i % 256);
  const wrote = vt.send(payload);
  assert.equal(wrote, payload.length);
  assert.equal(vt.pending, payload.length);
  assert.equal(vt.pump(), 0);
  assert.equal(vt.pending, payload.length);
  blocked = false;
  assert.equal(vt.pump(), payload.length);
  assert.equal(vt.pending, 0);
  assert.equal(sent.length, 3);
  await new Promise(resolve => setImmediate(resolve));
  const received = [];
  // Keep the loop bounded: a clean EOF is an empty byte array, not
  // would-block (null). Never spin forever on EOF in a test or UI.
  for (let i = 0; i < 10; i++) {
    const bytes = vt.read(10000);
    if (bytes === null) break;
    assert.ok(bytes.byteLength > 0, "unexpected EOF while socket is open");
    received.push(bytes);
  }
  assert.deepEqual(Buffer.concat(received), Buffer.from(payload));
  assert.throws(() => vt.send(new Uint8Array(65537)), /invalid_vtcp_send/);

  const frame = Uint8Array.from([0, 1, 128, 255, 42]);
  callbacks[0].onBytes(frame);
  callbacks[0].onDisconnected(1000);
  assert.equal(vt.state, VirtualTcpState.CLOSED);
  assert.deepEqual(vt.read(), frame);
  assert.equal(vt.read().byteLength, 0, "EOF only after draining");
  assert.throws(() => vt.send(frame), /vtcp_not_connected/);
  vt.close();

  let second;
  await vt.connect("ws://127.0.0.1/example", "f".repeat(64), {
    tunnelFactory: async (_url, _token, options) => {
      second = options;
      return { ...transport, closed: false };
    }
  });
  assert.equal(vt.state, VirtualTcpState.OPEN);
  second.onBytes(new Uint8Array(65536));
  assert.equal(vt.rxFree, 0);
  second.onBytes(Uint8Array.from([1])); // fail closed on overflow
  assert.equal(vt.state, VirtualTcpState.FAILED);
  assert.throws(() => vt.read(), /vtcp_read_failed/);
  vt.close();
});

test("native virtual TCP: async connect cancellation and failed handshake", async () => {
  const { default: createModule } = await import("../dist/tox_identity.mjs");
  const m = await createModule();
  const vt = new NativeVirtualTcp(m);
  let resolveConnect;
  const pending = vt.connect("ws://127.0.0.1/blocked", "a".repeat(64), {
    tunnelFactory: () => new Promise(resolve => { resolveConnect = resolve; })
  });
  assert.equal(vt.state, VirtualTcpState.CONNECTING);
  assert.equal(vt.send(Uint8Array.from([1])), 0, "would-block during handshake");
  vt.close();
  let closed = false;
  resolveConnect({ send() {}, close() { closed = true; } });
  await assert.rejects(pending, /vtcp_connect_failed/);
  assert.equal(closed, true);
  assert.equal(vt.state, VirtualTcpState.CLOSED);
  await assert.rejects(vt.connect("ws://127.0.0.1/bad", "b".repeat(64), {
    tunnelFactory: async () => { throw Error("denied"); }
  }), /vtcp_connect_failed/);
  assert.equal(vt.state, VirtualTcpState.FAILED);
  vt.close();
});
