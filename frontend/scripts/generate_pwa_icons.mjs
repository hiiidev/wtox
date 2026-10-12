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
