/**
 * Experimental native Tox TCP-relay destination policy.
 *
 * The *operator*, not a browser request, must supply the approved list.
 * Literal publicly-routable IPv4 only: prevents DNS rebinding, localhost,
 * metadata services, RFC1918/CGNAT, documentation and multicast destinations.
 * Support for IPv6 requires another explicitly-reviewed validator.
 * No public HTTP/WebSocket endpoint uses this module yet.
 */
export interface RelayEndpoint {
  host: string;
  port: number;
  publicKey: string;
}
const KEY = /^[0-9a-fA-F]{64}$/;
function parseIPv4(address: string): number[] | null {
  if (!/^(0|[1-9][0-9]{0,2})(\.(0|[1-9][0-9]{0,2})){3}$/.test(address)) return null;
  const bytes = address.split(".").map(Number);
  return bytes.every(x => x >= 0 && x <= 255) ? bytes : null;
}
export function isPublicIPv4(address: string): boolean {
  const a = parseIPv4(address);
  if (!a) return false;
  const [x, y, z] = a;
  if (x === 0 || x === 10 || x === 127 || x >= 224) return false;
  if (x === 100 && y >= 64 && y <= 127) return false;
  if (x === 169 && y === 254) return false;
  if (x === 172 && y >= 16 && y <= 31) return false;
  if (x === 192 && (y === 168 || (y === 0 && z === 0) || (y === 0 && z === 2))) return false;
  if (x === 198 && (y === 18 || y === 19 || (y === 51 && z === 100))) return false;
  if (x === 203 && y === 0 && z === 113) return false;
  // 192.88.99.0/24 deprecated anycast, 192.0.0.0/24 and 192.0.2.0/24 special.
  if (x === 192 && y === 88 && z === 99) return false;
  if (x === 255) return false;
  return true;
}
export function assertApprovedRelay(
  candidate: unknown,
  approved: readonly RelayEndpoint[]
): asserts candidate is RelayEndpoint {
  if (typeof candidate !== "object" || candidate === null) throw new TypeError("relay_not_approved");
  const { host, port, publicKey } = candidate as Record<string, unknown>;
  if (typeof host !== "string" || !isPublicIPv4(host) ||
      typeof port !== "number" || !Number.isInteger(port) ||
      port < 1 || port > 65535 ||
      typeof publicKey !== "string" || !KEY.test(publicKey)) {
    throw new TypeError("relay_not_approved");
  }
  if (!approved.some(x =>
    x.host === host && x.port === port &&
    x.publicKey.toUpperCase() === publicKey.toUpperCase() &&
    isPublicIPv4(x.host) && Number.isInteger(x.port) &&
    x.port >= 1 && x.port <= 65535 && KEY.test(x.publicKey))) {
    throw new TypeError("relay_not_approved");
  }
}
