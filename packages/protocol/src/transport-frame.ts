/**
 * Experimental browser-to-gateway binary transport frame.
 * Framing alone is NOT encryption, authentication, nor a Tox network adapter.
 * One whole frame per binary WebSocket message; TCP payload is a byte-stream
 * fragment, UDP payload is one complete atomic datagram.
 */
export const TRANSPORT_FRAME_VERSION = 1;
export const TCP_FRAME_MAX_BYTES = 64 * 1024;
export const UDP_DATAGRAM_MAX_BYTES = 1400;
const HEADER_BYTES = 6;

export const TransportKind = {
  TcpBytes: 1,
  UdpDatagram: 2
} as const;
export type TransportKind = typeof TransportKind[keyof typeof TransportKind];
export type TransportFrame = { kind: TransportKind; payload: Uint8Array };

export function encodeTransportFrame(kind: TransportKind, payload: Uint8Array): Uint8Array {
  if (!(payload instanceof Uint8Array) ||
      (kind !== TransportKind.TcpBytes && kind !== TransportKind.UdpDatagram)) {
    throw new TypeError("invalid_transport_frame");
  }
  const limit = kind === TransportKind.TcpBytes ?
    TCP_FRAME_MAX_BYTES : UDP_DATAGRAM_MAX_BYTES;
  if (payload.byteLength < 1 || payload.byteLength > limit) {
    throw new RangeError("invalid_transport_payload_length");
  }
  const frame = new Uint8Array(HEADER_BYTES + payload.byteLength);
  frame[0] = TRANSPORT_FRAME_VERSION;
  frame[1] = kind;
  new DataView(frame.buffer).setUint32(2, payload.byteLength, false);
  frame.set(payload, HEADER_BYTES);
  return frame;
}

export function decodeTransportFrame(frame: Uint8Array): TransportFrame {
  if (!(frame instanceof Uint8Array) || frame.byteLength < HEADER_BYTES) {
    throw new TypeError("invalid_transport_frame");
  }
  const kind = frame[1];
  if (frame[0] !== TRANSPORT_FRAME_VERSION ||
      (kind !== TransportKind.TcpBytes && kind !== TransportKind.UdpDatagram)) {
    throw new TypeError("invalid_transport_frame");
  }
  const length = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(2, false);
  const limit = kind === TransportKind.TcpBytes ?
    TCP_FRAME_MAX_BYTES : UDP_DATAGRAM_MAX_BYTES;
  if (length < 1 || length > limit || frame.byteLength !== HEADER_BYTES + length) {
    throw new RangeError("invalid_transport_payload_length");
  }
  return {
    kind,
    // Copy to prevent mutable input buffer aliasing.
    payload: frame.slice(HEADER_BYTES)
  };
}
