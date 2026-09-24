import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { publishHandsRelease, versionCodeFromVersion } from "./publish-hands-release.mjs";

const targets = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-x64",
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "computer-hands-publish-"));
  const manifest = {
    name: "raft-computer-app",
    version: "1.2.3-staging.sha.abcdef123456",
    nodeVersion: "24.15.0",
    targets: {},
  };
  for (const target of targets) {
    const suffix = target === "win32-x64" ? ".exe" : "";
    const file = `raft-computer-${target}${suffix}`;
    const raw = Buffer.from(`raw-${target}`);
    const gzip = Buffer.from(`gzip-${target}`);
    await writeFile(join(dir, file), raw);
    await writeFile(join(dir, `${file}.gz`), gzip);
    manifest.targets[target] = {
      file,
      sha256: sha256(raw),
      size: raw.length,
      gz: { file: `${file}.gz`, sha256: sha256(gzip), size: gzip.length },
    };
  }
  const manifestPath = join(dir, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  return { dir, manifest, manifestPath };
}

function fakeApi(manifest, { mismatchList = false } = {}) {
  const calls = [];
  const listedTargets = [];
  let buildInput;
  let releaseStatus = "draft";
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "GET" && path === "/api/apps") {
      return { apps: [{ id: "app-1", slug: "raft-computer-app" }] };
    }
    if (method === "GET" && path === "/api/apps/app-1/channels") {
      return { channels: [{ id: "channel-alpha", slug: "alpha" }] };
    }
    if (method === "GET" && path.startsWith("/api/apps/app-1/builds?version_name=")) {
      return { builds: [] };
    }
    if (method === "GET" && path.startsWith("/api/apps/app-1/releases?")) {
      return { releases: [] };
    }
    if (method === "POST" && path === "/api/apps/app-1/builds/publish-version") {
      buildInput ??= body;
      if (!listedTargets.some((row) => row.target === body.target)) {
        listedTargets.push({
          target: body.target,
          source_url: body.source_url,
          raw_sha256: body.raw_sha256,
          raw_size_bytes: body.raw_size_bytes,
          gzip_source_url: body.gzip_source_url,
          gzip_sha256: body.gzip_sha256,
          gzip_size_bytes: body.gzip_size_bytes,
          node_version: body.node_version,
        });
      }
      return { build_id: "build-1", target_id: `target-${body.target}` };
    }
    if (method === "GET" && path === "/api/apps/app-1/builds/build-1") {
      return {
        id: "build-1",
        channel_id: "channel-alpha",
        product_type: "cli-binary",
        release_type: "stable",
        version_name: manifest.version,
        version_code: 123456,
        source: "external",
        provenance_json: JSON.stringify(buildInput.provenance_json),
      };
    }
    if (method === "GET" && path === "/api/apps/app-1/builds/build-1/external-targets") {
      return {
        targets: mismatchList
          ? listedTargets.map((row, index) => index === 0 ? { ...row, raw_sha256: "0".repeat(64) } : row)
          : listedTargets,
      };
    }
    if (method === "POST" && path === "/api/apps/app-1/releases/draft") {
      if (releaseStatus === "active") {
        const error = new Error("exact release already exists");
        error.status = 409;
        error.payload = { release_id: "release-1" };
        throw error;
      }
      return { id: "release-1", status: "draft" };
    }
    if (method === "GET" && path === "/api/apps/app-1/releases/release-1") {
      return {
        release: {
          id: "release-1",
          build_id: "build-1",
          channel_id: "channel-alpha",
          product_type: "cli-binary",
          release_type: "stable",
          status: releaseStatus,
          revision: 0,
        },
        scopes: [{ scope_type: "full", scope_value: "all" }],
      };
    }
    if (method === "POST" && path === "/api/apps/app-1/releases/release-1/publish") {
      releaseStatus = "active";
      return { id: "release-1", status: "active" };
    }
    throw new Error(`unexpected API call: ${method} ${path}`);
  };
  return { api, calls };
}

function options(fx, api) {
  return {
    manifestPath: fx.manifestPath,
    artifactDir: fx.dir,
    artifactBaseUrl: `https://cdn.raft.build/computer/${fx.manifest.version}`,
    appSlug: "raft-computer-app",
    channel: "alpha",
    mode: "register",
    versionCode: "123456",
    expectedVersion: fx.manifest.version,
    sourceCommit: "a".repeat(40),
    runId: "32704156860",
    runUrl: "https://github.com/botiverse/slock/actions/runs/32704156860",
    api,
  };
}

test("staging version codes are deterministic per exact prerelease and distinct across commits", () => {
  const first = versionCodeFromVersion("1.0.17-staging.sha.aaaaaaaaaaaa");
  const replay = versionCodeFromVersion("1.0.17-staging.sha.aaaaaaaaaaaa");
  const next = versionCodeFromVersion("1.0.17-staging.sha.bbbbbbbbbbbb");
  assert.equal(first, replay);
  assert.notEqual(first, next);
  assert.equal(Number.isSafeInteger(first), true);
  assert.ok(first >= 2 ** 52);
  assert.equal(versionCodeFromVersion("1.2.3"), 1_002_003);
});

function promoteApi(manifest) {
  const calls = [];
  let releaseStatus = "draft";
  const listedTargets = Object.entries(manifest.targets).map(([target, entry]) => ({
    target,
    source_url: `https://cdn.raft.build/computer/candidates/${"a".repeat(40)}/${entry.file}`,
    raw_sha256: entry.sha256,
    raw_size_bytes: entry.size,
    // The current Hands list endpoint omits gzip_source_url. The publisher
    // must validate the server's documented source_url + ".gz" normalization.
    gzip_sha256: entry.gz.sha256,
    gzip_size_bytes: entry.gz.size,
    node_version: manifest.nodeVersion,
  }));
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "GET" && path === "/api/apps") {
      return { apps: [{ id: "app-1", slug: "raft-computer-app" }] };
    }
    if (method === "GET" && path === "/api/apps/app-1/channels") {
      return { channels: [{ id: "channel-main", slug: "main" }] };
    }
    if (method === "GET" && path.startsWith("/api/apps/app-1/builds?version_name=")) {
      return { builds: [{
        id: "build-1",
        channel: "alpha",
        product_type: "cli-binary",
        release_type: "stable",
        version_name: manifest.version,
        version_code: versionCodeFromVersion(manifest.version),
        source: "external",
        provenance_json: JSON.stringify({
          source_commit: "a".repeat(40),
          ci_provider: "github-actions",
          ci_run_id: "original-rc-run",
          ci_url: "https://github.com/botiverse/slock/actions/runs/original-rc-run",
        }),
      }] };
    }
    if (method === "GET" && path === "/api/apps/app-1/builds/build-1/external-targets") {
      return { targets: listedTargets };
    }
    if (method === "POST" && path === "/api/apps/app-1/releases/draft") {
      return { id: "release-main", status: "draft" };
    }
    if (method === "GET" && path === "/api/apps/app-1/releases/release-main") {
      return {
        release: {
          id: "release-main",
          build_id: "build-1",
          channel_id: "channel-main",
          product_type: "cli-binary",
          release_type: "stable",
          status: releaseStatus,
          revision: 0,
        },
        scopes: [{ scope_type: "full", scope_value: "all" }],
      };
    }
    if (method === "POST" && path === "/api/apps/app-1/releases/release-main/publish") {
      releaseStatus = "active";
      return { id: "release-main", status: "active" };
    }
    throw new Error(`unexpected API call: ${method} ${path}`);
  };
  return { api, calls };
}

function reuseApi(manifest, { releaseStatus = "active", partialTargets = false, duplicateBuilds = false } = {}) {
  const calls = [];
  const versionCode = versionCodeFromVersion(manifest.version);
  const build = {
    id: "build-existing",
    channel: "alpha",
    product_type: "cli-binary",
    release_type: "stable",
    version_name: manifest.version,
    version_code: versionCode,
    source: "external",
    provenance_json: JSON.stringify({
      source_commit: "a".repeat(40),
      ci_provider: "github-actions",
      ci_run_id: "original-run",
      ci_url: "https://github.com/botiverse/slock/actions/runs/original-run",
    }),
  };
  const listedTargets = Object.entries(manifest.targets).map(([target, entry]) => ({
    target,
    source_url: `https://cdn.raft.build/computer/candidates/${"a".repeat(40)}/${entry.file}`,
    raw_sha256: entry.sha256,
    raw_size_bytes: entry.size,
    gzip_sha256: entry.gz.sha256,
    gzip_size_bytes: entry.gz.size,
    node_version: manifest.nodeVersion,
  }));
  let status = releaseStatus;
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "GET" && path === "/api/apps") {
      return { apps: [{ id: "app-1", slug: "raft-computer-app" }] };
    }
    if (method === "GET" && path === "/api/apps/app-1/channels") {
      return { channels: [{ id: "channel-main", slug: "main" }] };
    }
    if (method === "GET" && path.startsWith("/api/apps/app-1/builds?version_name=")) {
      return { builds: duplicateBuilds ? [build, { ...build, id: "build-duplicate" }] : [build] };
    }
    if (method === "GET" && path.startsWith("/api/apps/app-1/releases?")) {
      return {
        releases: status === null ? [] : [{
          id: "release-existing",
          build_id: "build-existing",
          channel_id: "channel-main",
          channel: "main",
          product_type: "cli-binary",
          release_type: "stable",
          version_name: manifest.version,
          version_code: versionCode,
          status,
        }],
      };
    }
    if (method === "GET" && path === "/api/apps/app-1/builds/build-existing/external-targets") {
      return { targets: partialTargets ? listedTargets.slice(0, 4) : listedTargets };
    }
    if (method === "POST" && path === "/api/apps/app-1/releases/draft") {
      return { id: "release-new", status: "draft" };
    }
    if (
      method === "GET" &&
      ["/api/apps/app-1/releases/release-existing", "/api/apps/app-1/releases/release-new"].includes(path)
    ) {
      const id = path.endsWith("release-new") ? "release-new" : "release-existing";
      return {
        release: {
          id,
          build_id: "build-existing",
          channel_id: "channel-main",
          product_type: "cli-binary",
          release_type: "stable",
          status: id === "release-new" ? status ?? "draft" : status,
          revision: 0,
        },
        scopes: [{ scope_type: "full", scope_value: "all" }],
      };
    }
    if (method === "POST" && path.endsWith("/publish")) {
      status = "active";
      return { status };
    }
    throw new Error(`unexpected API call: ${method} ${path}`);
  };
  return { api, calls };
}

test("lists and verifies the complete Hands target set before release activation", async () => {
  const fx = await fixture();
  try {
    const remote = fakeApi(fx.manifest);
    const result = await publishHandsRelease(options(fx, remote.api));
    assert.equal(result.release_id, "release-1");
    const listAt = remote.calls.findIndex((call) => call.path.endsWith("/external-targets"));
    const draftAt = remote.calls.findIndex((call) => call.path.endsWith("/releases/draft"));
    const publishAt = remote.calls.findIndex((call) => call.path.endsWith("/publish"));
    assert.ok(listAt >= 0 && draftAt > listAt && publishAt > draftAt);
    assert.equal(remote.calls.filter((call) => call.path.includes("publish-version")).length, 5);
    assert.deepEqual(remote.calls[publishAt].body.required_external_targets, targets);
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
  }
});

test("a Hands target-list hash mismatch blocks draft creation and activation", async () => {
  const fx = await fixture();
  try {
    const remote = fakeApi(fx.manifest, { mismatchList: true });
    await assert.rejects(
      publishHandsRelease(options(fx, remote.api)),
      /Hands target mismatch for darwin-arm64.raw_sha256/,
    );
    assert.equal(remote.calls.some((call) => call.path.includes("/releases")), false);
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
  }
});

test("a local final-byte mismatch fails before any Hands call", async () => {
  const fx = await fixture();
  try {
    await writeFile(join(fx.dir, fx.manifest.targets["linux-x64"].file), "changed");
    const remote = fakeApi(fx.manifest);
    await assert.rejects(
      publishHandsRelease(options(fx, remote.api)),
      /local final artifact mismatch for linux-x64/,
    );
    assert.equal(remote.calls.length, 0);
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
  }
});

test("an exact rerun re-lists immutable declarations without republishing an active release", async () => {
  const fx = await fixture();
  try {
    const remote = fakeApi(fx.manifest);
    await publishHandsRelease(options(fx, remote.api));
    const replay = await publishHandsRelease(options(fx, remote.api));
    assert.equal(replay.release_id, "release-1");
    assert.equal(remote.calls.filter((call) => call.path.includes("publish-version")).length, 10);
    assert.equal(remote.calls.filter((call) => call.path.endsWith("/external-targets")).length, 2);
    const publishCalls = remote.calls.filter((call) => call.path.endsWith("/publish"));
    assert.equal(publishCalls.length, 1);
    assert.deepEqual(publishCalls[0].body.required_external_targets, targets);
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
  }
});

test("stable promotion reuses the immutable RC target URLs and activates main only after list verification", async () => {
  const fx = await fixture();
  try {
    const remote = promoteApi(fx.manifest);
    const promoted = await publishHandsRelease({
      ...options(fx, remote.api),
      artifactBaseUrl: `https://cdn.raft.build/computer/candidates/${"a".repeat(40)}`,
      channel: "main",
      mode: "promote-existing",
      versionCode: undefined,
    });
    assert.equal(promoted.release_id, "release-main");
    assert.equal(remote.calls.some((call) => call.path.includes("publish-version")), false);
    const listAt = remote.calls.findIndex((call) => call.path.endsWith("/external-targets"));
    const draftAt = remote.calls.findIndex((call) => call.path.endsWith("/releases/draft"));
    assert.ok(listAt >= 0 && draftAt > listAt);
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
  }
});

test("register-or-exact-reuse leaves an exact active build and release byte-for-byte idempotent", async () => {
  const fx = await fixture();
  try {
    const remote = reuseApi(fx.manifest);
    const result = await publishHandsRelease({
      ...options(fx, remote.api),
      artifactBaseUrl: `https://cdn.raft.build/computer/candidates/${"a".repeat(40)}`,
      channel: "main",
      mode: "register-or-exact-reuse",
      versionCode: undefined,
    });
    assert.equal(result.build_id, "build-existing");
    assert.equal(result.release_id, "release-existing");
    assert.equal(remote.calls.some((call) => call.path.includes("publish-version")), false);
    assert.equal(remote.calls.some((call) => call.path.endsWith("/releases/draft")), false);
    assert.equal(remote.calls.some((call) => call.path.endsWith("/publish")), false);
    const buildListAt = remote.calls.findIndex((call) => call.path.includes("/builds?version_name="));
    const releaseListAt = remote.calls.findIndex((call) => call.path.includes("/releases?"));
    const targetListAt = remote.calls.findIndex((call) => call.path.endsWith("/external-targets"));
    assert.ok(buildListAt >= 0 && releaseListAt > buildListAt && targetListAt > releaseListAt);
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
  }
});

test("register-or-exact-reuse registers exactly five targets only after empty build and release reads", async () => {
  const fx = await fixture();
  try {
    const remote = fakeApi(fx.manifest);
    const result = await publishHandsRelease({
      ...options(fx, remote.api),
      mode: "register-or-exact-reuse",
    });
    assert.equal(result.build_id, "build-1");
    assert.equal(remote.calls.filter((call) => call.path.includes("publish-version")).length, 5);
    const buildListAt = remote.calls.findIndex((call) => call.path.includes("/builds?version_name="));
    const releaseListAt = remote.calls.findIndex((call) => call.path.includes("/releases?"));
    const firstWriteAt = remote.calls.findIndex((call) => call.method === "POST");
    assert.ok(buildListAt >= 0 && releaseListAt > buildListAt && firstWriteAt > releaseListAt);
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
  }
});

test("register-or-exact-reuse resumes only an exact draft after target verification", async () => {
  const fx = await fixture();
  try {
    const remote = reuseApi(fx.manifest, { releaseStatus: "draft" });
    const result = await publishHandsRelease({
      ...options(fx, remote.api),
      artifactBaseUrl: `https://cdn.raft.build/computer/candidates/${"a".repeat(40)}`,
      channel: "main",
      mode: "register-or-exact-reuse",
      versionCode: undefined,
    });
    assert.equal(result.release_id, "release-existing");
    assert.equal(remote.calls.some((call) => call.path.includes("publish-version")), false);
    assert.equal(remote.calls.filter((call) => call.path.endsWith("/publish")).length, 1);
    const targetListAt = remote.calls.findIndex((call) => call.path.endsWith("/external-targets"));
    const publishAt = remote.calls.findIndex((call) => call.path.endsWith("/publish"));
    assert.ok(targetListAt >= 0 && publishAt > targetListAt);
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
  }
});

test("register-or-exact-reuse rejects a partial existing target set with zero Hands writes", async () => {
  const fx = await fixture();
  try {
    const remote = reuseApi(fx.manifest, { partialTargets: true });
    await assert.rejects(
      publishHandsRelease({
        ...options(fx, remote.api),
        artifactBaseUrl: `https://cdn.raft.build/computer/candidates/${"a".repeat(40)}`,
        channel: "main",
        mode: "register-or-exact-reuse",
        versionCode: undefined,
      }),
      /Hands target count mismatch: expected 5, got 4/,
    );
    assert.equal(remote.calls.every((call) => call.method === "GET"), true);
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
  }
});

test("register-or-exact-reuse rejects duplicate existing builds before any Hands write", async () => {
  const fx = await fixture();
  try {
    const remote = reuseApi(fx.manifest, { duplicateBuilds: true });
    await assert.rejects(
      publishHandsRelease({
        ...options(fx, remote.api),
        artifactBaseUrl: `https://cdn.raft.build/computer/candidates/${"a".repeat(40)}`,
        channel: "main",
        mode: "register-or-exact-reuse",
        versionCode: undefined,
      }),
      /resolved 2 times/,
    );
    assert.equal(remote.calls.every((call) => call.method === "GET"), true);
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
  }
});
