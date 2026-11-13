#!/usr/bin/env node
// Build a single-executable (SEA) `raft-computer` binary for ONE target.
//
// The CI release matrix calls this once per (platform, arch). Each step is a
// named function so a failing build is easy to localize from the CI log.
//
// Pipeline (mirrors Node's official SEA docs + kimi-code's native build):
//   1. download  — fetch the OFFICIAL node binary for the target from
//                  nodejs.org/dist. MUST be official, not homebrew: a
//                  homebrew node is a ~68KB libnode thin-wrapper without the
//                  SEA fuse, so postject fails with "Could not find sentinel".
//   2. bundle    — esbuild src/index.ts → ONE CommonJS file with EVERYTHING
//                  inlined (`bundle: true`, no externals). A SEA binary has no
//                  node_modules, so even @botiverse/raft-daemon must be inlined. The
//                  versions are baked via otherwise-absent `define`
//                  identifiers, with no runtime environment override path.
//   3. blob      — `node --experimental-sea-config` turns the bundle into a
//                  SEA blob. Generated with the HOST node; the blob is
//                  arch-independent but tied to the node MAJOR, so the host
//                  node major MUST equal --node-version's major (asserted).
//   4. inject    — copy the official node → output binary, then postject the
//                  blob into it (macho segment on darwin). On darwin the node
//                  signature is removed before inject and re-applied after.
//   5. sign      — darwin only: ad-hoc `codesign --sign -` so the matrix can
//                  smoke-run the injected arm64 carrier. The formal tag
//                  workflow treats this as an intermediate, replaces it with
//                  a hardened-runtime Developer ID signature, notarizes the
//                  exact final bytes, then regenerates all transport hashes.
//   6. emit      — write `<out>/raft-computer-<platform>-<arch>[.exe]` plus a
//                  `.sha256` sidecar for the manifest + install.sh to verify.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, readFileSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { createGzip } from "node:zlib";

import { assertBuildOutputFresh } from "./dependency-freshness.mjs";
import {
  SEA_ASSET_CLI,
  SEA_ASSET_CLI_UNDICI,
  SEA_ASSET_FULL,
  SEA_ASSET_KIMI,
  SEA_ASSET_LITE,
  SEA_CLI_LAZY_ASSETS,
  SEA_LAZY_ASSETS,
  SEA_LITE_EXTERNAL,
  seaLoaderSource,
} from "./seaEntries.mjs";
import {
  assertLatin1Source,
  countNonLatin1,
  escapeNonLatin1,
  insideRanges,
  regexLiteralRanges,
} from "./latin1Source.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPUTER_ROOT = resolve(HERE, "..", "..");
const DAEMON_ROOT = resolve(COMPUTER_ROOT, "..", "daemon");
const CLI_ROOT = resolve(COMPUTER_ROOT, "..", "cli");
const REPO_ROOT = resolve(COMPUTER_ROOT, "..", "..");
const PHOTON_WASM_FILENAME = "photon_rs_bg.wasm";

// Resolve the postject CLI from @botiverse/raft-computer's OWN node_modules (it's a
// pinned devDep). Invoking `npx postject` from the repo root would miss the
// package-local install and fetch an arbitrary version from npm — we want the
// exact pinned one, offline.
function resolvePostjectCli() {
  const require = createRequire(pathToFileURL(join(COMPUTER_ROOT, "package.json")));
  const pkgJsonPath = require.resolve("postject/package.json");
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin.postject;
  return join(dirname(pkgJsonPath), binRel);
}

// Sentinel fuse string from Node's SEA docs — postject looks for this byte
// sequence in the node binary to know where to write the blob. Do not change /
// truncate: it must be the FULL fuse (verified against `strings node` →
// `NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2:0`). A truncated value makes
// postject fail with "Could not find the sentinel … in the binary".
const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited with ${r.status ?? r.signal}`);
  }
  return r;
}

function tryRun(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) {
    console.warn(`[inject] optional command unavailable or failed: ${cmd} ${args.join(" ")}`);
  }
  return r;
}

function hostTarCommand() {
  if (process.platform !== "win32") return "tar";

  // GitHub's Windows build step runs under Git Bash, whose PATH resolves
  // `tar` to Git's GNU tar. GNU tar treats native `C:\\...` archive paths as
  // remote-host syntax (`C:`), so extraction fails before the SEA build can
  // start. Invoke Windows' bundled bsdtar by absolute path instead; spawning
  // it directly from Node preserves native paths without MSYS argument
  // rewriting and bsdtar supports the official Node .zip archive.
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!windowsRoot) {
    throw new Error("SystemRoot/WINDIR is required to locate Windows bsdtar");
  }
  const systemTar = join(windowsRoot, "System32", "tar.exe");
  if (!existsSync(systemTar)) {
    throw new Error(`Windows bsdtar not found at ${systemTar}`);
  }
  return systemTar;
}

// nodejs.org/dist names: darwin/linux use .tar.gz (binary at
// node-v<V>-<platform>-<arch>/bin/node); win32 uses .zip (node.exe at root).
function nodeDistMeta(platform, arch, nodeVersion) {
  // Node's runtime platform is `win32`, but its official distribution
  // archives use `win` (for example node-v24.15.0-win-x64.zip).
  const distPlatform = platform === "win32" ? "win" : platform;
  const base = `node-v${nodeVersion}-${distPlatform}-${arch}`;
  if (platform === "win32") {
    return {
      url: `https://nodejs.org/dist/v${nodeVersion}/${base}.zip`,
      archive: `${base}.zip`,
      innerBinary: join(base, "node.exe"),
      isZip: true,
    };
  }
  return {
    url: `https://nodejs.org/dist/v${nodeVersion}/${base}.tar.gz`,
    archive: `${base}.tar.gz`,
    innerBinary: join(base, "bin", "node"),
    isZip: false,
  };
}

async function downloadOfficialNode({ platform, arch, nodeVersion, workDir }) {
  const meta = nodeDistMeta(platform, arch, nodeVersion);
  const archivePath = join(workDir, meta.archive);
  const extractedBinary = join(workDir, meta.innerBinary);

  if (existsSync(extractedBinary)) {
    console.log(`[download] cached ${extractedBinary}`);
    return extractedBinary;
  }

  if (!existsSync(archivePath)) {
    console.log(`[download] ${meta.url}`);
    const res = await fetch(meta.url);
    if (!res.ok) throw new Error(`download failed ${res.status} for ${meta.url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(archivePath, buf);
  }

  console.log(`[download] extracting ${meta.archive}`);
  // bsdtar auto-detects zip, so use it for both archive kinds. On Windows,
  // hostTarCommand deliberately bypasses Git Bash's GNU tar and invokes the
  // system bsdtar by absolute path.
  const tarCommand = hostTarCommand();
  if (meta.isZip) {
    run(tarCommand, ["-xf", archivePath, "-C", workDir]);
  } else {
    run(tarCommand, ["-xzf", archivePath, "-C", workDir]);
  }
  if (!existsSync(extractedBinary)) {
    throw new Error(`extracted node binary not found at ${extractedBinary}`);
  }
  return extractedBinary;
}

// The agent CLI as its own CJS bundle (task #11). Same define/banner contract
// as bundleCjs; the SEA loader evaluates it alone for `__cli`, so an agent
// `raft` call skips the 38 MB Computer bundle (~550 → ~150 MiB per call).
// The CLI is first built by tsdown with its own config, as its dist is (tsdown
// drops far more unused zod than esbuild does), but with undici left external:
// esbuild then points undici at the shim that loads cli-undici.cjs on first use
// (seaEntries.mjs SEA_CLI_LAZY_ASSETS). The CLI dist itself keeps undici
// inlined for the npm package and the desktop sidecar.
async function bundleSeaCliCjs({ cliVersion, workDir }) {
  const { build: tsdown } = await import("tsdown");
  const { build } = await import("esbuild");
  const cliDir = join(workDir, "cli-sea-dist");
  const cliPkg = JSON.parse(await readFile(join(CLI_ROOT, "package.json"), "utf8"));
  const lazy = new Set(Object.keys(SEA_CLI_LAZY_ASSETS));
  const subpaths = (name) => new RegExp(`^${name.replace(/[^a-zA-Z0-9]/g, "\\$&")}(\\/|$)`);
  await tsdown({
    config: join(CLI_ROOT, "tsdown.config.ts"),
    cwd: CLI_ROOT,
    outDir: cliDir,
    clean: true,
    deps: {
      alwaysBundle: Object.keys(cliPkg.dependencies).filter((name) => !lazy.has(name)).map(subpaths),
      neverBundle: [...lazy].map(subpaths),
    },
    logLevel: "warn",
  });
  const outfile = join(workDir, "cli-bundle.cjs");
  const result = await build({
    entryPoints: [join(COMPUTER_ROOT, "src", "seaCliEntry.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile,
    metafile: true,
    define: {
      __RAFT_CLI_VERSION__: JSON.stringify(cliVersion),
      "import.meta.url": "__slockImportMetaUrl",
    },
    banner: {
      js: `const __slockImportMetaUrl = require("node:url").pathToFileURL(process.execPath).href;`,
    },
    alias: {
      "@botiverse/raft-daemon/bundled-cli": SEA_SOURCE_ALIASES["@botiverse/raft-daemon/bundled-cli"],
      "@botiverse/raft/dist/index.js": join(cliDir, "index.js"),
      ...SEA_CLI_LAZY_ASSET_SHIMS,
    },
    // See finalizeSeaBundleSource: no comments or layout whitespace in the
    // resident source.
    minifyWhitespace: true,
    logLevel: "info",
  });
  const inlined = bundledInputs(result).filter((input) =>
    [...lazy].some((name) => `/${input}`.includes(`/node_modules/${name}/`)) || /^packages\/[^/]+\/dist\//.test(input),
  );
  if (inlined.length > 0) {
    throw new Error(`Agent CLI SEA bundle inlined ${inlined[0]}; lazy packages load from their own asset (SEA_CLI_LAZY_ASSETS) and the CLI from the tsdown build above`);
  }
  assertLazyShimsDynamicOnly(result, SEA_CLI_LAZY_ASSET_SHIMS, "every agent `raft` call");
  await finalizeSeaBundleSource(outfile, SEA_ASSET_CLI);
  return outfile;
}

// undici on its own (asset cli-undici.cjs), evaluated by the SEA loader the
// first time a `raft` call opens a direct or proxied server connection. Built
// from the CLI's own undici so it is the version the CLI was tested with.
async function bundleCliUndiciCjs({ workDir }) {
  const { build } = await import("esbuild");
  const outfile = join(workDir, "cli-undici-bundle.cjs");
  const specifier = Object.keys(SEA_CLI_LAZY_ASSETS).find((id) => SEA_CLI_LAZY_ASSETS[id] === SEA_ASSET_CLI_UNDICI);
  await build({
    stdin: { contents: `module.exports = require(${JSON.stringify(specifier)});`, resolveDir: CLI_ROOT, sourcefile: "cli-undici-entry.cjs" },
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile,
    minifyWhitespace: true,
    logLevel: "info",
  });
  const check = spawnSync(
    process.execPath,
    [
      "-e",
      `const bundled = Object.keys(require(${JSON.stringify(outfile)})).sort();
       const pkg = Object.keys(require(${JSON.stringify(specifier)})).sort();
       if (JSON.stringify(bundled) !== JSON.stringify(pkg)) { console.error(JSON.stringify({ bundled, pkg })); process.exit(1); }`,
    ],
    { cwd: CLI_ROOT, encoding: "utf8" },
  );
  if (check.status !== 0) {
    throw new Error(`${SEA_ASSET_CLI_UNDICI} does not expose undici's exports: ${check.stderr.slice(0, 2000)}`);
  }
  await finalizeSeaBundleSource(outfile, SEA_ASSET_CLI_UNDICI);
  return outfile;
}

// Every SEA bundle stays resident as one V8 source string. Make it Latin-1 so
// V8 stores it one byte per character (latin1Source.mjs), and fail the build
// if anything above U+00FF is left. The compile check runs the escaped source
// through the same wrapper the SEA loader uses, so a bad rewrite fails here.
async function finalizeSeaBundleSource(outfile, label) {
  const original = await readFile(outfile, "utf8");
  // Locating regex literals takes a full parse (~30 s, ~1 GB on a small arm64
  // host), so only when there is something to rewrite.
  const mayRewrite =
    countNonLatin1(original) === 0
      ? () => false
      : insideRanges(regexLiteralRanges(original, createRequire(join(COMPUTER_ROOT, "package.json"))("typescript")));
  const { source, escaped } = escapeNonLatin1(original, label, mayRewrite);
  assertLatin1Source(source, label);
  vm.compileFunction(source, ["exports", "require", "module", "__filename", "__dirname"], { filename: label });
  if (escaped > 0) await writeFile(outfile, source);
  console.log(`[build] ${label}: ${source.length} chars, Latin-1 (${escaped} escaped)`);
}

// The loader names each asset's code cache by the asset's digest, so a cache
// written by one build is never read by another.
async function writeSeaLoader({ workDir, assets }) {
  const loaderPath = join(workDir, "sea-loader.cjs");
  const digests = {};
  for (const [asset, file] of Object.entries(assets)) digests[asset] = (await sha256(file)).slice(0, 16);
  await writeFile(loaderPath, seaLoaderSource(digests));
  return loaderPath;
}

// The Computer bundle inlines the daemon and the agent CLI from their sources,
// not from their tsdown dists. Each dist stays self-contained for native Node
// (it inlines raft-shared, raft-trace-client and, for the CLI, zod, undici,
// ajv and commander), so bundling a dist here embedded a second copy of code
// the Computer already imports from source, and V8 keeps the whole script
// source on the heap. Every daemon/CLI specifier the Computer graph imports
// needs an entry; bundleCjs fails if a dist still gets bundled.
const SEA_SOURCE_ALIASES = {
  "@botiverse/raft-daemon/core": join(DAEMON_ROOT, "src", "core.ts"),
  "@botiverse/raft-daemon/bundled-cli": join(DAEMON_ROOT, "src", "bundledRaftCli.ts"),
  "@botiverse/raft-daemon/runtime-detection-child": join(DAEMON_ROOT, "src", "runtimeDetectionChild.ts"),
  "@botiverse/raft-daemon/context-view-restore-child": join(DAEMON_ROOT, "src", "agentContextView", "contextViewRestoreChild.ts"),
  "@botiverse/raft/dist/index.js": join(CLI_ROOT, "src", "index.ts"),
};

// Modules no runner path reaches, replaced by an empty module so their source
// is not resident. highlight.js/lib/index.js (all ~190 grammars, 1.3M chars)
// is only imported by pi's interactive terminal UI (loadAllHighlightLanguages),
// which the daemon never runs; pi treats a failed or empty load as "eager
// languages only".
const SEA_UNREACHABLE_ALIASES = {
  "highlight.js/lib/index.js": join(HERE, "sea-empty-module.cjs"),
  // #oar-raft:#10: a SEA never advertises Cursor on OAR (no node_modules for
  // the SDK's native binaries, and OAR cannot start its child from a SEA). The
  // daemon never imports the SDK (OAR's child does, from a resolved file URL);
  // this keeps a future import from pulling it into the bundle.
  "@cursor/sdk": join(HERE, "sea-empty-module.cjs"),
};

// Each lazily loaded package (seaEntries.mjs SEA_LAZY_ASSETS) is replaced in
// computer.cjs by a shim that fetches it from its own asset on first use. A
// plain `external` would not do: esbuild keeps an external dynamic import as a
// real `import()`, which the SEA resolves through Node's ESM loader, and that
// cannot find a bare package name in a single binary.
const SEA_LAZY_ASSET_SHIMS = {
  "@botiverse/kimi-code-sdk": join(HERE, "sea-lazy-kimi.cjs"),
};
// The same for cli.cjs (seaEntries.mjs SEA_CLI_LAZY_ASSETS).
const SEA_CLI_LAZY_ASSET_SHIMS = {
  undici: join(HERE, "sea-lazy-undici.cjs"),
};

// The alias catches every import of a lazy package, so a static one would
// quietly require the shim at startup and load the asset in every process of
// that bundle. Only dynamic imports may reach a shim.
function assertLazyShimsDynamicOnly(result, shims, where) {
  const shimPaths = new Set(Object.values(shims).map((shim) => relative(REPO_ROOT, shim).replaceAll("\\", "/")));
  const eagerShimImports = Object.entries(result.metafile.inputs).flatMap(([importer, input]) =>
    input.imports
      .filter((record) => shimPaths.has(relative(REPO_ROOT, resolve(record.path)).replaceAll("\\", "/")) && record.kind !== "dynamic-import")
      .map((record) => `${importer} (${record.kind} of ${record.original ?? record.path})`),
  );
  if (eagerShimImports.length > 0) {
    throw new Error(
      `a lazily loaded SEA package is imported eagerly, which would load its asset in ${where}: ${eagerShimImports.join(", ")}; use a dynamic import()`,
    );
  }
}

// esbuild options both Computer bundles share. Each bundle function spells out
// its entry, `bundle` and `packages` itself: carrier-version-closure-gate reads
// them from bundleCjs's own body.
function computerBundleOptions({ version, daemonVersion, cliVersion, buildSha, minify }) {
  return {
    platform: "node",
    format: "cjs",
    target: "node20",
    metafile: true,
    define: {
      __RAFT_COMPUTER_VERSION__: JSON.stringify(version),
      __RAFT_DAEMON_VERSION__: JSON.stringify(daemonVersion),
      __RAFT_CLI_VERSION__: JSON.stringify(cliVersion),
      // Absent on local builds, so the identifier stays undefined at runtime.
      ...(buildSha ? { __RAFT_COMPUTER_BUILD_SHA__: JSON.stringify(buildSha) } : {}),
      // The source is ESM and uses `import.meta.url` (e.g. service.ts's
      // top-level `createRequire(import.meta.url)` for SEA detection). In CJS
      // output esbuild lowers `import.meta.url` to `undefined`, so
      // `createRequire(undefined)` throws at module load. Map every
      // `import.meta.url` to the executable's own file URL — a valid absolute
      // base that lets createRequire resolve node: builtins (all these call
      // sites need). SEA has no on-disk module tree, so the executable path is
      // the only meaningful base anyway.
      "import.meta.url": "__slockImportMetaUrl",
    },
    banner: {
      // `require` + `process` are available at the top of a SEA main script
      // (Node runs it via embedderRunCjs). pathToFileURL(process.execPath)
      // yields the running binary's file URL for the `import.meta.url` define.
      js:
        `/* raft-computer SEA bundle v${version} */\n` +
        `const __slockImportMetaUrl = require("node:url").pathToFileURL(process.execPath).href;`,
    },
    // Drops comments and layout whitespace from the resident source (40M → 29M
    // characters measured), which also removes almost all non-Latin-1 text.
    // Names are kept, so stack traces still name functions.
    minifyWhitespace: minify,
    logLevel: "info",
  };
}

function bundledInputs(result) {
  return Object.keys(result.metafile.inputs).map((input) => relative(REPO_ROOT, resolve(input)).replaceAll("\\", "/"));
}

// The lite bundle: `__service` and every `raft-computer <command>`. Same entry
// with the daemon and the agent CLI left external, so none of their source is
// resident in those processes; the SEA loader turns a stray daemon import into
// a routing error.
async function bundleLiteCjs({ version, daemonVersion, cliVersion, buildSha, workDir, minify = true }) {
  const { build } = await import("esbuild");
  const outfile = join(workDir, "computer-lite-bundle.cjs");
  const result = await build({
    ...computerBundleOptions({ version, daemonVersion, cliVersion, buildSha, minify }),
    entryPoints: [join(COMPUTER_ROOT, "src", "index.ts")],
    bundle: true,
    packages: undefined,
    outfile,
    external: SEA_LITE_EXTERNAL,
  });
  const runnerInputs = bundledInputs(result).filter((input) =>
    /^packages\/(daemon|cli)\//.test(input) || input.includes("node_modules/@botiverse/kimi-code-sdk/"),
  );
  if (runnerInputs.length > 0) {
    throw new Error(`Computer lite bundle pulled in runner code: ${runnerInputs.slice(0, 5).join(", ")}`);
  }
  if (minify) await finalizeSeaBundleSource(outfile, SEA_ASSET_LITE);
  return outfile;
}

// The kimi SDK on its own (asset kimi.cjs), evaluated by the SEA loader the
// first time a runner requires it. It must expose exactly the package's
// exports, or a Kimi launch would fail only once a user starts one.
async function bundleKimiCjs({ workDir, minify = true }) {
  const { build } = await import("esbuild");
  const outfile = join(workDir, "kimi-bundle.cjs");
  const specifier = Object.keys(SEA_LAZY_ASSETS).find((id) => SEA_LAZY_ASSETS[id] === SEA_ASSET_KIMI);
  await build({
    stdin: { contents: `export * from ${JSON.stringify(specifier)};`, resolveDir: DAEMON_ROOT, sourcefile: "kimi-entry.mjs" },
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile,
    define: { "import.meta.url": "__slockImportMetaUrl" },
    banner: { js: `const __slockImportMetaUrl = require("node:url").pathToFileURL(process.execPath).href;` },
    minifyWhitespace: minify,
    logLevel: "info",
  });
  const check = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { createRequire } from "node:module";
       const bundled = Object.keys(createRequire(import.meta.url)(${JSON.stringify(outfile)})).filter((k) => k !== "__esModule").sort();
       const pkg = Object.keys(await import(${JSON.stringify(specifier)})).filter((k) => k !== "default").sort();
       if (JSON.stringify(bundled) !== JSON.stringify(pkg)) { console.error(JSON.stringify({ bundled, pkg })); process.exit(1); }`,
    ],
    { cwd: DAEMON_ROOT, encoding: "utf8" },
  );
  if (check.status !== 0) {
    throw new Error(`${SEA_ASSET_KIMI} does not expose the kimi SDK's exports: ${check.stderr.slice(0, 2000)}`);
  }
  if (minify) await finalizeSeaBundleSource(outfile, SEA_ASSET_KIMI);
  return outfile;
}

// The full bundle: the runner (`__run`) and the other hidden entries that run
// daemon code (seaEntries.mjs SEA_RUNNER_ENTRIES).
async function bundleCjs({ version, daemonVersion, cliVersion, buildSha, workDir, minify = true }) {
  const { build } = await import("esbuild");
  const outfile = join(workDir, "computer-bundle.cjs");
  const result = await build({
    ...computerBundleOptions({ version, daemonVersion, cliVersion, buildSha, minify }),
    entryPoints: [join(COMPUTER_ROOT, "src", "index.ts")],
    bundle: true,
    // SEA has no node_modules — inline EVERYTHING including @botiverse/raft-daemon.
    // Leave node: builtins external (the runtime provides them).
    packages: undefined,
    outfile,
    alias: { ...SEA_SOURCE_ALIASES, ...SEA_UNREACHABLE_ALIASES, ...SEA_LAZY_ASSET_SHIMS },
  });
  const lazyInputs = bundledInputs(result).filter((input) => input.includes("node_modules/@botiverse/kimi-code-sdk/"));
  if (lazyInputs.length > 0) {
    throw new Error(`Computer SEA bundle inlined the kimi SDK, which must load from ${SEA_ASSET_KIMI}: ${lazyInputs[0]}`);
  }
  assertLazyShimsDynamicOnly(result, SEA_LAZY_ASSET_SHIMS, "every runner");
  const distInputs = bundledInputs(result).filter((input) => /^packages\/[^/]+\/dist\//.test(input));
  if (distInputs.length > 0) {
    throw new Error(
      `Computer SEA bundle inlined prebuilt workspace dists (duplicating shared/zod code): ` +
        `${distInputs.join(", ")}; add their source entries to SEA_SOURCE_ALIASES`,
    );
  }
  if (minify) await finalizeSeaBundleSource(outfile, SEA_ASSET_FULL);
  return outfile;
}

async function resolvePhotonWasmPath() {
  const candidates = [
    join(DAEMON_ROOT, "node_modules", "@silvia-odwyer", "photon-node", PHOTON_WASM_FILENAME),
    join(REPO_ROOT, "node_modules", "@silvia-odwyer", "photon-node", PHOTON_WASM_FILENAME),
  ];

  try {
    const piPackageDir = await realpath(
      join(DAEMON_ROOT, "node_modules", "@earendil-works", "pi-coding-agent"),
    );
    candidates.push(
      join(piPackageDir, "..", "..", "@silvia-odwyer", "photon-node", PHOTON_WASM_FILENAME),
    );
  } catch {
    // The direct dependency-freshness check will report missing daemon deps.
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `required Photon WASM sidecar not found (${PHOTON_WASM_FILENAME}); ` +
      "install dependencies before building the Computer SEA",
  );
}

async function copyPhotonWasmSidecar(outDir) {
  const source = await resolvePhotonWasmPath();
  const outWasm = join(outDir, PHOTON_WASM_FILENAME);
  await copyFile(source, outWasm);
  const digest = await sha256(outWasm);
  await writeFile(`${outWasm}.sha256`, `${digest}  ${PHOTON_WASM_FILENAME}\n`);
  console.log(`[build] photon wasm: ${outWasm} (${digest})`);
}

async function makeBlob({ loaderPath, bundlePath, liteBundlePath, kimiBundlePath, cliBundlePath, cliUndiciBundlePath, workDir, nodeVersion }) {
  const hostMajor = process.versions.node.split(".")[0];
  const targetMajor = String(nodeVersion).split(".")[0];
  if (hostMajor !== targetMajor) {
    throw new Error(
      `host node major (${hostMajor}) != target node major (${targetMajor}); ` +
        `SEA blobs are arch-independent but node-major-specific — run this build ` +
        `under a node ${targetMajor}.x runtime (actions/setup-node node-version: ${targetMajor}).`,
    );
  }
  const blobPath = join(workDir, "computer.blob");
  const configPath = join(workDir, "sea-config.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        main: loaderPath,
        output: blobPath,
        disableExperimentalSEAWarning: true,
        assets: {
          [SEA_ASSET_FULL]: bundlePath,
          [SEA_ASSET_LITE]: liteBundlePath,
          [SEA_ASSET_KIMI]: kimiBundlePath,
          [SEA_ASSET_CLI]: cliBundlePath,
          [SEA_ASSET_CLI_UNDICI]: cliUndiciBundlePath,
        },
      },
      null,
      2,
    ),
  );
  run(process.execPath, ["--experimental-sea-config", configPath]);
  if (!existsSync(blobPath)) throw new Error(`SEA blob not produced at ${blobPath}`);
  return blobPath;
}

async function injectAndSign({ officialNode, blobPath, platform, outBinary }) {
  await copyFile(officialNode, outBinary);
  // copyFile/codesign can leave the file read-only; postject must rewrite it.
  await chmod(outBinary, 0o755);

  const postjectArgs = [
    outBinary,
    "NODE_SEA_BLOB",
    blobPath,
    "--sentinel-fuse",
    SEA_FUSE,
  ];
  if (platform === "darwin") {
    postjectArgs.push("--macho-segment-name", "NODE_SEA");
    // Remove node's own signature first — postject mutating a signed mach-O
    // invalidates it and macOS then refuses to exec.
    run("codesign", ["--remove-signature", outBinary]);
  } else if (platform === "win32") {
    // Official Node Windows carriers are Authenticode-signed. Injecting the
    // SEA resource invalidates that signature, so remove it when signtool is
    // available (as it is on GitHub's Windows image). This mirrors kimi-code;
    // an unsigned curl/irm-installed CLI remains executable without a cert.
    tryRun("signtool", ["remove", "/s", outBinary], { windowsHide: true });
  }

  run(process.execPath, [resolvePostjectCli(), ...postjectArgs]);

  if (platform === "darwin") {
    // Ad-hoc re-sign for same-runner smoke. The formal release workflow must
    // replace this signature before any darwin artifact is published.
    run("codesign", ["--sign", "-", outBinary]);
    run("codesign", ["--verify", "--verbose", outBinary]);
  }
  await chmod(outBinary, 0o755);
}

function smokeNativeBinary({ outBinary, platform, arch, version, daemonVersion, cliVersion, smokeHome }) {
  if (platform !== process.platform || arch !== process.arch) return;
  // Prevent K dispatch from testing an installed resident instead of these
  // newly injected bytes, and keep host account credentials out of all probes.
  const smokeEnv = {
    ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}),
    RAFT_HOME: smokeHome,
    SLOCK_HOME: smokeHome,
  };
  const result = spawnSync(outBinary, ["--version"], {
    encoding: "utf8",
    windowsHide: true,
    env: smokeEnv,
  });
  if (result.status !== 0) {
    throw new Error(
      `native smoke failed: ${outBinary} --version exited with ${result.status ?? result.signal}: ` +
        `${result.stderr || result.stdout}`,
    );
  }
  const actual = String(result.stdout).trim().split(/\s+/)[0]?.replace(/^v/, "");
  if (actual !== version) {
    throw new Error(`native smoke version mismatch: got ${actual || "<empty>"}, expected ${version}`);
  }
  console.log(`[verify] ${outBinary} --version → ${actual}`);

  const versionsResult = spawnSync(outBinary, ["__build-versions"], {
    encoding: "utf8",
    windowsHide: true,
    env: smokeEnv,
  });
  if (versionsResult.status !== 0) {
    throw new Error(
      `native version identity smoke failed with ${versionsResult.status ?? versionsResult.signal}: ` +
        `${versionsResult.stderr || versionsResult.stdout}`,
    );
  }
  let reported;
  try {
    reported = JSON.parse(String(versionsResult.stdout));
  } catch {
    throw new Error(`native version identity smoke returned invalid JSON: ${versionsResult.stdout}`);
  }
  const expectedFields = ["cliVersion", "computerVersion", "daemonVersion"];
  const reportedFields =
    reported !== null && typeof reported === "object" && !Array.isArray(reported)
      ? Object.keys(reported).sort()
      : [];
  if (JSON.stringify(reportedFields) !== JSON.stringify(expectedFields)) {
    throw new Error(
      `native version identity smoke must report exactly ${expectedFields.join(", ")}; ` +
        `got ${reportedFields.length > 0 ? reportedFields.join(", ") : "<no fields>"}`,
    );
  }
  for (const field of expectedFields) {
    const value = reported?.[field];
    if (
      typeof value !== "string"
      || value.length === 0
      || value === "unknown"
      || /^0\.0\.0(?:$|-)/.test(value)
    ) {
      throw new Error(
        `native version identity ${field} is missing or placeholder: ${JSON.stringify(value)}`,
      );
    }
  }
  const expected = {
    computerVersion: version,
    daemonVersion,
    cliVersion,
  };
  for (const field of expectedFields) {
    if (reported[field] !== expected[field]) {
      throw new Error(
        `native version identity ${field} mismatch: got ${JSON.stringify(reported[field])}, ` +
          `expected ${JSON.stringify(expected[field])}`,
      );
    }
  }
  console.log(`[verify] ${outBinary} __build-versions → ${JSON.stringify(reported)}`);

  const oauthResult = spawnSync(outBinary, ["__verify-bundled-oauth"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
    env: smokeEnv,
  });
  if (oauthResult.status !== 0 || oauthResult.stdout.trim() !== "oauth-bundle-ok") {
    throw new Error(
      `native OAuth bundle smoke failed with ${oauthResult.status ?? oauthResult.signal}: ` +
        `${oauthResult.stderr || oauthResult.stdout || oauthResult.error}`,
    );
  }
  console.log(`[verify] ${outBinary} bundled OAuth derivation passed`);

  // The kimi SDK is its own asset, compiled on the first Kimi launch; load it
  // here so a broken asset fails the build, not a user's first Kimi agent.
  const kimiResult = spawnSync(outBinary, ["__verify-bundled-kimi"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    env: smokeEnv,
  });
  if (kimiResult.status !== 0 || kimiResult.stdout.trim() !== "kimi-bundle-ok") {
    throw new Error(
      `native kimi asset smoke failed with ${kimiResult.status ?? kimiResult.signal}: ` +
        `${kimiResult.stderr || kimiResult.stdout || kimiResult.error}`,
    );
  }
  console.log(`[verify] ${outBinary} kimi SDK asset loaded`);

  // The daemon's View Context restore child re-executes the binary: a request on
  // stdin, a header line and the result body on stdout. A missing file exercises
  // the routing and the protocol; the heap limit goes through NODE_OPTIONS, which
  // a SEA must honor or a large session would take the machine's memory, so the
  // limit the child reports is checked too.
  const restoreRequest = JSON.stringify({
    runtime: "claude",
    file: join(tmpdir(), "raft-native-smoke-no-such-session.jsonl"),
    allowedRoots: [tmpdir()],
    offset: 0,
    messageId: "smoke",
    sessionId: "smoke",
    maxBytes: 1024,
  });
  const restoreResult = spawnSync(outBinary, ["__restore-context-view"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    input: restoreRequest,
    env: { ...smokeEnv, NODE_OPTIONS: "--max-old-space-size=512" },
  });
  const [restoreHeader, restoreBody] = (restoreResult.stdout ?? "").split("\n");
  // The reported limit also counts the young generation (512 reads about 700).
  // V8's own default on a build machine is 2 GiB or more, so past 1 GiB means
  // NODE_OPTIONS was ignored.
  const restoreHeapLimit = /"child_heap_limit_mb":(\d+)/.exec(restoreHeader ?? "")?.[1];
  if (
    restoreResult.status !== 0
    || restoreBody !== JSON.stringify({ ok: false, reason: "not_found" })
    || !restoreHeader?.includes('"outcome":"not_found"')
    || !(Number(restoreHeapLimit) >= 512 && Number(restoreHeapLimit) <= 1024)
  ) {
    throw new Error(
      `native context view restore smoke failed with ${restoreResult.status ?? restoreResult.signal}: ` +
        `${restoreResult.stderr || restoreResult.stdout || restoreResult.error}`,
    );
  }
  console.log(`[verify] ${outBinary} context view restore child answered, heap limit ${restoreHeapLimit} MB`);

  // RFC 060: the OAR host loads OAR's runtimes (grok, qwen, qoder, codebuddy), their
  // session paths and the observe entry lazily; load them from the binary as a
  // launch would.
  const oarResult = spawnSync(outBinary, ["__verify-bundled-oar"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    env: smokeEnv,
  });
  if (oarResult.status !== 0 || oarResult.stdout.trim() !== "oar-bundle-ok") {
    throw new Error(
      `native OAR host smoke failed with ${oarResult.status ?? oarResult.signal}: ` +
        `${oarResult.stderr || oarResult.stdout || oarResult.error}`,
    );
  }
  console.log(`[verify] ${outBinary} OAR host runtimes loaded`);

  // The agent CLI path runs from its own embedded asset (seaCliEntry.ts).
  const cliResult = spawnSync(outBinary, ["__cli", "--version"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    env: smokeEnv,
  });
  const cliReported = String(cliResult.stdout ?? "").trim();
  if (cliResult.status !== 0 || !cliReported.endsWith(cliVersion)) {
    throw new Error(
      `native agent CLI smoke failed with ${cliResult.status ?? cliResult.signal}: ` +
        `${cliResult.stderr || cliResult.stdout || cliResult.error}`,
    );
  }
  console.log(`[verify] ${outBinary} __cli --version → ${cliReported}`);
  assertAgentCliFootprint({ outBinary, smokeEnv });
}

// Peak memory budget for one agent `raft` call (task #11). 1.0.47 measured
// ~580 MiB. With the CLI-only asset, lazy shared schemas and the node:http
// transport it measures 74 MiB on linux-arm64 and 85 MiB on macOS (which
// reports more for the same build); the budget leaves ~30% headroom over macOS.
const AGENT_CLI_MAX_RSS_MIB = 110;

// POSIX only: reads the child's peak RSS via python's getrusage(RUSAGE_CHILDREN)
// (Node has no API for a child's rusage). Skipped where python3 is missing.
function assertAgentCliFootprint({ outBinary, smokeEnv }) {
  if (process.platform === "win32") return;
  const probe = [
    "import resource, subprocess, sys, time",
    "t = time.time()",
    "r = subprocess.run([sys.argv[1], '__cli', '--version'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)",
    "u = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss",
    "kib = u / 1024 if sys.platform == 'darwin' else u",
    "print(r.returncode, int(kib / 1024), round(time.time() - t, 2))",
  ].join("\n");
  const result = spawnSync("python3", ["-c", probe, outBinary], { encoding: "utf8", env: { ...smokeEnv, PATH: process.env.PATH } });
  if (result.error || result.status !== 0) {
    console.log(`[verify] agent CLI footprint not measured (python3 unavailable: ${result.error?.message ?? result.stderr})`);
    return;
  }
  const [code, rssMiB, seconds] = String(result.stdout).trim().split(/\s+/).map(Number);
  console.log(`[verify] agent CLI footprint: ${rssMiB} MiB peak RSS, ${seconds}s (budget ${AGENT_CLI_MAX_RSS_MIB} MiB)`);
  if (code !== 0) throw new Error(`agent CLI footprint probe: __cli --version exited ${code}`);
  if (!(rssMiB <= AGENT_CLI_MAX_RSS_MIB)) {
    throw new Error(
      `agent CLI footprint ${rssMiB} MiB exceeds the ${AGENT_CLI_MAX_RSS_MIB} MiB budget: ` +
        "an agent `raft` call must load only the CLI asset (see seaCliEntry.ts) and build shared schemas lazily (packages/shared/src/lazySchema.ts)",
    );
  }
}

async function sha256(file) {
  const buf = await readFile(file);
  return createHash("sha256").update(buf).digest("hex");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pkg = JSON.parse(await readFile(join(COMPUTER_ROOT, "package.json"), "utf8"));
  const daemonPkg = JSON.parse(await readFile(join(DAEMON_ROOT, "package.json"), "utf8"));
  const cliPkg = JSON.parse(await readFile(join(CLI_ROOT, "package.json"), "utf8"));

  const version = args.version || pkg.version;
  const daemonVersion = daemonPkg.version;
  const cliVersion = cliPkg.version;
  // The commit Actions checked out; tells a staging build from the release
  // that reports the same version. Unset outside CI.
  const buildSha = process.env.GITHUB_SHA?.trim() || undefined;
  const platform = args.platform || process.platform;
  const arch = args.arch || process.arch;
  const nodeVersion = args["node-version"] || process.versions.node;
  const bundleOnly = args["bundle-only"] === true;
  // Measurement only (measure-load-heap attributes objects by the bundle's
  // module comments and source layout): keeps them, skips the Latin-1 gate.
  const noMinify = args["no-minify"] === true;
  if (noMinify && !bundleOnly) throw new Error("--no-minify is only for --bundle-only measurement bundles");
  const outDir = resolve(args["out-dir"] || join(COMPUTER_ROOT, "dist-native"));
  const workDir = resolve(args["work-dir"] || join(tmpdir(), "raft-computer-sea", `${platform}-${arch}`));

  await assertBuildOutputFresh({
    dependency: "@botiverse/raft-daemon",
    inputs: [
      join(DAEMON_ROOT, "src"),
      join(DAEMON_ROOT, "package.json"),
      join(DAEMON_ROOT, "tsconfig.json"),
      join(DAEMON_ROOT, "tsdown.config.ts"),
      join(COMPUTER_ROOT, "..", "cli", "src"),
      join(COMPUTER_ROOT, "..", "cli", "package.json"),
      join(COMPUTER_ROOT, "..", "cli", "tsconfig.json"),
      join(COMPUTER_ROOT, "..", "cli", "tsdown.config.ts"),
      join(COMPUTER_ROOT, "..", "shared", "src"),
      join(COMPUTER_ROOT, "..", "shared", "package.json"),
      join(COMPUTER_ROOT, "..", "shared", "tsconfig.json"),
      join(COMPUTER_ROOT, "..", "trace-client", "src"),
      join(COMPUTER_ROOT, "..", "trace-client", "package.json"),
      join(COMPUTER_ROOT, "..", "trace-client", "tsconfig.json"),
    ],
    output: join(DAEMON_ROOT, "dist", "core.js"),
    recovery: "pnpm --filter @botiverse/raft-computer build:deps",
  });

  console.log(
    `[build] raft-computer v${version} + raft-daemon v${daemonVersion} → ${platform}-${arch} (node v${nodeVersion})`,
  );
  await mkdir(outDir, { recursive: true });
  await mkdir(workDir, { recursive: true });

  const bundlePath = await bundleCjs({ version, daemonVersion, cliVersion, buildSha, workDir, minify: !noMinify });
  const liteBundlePath = await bundleLiteCjs({ version, daemonVersion, cliVersion, buildSha, workDir, minify: !noMinify });
  const kimiBundlePath = await bundleKimiCjs({ workDir, minify: !noMinify });
  if (bundleOnly) {
    console.log(
      `[build] bundle-only contract passed: ${bundlePath}, ${liteBundlePath}, ${kimiBundlePath}${noMinify ? " (unminified, not shippable)" : ""}`,
    );
    return;
  }

  const cliBundlePath = await bundleSeaCliCjs({ cliVersion, workDir });
  const cliUndiciBundlePath = await bundleCliUndiciCjs({ workDir });
  const loaderPath = await writeSeaLoader({
    workDir,
    assets: {
      [SEA_ASSET_FULL]: bundlePath,
      [SEA_ASSET_LITE]: liteBundlePath,
      [SEA_ASSET_KIMI]: kimiBundlePath,
      [SEA_ASSET_CLI]: cliBundlePath,
      [SEA_ASSET_CLI_UNDICI]: cliUndiciBundlePath,
    },
  });
  const officialNode = await downloadOfficialNode({ platform, arch, nodeVersion, workDir });
  const blobPath = await makeBlob({
    loaderPath,
    bundlePath,
    liteBundlePath,
    kimiBundlePath,
    cliBundlePath,
    cliUndiciBundlePath,
    workDir,
    nodeVersion,
  });

  const ext = platform === "win32" ? ".exe" : "";
  const binaryName = `raft-computer-${platform}-${arch}${ext}`;
  const outBinary = join(outDir, binaryName);
  await rm(outBinary, { force: true });

  await injectAndSign({ officialNode, blobPath, platform, outBinary });
  const smokeHome = await mkdtemp(join(workDir, "smoke-home-"));
  try {
    smokeNativeBinary({ outBinary, platform, arch, version, daemonVersion, cliVersion, smokeHome });
  } finally {
    await rm(smokeHome, { recursive: true, force: true });
  }

  const digest = await sha256(outBinary);
  await writeFile(`${outBinary}.sha256`, `${digest}  ${binaryName}\n`);
  // Emit a gzipped sidecar next to the binary so install.sh can ship a
  // ~3.4× smaller download (143MB → ~42MB measured for darwin-arm64). The
  // on-disk binary is unchanged; only transit is compressed. produce-manifest
  // picks these up and adds the gz block to each target. gzip -9 over -6 saves
  // <0.5% on this corpus; just use -9 for the slightly smaller release.
  const gzName = `${binaryName}.gz`;
  const outGz = join(outDir, gzName);
  await rm(outGz, { force: true });
  await new Promise((resolve, reject) => {
    const src = createReadStream(outBinary);
    const dst = createWriteStream(outGz);
    src.on("error", reject);
    dst.on("error", reject);
    dst.on("finish", resolve);
    src.pipe(createGzip({ level: 9 })).pipe(dst);
  });
  const gzDigest = await sha256(outGz);
  await writeFile(`${outGz}.sha256`, `${gzDigest}  ${gzName}\n`);
  await copyPhotonWasmSidecar(outDir);
  console.log(`[build] done: ${outBinary}`);
  console.log(`[build] sha256: ${digest}`);
  console.log(`[build] gzip:   ${outGz} (${gzDigest})`);
}

main().catch((err) => {
  console.error(`[build] FAILED: ${err.message}`);
  process.exit(1);
});
