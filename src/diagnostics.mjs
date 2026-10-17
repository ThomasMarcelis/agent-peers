import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { VERSION } from "./version.mjs";
import { claudeHome, opencodePeers, peersHome } from "./wire.mjs";
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

// ---- opencode checks (read-only) ----

// The opencode binary may be outside PATH: its installer puts it in ~/.opencode/bin.
function opencodeExecutable(env = process.env) {
  const name = process.platform === "win32" ? "opencode.exe" : "opencode";
  for (const directory of (env.PATH ?? "").split(":")) {
    if (!directory) continue;
    const path = join(directory, name);
    try { if (statSync(path).isFile()) return path; } catch {}
  }
  const fallback = join(env.HOME || homedir(), ".opencode", "bin", name);
  try { if (statSync(fallback).isFile()) return fallback; } catch {}
  return undefined;
}

function opencodeBinary() {
  const path = opencodeExecutable();
  if (!path) return { status: "warning", message: "opencode not found; install opencode 2.x to load the agent-peers plugin" };
  const result = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 2000 });
  const version = /v?(\d+\.\d+\.\d+)/.exec(String(result.stdout || result.stderr || ""));
  if (!version) return { status: "warning", message: `${path} did not report a version` };
  const major = Number(version[1].split(".")[0]);
  if (major < 2) return { status: "warning", message: `${path} is opencode ${version[1]}; agent-peers supports opencode 2.x only` };
  return { status: "ok", message: `${path} (${version[1]})` };
}

function opencodeConfigPath(env = process.env) {
  return join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config"), "opencode", "opencode.json");
}

function localPackageVersion(entry) {
  let directory;
  try { directory = statSync(entry).isDirectory() ? entry : dirname(entry); }
  catch { try { directory = dirname(entry); } catch { return undefined; } }
  for (let depth = 0; depth < 8; depth++) {
    try {
      const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
      if (pkg?.name === "agent-peers" && typeof pkg.version === "string") return pkg.version;
    } catch {}
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

// The installed plugin package. A local path is walked up to its package.json; a package entry
// checks the config-local node_modules, then opencode's npm cache. It never walks parent
// node_modules and reports an unrelated global copy.
function cachedOpencodePackageVersion(env = process.env) {
  const home = env.HOME || homedir();
  const cache = env.XDG_CACHE_HOME || join(home, ".cache");
  const root = join(cache, "opencode", "npm");
  let best;
  try {
    for (const key of readdirSync(root)) {
      for (const generation of readdirSync(join(root, key))) {
        const manifest = join(root, key, generation, "node_modules", "agent-peers", "package.json");
        try {
          const stat = statSync(manifest);
          if (!best || stat.mtimeMs > best.mtime) {
            const pkg = JSON.parse(readFileSync(manifest, "utf8"));
            if (pkg?.name === "agent-peers" && typeof pkg.version === "string") best = { version: pkg.version, mtime: stat.mtimeMs };
          }
        } catch {}
      }
    }
  } catch {}
  return best?.version;
}

const isLocalPluginEntry = (entry) =>
  typeof entry === "string" && (entry.endsWith(".mjs") || entry.endsWith(".js") || entry.startsWith(".") || entry.startsWith("/"));

function configuredPackageVersion(configPath) {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(configPath), "node_modules", "agent-peers", "package.json"), "utf8"));
    if (pkg?.name === "agent-peers" && typeof pkg.version === "string") return pkg.version;
  } catch {}
  return undefined;
}

function installedPluginVersion(entries, configPath) {
  for (const entry of entries) {
    if (entry === "agent-peers" || entry.startsWith("agent-peers@")) {
      return configuredPackageVersion(configPath) ?? cachedOpencodePackageVersion();
    }
    if (isLocalPluginEntry(entry)) {
      const local = localPackageVersion(isAbsolute(entry) ? entry : join(dirname(configPath), entry));
      if (local) return local;
    }
  }
  return undefined;
}

function opencodePlugin() {
  const path = opencodeConfigPath();
  let config;
  try { config = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return { status: "warning", message: `${path} is absent; install the plugin with "opencode plugin add agent-peers@next"` };
    return { status: "warning", message: `${path} could not be read as JSON; install the plugin with "opencode plugin add agent-peers@next"` };
  }
  const plugins = Array.isArray(config?.plugins) ? config.plugins : [];
  const entries = plugins.map((entry) => Array.isArray(entry) ? entry[0] : entry).filter((entry) => typeof entry === "string");
  const listed = entries.some((entry) => entry === "agent-peers" || entry.startsWith("agent-peers@") ||
    (isLocalPluginEntry(entry) && localPackageVersion(isAbsolute(entry) ? entry : join(dirname(path), entry))));
  if (!listed) return { status: "warning", message: `agent-peers is not in ${path}'s plugins; run "opencode plugin add agent-peers@next"` };
  const installed = installedPluginVersion(entries, path);
  if (!installed) return { status: "warning", message: `agent-peers is listed; its installed package version is unknown (CLI ${VERSION})` };
  if (installed !== VERSION) {
    return { status: "warning", message: `version skew: installed opencode plugin ${installed}, CLI ${VERSION}; pin one package version` };
  }
  return { status: "ok", message: `listed; installed package ${installed}` };
}

function opencodeRecords() {
  try {
    const live = opencodePeers();
    return { status: "ok", message: `${live.length} live opencode bridge record${live.length === 1 ? "" : "s"}` };
  } catch (error) {
    return { status: "warning", message: `opencode records could not be read: ${error.message}` };
  }
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
  const binary = opencodeBinary(), plugin = opencodePlugin(), records = opencodeRecords();
  add("opencode binary", binary.status, binary.message);
  add("opencode plugin", plugin.status, plugin.message);
  add("opencode records", records.status, records.message);
  add("compatibility", "warning", "An answering daemon is not a delivery check. Codex threads are reachable only on the app-server agent-peers is pointed at; Hermes replies require the documented route APIs. opencode reaches peers through its plugin and one bridge child per server; live interoperability is not verified by doctor. See the compatibility guide.");
  return { version: VERSION, ok: !checks.some((c) => c.status === "error"), logging, checks };
}
