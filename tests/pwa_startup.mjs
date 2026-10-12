import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";

const html=readFileSync("frontend/dist/index.html","utf8");
const css=readFileSync("frontend/src/style.css","utf8");
const refine=readFileSync("frontend/src/refine.css","utf8");
const manifest=JSON.parse(readFileSync("frontend/dist/manifest.webmanifest","utf8"));

assert.match(html,/<meta name="mobile-web-app-capable" content="yes">/);
assert.match(html,/<meta name="apple-mobile-web-app-capable" content="yes">/,
  "Retain iOS compatibility while adding the standardized-capability hint");
assert.match(html,/<meta name="theme-color" content="#1e1e1f">/);
assert.equal(manifest.name,"wTox");
assert.equal(manifest.short_name,"wTox");
assert.ok(!Object.hasOwn(manifest,"description"),
  "Remove the old Tox web-chat-client description from PWA metadata");
assert.equal(manifest.background_color,"#1e1e1f");
assert.equal(manifest.theme_color,"#1e1e1f");

for(const [name,value] of [
  ["HTML",html],["base stylesheet",css],["last stylesheet",refine]
]){
  assert.ok(!value.includes("#101927"),name+" must not contain the old navy startup color");
}
assert.ok(!css.includes("#0b1220")&&!css.includes("#0c1422")&&
  !css.includes("#1d3252"),"Remove old blue body/root radial background");
assert.match(html,/\.wtox-boot\{[^}]*background:transparent\}/);
assert.match(html,/html\[data-wtox-theme="dark"\] #root\{background:#1e1e1f\}/);
assert.match(html,/html\[data-wtox-theme="light"\] #root\{background:#f5f5f5\}/);
assert.match(css,/\.wtox-loading\{[^}]*background:var\(--wt-startup-bg\)/);

const block=html.match(/<script>\s*([\s\S]*?)\s*<\/script>/);
assert.ok(block,"Inline theme setup must run before the app bundle is fetched");
const themeOf=(stored,systemDark)=>{
  let theme="";
  const storage={getItem:()=>stored};
  const document={documentElement:{setAttribute:(name,value)=>{
    assert.equal(name,"data-wtox-theme");theme=value;
  }}};
  runInNewContext(block[1],{localStorage:storage,document,
    matchMedia:()=>({matches:systemDark})});
  return theme;
};
assert.equal(themeOf("light",true),"light",
  "Stored light must prevent a first-paint dark flash");
assert.equal(themeOf("dark",false),"dark",
  "Stored dark must prevent a first-paint light flash");
assert.equal(themeOf("system",true),"dark");
assert.equal(themeOf("system",false),"light");
assert.equal(themeOf(null,false),"light");

console.log("PWA metadata, launch background, and pre-React theme selection OK");
