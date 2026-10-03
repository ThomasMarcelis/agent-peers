import { lstatSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { VERSION } from "./version.mjs";
import { claudeHome, peersHome } from "./wire.mjs";

const require = createRequire(import.meta.url);

// Inspect metadata only: no configuration writes, daemon startup or model turns.
export function diagnose() {
  const checks = [];
  const add = (name, status, message) => checks.push({ name, status, message });
  add("node", Number(process.versions.node.split(".")[0]) >= 22 ? "ok" : "error", process.version);
  add("platform", ["linux", "darwin"].includes(process.platform) ? "ok" : "error", process.platform);
  for (const name of ["@modelcontextprotocol/sdk/client/index.js", "ws", "zod"]) {
    try { require.resolve(name); add(name, "ok", "installed"); }
    catch { add(name, "error", "missing; reinstall agent-peers with npm"); }
  }
  const paths = [
    ["claude registry", join(claudeHome(), "sessions"), "directory", false],
    ["peer registry", peersHome(), "directory", true],
    ["codex daemon", process.env.AGENT_PEERS_CODEX_APP_SERVER ||
      join(process.env.CODEX_HOME || join(homedir(), ".codex"), "app-server-control", "app-server-control.sock"), "socket", false],
  ];
  for (const [name, path, kind, privateMode] of paths) {
    if (!isAbsolute(path)) { add(name, "error", `expected an absolute path: ${path}`); continue; }
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (kind === "socket" ? !stat.isSocket() : !stat.isDirectory())) {
        add(name, "error", `${path} must be a ${kind}, not a symlink or another file type`);
      } else if ((process.getuid && stat.uid !== process.getuid()) || (stat.mode & (privateMode ? 0o077 : 0o022))) {
        add(name, "error", `${path} must belong to this user and have safe permissions`);
      } else add(name, "ok", path);
    } catch (error) {
      if (error.code === "ENOENT") add(name, "warning", `${path} is absent; start the corresponding agent to use it`);
      else add(name, "error", `${path}: ${error.message}`);
    }
  }
  add("compatibility", "warning", "Socket presence is not a delivery check. Codex must use its shared daemon; Hermes replies require the documented route APIs. See the compatibility guide.");
  return { version: VERSION, ok: !checks.some((c) => c.status === "error"), checks };
}
