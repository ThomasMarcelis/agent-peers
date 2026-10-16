import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { VERSION } from "./version.mjs";
import { claudeHome, peersHome } from "./wire.mjs";
import { loggingConfig } from "./logging.mjs";
import { daemonSocket } from "./app-server.mjs";

const require = createRequire(import.meta.url);

function daemonStat(path) {
  const link = lstatSync(path);
  if (!link.isSymbolicLink()) return link;
  if (process.getuid && link.uid !== process.getuid()) throw new Error("daemon socket link must belong to this user");
  // Codex publishes its short runtime socket through an owned symlink. Only this
  // daemon endpoint permits indirection; peer registry/socket rules stay strict.
  let target;
  try { target = realpathSync(path); }
  catch (error) {
    if (error.code === "ENOENT") throw Object.assign(new Error(readlinkSync(path)), { code: "STALE_LINK" });
    throw error;
  }
  for (const directory of [dirname(path), dirname(target)]) {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o022)) {
      throw new Error("daemon socket link and target require owned directories without shared write access");
    }
  }
  return lstatSync(target);
}

const START_DAEMON = "start it with `codex app-server daemon start`, or open a Codex session";

// One handshake and a loaded-thread read: a socket file can outlive its server, for example
// across a reboot. Nothing is logged, started or loaded.
async function daemonAnswers(path) {
  const { AppServer } = await import("./app-server.mjs");
  const app = new AppServer(undefined, { connectTimeoutMs: 2000, handshakeTimeoutMs: 2000, log: () => {} });
  try {
    const result = await app.request("thread/loaded/list", {}, 3000);
    const count = Array.isArray(result?.data) ? `${result.data.length}${result.nextCursor ? "+" : ""}` : "unknown";
    return { status: "ok", message: `${path} (answering; ${count} loaded threads)` };
  } catch (error) {
    const reason = error?.code === "ECONNREFUSED" ? "connection refused" : String(error?.code || error?.message || "no answer");
    const configured = process.env.AGENT_PEERS_CODEX_APP_SERVER ? "the configured app-server" : "Codex's shared daemon";
    return { status: "warning", message: `${path} is not answering (${reason}); ${configured} is not running` +
      (process.env.AGENT_PEERS_CODEX_APP_SERVER ? "" : `: ${START_DAEMON}`) };
  } finally { app.close(); }
}

// Inspect metadata and ask the app-server one read-only question: no configuration writes,
// daemon startup or model turns.
export async function diagnose() {
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
    ["codex daemon", daemonSocket(), "socket", false],
  ];
  for (const [name, path, kind, privateMode] of paths) {
    if (!isAbsolute(path)) { add(name, "error", `expected an absolute path: ${path}`); continue; }
    try {
      const stat = kind === "socket" ? daemonStat(path) : lstatSync(path);
      if (stat.isSymbolicLink() || (kind === "socket" ? !stat.isSocket() : !stat.isDirectory())) {
        add(name, "error", `${path} must be a ${kind}, not a symlink or another file type`);
      } else if ((process.getuid && stat.uid !== process.getuid()) || (stat.mode & (privateMode ? 0o077 : 0o022))) {
        add(name, "error", `${path} must belong to this user and have safe permissions`);
      } else if (kind === "socket") {
        const live = await daemonAnswers(path);
        add(name, live.status, live.message);
      } else add(name, "ok", path);
    } catch (error) {
      if (error.code === "STALE_LINK") add(name, "warning", `${path} links to a missing socket (${error.message}); Codex's shared daemon is not running: ${START_DAEMON}`);
      else if (error.code === "ENOENT") add(name, "warning", `${path} is absent; start the corresponding agent to use it`);
      else add(name, "error", `${path}: ${error.message}`);
    }
  }
  const logging = loggingConfig();
  add("logging", logging.enabled && !logging.valid ? "error" : "ok", logging.enabled
    ? `enabled; ${logging.mode}: ${logging.location}${logging.valid ? "" : "; expected an absolute normalized path"}`
    : `disabled; set AGENT_PEERS_DEBUG=1 to capture future events in ${logging.location}`);
  add("compatibility", "warning", "An answering daemon is not a delivery check. Codex threads are reachable only on the app-server agent-peers is pointed at; Hermes replies require the documented route APIs. See the compatibility guide.");
  return { version: VERSION, ok: !checks.some((c) => c.status === "error"), logging, checks };
}
