import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const indexHtml = readFileSync(resolve(root, "dist", "index.html"), "utf8");
const jsMatch = indexHtml.match(/src="\.\/assets\/([^"]+\.js)"/);
const cssMatch = indexHtml.match(/href="\.\/assets\/([^"]+\.css)"/);

if (!jsMatch || !cssMatch) {
  throw new Error("Cannot find built JS/CSS assets in dist/index.html");
}

const js = readFileSync(resolve(root, "dist", "assets", jsMatch[1]), "utf8");
const css = readFileSync(resolve(root, "dist", "assets", cssMatch[1]), "utf8");

const standalone = indexHtml
  .replace(/<script type="module" crossorigin src="\.\/assets\/[^"]+"><\/script>/, () => `<script type="module">\n${js}\n</script>`)
  .replace(/<link rel="stylesheet" crossorigin href="\.\/assets\/[^"]+">/, () => `<style>\n${css}\n</style>`);

writeFileSync(resolve(root, "react-standalone.html"), standalone, "utf8");
console.log("WROTE react-standalone.html");
