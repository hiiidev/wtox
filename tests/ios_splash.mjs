import assert from "node:assert/strict";
import {existsSync,readFileSync} from "node:fs";
import {join} from "node:path";

const html=readFileSync("frontend/dist/index.html","utf8");
const generator=readFileSync("frontend/scripts/generate_pwa_icons.mjs","utf8");
const js=readFileSync("frontend/src/App.jsx","utf8");
const sizes=[
  [320,568,2],[375,667,2],[414,736,3],
  [375,812,3],[414,896,2],[414,896,3],
  [390,844,3],[393,852,3],[402,874,3],
  [428,926,3],[430,932,3],[440,956,3],
  [768,1024,2],[810,1080,2],[820,1180,2],
  [834,1112,2],[834,1194,2],[1024,1366,2],
];
assert.equal((html.match(/rel="apple-touch-startup-image"/g)||[]).length,sizes.length);
for(const [w,h,dpr] of sizes){
  const pixels=`${w*dpr}x${h*dpr}`;
  const path=join("frontend","dist","icons",`splash-${pixels}.png`);
  assert.ok(existsSync(path),`Missing iOS startup ${pixels}`);
  const file=readFileSync(path);
  assert.equal(file.subarray(0,8).toString("hex"),"89504e470d0a1a0a",
    `${pixels} PNG signature`);
  assert.equal(file.readUInt32BE(16),w*dpr,`${pixels} width`);
  assert.equal(file.readUInt32BE(20),h*dpr,`${pixels} height`);
  assert.ok(html.includes(`/icons/splash-${pixels}.png`),
    `Missing HTML splash link ${pixels}`);
}
assert.ok(generator.includes('fill="#07C160"'),"Use requested PWA splash green");
assert.ok(generator.includes('fill="#fff"'),"Use white logo and wordmark");
assert.ok(generator.includes("WORDMARK_PATH")&&generator.includes("WORDMARK_ADVANCE"),"Render wTox as scalable vector outlines even without installed fonts");
assert.ok(generator.includes('public/logo.svg'),"Use the supplied SVG for startup logo");
assert.ok(js.includes('<span className="wtox-boot-ring"'),
  "React should reuse the same spinner from first HTML paint");
assert.ok(!js.includes('<Spin size="large"/>'),"Do not flash two different loaders");
console.log("iPhone and iPad startup PNG sizes, colors and React spinner verified");
