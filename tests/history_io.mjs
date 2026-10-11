import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const src=readFileSync("frontend/history_io.js","utf8");
const h=await import("data:text/javascript;base64,"+Buffer.from(src).toString("base64"));
const me="A".repeat(64),peer="B".repeat(64);
const messages=[
 {type:"message",direction:"outgoing",public_key:peer,text:"hello\n世界",at:1746094830000},
 {type:"message",direction:"incoming",public_key:peer,text:"hi",at:1746094890000}
];
const json=h.toWtoxJson(messages,me);
assert.deepEqual(h.fromWtoxJson(json,me),messages);
assert.throws(()=>h.fromWtoxJson(json,"C".repeat(64)),
 "Cross-identity backup must not be importable");
assert.throws(()=>h.fromWtoxJson('{"format":"aTox"}',me),
 "Unknown formats must fail closed rather than claim aTox compatibility");
assert.equal(typeof h.toQtoxTsv,"undefined");
assert.equal(typeof h.fromQtoxTsv,"undefined");
console.log("wTox self-contained JSON history backup checks OK");
