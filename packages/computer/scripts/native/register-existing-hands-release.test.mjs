import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import {
  prepareVerifiedCandidate,
  registerExistingHandsRelease,
} from "./register-existing-hands-release.mjs";

// Asserts on private CI/deploy files that the source-available snapshot does not
// carry; skipped when an exported snapshot's RELEASE_SOURCE marker is present.
const inSourceSnapshot = existsSync(new URL("../../../../RELEASE_SOURCE", import.meta.url));

const sourceCommit = "a".repeat(40);
const version = "1.2.3";
const confirmation = "REGISTER-EXACT-RAFT-COMPUTER-CLI-MAIN";
const targetNames = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-x64",
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function makeFixture({ wrongExpandedTarget = null, version: fixtureVersion = version, featureChannel = null } = {}) {
  const files = new Map();
  const put = (name, bytes) => {
    const body = Buffer.from(bytes);
    files.set(name, body);
    return { file: name, sha256: sha256(body), size: body.length };
  };
  put("install.sh", "#!/bin/sh\nexit 0\n");
  put("install.ps1", "exit 0\r\n");
  const photon = put("photon_rs_bg.wasm", "wasm-fixture");
  put("photon_rs_bg.wasm.sha256", `${photon.sha256}  ${photon.file}\n`);
  const targets = {};
  for (const target of targetNames) {
    const suffix = target === "win32-x64" ? ".exe" : "";
    const name = `raft-computer-${target}${suffix}`;
    const raw = put(name, `raw-${target}`);
    const gzipInput = wrongExpandedTarget === target ? Buffer.from("wrong-expanded-bytes") : files.get(name);
    const gzip = put(`${name}.gz`, gzipSync(gzipInput, { mtime: 0 }));
    put(`${name}.sha256`, `${raw.sha256}  ${name}\n`);
    put(`${name}.gz.sha256`, `${gzip.sha256}  ${name}.gz\n`);
    const row = {
      ...raw,
      gz: gzip,
    };
    if (target.startsWith("darwin-")) {
      const response = put(`${name}.notarization.json`, `response-${target}`);
      const log = put(`${name}.notarization.log.json`, `log-${target}`);
      const receipt = put(`${name}.notarization.receipt.json`, `receipt-${target}`);
      row.apple = {
        signature: {
          type: "developer-id-application",
          teamId: "TEAM123456",
          cdHash: "a".repeat(40),
          hardenedRuntime: true,
        },
        notarization: {
          status: "Accepted",
          issues: 0,
          evidence: { response, log },
          receipt,
        },
      };
    }
    targets[target] = row;
  }
  const manifest = { version: fixtureVersion, nodeVersion: "24.15.0", photonWasm: photon, targets };
  const manifestBytes = jsonBytes(manifest);
  files.set("manifest.json", manifestBytes);
  const inventory = [...files.entries()]
    .map(([file, bytes]) => ({ file, sha256: sha256(bytes), sizeBytes: bytes.length }))
    .sort((left, right) => left.file.localeCompare(right.file));
  const inventoryBytes = jsonBytes(inventory);
  const receipt = {
    schemaVersion: 1,
    sourceSha: sourceCommit,
    ...(featureChannel ? { featureChannel } : { rcTag: `computer-v${fixtureVersion}-rc.1` }),
    version: fixtureVersion,
    nodeVersion: "24.15.0",
    manifestSha256: sha256(manifestBytes),
    inventorySha256: sha256(inventoryBytes),
  };
  const receiptBytes = jsonBytes(receipt);
  files.set("candidate-receipt.json", receiptBytes);
  files.set("candidate-inventory.json", inventoryBytes);
  return {
    files,
    receiptSha256: sha256(receiptBytes),
    inventorySha256: sha256(inventoryBytes),
    manifestSha256: sha256(manifestBytes),
  };
}

function fixtureFetch(fixture, calls) {
  return async (url, init) => {
    const parsed = new URL(url);
    calls.push({ url: parsed.href, init });
    const prefix = `https://cdn.raft.build/computer/candidates/${sourceCommit}/`;
    assert.ok(parsed.href.startsWith(prefix), `escaped candidate origin: ${parsed.href}`);
    const name = decodeURIComponent(parsed.pathname.split("/").at(-1));
    const body = fixture.files.get(name);
    return body
      ? new Response(body, { status: 200, headers: { "content-length": String(body.length) } })
      : new Response("missing", { status: 404 });
  };
}

function verifierOptions(fixture, fetchImpl) {
  return {
    sourceCommit,
    version,
    channel: "main",
    receiptSha256: fixture.receiptSha256,
    inventorySha256: fixture.inventorySha256,
    manifestSha256: fixture.manifestSha256,
    confirmation,
    fetchImpl,
  };
}

test("verifies the complete canonical candidate, every sidecar, and gzip-to-raw identity", async () => {
  const fixture = makeFixture();
  const calls = [];
  const workDir = await mkdtemp("/tmp/hands-existing-test-");
  try {
    const verified = await prepareVerifiedCandidate({
      ...verifierOptions(fixture, fixtureFetch(fixture, calls)),
      workDir,
    });
    assert.equal(verified.artifactBaseUrl, `https://cdn.raft.build/computer/candidates/${sourceCommit}`);
    assert.equal(calls.length, fixture.files.size);
    assert.equal(calls.every((call) => call.init.redirect === "error"), true);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("candidate transport errors identify only the canonical host and pathname", async () => {
  const fixture = makeFixture();
  const workDir = await mkdtemp("/tmp/hands-existing-test-");
  try {
    await assert.rejects(
      prepareVerifiedCandidate({
        ...verifierOptions(fixture, async () => {
          throw new TypeError("fetch failed with bearer=must-not-leak");
        }),
        workDir,
      }),
      (error) => {
        assert.match(
          error.message,
          /^candidate download transport failed: cdn\.raft\.build\/computer\/candidates\/[a-f0-9]{40}\/(?:candidate-receipt|candidate-inventory|manifest)\.json$/,
        );
        assert.doesNotMatch(error.message, /bearer|must-not-leak|https?:\/\//);
        return true;
      },
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("a metadata mismatch fails before the first Hands API call", async () => {
  const fixture = makeFixture();
  const apiCalls = [];
  await assert.rejects(
    registerExistingHandsRelease({
      ...verifierOptions(fixture, fixtureFetch(fixture, [])),
      receiptSha256: "0".repeat(64),
      runId: "run-1",
      runUrl: "https://github.com/botiverse/slock/actions/runs/run-1",
      api: async (...args) => {
        apiCalls.push(args);
        throw new Error("Hands must not be called");
      },
    }),
    /candidate receipt SHA-256 mismatch/,
  );
  assert.equal(apiCalls.length, 0);
});

test("a gzip declaration that expands to different raw bytes is rejected before Hands", async () => {
  const fixture = makeFixture({ wrongExpandedTarget: "linux-x64" });
  const apiCalls = [];
  await assert.rejects(
    registerExistingHandsRelease({
      ...verifierOptions(fixture, fixtureFetch(fixture, [])),
      runId: "run-1",
      runUrl: "https://github.com/botiverse/slock/actions/runs/run-1",
      api: async (...args) => {
        apiCalls.push(args);
        throw new Error("Hands must not be called");
      },
    }),
    /gzip does not expand to the declared raw bytes for linux-x64/,
  );
  assert.equal(apiCalls.length, 0);
});

test("shell-like source input is rejected without candidate or Hands network access", async () => {
  const fixture = makeFixture();
  let candidateCalls = 0;
  let apiCalls = 0;
  await assert.rejects(
    registerExistingHandsRelease({
      ...verifierOptions(fixture, async () => {
        candidateCalls += 1;
        throw new Error("candidate network must not be called");
      }),
      sourceCommit: `${sourceCommit};touch-pwned`,
      runId: "run-1",
      runUrl: "https://github.com/botiverse/slock/actions/runs/run-1",
      api: async () => {
        apiCalls += 1;
        throw new Error("Hands must not be called");
      },
    }),
    /full lowercase Git commit/,
  );
  assert.equal(candidateCalls, 0);
  assert.equal(apiCalls, 0);
});

test("alpha is an exact supported channel and reaches the publisher with channel-bound confirmation", async () => {
  const fixture = makeFixture();
  let published;
  const result = await registerExistingHandsRelease({
    ...verifierOptions(fixture, fixtureFetch(fixture, [])),
    channel: "alpha",
    confirmation: "REGISTER-EXACT-RAFT-COMPUTER-CLI-ALPHA",
    runId: "run-1",
    runUrl: "https://github.com/botiverse/slock/actions/runs/run-1",
    publishImpl: async (options) => {
      published = options;
      return { channel_id: "channel-alpha" };
    },
  });
  assert.equal(result.channel_id, "channel-alpha");
  assert.equal(published.channel, "alpha");
  assert.equal(published.mode, "register-or-exact-reuse");
});

test("candidate is an exact RC channel: an RC receipt registers there, a feature receipt cannot", async () => {
  const fixture = makeFixture();
  let published;
  const result = await registerExistingHandsRelease({
    ...verifierOptions(fixture, fixtureFetch(fixture, [])),
    channel: "candidate",
    confirmation: "REGISTER-EXACT-RAFT-COMPUTER-CLI-CANDIDATE",
    runId: "run-1",
    runUrl: "https://github.com/botiverse/slock/actions/runs/run-1",
    publishImpl: async (options) => {
      published = options;
      return { channel_id: "channel-candidate" };
    },
  });
  assert.equal(result.channel_id, "channel-candidate");
  assert.equal(published.channel, "candidate");
  assert.equal(published.mode, "register-or-exact-reuse");
  // A feature build stamped `-candidate.<n>` is refused: candidate takes
  // exact stable semver from an RC receipt only.
  const feature = makeFixture({ version: "1.0.33-candidate.1", featureChannel: "candidate" });
  await assert.rejects(
    registerExistingHandsRelease({
      ...verifierOptions(feature, fixtureFetch(feature, [])),
      version: "1.0.33-candidate.1",
      channel: "candidate",
      confirmation: "REGISTER-EXACT-RAFT-COMPUTER-CLI-CANDIDATE",
      runId: "run-1",
      runUrl: "https://github.com/botiverse/slock/actions/runs/run-1",
      publishImpl: async () => { throw new Error("Hands must not be called"); },
    }),
    /exact stable semver/,
  );
});

// task #816 — a named feature channel is an exact supported channel; its
// version must carry the channel's own suffix.
test("a named feature channel reaches the publisher with its slug and a channel-stamped version", async () => {
  const fixture = makeFixture({ version: "1.0.33-constructed-wake-context.1", featureChannel: "constructed-wake-context" });
  let published;
  const result = await registerExistingHandsRelease({
    ...verifierOptions(fixture, fixtureFetch(fixture, [])),
    version: "1.0.33-constructed-wake-context.1",
    channel: "constructed-wake-context",
    confirmation: "REGISTER-EXACT-RAFT-COMPUTER-CLI-CONSTRUCTED-WAKE-CONTEXT",
    runId: "run-1",
    runUrl: "https://github.com/botiverse/slock/actions/runs/run-1",
    publishImpl: async (options) => {
      published = options;
      return { channel_id: "channel-cwc" };
    },
  });
  assert.equal(result.channel_id, "channel-cwc");
  assert.equal(published.channel, "constructed-wake-context");
  assert.equal(published.mode, "register-or-exact-reuse");
});

test("a feature channel refuses a plain semver, a version stamped for another channel, and reserved cohort words", async () => {
  const fixture = makeFixture();
  for (const options of [
    { channel: "constructed-wake-context", version: "1.0.33", confirmation: "REGISTER-EXACT-RAFT-COMPUTER-CLI-CONSTRUCTED-WAKE-CONTEXT", expected: /must be <major>\.<minor>\.<patch>-constructed-wake-context/ },
    { channel: "constructed-wake-context", version: "1.0.33-other-feature.1", confirmation: "REGISTER-EXACT-RAFT-COMPUTER-CLI-CONSTRUCTED-WAKE-CONTEXT", expected: /must be <major>\.<minor>\.<patch>-constructed-wake-context/ },
    { channel: "main", version: "1.0.33-constructed-wake-context.1", confirmation: "REGISTER-EXACT-RAFT-COMPUTER-CLI-MAIN", expected: /exact stable semver/ },
    { channel: "stable", version: "1.0.33-stable.1", confirmation: "REGISTER-EXACT-RAFT-COMPUTER-CLI-STABLE", expected: /named feature channel/ },
    { channel: "Constructed-Wake-Context", version: "1.0.33-constructed-wake-context.1", confirmation: "REGISTER-EXACT-RAFT-COMPUTER-CLI-CONSTRUCTED-WAKE-CONTEXT", expected: /named feature channel/ },
  ]) {
    let candidateCalls = 0;
    let publishCalls = 0;
    const { expected, ...rest } = options;
    await assert.rejects(
      registerExistingHandsRelease({
        ...verifierOptions(fixture, async () => {
          candidateCalls += 1;
          throw new Error("candidate network must not be called");
        }),
        ...rest,
        runId: "run-1",
        runUrl: "https://github.com/botiverse/slock/actions/runs/run-1",
        publishImpl: async () => {
          publishCalls += 1;
          throw new Error("Hands must not be called");
        },
      }),
      expected,
    );
    assert.equal(candidateCalls, 0, `${options.channel}/${options.version}: no candidate access`);
    assert.equal(publishCalls, 0, `${options.channel}/${options.version}: no Hands access`);
  }
});

test("receipt identity is channel-bound: an RC receipt cannot register to a feature channel and vice versa", async () => {
  // RC receipt (rcTag) presented for a feature channel with a matching stamped version.
  const rcFixture = makeFixture({ version: "1.0.33-constructed-wake-context.1" });
  let publishCalls = 0;
  await assert.rejects(
    registerExistingHandsRelease({
      ...verifierOptions(rcFixture, fixtureFetch(rcFixture, [])),
      version: "1.0.33-constructed-wake-context.1",
      channel: "constructed-wake-context",
      confirmation: "REGISTER-EXACT-RAFT-COMPUTER-CLI-CONSTRUCTED-WAKE-CONTEXT",
      runId: "run-1",
      runUrl: "https://github.com/botiverse/slock/actions/runs/run-1",
      publishImpl: async () => { publishCalls += 1; throw new Error("Hands must not be called"); },
    }),
    /candidate receipt identity mismatch/,
  );
  // Feature receipt presented for main.
  const featureFixture = makeFixture({ featureChannel: "constructed-wake-context" });
  await assert.rejects(
    registerExistingHandsRelease({
      ...verifierOptions(featureFixture, fixtureFetch(featureFixture, [])),
      runId: "run-1",
      runUrl: "https://github.com/botiverse/slock/actions/runs/run-1",
      publishImpl: async () => { publishCalls += 1; throw new Error("Hands must not be called"); },
    }),
    /candidate receipt identity mismatch/,
  );
  assert.equal(publishCalls, 0);
});

test("unsupported or confirmation-mismatched channel fails before candidate and Hands access", async () => {
  const fixture = makeFixture();
  for (const options of [
    { channel: "rc", confirmation: "REGISTER-EXACT-RAFT-COMPUTER-CLI-RC" },
    { channel: "alpha", confirmation: "REGISTER-EXACT-RAFT-COMPUTER-CLI-MAIN" },
  ]) {
    let candidateCalls = 0;
    let publishCalls = 0;
    await assert.rejects(
      registerExistingHandsRelease({
        ...verifierOptions(fixture, async () => {
          candidateCalls += 1;
          throw new Error("candidate network must not be called");
        }),
        ...options,
        runId: "run-1",
        runUrl: "https://github.com/botiverse/slock/actions/runs/run-1",
        publishImpl: async () => {
          publishCalls += 1;
          throw new Error("Hands must not be called");
        },
      }),
      /--channel must be exactly main, alpha, candidate, or a named feature channel|channel-bound exact phrase/,
    );
    assert.equal(candidateCalls, 0);
    assert.equal(publishCalls, 0);
  }
});

test.skipIf(inSourceSnapshot)("register-only workflow is staging-bound and contains no tag, CDN, upload, build, or signing authority", async () => {
  const workflowUrl = new URL("../../../../.github/workflows/register-computer-hands-release.yml", import.meta.url);
  const workflow = await readFile(workflowUrl, "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /permissions:\n  contents: read\n/);
  assert.match(workflow, /test "\$GITHUB_REF" = "refs\/heads\/staging"/);
  assert.match(workflow, /test "\$\(git rev-parse origin\/staging\)" = "\$GITHUB_SHA"/);
  assert.match(workflow, /HANDS_BEARER_TOKEN: \$\{\{ secrets\.HANDS_COMPUTER_DEPLOY_TOKEN \}\}/);
  assert.match(workflow, /register-existing-hands-release\.mjs/);
  assert.match(workflow, /channel:\n        description: Exact Hands channel to anchor[\s\S]*options:\n          - main\n          - alpha\n          - candidate\n/);
  assert.match(workflow, /--channel "\$CHANNEL"/);
  const runBlocks = workflow.split("        run: |").slice(1).join("\n");
  assert.doesNotMatch(runBlocks, /\$\{\{ inputs\./, "workflow inputs must reach shell only through env bindings");
  assert.doesNotMatch(workflow, /\b(?:aws|wrangler|gh)\b|R2_|ACCESS_KEY|upload-artifact|git\s+(?:tag|push)|npm\s+run\s+build|notari[sz]|codesign/);
  assert.equal((workflow.match(/secrets\./g) ?? []).length, 1);
});
