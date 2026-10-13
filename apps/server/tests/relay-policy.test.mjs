import assert from "node:assert/strict";
import test from "node:test";
import {
  assertApprovedRelay, isPublicIPv4
} from "../../../packages/protocol/src/relay-policy.ts";

const allowed = [{ host: "1.1.1.1", port: 33445, publicKey: "a".repeat(64) }];
test("explicit public IPv4 relay and Tox public key allowlist", () => {
  assert.equal(isPublicIPv4("1.1.1.1"), true);
  assert.equal(isPublicIPv4("8.8.8.8"), true);
  assert.doesNotThrow(() => assertApprovedRelay({
    host: "1.1.1.1", port: 33445, publicKey: "A".repeat(64)
  }, allowed));
  assert.throws(() => assertApprovedRelay({
    host: "1.1.1.1", port: 33446, publicKey: "a".repeat(64)
  }, allowed), /not_approved/);
  assert.throws(() => assertApprovedRelay({
    host: "1.1.1.1", port: 33445, publicKey: "b".repeat(64)
  }, allowed), /not_approved/);
  assert.throws(() => assertApprovedRelay({
    host: "8.8.8.8", port: 33445, publicKey: "a".repeat(64)
  }, allowed), /not_approved/);
});
test("reject private, link-local, reserved, malformed, and DNS endpoints", () => {
  for (const host of [
    "0.0.0.0", "10.0.0.1", "127.0.0.1", "100.64.0.1",
    "169.254.169.254", "172.16.0.1", "192.168.1.5",
    "192.0.2.1", "198.18.0.1", "198.51.100.1",
    "203.0.113.1", "224.0.0.1", "255.255.255.255",
    "1.1.1.01", "256.1.1.1", "::1", "[::1]",
    "localhost", "example.org", "1.1.1.1.evil.net"
  ]) {
    assert.equal(isPublicIPv4(host), false, host);
    assert.throws(() => assertApprovedRelay({
      host, port: 33445, publicKey: "a".repeat(64)
    }, [{ host, port: 33445, publicKey: "a".repeat(64) }]), /not_approved/, host);
  }
});
test("reject malformed port, missing key and default-open relay lists", () => {
  for (const port of [0, -1, 65536, 33445.1, "33445"]) {
    assert.throws(() => assertApprovedRelay({
      host: "1.1.1.1", port, publicKey: "a".repeat(64)
    }, allowed), /not_approved/);
  }
  assert.throws(() => assertApprovedRelay({
    host: "1.1.1.1", port: 33445, publicKey: "a".repeat(64)
  }, []), /not_approved/);
});
