import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandsClient, publishHandsRelease, versionCodeFromVersion } from "./publish-hands-release.mjs";
import { completeUpload, uploadAsset } from "./hands-hosted-transport.mjs";

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
    version: "1.2.3-staging.20261003085512.sha.abcdef123456",
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
  const first = versionCodeFromVersion("1.0.17-staging.20261003085512.sha.aaaaaaaaaaaa");
  const replay = versionCodeFromVersion("1.0.17-staging.20261003085512.sha.aaaaaaaaaaaa");
  const next = versionCodeFromVersion("1.0.17-staging.20261003090000.sha.bbbbbbbbbbbb");
  assert.equal(first, replay);
  assert.notEqual(first, next);
  assert.equal(Number.isSafeInteger(first), true);
  assert.ok(first >= 2 ** 52);
  assert.equal(versionCodeFromVersion("1.2.3"), 1_002_003);
});

function promoteApi(manifest, { buildChannel = "alpha" } = {}) {
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
        channel: buildChannel,
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

test("stable promotion accepts an RC build from the candidate channel and refuses any other source channel", async () => {
  const fx = await fixture();
  try {
    const promote = (remote) => publishHandsRelease({
      ...options(fx, remote.api),
      artifactBaseUrl: `https://cdn.raft.build/computer/candidates/${"a".repeat(40)}`,
      channel: "main",
      mode: "promote-existing",
      versionCode: undefined,
    });
    const promoted = await promote(promoteApi(fx.manifest, { buildChannel: "candidate" }));
    assert.equal(promoted.release_id, "release-main");
    for (const buildChannel of ["main", "constructed-wake-context"]) {
      const remote = promoteApi(fx.manifest, { buildChannel });
      await assert.rejects(promote(remote), /external build identity mismatch/);
      assert.equal(remote.calls.some((call) => call.path.endsWith("/releases/draft")), false);
    }
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

test("Hands API transport failures name the request and cause codes, never the bearer", async () => {
  const api = createHandsClient({
    apiBase: "https://hands.build",
    token: "bearer-must-not-leak",
    fetchImpl: async () => {
      const cause = Object.assign(new Error("other side closed https://x/?sig=must-not-leak"), { code: "UND_ERR_SOCKET" });
      throw new TypeError("fetch failed", { cause });
    },
  });
  await assert.rejects(api("POST", "/api/apps/a1/builds/b1/assets/uploads", {}), (error) => {
    assert.equal(error.message, "Hands POST /api/apps/a1/builds/b1/assets/uploads transport failed (TypeError <- UND_ERR_SOCKET)");
    return true;
  });
});

test("direct upload transport failures name the asset and host/path, never the signed query", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "hands-upload-test-"));
  try {
    const path = join(workDir, "raft-computer-linux-x64");
    await writeFile(path, "bytes");
    const api = async () => ({
      state: "pending",
      asset_id: "as1",
      upload: { method: "PUT", url: "https://r2.example.com/bucket/key?X-Amz-Signature=must-not-leak", headers: {} },
      complete_url: "/api/apps/a1/builds/b1/assets/as1/upload/complete",
    });
    let body;
    const fetchImpl = async (_url, init) => {
      body = init.body;
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
    };
    await assert.rejects(
      uploadAsset({
        api, appId: "a1", buildId: "b1", fetchImpl, recovery: { sleep: async () => {} }, log: () => {},
        asset: { artifact_kind: "binary", platform: "linux", arch: "x64", filetype: "bin", sha256: "0".repeat(64), size_bytes: 5, file: "raft-computer-linux-x64", path },
      }),
      (error) => {
        assert.match(error.message, /^Hands direct upload transport failed: raft-computer-linux-x64 \(5 bytes\) -> r2\.example\.com\/bucket\/key after \d+ ms \(TypeError <- ECONNRESET\)$/);
        assert.doesNotMatch(error.message, /must-not-leak|Signature/);
        return true;
      },
    );
    // The file stream's open must settle before the caller can remove the file;
    // a still-pending open fails later as an uncaught ENOENT.
    assert.equal(body.closed, true);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("a failed direct upload names the host, size, edge request ids and the error body, never signature material", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "hands-upload-test-"));
  try {
    const path = join(workDir, "raft-computer-linux-x64");
    await writeFile(path, "bytes");
    const api = async () => ({
      state: "pending",
      asset_id: "as1",
      upload: { method: "PUT", url: "https://acct.r2.cloudflarestorage.com/bucket/key?X-Amz-Signature=must-not-leak", headers: {} },
      complete_url: "/api/apps/a1/builds/b1/assets/as1/upload/complete",
    });
    const errorBody = "<Error><Code>InternalError</Code><Message>We encountered an internal error.</Message>"
      + "<StringToSign>AWS4-HMAC-SHA256 must-not-leak</StringToSign><Resource>/bucket/key?X-Amz-Credential=AKIA-must-not-leak</Resource></Error>";
    const fetchImpl = async () => new Response(errorBody, {
      status: 504,
      headers: { "cf-ray": "8d1f2e3a4b5c6d7e-SJC", "x-amz-request-id": "req-123", "server": "cloudflare" },
    });
    await assert.rejects(
      uploadAsset({
        api, appId: "a1", buildId: "b1", fetchImpl, recovery: { sleep: async () => {} }, log: () => {},
        asset: { artifact_kind: "binary", platform: "linux", arch: "x64", filetype: "bin", sha256: "0".repeat(64), size_bytes: 5, file: "raft-computer-linux-x64", path },
      }),
      (error) => {
        assert.match(error.message, /^Hands direct upload failed: HTTP 504: raft-computer-linux-x64 \(5 bytes\) -> acct\.r2\.cloudflarestorage\.com\/bucket\/key; after \d+ ms; /);
        assert.match(error.message, /cf-ray=8d1f2e3a4b5c6d7e-SJC x-amz-request-id=req-123 server=cloudflare/);
        assert.match(error.message, /<Code>InternalError<\/Code>/);
        assert.doesNotMatch(error.message, /must-not-leak/);
        return true;
      },
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

async function retryFixture(statuses, run) {
  const workDir = await mkdtemp(join(tmpdir(), "hands-upload-retry-"));
  try {
    const path = join(workDir, "raft-computer-darwin-arm64");
    await writeFile(path, "bytes");
    let links = 0;
    const calls = [];
    const api = async (method, apiPath) => {
      calls.push(`${method} ${apiPath}`);
      if (apiPath.endsWith("/assets/uploads")) {
        links += 1;
        return {
          state: "pending",
          asset_id: "as1",
          upload: { method: "PUT", url: `https://acct.r2.cloudflarestorage.com/bucket/key?link=${links}&X-Amz-Signature=must-not-leak`, headers: {} },
          complete_url: "/api/apps/a1/builds/b1/assets/as1/upload/complete",
        };
      }
      if (apiPath.endsWith("/upload/complete")) return { state: "ready" };
      throw new Error(`unexpected ${method} ${apiPath}`);
    };
    const putLinks = [];
    const fetchImpl = async (url) => {
      putLinks.push(new URL(url).searchParams.get("link"));
      const status = statuses.shift();
      if (status === "reset") throw new TypeError("fetch failed", { cause: Object.assign(new Error("socket"), { code: "UND_ERR_SOCKET" }) });
      return new Response(status === 200 ? null : "<Error><Code>X</Code></Error>", { status });
    };
    const slept = [];
    const logged = [];
    const asset = { artifact_kind: "binary", platform: "darwin", arch: "arm64", filetype: "bin", sha256: "0".repeat(64), size_bytes: 5, file: "raft-computer-darwin-arm64", path };
    const upload = () => uploadAsset({ api, appId: "a1", buildId: "b1", fetchImpl, asset, recovery: { sleep: async (ms) => { slept.push(ms); } }, log: (line) => logged.push(line) });
    await run({ upload, calls, putLinks, slept, logged });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

test("a direct upload that fails with 504 or a reset is retried for that asset only, with a fresh link each time", async () => {
  await retryFixture([504, "reset", 200], async ({ upload, calls, putLinks, slept, logged }) => {
    await upload();
    assert.deepEqual(putLinks, ["1", "2", "3"], "every attempt asks Hands for a new link");
    assert.deepEqual(slept, [10_000, 30_000]);
    assert.equal(calls.filter((call) => call.endsWith("/upload/complete")).length, 1, "completed once, after the PUT that passed");
    assert.match(logged[0], /attempt 1\/3 failed \(http_504\)/);
    assert.match(logged[1], /attempt 2\/3 failed \(transport\)/);
    assert.doesNotMatch(logged.join("\n"), /must-not-leak/);
  });
});

test("a 403 on the direct upload is reported as a rejected link and retried with a fresh one", async () => {
  await retryFixture([403, 200], async ({ upload, logged, putLinks }) => {
    await upload();
    assert.deepEqual(putLinks, ["1", "2"]);
    assert.match(logged[0], /\(link_rejected\).*upload link rejected \(expired or invalid\): HTTP 403/);
  });
});

test("a direct upload gives up after three attempts, and never retries a 4xx other than 403/408/429", async () => {
  await retryFixture([500, 502, 504], async ({ upload, putLinks }) => {
    await assert.rejects(upload(), /Hands direct upload failed: HTTP 504/);
    assert.equal(putLinks.length, 3);
  });
  await retryFixture([400], async ({ upload, putLinks, slept }) => {
    await assert.rejects(upload(), /Hands direct upload failed: HTTP 400/);
    assert.deepEqual(putLinks, ["1"]);
    assert.deepEqual(slept, []);
  });
});

test("a timed-out Hands API request names TimeoutError, not the numeric DOMException code", async () => {
  const api = createHandsClient({
    apiBase: "https://hands.build",
    token: "bearer-must-not-leak",
    fetchImpl: async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); },
  });
  await assert.rejects(api("POST", "/api/apps/a1/builds/b1/assets/as1/upload/complete", {}), (error) => {
    assert.equal(error.message, "Hands POST /api/apps/a1/builds/b1/assets/as1/upload/complete transport failed (TimeoutError)");
    return true;
  });
});

function fakeClock(start = 1_000_000) {
  let t = start;
  const slept = [];
  return { now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; }, slept };
}
const busy = (payload = {}) => Object.assign(new Error("Hands POST complete failed with HTTP 409"), { status: 409, payload: { code: "ASSET_UPLOAD_BUSY", ...payload }, retryAfter: null });
const verifyingAsset = { artifact_kind: "binary", platform: "linux", arch: "arm64", filetype: "gz", sha256: "0".repeat(64), size_bytes: 5, file: "raft-computer-linux-arm64.gz", path: "/nonexistent" };

test("a verifying asset (old Hands: no lease fields) waits and retries completion, never re-uploads", async () => {
  const clock = fakeClock();
  const calls = [];
  let completes = 0;
  const api = async (method, path) => {
    calls.push(`${method} ${path}`);
    if (path.endsWith("/assets/uploads")) return { state: "verifying", asset_id: "as1", upload: null, complete_url: "/api/apps/a1/builds/b1/assets/as1/upload/complete" };
    if (path.endsWith("/upload/complete")) { completes += 1; if (completes < 3) throw busy(); return { state: "ready" }; }
    throw new Error(`unexpected ${method} ${path}`);
  };
  await uploadAsset({ api, appId: "a1", buildId: "b1", asset: verifyingAsset, fetchImpl: async () => { throw new Error("must not PUT"); }, recovery: { now: clock.now, sleep: clock.sleep } });
  assert.equal(completes, 3);
  assert.ok(clock.slept.length >= 3 && clock.slept.every((ms) => ms >= 1_000), String(clock.slept));
  assert.ok(calls.every((c) => !c.includes(" PUT ")));
});

test("a completion that times out client-side is settled by reading state, not by re-uploading", async () => {
  const clock = fakeClock();
  const calls = [];
  const api = async (method, path) => {
    calls.push(`${method} ${path}`);
    if (path.endsWith("/upload/complete")) throw Object.assign(new Error("Hands POST … transport failed (TimeoutError)"), { transport: true });
    if (method === "GET" && path.endsWith("/assets/as1/upload")) return { state: "ready" };
    throw new Error(`unexpected ${method} ${path}`);
  };
  await completeUpload({ api, appId: "a1", buildId: "b1", assetId: "as1", path: "/api/apps/a1/builds/b1/assets/as1/upload/complete", now: clock.now, sleep: clock.sleep });
  assert.deepEqual(calls, ["POST /api/apps/a1/builds/b1/assets/as1/upload/complete", "GET /api/apps/a1/builds/b1/assets/as1/upload"]);
});

test("lease and upload-expiry fields (new Hands) drive the wait and bound the total", async () => {
  const clock = fakeClock(1_000_000);
  const lease = 1_000_000 + 90_000;
  const api = async () => { throw busy({ verifier_lease_expires_at: lease, upload_expires_at: 1_000_000 + 100_000 }); };
  await assert.rejects(
    completeUpload({ api, appId: "a1", buildId: "b1", assetId: "as1", path: "/x/upload/complete", now: clock.now, sleep: clock.sleep }),
    /did not finish before its deadline \(last: ASSET_UPLOAD_BUSY\)/,
  );
  assert.equal(clock.slept[0], 91_000);
});
