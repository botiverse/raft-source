import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  STAGING_CLIENT_ID,
  STAGING_RAFT_API_ORIGIN,
  STAGING_RAFT_ORIGIN,
} from "./render-staging-wrangler.mjs";

export const REQUIRED_SECRET_NAMES = ["FEATURE_FLAG_SESSION_SECRET", "RAFT_CLIENT_SECRET"];

function deploymentMessage(sourceSha, runKey) {
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error("invalid source SHA");
  if (!/^\d+:\d+$/.test(runKey)) throw new Error("invalid GitHub run key");
  return `source_sha=${sourceSha};github_run=${runKey}`;
}

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

export function verifySecretList(raw) {
  const payload = parseJson(raw, "secret list");
  if (!Array.isArray(payload)) throw new Error("secret list must be an array");
  if (payload.some((entry) => typeof entry?.name !== "string" || entry?.type !== "secret_text")) {
    throw new Error("secret list contains an invalid entry");
  }
  const names = payload.map((entry) => entry?.name).filter((name) => typeof name === "string").sort();
  if (JSON.stringify(names) !== JSON.stringify([...REQUIRED_SECRET_NAMES].sort())) {
    throw new Error(`staging Worker secrets must be exactly ${REQUIRED_SECRET_NAMES.join(", ")}`);
  }
}

export function selectVersionId(raw, sourceSha, runKey) {
  const deployments = parseJson(raw, "deployment list");
  if (!Array.isArray(deployments)) throw new Error("deployment list must be an array");
  const message = deploymentMessage(sourceSha, runKey);
  const matches = deployments.filter(
    (deployment) => deployment?.annotations?.["workers/message"] === message,
  );
  if (matches.length !== 1) throw new Error("expected exactly one deployment for source SHA");
  const versions = matches[0]?.versions;
  if (!Array.isArray(versions) || versions.length !== 1 || versions[0]?.percentage !== 100) {
    throw new Error("source deployment must have exactly one version at 100 percent");
  }
  const versionId = versions[0]?.version_id;
  if (typeof versionId !== "string" || !versionId) throw new Error("deployment version id missing");
  return versionId;
}

function oneBinding(bindings, name, type) {
  const matches = bindings.filter((binding) => binding?.name === name && binding?.type === type);
  if (matches.length !== 1) throw new Error(`expected one ${type} binding named ${name}`);
  return matches[0];
}

export function verifyVersion(raw, expected) {
  const version = parseJson(raw, "version readback");
  if (version?.id !== expected.versionId) throw new Error("version id readback mismatch");
  if (version?.annotations?.["workers/message"] !== deploymentMessage(expected.sourceSha, expected.runKey)) {
    throw new Error("source SHA annotation mismatch");
  }
  const bindings = version?.resources?.bindings;
  if (!Array.isArray(bindings)) throw new Error("version bindings missing");

  const expectedText = {
    RAFT_ORIGIN: STAGING_RAFT_ORIGIN,
    RAFT_API_ORIGIN: STAGING_RAFT_API_ORIGIN,
    RAFT_CLIENT_ID: STAGING_CLIENT_ID,
    FEATURE_FLAG_ALLOWED_SERVER_IDS: expected.serverIds,
  };
  for (const [name, text] of Object.entries(expectedText)) {
    if (oneBinding(bindings, name, "plain_text").text !== text) {
      throw new Error(`${name} readback mismatch`);
    }
  }
  if (oneBinding(bindings, "FEATURE_FLAG_PG", "hyperdrive").id !== expected.hyperdriveId) {
    throw new Error("Hyperdrive readback mismatch");
  }
  if (oneBinding(bindings, "FEATURE_FLAG_AUDIT_DB", "d1").id !== expected.d1Id) {
    throw new Error("D1 readback mismatch");
  }
  const secretNames = bindings
    .filter((binding) => binding?.type === "secret_text")
    .map((binding) => binding.name)
    .sort();
  if (JSON.stringify(secretNames) !== JSON.stringify([...REQUIRED_SECRET_NAMES].sort())) {
    throw new Error("version secret binding names mismatch");
  }
}

export function verifyObservabilitySettings(raw) {
  const payload = parseJson(raw, "Worker settings readback");
  if (payload?.success !== true || !payload?.result) {
    throw new Error("staging Worker settings readback failed");
  }
  const observability = payload.result.observability;
  if (
    observability?.enabled !== true
    || observability?.head_sampling_rate !== 1
    || observability?.logs?.enabled !== true
    || observability?.logs?.head_sampling_rate !== 1
    || observability?.logs?.invocation_logs !== true
    || observability?.logs?.persist !== true
  ) {
    throw new Error("staging Worker persisted observability is not fully enabled");
  }
}

async function main() {
  const [mode, file, ...args] = process.argv.slice(2);
  if (!mode || !file) throw new Error("usage: verify-staging-deployment.mjs <secrets|select-version|version|observability> <json-file> [...]");
  const raw = await readFile(file, "utf8");
  if (mode === "secrets") return verifySecretList(raw);
  if (mode === "observability") return verifyObservabilitySettings(raw);
  if (mode === "select-version") {
    if (args.length !== 2) throw new Error("select-version requires source SHA and GitHub run key");
    process.stdout.write(`${selectVersionId(raw, args[0], args[1])}\n`);
    return;
  }
  if (mode === "version") {
    if (args.length !== 6) {
      throw new Error("version requires version id, source SHA, GitHub run key, server ids, Hyperdrive id, and D1 id");
    }
    return verifyVersion(raw, {
      versionId: args[0],
      sourceSha: args[1],
      runKey: args[2],
      serverIds: args[3],
      hyperdriveId: args[4],
      d1Id: args[5],
    });
  }
  throw new Error(`unknown mode: ${mode}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
