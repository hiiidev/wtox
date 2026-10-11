import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const html = readFileSync("frontend/index.html", "utf8");
const js = readFileSync("frontend/app.js", "utf8");
const css = readFileSync("frontend/app.css", "utf8");

const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m=>m[1]));
const jsIds = new Set([...js.matchAll(/\$\("#([^"]+)"\)/g)].map(m=>m[1]));
for(const id of jsIds) {
  assert.ok(htmlIds.has(id), "JS references missing UI ID: #" + id);
}
for(const required of ["friends","messages","contactSearch","selectedStatus",
                       "backToContacts","profileFile","historyDialog","send"]) {
  assert.ok(htmlIds.has(required), "Critical UI control absent: #" + required);
}
assert.match(css, /@media\(max-width:650px\)/, "Missing phone layout");
assert.match(css, /\.app-window\.chat-open \.chat-pane/, "Missing mobile conversation view");
assert.match(css, /\.bubble-row\.mine/, "Missing outgoing message bubble");
assert.match(js, /function updateComposer\(/, "Missing online/offline send UX");
assert.match(js, /friend\.status|f\.status/, "Missing per-friend presence");
assert.ok(js.includes("beginHistoryForIdentity()"), "auto-open must run");
assert.ok(js.includes("migrateLegacyHistory()"), "legacy migration must run");
assert.ok(js.includes("generateKey("), "device key creation is required");
assert.ok(js.includes("AUTO_KEY_ID"), "device key must persist per browser");
assert.ok(js.includes("historyDb.transaction([\"meta\",\"events\"],\"readwrite\")"), "legacy history must migrate atomically");
console.log("wtox local history automatic setup checks OK");
console.log("wtox desktop/mobile messenger UI structure OK");
