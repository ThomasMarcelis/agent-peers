// Verify a release tag against the package and plugin versions; optionally write its changelog notes.
// Usage: node scripts/release-check.mjs v1.2.3 [notes-file]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const [tag, notesFile] = process.argv.slice(2);
const fail = (message) => {
  console.error(`release-check: ${message}`);
  process.exit(1);
};

if (!tag) fail("usage: node scripts/release-check.mjs v<version> [notes-file]");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
if (tag !== `v${version}`) fail(`tag ${tag} does not match package.json version ${version} (expected v${version})`);
for (const file of ["plugin.yaml", "hermes-plugin/plugin.yaml"]) {
  const manifest = readFileSync(join(root, file), "utf8").match(/^version:\s*["']?([^"'\s]+)["']?\s*$/m)?.[1];
  if (manifest !== version) fail(`${file} version ${manifest ?? "(missing)"} does not match package.json version ${version}`);
}

const lines = readFileSync(join(root, "CHANGELOG.md"), "utf8").split("\n");
const start = lines.findIndex((line) => line.startsWith(`## ${version} `) || line === `## ${version}`);
if (start === -1) fail(`CHANGELOG.md has no "## ${version}" section`);
const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
const notes = lines.slice(start + 1, end === -1 ? undefined : end).join("\n").trim();
if (!notes) fail(`CHANGELOG.md section for ${version} is empty`);
if (notesFile) writeFileSync(notesFile, `${notes}\n`);
console.log(`Tag ${tag} matches package.json, plugin.yaml and hermes-plugin/plugin.yaml; CHANGELOG.md has notes for ${version}.`);
