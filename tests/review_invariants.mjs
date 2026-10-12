import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const read=p=>readFileSync(p,"utf8");
const readme=read("README.md"),hostCaddy=read("docs/HOST_CADDY.md");
const bundledCaddy=read("Caddyfile"),example=read(".env.example");
const disk=read("backend/attachment_disk.py");
const guard=read("backend/body_limit.py");
const app=read("frontend/src/App.jsx");
assert.match(hostCaddy,/max_size 16MB/);
assert.match(bundledCaddy,/max_size 16MB/);
assert.match(readme,/15 MB（15,000,000 字节）/);
assert.doesNotMatch(readme,/Sender\.Header|每文件最多 5 MiB|每个文件最大 5 MiB/);
assert.match(example,/attachment uploads at 15 MB/);
assert.match(example,/16 MB ceiling/);
assert.match(disk,/MAX_FILE = 15_000_000/);
assert.match(guard,/MAX_FILE_BODY = MAX_FILE/);
assert.ok(app.includes("attachmentPreparedFor.current!==peer"),
  "Do not leak an image to a newly selected peer");
assert.ok(app.includes("attachmentPreparationId.current++"),
  "Switching selected peer must invalidate background photo conversion");
assert.ok(app.includes("attachmentPreparedFor.current=null;"),
  "Old file chooser must not remain sendable");
assert.ok(app.includes('selectedRef.current!==peer'),
  "Do not display stale photo processing results in the wrong chat");
assert.ok(app.includes('const processed=await sanitizePhoto(file)'),
  "Never upload original photo directly");
assert.ok(app.includes('body:file'),
  "Upload the prepared binary body");
console.log("Prior Caddy/15MB/attachment changes and current privacy race checks OK");
