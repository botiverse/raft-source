#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SHA256 = /^[0-9a-f]{64}$/;
const TARGET = /^(darwin|linux|win32)-(arm64|x64)$/;
const REQUIRED_TARGETS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-x64",
];

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${key} requires a value`);
    result[key.slice(2)] = value;
    index += 1;
  }
  return result;
}

function required(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function safeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return parsed;
}

function exactHttpsUrl(value, name) {
  const url = new URL(required(value, name));
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be a credential-free HTTPS URL without query or fragment`);
  }
  return url;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function descriptor(target, entry, baseUrl) {
  if (!TARGET.test(target)) throw new Error(`unsupported manifest target: ${target}`);
  if (!entry || typeof entry !== "object") throw new Error(`invalid manifest target: ${target}`);
  const rawFile = required(entry.file, `${target}.file`);
  const rawSha256 = required(entry.sha256, `${target}.sha256`).toLowerCase();
  const rawSize = safeInteger(entry.size, `${target}.size`);
  const gzipFile = required(entry.gz?.file, `${target}.gz.file`);
  const gzipSha256 = required(entry.gz?.sha256, `${target}.gz.sha256`).toLowerCase();
  const gzipSize = safeInteger(entry.gz?.size, `${target}.gz.size`);
  if (!SHA256.test(rawSha256) || !SHA256.test(gzipSha256)) {
    throw new Error(`${target} manifest contains an invalid SHA-256`);
  }
  if (basename(rawFile) !== rawFile || basename(gzipFile) !== gzipFile || gzipFile !== `${rawFile}.gz`) {
    throw new Error(`${target} manifest filenames are not canonical`);
  }
  return {
    target,
    source_url: new URL(rawFile, `${baseUrl.href.replace(/\/$/, "")}/`).href,
    raw_sha256: rawSha256,
    raw_size_bytes: rawSize,
    gzip_source_url: new URL(gzipFile, `${baseUrl.href.replace(/\/$/, "")}/`).href,
    gzip_sha256: gzipSha256,
    gzip_size_bytes: gzipSize,
    raw_file: rawFile,
    gzip_file: gzipFile,
  };
}

export async function loadVerifiedTargets({ manifestPath, artifactDir, artifactBaseUrl }) {
  const manifest = JSON.parse(await readFile(resolve(manifestPath), "utf8"));
  const version = required(manifest.version, "manifest.version");
  const nodeVersion = required(manifest.nodeVersion, "manifest.nodeVersion");
  const baseUrl = exactHttpsUrl(artifactBaseUrl, "--artifact-base-url");
  const targetEntries = Object.entries(manifest.targets ?? {}).sort(([left], [right]) => left.localeCompare(right));
  const targetNames = targetEntries.map(([target]) => target);
  if (
    targetNames.length !== REQUIRED_TARGETS.length ||
    targetNames.some((target, index) => target !== REQUIRED_TARGETS[index])
  ) {
    throw new Error(`manifest target set must be exactly ${REQUIRED_TARGETS.join(",")}`);
  }
  const targets = targetEntries.map(([target, entry]) => descriptor(target, entry, baseUrl));
  const dir = resolve(artifactDir);
  for (const target of targets) {
    for (const [file, expectedSha, expectedSize] of [
      [target.raw_file, target.raw_sha256, target.raw_size_bytes],
      [target.gzip_file, target.gzip_sha256, target.gzip_size_bytes],
    ]) {
      const path = join(dir, file);
      const [actualStat, actualSha] = await Promise.all([stat(path), sha256File(path)]);
      if (actualStat.size !== expectedSize || actualSha !== expectedSha) {
        throw new Error(
          `local final artifact mismatch for ${target.target}/${file}: ` +
          `expected ${expectedSize}/${expectedSha}, got ${actualStat.size}/${actualSha}`,
        );
      }
    }
  }
  return { version, nodeVersion, targets };
}

function canonicalTarget(row) {
  return {
    target: row.target,
    source_url: row.source_url,
    raw_sha256: row.raw_sha256,
    raw_size_bytes: Number(row.raw_size_bytes),
    gzip_source_url: row.gzip_source_url ?? `${row.source_url}.gz`,
    gzip_sha256: row.gzip_sha256,
    gzip_size_bytes: Number(row.gzip_size_bytes),
    node_version: row.node_version,
  };
}

function expectedTarget(row, nodeVersion) {
  return canonicalTarget({ ...row, node_version: nodeVersion });
}

export function assertHandsTargetSet(actualRows, expectedRows, nodeVersion) {
  if (!Array.isArray(actualRows)) throw new Error("Hands external-target list is not an array");
  const actual = actualRows.map(canonicalTarget).sort((left, right) => left.target.localeCompare(right.target));
  const expected = expectedRows.map((row) => expectedTarget(row, nodeVersion))
    .sort((left, right) => left.target.localeCompare(right.target));
  if (actual.length !== expected.length) {
    throw new Error(`Hands target count mismatch: expected ${expected.length}, got ${actual.length}`);
  }
  const seen = new Set();
  for (let index = 0; index < expected.length; index += 1) {
    const wanted = expected[index];
    const got = actual[index];
    if (seen.has(got.target)) throw new Error(`Hands target list duplicates ${got.target}`);
    seen.add(got.target);
    for (const field of [
      "target", "raw_sha256", "raw_size_bytes", "gzip_sha256", "gzip_size_bytes", "node_version",
    ]) {
      if (got[field] !== wanted[field]) {
        throw new Error(`Hands target mismatch for ${wanted.target}.${field}`);
      }
    }
    for (const field of ["source_url", "gzip_source_url"]) {
      if (got[field] !== wanted[field]) {
        throw new Error(`Hands target mismatch for ${wanted.target}.${field}`);
      }
    }
  }
}

export function versionCodeFromVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(version);
  if (!match) throw new Error("--version-code is required for a non-semver version");
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  if ([major, minor, patch].some((part) => !Number.isSafeInteger(part) || part > 999)) {
    throw new Error("version components must be between 0 and 999");
  }
  if (match[4]) {
    // Staging versions share the same package triplet across many commits.
    // Reserve the upper safe-integer range and derive a stable 48-bit suffix
    // from the complete version, so an exact workflow rerun reuses its code
    // while different staging commits cannot collapse to the triplet code.
    const suffix = Number.parseInt(createHash("sha256").update(version).digest("hex").slice(0, 12), 16);
    return 2 ** 52 + suffix;
  }
  return major * 1_000_000 + minor * 1_000 + patch;
}

export function createHandsClient({ apiBase, token, fetchImpl = fetch }) {
  const base = exactHttpsUrl(apiBase, "HANDS_API");
  const bearer = required(token, "HANDS_BEARER_TOKEN");
  return async (method, path, body) => {
    const url = new URL(path, base);
    if (url.origin !== base.origin || !url.pathname.startsWith("/api/")) {
      throw new Error("Hands API path escaped the configured origin");
    }
    const response = await fetchImpl(url, {
      method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${bearer}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let payload = text;
    try { payload = text ? JSON.parse(text) : {}; } catch { /* retain text */ }
    if (!response.ok) {
      const error = new Error(`Hands ${method} ${url.pathname} failed with HTTP ${response.status}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  };
}

async function resolveAppAndChannel(api, appSlug, channelSlug) {
  const apps = await api("GET", "/api/apps");
  const matches = (apps.apps ?? []).filter((app) => app.slug === appSlug);
  if (matches.length !== 1) throw new Error(`Hands app '${appSlug}' resolved ${matches.length} times`);
  const appId = matches[0].id;
  const channels = await api("GET", `/api/apps/${appId}/channels`);
  const channelMatches = (channels.channels ?? []).filter((channel) => channel.slug === channelSlug);
  if (channelMatches.length !== 1) {
    throw new Error(`Hands channel '${channelSlug}' resolved ${channelMatches.length} times`);
  }
  return { appId, channelId: channelMatches[0].id };
}

function parseJsonObject(value, name) {
  let parsed = value;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { throw new Error(`${name} is not valid JSON`); }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} is not an object`);
  }
  return parsed;
}

function assertBuildIdentity(build, { buildId, channelId, channel, version, versionCode, sourceCommit, runId, runUrl }) {
  if (
    build.id !== buildId ||
    build.version_name !== version ||
    Number(build.version_code) !== versionCode ||
    build.source !== "external" ||
    build.product_type !== "cli-binary" ||
    build.release_type !== "stable" ||
    (channelId !== undefined && build.channel_id !== channelId) ||
    (channel !== undefined && build.channel !== channel)
  ) {
    throw new Error(`Hands external build identity mismatch for ${version}`);
  }
  const provenance = parseJsonObject(build.provenance_json, "Hands build provenance_json");
  if (
    provenance.source_commit !== sourceCommit ||
    (runId !== undefined && provenance.ci_run_id !== runId) ||
    (runUrl !== undefined && provenance.ci_url !== runUrl) ||
    provenance.ci_provider !== "github-actions"
  ) {
    throw new Error(`Hands external build provenance mismatch for ${version}`);
  }
}

async function findExistingBuild(api, appId, { version, versionCode, sourceCommit }) {
  const response = await api("GET", `/api/apps/${appId}/builds?version_name=${encodeURIComponent(version)}`);
  const matches = (response.builds ?? []).filter((build) => build.version_name === version && build.source === "external");
  if (matches.length !== 1) throw new Error(`Hands external build '${version}' resolved ${matches.length} times`);
  assertBuildIdentity(matches[0], {
    buildId: matches[0].id,
    channel: "alpha",
    version,
    versionCode,
    sourceCommit,
  });
  return matches[0].id;
}

async function findOptionalExactBuild(api, appId, { version, versionCode, sourceCommit }) {
  const response = await api("GET", `/api/apps/${appId}/builds?version_name=${encodeURIComponent(version)}`);
  const matches = (response.builds ?? []).filter((build) => build.version_name === version);
  if (matches.length > 1) {
    throw new Error(`Hands build '${version}' resolved ${matches.length} times`);
  }
  if (matches.length === 0) return null;
  if (matches[0].source !== "external") {
    throw new Error(`Hands build '${version}' exists but is not an external immutable build`);
  }
  assertBuildIdentity(matches[0], {
    buildId: matches[0].id,
    version,
    versionCode,
    sourceCommit,
  });
  return matches[0].id;
}

async function registerTargets(api, { appId, channelId, versionCode, sourceCommit, runId, runUrl, verified }) {
  let buildId = null;
  for (const target of verified.targets) {
    const response = await api("POST", `/api/apps/${appId}/builds/publish-version`, {
      channel_id: channelId,
      version_name: verified.version,
      version_code: versionCode,
      target: target.target,
      source_url: target.source_url,
      raw_sha256: target.raw_sha256,
      raw_size_bytes: target.raw_size_bytes,
      gzip_source_url: target.gzip_source_url,
      gzip_sha256: target.gzip_sha256,
      gzip_size_bytes: target.gzip_size_bytes,
      node_version: verified.nodeVersion,
      product_type: "cli-binary",
      release_type: "stable",
      provenance_json: {
        source_commit: sourceCommit,
        ci_provider: "github-actions",
        ci_run_id: runId,
        ci_url: runUrl,
      },
    });
    if (buildId !== null && response.build_id !== buildId) {
      throw new Error("Hands registered one version into multiple builds");
    }
    buildId = response.build_id;
  }
  return required(buildId, "Hands build_id");
}

function assertExactReleaseDetail(detail, { buildId, channelId, version, releaseId }) {
  const row = detail.release ?? {};
  if (
    row.id !== releaseId ||
    row.build_id !== buildId ||
    row.channel_id !== channelId ||
    row.product_type !== "cli-binary" ||
    row.release_type !== "stable"
  ) {
    throw new Error(`Hands release identity mismatch for ${version}`);
  }
  const scopes = detail.scopes;
  if (!Array.isArray(scopes) || scopes.length !== 1 || scopes[0].scope_type !== "full" || scopes[0].scope_value !== "all") {
    throw new Error(`Hands release ${releaseId} scope drifted before activation`);
  }
  if (!["draft", "active"].includes(row.status) || !Number.isSafeInteger(Number(row.revision))) {
    throw new Error(`Hands release ${releaseId} is not an activatable exact release`);
  }
  return { row, scopes };
}

async function findOptionalExactRelease(
  api,
  { appId, buildId, channelId, version, versionCode },
) {
  const query = new URLSearchParams({
    channel: channelId,
    product_type: "cli-binary",
    release_type: "stable",
    version_code: String(versionCode),
  });
  const response = await api("GET", `/api/apps/${appId}/releases?${query}`);
  const matches = response.releases ?? [];
  if (!Array.isArray(matches)) throw new Error("Hands release list is not an array");
  if (matches.length > 1) {
    throw new Error(`Hands release '${version}' resolved ${matches.length} times on main`);
  }
  if (matches.length === 0) return null;
  const row = matches[0];
  if (
    (buildId !== null && row.build_id !== buildId) ||
    row.channel_id !== channelId ||
    row.product_type !== "cli-binary" ||
    row.release_type !== "stable" ||
    row.version_name !== version ||
    Number(row.version_code) !== versionCode ||
    !["draft", "active"].includes(row.status)
  ) {
    throw new Error(`Hands release identity mismatch for ${version}`);
  }
  return row.id;
}

async function ensureActiveRelease(api, { appId, buildId, channelId, version, existingReleaseId }) {
  let releaseId = existingReleaseId ?? null;
  if (releaseId === null) {
    try {
      const release = await api("POST", `/api/apps/${appId}/releases/draft`, {
        build_id: buildId,
        channel_id: channelId,
        product_type: "cli-binary",
        release_type: "stable",
        scopes: [{ scope_type: "full", scope_value: "all" }],
        provenance_json: { publisher: "raft-computer-release-workflow" },
      });
      releaseId = required(release.id, "Hands release id");
    } catch (error) {
      if (error.status !== 409 || !error.payload?.release_id) throw error;
      releaseId = error.payload.release_id;
    }
  }
  const detail = await api("GET", `/api/apps/${appId}/releases/${releaseId}`);
  const { row, scopes } = assertExactReleaseDetail(detail, {
    buildId, channelId, version, releaseId,
  });
  if (row.status === "active") {
    return { releaseId, revision: Number(row.revision) };
  }
  await api("POST", `/api/apps/${appId}/releases/${releaseId}/publish`, {
    expected_revision: Number(row.revision),
    expected_scopes: scopes,
    required_external_targets: REQUIRED_TARGETS,
  });
  const terminal = await api("GET", `/api/apps/${appId}/releases/${releaseId}`);
  if (
    terminal.release?.status !== "active" ||
    terminal.release?.build_id !== buildId ||
    terminal.release?.channel_id !== channelId ||
    terminal.release?.product_type !== "cli-binary" ||
    terminal.release?.release_type !== "stable"
  ) {
    throw new Error(`Hands release ${releaseId} did not become active`);
  }
  const terminalScopes = terminal.scopes;
  if (
    !Array.isArray(terminalScopes) ||
    terminalScopes.length !== 1 ||
    terminalScopes[0].scope_type !== "full" ||
    terminalScopes[0].scope_value !== "all"
  ) {
    throw new Error(`Hands release ${releaseId} scope drifted after activation`);
  }
  return { releaseId, revision: Number(terminal.release.revision) };
}

export async function publishHandsRelease(options) {
  if (
    options.mode !== undefined &&
    !["register", "promote-existing", "register-or-exact-reuse"].includes(options.mode)
  ) {
    throw new Error(`unsupported publication mode: ${options.mode}`);
  }
  const sourceCommit = required(options.sourceCommit, "--source-commit").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
    throw new Error("--source-commit must be a full 40-character Git commit");
  }
  const runId = required(options.runId, "--run-id");
  const runUrl = exactHttpsUrl(options.runUrl, "--run-url").href;
  const verified = await loadVerifiedTargets(options);
  if (options.expectedVersion && verified.version !== options.expectedVersion) {
    throw new Error(`manifest version ${verified.version} does not match ${options.expectedVersion}`);
  }
  const api = options.api ?? createHandsClient({
    apiBase: options.apiBase,
    token: options.token,
    fetchImpl: options.fetchImpl,
  });
  const { appId, channelId } = await resolveAppAndChannel(api, options.appSlug, options.channel);
  const versionCode = options.versionCode === undefined
    ? versionCodeFromVersion(verified.version)
    : safeInteger(options.versionCode, "--version-code");
  let buildId;
  let buildReused = false;
  let existingReleaseId = null;
  if (options.mode === "register-or-exact-reuse") {
    buildId = await findOptionalExactBuild(api, appId, {
      version: verified.version,
      versionCode,
      sourceCommit,
    });
    existingReleaseId = await findOptionalExactRelease(api, {
      appId,
      buildId,
      channelId,
      version: verified.version,
      versionCode,
    });
    if (buildId === null && existingReleaseId !== null) {
      throw new Error(`Hands release '${verified.version}' exists without one exact external build`);
    }
    if (buildId === null) {
      buildId = await registerTargets(api, {
        appId,
        channelId,
        versionCode,
        sourceCommit,
        runId,
        runUrl,
        verified,
      });
      const build = await api("GET", `/api/apps/${appId}/builds/${buildId}`);
      assertBuildIdentity(build, {
        buildId,
        channelId,
        version: verified.version,
        versionCode,
        sourceCommit,
        runId,
        runUrl,
      });
    } else {
      buildReused = true;
    }
  } else if (options.mode === "promote-existing") {
    buildId = await findExistingBuild(api, appId, {
      version: verified.version,
      versionCode,
      sourceCommit,
    });
    buildReused = true;
  } else {
    buildId = await registerTargets(api, {
      appId,
      channelId,
      versionCode,
      sourceCommit,
      runId,
      runUrl,
      verified,
    });
  }
  if (options.mode !== "promote-existing" && options.mode !== "register-or-exact-reuse") {
    const build = await api("GET", `/api/apps/${appId}/builds/${buildId}`);
    assertBuildIdentity(build, {
      buildId,
      channelId,
      version: verified.version,
      versionCode,
      sourceCommit,
      runId,
      runUrl,
    });
  }
  const listed = await api("GET", `/api/apps/${appId}/builds/${buildId}/external-targets`);
  assertHandsTargetSet(listed.targets, verified.targets, verified.nodeVersion);
  const release = await ensureActiveRelease(api, {
    appId, buildId, channelId, version: verified.version, existingReleaseId,
  });
  return {
    app_id: appId,
    channel_id: channelId,
    build_id: buildId,
    build_reused: buildReused,
    release_id: release.releaseId,
    release_reused: existingReleaseId !== null,
    release_revision: release.revision,
    release_status: "active",
    version: verified.version,
    targets: verified.targets.map((target) => expectedTarget(target, verified.nodeVersion)),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await publishHandsRelease({
    manifestPath: required(args.manifest, "--manifest"),
    artifactDir: required(args["artifact-dir"], "--artifact-dir"),
    artifactBaseUrl: required(args["artifact-base-url"], "--artifact-base-url"),
    appSlug: required(args.app, "--app"),
    channel: required(args.channel, "--channel"),
    mode: args.mode ?? "register",
    versionCode: args["version-code"],
    expectedVersion: args["expected-version"],
    sourceCommit: required(args["source-commit"], "--source-commit"),
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
