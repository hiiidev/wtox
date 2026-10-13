/**
 * Experimental TCP-only native Tox relay dialer, not a public HTTP API.
 * This establishes a raw TCP transport, NOT a complete WSS/Tox WASM adapter.
 * Callers MUST first authenticate devices, authorize the relay, and apply
 * per-session connection/byte quotas before using a socket for bridging.
 */
import { connect } from "cloudflare:sockets";
import {
  assertApprovedRelay,
  type RelayEndpoint
} from "../../packages/protocol/src/relay-policy.ts";

export function dialApprovedToxRelay(
  candidate: unknown,
  operatorAllowlist: readonly RelayEndpoint[]
) {
  assertApprovedRelay(candidate, operatorAllowlist);
  // Tox itself uses an authenticated encrypted transport over this raw TCP.
  // A TLS-wrapping socket here would not speak the native Tox relay protocol.
  return connect({ hostname: candidate.host, port: candidate.port }, {
    secureTransport: "off"
  });
}
