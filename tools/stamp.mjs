// Cache-busting for the deployed site: appends ?v=<version> to the stylesheet, the entry script and every js module,
// so a new deploy never mixes freshly downloaded files with older cached ones. Run by the deploy workflow only.
//   node tools/stamp.mjs <version> [rootDir]
import fs from "node:fs";
import path from "node:path";

const version = (process.argv[2] || "dev").slice(0, 12);
const root = path.resolve(process.argv[3] || ".");
const htmlPath = path.join(root, "index.html");
let html = fs.readFileSync(htmlPath, "utf8");

const modules = fs.readdirSync(path.join(root, "js")).filter((f) => f.endsWith(".js")).map((f) => `./js/${f}`);
modules.push("./vendor/OrbitControls.js");
const map = { three: "./vendor/three.module.min.js" };
for (const m of modules) map[m] = `${m}?v=${version}`;

const mapRe = /<script type="importmap">[\s\S]*?<\/script>/;
if (!mapRe.test(html)) throw new Error("importmap not found in index.html");
html = html.replace(mapRe, `<script type="importmap">\n    ${JSON.stringify({ imports: map }, null, 2).replace(/\n/g, "\n    ")}\n  </script>`);
for (const [from, to] of [
  ['href="css/style.css"', `href="css/style.css?v=${version}"`],
  ['src="js/app.js"', `src="js/app.js?v=${version}"`],
]) {
  if (!html.includes(from)) throw new Error(`${from} not found in index.html`);
  html = html.replace(from, to);
}
fs.writeFileSync(htmlPath, html);
console.log(`stamped ${modules.length} modules with v=${version}`);
