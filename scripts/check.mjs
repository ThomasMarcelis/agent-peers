import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
for (const directory of ["src", "bin", "scripts", "test"]) {
  for (const file of readdirSync(join(root, directory)).filter((file) => file.endsWith(".mjs"))) {
    const result = spawnSync(process.execPath, ["--check", join(root, directory, file)], { stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
assert.equal(lock.version, pkg.version, "lockfile version");
assert.deepEqual(lock.packages[""].dependencies, pkg.dependencies, "lockfile dependencies");
for (const file of ["plugin.yaml", "hermes-plugin/plugin.yaml"]) {
  const manifest = readFileSync(join(root, file), "utf8");
  assert.match(manifest, new RegExp(`^version: ["']?${pkg.version.replaceAll(".", "\\.")}["']?$`, "m"), `${file} version`);
}
console.log("Syntax, versions, and lockfile are consistent.");
