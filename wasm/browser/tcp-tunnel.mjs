/** Browser-facing WSS/TCP byte transport. NOT yet wired to native Toxcore. */
export const TCP_TUNNEL_PROTOCOL = "wtox-v1";
const MAX_CHUNK = 65536;
const MAX_BACKLOG = 512 * 1024;
function frame(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > MAX_CHUNK) {
    throw new RangeError("invalid_tcp_chunk");
  }
  const result = new Uint8Array(6 + bytes.length);
  result[0] = 1; result[1] = 1;
  new DataView(result.buffer).setUint32(2, bytes.length);
  result.set(bytes, 6);
  return result;
}
function unframe(input) {
  const bytes = new Uint8Array(input);
  if (bytes.length < 7 || bytes[0] !== 1 || bytes[1] !== 1 ||
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(2) !== bytes.length - 6 ||
      bytes.length - 6 > MAX_CHUNK) throw new Error("invalid_tcp_frame");
  return bytes.slice(6);
}
export async function openExperimentalTcpTunnel(url, token, {
  webSocketFactory = (address, protocol) => new WebSocket(address, protocol),
  onBytes = () => {}, handshakeTimeoutMs = 8000
} = {}) {
  if (typeof url !== "string" || !/^wss?:\/\//.test(url) ||
      typeof token !== "string" || !/^[0-9a-fA-F]{64}$/.test(token) ||
      typeof onBytes !== "function" ||
      !Number.isInteger(handshakeTimeoutMs) ||
      handshakeTimeoutMs < 1000 || handshakeTimeoutMs > 30000) {
    throw new TypeError("invalid_tunnel_config");
  }
  const ws = webSocketFactory(url, TCP_TUNNEL_PROTOCOL);
  ws.binaryType = "arraybuffer";
  let ready = false;
  let closed = false;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(Error("tcp_tunnel_auth_timeout")); }, handshakeTimeoutMs);
      function cleanup() {
        clearTimeout(timer);
        ws.removeEventListener("close", onClose);
        ws.removeEventListener("error", onError);
      }
      function onClose() { cleanup(); reject(Error("tcp_tunnel_closed")); }
      function onError() { cleanup(); reject(Error("tcp_tunnel_connect_error")); }
      ws.addEventListener("close", onClose);
      ws.addEventListener("error", onError);
      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({ type: "authenticate", token }));
      }, { once: true });
      ws.addEventListener("message", event => {
        try {
          if (!ready) {
            if (typeof event.data !== "string" ||
                JSON.parse(event.data)?.type !== "ready") throw Error("invalid_ready");
            ready = true;
            cleanup();
            resolve();
          } else {
            if (!(event.data instanceof ArrayBuffer)) throw Error("invalid_binary");
            onBytes(unframe(event.data));
          }
        } catch {
          ws.close();
          if (!ready) { cleanup(); reject(Error("tcp_tunnel_protocol_error")); }
        }
      });
    });
  } catch (error) {
    closed = true;
    ws.close();
    throw error;
  }
  ws.addEventListener("close", () => { closed = true; });
  return {
    send(bytes) {
      if (closed || ws.readyState !== 1) throw Error("tcp_tunnel_closed");
      if (ws.bufferedAmount > MAX_BACKLOG) throw Error("tcp_tunnel_backpressure");
      ws.send(frame(bytes));
    },
    close() { closed = true; ws.close(); },
    get closed() { return closed; }
  };
}
