/** Local-only experimental WebSocket to TCP byte bridge.
 * NOT a Toxcore socket adapter. Default disabled. Never expose to the public.
 * The operator fixes the Tox relay destination, never the browser.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { dialApprovedToxRelay } from "./tcp-relay.ts";
import { assertApprovedRelay, type RelayEndpoint } from "../../../packages/protocol/src/relay-policy.ts";
import { TCP_FRAME_MAX_BYTES, TransportKind, encodeTransportFrame, decodeTransportFrame } from "../../../packages/protocol/src/transport-frame.ts";

export const EXPERIMENTAL_PATH = "/__wtox_v1_experimental/tcp";
const PROTOCOL = "wtox-v1";
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_WS_BUFFERED = 512 * 1024;
type Dial = (endpoint: RelayEndpoint, allowlist: readonly RelayEndpoint[]) => Socket;
export interface BridgeConfig {
  origin: string;
  token: string;
  endpoint: RelayEndpoint;
  allowlist: readonly RelayEndpoint[];
  dial?: Dial; // Only used by the isolated echo tests
}
function equalSecret(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}
function deny(socket: Socket, code: number): void {
  socket.end("HTTP/1.1 " + code + " Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
}
export function installExperimentalTcpBridge(server: Server, config: BridgeConfig) {
  const origin = new URL(config.origin);
  if (origin.origin !== config.origin || origin.protocol !== "http:" ||
      origin.hostname !== "127.0.0.1" || !/^[0-9a-fA-F]{64}$/.test(config.token)) {
    throw new TypeError("invalid_experimental_bridge_configuration");
  }
  assertApprovedRelay(config.endpoint, config.allowlist);
  const wss = new WebSocketServer({
    noServer: true, maxPayload: TCP_FRAME_MAX_BYTES + 6, perMessageDeflate: false,
    handleProtocols: list => list.has(PROTOCOL) ? PROTOCOL : false
  });
  const sessions = new Set<WebSocket>();
  server.on("upgrade", (request: IncomingMessage, socket: Socket, head: Buffer) => {
    if (request.url !== EXPERIMENTAL_PATH ||
        request.headers.origin !== config.origin ||
        request.headers["sec-websocket-protocol"] !== PROTOCOL ||
        sessions.size >= 4) {
      deny(socket, 403);
      return;
    }
    wss.handleUpgrade(request, socket, head, ws => {
      sessions.add(ws);
      let authed = false;
      let disposed = false;
      let tcp: Socket | null = null;
      let totalBytes = 0;
      const authTimer = setTimeout(() => ws.close(1008, "authentication_required"), 5000);
      const lifetime = setTimeout(() => ws.close(1000, "session_expired"), 120_000);
      authTimer.unref();
      lifetime.unref();
      const cleanup = () => {
        if (disposed) return;
        disposed = true;
        clearTimeout(authTimer);
        clearTimeout(lifetime);
        sessions.delete(ws);
        tcp?.destroy();
      };
      ws.on("close", cleanup);
      ws.on("error", cleanup);
      ws.on("message", (data, isBinary) => {
        if (disposed) return;
        if (!authed) {
          if (isBinary) { ws.close(1008); return; }
          const authText = data.toString();
          if (authText.length > 512) { ws.close(1008); return; }
          let auth: { type?: string; token?: string } | null = null;
          try { auth = JSON.parse(authText); } catch { ws.close(1008); return; }
          if (auth?.type !== "authenticate" || typeof auth.token !== "string" ||
              !equalSecret(auth.token, config.token)) {
            ws.close(1008);
            return;
          }
          authed = true;
          clearTimeout(authTimer);
          try {
            tcp = (config.dial ?? dialApprovedToxRelay)(config.endpoint, config.allowlist);
          } catch { ws.close(1011); return; }
          tcp.once("connect", () => {
            if (!disposed && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "ready" }));
            }
          });
          tcp.on("data", bytes => {
            if (disposed || ws.readyState !== WebSocket.OPEN) return;
            totalBytes += bytes.length;
            if (totalBytes > MAX_BYTES || ws.bufferedAmount > MAX_WS_BUFFERED) {
              ws.close(1009); return;
            }
            for (let i = 0; i < bytes.length; i += TCP_FRAME_MAX_BYTES) {
              ws.send(encodeTransportFrame(TransportKind.TcpBytes,
                bytes.subarray(i, i + TCP_FRAME_MAX_BYTES)));
            }
          });
          tcp.on("error", () => ws.close(1011));
          tcp.on("close", () => ws.close(1000));
          return;
        }
        if (!isBinary || !tcp || !tcp.writable) {
          ws.close(1008); return;
        }
        try {
          const frame = decodeTransportFrame(new Uint8Array(data as Buffer));
          if (frame.kind !== TransportKind.TcpBytes) throw new Error("tcp_only");
          totalBytes += frame.payload.length;
          if (totalBytes > MAX_BYTES || tcp.writableLength > MAX_WS_BUFFERED) {
            ws.close(1009); return;
          }
          tcp.write(frame.payload);
        } catch { ws.close(1008); }
      });
    });
  });
  return {
    get activeCount() { return sessions.size; },
    close() {
      for (const ws of sessions) ws.terminate();
      wss.close();
    }
  };
}
