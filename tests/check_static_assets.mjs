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
console.log("Vite HTML JS/CSS URLs and wtox favicon all exist");
