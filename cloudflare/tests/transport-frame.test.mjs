import test from "node:test";
import assert from "node:assert/strict";
import {
  encodeTransportFrame, decodeTransportFrame, TransportKind,
  UDP_DATAGRAM_MAX_BYTES
} from "../../packages/protocol/src/transport-frame.ts";

test("binary transport frames are portable between browser and Cloudflare runtime", () => {
  const payload = Uint8Array.from([0, 1, 128, 255]);
  const frame = encodeTransportFrame(TransportKind.UdpDatagram, payload);
  assert.equal(frame.byteLength, payload.byteLength + 6);
  assert.deepEqual(decodeTransportFrame(frame), { kind: TransportKind.UdpDatagram, payload });
  assert.equal(decodeTransportFrame(
    encodeTransportFrame(TransportKind.TcpBytes, payload)
  ).kind, TransportKind.TcpBytes);
  assert.throws(() => encodeTransportFrame(
    TransportKind.UdpDatagram, new Uint8Array(UDP_DATAGRAM_MAX_BYTES + 1)
  ));
});
