import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const workflow=readFileSync(".github/workflows/cleanup-merged-branches.yml","utf8");
assert.match(workflow,/contains\(github\.event\.head_commit\.message, '\[cleanup-merged-branches\]'\)/);
assert.match(workflow,/branches: \[main\]/);
assert.match(workflow,/contents: write/);
assert.match(workflow,/merged_at/);
assert.match(workflow,/current.*expected/);
assert.match(workflow,/pr_sha.*expected/);
assert.match(workflow,/gh api --method DELETE/);
assert.doesNotMatch(workflow,/\|main\|/);
const rows=[...workflow.matchAll(/^\s+'(\d+)\|([^|]+)\|([0-9a-f]{40}|CURRENT)'$/gm)]
  .map(match=>({pr:Number(match[1]),branch:match[2],sha:match[3]}));
assert.equal(rows.length,22,"Only the known 22 PR branches should be targeted");
assert.equal(new Set(rows.map(row=>row.branch)).size,22);
assert.deepEqual(rows.map(row=>row.pr).sort((a,b)=>a-b),
  Array.from({length:22},(_,i)=>i+1));
assert.deepEqual(rows.filter(row=>row.sha==="CURRENT").map(row=>row.pr),[22]);
for(const row of rows) {
  assert.notEqual(row.branch,"main");
  assert.match(row.branch,/^(feat|fix|refine|security|style)\//);
  assert.doesNotMatch(row.branch,/[;&|$'"\\\s]/);
}
console.log("One-time branch cleanup allowlist, merged checks and SHA leases verified");
