import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = {};
for (const [key, value] of Object.entries(process.env)) {
  const normalized = key.toLowerCase();
  if (normalized === "path") {
    if (!env.Path) env.Path = value;
    continue;
  }
  if (!(key in env)) env[key] = value;
}
const out = openSync(resolve(root, "dev-server.log"), "a");
const err = openSync(resolve(root, "dev-server.err.log"), "a");
const child = spawn(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["run", "dev"],
  {
    cwd: root,
    detached: true,
    stdio: ["ignore", out, err],
    env,
  },
);

child.unref();
console.log("DEV_SERVER_START_REQUESTED http://localhost:5174");
