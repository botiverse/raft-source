#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const classifier = fileURLToPath(
  new URL("./classify-object-inventory.mjs", import.meta.url),
);

function fail(message) {
  process.stderr.write(`Provider inventory rehearsal failed: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      fail("invalid arguments");
    }
    if (values.has(key)) fail("duplicate argument");
    values.set(key, value);
  }

  const allowed = new Set([
    "--bucket",
    "--source-sha",
    "--version",
    "--positive-control-prefix",
  ]);
  if ([...values.keys()].some((key) => !allowed.has(key))) {
    fail("unknown argument");
  }
  if ([...allowed].some((key) => !values.has(key))) {
    fail("missing argument");
  }

  const sourceSha = values.get("--source-sha");
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) fail("invalid source SHA");

  const version = values.get("--version");
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) fail("invalid version");

  const bucket = values.get("--bucket");
  const positiveControlPrefix = values.get("--positive-control-prefix");
  if (!bucket || !positiveControlPrefix) fail("empty coordinate");

  return { bucket, positiveControlPrefix, sourceSha, version };
}

function classifyProviderResponse(response) {
  const result = spawnSync(
    process.execPath,
    [classifier, "--require-complete"],
    { encoding: "utf8", input: response },
  );
  if (result.error || result.status !== 0) fail("unclassifiable provider response");

  const value = result.stdout.trim();
  if (!/^(0|[1-9][0-9]*)$/.test(value)) fail("invalid classifier output");
  const count = Number(value);
  if (!Number.isSafeInteger(count)) fail("unsafe classifier output");
  return count;
}

function listObjects(bucket, prefix) {
  const result = spawnSync(
    "aws",
    [
      "s3api",
      "list-objects-v2",
      "--bucket",
      bucket,
      "--prefix",
      prefix,
      "--max-keys",
      "1000",
      "--output",
      "json",
    ],
    { encoding: "utf8" },
  );
  if (result.error || result.status !== 0) fail("provider list request failed");
  return classifyProviderResponse(result.stdout);
}

const { bucket, positiveControlPrefix, sourceSha, version } = parseArgs(
  process.argv.slice(2),
);
const candidatePrefix = `computer/candidates/${sourceSha}/`;
if (candidatePrefix === positiveControlPrefix) fail("control prefix collision");

const candidateCount = listObjects(bucket, candidatePrefix);
if (candidateCount !== 0) fail("candidate prefix is not empty");

const positiveControlCount = listObjects(bucket, positiveControlPrefix);
if (positiveControlCount <= 0) fail("positive-control prefix is empty");

process.stdout.write(
  `${JSON.stringify({
    schemaVersion: 1,
    sourceSha,
    version,
    bucket,
    candidatePrefix,
    candidateCount,
    positiveControlPrefix,
    positiveControlCount,
  })}\n`,
);
