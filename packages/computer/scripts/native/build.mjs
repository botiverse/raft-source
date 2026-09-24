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
import { chmod, copyFile, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createGzip } from "node:zlib";

import { assertBuildOutputFresh } from "./dependency-freshness.mjs";

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

async function bundleCjs({ version, daemonVersion, cliVersion, workDir }) {
  const { build } = await import("esbuild");
  const outfile = join(workDir, "computer-bundle.cjs");
  await build({
    entryPoints: [join(COMPUTER_ROOT, "src", "index.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile,
    // SEA has no node_modules — inline EVERYTHING including @botiverse/raft-daemon.
    // Leave node: builtins external (the runtime provides them).
    packages: undefined,
    define: {
      __RAFT_COMPUTER_VERSION__: JSON.stringify(version),
      __RAFT_DAEMON_VERSION__: JSON.stringify(daemonVersion),
      __RAFT_CLI_VERSION__: JSON.stringify(cliVersion),
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
    logLevel: "info",
  });
  return outfile;
}

async function assertBundledDaemonReleaseContracts(bundlePath) {
  const bundle = await readFile(bundlePath, "utf8");
  for (const requiredText of [
    "wiki-workspace-pack:v1",
    "Configured Wiki Agent has no valid installed workspace pack",
  ]) {
    if (!bundle.includes(requiredText)) {
      throw new Error(
        `bundled daemon release contract missing from Computer SEA input: ${requiredText}`,
      );
    }
  }
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

async function makeBlob({ bundlePath, workDir, nodeVersion }) {
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
      { main: bundlePath, output: blobPath, disableExperimentalSEAWarning: true },
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

function smokeNativeBinary({ outBinary, platform, arch, version, daemonVersion, cliVersion }) {
  if (platform !== process.platform || arch !== process.arch) return;
  const result = spawnSync(outBinary, ["--version"], {
    encoding: "utf8",
    windowsHide: true,
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
  const platform = args.platform || process.platform;
  const arch = args.arch || process.arch;
  const nodeVersion = args["node-version"] || process.versions.node;
  const bundleOnly = args["bundle-only"] === true;
  const outDir = resolve(args["out-dir"] || join(COMPUTER_ROOT, "dist-native"));
  const workDir = resolve(args["work-dir"] || join(tmpdir(), "raft-computer-sea", `${platform}-${arch}`));

  await assertBuildOutputFresh({
    dependency: "@botiverse/raft-daemon",
    inputs: [
      join(DAEMON_ROOT, "src"),
      join(DAEMON_ROOT, "package.json"),
      join(DAEMON_ROOT, "tsconfig.json"),
      join(DAEMON_ROOT, "tsup.config.ts"),
      join(COMPUTER_ROOT, "..", "cli", "src"),
      join(COMPUTER_ROOT, "..", "cli", "package.json"),
      join(COMPUTER_ROOT, "..", "cli", "tsconfig.json"),
      join(COMPUTER_ROOT, "..", "cli", "tsup.config.ts"),
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

  const bundlePath = await bundleCjs({ version, daemonVersion, cliVersion, workDir });
  await assertBundledDaemonReleaseContracts(bundlePath);
  if (bundleOnly) {
    console.log(`[build] bundle-only contract passed: ${bundlePath}`);
    return;
  }

  const officialNode = await downloadOfficialNode({ platform, arch, nodeVersion, workDir });
  const blobPath = await makeBlob({ bundlePath, workDir, nodeVersion });

  const ext = platform === "win32" ? ".exe" : "";
  const binaryName = `raft-computer-${platform}-${arch}${ext}`;
  const outBinary = join(outDir, binaryName);
  await rm(outBinary, { force: true });

  await injectAndSign({ officialNode, blobPath, platform, outBinary });
  smokeNativeBinary({ outBinary, platform, arch, version, daemonVersion, cliVersion });

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
