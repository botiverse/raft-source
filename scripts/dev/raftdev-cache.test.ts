// Where dev caches and test temp files go (raftdev-cache.ts). statfs and the
// sweep's filesystem are fakes; only the startDevRun test writes, inside its
// own temp dir. Run: pnpm exec vitest run scripts/dev/raftdev-cache.test.ts
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";

import {
  ENVS_DIR,
  ENV_OWNER_FILE,
  JOBS_DIR,
  MAX_RUN_TMPDIR_BYTES,
  RUN_DIR_ENV,
  STALE_RUN_AGE_MS,
  TMPFS_MAGIC,
  agentIdFor,
  agentKeyFor,
  devEnvSessionName,
  envKeyFor,
  isStaleRun,
  prepareDevEnvDir,
  processesUsingTmpdir,
  realEnvDirFs,
  recordDevEnvProcesses,
  removeDevEnvDir,
  resolveDevEnvDir,
  resolveDevCachePaths,
  runCacheCli,
  startDevRun,
  storageMedium,
  sweepStaleRuns,
  type EnvDirFs,
  type EnvOwner,
  type EnvTeardownContext,
  type RunOwner,
  type EntryKind,
  type StatFs,
  type SweepFs,
} from "./raftdev-cache";

const EXT4 = 0xef53;

/** A fake tree: existing paths, symlinks (path -> target), and mounts (prefix -> f_type). */
function fakeFs(options: { exists: string[]; links?: Record<string, string>; mounts: Record<string, number> }): StatFs & { statted: string[] } {
  const statted: string[] = [];
  const links = options.links ?? {};
  const exists = new Set(options.exists);
  const realpath = (p: string): string => {
    // Resolve the longest symlinked prefix, then require existence.
    for (const [link, target] of Object.entries(links)) {
      if (p === link || p.startsWith(`${link}/`)) return realpath(target + p.slice(link.length));
    }
    if (!exists.has(p)) throw Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" });
    return p;
  };
  return {
    statted,
    realpath,
    statfsType: (p) => {
      statted.push(p);
      const mount = Object.keys(options.mounts).filter((m) => p === m || p.startsWith(m === "/" ? "/" : `${m}/`))
        .sort((a, b) => b.length - a.length)[0];
      return options.mounts[mount];
    },
  };
}

const HOME = "/home/u";
const diskHome = () => fakeFs({ exists: ["/", "/home", HOME, `${HOME}/.cache`, "/tmp"], mounts: { "/": EXT4, "/tmp": TMPFS_MAGIC } });
const base = { platform: "linux" as const, homedir: HOME, username: "u" };

test("storageMedium follows symlinks and judges a missing path by its nearest existing parent", () => {
  const sfs = fakeFs({
    exists: ["/", "/home", HOME, "/tmp", "/tmp/c"],
    links: { [`${HOME}/.cache`]: "/tmp/c" },
    mounts: { "/": EXT4, "/tmp": TMPFS_MAGIC },
  });
  // ~/.cache is a symlink into tmpfs; raft-dev/ under it doesn't exist yet.
  assert.deepEqual(storageMedium(`${HOME}/.cache/raft-dev/node-compile-cache`, sfs), { medium: "ram", checked: "/tmp/c" });
  assert.deepEqual(storageMedium(`${HOME}/projects/x`, sfs), { medium: "disk", checked: HOME });
});

test("on disk: compile cache and per-run TMPDIR under ~/.cache/raft-dev; browsers at Playwright's default", () => {
  const paths = resolveDevCachePaths({ ...base, env: { SLOCK_AGENT_ID: "agent-1" }, statfs: diskHome() });
  assert.equal(paths.active, true);
  assert.equal(paths.root, `${HOME}/.cache/raft-dev`);
  assert.deepEqual(paths.nodeCompileCache, { path: `${HOME}/.cache/raft-dev/node-compile-cache`, source: "raft-dev" });
  assert.deepEqual(paths.tmp, { source: "raft-dev", path: null });
  assert.deepEqual(paths.playwrightBrowsers, { path: `${HOME}/.cache/ms-playwright`, source: "default" });
  assert.equal(paths.agentId, "agent-1");
  assert.deepEqual(paths.warnings, []);
});

test("XDG_CACHE_HOME on tmpfs falls back to a verified on-disk ~/.cache", () => {
  const paths = resolveDevCachePaths({ ...base, env: { XDG_CACHE_HOME: "/tmp/xdg" }, statfs: diskHome() });
  assert.equal(paths.root, `${HOME}/.cache/raft-dev`);
  // Browsers stay where Playwright looks (XDG), with a warning, not moved.
  assert.equal(paths.playwrightBrowsers.path, "/tmp/xdg/ms-playwright");
  assert.match(paths.warnings.join("\n"), /Playwright browsers path \/tmp\/xdg\/ms-playwright is on tmpfs/);
});

test("no on-disk candidate: nothing applied and a warning says the caches stay in RAM", () => {
  const sfs = fakeFs({ exists: ["/", "/home", HOME], mounts: { "/": TMPFS_MAGIC } });
  const paths = resolveDevCachePaths({ ...base, env: {}, statfs: sfs });
  assert.equal(paths.active, false);
  assert.equal(paths.root, null);
  assert.equal(paths.nodeCompileCache.source, "none");
  assert.match(paths.warnings.join("\n"), /NOT migrated.*in RAM/);
  const run = startDevRun({ ...base, env: {}, statfs: sfs, warn: () => {} });
  assert.deepEqual(run.env, {});
});

test("explicit configuration wins: TMPDIR, NODE_COMPILE_CACHE, PLAYWRIGHT_BROWSERS_PATH, RAFT_DEV_CACHE_DIR", () => {
  const env = {
    TMPDIR: "/tmp",
    NODE_COMPILE_CACHE: "/srv/ncc",
    PLAYWRIGHT_BROWSERS_PATH: "/srv/pw",
    RAFT_DEV_CACHE_DIR: "/srv/raft-dev",
  };
  const paths = resolveDevCachePaths({ ...base, env, statfs: diskHome() });
  assert.equal(paths.root, "/srv/raft-dev");
  assert.deepEqual(paths.nodeCompileCache, { path: "/srv/ncc", source: "env" });
  assert.deepEqual(paths.tmp, { source: "env", path: "/tmp" });
  assert.deepEqual(paths.playwrightBrowsers, { path: "/srv/pw", source: "env" });
  // Kept, but the RAM placement is said out loud.
  assert.match(paths.warnings.join("\n"), /TMPDIR \/tmp is on tmpfs; it stays in RAM/);
  const run = startDevRun({ ...base, env, statfs: diskHome(), warn: () => {} });
  assert.deepEqual(run.env, {});
  assert.equal(run.runDir, null);
});

test("CI, non-Linux and RAFT_DEV_CACHE=0 are untouched", () => {
  for (const [env, platform] of [
    [{ CI: "true" }, "linux"],
    [{ CI: "1" }, "linux"],
    [{ GITHUB_ACTIONS: "true" }, "linux"],
    [{ RAFT_DEV_CACHE: "0" }, "linux"],
    [{}, "darwin"],
  ] as const) {
    const sfs = diskHome();
    const paths = resolveDevCachePaths({ ...base, env, platform, statfs: sfs });
    assert.equal(paths.active, false, JSON.stringify(env));
    assert.deepEqual(startDevRun({ ...base, env, platform, statfs: sfs, warn: () => {} }).env, {});
  }
  // No statfs at all in CI: nothing is probed.
  const sfs = diskHome();
  resolveDevCachePaths({ ...base, env: { CI: "true" }, statfs: sfs });
  assert.deepEqual(sfs.statted, []);
});

test("a run under a parent launcher reuses the parent's TMPDIR", () => {
  const env = { [RUN_DIR_ENV]: "/r/run", TMPDIR: "/r/run/tmp", NODE_COMPILE_CACHE: "/r/ncc" };
  const paths = resolveDevCachePaths({ ...base, env, statfs: diskHome() });
  assert.deepEqual(paths.tmp, { source: "parent-run", path: "/r/run/tmp" });
  const run = startDevRun({ ...base, env, statfs: diskHome(), warn: () => {} });
  assert.equal(run.runDir, null);
  assert.deepEqual(run.env, {});
});

test("agent id: Raft agent env, else the user name; its dir is 8 hex of its sha256", () => {
  assert.equal(agentIdFor({ SLOCK_AGENT_ID: "b41f36f6-803d" }, "u"), "b41f36f6-803d");
  assert.equal(agentIdFor({ RAFT_AGENT_ID: "a", SLOCK_AGENT_ID: "b" }, "u"), "a");
  assert.equal(agentIdFor({}, "jzm"), "jzm");
  assert.match(agentKeyFor("../x/y"), /^[0-9a-f]{8}$/);
  assert.equal(agentKeyFor("a1"), agentKeyFor("a1"));
  assert.notEqual(agentKeyFor("a1"), agentKeyFor("a2"));
});

const NOW = 10 * STALE_RUN_AGE_MS;
const ctx = (alive: number[]) => ({ now: NOW, hostname: "h", bootId: "boot-1", isPidAlive: (pid: number) => alive.includes(pid) });
const owner = (o: Partial<RunOwner>): RunOwner => ({ pid: 100, hostname: "h", bootId: "boot-1", startedAt: NOW - 2 * STALE_RUN_AGE_MS, ...o });

test("a leftover run is removed only when its owner record is older than 24h and its process is gone", () => {
  // Fresh: kept whatever the pid.
  assert.equal(isStaleRun(owner({ startedAt: NOW - 1000 }), ctx([])), false);
  // Old, process alive: kept (a run longer than a day is still a run).
  assert.equal(isStaleRun(owner({}), ctx([100])), false);
  // Old, process gone: removed.
  assert.equal(isStaleRun(owner({}), ctx([])), true);
  // Old, from an earlier boot: removed even if the pid is in use again.
  assert.equal(isStaleRun(owner({ bootId: "boot-0" }), ctx([100])), true);
  // Recorded on another host (a shared home): never removed here.
  assert.equal(isStaleRun(owner({ hostname: "other" }), ctx([])), false);
  // No owner record: never removed (no mtime-only deletion).
  assert.equal(isStaleRun(null, ctx([])), false);
});

const A1 = agentKeyFor("a1");
const A2 = agentKeyFor("a2");

/** A fake jobs tree: path -> kind, owners by run dir. */
function fakeSweepFs(tree: Record<string, EntryKind>, owners: Record<string, RunOwner>) {
  const removed: string[] = [];
  const sfs: SweepFs = {
    readdir: (dir) => Object.keys(tree).filter((p) => path.dirname(p) === dir).map((p) => path.basename(p)),
    kind: (p) => tree[p] ?? null,
    readOwner: (d) => owners[d] ?? null,
    remove: (d) => removed.push(d),
  };
  return { sfs, removed };
}

test("sweepStaleRuns removes only stale runs it made, of one agent or all, and never follows symlinks", () => {
  const j = "/r/j";
  const dead = owner({ pid: 2 });
  const tree: Record<string, EntryKind> = {
    [j]: "dir",
    [`${j}/${A1}`]: "dir",
    [`${j}/${A1}/live01`]: "dir",
    [`${j}/${A1}/dead01`]: "dir",
    [`${j}/${A1}/new001`]: "dir",
    [`${j}/${A1}/noown1`]: "dir", // no owner.json: left alone however old
    [`${j}/${A1}/link01`]: "symlink", // a symlink, even with a stale owner
    [`${j}/${A1}/Foreign-Name`]: "dir", // not a run id
    [`${j}/${A2}`]: "dir",
    [`${j}/${A2}/dead02`]: "dir",
    [`${j}/${agentKeyFor("a3")}`]: "symlink", // a symlinked agent dir
    [`${j}/${agentKeyFor("a3")}/dead03`]: "dir",
    [`${j}/not-an-agent`]: "dir",
    [`${j}/not-an-agent/dead04`]: "dir",
  };
  const owners = {
    [`${j}/${A1}/live01`]: owner({ pid: 1 }),
    [`${j}/${A1}/dead01`]: dead,
    [`${j}/${A1}/new001`]: owner({ pid: 3, startedAt: NOW }),
    [`${j}/${A1}/link01`]: dead,
    [`${j}/${A1}/Foreign-Name`]: dead,
    [`${j}/${A2}/dead02`]: dead,
    [`${j}/${agentKeyFor("a3")}/dead03`]: dead,
    [`${j}/not-an-agent/dead04`]: dead,
  };
  const one = fakeSweepFs(tree, owners);
  assert.deepEqual(sweepStaleRuns(j, A1, ctx([1]), one.sfs), [`${j}/${A1}/dead01`]);
  const all = fakeSweepFs(tree, owners);
  assert.deepEqual(sweepStaleRuns(j, null, ctx([1]), all.sfs).sort(), [`${j}/${A1}/dead01`, `${j}/${A2}/dead02`].sort());
  // A symlinked jobs dir is not swept at all.
  const linked = fakeSweepFs({ ...tree, [j]: "symlink" }, owners);
  assert.deepEqual(sweepStaleRuns(j, null, ctx([]), linked.sfs), []);
});

test("the per-run TMPDIR stays short enough for AF_UNIX socket paths", () => {
  const sfs: StatFs = { realpath: (p) => p, statfsType: () => EXT4 };
  // <root>/j/<8>/<6>/tmp; the default root under a long HOME: HOME + 38 bytes,
  // within 60 beyond HOME.
  const longHome = `/home/${"u".repeat(22)}`; // 28 bytes
  const paths = resolveDevCachePaths({ ...base, homedir: longHome, env: {}, statfs: sfs });
  const sample = path.join(paths.root ?? "", JOBS_DIR, paths.agentKey, "abcdef", "tmp");
  assert.equal(sample.length - longHome.length, 38);
  assert.ok(sample.length <= MAX_RUN_TMPDIR_BYTES, `${sample.length}`);
  // The budget leaves 40 bytes of 108 for names under it.
  assert.ok(108 - MAX_RUN_TMPDIR_BYTES >= 40);
  // Over budget: TMPDIR is left alone (with a warning), nothing is written.
  const warnings: string[] = [];
  const over = startDevRun({ ...base, env: { RAFT_DEV_CACHE_DIR: `/nonexistent/${"x".repeat(60)}` }, statfs: sfs, warn: (w) => warnings.push(w) });
  assert.equal(over.env.TMPDIR, undefined);
  assert.equal(over.runDir, null);
  assert.match(warnings.join("\n"), /AF_UNIX/);
});

test("startDevRun makes a private run dir with an owner record and removes it on cleanup", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "raftdev-cache-test-"));
  try {
    const sfs: StatFs = { realpath: (p) => p, statfsType: () => EXT4 };
    const run = startDevRun({ ...base, env: { RAFT_DEV_CACHE_DIR: scratch, SLOCK_AGENT_ID: "a1" }, statfs: sfs, pid: 4242, warn: () => {}, maxTmpdirBytes: Infinity });
    const runDir = run.runDir ?? assert.fail("no run dir");
    assert.ok(runDir.startsWith(path.join(scratch, JOBS_DIR, agentKeyFor("a1")) + path.sep), runDir);
    assert.equal(run.env.TMPDIR, path.join(runDir, "tmp"));
    assert.equal(run.env[RUN_DIR_ENV], runDir);
    assert.equal(run.env.NODE_COMPILE_CACHE, path.join(scratch, "node-compile-cache"));
    assert.ok(existsSync(run.env.TMPDIR));
    assert.equal((JSON.parse(readFileSync(path.join(runDir, "owner.json"), "utf8")) as RunOwner).pid, 4242);
    run.cleanup();
    assert.equal(existsSync(runDir), false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("cache status writes nothing and warns when the pnpm store is on tmpfs", () => {
  const lines: string[] = [];
  const calls: string[][] = [];
  const sfs = fakeFs({ exists: ["/", "/home", HOME, `${HOME}/.cache`, "/tmp", "/tmp/store"], mounts: { "/": EXT4, "/tmp": TMPFS_MAGIC } });
  const code = runCacheCli(["status"], {
    out: (l) => lines.push(l),
    env: { HOME, SLOCK_AGENT_ID: "a1" },
    statfs: sfs,
    pnpm: (args) => {
      calls.push(args);
      return { stdout: "/tmp/store\n", status: 0 };
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, [["store", "path"]]);
  assert.match(lines.join("\n"), /pnpm store is on tmpfs and was NOT moved/);
});

test("cache prune sweeps every agent, clears the compile cache it owns, then prunes the pnpm store", () => {
  const lines: string[] = [];
  const calls: string[][] = [];
  const root = "/r";
  const { sfs: sweepFs, removed } = fakeSweepFs({
    [`${root}/j`]: "dir",
    [`${root}/j/${A1}`]: "dir",
    [`${root}/j/${A1}/dead01`]: "dir",
    [`${root}/node-compile-cache`]: "dir",
  }, { [`${root}/j/${A1}/dead01`]: owner({ pid: 2, hostname: hostname() }) });
  const code = runCacheCli(["prune"], {
    out: (l) => lines.push(l),
    env: { RAFT_DEV_CACHE_DIR: root },
    statfs: { realpath: (p) => p, statfsType: () => EXT4 },
    sweepFs,
    now: Date.now() + 10 * STALE_RUN_AGE_MS,
    pnpm: (args) => {
      calls.push(args);
      return { stdout: "", status: 0 };
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(removed, [`${root}/j/${A1}/dead01`, `${root}/node-compile-cache`]);
  assert.deepEqual(calls, [["store", "prune"]]);
  // An explicit NODE_COMPILE_CACHE is the user's: not cleared.
  const kept = fakeSweepFs({ "/srv/ncc": "dir" }, {});
  runCacheCli(["prune"], { out: () => {}, env: { RAFT_DEV_CACHE_DIR: root, NODE_COMPILE_CACHE: "/srv/ncc" }, statfs: { realpath: (p) => p, statfsType: () => EXT4 }, sweepFs: kept.sfs, pnpm: () => ({ stdout: "", status: 0 }) });
  assert.deepEqual(kept.removed, []);
});

// ───────────────── per-environment dirs (./raftdev start / stop) ─────────────────

const ENV_ID = "/home/u/wt/a/.slockdev/demo";

test("the environment dir is keyed by the env's unique id, short enough for sockets", () => {
  const sfs: StatFs = { realpath: (p) => p, statfsType: () => EXT4 };
  const longHome = `/home/${"u".repeat(22)}`; // 28 bytes
  const dir = resolveDevEnvDir(ENV_ID, { ...base, homedir: longHome, env: {}, statfs: sfs });
  assert.equal(dir.source, "raft-dev");
  assert.equal(dir.envKey, envKeyFor(ENV_ID));
  assert.match(dir.envKey, /^[0-9a-f]{8}$/);
  assert.equal(dir.dir, path.join(longHome, ".cache", "raft-dev", ENVS_DIR, dir.envKey));
  assert.equal(dir.tmpdir, path.join(dir.dir ?? "", "tmp"));
  // <root>/env/<8>/tmp: HOME + 33 bytes, within the run TMPDIR budget.
  assert.equal((dir.tmpdir ?? "").length - longHome.length, 33);
  assert.ok((dir.tmpdir ?? "").length <= MAX_RUN_TMPDIR_BYTES);
  // Same name in another worktree: another dir. Same id: the same dir (fixed, not per start).
  const other = resolveDevEnvDir("/home/u/wt/b/.slockdev/demo", { ...base, env: {}, statfs: sfs });
  assert.notEqual(other.envKey, dir.envKey);
  assert.equal(resolveDevEnvDir(ENV_ID, { ...base, homedir: longHome, env: {}, statfs: sfs }).dir, dir.dir);
  // Over budget: nothing changes, with a warning.
  const over = resolveDevEnvDir(ENV_ID, { ...base, env: { RAFT_DEV_CACHE_DIR: `/nonexistent/${"x".repeat(60)}` }, statfs: sfs });
  assert.equal(over.source, "none");
  assert.equal(over.tmpdir, null);
  assert.match(over.warnings.join("\n"), /AF_UNIX/);
});

test("an explicit TMPDIR wins; one inherited from another environment's services does not", () => {
  const sfs: StatFs = { realpath: (p) => p, statfsType: () => EXT4 };
  const explicit = resolveDevEnvDir(ENV_ID, { ...base, env: { TMPDIR: "/srv/tmp" }, statfs: sfs });
  assert.equal(explicit.source, "env");
  assert.equal(explicit.tmpdir, null);
  const fromOtherEnv = `${HOME}/.cache/raft-dev/${ENVS_DIR}/${envKeyFor("/other/.slockdev/x")}/tmp`;
  const inherited = resolveDevEnvDir(ENV_ID, { ...base, env: { TMPDIR: fromOtherEnv }, statfs: sfs });
  assert.equal(inherited.source, "raft-dev");
  assert.equal(inherited.tmpdir, `${HOME}/.cache/raft-dev/${ENVS_DIR}/${envKeyFor(ENV_ID)}/tmp`);
});

test("the environment dir falls back past tmpfs, and CI / non-Linux / opt-out change nothing", () => {
  const xdgOnTmpfs = fakeFs({ exists: ["/", "/home", HOME, `${HOME}/.cache`, "/tmp", "/tmp/xdg"], mounts: { "/": EXT4, "/tmp": TMPFS_MAGIC } });
  const fallback = resolveDevEnvDir(ENV_ID, { ...base, env: { XDG_CACHE_HOME: "/tmp/xdg" }, statfs: xdgOnTmpfs });
  assert.equal(fallback.dir, `${HOME}/.cache/raft-dev/${ENVS_DIR}/${envKeyFor(ENV_ID)}`);
  const allRam = fakeFs({ exists: ["/"], mounts: { "/": TMPFS_MAGIC } });
  assert.equal(resolveDevEnvDir(ENV_ID, { ...base, env: {}, statfs: allRam }).source, "none");
  const sfs: StatFs = { realpath: (p) => p, statfsType: () => EXT4 };
  for (const input of [
    { ...base, env: { CI: "true" } },
    { ...base, env: { GITHUB_ACTIONS: "true" } },
    { ...base, env: {}, platform: "darwin" as const },
    { ...base, env: { RAFT_DEV_CACHE: "0" } },
  ]) {
    const r = resolveDevEnvDir(ENV_ID, { ...input, statfs: sfs });
    assert.equal(r.source, "none", JSON.stringify(input));
    assert.equal(r.tmpdir, null);
  }
});

test("prepareDevEnvDir creates the dir with an owner record; recordDevEnvProcesses adds pid + starttime", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "raftdev-cache-test-"));
  try {
    const sfs: StatFs = { realpath: (p) => p, statfsType: () => EXT4 };
    const resolved = resolveDevEnvDir(ENV_ID, { ...base, env: { RAFT_DEV_CACHE_DIR: scratch }, statfs: sfs, maxTmpdirBytes: Infinity });
    const dir = resolved.dir ?? assert.fail("no env dir");
    const starttimeOf = (pid: number) => (pid === 7 ? null : `st${pid}`); // 7: already gone
    assert.equal(prepareDevEnvDir(resolved, { pid: 4242, now: 1, hostname: "h", bootId: "b", warn: () => {}, starttimeOf }), true);
    assert.ok(existsSync(path.join(dir, "tmp")));
    recordDevEnvProcesses(dir, [{ pid: 5, role: "tmux-pane" }, { pid: 6, role: "tmux-pane" }, { pid: 5, role: "tmux-pane" }, { pid: 7, role: "tmux-pane" }], starttimeOf);
    const owner = JSON.parse(readFileSync(path.join(dir, "owner.json"), "utf8")) as EnvOwner;
    assert.deepEqual(owner, {
      envId: ENV_ID, hostname: "h", bootId: "b", startedAt: 1,
      processes: [
        { pid: 4242, starttime: "st4242", role: "raftdev-start" },
        { pid: 5, starttime: "st5", role: "tmux-pane" },
        { pid: 6, starttime: "st6", role: "tmux-pane" },
      ],
    });
    // A colliding key owned by another environment is not taken over.
    const warnings: string[] = [];
    assert.equal(prepareDevEnvDir({ ...resolved, envId: "/elsewhere" }, { warn: (w) => warnings.push(w) }), false);
    assert.match(warnings.join("\n"), /belongs to/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("processesUsingTmpdir matches TMPDIR in /proc/<pid>/environ exactly or below", () => {
  const proc = mkdtempSync(path.join(tmpdir(), "raftdev-cache-proc-"));
  try {
    const env = (pid: string, vars: string[]) => {
      mkdirSync(path.join(proc, pid));
      writeFileSync(path.join(proc, pid, "environ"), vars.join("\0") + "\0");
    };
    env("10", ["A=1", "TMPDIR=/r/env/k/tmp"]);
    env("11", ["TMPDIR=/r/env/k/tmp/sub"]);
    env("12", ["TMPDIR=/r/env/k/tmpx"]);
    env("13", ["PATH=/bin"]);
    mkdirSync(path.join(proc, "self"));
    assert.deepEqual(processesUsingTmpdir("/r/env/k/tmp", proc)?.sort(), [10, 11]);
    // Compared after realpath: a TMPDIR reaching the dir through a symlink counts.
    const real = path.join(proc, "real-tmp");
    mkdirSync(real);
    symlinkSync(real, path.join(proc, "link-tmp"));
    env("20", [`TMPDIR=${path.join(proc, "link-tmp")}`]);
    env("21", [`TMPDIR=${real}/x`]);
    assert.deepEqual(processesUsingTmpdir(real, proc)?.sort(), [20, 21]);
    assert.deepEqual(processesUsingTmpdir(path.join(proc, "link-tmp"), proc)?.sort(), [20, 21]);
    assert.equal(processesUsingTmpdir("/r/env/k/tmp", path.join(proc, "missing")), null);
  } finally {
    rmSync(proc, { recursive: true, force: true });
  }
});

const ENV_DIR = `/r/${ENVS_DIR}/${envKeyFor(ENV_ID)}`;
function fakeEnvFs(options: { kinds?: Record<string, EntryKind>; owner?: EnvOwner | null; users?: number[] | null } = {}): { efs: EnvDirFs; removed: string[] } {
  const removed: string[] = [];
  const kinds = options.kinds ?? { [ENV_DIR]: "dir" };
  return {
    removed,
    efs: {
      readdir: () => [],
      kind: (p) => kinds[p] ?? null,
      readOwner: (d) => (d === ENV_DIR && options.owner !== undefined ? options.owner : d === ENV_DIR ? envOwner() : null),
      processesUsingTmpdir: () => (options.users === undefined ? [] : options.users),
      remove: (d) => removed.push(d),
    },
  };
}
function envOwner(o: Partial<EnvOwner> = {}): EnvOwner {
  return {
    envId: ENV_ID, hostname: "h", bootId: "b1", startedAt: 1,
    processes: [{ pid: 100, starttime: "s100", role: "tmux-pane" }, { pid: 101, starttime: "s101", role: "cloudflared" }],
    ...o,
  };
}
/** `live`: pid -> its current starttime (absent: no such process). */
function teardownCtx(o: Partial<EnvTeardownContext> & { live?: Record<number, string> } = {}): EnvTeardownContext {
  const { live = {}, ...rest } = o;
  return { envId: ENV_ID, hostname: "h", bootId: "b1", starttimeOf: (p) => live[p] ?? null, selfPid: 999, sessionAlive: () => false, ...rest };
}

test("stop removes only this environment's dir, once its processes are confirmed gone", () => {
  // All gone: removed, and nothing else.
  const ok = fakeEnvFs();
  assert.deepEqual(removeDevEnvDir(ENV_DIR, teardownCtx(), ok.efs), { removed: true, reason: "removed", liveProcesses: false });
  assert.deepEqual(ok.removed, [ENV_DIR]);
  // This stop's own pid (a janitor-started stop inherits TMPDIR) doesn't block it.
  const self = fakeEnvFs({ owner: envOwner({ processes: [{ pid: 999, starttime: "s999", role: "raftdev-start" }] }), users: [999] });
  assert.equal(removeDevEnvDir(ENV_DIR, teardownCtx({ live: { 999: "s999" } }), self.efs).removed, true);
  // A recorded pid now reused by another process (other starttime) is the old one gone.
  const reused = fakeEnvFs();
  assert.equal(removeDevEnvDir(ENV_DIR, teardownCtx({ live: { 100: "other", 101: "other" } }), reused.efs).removed, true);
  // Recorded on an earlier boot: its pids are not this boot's.
  const reboot = fakeEnvFs();
  assert.equal(removeDevEnvDir(ENV_DIR, teardownCtx({ bootId: "b2", live: { 100: "s100" } }), reboot.efs).removed, true);

  // live: kept because processes are still alive (stop waits and retries only then).
  const kept: Array<[string, ReturnType<typeof fakeEnvFs>, EnvTeardownContext, RegExp, boolean]> = [
    ["session alive", fakeEnvFs(), teardownCtx({ sessionAlive: () => true }), /tmux session still running/, false],
    ["session can't be checked", fakeEnvFs(), teardownCtx({ sessionAlive: () => null }), /could not check the tmux session/, false],
    ["recorded process alive", fakeEnvFs(), teardownCtx({ live: { 101: "s101" } }), /recorded process.*101/, true],
    ["recorded process alive, boot unknown now", fakeEnvFs(), teardownCtx({ bootId: null, live: { 100: "s100" } }), /recorded process.*100/, true],
    ["a process still uses its TMPDIR", fakeEnvFs({ users: [555] }), teardownCtx(), /still using it: 555/, true],
    ["processes can't be checked", fakeEnvFs({ users: null }), teardownCtx(), /could not check/, false],
    ["no owner record", fakeEnvFs({ owner: null }), teardownCtx(), /no valid owner/, false],
    ["another env (key collision)", fakeEnvFs({ owner: envOwner({ envId: "/other" }) }), teardownCtx(), /owned by \/other/, false],
    ["another host", fakeEnvFs({ owner: envOwner({ hostname: "h2" }) }), teardownCtx(), /host h2/, false],
    ["a symlink", fakeEnvFs({ kinds: { [ENV_DIR]: "symlink" } }), teardownCtx(), /symlink/, false],
    ["absent", fakeEnvFs({ kinds: {} }), teardownCtx(), /absent/, false],
  ];
  for (const [label, f, c, reason, live] of kept) {
    const r = removeDevEnvDir(ENV_DIR, c, f.efs);
    assert.equal(r.removed, false, label);
    assert.equal(r.liveProcesses, live, label);
    assert.match(r.reason, reason, label);
    assert.deepEqual(f.removed, [], label);
  }
  // A dir not named like an env key (e.g. the env root itself) is never removed.
  const root = fakeEnvFs({ kinds: { [`/r/${ENVS_DIR}`]: "dir" } });
  assert.equal(removeDevEnvDir(`/r/${ENVS_DIR}`, teardownCtx(), root.efs).removed, false);
  assert.deepEqual(root.removed, []);
});

test("cache status lists the raftdev services TMPDIR", () => {
  const lines: string[] = [];
  const sfs: StatFs = { realpath: (p) => p, statfsType: () => EXT4 };
  runCacheCli(["status"], { out: (l) => lines.push(l), env: { RAFT_DEV_CACHE_DIR: "/r" }, statfs: sfs, pnpm: () => ({ stdout: "/s\n", status: 0 }) });
  assert.match(lines.join("\n"), /raftdev services TMPDIR: +\/r\/env\/<env-key>\/tmp \(raft-dev/);
  const kept: string[] = [];
  runCacheCli(["status"], { out: (l) => kept.push(l), env: { RAFT_DEV_CACHE_DIR: "/r", TMPDIR: "/srv/tmp" }, statfs: sfs, pnpm: () => ({ stdout: "/s\n", status: 0 }) });
  assert.match(kept.join("\n"), /raftdev services TMPDIR: +\/srv\/tmp \(env\)/);
});

test("cache prune sweeps env dirs whose environment is fully gone, and says why it keeps the rest", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "raftdev-cache-prune-env-"));
  try {
    const root = path.join(scratch, "r");
    const envs = path.join(root, ENVS_DIR);
    const proc = path.join(scratch, "proc");
    mkdirSync(proc);
    const dirOf = (envId: string) => path.join(envs, envKeyFor(envId));
    const make = (dir: string, owner: EnvOwner | null) => {
      mkdirSync(path.join(dir, "tmp"), { recursive: true });
      writeFileSync(path.join(dir, "tmp", "f"), "x");
      if (owner) writeFileSync(path.join(dir, ENV_OWNER_FILE), JSON.stringify(owner));
    };
    const env = (id: string, o: Partial<EnvOwner> = {}) => {
      const dir = dirOf(id);
      make(dir, envOwner({ envId: id, processes: [{ pid: 100, starttime: "s100", role: "tmux-pane" }], ...o }));
      return dir;
    };
    const usesTmpdir = (pid: string, tmp: string) => {
      mkdirSync(path.join(proc, pid));
      writeFileSync(path.join(proc, pid, "environ"), `A=1\0TMPDIR=${tmp}\0`);
    };

    const gone = env("/w/gone/.slockdev/a");
    const live = env("/w/live/.slockdev/b", { processes: [{ pid: 101, starttime: "s101", role: "cloudflared" }] });
    const session = env("/w/sess/.slockdev/c");
    const foreign = env("/w/far/.slockdev/d", { hostname: "h2" });
    const used = env("/w/tmp/.slockdev/e");
    usesTmpdir("555", path.join(used, "tmp", "sub"));
    const usedViaLink = env("/w/lnk/.slockdev/f");
    symlinkSync(path.join(usedViaLink, "tmp"), path.join(scratch, "alias"));
    usesTmpdir("556", path.join(scratch, "alias"));
    const noOwner = dirOf("/w/none/.slockdev/g");
    make(noOwner, null);
    // A symlinked entry whose target looks like a fully gone env: neither followed nor removed.
    const outside = path.join(scratch, "outside");
    make(outside, envOwner({ envId: "/w/link/.slockdev/h", processes: [] }));
    const linked = dirOf("/w/link/.slockdev/h");
    symlinkSync(outside, linked);
    const badName = path.join(envs, "not-a-key");
    make(badName, envOwner({ envId: "/w/bad/.slockdev/i", processes: [] }));
    const mismatch = dirOf("/w/mis/.slockdev/j");
    make(mismatch, envOwner({ envId: "/w/other/.slockdev/j" }));
    // Previews run slock-<name> on their own tmux server (-L raft-preview-<id>).
    const previewId = "0123abcd-0000-4000-8000-00000000000a";
    const previewEnvId = path.join(scratch, "wt", ".slockdev", "k");
    mkdirSync(previewEnvId, { recursive: true });
    writeFileSync(path.join(previewEnvId, "preview.json"), JSON.stringify({
      schemaVersion: 1, id: previewId, deadlineAt: "2030-01-01T00:00:00Z", registryDir: "/reg", tmuxSocket: `raft-preview-${previewId}`,
    }));
    const preview = env(previewEnvId);
    const badPreviewEnvId = path.join(scratch, "wt", ".slockdev", "l");
    mkdirSync(badPreviewEnvId, { recursive: true });
    writeFileSync(path.join(badPreviewEnvId, "preview.json"), "{not json");
    const badPreview = env(badPreviewEnvId);
    // A `start` running now: its record (pid + starttime) is written before tmp/.
    const starting = env("/w/start/.slockdev/m", { processes: [{ pid: 102, starttime: "s102", role: "raftdev-start" }] });

    const sessionsAsked: string[] = [];
    const lines: string[] = [];
    const code = runCacheCli(["prune"], {
      out: (l) => lines.push(l),
      env: { RAFT_DEV_CACHE_DIR: root },
      statfs: { realpath: (p) => p, statfsType: () => EXT4 },
      sweepFs: fakeSweepFs({}, {}).sfs,
      pnpm: () => ({ stdout: "", status: 0 }),
      envDirFs: { ...realEnvDirFs, processesUsingTmpdir: (t) => processesUsingTmpdir(t, proc) },
      envCtx: {
        hostname: "h", bootId: "b1",
        starttimeOf: (pid) => (pid === 101 ? "s101" : pid === 102 ? "s102" : null),
      },
      tmux: (session, socket) => {
        sessionsAsked.push(`${socket ?? "default"}/${session}`);
        return socket === null ? session === "slock-c" : socket === `raft-preview-${previewId}` && session === "slock-k";
      },
    });
    assert.equal(code, 0);
    const output = lines.join("\n");
    assert.equal(existsSync(gone), false, output);
    assert.match(output, /Removed 1 environment dir/);
    const kept: Array<[string, RegExp]> = [
      [live, /recorded process\(es\) still alive: 101/],
      [session, /tmux session still running/],
      [foreign, /owned by host h2/],
      [used, /still using it: 555/],
      [usedViaLink, /still using it: 556/],
      [noOwner, /no valid owner record/],
      [linked, /symlink/],
      [badName, /not an environment dir/],
      [mismatch, /owned by \/w\/other/],
      [preview, /tmux session still running/],
      [badPreview, /could not check the tmux session/],
      [starting, /recorded process\(es\) still alive: 102/],
    ];
    for (const [dir, reason] of kept) {
      assert.ok(existsSync(path.join(dir, "tmp", "f")), dir);
      const line = lines.find((l) => l.startsWith(`  kept ${dir}: `));
      assert.ok(line, `${dir} not reported: ${output}`);
      assert.match(line, reason);
    }
    assert.ok(existsSync(path.join(outside, "tmp", "f")));
    assert.ok(sessionsAsked.includes("default/slock-c"));
    assert.ok(sessionsAsked.includes(`raft-preview-${previewId}/slock-k`));
    assert.ok(sessionsAsked.includes("default/slock-a"));
    assert.equal(devEnvSessionName(previewEnvId), "slock-k");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("start writes its owner record before tmp/, and stop/prune keep a dir whose record changed meanwhile", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "raftdev-cache-start-order-"));
  try {
    const sfs: StatFs = { realpath: (p) => p, statfsType: () => EXT4 };
    const resolved = resolveDevEnvDir(ENV_ID, { ...base, env: { RAFT_DEV_CACHE_DIR: scratch }, statfs: sfs, maxTmpdirBytes: Infinity });
    const dir = resolved.dir ?? assert.fail("no env dir");
    // tmp/ can't be created (a file is in the way): the record is already there.
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "tmp"), "");
    assert.equal(prepareDevEnvDir(resolved, { pid: 4242, now: 5, hostname: "h", bootId: "b", warn: () => {}, starttimeOf: (p) => `st${p}` }), false);
    const owner = JSON.parse(readFileSync(path.join(dir, ENV_OWNER_FILE), "utf8")) as EnvOwner;
    assert.equal(owner.startedAt, 5);
    assert.deepEqual(owner.processes, [{ pid: 4242, starttime: "st4242", role: "raftdev-start" }]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  // The record is re-read right before removal: a start rewrote it, so keep.
  let reads = 0;
  const f = fakeEnvFs();
  const efs: EnvDirFs = { ...f.efs, readOwner: () => (reads++ === 0 ? envOwner() : envOwner({ startedAt: 2 })) };
  const r = removeDevEnvDir(ENV_DIR, teardownCtx(), efs);
  assert.equal(r.removed, false);
  assert.match(r.reason, /owner record changed/);
  assert.deepEqual(f.removed, []);
});
