import test from "node:test";
import assert from "node:assert/strict";
import { createServer as httpServer } from "node:http";
import { createServer as tcpServer, connect } from "node:net";
import { WebSocket } from "ws";
import { installExperimentalTcpBridge, EXPERIMENTAL_PATH } from "../src/experimental-tcp-bridge.ts";
import { openExperimentalTcpTunnel } from "../../../wasm/browser/tcp-tunnel.mjs";
const relay = { host: "1.1.1.1", port: 33445, publicKey: "a".repeat(64) };
const token = "c".repeat(64);
const origin = "http://127.0.0.1:9917";
async function fixture() {
  const tcp = tcpServer(socket => socket.pipe(socket));
  await new Promise(resolve => tcp.listen(0, "127.0.0.1", resolve));
  const http = httpServer((_req, res) => res.writeHead(404).end());
  const bridge = installExperimentalTcpBridge(http, {
    origin, token, endpoint: relay, allowlist: [relay],
    dial: () => connect(tcp.address().port, "127.0.0.1") // test-only echo endpoint
  });
  await new Promise(resolve => http.listen(0, "127.0.0.1", resolve));
  return {
    bridge,
    url: "ws://127.0.0.1:" + http.address().port + EXPERIMENTAL_PATH,
    factory: (url, protocol) => new WebSocket(url, protocol, { origin }),
    async close() {
      bridge.close();
      await new Promise(resolve => http.close(resolve));
      await new Promise(resolve => tcp.close(resolve));
    }
  };
}
test("browser protocol bytes survive a real WebSocket and local TCP echo server", async () => {
  const f = await fixture();
  try {
    let done;
    const response = new Promise(resolve => { done = resolve; });
    const chunks = [];
    const client = await openExperimentalTcpTunnel(f.url, token, {
      webSocketFactory: f.factory,
      onBytes(data) { chunks.push(data); done(); }
    });
    try {
      const bytes = Uint8Array.from([0, 128, 255, 1]);
      client.send(bytes);
      await Promise.race([
        response,
        new Promise((_, reject) => setTimeout(() => reject(Error("echo_timeout")), 3000))
      ]);
      assert.deepEqual(Buffer.concat(chunks.map(x => Buffer.from(x))), Buffer.from(bytes));
    } finally { client.close(); }
  } finally { await f.close(); }
});
test("unauthorized secret and wrong Origin reject the connection", async () => {
  const f = await fixture();
  try {
    await assert.rejects(openExperimentalTcpTunnel(f.url, "d".repeat(64), {
      webSocketFactory: f.factory, handshakeTimeoutMs: 1500
    }), /tcp_tunnel_closed|tcp_tunnel_connect_error/);
    await assert.rejects(openExperimentalTcpTunnel(f.url, token, {
      webSocketFactory: (url, protocol) => new WebSocket(url, protocol, { origin: "https://evil.example" }),
      handshakeTimeoutMs: 1500
    }), /tcp_tunnel_closed|tcp_tunnel_connect_error/);
    assert.equal(f.bridge.activeCount, 0);
  } finally { await f.close(); }
});
test("bridge refuses insecure secrets or private relay targets", () => {
  const server = httpServer();
  assert.throws(() => installExperimentalTcpBridge(server, {
    origin, token: "short", endpoint: relay, allowlist: [relay]
  }), /invalid_experimental_bridge_configuration/);
  assert.throws(() => installExperimentalTcpBridge(server, {
    origin, token, endpoint: { ...relay, host: "127.0.0.1" }, allowlist: [relay]
  }), /relay_not_approved/);
});
