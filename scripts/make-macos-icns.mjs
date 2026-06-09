import { existsSync, mkdirSync, rmSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

if (process.platform !== "darwin") {
  console.log("SKIP macOS .icns generation: iconutil is only available on macOS.");
  process.exit(0);
}

const iconDir = resolve(import.meta.dirname, "..", "src-tauri", "icons");
const iconsetDir = resolve(iconDir, "icon.iconset");
const outputPath = resolve(iconDir, "icon.icns");

const required = [
  ["32x32.png", "icon_16x16@2x.png"],
  ["128x128.png", "icon_128x128.png"],
  ["128x128@2x.png", "icon_128x128@2x.png"],
  ["512x512.png", "icon_512x512.png"],
  ["icon.png", "icon_512x512@2x.png"],
];

for (const [source] of required) {
  const sourcePath = resolve(iconDir, source);
  if (!existsSync(sourcePath)) {
    throw new Error(`Missing ${sourcePath}. Run npm run icons first.`);
  }
}

rmSync(iconsetDir, { recursive: true, force: true });
mkdirSync(iconsetDir, { recursive: true });

for (const [source, target] of required) {
  await copyFile(resolve(iconDir, source), resolve(iconsetDir, target));
}

execFileSync("iconutil", ["-c", "icns", iconsetDir, "-o", outputPath], { stdio: "inherit" });
rmSync(iconsetDir, { recursive: true, force: true });
console.log(`WROTE ${outputPath}`);
