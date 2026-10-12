import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const moduleCode=readFileSync("frontend/src/attachment_ui.js","utf8");
const {MAX_ATTACHMENT_BYTES,formatAttachmentSize,mergeFileTimeline}=
  await import("data:text/javascript;base64,"+Buffer.from(moduleCode).toString("base64"));
const app=readFileSync("frontend/src/App.jsx","utf8");
const css=readFileSync("frontend/src/refine.css","utf8");
const sw=readFileSync("frontend/public/sw.js","utf8");
assert.equal(MAX_ATTACHMENT_BYTES,15_000_000);
assert.equal(formatAttachmentSize(15_000_000),"15.00 MB");
assert.equal(formatAttachmentSize(1_500_000),"1.50 MB");
assert.equal(formatAttachmentSize(540),"540 B");
assert.ok(!formatAttachmentSize(8_000_000).includes("MiB"));

const peer="A".repeat(64);
const thumbnail=new Blob(["preview"]);
const pending={id:"pending-file-1",type:"file",direction:"outgoing",
  public_key:peer,file_id:null,file_name:"a.png",file_size:15000000,
  file_state:"uploading",at:1000,previewBlob:thumbnail};
const committed={id:"file-xyz",file_id:"xyz",type:"file",direction:"outgoing",
  public_key:peer,file_name:"a.png",file_size:15000000,
  file_state:"completed",at:3000};
let rows=mergeFileTimeline([committed],[pending],peer);
assert.equal(rows.length,1,"Native realtime callbacks and optimistic upload must form one bubble");
assert.equal(rows[0].id,"file-xyz");
assert.equal(rows[0].file_state,"completed");
assert.equal(rows[0].previewBlob,thumbnail,"Preserve local image before encrypted cache is ready");

rows=mergeFileTimeline([committed],[{...pending,file_id:"xyz"}],peer);
assert.equal(rows.length,1,"Canonical file ID has precedence over optimistic ID");
rows=mergeFileTimeline([committed],[{...pending,file_name:"different.png"}],peer);
assert.equal(rows.length,2,"Different files must never merge");
rows=mergeFileTimeline([committed,{...committed,id:"file-other",file_id:"other"}],[],peer);
assert.equal(rows.length,2,"Separate persisted transfers must never merge");
rows=mergeFileTimeline([], [{...pending,file_state:"failed"}],peer);
assert.equal(rows.length,1,"Failed upload remains visible for inspection");
rows=mergeFileTimeline([committed],[pending],"B".repeat(64));
assert.equal(rows.length,0,"Conversation isolation must remain strict");

assert.match(app,/mergeFileTimeline\(messages,pendingFiles,selected\)/);
assert.match(app,/setPendingFiles\(previous=>previous\.map\(entry=>entry\.id===localId[\s\S]*file_id:transfer\.id/);
assert.match(app,/wt-text-context-target wt-selectable-message/);
assert.match(app,/wt-file-context-target wt-selectable-message/);
assert.match(css,/\.wt-text-context-target\{/);
assert.match(css,/\.wt-file-context-target\{/);
assert.match(app,/MAX_ATTACHMENT_BYTES/);
assert.match(app,/formatAttachmentSize\(file\.file_size\)/);
assert.match(sw,/你有好友请求"/);
assert.match(sw,/你收到了一条新消息"/);
assert.doesNotMatch(sw,/你有好友请求。|你收到了一条新消息。/);
console.log("15 MB unit formatting, no duplicate file bubbles, exact context menus and notification copy OK");
