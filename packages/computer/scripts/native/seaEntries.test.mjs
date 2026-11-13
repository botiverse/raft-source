import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { afterEach, test, vi } from "vitest";

import {
  SEA_ASSET_CLI,
  SEA_ASSET_CLI_UNDICI,
  SEA_ASSET_FULL,
  SEA_ASSET_KIMI,
  SEA_ASSET_LITE,
  SEA_CLI_ENTRY,
  SEA_CODE_CACHE_DELAY_MS,
  SEA_CODE_CACHE_DIR,
  SEA_LAZY_ASSET_HOOK,
  SEA_LITE_EXTERNAL_PATTERN,
  SEA_RUNNER_ENTRIES,
  seaAssetFor,
  seaCodeCacheFileName,
  seaLoaderSource,
} from "./seaEntries.mjs";

const DIGESTS = {
  [SEA_ASSET_FULL]: "fulldigest",
  [SEA_ASSET_LITE]: "litedigest",
  [SEA_ASSET_KIMI]: "kimidigest",
  [SEA_ASSET_CLI]: "clidigest",
  [SEA_ASSET_CLI_UNDICI]: "undicidigest",
};

// Runs the generated loader with `node:sea` serving `assets` and the real
// node:vm/node:fs/node:path, under the given argv entry and environment.
function runLoader({ entry, assets, env = {}, onGetAsset = () => {} }) {
  const loaderRequire = (id) => {
    if (id === "node:sea") return { getAsset: (name) => (onGetAsset(name), assets[name]) };
    return { "node:vm": vm, "node:fs": require("node:fs"), "node:path": require("node:path") }[id] ?? {};
  };
  const saved = { argv: process.argv, RAFT_HOME: process.env.RAFT_HOME, SLOCK_HOME: process.env.SLOCK_HOME };
  process.argv = ["node", "raft-computer", ...(entry === undefined ? [] : [entry])];
  delete process.env.RAFT_HOME;
  delete process.env.SLOCK_HOME;
  Object.assign(process.env, env);
  try {
    new Function("require", seaLoaderSource(DIGESTS))(loaderRequire);
  } finally {
    process.argv = saved.argv;
    for (const key of ["RAFT_HOME", "SLOCK_HOME"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}
const require = (await import("node:module")).createRequire(import.meta.url);

const SRC = fileURLToPath(new URL("../../src", import.meta.url));

// Every runtime import of daemon / agent-CLI code in the Computer source, and
// the hidden argv entries that reach it. A new import fails this test until it
// is listed here, and its entry must be routed to a bundle that contains the
// daemon (SEA_RUNNER_ENTRIES, or the agent CLI's own bundle).
const DAEMON_IMPORT_SITES = {
  "cli.ts @botiverse/raft-daemon/bundled-cli": "__cli",
  "cli.ts @botiverse/raft-daemon/core": ["__verify-bundled-oauth", "__verify-bundled-kimi", "__verify-bundled-oar"],
  "index.ts @botiverse/raft-daemon/bundled-cli": "__cli",
  "runtimeDetectionEntry.ts @botiverse/raft-daemon/runtime-detection-child": "__detect-runtimes",
  "runtimeDetectionEntry.ts @botiverse/raft-daemon/context-view-restore-child": "__restore-context-view",
  "seaCliEntry.ts @botiverse/raft-daemon/bundled-cli": "__cli",
  // runResident → defaultCoreFactory, reached only through the `__run` command.
  "service.ts @botiverse/raft-daemon/core": "__run",
};

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "test" || entry.name === "fixtures" ? [] : sourceFiles(path);
    return entry.name.endsWith(".ts") && !/\.(test|typeproof)\.ts$/.test(entry.name) ? [path] : [];
  });
}

function runtimeDaemonImports() {
  const found = new Set();
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    const name = relative(SRC, file).replaceAll("\\", "/");
    // Dynamic imports, and static imports that are not `import type`.
    const patterns = [
      /import\(\s*["']([^"']+)["']\s*\)/g,
      /^\s*import\s+(?!type\b)[^;]*?\s+from\s+["']([^"']+)["']/gm,
      /^\s*import\s+["']([^"']+)["']/gm,
    ];
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        if (SEA_LITE_EXTERNAL_PATTERN.test(match[1])) found.add(`${name} ${match[1]}`);
      }
    }
  }
  return [...found].sort();
}

test("every daemon import in the Computer source is listed with the entry that reaches it", () => {
  assert.deepEqual(
    runtimeDaemonImports(),
    Object.keys(DAEMON_IMPORT_SITES).sort(),
    "a daemon import was added or removed: list it in DAEMON_IMPORT_SITES with the hidden entry that reaches it, " +
      "and make sure that entry is in SEA_RUNNER_ENTRIES (seaEntries.mjs)",
  );
});

test("each of those entries is routed to a bundle that contains the daemon", () => {
  for (const [site, entries] of Object.entries(DAEMON_IMPORT_SITES)) {
    for (const entry of [entries].flat()) {
      assert.notEqual(seaAssetFor(entry), SEA_ASSET_LITE, `${site} is reached by ${entry}, which would run the lite bundle`);
    }
  }
  // And each listed entry really is a hidden entry of the Computer source.
  const sources = sourceFiles(SRC).map((file) => readFileSync(file, "utf8")).join("\n");
  for (const entry of new Set(Object.values(DAEMON_IMPORT_SITES).flat())) {
    assert.ok(sources.includes(`"${entry}"`), `${entry} is not an argv entry in the Computer source`);
  }
});

test("routing: runner entries get the full bundle, __cli the CLI, everything else the lite bundle", () => {
  for (const entry of SEA_RUNNER_ENTRIES) assert.equal(seaAssetFor(entry), SEA_ASSET_FULL);
  assert.equal(seaAssetFor(SEA_CLI_ENTRY), SEA_ASSET_CLI);
  for (const entry of ["__service", "status", "doctor", "--version", undefined]) assert.equal(seaAssetFor(entry), SEA_ASSET_LITE);
});

test("the generated loader routes the same way and names the fix for a stray daemon import", () => {
  const evaluate = (entry, bundleSource) => {
    let chosen = null;
    const assets = { [SEA_ASSET_FULL]: "", [SEA_ASSET_LITE]: bundleSource, [SEA_ASSET_CLI]: "" };
    runLoader({ entry, assets, onGetAsset: (name) => (chosen = name) });
    return chosen;
  };
  assert.equal(evaluate("__run", ""), SEA_ASSET_FULL);
  assert.equal(evaluate("__cli", ""), SEA_ASSET_CLI);
  assert.equal(evaluate("status", ""), SEA_ASSET_LITE);
  assert.throws(
    () => evaluate("status", 'require("@botiverse/raft-daemon/core");'),
    /entry "status" reached daemon code \(@botiverse\/raft-daemon\/core\) but runs computer-lite\.cjs; add it to SEA_RUNNER_ENTRIES/,
  );
});

test("the full bundle gets a hook that compiles each lazy asset once, on first use", () => {
  const compiled = [];
  const assets = {
    [SEA_ASSET_FULL]: "",
    [SEA_ASSET_KIMI]: "module.exports = { createKimiHarness() {}, loadedAt: Symbol('once') };",
  };
  const hook = Symbol.for(SEA_LAZY_ASSET_HOOK);
  try {
    delete globalThis[hook];
    runLoader({ entry: "__run", assets, onGetAsset: (name) => compiled.push(name) });
    const first = globalThis[hook]("@botiverse/kimi-code-sdk");
    const second = globalThis[hook]("@botiverse/kimi-code-sdk");
    assert.equal(typeof first.createKimiHarness, "function");
    assert.equal(first, second, "compiled once and cached");
    assert.deepEqual(compiled, [SEA_ASSET_FULL, SEA_ASSET_KIMI]);
    assert.throws(() => globalThis[hook]("left-pad"), /no lazy SEA asset for left-pad/);
  } finally {
    delete globalThis[hook];
  }
});

test("the CLI bundle gets the hook for its own lazy assets, and the lite bundle gets none", () => {
  const compiled = [];
  const assets = {
    [SEA_ASSET_CLI]: "",
    [SEA_ASSET_LITE]: "",
    [SEA_ASSET_CLI_UNDICI]: "module.exports = { fetch() {}, loadedAt: Symbol('once') };",
  };
  const hook = Symbol.for(SEA_LAZY_ASSET_HOOK);
  try {
    delete globalThis[hook];
    runLoader({ entry: SEA_CLI_ENTRY, assets, onGetAsset: (name) => compiled.push(name) });
    assert.deepEqual(compiled, [SEA_ASSET_CLI], "undici is not compiled until asked for");
    const first = globalThis[hook]("undici");
    assert.equal(typeof first.fetch, "function");
    assert.equal(globalThis[hook]("undici"), first, "compiled once and cached");
    assert.deepEqual(compiled, [SEA_ASSET_CLI, SEA_ASSET_CLI_UNDICI]);
    assert.throws(() => globalThis[hook]("@botiverse/kimi-code-sdk"), /no lazy SEA asset for @botiverse\/kimi-code-sdk/);
    delete globalThis[hook];
    runLoader({ entry: "status", assets });
    assert.equal(globalThis[hook], undefined);
  } finally {
    delete globalThis[hook];
  }
});

test("stack trace positions in an asset are the same as compiling the asset alone", () => {
  const body = 'module.exports = function boom() { throw new Error("x"); };';
  const assets = { [SEA_ASSET_LITE]: `${body}\nglobalThis.__seaTestBoom = module.exports;` };
  try {
    runLoader({ entry: "status", assets });
    const stack = (() => { try { globalThis.__seaTestBoom(); } catch (e) { return e.stack; } })();
    const column = body.indexOf("new Error") + 1;
    assert.match(stack, new RegExp(`${SEA_ASSET_LITE.replace(".", "\\.")}:1:${column}\\)`));
  } finally {
    delete globalThis.__seaTestBoom;
  }
});

// V8 skips cached data for a source this isolate already compiled, so every
// start that must read (or reject) a cache runs in its own process, the way
// a real SEA start does. The child reports whether V8 rejected the cache.
const CACHE_ASSET = "module.exports = { add: (a, b) => a + b }; module.exports.add(1, 2);";
function startInChild(env, { delayElapses = true, entry = "status", asset = SEA_ASSET_LITE } = {}) {
  const child = `
    const vm = require("node:vm");
    const realScript = vm.Script;
    let rejected = null;
    vm.Script = class extends realScript {
      constructor(source, options) { super(source, options); if (options.cachedData) rejected = this.cachedDataRejected; }
    };
    const assets = { ${JSON.stringify(asset)}: ${JSON.stringify(CACHE_ASSET)} };
    const loaderRequire = (id) => id === "node:sea" ? { getAsset: (name) => assets[name] } : require(id);
    process.argv = [process.argv[0], "raft-computer", ${JSON.stringify(entry)}];
    const realSetTimeout = setTimeout;
    let scheduled = 0;
    globalThis.setTimeout = (fn, ms) => { scheduled += 1; if (${delayElapses}) fn(); return { unref() {} }; };
    new Function("require", ${JSON.stringify(seaLoaderSource(DIGESTS))})(loaderRequire);
    process.stdout.write(JSON.stringify({ rejected, scheduled }));
  `;
  const result = spawnSync(process.execPath, ["-e", child], {
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
const cacheFile = (home, asset = SEA_ASSET_LITE) =>
  join(home, ...SEA_CODE_CACHE_DIR, seaCodeCacheFileName(asset, DIGESTS[asset], process.version, process.arch));
const tempHomes = [];
const tempHome = () => {
  const home = mkdtempSync(join(tmpdir(), "sea-code-cache-"));
  tempHomes.push(home);
  return home;
};
afterEach(() => {
  vi.useRealTimers();
  for (const home of tempHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});

test("code cache: written only after the delay, under the Raft home", () => {
  vi.useFakeTimers();
  const home = tempHome();
  runLoader({ entry: "status", assets: { [SEA_ASSET_LITE]: CACHE_ASSET }, env: { RAFT_HOME: home } });
  vi.advanceTimersByTime(SEA_CODE_CACHE_DELAY_MS - 1);
  assert.equal(existsSync(cacheFile(home)), false, "not before the delay");
  vi.advanceTimersByTime(1);
  assert.ok(readFileSync(cacheFile(home)).length > 0);
});

test("code cache: the next start reads it, V8 accepts it, and nothing is rewritten", () => {
  const home = tempHome();
  assert.deepEqual(startInChild({ RAFT_HOME: home }), { rejected: null, scheduled: 1 });
  const written = readFileSync(cacheFile(home));
  assert.deepEqual(startInChild({ RAFT_HOME: home }), { rejected: false, scheduled: 0 });
  assert.deepEqual(readFileSync(cacheFile(home)), written);
});

test("code cache: directory and file are user-only", { skip: process.platform === "win32" }, () => {
  const home = tempHome();
  startInChild({ RAFT_HOME: home });
  assert.equal(statSync(join(home, ...SEA_CODE_CACHE_DIR)).mode & 0o777, 0o700);
  assert.equal(statSync(cacheFile(home)).mode & 0o777, 0o600);
});

test("code cache: legacy SLOCK_HOME works; no Raft home in the environment means no cache", () => {
  const home = tempHome();
  startInChild({ SLOCK_HOME: home });
  assert.ok(existsSync(cacheFile(home)));
  assert.deepEqual(startInChild({}), { rejected: null, scheduled: 0 });
});

test("code cache: a rejected cache is rewritten and older builds' caches are removed", () => {
  const home = tempHome();
  const dir = join(home, ...SEA_CODE_CACHE_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(cacheFile(home), "not a v8 code cache");
  const stale = join(dir, seaCodeCacheFileName(SEA_ASSET_LITE, "olddigest", process.version, process.arch));
  const otherAsset = join(dir, seaCodeCacheFileName(SEA_ASSET_FULL, "olddigest", process.version, process.arch));
  writeFileSync(stale, "old");
  writeFileSync(otherAsset, "old");

  assert.deepEqual(startInChild({ RAFT_HOME: home }), { rejected: true, scheduled: 1 });
  assert.notEqual(readFileSync(cacheFile(home), "utf8"), "not a v8 code cache");
  assert.equal(existsSync(stale), false, "the same asset's cache from another build is removed");
  assert.ok(existsSync(otherAsset), "other assets' caches are left alone");
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
  assert.deepEqual(startInChild({ RAFT_HOME: home }), { rejected: false, scheduled: 0 });
});

test("code cache: the agent CLI asset writes one as the process exits, not on a timer", () => {
  vi.useFakeTimers();
  const home = tempHome();
  const exitListeners = process.listenerCount("exit");
  try {
    runLoader({ entry: SEA_CLI_ENTRY, assets: { [SEA_ASSET_CLI]: CACHE_ASSET }, env: { RAFT_HOME: home } });
    assert.equal(vi.getTimerCount(), 0);
    assert.equal(process.listenerCount("exit"), exitListeners + 1);
  } finally {
    for (const listener of process.listeners("exit").slice(exitListeners)) process.removeListener("exit", listener);
  }
  assert.equal(existsSync(cacheFile(home, SEA_ASSET_CLI)), false, "nothing written while running");
});

test("code cache: a raft call's cache is read and accepted by the next call, which writes nothing", () => {
  const home = tempHome();
  const cli = { entry: SEA_CLI_ENTRY, asset: SEA_ASSET_CLI };
  assert.deepEqual(startInChild({ RAFT_HOME: home }, cli), { rejected: null, scheduled: 0 });
  const written = readFileSync(cacheFile(home, SEA_ASSET_CLI));
  assert.ok(written.length > 0);
  assert.deepEqual(startInChild({ RAFT_HOME: home }, cli), { rejected: false, scheduled: 0 });
  assert.deepEqual(readFileSync(cacheFile(home, SEA_ASSET_CLI)), written);
  assert.deepEqual(readdirSync(join(home, ...SEA_CODE_CACHE_DIR)).filter((f) => f.endsWith(".tmp")), []);
});

test("code cache: a raft call whose Raft home cannot hold a cache still exits cleanly", () => {
  const home = tempHome();
  writeFileSync(join(home, SEA_CODE_CACHE_DIR[0]), "a file where the directory should be");
  assert.deepEqual(startInChild({ RAFT_HOME: home }, { entry: SEA_CLI_ENTRY, asset: SEA_ASSET_CLI }), { rejected: null, scheduled: 0 });
});

test("code cache: a cache directory that cannot be written leaves the start unaffected", () => {
  const home = tempHome();
  writeFileSync(join(home, SEA_CODE_CACHE_DIR[0]), "a file where the directory should be");
  assert.deepEqual(startInChild({ RAFT_HOME: home }), { rejected: null, scheduled: 1 });
});
