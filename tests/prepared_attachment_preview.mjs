import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const app=readFileSync("frontend/src/App.jsx","utf8");
const view=readFileSync("frontend/src/PreparedAttachmentPreview.jsx","utf8");
const css=readFileSync("frontend/src/refine.css","utf8");
const photo=readFileSync("frontend/src/photo_sanitize.js","utf8");

assert.ok(app.includes('import {PreparedAttachmentPreview} from "./PreparedAttachmentPreview.jsx"'));
assert.ok(app.includes("<PreparedAttachmentPreview file={uploadFile}/>"));
assert.ok(!app.includes('<FileCard name={uploadFile.name}'),
  "Filename-only Ant Design FileCard lacks image bytes and shows a broken picture");
assert.ok(view.includes('URL.createObjectURL(file)'),
  "Preview must use the prepared File bytes as a local Blob URL");
assert.ok(view.includes('URL.revokeObjectURL(url)'),
  "Blob URL must be released whenever the modal/file is removed");
assert.ok(view.includes('useEffect(()=>{')&&view.includes('},[file]);'),
  "Changing photo must revoke the previous preview URL");
assert.ok(view.includes('src={preview}'));
assert.ok(view.includes('className="wt-prepared-image"'));
assert.ok(view.includes('onError={()=>setImageFailed(true)}'));
assert.ok(view.includes('if(!file)return null;'));
assert.ok(view.includes('/^image\\/(?:jpeg|png|webp|gif)$/i'),
  "Only known browser image formats should use the image element");
assert.ok(css.includes(".wt-attachment-modal .wt-prepared-image"));
assert.ok(css.includes("object-fit:contain"));
assert.ok(css.includes("max-height:min(42dvh,280px)"));
assert.ok(app.includes('const processed=await sanitizePhoto(file)'));
assert.ok(app.includes("setUploadFile(processed)"),
  "Preview must reference the file whose bytes will actually be uploaded");
assert.ok(app.includes('body:file'),
  "Upload must use the same prepared File rather than a different original");
assert.ok(app.includes("await h.cacheImage(transfer.id,blob)"),
  "Sender's image preview cache must remain intact after send");
assert.ok(photo.includes("new File([blob],safeRandomName(blob.type)"),
  "Photo compression and metadata removal must still occur before preview");
console.log("Prepared image file -> local Blob URL -> modal thumbnail lifecycle verified");
