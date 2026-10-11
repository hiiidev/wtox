import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const code=readFileSync("frontend/history_io.js","utf8");
// Import as ESM even if the repo has no package.json "type": "module".
const h=await import("data:text/javascript;base64,"+Buffer.from(code).toString("base64"));
const me="A".repeat(64),peer="B".repeat(64);
const sample=[
 {type:"message",direction:"outgoing",public_key:peer,text:"hello",at:new Date("2025-05-01T10:20:30").getTime()},
 {type:"message",direction:"incoming",public_key:peer,text:"hi",at:new Date("2025-05-01T10:21:30").getTime()}
];
const json=h.toWtoxJson(sample,me);
assert.deepEqual(h.fromWtoxJson(json,me),sample);
assert.throws(()=>h.fromWtoxJson(json,"C".repeat(64)));
const tsv=h.toQtoxTsv(sample,peer,"Bob");
assert.match(tsv,/\tBob\thi/);
const loaded=h.fromQtoxTsv(tsv,peer,"wtox-me");
assert.deepEqual(loaded,sample);
const multiline=[{...sample[0],text:"first line\nsecond line"}];
const multilineLog=h.toQtoxTsv(multiline,peer,"Bob");
assert.equal(h.fromQtoxTsv(multilineLog,peer,"wtox-me")[0].text,"first line\nsecond line");

assert.throws(()=>h.fromQtoxTsv(tsv,peer,""));
assert.throws(()=>h.fromQtoxTsv("garbage",peer,"wtox-me"));
console.log("history interchange JSON and qTox TSV roundtrip OK");
