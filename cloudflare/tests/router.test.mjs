import assert from "node:assert/strict";
import test from "node:test";
import { routeRequest } from "../src/router.ts";

const request = (path, method = "GET") =>
  new Request("https://chat.example.test" + path, { method });

test("health is public and never cached", async () => {
  const response = routeRequest(request("/api/v1/health"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
  assert.deepEqual(await response.json(), {
    status: "ok", service: "wtox-edge", version: "v1"
  });
});

test("capabilities accurately report unfinished sensitive features", async () => {
  const response = routeRequest(request("/api/v1/capabilities"));
  const data = await response.json();
  assert.equal(data.public_mailbox_api, "disabled");
  assert.equal(data.tox_wasm, "not_implemented");
  assert.equal(data.e2ee_devices, "not_implemented");
});

test("mailbox/relay/identity/push routes fail closed", async () => {
  for (const path of [
    "/api/v1/mailboxes/alice/messages",
    "/api/v1/relay",
    "/api/v1/identity/register",
    "/api/v1/push/subscribe"
  ]) {
    const response = routeRequest(request(path, "POST"));
    assert.equal(response.status, 501, path);
    assert.equal((await response.json()).error, "not_implemented");
  }
});

test("unsupported method and path never fall through", async () => {
  assert.equal(routeRequest(request("/api/v1/health", "POST")).status, 405);
  assert.equal(routeRequest(request("/api/v1/capabilities", "DELETE")).status, 405);
  assert.equal(routeRequest(request("/api/messages", "POST")).status, 404);
  assert.equal(routeRequest(request("/")).status, 404);
});
