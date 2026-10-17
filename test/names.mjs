// Claimed names (docs/design/names.md §10, items 1-9): grammar, races, compare-and-swap, the
// conflict table, release, file safety, send-time resolution and pins.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs, { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync,
  writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:net";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { claim, claimRows, claimsOf, claudeClaimant, parseName, release, resolveClaim, withClaims } from "../src/names.mjs";
import { Pins, resolveTarget } from "../src/outbox.mjs";
import { address, claudeSessionAt, claudeSessions, generation, processStart } from "../src/wire.mjs";

const cli = fileURLToPath(new URL("../bin/agent-peers.mjs", import.meta.url));
const NAME = "claude:proj/lead";
const fileOf = (dir, name) => join(dir, "peers", "names", `n-${createHash("sha256").update(name).digest("hex").slice(0, 32)}.json`);

function fixture(t) {
  const dir = mkdtempSync(join(realpathSync("/tmp"), "ap-names-"));
  const claude = join(dir, "claude"), peers = join(dir, "peers"), sockets = join(dir, "s"), other = join(dir, "o");
  for (const path of [join(claude, "sessions"), sockets, other]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const before = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, AGENT_PEERS_HOME: process.env.AGENT_PEERS_HOME };
  Object.assign(process.env, { CLAUDE_CONFIG_DIR: claude, AGENT_PEERS_HOME: peers });
  const children = [];
  t.after(() => {
    for (const child of children) child.kill("SIGKILL");
    for (const [key, value] of Object.entries(before)) value === undefined ? delete process.env[key] : process.env[key] = value;
    rmSync(dir, { recursive: true, force: true });
  });
  const record = (pid, name, socket = join(sockets, `${pid}.sock`), extra = {}) =>
    writeFileSync(join(claude, "sessions", `${pid}.json`), JSON.stringify({ pid, name, messagingSocketPath: socket, ...extra }));
  // This process is a Claude session that records its start, so a PID reuse is detectable.
  record(process.pid, "me", join(sockets, "me.sock"), { procStart: processStart(process.pid) });
  // Another live Claude session: a process of its own with a registry record, which records its
  // start as current Claude Code does.
  const session = async (name, socket) => {
    const child = spawn("sleep", ["60"], { stdio: "ignore" });
    children.push(child);
    await once(child, "spawn");
    record(child.pid, name, socket, { procStart: processStart(child.pid) });
    return { child, claimant: () => claudeClaimant(claudeSessionAt(child.pid)),
      stop: async () => { const exited = once(child, "exit"); child.kill(); await exited; } };
  };
  return { dir, claude, peers, sockets, other, record, session, me: () => claudeClaimant(claudeSessionAt(process.pid)) };
}

test("grammar: exact lowercase <kind>:<scope>/<claim>, limits, and kind elision", () => {
  for (const name of ["claude:proj/lead", "codex:a/b", "hermes:gaming/marketsimulator", "claude:a-b_c/x.y-z_1",
    `codex:${"s".repeat(64)}/${"c".repeat(64)}`, "claude:0/9"]) assert.equal(parseName(name).name, name);
  for (const name of ["", "Claude:proj/lead", "claude:Proj/lead", "claude:proj/Lead", "claude:proj/lead/x", "claude:proj", "proj",
    "claude:/lead", "claude:proj/", "claude:pr:oj/lead", "claude:proj/le:ad", "claude:proj/léad", "claude:-proj/lead",
    "claude:proj/.lead", "claude:proj.x/lead", `claude:${"s".repeat(65)}/c`, `claude:s/${"c".repeat(65)}`, "gemini:proj/lead",
    "claude:proj /lead", "claude:proj/lead ", "uds:/tmp/x.sock"]) {
    assert.throws(() => parseName(name), (error) => error.reason === "invalid-request" && /<kind>:<scope>\/<claim>/.test(error.message), name);
  }
  assert.deepEqual(parseName("proj/lead"), { kind: undefined, scope: "proj", claim: "lead", elided: true, name: undefined });
  assert.equal(parseName("proj/lead", "codex").name, "codex:proj/lead");
  assert.equal(parseName("hermes:proj/lead", "codex").name, "hermes:proj/lead", "a given kind is kept, never replaced");
});

test("kind elision resolves only when exactly one kind has a record, and never prefers the live one", async (t) => {
  const f = fixture(t);
  claim(NAME, f.me());
  assert.equal(resolveClaim("proj/lead").name, NAME);
  // A dead Codex record for the same scope and claim makes the short form ambiguous.
  const codex = { kind: "codex", owner: generation("codex", "gone"), generation: generation("codex", "gone", "1"), address: null,
    holder: { pid: 0x7ffffffe, autoName: "codex:gone-1234", threadId: "gone", addresses: [] } };
  assert.equal(claim("codex:proj/lead", codex).status, "claimed");
  assert.throws(() => resolveClaim("proj/lead"), (error) => error.reason === "ambiguous" &&
    error.message.includes("claude:proj/lead, codex:proj/lead"));
  assert.equal(resolveClaim(NAME).name, NAME, "the full name still resolves");
});

// The race harness: shells that are Claude sessions (each owns a registry record), each running the
// real CLI at the same moment.
async function shells(f, count, args) {
  const runs = [];
  for (let i = 0; i < count; i++) {
    const shell = execFile("sh", ["-c", `read go; "${process.execPath}" "${cli}" ${args} --json; echo ---; read done`],
      { encoding: "utf8", env: { ...process.env } });
    let out = "", err = "";
    shell.stdout.on("data", (data) => { out += data; });
    shell.stderr.on("data", (data) => { err += data; });
    f.record(shell.pid, `racer-${i}`, undefined, { procStart: processStart(shell.pid) });
    runs.push({ shell, output: () => out, errors: () => err });
  }
  const finish = async () => { for (const run of runs) { const closed = once(run.shell, "close"); run.shell.stdin.end(); await closed; } };
  try {
    for (const run of runs) run.shell.stdin.write("go\n");
    for (let i = 0; i < 1000 && !runs.every((run) => run.output().includes("---")); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    const results = runs.map((run) => {
      try { return { pid: run.shell.pid, ...JSON.parse(run.output().split("---")[0]) }; }
      catch { assert.fail(`no result from a racer: ${run.output()} ${run.errors()}`); }
    });
    return { results, finish };
  } catch (error) { await finish(); throw error; }
}

test("create race: of 8 sessions claiming one name, exactly one holds it and the others are refused", { timeout: 30_000 }, async (t) => {
  const f = fixture(t);
  const { results, finish } = await shells(f, 8, `claim ${NAME}`);
  try {
    const winners = results.filter((r) => r.status === "claimed");
    assert.equal(winners.length, 1, JSON.stringify(results.map((r) => [r.status, r.reason])));
    assert.ok(results.filter((r) => r.status !== "claimed").every((r) => r.status === "refused" && ["name-held", "conflict"].includes(r.reason)));
    const stored = JSON.parse(readFileSync(fileOf(f.dir, NAME), "utf8"));
    assert.deepEqual([stored.holder.pid, stored.generation], [winners[0].pid, winners[0].generation]);
  } finally { await finish(); }
});

test("takeover race: of 8 sessions taking over a dead claim, at most one succeeds and there is one holder", { timeout: 30_000 }, async (t) => {
  const f = fixture(t), old = await f.session("old");
  assert.equal(claim(NAME, old.claimant()).status, "claimed");
  await old.stop();
  const { results, finish } = await shells(f, 8, `claim ${NAME}`);
  try {
    const winners = results.filter((r) => ["claimed", "taken-over"].includes(r.status));
    assert.ok(winners.length <= 1, JSON.stringify(results.map((r) => [r.status, r.reason])));
    assert.ok(results.filter((r) => !winners.includes(r)).every((r) => r.status === "refused" && ["name-held", "conflict"].includes(r.reason)));
    const stored = JSON.parse(readFileSync(fileOf(f.dir, NAME), "utf8"));
    if (winners.length) assert.deepEqual([stored.holder.pid, stored.generation], [winners[0].pid, winners[0].generation]);
    assert.deepEqual(readdirSync(join(f.peers, "names")), [`n-${createHash("sha256").update(NAME).digest("hex").slice(0, 32)}.json`],
      "no temporary or reaped files remain");
  } finally { await finish(); }
});

// Replace the record between its read and the rename that would take it, as a concurrent claim would.
function interleave(t, file, replacement) {
  const rename = fs.renameSync;
  let injected = false;
  fs.renameSync = (source, destination) => {
    if (!injected && source === file && String(destination).includes(".reap-")) {
      injected = true;
      const temporary = `${file}.other`;
      writeFileSync(temporary, JSON.stringify(replacement), { mode: 0o600 });
      rename(temporary, file);
    }
    return rename(source, destination);
  };
  syncBuiltinESMExports();
  t.after(() => { fs.renameSync = rename; syncBuiltinESMExports(); });
  return () => injected;
}

test("compare-and-swap: a record replaced between read and rename is restored, and the claim reports conflict", async (t) => {
  const f = fixture(t), old = await f.session("old"), next = await f.session("next");
  claim(NAME, old.claimant());
  await old.stop();
  const file = fileOf(f.dir, NAME);
  const replacement = { ...JSON.parse(readFileSync(file, "utf8")), owner: next.claimant().owner, generation: next.claimant().generation,
    holder: next.claimant().holder };
  const injected = interleave(t, file, replacement);
  const result = claim(NAME, f.me());
  assert.equal(injected(), true);
  assert.deepEqual([result.status, result.reason], ["refused", "conflict"]);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), JSON.parse(JSON.stringify(replacement)), "the newer record is back in place");
  assert.equal(resolveClaim(NAME).generation, next.claimant().generation);
});

// The documented worst case (reference, "Races"): B takes a dead name over between A's read and
// A's rename, and C claims while A holds B's record aside, so A cannot put it back.
test("a three-way race can lose a claim, but never leaves two holders", async (t) => {
  const f = fixture(t), old = await f.session("old"), b = await f.session("b"), c = await f.session("c");
  claim(NAME, old.claimant());
  await old.stop();
  const file = fileOf(f.dir, NAME);
  interleave(t, file, { ...JSON.parse(readFileSync(file, "utf8")), owner: b.claimant().owner, generation: b.claimant().generation,
    holder: b.claimant().holder });
  const link = fs.linkSync;
  let during;
  fs.linkSync = (source, destination) => {
    if (!during && String(source).includes(".reap-")) during = claim(NAME, c.claimant());
    return link(source, destination);
  };
  syncBuiltinESMExports();
  t.after(() => { fs.linkSync = link; syncBuiltinESMExports(); });
  const a = claim(NAME, f.me());
  assert.deepEqual([a.status, a.reason, during?.status], ["refused", "conflict", "claimed"]);
  // B's takeover is lost; C is the one holder, on disk and for every reader.
  assert.deepEqual(readdirSync(join(f.peers, "names")), [basename(file)], "one record and nothing left aside");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).generation, c.claimant().generation);
  assert.deepEqual(claimRows().map((row) => [row.name, row.generation, row.running]), [[NAME, c.claimant().generation, true]]);
  assert.equal(resolveClaim(NAME).holder, "claude:c");
});

test("a claim or release sweeps what a dead claim left aside a minute ago, and nothing else", (t) => {
  const f = fixture(t), names = join(f.peers, "names");
  claim(NAME, f.me());
  const leftover = (prefix) => { const path = join(names, `${prefix}-${randomUUID()}.json`); writeFileSync(path, "{}", { mode: 0o600 }); return basename(path); };
  const reaped = leftover(".reap"), temporary = leftover(".t"), linked = `.reap-${randomUUID()}.json`, folder = `.t-${randomUUID()}.json`;
  symlinkSync(join(f.dir, "elsewhere.json"), join(names, linked));
  mkdirSync(join(names, folder));
  writeFileSync(join(names, ".reap-not-a-uuid.json"), "{}", { mode: 0o600 });
  const kept = [basename(fileOf(f.dir, NAME)), linked, folder, ".reap-not-a-uuid.json"].sort();
  // A fresh one may belong to a claim or release still running.
  claim(NAME, f.me());
  assert.deepEqual(readdirSync(names).sort(), [...kept, reaped, temporary].sort());
  const now = Date.now;
  Date.now = () => now() + 61_000;
  t.after(() => { Date.now = now; });
  claim(NAME, f.me());
  assert.deepEqual(readdirSync(names).sort(), kept, "only this user's regular leftovers, by their exact names");
  const another = leftover(".reap");
  assert.equal(release("proj/missing", f.me()).reason, "not-found");
  assert.equal(readdirSync(names).includes(another), false, "a release sweeps too");
});

test("a record left aside by a claim that died is put back while its name is free, and removed once it is not", async (t) => {
  const f = fixture(t), names = join(f.peers, "names"), lead = await f.session("lead");
  claim(NAME, lead.claimant());
  claim("claude:proj/second", lead.claimant());
  const aside = (name) => {
    const path = join(names, `.reap-${randomUUID()}.json`);
    fs.renameSync(fileOf(f.dir, name), path);
    return basename(path);
  };
  // A swap that died between moving the record aside and putting it back; the second name was
  // claimed again meanwhile; a newer agent-peers' record is never removed.
  const orphan = aside(NAME), stale = aside("claude:proj/second"), future = `.reap-${randomUUID()}.json`;
  writeFileSync(join(names, future), JSON.stringify({ v: 2, name: "claude:proj/future" }), { mode: 0o600 });
  const other = await f.session("other");
  assert.equal(claim("claude:proj/second", other.claimant()).status, "claimed");
  assert.throws(() => resolveClaim(NAME), (error) => error.reason === "not-found", "fresh: it may be a swap still running");
  const now = Date.now;
  Date.now = () => now() + 61_000;
  t.after(() => { Date.now = now; });
  assert.equal(release("proj/missing", f.me()).reason, "not-found");
  assert.equal(resolveClaim(NAME).holder, "claude:lead", "the orphaned record is back");
  assert.equal(resolveClaim("claude:proj/second").holder, "claude:other", "a name claimed again is kept");
  assert.deepEqual(readdirSync(names).filter((name) => name.startsWith(".")), [future]);
  assert.ok(![orphan, stale].some((name) => readdirSync(names).includes(name)));
});

// The sweep above tells a swap in progress by its ctime, which rename(2) must update. Linux
// filesystems and APFS do (stat(2) on macOS lists rename); CI checks each runner's filesystem.
test("renaming a file aside updates its ctime on this filesystem", async (t) => {
  const dir = mkdtempSync(join(realpathSync("/tmp"), "ap-ctime-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "record.json");
  writeFileSync(file, "{}");
  const before = lstatSync(file).ctimeMs;
  // Wait until this filesystem's clock, at its own resolution, has passed that ctime.
  for (let i = 0; i < 300; i++) {
    writeFileSync(join(dir, "probe"), String(i));
    if (lstatSync(join(dir, "probe")).ctimeMs > before) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(lstatSync(join(dir, "probe")).ctimeMs > before, "the filesystem clock advanced");
  fs.renameSync(file, join(dir, `.reap-${randomUUID()}.json`));
  const moved = readdirSync(dir).find((name) => name.startsWith(".reap-"));
  assert.ok(lstatSync(join(dir, moved)).ctimeMs > before, "rename updated the ctime");
});

test("a running holder's refresh never leaves its name free for another claimant", async (t) => {
  const f = fixture(t), other = await f.session("other");
  assert.equal(claim(NAME, f.me()).status, "claimed");
  // Another session claims right after each rename the refresh makes.
  const rename = fs.renameSync, during = [];
  fs.renameSync = (source, destination) => {
    rename(source, destination);
    if (!during.length) { during.push(null); during[0] = claim(NAME, other.claimant()); }
  };
  syncBuiltinESMExports();
  t.after(() => { fs.renameSync = rename; syncBuiltinESMExports(); });
  const refreshed = claim(NAME, { ...f.me(), holder: { ...f.me().holder, autoName: "claude:me-renamed" } });
  assert.deepEqual([refreshed.status, during[0]?.status, during[0]?.reason], ["refreshed", "refused", "name-held"]);
  const stored = JSON.parse(readFileSync(fileOf(f.dir, NAME), "utf8"));
  assert.deepEqual([stored.generation, stored.holder.autoName], [f.me().generation, "claude:me-renamed"]);
});

test("a Hermes holder is running wherever its inboxes are, even in a directory this process may not send to", async (t) => {
  const f = fixture(t), socket = join(f.other, `hermes-${"a".repeat(32)}.sock`), server = createServer();
  await new Promise((resolve) => server.listen(socket, resolve));
  t.after(() => server.close());
  const hermes = (route, owner) => ({ kind: "hermes", scope: "proj", owner: generation("hermes", "proj", owner),
    generation: generation("hermes", route), address: address(socket),
    holder: { pid: process.pid, procStart: processStart(process.pid), autoName: `hermes:${owner}`, addresses: [address(socket)] } });
  const name = "hermes:proj/relay";
  assert.equal(claim(name, hermes("route-1", "conversation-1")).status, "claimed");
  const [row] = claimRows();
  assert.deepEqual([row.running, row.address], [true, null], "running, with no address this process may use");
  assert.deepEqual([claim(name, hermes("route-2", "conversation-2")).reason, release(name, undefined, "hermes").reason], ["name-held", "not-holder"]);
  assert.throws(() => resolveClaim(name), (error) => error.reason === "inbox-unavailable");
  await new Promise((resolve) => server.close(resolve));
  assert.equal(claimRows()[0].running, false, "its inbox is gone");
});

// Liveness comes only from the record (PID and start time); a registry view only picks the address.
test("a running holder out of this process's sight is never taken over, released or replaced by another session", async (t) => {
  const f = fixture(t), lead = await f.session("lead");
  assert.equal(claim(NAME, lead.claimant()).status, "claimed");
  const sessionFile = join(f.claude, "sessions", `${lead.child.pid}.json`), saved = readFileSync(sessionFile, "utf8");
  // Another CLAUDE_CONFIG_DIR, as a shell or session with a different configuration sees.
  const elsewhere = join(f.dir, "claude-b");
  mkdirSync(join(elsewhere, "sessions"), { recursive: true, mode: 0o700 });
  const rival = { ...f.me(), owner: generation("claude", "rival"), generation: generation("claude", "rival", "s") };
  const views = { "another CLAUDE_CONFIG_DIR": () => { process.env.CLAUDE_CONFIG_DIR = elsewhere; },
    "a registry file Claude is rewriting": () => { writeFileSync(sessionFile, saved.slice(0, 20)); } };
  for (const [view, enter] of Object.entries(views)) {
    enter();
    try {
      const taken = claim(NAME, rival);
      assert.deepEqual([taken.status, taken.reason, taken.previous.running], ["refused", "name-held", true], view);
      assert.deepEqual([release(NAME, undefined, "claude").reason, release(NAME, rival).reason], ["not-holder", "not-holder"], view);
      assert.throws(() => resolveClaim(NAME), (error) => error.reason === "inbox-unavailable" && /which is running/.test(error.message), view);
      assert.deepEqual(claimRows().map((row) => [row.running, row.address, row.holder]), [[true, null, "claude:lead"]], view);
    } finally { process.env.CLAUDE_CONFIG_DIR = f.claude; writeFileSync(sessionFile, saved); }
  }
  assert.equal(resolveClaim(NAME).address, address(join(f.sockets, `${lead.child.pid}.sock`)), "the holder still has its name");
  // A Codex holder whose primary inbox sits in a directory this process knows only from another
  // configuration's Claude sessions.
  const custom = join(f.dir, "custom"), codexAddress = address(join(custom, "codex-w.sock")), start = processStart(lead.child.pid);
  mkdirSync(custom, { mode: 0o700 });
  await f.session("custom", join(custom, "c.sock"));
  writeFileSync(join(f.peers, "codex-w.json"), JSON.stringify({ pid: lead.child.pid, procStart: start, name: "codex:worker-0001", threadId: "w",
    address: codexAddress, addresses: [codexAddress] }), { mode: 0o600 });
  const codex = { kind: "codex", owner: generation("codex", "w"), generation: generation("codex", "w", start), address: codexAddress,
    holder: { pid: lead.child.pid, procStart: start, autoName: "codex:worker-0001", threadId: "w", addresses: [codexAddress] } };
  const codexRival = { ...codex, owner: generation("codex", "v"), generation: generation("codex", "v", "x"),
    holder: { ...codex.holder, pid: process.pid, procStart: processStart(process.pid), threadId: "v" } };
  assert.equal(claim("codex:proj/worker", codex).status, "claimed");
  process.env.CLAUDE_CONFIG_DIR = elsewhere;
  try {
    assert.deepEqual([claim("codex:proj/worker", codexRival).reason, release("codex:proj/worker", codexRival).reason], ["name-held", "not-holder"]);
    assert.throws(() => resolveClaim("codex:proj/worker"), (error) => error.reason === "inbox-unavailable");
  } finally { process.env.CLAUDE_CONFIG_DIR = f.claude; }
  assert.equal(resolveClaim("codex:proj/worker").address, codexAddress);
  // Positive evidence: once the process is gone, both names are taken over.
  await lead.stop();
  assert.deepEqual([claim(NAME, rival).status, claim("codex:proj/worker", codexRival).status], ["taken-over", "taken-over"]);
});

test("the conflict table: dead and reused holders are taken over, the same owner refreshes, a live holder is refused", async (t) => {
  const f = fixture(t);
  // A holder whose process was killed.
  const killed = await f.session("killed"), killedGeneration = killed.claimant().generation;
  assert.equal(claim(NAME, killed.claimant()).status, "claimed");
  await killed.stop();
  const took = claim(NAME, f.me());
  assert.deepEqual([took.status, took.reason, took.name, took.kind, took.generation, took.address],
    ["taken-over", null, NAME, "claude", f.me().generation, address(join(f.sockets, "me.sock"))]);
  assert.deepEqual(took.previous, { holder: "claude:killed", generation: killedGeneration, running: false });
  assert.match(took.text, /Took over claude:proj\/lead from claude:killed .*no longer running/);
  // A holder whose PID now belongs to another process: this PID with a different start.
  const name = "claude:proj/reused", reused = { ...f.me(), owner: generation("claude", process.pid, "an-older-start"),
    generation: generation("claude", process.pid, "an-older-start", join(f.sockets, "me.sock")),
    holder: { ...f.me().holder, procStart: "an-older-start" } };
  claim(name, reused);
  const live = await f.session("live");
  assert.equal(claim(name, live.claimant()).status, "taken-over");
  // The same owner in a new generation (here a new socket) refreshes, with no flag. Its process,
  // the previous holder, still runs.
  f.record(live.child.pid, "live", join(f.sockets, "moved.sock"), { procStart: processStart(live.child.pid) });
  const refreshed = claim(name, live.claimant());
  assert.deepEqual([refreshed.status, refreshed.previous.running], ["refreshed", true]);
  assert.equal(claim(name, live.claimant()).text, `${name} already names this session.`, "an unchanged refresh writes nothing");
  // A running holder with another owner is always refused.
  const held = claim(name, f.me());
  assert.deepEqual([held.status, held.reason, held.generation, held.address, held.previous.holder, held.previous.running],
    ["refused", "name-held", null, null, "claude:live", true]);
  assert.equal(resolveClaim(name).holder, "claude:live");
  // Kinds bind: a Claude session claims only claude: names, and elision fills in its own kind.
  assert.equal(claim("codex:proj/x", f.me()).reason, "scope-denied");
  assert.equal(claim("proj/x", f.me()).name, "claude:proj/x");
});

test("a Claude record without a start time counts as stopped: it is taken over and released, and never resolves", async (t) => {
  const f = fixture(t), socket = join(f.sockets, `${process.pid}.sock`);
  // What rc.2 wrote for an older Claude Code build at this PID and socket, which records no start.
  const legacy = { v: 1, name: NAME, kind: "claude", owner: generation("claude", process.pid, undefined),
    generation: generation("claude", process.pid, undefined, socket), claimedAt: 1,
    holder: { pid: process.pid, autoName: "claude:old", socket, addresses: [address(socket)] } };
  mkdirSync(join(f.peers, "names"), { recursive: true, mode: 0o700 });
  writeFileSync(fileOf(f.dir, NAME), JSON.stringify(legacy), { mode: 0o600 });
  // A later session at the same PID and socket, also without a start time.
  f.record(process.pid, "new", socket);
  assert.throws(() => resolveClaim(NAME), (error) => error.reason === "not-running");
  assert.deepEqual(claimRows().map((row) => [row.name, row.running, row.holder]), [[NAME, false, null]]);
  assert.equal(release(NAME, undefined, "claude").status, "released");
  writeFileSync(fileOf(f.dir, NAME), JSON.stringify(legacy), { mode: 0o600 });
  const other = await f.session("other");
  const took = claim(NAME, other.claimant());
  assert.deepEqual([took.status, took.previous.running], ["taken-over", false]);
});

// A holder is always this user's process: a PID that now belongs to another user (kill gives EPERM)
// means the holder stopped, even when its start time happens to match.
test("a holder whose PID belongs to another user now counts as stopped", { skip: process.getuid() === 0 && "runs as root" }, async (t) => {
  const f = fixture(t), socket = join(f.sockets, "1.sock");
  mkdirSync(join(f.peers, "names"), { recursive: true, mode: 0o700 });
  // PID 1 is root's (init, launchd); its start time is readable.
  writeFileSync(fileOf(f.dir, NAME), JSON.stringify({ v: 1, name: NAME, kind: "claude", owner: generation("claude", 1, processStart(1)),
    generation: generation("claude", 1, processStart(1), socket), claimedAt: 1,
    holder: { pid: 1, procStart: processStart(1), autoName: "claude:pid-one", socket, addresses: [address(socket)] } }), { mode: 0o600 });
  assert.deepEqual(claimRows().map((row) => [row.name, row.running]), [[NAME, false]]);
  const took = claim(NAME, f.me());
  assert.deepEqual([took.status, took.previous.running], ["taken-over", false]);
});

test("at most 8 names per owner", (t) => {
  const f = fixture(t);
  for (let i = 0; i < 8; i++) assert.equal(claim(`proj/n${i}`, f.me()).status, "claimed");
  assert.equal(claim("proj/n8", f.me()).reason, "too-many-names");
  assert.equal(claim("proj/n0", f.me()).status, "refreshed", "a refresh adds no name");
  assert.equal(release("proj/n0", f.me()).status, "released");
  assert.equal(claim("proj/n8", f.me()).status, "claimed");
});

test("scans read every record, and a new record is refused once 1024 exist while refreshes and takeovers still work", (t) => {
  const f = fixture(t), names = join(f.peers, "names");
  mkdirSync(names, { recursive: true, mode: 0o700 });
  const owner = (id) => ({ kind: "codex", owner: generation("codex", id), generation: generation("codex", id, "1"), address: null,
    holder: { pid: 0x7ffffff0, autoName: `codex:${id}-0001`, threadId: id, addresses: [] } });
  const write = (name, o) => writeFileSync(fileOf(f.dir, name), JSON.stringify({ v: 1, name, kind: "codex", owner: o.owner, generation: o.generation,
    claimedAt: 1, holder: o.holder }), { mode: 0o600 }), hash = (name) => basename(fileOf(f.dir, name));
  // More records than the bound, as an older agent-peers could leave; nine of one owner's sort last.
  for (let i = 0; i < 1100; i++) write(`codex:old/worker-${i}`, owner(`w${i}`));
  const last = readdirSync(names).sort().at(-1), mine = [];
  for (let i = 0; mine.length < 9; i++) if (hash(`codex:proj/role-${i}`) > last) mine.push(`codex:proj/role-${i}`);
  for (const name of mine) write(name, owner("me"));
  assert.deepEqual(claimsOf({ owner: owner("me").owner }).sort(), [...mine].sort(), "the restart re-claim sees every name");
  assert.equal(claimRows().length, 1109);
  // The owner already holds more than 8, all of which the cap counts, so it cannot take another.
  assert.equal(claim("codex:old/worker-0", owner("me")).reason, "too-many-names");
  assert.equal(claim(mine[0], owner("me")).status, "refreshed", "a refresh still works");
  // Another owner: no new file past the bound, but a dead record is taken over.
  const refused = claim("codex:proj/new", owner("other"));
  assert.deepEqual([refused.reason, /1024 claimed names/.test(refused.text)], ["too-many-names", true]);
  assert.equal(claim("codex:old/worker-1", owner("other")).status, "taken-over");
  assert.equal(readdirSync(names).filter((name) => name.startsWith("n-")).length, 1109);
});

test("release: only the holder of a running claim, anyone once the holder stopped, and never a newer record", async (t) => {
  const f = fixture(t), other = await f.session("other");
  claim(NAME, other.claimant());
  const refused = release(NAME, f.me());
  assert.deepEqual([refused.status, refused.reason], ["refused", "not-holder"]);
  assert.equal(release(NAME, undefined, "claude").reason, "not-holder", "outside any session too");
  assert.equal(release(NAME, other.claimant()).status, "released");
  assert.equal(release(NAME, other.claimant()).reason, "not-found");
  claim(NAME, other.claimant());
  await other.stop();
  const released = release(NAME, undefined, "claude");
  assert.deepEqual([released.status, released.generation, released.previous.running], ["released", null, false]);
  // A release that loses to a takeover keeps the takeover.
  const old = await f.session("old"), next = await f.session("next");
  claim(NAME, old.claimant());
  await old.stop();
  const file = fileOf(f.dir, NAME);
  const takeover = { ...JSON.parse(readFileSync(file, "utf8")), owner: next.claimant().owner, generation: next.claimant().generation };
  interleave(t, file, takeover);
  assert.equal(release(NAME, undefined, "claude").reason, "conflict");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).generation, next.claimant().generation);
});

test("a dead name is released only by a releaser of its own kind, and a Hermes one only within its profile", async (t) => {
  const f = fixture(t);
  // A gaming conversation's names right after its gateway restarted: dead until its next call.
  const owner = generation("hermes", "gaming", "conversation-1");
  const gaming = { kind: "hermes", scope: "gaming", owner, generation: generation("hermes", "route-old"), address: null,
    holder: { pid: 0x7ffffffd, autoName: "hermes:gaming:abcd1234", addresses: [address(join(f.sockets, `hermes-${"b".repeat(32)}.sock`))] } };
  for (const name of ["hermes:gaming/relay", "hermes:gaming/scout"]) assert.equal(claim(name, gaming).status, "claimed");
  const deadCodex = { kind: "codex", owner: generation("codex", "gone"), generation: generation("codex", "gone", "1"), address: null,
    holder: { pid: 0x7ffffffe, autoName: "codex:gone-1234", threadId: "gone", addresses: [] } };
  assert.equal(claim("codex:proj/worker", deadCodex).status, "claimed");
  const codex = { kind: "codex", owner: generation("codex", "T"), generation: generation("codex", "T", "1"), address: null,
    holder: { pid: process.pid, autoName: "codex:x-0001", threadId: "T", addresses: [] } };
  const casa = { ...gaming, scope: "casa", owner: generation("hermes", "casa", "conversation-2"), generation: generation("hermes", "route-casa") };
  for (const [who, name, claimant, kind] of [["the CLI outside a session", "hermes:gaming/relay", undefined, "claude"],
    ["the CLI outside a session", "codex:proj/worker", undefined, "claude"], ["a Claude session", "codex:proj/worker", f.me(), "claude"],
    ["a Codex session", "hermes:gaming/scout", codex, "codex"], ["another Hermes profile", "hermes:gaming/scout", casa, "hermes"]]) {
    const refused = release(name, claimant, kind);
    assert.deepEqual([refused.status, refused.reason, refused.name], ["refused", "scope-denied", name], `${who}: ${name}`);
  }
  assert.deepEqual(claimRows().map((row) => row.name), ["codex:proj/worker", "hermes:gaming/relay", "hermes:gaming/scout"], "nothing was removed");
  // Its own kind may: Codex releases the dead Codex name, the gaming profile its own dead name.
  assert.equal(release("codex:proj/worker", codex).status, "released");
  const sibling = { ...gaming, owner: generation("hermes", "gaming", "conversation-3"), generation: generation("hermes", "route-3") };
  assert.equal(release("hermes:gaming/scout", sibling).status, "released");
  assert.equal(release("hermes:gaming/relay", gaming).status, "released");
});

test("a record with a higher version is read when it validates, and never replaced or removed", async (t) => {
  const f = fixture(t), live = await f.session("live"), gone = await f.session("gone");
  claim(NAME, live.claimant());
  claim("claude:proj/gone", gone.claimant());
  await gone.stop();
  for (const name of [NAME, "claude:proj/gone"]) {
    const file = fileOf(f.dir, name);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), v: 2, future: { meaning: "unknown here" } }), { mode: 0o600 });
  }
  assert.equal(resolveClaim(NAME).holder, "claude:live", "a v2 record this version can read still resolves");
  assert.throws(() => resolveClaim("claude:proj/gone"), (error) => error.reason === "not-running");
  for (const name of [NAME, "claude:proj/gone"]) {
    const before = readFileSync(fileOf(f.dir, name), "utf8");
    assert.deepEqual([claim(name, f.me()).reason, release(name, undefined, "claude").reason], ["name-held", "not-holder"], name);
    assert.equal(readFileSync(fileOf(f.dir, name), "utf8"), before, `${name} is untouched`);
  }
  assert.deepEqual([claim(NAME, live.claimant()).reason, release(NAME, live.claimant()).reason], ["name-held", "not-holder"], "not even by its holder");
});

test("file safety: unsafe, foreign or mismatched files are never read as claims; the directory is private", async (t) => {
  const f = fixture(t), other = await f.session("other");
  claim(NAME, other.claimant());
  const names = join(f.peers, "names"), file = fileOf(f.dir, NAME), good = readFileSync(file, "utf8");
  assert.equal(lstatSync(names).mode & 0o777, 0o700);
  assert.equal(lstatSync(file).mode & 0o777, 0o600);
  const unread = () => {
    assert.throws(() => resolveClaim(NAME), (error) => error.reason === "not-found");
    assert.deepEqual(claimRows().map((row) => row.name), []);
  };
  rmSync(file);
  writeFileSync(join(f.dir, "elsewhere.json"), good);
  symlinkSync(join(f.dir, "elsewhere.json"), file);
  unread();
  rmSync(file);
  for (const mode of [0o660, 0o606]) {
    writeFileSync(file, good, { mode: 0o600 });
    chmodSync(file, mode);
    unread();
    rmSync(file);
  }
  writeFileSync(file, JSON.stringify({ ...JSON.parse(good), padding: "x".repeat(70_000) }), { mode: 0o600 });
  unread();
  writeFileSync(file, JSON.stringify({ ...JSON.parse(good), kind: "codex" }), { mode: 0o600 });
  unread();
  rmSync(file);
  // A valid record in another name's file.
  writeFileSync(fileOf(f.dir, "claude:proj/other"), good, { mode: 0o600 });
  assert.deepEqual(claimRows(), []);
  assert.throws(() => resolveClaim("claude:proj/other"), (error) => error.reason === "not-found");
  // An invalid file in the name's place can be claimed over.
  writeFileSync(file, "not json", { mode: 0o600 });
  assert.equal(claim(NAME, f.me()).status, "claimed");
  // A record from a newer agent-peers, or one that cannot be read right now, is never replaced or removed.
  writeFileSync(file, JSON.stringify({ ...JSON.parse(good), v: 2, holder: { future: true } }), { mode: 0o600 });
  assert.deepEqual([claim(NAME, f.me()).reason, release(NAME, undefined, "claude").reason], ["name-held", "not-holder"]);
  if (process.getuid() !== 0) {
    writeFileSync(file, good, { mode: 0o600 });
    chmodSync(file, 0o000);
    const [claimed, released] = [claim(NAME, f.me()), release(NAME, undefined, "claude")];
    assert.deepEqual([claimed.reason, released.reason, claimed.name], ["conflict", "conflict", NAME]);
    assert.match(claimed.text, /\(EACCES\); nothing changed/);
    chmodSync(file, 0o600);
  }
  chmodSync(names, 0o755);
  assert.deepEqual(claimRows(), [], "a shared directory is not read");
  assert.throws(() => claim(NAME, f.me()), /unsafe peer directory/);
  chmodSync(names, 0o700);
});

test("resolution: precise not-found and not-running texts, and the holder's inbox in the caller's directory", async (t) => {
  const f = fixture(t);
  assert.throws(() => resolveClaim(NAME), (error) => error.reason === "not-found" &&
    error.message === "No session has claimed claude:proj/lead. Its holder must claim it (Claude: agent-peers claim; Codex or Hermes: claim_name). Nothing was sent.");
  const gone = await f.session("gone");
  claim(NAME, gone.claimant());
  await gone.stop();
  assert.throws(() => resolveClaim(NAME), (error) => error.reason === "not-running" &&
    /^claude:proj\/lead is claimed by claude:gone, a Claude session that is no longer running \(claimed \d{4}-.*Z, generation [a-f0-9]{16}\)\. Nothing was sent\. The new session must claim it\.$/.test(error.message));
  // A Codex holder with inboxes in two directories, both verified by live Claude sessions.
  await f.session("elsewhere", join(f.other, "elsewhere.sock"));
  const start = processStart(process.pid), primary = address(join(f.sockets, "codex-w.sock")), alias = address(join(f.other, "codex-w.sock"));
  mkdirSync(f.peers, { recursive: true, mode: 0o700 });
  writeFileSync(join(f.peers, "codex-w.json"), JSON.stringify({ pid: process.pid, procStart: start, name: "codex:worker-0001", threadId: "w",
    address: primary, addresses: [primary, alias] }));
  const codex = { kind: "codex", owner: generation("codex", "w"), generation: generation("codex", "w", start), address: primary,
    holder: { pid: process.pid, procStart: start, autoName: "codex:worker-0001", threadId: "w", addresses: [primary] } };
  assert.equal(claim("codex:proj/worker", codex).status, "claimed");
  assert.equal(resolveClaim("codex:proj/worker").address, primary);
  assert.equal(resolveClaim("codex:proj/worker", { directory: f.other }).address, alias, "the live registry's alias, fresher than the claim");
  assert.equal(resolveClaim("codex:proj/worker", { directory: join(f.dir, "none") }).address, primary);
  const rows = claimRows();
  assert.deepEqual(rows.map((row) => [row.name, row.running, row.holder, row.address]),
    [[NAME, false, null, null], ["codex:proj/worker", true, "codex:worker-0001", primary]].sort());
  assert.ok(rows.every((row) => typeof row.claimedAt === "number" && /^[a-f0-9]{16}$/.test(row.generation)));
  assert.deepEqual(withClaims(claudeSessions()).map((row) => row.claims), [[], []]);
});

test("pins: a claim follows its holder and says so, while an automatic name still fails on a pin mismatch", async (t) => {
  const f = fixture(t), pins = new Pins(), first = await f.session("first");
  claim(NAME, first.claimant());
  const before = resolveTarget(NAME, pins);
  assert.deepEqual([before.name, before.generation, before.note], [NAME, first.claimant().generation, undefined]);
  await first.stop();
  const second = await f.session("second");
  assert.equal(claim(NAME, second.claimant()).status, "taken-over");
  const after = resolveTarget(NAME, pins);
  assert.equal(after.generation, second.claimant().generation);
  assert.equal(after.note, `${NAME} is held by a different session than at your last send (generation ${before.generation} → ${after.generation}).`);
  assert.equal(resolveTarget(NAME, pins).note, undefined, "the pin now follows the new holder");
  pins.note("claude:me", "0000000000000000");
  assert.throws(() => resolveTarget("claude:me", pins), (error) => error.reason === "not-running" && /now a different process/.test(error.message));
});
