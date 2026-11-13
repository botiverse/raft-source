// Which embedded bundle a SEA process evaluates. Each process evaluates exactly
// one, and V8 keeps that bundle's whole source resident, so the always-running
// `__service` and every `raft-computer <command>` get a bundle without the
// daemon (~2M characters instead of ~25M). Only the hidden entries below reach
// daemon code; seaEntries.test.mjs fails when a new daemon import appears in
// the Computer source without being routed here.

export const SEA_CLI_ENTRY = "__cli";
/** Hidden argv[2] entries that run daemon code: they get the full bundle. */
export const SEA_RUNNER_ENTRIES = ["__run", "__detect-runtimes", "__restore-context-view", "__verify-bundled-oauth", "__verify-bundled-kimi", "__verify-bundled-oar"];

export const SEA_ASSET_FULL = "computer.cjs";
export const SEA_ASSET_LITE = "computer-lite.cjs";
export const SEA_ASSET_CLI = "cli.cjs";

// Large runner dependencies kept out of computer.cjs and compiled from their
// own asset on first use, so a runner whose agents never use them never holds
// their source. The daemon reaches each only through a dynamic import (kimi:
// drivers/kimi-sdk.ts loadKimiSdk()); build.mjs aliases the package to a shim
// (sea-lazy-kimi.cjs) that asks the loader for the asset through this hook.
export const SEA_ASSET_KIMI = "kimi.cjs";
export const SEA_LAZY_ASSETS = { "@botiverse/kimi-code-sdk": SEA_ASSET_KIMI };
// The same for cli.cjs. undici is a third of the agent CLI's source, but a
// managed agent's `raft` call reaches the loopback proxy through Node's
// built-in fetch; the CLI imports undici dynamically (cli/src/proxy.ts) only
// for a direct or proxied server connection. Every `raft` call parses all of
// cli.cjs, so leaving undici in it cost each call ~3 MB.
export const SEA_ASSET_CLI_UNDICI = "cli-undici.cjs";
export const SEA_CLI_LAZY_ASSETS = { undici: SEA_ASSET_CLI_UNDICI };
export const SEA_LAZY_ASSET_HOOK = "raft.sea.loadLazyAsset";

/** Specifiers the lite bundle leaves external: the daemon and the agent CLI. */
export const SEA_LITE_EXTERNAL = ["@botiverse/raft-daemon", "@botiverse/raft-daemon/*", "@botiverse/raft", "@botiverse/raft/*"];
export const SEA_LITE_EXTERNAL_PATTERN = /^@botiverse\/raft(-daemon)?(\/|$)/;

export function seaAssetFor(entry) {
  if (entry === SEA_CLI_ENTRY) return SEA_ASSET_CLI;
  return SEA_RUNNER_ENTRIES.includes(entry) ? SEA_ASSET_FULL : SEA_ASSET_LITE;
}

// V8 code cache for the embedded bundles. Compiling computer.cjs is most of
// a runner's start time, and the bytecode of everything it compiled while
// loading is resident from then on. With a cache V8 deserializes that bytecode
// instead (start ~1.4 s -> ~0.8 s and ~10 MB less on linux-arm64, more on
// macOS). The cache is produced on the user's machine, by the process that
// will consume it: a cache records the V8 version and flags, so one built in
// CI for another platform or flag set would only be rejected. A process
// without a cache (or whose cache V8 rejected) writes one SEA_CODE_CACHE_DELAY_MS
// after evaluating the bundle, so it covers what start-up compiled and not the
// whole bundle (eagerly deserializing all of it would cost memory instead).
// Files live under <Raft home>/computer/code-cache, named by asset, the
// asset's build digest, Node version and arch, so a new build never reads an
// old build's cache (V8 itself only checks the source length). No Raft home in
// the environment means no cache: the loader does not guess one; the service
// passes RAFT_HOME to every runner. Any cache failure falls back to an
// ordinary compile. The agent CLI asset (cli.cjs) exits long before the delay,
// so a `raft` call without a usable cache writes one as the process exits
// instead, covering what that call compiled (raft --help: 0.33-0.37 -> 0.18 s;
// footprint 46 -> 37 MB on macOS, ~1 MB less anonymous RSS on linux-arm64).
export const SEA_CODE_CACHE_DIR = ["computer", "code-cache"];
export const SEA_CODE_CACHE_DELAY_MS = 20_000;
// The bundle body starts on line 2 of the wrapper; lineOffset -1 keeps stack
// trace positions identical to compiling the body alone.
export const SEA_ASSET_WRAPPER_HEAD = "(function (exports, require, module, __filename, __dirname) {\n";
export const SEA_ASSET_WRAPPER_TAIL = "\n})";

export function seaCodeCacheFileName(asset, digest, nodeVersion, arch) {
  return `${asset}-${digest}-${nodeVersion}-${arch}.v8cache`;
}

// The SEA main script. It gets the CommonJS wrapper of a SEA main script
// (builtin-only require, __filename = the executable); dynamic import() keeps
// the main-context default loader. In the lite bundle a daemon import is a
// routing bug, so it fails with what to fix rather than "module not found".
// `assetDigests` maps each asset to its build digest (build.mjs).
export function seaLoaderSource(assetDigests) {
  return `"use strict";
const sea = require("node:sea");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const entry = process.argv[2];
const name = entry === ${JSON.stringify(SEA_CLI_ENTRY)} ? ${JSON.stringify(SEA_ASSET_CLI)}
  : ${JSON.stringify(SEA_RUNNER_ENTRIES)}.includes(entry) ? ${JSON.stringify(SEA_ASSET_FULL)}
  : ${JSON.stringify(SEA_ASSET_LITE)};
const assetDigests = ${JSON.stringify(assetDigests)};
const raftHome = (process.env.RAFT_HOME || "").trim() || (process.env.SLOCK_HOME || "").trim();
const cacheDir = raftHome ? path.join(raftHome, ...${JSON.stringify(SEA_CODE_CACHE_DIR)}) : null;
const fileNameFor = ${seaCodeCacheFileName.toString()};
const writeCodeCache = (script, asset, file) => {
  const tmp = file + "." + process.pid + ".tmp";
  let fd;
  try {
    // User-only, like the rest of the Raft home: whoever can write a cache
    // gets code run inside this process. Opened before serializing, so an
    // unwritable home (e.g. a sandboxed agent's raft call) costs no V8 work.
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    fd = fs.openSync(tmp, "w", 0o600);
    fs.writeFileSync(fd, script.createCachedData());
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
    // Earlier builds' caches for this asset are never read again.
    for (const old of fs.readdirSync(cacheDir)) {
      if (old.startsWith(asset + "-") && path.join(cacheDir, old) !== file && !old.endsWith(".tmp")) fs.rmSync(path.join(cacheDir, old), { force: true });
    }
  } catch {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
};
const compileAsset = (asset) => {
  const source = ${JSON.stringify(SEA_ASSET_WRAPPER_HEAD)} + sea.getAsset(asset, "utf8") + ${JSON.stringify(SEA_ASSET_WRAPPER_TAIL)};
  const file = cacheDir && assetDigests[asset] ? path.join(cacheDir, fileNameFor(asset, assetDigests[asset], process.version, process.arch)) : null;
  let cachedData;
  if (file) {
    try { cachedData = fs.readFileSync(file); } catch {}
  }
  const script = new vm.Script(source, {
    filename: asset,
    lineOffset: -1,
    cachedData,
    importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  });
  if (file && (cachedData === undefined || script.cachedDataRejected)) {
    if (asset === ${JSON.stringify(SEA_ASSET_CLI)}) process.once("exit", () => writeCodeCache(script, asset, file));
    else setTimeout(() => writeCodeCache(script, asset, file), ${SEA_CODE_CACHE_DELAY_MS}).unref();
  }
  return script.runInThisContext();
};
const evaluateAsset = (asset, assetRequire) => {
  const run = compileAsset(asset);
  const loaded = { exports: {} };
  run.call(loaded.exports, loaded.exports, assetRequire, loaded, process.execPath, path.dirname(process.execPath));
  return loaded.exports;
};
const liteExternal = ${SEA_LITE_EXTERNAL_PATTERN.toString()};
const bundleRequire = name !== ${JSON.stringify(SEA_ASSET_LITE)} ? require : (id) => {
  if (liteExternal.test(id)) {
    throw new Error("raft-computer: entry " + JSON.stringify(entry) + " reached daemon code (" + id + ") but runs ${SEA_ASSET_LITE}; add it to SEA_RUNNER_ENTRIES in packages/computer/scripts/native/seaEntries.mjs");
  }
  return require(id);
};
const lazyAssets = name === ${JSON.stringify(SEA_ASSET_FULL)} ? ${JSON.stringify(SEA_LAZY_ASSETS)}
  : name === ${JSON.stringify(SEA_ASSET_CLI)} ? ${JSON.stringify(SEA_CLI_LAZY_ASSETS)}
  : null;
if (lazyAssets) {
  const lazyLoaded = new Map();
  globalThis[Symbol.for(${JSON.stringify(SEA_LAZY_ASSET_HOOK)})] = (id) => {
    if (!Object.prototype.hasOwnProperty.call(lazyAssets, id)) throw new Error("raft-computer: no lazy SEA asset for " + id);
    if (!lazyLoaded.has(id)) lazyLoaded.set(id, evaluateAsset(lazyAssets[id], require));
    return lazyLoaded.get(id);
  };
}
evaluateAsset(name, bundleRequire);
`;
}
