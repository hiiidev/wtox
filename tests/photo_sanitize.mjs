import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {isPhotoAttachment,sanitizePhoto,MAX_SANITIZED_BYTES,MAX_SOURCE_PHOTO_BYTES}
  from "../frontend/src/photo_sanitize.js";

assert.equal(MAX_SANITIZED_BYTES,15_000_000);
assert.equal(MAX_SOURCE_PHOTO_BYTES,40_000_000);
for(const [name,type] of [
  ["IMG_1001.jpg","image/jpeg"],["photo.png","image/png"],
  ["pic.webp","image/webp"],["capture.heic","image/heic"],
  ["capture.heif","image/heif"],["old.bmp","image/bmp"]
]) assert.equal(isPhotoAttachment({name,type}),true);
assert.equal(isPhotoAttachment({name:"animation.gif",type:"image/gif"}),false);
assert.equal(isPhotoAttachment({name:"vector.svg",type:"image/svg+xml"}),false);
assert.equal(isPhotoAttachment({name:"book.pdf",type:"application/pdf"}),false);

const gif=new File(["GIF89a-METADATA"],"animation.gif",{type:"image/gif"});
assert.strictEqual(await sanitizePhoto(gif),gif,
  "Animated GIF must never silently lose all but its first frame");

const origCreate=URL.createObjectURL,origRevoke=URL.revokeObjectURL;
const origImage=globalThis.Image,origDocument=globalThis.document;
const urls=[],revoked=[],sizeCalls=[],canvasOptions=[];
let dimensions=[4000,3000],resultType="image/jpeg",shouldFailDecode=false;
let encodeFail=false,produceOversizeOnce=false;
URL.createObjectURL=file=>{
  urls.push(file);
  return "blob:mock-photo-"+urls.length;
};
URL.revokeObjectURL=url=>revoked.push(url);
globalThis.Image=class {
  naturalWidth=dimensions[0];naturalHeight=dimensions[1];
  set src(_) {
    queueMicrotask(()=>{
      if(shouldFailDecode)this.onerror?.();
      else this.onload?.();
    });
  }
};
globalThis.document={
  createElement(tag) {
    assert.equal(tag,"canvas");
    const canvas={width:0,height:0};
    canvas.getContext=(kind,options)=>{
      assert.equal(kind,"2d");
      canvasOptions.push(options);
      return {
        fillRect(){},drawImage(){sizeCalls.push([canvas.width,canvas.height])},
        set fillStyle(value){},set imageSmoothingEnabled(value){},
        set imageSmoothingQuality(value){}
      };
    };
    canvas.toBlob=(done,format,quality)=>{
      assert.equal(quality<=0.82,true);
      if(encodeFail){done(null);return}
      const desired=resultType==="auto"?format:resultType;
      const length=produceOversizeOnce ? 15_000_001 : 200;
      produceOversizeOnce=false;
      done(new Blob([new Uint8Array(length)],{type:desired}));
    };
    return canvas;
  }
};
try {
  const original=new File(["EXIF_GPS_COORDINATES_SECRET"],"IMG_2026-10-13_GPS.jpg",
                          {type:"image/jpeg"});
  const jpeg=await sanitizePhoto(original);
  assert.notStrictEqual(jpeg,original);
  assert.equal(jpeg.type,"image/jpeg");
  assert.match(jpeg.name,/^photo-[0-9a-f]{12}\.jpg$/);
  assert.equal(jpeg.size,200);
  assert.doesNotMatch(await jpeg.text(),/EXIF|GPS|SECRET/);
  assert.equal(await original.text(),"EXIF_GPS_COORDINATES_SECRET",
    "Original file is never modified");
  assert.deepEqual(sizeCalls[0],[2560,1920],"Resize large images locally");
  assert.equal(canvasOptions[0].alpha,false);
  assert.equal(revoked.length,1,"Always release original photo Blob URL");

  const png=new File(["eXIf-secret"],"geotag.png",{type:"image/png"});
  resultType="image/webp";
  const webp=await sanitizePhoto(png);
  assert.equal(webp.type,"image/webp");
  assert.match(webp.name,/\.webp$/);
  assert.equal(canvasOptions[1].alpha,true,"Preserve alpha transparency");
  assert.doesNotMatch(await webp.text(),/eXIf-secret/);

  resultType="image/png"; // Safari without image/webp canvas export
  const pngFallback=await sanitizePhoto(png);
  assert.equal(pngFallback.type,"image/png");
  assert.match(pngFallback.name,/\.png$/);

  resultType="image/jpeg";
  produceOversizeOnce=true;
  const resized=await sanitizePhoto(original);
  assert.ok(resized.size<=MAX_SANITIZED_BYTES);
  assert.ok(sizeCalls.at(-1)[0]<sizeCalls.at(-2)[0],
    "Oversized encoded photos are shrunk again, never uploaded raw");

  await assert.rejects(sanitizePhoto({size:40_000_001,name:"huge.jpg",type:"image/jpeg"}),
                       /40 MB/);
  dimensions=[100_000,100_000];
  await assert.rejects(sanitizePhoto(original),/分辨率过大/);
  dimensions=[4000,3000];
  shouldFailDecode=true;
  await assert.rejects(sanitizePhoto(original),/无法解码/);
  shouldFailDecode=false;
  encodeFail=true;
  await assert.rejects(sanitizePhoto(original),/重新编码失败/);
  assert.equal(revoked.length,urls.length,
    "Every success and error must free its source URL");
} finally {
  URL.createObjectURL=origCreate;URL.revokeObjectURL=origRevoke;
  globalThis.Image=origImage;globalThis.document=origDocument;
}

const app=readFileSync("frontend/src/App.jsx","utf8");
assert.ok(app.includes('void prepareAttachment(file);'));
assert.ok(app.includes('const processed=await sanitizePhoto(file);'));
assert.ok(app.includes('setUploadFile(processed)'));
assert.ok(app.includes('processed.size>MAX_ATTACHMENT_BYTES'));
assert.ok(app.includes("attachmentPreparedFor.current=peer"),
  "Prepared photo must be tied to the selected recipient");
assert.ok(app.includes("attachmentPreparedFor.current!==peer"),
  "Sending must abort if the recipient changed");
assert.ok(app.includes("attachmentPreparationId.current++"),
  "Switching conversations must invalidate in-flight photo processing");
assert.ok(app.includes('selectedRef.current!==peer'),
  "Async photo processing must not select a file for a different chat");
assert.ok(app.includes('loading={preparingPhoto}'));
assert.ok(app.includes('body:file'),"Send the post-processing File, never the original");
assert.ok(app.includes("await h.cacheImage(transfer.id,blob)"),
  "Image preview remains locally encrypted after sending");
console.log("On-device photo resize, EXIF avoidance, MIME, fail-closed and size checks OK");
