import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";
import { DEFAULT_UPGRADE_BASE_URL } from "./computerRelease.js";
import { createComputerReleaseSource } from "./kReleaseSource.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");
const pinnedNodeVersion = readFileSync(join(repoRoot, ".node-version"), "utf8").trim();
const nativeManifestScriptPath = join(
  here,
  "../scripts/native/produce-manifest.mjs",
);
const releaseTagClassifierPath = join(
  here,
  "../scripts/native/classify-release-tag.mjs",
);

function sha256(bytes: string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function writePhotonWasmFixture(dir: string): void {
  const file = "photon_rs_bg.wasm";
  const bytes = "fixture-photon-wasm";
  writeFileSync(join(dir, file), bytes);
  writeFileSync(join(dir, `${file}.sha256`), `${sha256(bytes)}  ${file}\n`);
}

function writeNativeFixture(
  dir: string,
  target: string,
  version: string,
  withReceipt: boolean,
): void {
  const file = `raft-computer-${target}`;
  const bytes = `fixture-${target}`;
  const digest = sha256(bytes);
  writeFileSync(join(dir, file), bytes);
  writeFileSync(join(dir, `${file}.sha256`), `${digest}  ${file}\n`);
  writePhotonWasmFixture(dir);
  if (!withReceipt) return;
  const notaryResponse = `${JSON.stringify({ status: "Accepted", id: "fixture" })}\n`;
  const notaryLog = `${JSON.stringify({ status: "Accepted", issues: [] })}\n`;
  writeFileSync(join(dir, `${file}.notarization.json`), notaryResponse);
  writeFileSync(join(dir, `${file}.notarization.log.json`), notaryLog);
  writeFileSync(
    join(dir, `${file}.notarization.receipt.json`),
    `${JSON.stringify({
      schema_version: 1,
      target,
      version,
      binary_file: file,
      signature_type: "developer-id-application",
      team_id: "ABCDE12345",
      cdhash: "b".repeat(40),
      hardened_runtime: true,
      status: "Accepted",
      submission_id: "12345678-1234-4234-8234-123456789abc",
      notary_issues: 0,
      submitted_archive: {
        file: `${file}.notarization.zip`,
        sha256: "c".repeat(64),
        size_bytes: 123,
      },
      notary_response: {
        file: `${file}.notarization.json`,
        sha256: sha256(notaryResponse),
        size_bytes: Buffer.byteLength(notaryResponse),
      },
      notary_log: {
        file: `${file}.notarization.log.json`,
        sha256: sha256(notaryLog),
        size_bytes: Buffer.byteLength(notaryLog),
      },
      final_sha256: digest,
      final_size_bytes: Buffer.byteLength(bytes),
      stapled: false,
      ticket_delivery: "online",
    })}\n`,
  );
}

test("Computer exact target resolves the no-env default root manifest and fails closed on 404", async () => {
  const version = "1.0.16-staging.sha.95dbe9596b68";
  const expectedUrl = `${DEFAULT_UPGRADE_BASE_URL}/${version}/manifest.json`;
  let requestedUrl = "";
  const source = createComputerReleaseSource(DEFAULT_UPGRADE_BASE_URL, {
    backend: "legacy-cdn",
    fetchFn: (async (input: string | URL | Request) => {
      requestedUrl = String(input);
      return new Response("", { status: 404 });
    }) as typeof fetch,
  });

  await assert.rejects(
    source.fetchRelease(version, { currentVersion: "1.0.16", platformKey: "linux-x64" }),
    /K_SOURCE_UNAVAILABLE: .*manifest\.json answered HTTP 404/u,
  );
  assert.equal(requestedUrl, expectedUrl);
});

test("Computer release tag classifier keeps RC bytes on the final package version", () => {
  const run = (tag: string, packageVersion = "1.0.18") =>
    spawnSync(process.execPath, [releaseTagClassifierPath, tag, packageVersion], {
      encoding: "utf8",
    });

  const stable = run("computer-v1.0.18");
  assert.equal(stable.status, 0, stable.stderr);
  assert.deepEqual(JSON.parse(stable.stdout), {
    channel: "stable",
    version: "1.0.18",
    packageVersion: "1.0.18",
  });

  const rc = run("computer-v1.0.18-rc.1");
  assert.equal(rc.status, 0, rc.stderr);
  assert.deepEqual(JSON.parse(rc.stdout), {
    channel: "rc",
    version: "1.0.18",
    tagVersion: "1.0.18-rc.1",
    packageVersion: "1.0.18",
  });

  for (const invalid of [
    "computer-v1.0.18-rc.0",
    "computer-v1.0.18-rc.01",
    "computer-v1.0.18-rc.alpha",
    "computer-v01.0.18",
    "computer-v1.0.19-rc.1",
  ]) {
    assert.notEqual(run(invalid).status, 0, `${invalid} must fail closed`);
  }
});

test("formal manifest requires both attested Darwin targets and binds receipts to final bytes", () => {
  const dir = mkdtempSync(join(tmpdir(), "raft-computer-native-manifest-"));
  try {
    writeNativeFixture(dir, "darwin-arm64", "1.2.3", true);
    writeNativeFixture(dir, "darwin-x64", "1.2.3", true);
    const pass = spawnSync(
      process.execPath,
      [
        nativeManifestScriptPath,
        "--dir",
        dir,
        "--version",
        "1.2.3",
        "--node-version",
        pinnedNodeVersion,
        "--required-targets",
        "darwin-arm64,darwin-x64",
        "--require-darwin-notarization",
      ],
      { encoding: "utf8" },
    );
    assert.equal(pass.status, 0, pass.stderr);
    const manifest = JSON.parse(
      readFileSync(join(dir, "manifest.json"), "utf8"),
    );
    assert.equal(
      manifest.targets["darwin-arm64"].apple.notarization.status,
      "Accepted",
    );
    assert.equal(
      manifest.targets["darwin-arm64"].apple.notarization.receipt.file,
      "raft-computer-darwin-arm64.notarization.receipt.json",
    );
    assert.equal(manifest.photonWasm.file, "photon_rs_bg.wasm");
    assert.equal(manifest.photonWasm.sha256, sha256("fixture-photon-wasm"));

    const armReceiptPath = join(
      dir,
      "raft-computer-darwin-arm64.notarization.receipt.json",
    );
    const armReceipt = JSON.parse(readFileSync(armReceiptPath, "utf8"));
    armReceipt.final_sha256 = "d".repeat(64);
    writeFileSync(armReceiptPath, `${JSON.stringify(armReceipt)}\n`);
    const fail = spawnSync(
      process.execPath,
      [
        nativeManifestScriptPath,
        "--dir",
        dir,
        "--version",
        "1.2.3",
        "--require-darwin-notarization",
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(fail.status, 0);
    assert.match(fail.stderr, /does not attest darwin-arm64 final bytes/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("staging manifests remain compatible when Apple receipts are absent", () => {
  const dir = mkdtempSync(
    join(tmpdir(), "raft-computer-native-staging-manifest-"),
  );
  try {
    writeNativeFixture(dir, "darwin-arm64", "1.2.3", false);
    const result = spawnSync(
      process.execPath,
      [nativeManifestScriptPath, "--dir", dir, "--version", "1.2.3"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    assert.equal(manifest.targets["darwin-arm64"].apple, undefined);
    assert.equal(manifest.photonWasm.file, "photon_rs_bg.wasm");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
