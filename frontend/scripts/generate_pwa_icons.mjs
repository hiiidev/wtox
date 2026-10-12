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
// Outlined wTox wordmark; avoid dependence on installed build-system fonts
// (the slim Docker frontend stage may not have any font packages).
const WORDMARK_PATH="M72 1120H420L608 348L797 1120H1096L1284 356L1473 1120H1821L1526 0H1135L946 770L758 0H367ZM1902 1493H3278V1202H2783V0H2398V1202H1902ZM3994 891Q3875 891 3812.5 805.5Q3750 720 3750 559Q3750 398 3812.5 312.5Q3875 227 3994 227Q4111 227 4173.0 312.5Q4235 398 4235 559Q4235 720 4173.0 805.5Q4111 891 3994 891ZM3994 1147Q4283 1147 4445.5 991.0Q4608 835 4608 559Q4608 283 4445.5 127.0Q4283 -29 3994 -29Q3704 -29 3540.5 127.0Q3377 283 3377 559Q3377 835 3540.5 991.0Q3704 1147 3994 1147ZM5151 573 4747 1120H5126L5355 788L5587 1120H5966L5562 575L5986 0H5607L5355 354L5106 0H4727Z";
const WORDMARK_EM=2048;
const WORDMARK_ADVANCE=6017;
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
    <g transform="translate(${cx-(WORDMARK_ADVANCE*fontSize/WORDMARK_EM)/2}
      ${cy+mark/2+gap+fontSize}) scale(${fontSize/WORDMARK_EM} -${fontSize/WORDMARK_EM})">
      <path d="${WORDMARK_PATH}" fill="#fff"/>
    </g>
  </svg>`;
  const png=new Resvg(artworkSvg,{fitTo:{mode:"width",value:width}}).render().asPng();
  writeFileSync(resolve(folder,`splash-${width}x${height}.png`),png);
  console.log(`Generated iOS splash ${width}x${height}`);
}
