import assert from "node:assert/strict";
import {existsSync,readFileSync,readdirSync} from "node:fs";
import {resolve,dirname,join} from "node:path";
const root=resolve("frontend/dist");
const htmlPath=join(root,"index.html");
assert.ok(existsSync(htmlPath),"Vite dist/index.html was not built");
const html=readFileSync(htmlPath,"utf8");
const referenced=[...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(x=>x[1]);
assert.ok(referenced.some(x=>x.endsWith(".js")),"index.html missing compiled JavaScript URL");
assert.ok(referenced.some(x=>x.endsWith(".css")),"index.html missing compiled CSS URL");
for(const name of referenced){
  const local=join(root,name.replace(/^\//,""));
  assert.ok(existsSync(local),"Static asset referenced by React HTML is missing: "+name);
}
const icon=join(root,"logo.svg");
assert.ok(existsSync(icon),"Generated logo favicon must be present in Vite output");

const {readFileSync: read}=await import("node:fs");
for (const size of [180, 192, 512, 1024]) {
  const file=join(root,"icons",`icon-${size}.png`);
  assert.ok(existsSync(file),`PWA PNG ${size}x${size} missing from Vite output`);
  const data=read(file);
  assert.equal(data.subarray(0,8).toString("hex"),"89504e470d0a1a0a","Invalid PNG signature");
  assert.equal(data.readUInt32BE(16),size,"PNG width mismatch");
  assert.equal(data.readUInt32BE(20),size,"PNG height mismatch");
}
assert.ok(html.includes("/logo.svg?t="),"Logo query must change on every Vite build");
// UI favicon and installed-app icons deliberately use different source artwork.
const uiLogo=readFileSync("frontend/public/logo.svg","utf8");
const pwaArt=readFileSync("frontend/scripts/pwa-icon-source.svg","utf8");
const generator=readFileSync("frontend/scripts/generate_pwa_icons.mjs","utf8");
assert.match(uiLogo, /fill="#07C160"/, "UI SVG should be the provided green outline artwork");
assert.ok(!uiLogo.includes("<rect"), "UI SVG must be transparent (no app-icon background)");
assert.match(pwaArt, /<rect[^>]*fill="#07C160"/, "PWA source must have the green square background");
assert.match(pwaArt, /fill="#fff"/, "PWA icon must use the white-filled speech balloon");
assert.match(generator, /scripts\\/pwa-icon-source\\.svg/, "PNG generation must use PWA artwork, not the UI SVG");
assert.ok(!generator.includes('public/logo.svg'), "Do not generate app PNGs from favicon SVG");
const manifest=JSON.parse(readFileSync("frontend/dist/manifest.webmanifest","utf8"));
assert.deepEqual(manifest.icons.map(icon=>icon.type),["image/png","image/png"]);
assert.ok(manifest.icons.every(icon=>icon.src.includes("?v=4d7f4d8f")),
  "Manifest icon URLs should bypass previously cached PWA images");
assert.ok(html.includes("icon-180.png?v=4d7f4d8f"), "Apple touch icon should bypass its old cached version");
const backend=readFileSync("backend/main.py","utf8");
assert.ok(backend.includes('app.mount("/icons"'),"Backend must serve generated PWA PNGs");
console.log("Vite JS/CSS, versioned SVG and all PWA PNG icons exist");
