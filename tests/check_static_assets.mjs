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
assert.match(html,/\\/logo\\.svg\\?t=[a-z0-9]+/,"Logo query must change on every Vite build");
const backend=readFileSync("backend/main.py","utf8");
assert.match(backend,/app\\.mount\\("\\/icons"/,"Backend must serve generated PWA PNGs");
console.log("Vite JS/CSS, versioned SVG and all PWA PNG icons exist");
