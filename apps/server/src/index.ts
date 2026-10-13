/**
 * Self-hosted public HTTP entrypoint; currently health/capabilities only.
 * Private mailbox methods intentionally have no public routing.
 * Reverse-proxy TLS must be enabled for internet-facing deployment.
 */
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { routeRequest } from "../../../packages/protocol/src/router.ts";
import { openSqliteMailbox } from "./sqlite-mailbox.ts";
import { installExperimentalTcpBridge } from "./experimental-tcp-bridge.ts";

const port = Number(process.env.PORT ?? "8787");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid_PORT");
const host = process.env.HOST ?? "127.0.0.1";
if (!["127.0.0.1", "::1", "0.0.0.0"].includes(host)) throw new Error("invalid_HOST");
const dataDir = process.env.WTOX_DATA_DIR ?? "./data";
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const store = openSqliteMailbox(join(dataDir, "mailbox.sqlite"));

const server = createServer(async (req, res) => {
  try {
    // Do not trust the incoming Host header to build a Request URL.
    const base = "http://localhost:8787";
    const request = new Request(new URL(req.url ?? "/", base), {
      method: req.method,
      headers: req.headers as HeadersInit
    });
    const result = routeRequest(request, "node-selfhost");
    res.statusCode = result.status;
    for (const [name, value] of result.headers) res.setHeader(name, value);
    res.end(Buffer.from(await result.arrayBuffer()));
  } catch {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ error: "bad_request" }));
  }
});
// Only enable for local development; never expose the bearer token in public JS.
if (process.env.WTOX_EXPERIMENTAL_TCP_BRIDGE === "1") {
  if (host !== "127.0.0.1") throw Error("experimental_bridge_requires_loopback");
  const relay = {
    host: process.env.WTOX_RELAY_HOST ?? "",
    port: Number(process.env.WTOX_RELAY_PORT ?? 0),
    publicKey: process.env.WTOX_RELAY_PUBLIC_KEY ?? ""
  };
  installExperimentalTcpBridge(server, {
    origin: process.env.WTOX_EXPERIMENTAL_ORIGIN ?? "",
    token: process.env.WTOX_EXPERIMENTAL_TOKEN ?? "",
    endpoint: relay,
    allowlist: [relay]
  });
}
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.maxHeadersCount = 100;
server.listen(port, host, () => {
  console.info(`wTox v1 self-hosted API listening on ${host}:${port} (sensitive routes disabled)`);
});
function shutdown(): void {
  server.close(() => {
    store.close();
    process.exit(0);
  });
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
