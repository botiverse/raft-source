import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "../../../..");
const buildScriptPath = resolve(repoRoot, "packages/computer/scripts/native/build.mjs");
const manifestScriptPath = resolve(repoRoot, "packages/computer/scripts/native/produce-manifest.mjs");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("native SEA build script emits the Photon WASM sidecar beside the binary", async () => {
  const source = await readFile(buildScriptPath, "utf8");

  assert.match(source, /PHOTON_WASM_FILENAME = "photon_rs_bg\.wasm"/);
  assert.match(source, /@silvia-odwyer", "photon-node"/);
  assert.match(source, /copyPhotonWasmSidecar\(outDir\)/);
  assert.match(source, /\$\{outWasm\}\.sha256/);
});

test("produce-manifest requires and attests photon_rs_bg.wasm", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "raft-photon-manifest-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));

  const binary = Buffer.from("fake native binary\n");
  const binaryName = "raft-computer-linux-x64";
  await writeFile(join(root, binaryName), binary);
  await writeFile(join(root, `${binaryName}.sha256`), `${sha256(binary)}  ${binaryName}\n`);

  const missing = await execFileAsync(
    process.execPath,
    [manifestScriptPath, "--dir", root, "--version", "1.2.3"],
  ).then(
    () => ({ code: 0, stderr: "" }),
    (error) => ({ code: error.code ?? -1, stderr: error.stderr ?? "" }),
  );
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /missing required Photon WASM sidecar: photon_rs_bg\.wasm/);

  const wasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  await writeFile(join(root, "photon_rs_bg.wasm"), wasm);
  await writeFile(join(root, "photon_rs_bg.wasm.sha256"), `${sha256(wasm)}  photon_rs_bg.wasm\n`);

  await execFileAsync(process.execPath, [
    manifestScriptPath,
    "--dir",
    root,
    "--version",
    "1.2.3",
    "--required-targets",
    "linux-x64",
  ]);
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.photonWasm, {
    file: "photon_rs_bg.wasm",
    sha256: sha256(wasm),
    size: wasm.length,
  });
});
