#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { createGunzip } from "node:zlib";
import { publishHandsRelease } from "./publish-hands-release.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const CHANNELS = new Set(["main", "alpha"]);
const REQUIRED_TARGETS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-x64",
];
const MAX_METADATA_BYTES = 2 * 1024 * 1024;

function required(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`);
  return value.trim();
}

function exactSha(value, name) {
  const normalized = required(value, name).toLowerCase();
  if (!SHA256.test(normalized)) throw new Error(`${name} must be a lowercase SHA-256`);
  return normalized;
}

function exactInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function exactChannel(value) {
  const channel = required(value, "--channel");
  if (!CHANNELS.has(channel)) throw new Error("--channel must be exactly main or alpha");
  return channel;
}

function expectedConfirmation(channel) {
  return `REGISTER-EXACT-RAFT-COMPUTER-CLI-${channel.toUpperCase()}`;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`invalid argument near ${key ?? "end of input"}`);
    }
    const name = key.slice(2);
    if (Object.hasOwn(result, name)) throw new Error(`duplicate argument: ${key}`);
    result[name] = value;
    index += 1;
  }
  return result;
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function sha256GunzipFile(path) {
  const hash = createHash("sha256");
  await pipeline(
    createReadStream(path),
    createGunzip(),
    new Writable({
      write(chunk, _encoding, callback) {
        hash.update(chunk);
        callback();
      },
    }),
  );
  return hash.digest("hex");
}

function candidateBaseUrl(sourceCommit) {
  return `https://cdn.slock.ai/computer/candidates/${sourceCommit}`;
}

async function fetchResponse(fetchImpl, url) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/octet-stream" },
      redirect: "error",
    });
  } catch {
    throw new Error(`candidate download transport failed: ${url.host}${url.pathname}`);
  }
  if (!response.ok) {
    throw new Error(`candidate download failed with HTTP ${response.status}: ${url.host}${url.pathname}`);
  }
  return response;
}

async function downloadMetadata(fetchImpl, url, name) {
  const response = await fetchResponse(fetchImpl, url);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_METADATA_BYTES) {
    throw new Error(`${name} exceeds the metadata size limit`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_METADATA_BYTES) throw new Error(`${name} exceeds the metadata size limit`);
  return bytes;
}

async function downloadFile(fetchImpl, url, path) {
  const response = await fetchResponse(fetchImpl, url);
  if (!response.body) throw new Error(`candidate response has no body: ${url.pathname}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(path, { flags: "wx" }));
}

function parseJson(bytes, name) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${name} is not valid JSON`);
  }
}

function canonicalInventory(raw) {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("candidate inventory must be a non-empty array");
  const seen = new Set();
  let previous = "";
  return raw.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("candidate inventory contains a non-object row");
    }
    const keys = Object.keys(entry).sort();
    if (keys.join(",") !== "file,sha256,sizeBytes") {
      throw new Error("candidate inventory row shape drifted");
    }
    const file = required(entry.file, "candidate inventory file");
    if (basename(file) !== file || !/^[A-Za-z0-9._-]+$/.test(file)) {
      throw new Error(`candidate inventory filename is not canonical: ${file}`);
    }
    if (seen.has(file)) throw new Error(`candidate inventory duplicates ${file}`);
    if (file.localeCompare(previous) <= 0) throw new Error("candidate inventory must be strictly sorted by filename");
    seen.add(file);
    previous = file;
    return {
      file,
      sha256: exactSha(entry.sha256, `candidate inventory ${file}.sha256`),
      sizeBytes: exactInteger(entry.sizeBytes, `candidate inventory ${file}.sizeBytes`),
    };
  });
}

function manifestFileRefs(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("manifest must be an object");
  }
  const targetNames = Object.keys(manifest.targets ?? {}).sort();
  if (targetNames.join(",") !== REQUIRED_TARGETS.join(",")) {
    throw new Error(`manifest target set must be exactly ${REQUIRED_TARGETS.join(",")}`);
  }
  const refs = new Map([
    ["manifest.json", null],
    ["install.sh", null],
    ["install.ps1", null],
  ]);
  const add = (file, sha256, size, label) => {
    const name = required(file, `${label}.file`);
    if (basename(name) !== name || refs.has(name)) throw new Error(`${label} filename is not canonical or unique`);
    refs.set(name, {
      sha256: exactSha(sha256, `${label}.sha256`),
      size: exactInteger(size, `${label}.size`),
    });
  };
  add(manifest.photonWasm?.file, manifest.photonWasm?.sha256, manifest.photonWasm?.size, "photonWasm");
  refs.set(`${manifest.photonWasm.file}.sha256`, null);
  for (const target of targetNames) {
    const row = manifest.targets[target];
    add(row?.file, row?.sha256, row?.size, `${target}.raw`);
    add(row?.gz?.file, row?.gz?.sha256, row?.gz?.size, `${target}.gzip`);
    if (row.gz.file !== `${row.file}.gz`) throw new Error(`${target} gzip filename is not canonical`);
    refs.set(`${row.file}.sha256`, null);
    refs.set(`${row.gz.file}.sha256`, null);
    if (target.startsWith("darwin-")) {
      if (
        row.apple?.signature?.type !== "developer-id-application" ||
        row.apple?.signature?.hardenedRuntime !== true ||
        row.apple?.notarization?.status !== "Accepted" ||
        Number(row.apple?.notarization?.issues) !== 0
      ) {
        throw new Error(`${target} Apple signature/notarization contract drifted`);
      }
      const evidence = row.apple.notarization.evidence;
      add(evidence?.response?.file, evidence?.response?.sha256, evidence?.response?.size, `${target}.notarization.response`);
      add(evidence?.log?.file, evidence?.log?.sha256, evidence?.log?.size, `${target}.notarization.log`);
      const receipt = row.apple.notarization.receipt;
      add(receipt?.file, receipt?.sha256, receipt?.size, `${target}.notarization.receipt`);
    }
  }
  return refs;
}

async function assertSidecar(dir, file, expectedSha) {
  const text = await readFile(join(dir, `${file}.sha256`), "utf8");
  const match = /^([0-9a-f]{64})\s+\*?([^\r\n]+)\r?\n?$/.exec(text);
  if (!match || match[1] !== expectedSha || basename(match[2]) !== file) {
    throw new Error(`candidate SHA-256 sidecar mismatch for ${file}`);
  }
}

async function mapLimit(rows, limit, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, rows.length) }, async () => {
    while (cursor < rows.length) {
      const index = cursor;
      cursor += 1;
      await worker(rows[index]);
    }
  });
  await Promise.all(runners);
}

export async function prepareVerifiedCandidate({
  sourceCommit,
  version,
  channel,
  receiptSha256,
  inventorySha256,
  manifestSha256,
  confirmation,
  fetchImpl = fetch,
  workDir,
}) {
  const source = required(sourceCommit, "--source-commit").toLowerCase();
  if (!COMMIT.test(source)) throw new Error("--source-commit must be a full lowercase Git commit");
  const exactVersion = required(version, "--version");
  if (!VERSION.test(exactVersion)) throw new Error("--version must be an exact stable semver");
  const exactTargetChannel = exactChannel(channel);
  if (confirmation !== expectedConfirmation(exactTargetChannel)) {
    throw new Error("--confirmation did not match the required channel-bound exact phrase");
  }
  const expectedReceiptSha = exactSha(receiptSha256, "--candidate-receipt-sha256");
  const expectedInventorySha = exactSha(inventorySha256, "--candidate-inventory-sha256");
  const expectedManifestSha = exactSha(manifestSha256, "--manifest-sha256");
  const base = candidateBaseUrl(source);
  const dir = required(workDir, "workDir");

  const [receiptBytes, inventoryBytes, manifestBytes] = await Promise.all([
    downloadMetadata(fetchImpl, new URL(`${base}/candidate-receipt.json`), "candidate receipt"),
    downloadMetadata(fetchImpl, new URL(`${base}/candidate-inventory.json`), "candidate inventory"),
    downloadMetadata(fetchImpl, new URL(`${base}/manifest.json`), "manifest"),
  ]);
  if (sha256Bytes(receiptBytes) !== expectedReceiptSha) throw new Error("candidate receipt SHA-256 mismatch");
  if (sha256Bytes(inventoryBytes) !== expectedInventorySha) throw new Error("candidate inventory SHA-256 mismatch");
  if (sha256Bytes(manifestBytes) !== expectedManifestSha) throw new Error("manifest SHA-256 mismatch");

  const receipt = parseJson(receiptBytes, "candidate receipt");
  if (
    receipt.schemaVersion !== 1 ||
    receipt.sourceSha !== source ||
    receipt.version !== exactVersion ||
    receipt.manifestSha256 !== expectedManifestSha ||
    receipt.inventorySha256 !== expectedInventorySha ||
    typeof receipt.nodeVersion !== "string" ||
    !new RegExp(`^computer-v${exactVersion.replaceAll(".", "\\.")}-rc\\.[1-9][0-9]*$`).test(receipt.rcTag)
  ) {
    throw new Error("candidate receipt identity mismatch");
  }
  const inventory = canonicalInventory(parseJson(inventoryBytes, "candidate inventory"));
  const manifest = parseJson(manifestBytes, "manifest");
  if (manifest.version !== exactVersion || manifest.nodeVersion !== receipt.nodeVersion) {
    throw new Error("manifest version or Node carrier mismatch");
  }
  const refs = manifestFileRefs(manifest);
  const inventoryNames = inventory.map((row) => row.file);
  const expectedNames = [...refs.keys()].sort();
  if (inventoryNames.join("\n") !== expectedNames.join("\n")) {
    throw new Error("candidate inventory does not equal the canonical manifest file set");
  }
  const inventoryByFile = new Map(inventory.map((row) => [row.file, row]));
  if (inventoryByFile.get("manifest.json")?.sha256 !== expectedManifestSha) {
    throw new Error("candidate inventory manifest identity mismatch");
  }
  for (const [file, declared] of refs) {
    if (!declared) continue;
    const entry = inventoryByFile.get(file);
    if (entry.sha256 !== declared.sha256 || entry.sizeBytes !== declared.size) {
      throw new Error(`candidate inventory disagrees with manifest for ${file}`);
    }
  }

  await writeFile(join(dir, "manifest.json"), manifestBytes, { flag: "wx" });
  await mapLimit(inventory.filter((entry) => entry.file !== "manifest.json"), 4, async (entry) => {
    const url = new URL(`${base}/${encodeURIComponent(entry.file)}`);
    const path = join(dir, entry.file);
    await downloadFile(fetchImpl, url, path);
  });
  for (const entry of inventory) {
    const path = join(dir, entry.file);
    const [details, actualSha] = await Promise.all([stat(path), sha256File(path)]);
    if (details.size !== entry.sizeBytes || actualSha !== entry.sha256) {
      throw new Error(`candidate file mismatch for ${entry.file}`);
    }
  }
  await assertSidecar(dir, manifest.photonWasm.file, manifest.photonWasm.sha256);
  for (const target of REQUIRED_TARGETS) {
    const row = manifest.targets[target];
    await assertSidecar(dir, row.file, row.sha256);
    await assertSidecar(dir, row.gz.file, row.gz.sha256);
    if (await sha256GunzipFile(join(dir, row.gz.file)) !== row.sha256) {
      throw new Error(`candidate gzip does not expand to the declared raw bytes for ${target}`);
    }
  }
  return {
    artifactBaseUrl: base,
    artifactDir: dir,
    manifestPath: join(dir, "manifest.json"),
    sourceCommit: source,
    version: exactVersion,
    channel: exactTargetChannel,
  };
}

export async function registerExistingHandsRelease(options) {
  const workDir = await mkdtemp(join(tmpdir(), "computer-hands-register-existing-"));
  try {
    const candidate = await prepareVerifiedCandidate({ ...options, workDir });
    const publishImpl = options.publishImpl ?? publishHandsRelease;
    return await publishImpl({
      ...candidate,
      appSlug: "raft-computer-cli",
      channel: candidate.channel,
      mode: "register-or-exact-reuse",
      expectedVersion: candidate.version,
      runId: options.runId,
      runUrl: options.runUrl,
      apiBase: options.apiBase,
      token: options.token,
      api: options.api,
      fetchImpl: options.handsFetchImpl,
    });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await registerExistingHandsRelease({
    sourceCommit: required(args["source-commit"], "--source-commit"),
    version: required(args.version, "--version"),
    channel: required(args.channel, "--channel"),
    receiptSha256: required(args["candidate-receipt-sha256"], "--candidate-receipt-sha256"),
    inventorySha256: required(args["candidate-inventory-sha256"], "--candidate-inventory-sha256"),
    manifestSha256: required(args["manifest-sha256"], "--manifest-sha256"),
    confirmation: required(args.confirmation, "--confirmation"),
    runId: required(args["run-id"], "--run-id"),
    runUrl: required(args["run-url"], "--run-url"),
    apiBase: process.env.HANDS_API ?? "https://hands.build",
    token: process.env.HANDS_BEARER_TOKEN,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
