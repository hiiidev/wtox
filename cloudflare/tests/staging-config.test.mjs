import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
test("staging uses an isolated Worker and SQLite DO, with no production hostname", () => {
  const staging = JSON.parse(readFileSync(new URL("../wrangler.staging.jsonc", import.meta.url)));
  const normal = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url)));
  assert.equal(staging.name, "wtox-v1-staging");
  assert.notEqual(staging.name, normal.name);
  assert.equal(staging.workers_dev, true);
  assert.equal(staging.routes, undefined);
  assert.equal(staging.route, undefined);
  assert.equal(staging.assets, undefined);
  assert.equal(staging.durable_objects.bindings[0].class_name, "EncryptedMailbox");
  assert.deepEqual(staging.migrations[0].new_sqlite_classes, ["EncryptedMailbox"]);
});
