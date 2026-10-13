/**
 * Internal-only experimental, outbound UDP socket bound to a single
 * operator-approved Tox endpoint.
 *
 * This module does NOT expose an HTTP/WebSocket endpoint and does NOT
 * accept arbitrary peer destinations. Full Tox UDP DHT and NAT traversal
 * require a separate security-reviewed design and Toxcore WASM adapter.
 *
 * Exact approved host+port+key is only a routing policy. Actual Tox peer
 * authentication still belongs inside browser-side Toxcore. No keys are used
 * or stored in this UDP module.
 */
import { createSocket, type Socket, type RemoteInfo } from "node:dgram";
import {
  assertApprovedRelay, type RelayEndpoint
} from "../../../packages/protocol/src/relay-policy.ts";
import { UDP_DATAGRAM_MAX_BYTES } from "../../../packages/protocol/src/transport-frame.ts";

const MAX_SESSION_MS = 120_000;
const PACKETS_PER_SECOND = 60;
const MAX_BYTES_PER_SECOND = 64 * 1024;

export interface UdpTransportSession {
  send(packet: Uint8Array): Promise<void>;
  close(): void;
  readonly closed: boolean;
}
export interface UdpTransportOptions {
  /** Dependency injection for isolated tests; never accept over HTTP. */
  socketFactory?: () => Socket;
  now?: () => number;
  maxDurationMs?: number;
}

/**
 * Open one short-lived, outbound-only, connected UDP socket.
 * No dynamic destination selection, no raw user-selected destinations.
 * Per-second caps are applied in both directions; oversized packets drop.
 */
export async function openApprovedUdpSession(
  endpoint: unknown,
  operatorAllowlist: readonly RelayEndpoint[],
  onDatagram: (packet: Uint8Array) => void,
  options: UdpTransportOptions = {}
): Promise<UdpTransportSession> {
  assertApprovedRelay(endpoint, operatorAllowlist);
  if (typeof onDatagram !== "function") throw new TypeError("invalid_udp_callback");
  const maxDurationMs = options.maxDurationMs ?? 60_000;
  if (!Number.isInteger(maxDurationMs) ||
      maxDurationMs < 1000 || maxDurationMs > MAX_SESSION_MS) {
    throw new RangeError("invalid_udp_session_duration");
  }
  const clock = options.now ?? Date.now;
  const socket = (options.socketFactory ?? (() => createSocket("udp4")))();
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const startedAt = clock();
  let outboundWindow = Math.floor(startedAt / 1000);
  let inboundWindow = outboundWindow;
  let outgoingCount = 0, incomingCount = 0;
  let outgoingBytes = 0, incomingBytes = 0;

  function close(): void {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    try { socket.close(); } catch { /* socket may already be closed */ }
  }
  function expired(): boolean {
    if (clock() - startedAt >= maxDurationMs) { close(); return true; }
    return false;
  }
  function claim(direction: "in" | "out", size: number): boolean {
    const second = Math.floor(clock() / 1000);
    if (direction === "in") {
      if (second !== inboundWindow) {
        inboundWindow = second; incomingCount = 0; incomingBytes = 0;
      }
      if (++incomingCount > PACKETS_PER_SECOND ||
          (incomingBytes += size) > MAX_BYTES_PER_SECOND) return false;
    } else {
      if (second !== outboundWindow) {
        outboundWindow = second; outgoingCount = 0; outgoingBytes = 0;
      }
      if (++outgoingCount > PACKETS_PER_SECOND ||
          (outgoingBytes += size) > MAX_BYTES_PER_SECOND) return false;
    }
    return true;
  }

  socket.on("message", (packet: Buffer, remote: RemoteInfo) => {
    if (closed || expired() || packet.byteLength < 1 ||
        packet.byteLength > UDP_DATAGRAM_MAX_BYTES ||
        remote.address !== endpoint.host || remote.port !== endpoint.port ||
        !claim("in", packet.byteLength)) return;
    try {
      onDatagram(Uint8Array.from(packet));
    } catch {
      close(); // do not throw from a UDP event handler
    }
  });
  socket.on("error", () => close());

  try {
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => {
        socket.off("error", failed);
        reject(error);
      };
      socket.once("error", failed);
      try {
        socket.connect(endpoint.port, endpoint.host, () => {
          socket.off("error", failed);
          resolve();
        });
      } catch (error) {
        socket.off("error", failed);
        reject(error);
      }
    });
  } catch (error) {
    close();
    throw error;
  }
  timer = setTimeout(close, maxDurationMs);
  timer.unref();

  return {
    get closed() { return closed; },
    close,
    async send(packet: Uint8Array): Promise<void> {
      if (closed || expired()) throw new Error("udp_session_closed");
      if (!(packet instanceof Uint8Array) ||
          packet.byteLength < 1 || packet.byteLength > UDP_DATAGRAM_MAX_BYTES) {
        throw new RangeError("invalid_udp_datagram");
      }
      if (!claim("out", packet.byteLength)) throw new Error("udp_rate_limited");
      await new Promise<void>((resolve, reject) => {
        socket.send(Buffer.from(packet), error => {
          if (error) { close(); reject(error); }
          else resolve();
        });
      });
    }
  };
}
