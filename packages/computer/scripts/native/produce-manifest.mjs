#!/usr/bin/env node
// Produce `manifest.json` describing a set of built SEA binaries.
//
// The release workflow downloads every per-platform binary into one directory
// (each with its `.sha256` sidecar from build.mjs) and runs this once. The
// manifest is the contract install.sh / the upgrade flow read to pick the
// right asset and verify its digest before swapping it in.
//
// Shape:
//   {
//     "name": "raft-computer",
//     "version": "0.0.28",
//     "nodeVersion": "22.x",
//     "targets": {
//       "darwin-arm64": { "file": "raft-computer-darwin-arm64", "sha256": "…", "size": 135540496 },
//       "linux-x64":    { "file": "raft-computer-linux-x64",    "sha256": "…", "size": … },
//       …
//     }
//   }
//

import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const PHOTON_WASM_FILENAME = "photon_rs_bg.wasm";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[a.slice(2)] = next;
        i++;
      } else {
        out[a.slice(2)] = true;
      }
    }
  }
  return out;
}

// raft-computer-<platform>-<arch>[.exe] -> "<platform>-<arch>"
function targetKeyFromFilename(file) {
  const m = file.match(/^raft-computer-([a-z0-9]+)-([a-z0-9]+)(\.exe)?$/);
  if (!m) return null;
  return `${m[1]}-${m[2]}`;
}

function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isUuid(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

async function sha256File(path) {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

async function readPhotonWasmDescriptor(dir, entries) {
  if (!entries.includes(PHOTON_WASM_FILENAME)) {
    throw new Error(`missing required Photon WASM sidecar: ${PHOTON_WASM_FILENAME}`);
  }
  const wasmPath = join(dir, PHOTON_WASM_FILENAME);
  const shaPath = `${wasmPath}.sha256`;
  const shaContent = await readFile(shaPath, "utf8").catch(() => {
    throw new Error(
      `missing sha256 sidecar for ${PHOTON_WASM_FILENAME} (expected ${shaPath})`,
    );
  });
  const expectedSha = shaContent.trim().split(/\s+/)[0];
  if (!isSha256(expectedSha)) {
    throw new Error(`invalid sha256 sidecar for ${PHOTON_WASM_FILENAME}`);
  }
  const actualSha = await sha256File(wasmPath);
  if (actualSha !== expectedSha) {
    throw new Error(`sha256 sidecar mismatch for ${PHOTON_WASM_FILENAME}`);
  }
  const { size } = await stat(wasmPath);
  return { file: PHOTON_WASM_FILENAME, sha256: actualSha, size };
}

async function verifyEvidenceFile({
  dir,
  entries,
  evidence,
  expectedFile,
  label,
}) {
  if (
    !evidence ||
    evidence.file !== expectedFile ||
    !isSha256(evidence.sha256) ||
    !Number.isSafeInteger(evidence.size_bytes) ||
    evidence.size_bytes <= 0 ||
    !entries.includes(expectedFile)
  ) {
    throw new Error(`invalid ${label} evidence descriptor`);
  }
  const evidencePath = join(dir, expectedFile);
  const evidenceStat = await stat(evidencePath);
  const evidenceSha256 = await sha256File(evidencePath);
  if (
    evidenceStat.size !== evidence.size_bytes ||
    evidenceSha256 !== evidence.sha256
  ) {
    throw new Error(`${label} evidence bytes do not match the receipt`);
  }
  return {
    file: expectedFile,
    sha256: evidenceSha256,
    size: evidenceStat.size,
  };
}

async function readAppleAttestation({
  dir,
  entries,
  file,
  key,
  version,
  sha256,
  size,
  required,
}) {
  const receiptFile = `${file}.notarization.receipt.json`;
  if (!entries.includes(receiptFile)) {
    if (required)
      throw new Error(`missing Apple notarization receipt for ${key}`);
    return null;
  }

  const receiptPath = join(dir, receiptFile);
  let receipt;
  try {
    receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  } catch (error) {
    throw new Error(
      `invalid Apple notarization receipt for ${key}: ${error.message}`,
    );
  }

  const valid =
    receipt.schema_version === 1 &&
    receipt.target === key &&
    receipt.version === version &&
    receipt.binary_file === file &&
    receipt.signature_type === "developer-id-application" &&
    typeof receipt.team_id === "string" &&
    /^[A-Z0-9]{10}$/.test(receipt.team_id) &&
    typeof receipt.cdhash === "string" &&
    /^[0-9a-f]{40}$/.test(receipt.cdhash) &&
    receipt.hardened_runtime === true &&
    receipt.status === "Accepted" &&
    isUuid(receipt.submission_id) &&
    receipt.notary_issues === 0 &&
    receipt.final_sha256 === sha256 &&
    receipt.final_size_bytes === size &&
    receipt.stapled === false &&
    receipt.ticket_delivery === "online" &&
    receipt.submitted_archive &&
    typeof receipt.submitted_archive.file === "string" &&
    isSha256(receipt.submitted_archive.sha256) &&
    Number.isSafeInteger(receipt.submitted_archive.size_bytes) &&
    receipt.submitted_archive.size_bytes > 0;
  if (!valid)
    throw new Error(
      `Apple notarization receipt does not attest ${key} final bytes`,
    );

  const responseEvidence = await verifyEvidenceFile({
    dir,
    entries,
    evidence: receipt.notary_response,
    expectedFile: `${file}.notarization.json`,
    label: `${key} notary response`,
  });
  const logEvidence = await verifyEvidenceFile({
    dir,
    entries,
    evidence: receipt.notary_log,
    expectedFile: `${file}.notarization.log.json`,
    label: `${key} notary log`,
  });

  const receiptStat = await stat(receiptPath);
  return {
    signature: {
      type: receipt.signature_type,
      teamId: receipt.team_id,
      cdHash: receipt.cdhash,
      hardenedRuntime: true,
    },
    notarization: {
      status: receipt.status,
      submissionId: receipt.submission_id,
      issues: 0,
      stapled: false,
      ticketDelivery: receipt.ticket_delivery,
      submittedArchive: {
        sha256: receipt.submitted_archive.sha256,
        size: receipt.submitted_archive.size_bytes,
      },
      evidence: {
        response: responseEvidence,
        log: logEvidence,
      },
      receipt: {
        file: receiptFile,
        sha256: await sha256File(receiptPath),
        size: receiptStat.size,
      },
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = resolve(args.dir || "dist-native");
  const version = args.version;
  const nodeVersion = args["node-version"] || "";
  const requireDarwinNotarization =
    args["require-darwin-notarization"] === true;
  const requiredTargets = String(args["required-targets"] || "")
    .split(",")
    .map((target) => target.trim())
    .filter(Boolean);
  if (!version) throw new Error("--version is required");

  const entries = await readdir(dir);
  const targets = {};
  for (const file of entries) {
    if (file.endsWith(".sha256")) continue;
    if (file.endsWith(".gz")) continue; // handled as a sidecar to the binary, below
    if (file === "manifest.json") continue;
    const key = targetKeyFromFilename(file);
    if (!key) continue;

    const binaryPath = join(dir, file);
    const shaPath = `${binaryPath}.sha256`;
    const shaContent = await readFile(shaPath, "utf8").catch(() => {
      throw new Error(
        `missing sha256 sidecar for ${file} (expected ${shaPath})`,
      );
    });
    const sha256 = shaContent.trim().split(/\s+/)[0];
    const { size } = await stat(binaryPath);
    const target = { file, sha256, size };

    if (key.startsWith("darwin-")) {
      const apple = await readAppleAttestation({
        dir,
        entries,
        file,
        key,
        version,
        sha256,
        size,
        required: requireDarwinNotarization,
      });
      if (apple) target.apple = apple;
    }

    // Optional gzip sidecar (build.mjs emits `<file>.gz` + `<file>.gz.sha256`).
    // install.sh prefers `target.gz` when present (~3.4× smaller download); the
    // decompressed file is still verified against `target.sha256`. Older
    // releases without `.gz` sidecars stay valid — the field is omitted.
    const gzName = `${file}.gz`;
    const gzPath = join(dir, gzName);
    if (entries.includes(gzName)) {
      const gzShaContent = await readFile(`${gzPath}.sha256`, "utf8").catch(
        () => {
          throw new Error(
            `missing sha256 sidecar for ${gzName} (expected ${gzPath}.sha256)`,
          );
        },
      );
      const gzSha = gzShaContent.trim().split(/\s+/)[0];
      const gzStat = await stat(gzPath);
      target.gz = { file: gzName, sha256: gzSha, size: gzStat.size };
    }
    targets[key] = target;
  }

  if (Object.keys(targets).length === 0) {
    throw new Error(`no raft-computer-* binaries found in ${dir}`);
  }
  for (const requiredTarget of requiredTargets) {
    if (!targets[requiredTarget]) {
      throw new Error(`missing required target: ${requiredTarget}`);
    }
  }
  if (requireDarwinNotarization) {
    for (const key of ["darwin-arm64", "darwin-x64"]) {
      if (!targets[key]?.apple)
        throw new Error(`missing required notarized target: ${key}`);
    }
  }
  const photonWasm = await readPhotonWasmDescriptor(dir, entries);

  const manifest = {
    name: "raft-computer",
    version,
    nodeVersion,
    photonWasm,
    targets: Object.fromEntries(
      Object.entries(targets).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
  const outPath = join(dir, "manifest.json");
  await writeFile(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[manifest] ${outPath}`);
  console.log(
    `[manifest] ${Object.keys(manifest.targets).length} target(s): ${Object.keys(manifest.targets).join(", ")}`,
  );
}

main().catch((err) => {
  console.error(`[manifest] FAILED: ${err.message}`);
  process.exit(1);
});
