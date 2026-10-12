/* Build portable PNG icons from the exact, user-provided wTox SVG. */
import {readFileSync, mkdirSync, writeFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname, resolve} from "node:path";
import {Resvg} from "@resvg/resvg-js";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const svg = readFileSync(resolve(project, "public/logo.svg"), "utf8");
const folder = resolve(project, "public/icons");
mkdirSync(folder, {recursive: true});
for (const size of [180, 192, 512, 1024]) {
  const renderer = new Resvg(svg, {
    fitTo: {mode: "width", value: size},
    background: "transparent"
  });
  const png = renderer.render().asPng();
  writeFileSync(resolve(folder, `icon-${size}.png`), png);
  console.log(`Generated PWA icon ${size}x${size}`);
}
