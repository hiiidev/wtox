import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createSocket } from "node:dgram";
import { openApprovedUdpSession } from "../src/udp-transport.ts";
import {
  TransportKind, encodeTransportFrame, decodeTransportFrame,
  UDP_DATAGRAM_MAX_BYTES, TCP_FRAME_MAX_BYTES
} from "../../../packages/protocol/src/transport-frame.ts";

const relay = { host: "1.1.1.1", port: 33445, publicKey: "a".repeat(64) };
function fakeSocket() {
  const socket = new EventEmitter();
  const sent = [];
  socket.closed = false;
  socket.connect = (port, host, callback) => {
    assert.equal(port, relay.port);
    assert.equal(host, relay.host);
    callback();
  };
  socket.send = (bytes, callback) => { sent.push(Uint8Array.from(bytes)); callback(null); };
  socket.close = () => { socket.closed = true; };
  return { socket, sent };
}
test("UDP internal session sends only to approved peer and delivers bounded responses", async () => {
  const f = fakeSocket();
  const received = [];
  const session = await openApprovedUdpSession(relay, [relay],
    bytes => received.push(bytes),
    { socketFactory: () => f.socket });
  try {
    await session.send(new Uint8Array([1, 2, 3]));
    assert.deepEqual(f.sent[0], new Uint8Array([1, 2, 3]));
    f.socket.emit("message", Buffer.from([7, 8]), {
      address: relay.host, port: relay.port, size: 2
    });
    f.socket.emit("message", Buffer.from([9]), {
      address: "8.8.8.8", port: relay.port, size: 1
    });
    assert.deepEqual(received, [new Uint8Array([7, 8])]);
  } finally { session.close(); }
  assert.equal(session.closed, true);
  assert.equal(f.socket.closed, true);
});
test("reject invalid destinations without opening a UDP socket", async () => {
  let factoryCalled = false;
  await assert.rejects(openApprovedUdpSession(
    { host: "127.0.0.1", port: 33445, publicKey: relay.publicKey },
    [relay], () => {}, { socketFactory: () => { factoryCalled = true; } }
  ), /relay_not_approved/);
  assert.equal(factoryCalled, false);
});
test("UDP payload cap, packet rate cap, and TTL close are enforced", async () => {
  const f = fakeSocket();
  let time = 10_000;
  const received = [];
  const session = await openApprovedUdpSession(relay, [relay],
    bytes => received.push(bytes),
    { socketFactory: () => f.socket, now: () => time, maxDurationMs: 1000 });
  try {
    await assert.rejects(session.send(new Uint8Array(UDP_DATAGRAM_MAX_BYTES + 1)),
      /invalid_udp_datagram/);
    for (let i = 0; i < 60; i++) await session.send(new Uint8Array([1]));
    await assert.rejects(session.send(new Uint8Array([2])), /udp_rate_limited/);
    for (let i = 0; i < 70; i++) {
      f.socket.emit("message", Buffer.from([i]), {
        address: relay.host, port: relay.port, size: 1
      });
    }
    assert.equal(received.length, 60);
    time += 1000;
    await assert.rejects(session.send(new Uint8Array([1])), /udp_session_closed/);
    assert.equal(session.closed, true);
  } finally { session.close(); }
});
test("binary websocket frame roundtrips and rejects corrupted sizes/kinds", () => {
  const udp = Uint8Array.from([0, 128, 255]);
  const encoded = encodeTransportFrame(TransportKind.UdpDatagram, udp);
  assert.deepEqual(decodeTransportFrame(encoded), {
    kind: TransportKind.UdpDatagram, payload: udp
  });
  assert.deepEqual(decodeTransportFrame(
    encodeTransportFrame(TransportKind.TcpBytes, new Uint8Array(TCP_FRAME_MAX_BYTES))
  ).payload.byteLength, TCP_FRAME_MAX_BYTES);
  for (const input of [
    new Uint8Array(0),
    new Uint8Array([1, 1]),
    Uint8Array.from([2, 2, 0, 0, 0, 1, 77]),
    Uint8Array.from([1, 9, 0, 0, 0, 1, 77]),
    Uint8Array.from([1, 2, 0, 0, 0, 2, 77]),
    Uint8Array.from([1, 2, 0, 0, 0, 1, 77, 77])
  ]) {
    assert.throws(() => decodeTransportFrame(input));
  }
  assert.throws(() => encodeTransportFrame(
    TransportKind.UdpDatagram, new Uint8Array(UDP_DATAGRAM_MAX_BYTES + 1)
  ), /invalid_transport_payload_length/);
});
test("Node.js runtime supports local native UDP echo transport (no external traffic)", async () => {
  const server = createSocket("udp4");
  const client = createSocket("udp4");
  try {
    server.on("message", (data, peer) => server.send(data, peer.port, peer.address));
    await new Promise(resolve => server.bind(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const got = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error("udp_echo_timeout")), 1500);
      client.once("message", data => { clearTimeout(timeout); resolve(data); });
      client.once("error", error => { clearTimeout(timeout); reject(error); });
    });
    client.send(Buffer.from([1, 2, 3, 255]), port, "127.0.0.1");
    assert.deepEqual(await got, Buffer.from([1, 2, 3, 255]));
  } finally {
    server.close();
    client.close();
  }
});
