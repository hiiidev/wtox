/**
 * Node.js counterpart to the internal-only Cloudflare TCP relay dialer.
 * No HTTP route exposes this function. Tox-core and WSS framing remain TODO.
 */
import { connect, type Socket } from "node:net";
import {
  assertApprovedRelay, type RelayEndpoint
} from "../../../packages/protocol/src/relay-policy.ts";

export function dialApprovedToxRelay(
  candidate: unknown,
  operatorAllowlist: readonly RelayEndpoint[],
  timeoutMs = 8000
): Socket {
  assertApprovedRelay(candidate, operatorAllowlist);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) {
    throw new RangeError("invalid_tcp_timeout");
  }
  const socket = connect({ host: candidate.host, port: candidate.port });
  socket.setTimeout(timeoutMs, () => socket.destroy(new Error("tcp_timeout")));
  return socket;
}
