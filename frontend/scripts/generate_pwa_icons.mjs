/* Build PNG PWA icons from the separate green-square artwork.
 * The website favicon/UI use public/logo.svg (transparent green symbol);
 * the installed PWA uses the supplied PNG's green-background appearance.
 */
import {readFileSync, mkdirSync, writeFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname, resolve} from "node:path";
import {Resvg} from "@resvg/resvg-js";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artwork = readFileSync(resolve(project, "scripts/pwa-icon-source.svg"), "utf8");
const folder = resolve(project, "public/icons");
mkdirSync(folder, {recursive: true});
for (const size of [180, 192, 512, 1024]) {
  const renderer = new Resvg(artwork, {
    fitTo: {mode: "width", value: size},
    background: "transparent"
  });
  const png = renderer.render().asPng();
  writeFileSync(resolve(folder, `icon-${size}.png`), png);
  console.log(`Generated PWA icon ${size}x${size}`);
}


/* iOS native startup images.
 * iOS looks up these screen-size-specific files at Home Screen launch. They
 * are generated during npm run build alongside the manifest PNG icons.
 * White artwork is derived from the exact transparent UI logo path.
 */
const uiLogo=readFileSync(resolve(project,"public/logo.svg"),"utf8");
const logoPath=uiLogo.match(/<path[^>]+d="([^"]+)"/)?.[1];
if(!logoPath)throw Error("PWA splash generation needs the vector UI logo path");
const deviceScreens=[
  // iPhone / iPod sizes (CSS width, CSS height, device pixel ratio)
  [320,568,2],[375,667,2],[414,736,3],
  [375,812,3],[414,896,2],[414,896,3],
  [390,844,3],[393,852,3],[402,874,3],
  [428,926,3],[430,932,3],[440,956,3],
  // iPad portrait
  [768,1024,2],[810,1080,2],[820,1180,2],
  [834,1112,2],[834,1194,2],[1024,1366,2]
];
for(const [cssWidth,cssHeight,dpr] of deviceScreens){
  const width=cssWidth*dpr,height=cssHeight*dpr;
  const mark=Math.round(Math.min(cssWidth*.38,190)*dpr);
  const cx=width/2,cy=height*.48;
  const originX=cx-mark/2,originY=cy-mark/2;
  const gap=Math.round(18*dpr);
  const fontSize=Math.round(Math.min(cssWidth*.072,34)*dpr);
  const artworkSvg=`<svg xmlns="http://www.w3.org/2000/svg"
    width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="#07C160"/>
    <g transform="translate(${originX} ${originY}) scale(${mark/350})">
      <path d="${logoPath}" fill="#fff"/>
    </g>
    <text x="${cx}" y="${cy+mark/2+gap+fontSize}" text-anchor="middle"
      fill="#fff" font-family="DejaVu Sans, Arial, sans-serif"
      font-size="${fontSize}" font-weight="750">wTox</text>
  </svg>`;
  const png=new Resvg(artworkSvg,{fitTo:{mode:"width",value:width}}).render().asPng();
  writeFileSync(resolve(folder,`splash-${width}x${height}.png`),png);
  console.log(`Generated iOS splash ${width}x${height}`);
}
