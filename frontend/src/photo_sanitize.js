/** Browser-only photo sanitization before any bytes reach Tox/VPS.
 * Canvas pixels contain no source EXIF, GPS, maker notes or ICC metadata.
 * Animated GIF and SVG are not photo types here and are left as attachments.
 */
export const MAX_SOURCE_PHOTO_BYTES = 40_000_000;
export const MAX_PHOTO_PIXELS = 48_000_000;
export const MAX_PHOTO_EDGE = 2560;
export const MAX_SANITIZED_BYTES = 15_000_000;
const PHOTO_EXT = /\.(?:jpe?g|png|webp|heic|heif|bmp)$/i;
const PHOTO_TYPES = new Set([
  "image/jpeg","image/png","image/webp","image/heic","image/heif","image/bmp"
]);

export function isPhotoAttachment(file) {
  if (!file) return false;
  const type=String(file.type||"").toLowerCase();
  // Never flatten an animated GIF or silently alter an SVG vector.
  if (type==="image/gif" || type==="image/svg+xml" ||
      /\.(?:gif|svg)$/i.test(file.name||"")) return false;
  return PHOTO_TYPES.has(type) || PHOTO_EXT.test(file.name||"");
}

function loadImage(url) {
  return new Promise((resolve,reject)=>{
    const img=new Image();
    img.onload=()=>resolve(img);
    img.onerror=()=>reject(new Error("此浏览器无法解码所选照片，请换用 JPG 或 PNG"));
    img.src=url;
  });
}
function writeCanvas(canvas, format, quality) {
  return new Promise((resolve,reject)=>{
    canvas.toBlob(blob=>{
      if (!blob || !blob.size || !["image/jpeg","image/png","image/webp"].includes(blob.type))
        reject(new Error("照片重新编码失败，未发送原图"));
      else resolve(blob);
    },format,quality);
  });
}
function safeRandomName(type) {
  const ext=type==="image/png"?"png":type==="image/webp"?"webp":"jpg";
  // Original camera filenames may themselves include capture time or location.
  return "photo-"+crypto.randomUUID().replace(/-/g,"").slice(0,12)+"."+ext;
}

export async function sanitizePhoto(file) {
  if (!isPhotoAttachment(file)) return file;
  if (file.size===0 || file.size>MAX_SOURCE_PHOTO_BYTES)
    throw new Error("照片原文件须小于 40 MB，处理前不会上传");
  const url=URL.createObjectURL(file);
  try {
    const image=await loadImage(url);
    const w=image.naturalWidth,h=image.naturalHeight;
    if (!w || !h || !Number.isSafeInteger(w*h) || w*h>MAX_PHOTO_PIXELS)
      throw new Error("照片分辨率过大，未发送未经清理的原图");
    // PNG/WebP are encoded with transparency preserved. JPEG/HEIC become JPEG.
    const sourceType=String(file.type||"").toLowerCase();
    const transparent=/(?:png|webp)/.test(sourceType) || /\.(?:png|webp)$/i.test(file.name||"");
    const format=transparent?"image/webp":"image/jpeg";
    let scale=Math.min(1,MAX_PHOTO_EDGE/Math.max(w,h));
    let quality=0.82;
    for (let attempt=0;attempt<8;attempt++) {
      const canvas=document.createElement("canvas");
      canvas.width=Math.max(1,Math.floor(w*scale));
      canvas.height=Math.max(1,Math.floor(h*scale));
      const context=canvas.getContext("2d",{alpha:transparent});
      if (!context) throw new Error("当前浏览器不支持安全照片处理");
      context.imageSmoothingEnabled=true;
      context.imageSmoothingQuality="high";
      if (!transparent) {
        context.fillStyle="#fff";
        context.fillRect(0,0,canvas.width,canvas.height);
      }
      context.drawImage(image,0,0,canvas.width,canvas.height);
      // Re-encode pixels: never fall back to the original EXIF-bearing file.
      const blob=await writeCanvas(canvas,format,quality);
      canvas.width=0;canvas.height=0;
      if (blob.size<=MAX_SANITIZED_BYTES) {
        return new File([blob],safeRandomName(blob.type),{
          type:blob.type,lastModified:Date.now()
        });
      }
      scale*=0.72;
      quality=Math.max(0.6,quality-0.08);
    }
    throw new Error("照片压缩后仍超过 15 MB，未发送原图");
  } finally {
    URL.revokeObjectURL(url);
  }
}
