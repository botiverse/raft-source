// kReleaseSource contract tests (#wg-k task #2).
//
// The teeth mirror the fail-closed clauses in kReleaseSource.ts:
//  - null strictly means "already current" — a failed look THROWS
//  - an older latest-pointer is not an update (no automatic downgrade)
//  - size must be manifest-attested, never borrowed from the byte server
//  - pre-release precedence follows SemVer identifiers, not lexical strings
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  compareComputerVersions,
  createComputerReleaseSource as createReleaseSource,
  resolveComputerUpgradeTargetVersion,
} from "./kReleaseSource.js";
import { ComputerServiceError } from "./services/errors.js";
import type {
  HandsUpdater,
  HandsUpdaterOptions,
  UpdateCandidate,
  UpdateCheckInput,
} from "@botiverse/hands-node/updater";

function createComputerReleaseSource(
  baseUrl: string,
  deps: Parameters<typeof createReleaseSource>[1] = {},
) {
  return createReleaseSource(baseUrl, { ...deps, backend: "legacy-cdn" });
}

const CTX = { currentVersion: "1.0.16", platformKey: "linux-x64" };
const DEVICE_ID = "123e4567-e89b-4d3a-a456-426614174000";

function fakeFetch(routes: Record<string, unknown | number>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const path = new URL(url).pathname;
    const route = routes[path];
    if (route === undefined) return new Response("", { status: 404 });
    if (typeof route === "number") return new Response("", { status: route });
    return new Response(JSON.stringify(route), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function targetsFor(size: unknown = 1234): unknown {
  return {
    targets: {
      "linux-x64": { file: "raft-computer-linux-x64", sha256: "ab".repeat(32), size },
    },
  };
}

test("checkForUpdate maps a newer pointer to a complete Release (url/sha256/size)", async () => {
  const source = createComputerReleaseSource("https://cdn.example/computer/", {
    fetchFn: fakeFetch({
      "/computer/manifest.json": { version: "1.0.17" },
      "/computer/1.0.17/manifest.json": targetsFor(),
    }),
  });
  const release = await source.checkForUpdate(CTX);
  assert.deepEqual(release, {
    version: "1.0.17",
    url: "https://cdn.example/computer/1.0.17/raft-computer-linux-x64",
    sha256: "ab".repeat(32),
    size: 1234,
  });
});

test("checkForUpdate returns null ONLY for already-current", async () => {
  const source = createComputerReleaseSource("https://cdn.example/computer", {
    fetchFn: fakeFetch({ "/computer/manifest.json": { version: "1.0.16" } }),
  });
  assert.equal(await source.checkForUpdate(CTX), null);
});

test("an OLDER latest-pointer is not an update (no automatic downgrade)", async () => {
  const source = createComputerReleaseSource("https://cdn.example/computer", {
    fetchFn: fakeFetch({ "/computer/manifest.json": { version: "1.0.15" } }),
  });
  assert.equal(await source.checkForUpdate(CTX), null);
});

test("a failed look THROWS — it must never read as \"nothing to do\"", async () => {
  const network = createComputerReleaseSource("https://cdn.example/computer", {
    fetchFn: (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch,
    timeoutMs: 50,
  });
  await assert.rejects(network.checkForUpdate(CTX), (err: unknown) => {
    assert.ok(err instanceof ComputerServiceError);
    assert.equal(err.code, "K_SOURCE_UNAVAILABLE");
    return true;
  });

  const publishing = createComputerReleaseSource("https://cdn.example/computer", {
    fetchFn: fakeFetch({ "/computer/manifest.json": {} }), // pointer absent
  });
  await assert.rejects(publishing.checkForUpdate(CTX), (err: unknown) => {
    assert.ok(err instanceof ComputerServiceError);
    assert.equal(err.code, "K_SOURCE_UNAVAILABLE");
    return true;
  });
});

test("fetchRelease serves a NAMED version — the explicit (downgrade-capable) path", async () => {
  const source = createComputerReleaseSource("https://cdn.example/computer", {
    fetchFn: fakeFetch({ "/computer/1.0.15/manifest.json": targetsFor(999) }),
  });
  const release = await source.fetchRelease("1.0.15", CTX);
  assert.equal(release.version, "1.0.15");
  assert.equal(release.size, 999);
});

test("fetchRelease rejects a non-semver URL segment before touching the network", async () => {
  let fetched = false;
  const source = createComputerReleaseSource("https://cdn.example/computer", {
    fetchFn: async () => {
      fetched = true;
      throw new Error("must not fetch");
    },
  });
  await assert.rejects(
    source.fetchRelease("../manifest", CTX),
    /K_SOURCE_VERSION_UNPARSABLE/u,
  );
  assert.equal(fetched, false);
});

test("fetchRelease fails typed when the platform has no target", async () => {
  const source = createComputerReleaseSource("https://cdn.example/computer", {
    fetchFn: fakeFetch({ "/computer/1.0.17/manifest.json": targetsFor() }),
  });
  await assert.rejects(
    source.fetchRelease("1.0.17", { ...CTX, platformKey: "win32-arm64" }),
    (err: unknown) => {
      assert.ok(err instanceof ComputerServiceError);
      assert.equal(err.code, "K_SOURCE_TARGET_UNSUPPORTED");
      return true;
    },
  );
});

test("a target without an attested size fails typed (no Content-Length substitution)", async () => {
  // NOTE: the absent case must OMIT the field — passing `undefined` through
  // a defaulted parameter would silently produce a valid target instead
  // (this test caught exactly that in its own first draft).
  const absent = { targets: { "linux-x64": { file: "raft-computer-linux-x64", sha256: "ab".repeat(32) } } };
  const cases: Array<[string, unknown]> = [
    ["absent", absent],
    ["string", targetsFor("1234")],
    ["negative", targetsFor(-1)],
    ["zero", targetsFor(0)],
    ["fractional", targetsFor(1.5)],
  ];
  for (const [label, manifest] of cases) {
    const source = createComputerReleaseSource("https://cdn.example/computer", {
      fetchFn: fakeFetch({ "/computer/1.0.17/manifest.json": manifest }),
    });
    await assert.rejects(source.fetchRelease("1.0.17", CTX), (err: unknown) => {
      assert.ok(err instanceof ComputerServiceError);
      assert.equal(err.code, "K_SOURCE_SIZE_UNATTESTED", `case=${label}`);
      return true;
    });
  }
});

test("a target lacking file/sha256 fails typed as manifest-invalid", async () => {
  const source = createComputerReleaseSource("https://cdn.example/computer", {
    fetchFn: fakeFetch({
      "/computer/1.0.17/manifest.json": { targets: { "linux-x64": { file: "x" } } },
    }),
  });
  await assert.rejects(source.fetchRelease("1.0.17", CTX), (err: unknown) => {
    assert.ok(err instanceof ComputerServiceError);
    assert.equal(err.code, "K_SOURCE_MANIFEST_INVALID");
    return true;
  });
});

test("version compare follows SemVer pre-release precedence, including numeric identifiers", () => {
  assert.ok(compareComputerVersions("1.0.17", "1.0.16") > 0);
  assert.ok(compareComputerVersions("1.0.16", "1.0.16") === 0);
  assert.ok(compareComputerVersions("0.9.9", "1.0.0") < 0);

  const ordered = [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0",
  ];
  for (let i = 1; i < ordered.length; i += 1) {
    assert.ok(compareComputerVersions(ordered[i - 1]!, ordered[i]!) < 0);
  }
  assert.ok(compareComputerVersions("1.0.0-rc.2", "1.0.0-rc.10") < 0);
  assert.ok(compareComputerVersions("1.0.0-1", "1.0.0-alpha") < 0);
});

test("version compare rejects non-SemVer and zero-padded numeric identifiers", () => {
  for (const version of ["latest", "01.0.0", "1.01.0", "1.0.01", "1.0.0-01", "1.0.0-rc.01"]) {
    assert.throws(() => compareComputerVersions(version, "1.0.0"), (err: unknown) => {
      assert.ok(err instanceof ComputerServiceError);
      assert.equal(err.code, "K_SOURCE_VERSION_UNPARSABLE");
      return true;
    });
  }
});

function handsCandidate(overrides: Partial<UpdateCandidate> = {}): UpdateCandidate {
  return {
    appId: "app-computer",
    appSlug: "raft-computer",
    releaseId: "release-117",
    releaseRevision: 3,
    channel: "alpha",
    selectedChannel: "alpha",
    channelId: "channel-alpha",
    version: "1.0.17",
    versionCode: 1_000_017,
    versionRelation: "upgrade",
    publishedAt: 1_787_460_000_000,
    target: { platform: "linux", arch: "x64" },
    artifact: {
      artifactId: "artifact-linux-x64",
      url: "https://downloads.example/raft-computer-linux-x64",
      size: 1234,
      sha256: "ab".repeat(32),
    },
    candidateDigest: `sha256:${"cd".repeat(32)}`,
    ...overrides,
  };
}

function handsSource(
  checkUpdate: HandsUpdater["checkUpdate"],
  seenOptions?: HandsUpdaterOptions[],
  overrides: Parameters<typeof createReleaseSource>[1] = {},
) {
  return createReleaseSource("https://legacy.invalid/computer", {
    handsApiOrigin: "https://hands.example",
    handsAppSlug: "raft-computer",
    channelProvider: () => "alpha",
    getHandsDeviceIdFn: async () => DEVICE_ID,
    createHandsUpdaterFn: (options) => {
      seenOptions?.push(options);
      return {
        checkUpdate,
        prepareUpdate: async () => {
          throw new Error("prepareUpdate must never be called: K owns download/staging");
        },
      };
    },
    ...overrides,
  });
}

test("Hands checkForUpdate resolves alpha active exact without touching legacy CDN or prepareUpdate", async () => {
  const inputs: UpdateCheckInput[] = [];
  const options: HandsUpdaterOptions[] = [];
  const source = handsSource(async (input) => {
    inputs.push(input);
    return { kind: "update", candidate: handsCandidate({ channel: "alpha", selectedChannel: "alpha" }) };
  }, options);

  assert.deepEqual(await source.checkForUpdate(CTX), {
    version: "1.0.17",
    url: "https://downloads.example/raft-computer-linux-x64",
    sha256: "ab".repeat(32),
    size: 1234,
  });
  assert.deepEqual(inputs, [{
    currentVersion: "1.0.16",
    channel: "alpha",
    target: { platform: "linux", arch: "x64" },
    deviceId: DEVICE_ID,
  }]);
  assert.equal(options[0]?.apiOrigin, "https://hands.example");
  assert.equal(options[0]?.appSlug, "raft-computer");
});

test("CLI target resolution shares Hands authority for latest, alpha, and pinned", async () => {
  const inputs: UpdateCheckInput[] = [];
  let identityReads = 0;
  let legacyFetches = 0;
  const deps: Parameters<typeof resolveComputerUpgradeTargetVersion>[3] = {
    fetchFn: async () => {
      legacyFetches += 1;
      throw new Error("legacy CDN must not run");
    },
    getHandsDeviceIdFn: async () => {
      identityReads += 1;
      return DEVICE_ID;
    },
    createHandsUpdaterFn: () => ({
      checkUpdate: async (input) => {
        inputs.push(input);
        const version = input.channel === "main"
          ? "1.0.22"
          : input.channel === "alpha"
            ? "1.0.23-alpha.1"
            : input.channel.slice("pinned:".length);
        return {
          kind: "update",
          candidate: handsCandidate({
            appSlug: "raft-computer-cli",
            channel: input.channel,
            selectedChannel: input.channel.startsWith("pinned:") ? "alpha" : input.channel,
            version,
          }),
        };
      },
      prepareUpdate: async () => { throw new Error("K alone owns package preparation"); },
    }),
  };
  assert.equal(await resolveComputerUpgradeTargetVersion(
    "latest", CTX, "https://legacy.invalid/computer", deps,
  ), "1.0.22");
  assert.equal(await resolveComputerUpgradeTargetVersion(
    "alpha", CTX, "https://legacy.invalid/computer", deps,
  ), "1.0.23-alpha.1");
  assert.equal(await resolveComputerUpgradeTargetVersion(
    "pinned:1.0.20", CTX, "https://legacy.invalid/computer", deps,
  ), "1.0.20");
  assert.deepEqual(inputs.map((input) => input.channel), ["main", "alpha", "pinned:1.0.20"]);
  assert.ok(inputs.every((input) => input.deviceId === DEVICE_ID));
  assert.equal(identityReads, 3, "each command resolves one stable OS-user identity");
  assert.equal(legacyFetches, 0);
});

test("CLI target resolution fails closed on Hands target or cohort identity drift", async () => {
  for (const candidate of [
    handsCandidate({ appSlug: "other-app", channel: "alpha", selectedChannel: "alpha" }),
    handsCandidate({ appSlug: "raft-computer-cli", target: { platform: "darwin", arch: "arm64" }, channel: "alpha", selectedChannel: "alpha" }),
    handsCandidate({ appSlug: "raft-computer-cli", channel: "main", selectedChannel: "alpha" }),
  ]) {
    await assert.rejects(resolveComputerUpgradeTargetVersion(
      "alpha",
      CTX,
      "https://legacy.invalid/computer",
      {
        getHandsDeviceIdFn: async () => DEVICE_ID,
        createHandsUpdaterFn: () => ({
          checkUpdate: async () => ({ kind: "update", candidate }),
          prepareUpdate: async () => { throw new Error("must not prepare"); },
        }),
      },
    ), (error: unknown) => {
      assert.ok(error instanceof ComputerServiceError);
      assert.equal(error.code, "K_SOURCE_IDENTITY_DRIFT");
      return true;
    });
  }
});

test("Hands default deps resolve the production app slug raft-computer-cli end to end", async () => {
  // Regression tooth for the latent wrong-default defect: every other test
  // injects handsAppSlug explicitly, so the production default branch of
  // createComputerReleaseSource was never exercised and a nonexistent slug
  // (the old "raft-computer") stayed green. This test binds the default.
  const options: HandsUpdaterOptions[] = [];
  const source = createReleaseSource("https://legacy.invalid/computer", {
    channelProvider: () => "alpha",
    getHandsDeviceIdFn: async () => DEVICE_ID,
    createHandsUpdaterFn: (opts) => {
      options.push(opts);
      return {
        checkUpdate: async () => ({
          kind: "update",
          candidate: handsCandidate({
            appSlug: "raft-computer-cli",
            channel: "alpha",
            selectedChannel: "alpha",
          }),
        }),
        prepareUpdate: async () => {
          throw new Error("prepareUpdate must never be called: K owns download/staging");
        },
      };
    },
  });

  assert.deepEqual(await source.checkForUpdate(CTX), {
    version: "1.0.17",
    url: "https://downloads.example/raft-computer-linux-x64",
    sha256: "ab".repeat(32),
    size: 1234,
  });
  assert.equal(options[0]?.appSlug, "raft-computer-cli");
  assert.equal(options[0]?.apiOrigin, "https://hands.build");

  // The candidate identity check must bind the same default: an echo of any
  // other app slug is drift, not a resolvable release.
  const drifted = createReleaseSource("https://legacy.invalid/computer", {
    channelProvider: () => "alpha",
    getHandsDeviceIdFn: async () => DEVICE_ID,
    createHandsUpdaterFn: () => ({
      checkUpdate: async () => ({
        kind: "update",
        candidate: handsCandidate({
          appSlug: "raft-computer-app",
          channel: "alpha",
          selectedChannel: "alpha",
        }),
      }),
      prepareUpdate: async () => {
        throw new Error("prepareUpdate must never be called: K owns download/staging");
      },
    }),
  });
  await assert.rejects(drifted.checkForUpdate(CTX), (err: unknown) => {
    assert.ok(err instanceof ComputerServiceError);
    assert.equal(err.code, "K_SOURCE_IDENTITY_DRIFT");
    return true;
  });
});

test("Hands fetchRelease resolves an exact pinned downgrade", async () => {
  const inputs: UpdateCheckInput[] = [];
  const source = handsSource(async (input) => {
    inputs.push(input);
    return {
      kind: "update",
      candidate: handsCandidate({
        channel: "pinned:1.0.15",
        selectedChannel: "alpha",
        version: "1.0.15",
        versionRelation: "downgrade",
      }),
    };
  });

  assert.equal((await source.fetchRelease("1.0.15", CTX)).version, "1.0.15");
  assert.equal(inputs[0]?.channel, "pinned:1.0.15");
  assert.equal(inputs[0]?.currentVersion, "0.0.0");
  assert.equal(inputs[0]?.deviceId, DEVICE_ID);
});

test("Hands shares one DeveloperDeviceId across main, alpha, and pinned", async () => {
  const inputs: UpdateCheckInput[] = [];
  let reads = 0;
  const source = handsSource(async (input) => {
    inputs.push(input);
    const version = input.channel === "main"
      ? "1.0.17"
      : input.channel === "alpha"
        ? "1.0.18"
        : input.channel.slice(7);
    return { kind: "update", candidate: handsCandidate({
      channel: input.channel,
      selectedChannel: input.channel.startsWith("pinned:") ? "alpha" : input.channel,
      version,
    }) };
  }, undefined, {
    channelProvider: (() => inputs.length === 0 ? "latest" : "alpha"),
    getHandsDeviceIdFn: async () => {
      reads += 1;
      return DEVICE_ID;
    },
  });

  await source.checkForUpdate(CTX);
  await source.checkForUpdate(CTX);
  await source.fetchRelease("1.0.19", CTX);
  assert.equal(reads, 1);
  assert.deepEqual(inputs.map(({ channel, deviceId }) => ({ channel, deviceId })), [
    { channel: "main", deviceId: DEVICE_ID },
    { channel: "alpha", deviceId: DEVICE_ID },
    { channel: "pinned:1.0.19", deviceId: DEVICE_ID },
  ]);
});

test("explicit legacy backend never resolves or sends a Hands DeveloperDeviceId", async () => {
  let identityReads = 0;
  const source = createReleaseSource("https://cdn.example/computer", {
    backend: "legacy-cdn",
    getHandsDeviceIdFn: async () => {
      identityReads += 1;
      throw new Error("legacy must not resolve Hands identity");
    },
    fetchFn: fakeFetch({ "/computer/manifest.json": { version: CTX.currentVersion } }),
  });

  assert.equal(await source.checkForUpdate(CTX), null);
  assert.equal(identityReads, 0);
});

test("Hands DeveloperDeviceId failures and malformed values stop before updater fetch", async () => {
  for (const getHandsDeviceIdFn of [
    async () => { throw new Error("persist failed"); },
    async () => "not-a-device-id",
  ]) {
    let fetches = 0;
    const source = handsSource(async () => {
      fetches += 1;
      return { kind: "update", candidate: handsCandidate() };
    }, undefined, { getHandsDeviceIdFn });
    await assert.rejects(source.checkForUpdate(CTX), (error: unknown) => {
      assert.ok(error instanceof ComputerServiceError);
      assert.equal(error.code, "K_SOURCE_DEVICE_ID_INVALID");
      return true;
    });
    assert.equal(fetches, 0);
  }
});

test("default published Hands identity uses OS-aware user state and is reused", {
  // Published Windows identity uses HKCU; the hands-node Windows job exercises
  // the real registry contract.
  skip: process.platform === "win32",
}, async () => {
  const home = await mkdtemp(join(tmpdir(), "computer-hands-home-"));
  const state = await mkdtemp(join(tmpdir(), "computer-hands-device-"));
  const previous = process.env.XDG_STATE_HOME;
  const previousHome = process.env.HOME;
  if (process.platform === "darwin") {
    process.env.HOME = home;
  }
  process.env.XDG_STATE_HOME = state;
  const inputs: UpdateCheckInput[] = [];
  try {
    const source = createReleaseSource("https://legacy.invalid/computer", {
      handsApiOrigin: "https://hands.example",
      handsAppSlug: "raft-computer",
      channelProvider: () => "alpha",
      createHandsUpdaterFn: () => ({
        checkUpdate: async (input) => {
          inputs.push(input);
          return {
            kind: "update",
            candidate: handsCandidate({
              channel: input.channel,
              selectedChannel: "alpha",
            }),
          };
        },
        prepareUpdate: async () => {
          throw new Error("prepareUpdate must never be called");
        },
      }),
    });
    await source.checkForUpdate(CTX);
    await source.fetchRelease("1.0.17", CTX);
    const path = process.platform === "darwin"
      ? join(home, "Library", "Application Support", "hands.build", "deviceid")
      : join(state, "hands.build", "deviceid");
    const stored = (await readFile(path, "utf8")).trim();
    assert.equal(inputs[0]?.deviceId, stored);
    assert.equal(inputs[1]?.deviceId, stored);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    if (process.platform === "darwin") {
      await assert.rejects(readFile(join(state, "hands.build", "deviceid")), { code: "ENOENT" });
    }
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test("Hands up-to-date remains null and resolution failures never fall back to CDN", async () => {
  const source = handsSource(async () => ({
    kind: "up_to_date",
    currentVersion: CTX.currentVersion,
    checkedAt: "2026-08-23T00:00:00.000Z",
  }));
  assert.equal(await source.checkForUpdate(CTX), null);

  let legacyFetches = 0;
  const failed = handsSource(async () => {
    throw new Error("Hands unavailable");
  }, undefined, {
    fetchFn: async () => {
      legacyFetches += 1;
      throw new Error("legacy fallback must not run");
    },
  });
  await assert.rejects(failed.checkForUpdate(CTX), (error: unknown) => {
    assert.ok(error instanceof ComputerServiceError);
    assert.equal(error.code, "K_SOURCE_UNAVAILABLE");
    return true;
  });
  assert.equal(legacyFetches, 0);
});

test("Hands current-channel older or equal candidates never auto-downgrade", async () => {
  for (const version of ["1.0.15", "1.0.16"]) {
    const source = handsSource(async () => ({
      kind: "update",
      candidate: handsCandidate({ version, versionRelation: "downgrade" }),
    }));
    assert.equal(await source.checkForUpdate(CTX), null);
  }
});

test("Hands candidate must conserve every exact identity field between resolve calls", async () => {
  const mutations: Array<[string, (candidate: UpdateCandidate) => UpdateCandidate]> = [
    ["app", (c) => ({ ...c, appId: "other-app" })],
    ["release", (c) => ({ ...c, releaseId: "other-release" })],
    ["revision", (c) => ({ ...c, releaseRevision: 4 })],
    ["selected channel", (c) => ({ ...c, selectedChannel: "other" })],
    ["channel id", (c) => ({ ...c, channelId: "other-channel" })],
    ["artifact id", (c) => ({ ...c, artifact: { ...c.artifact, artifactId: "other-artifact" } })],
    ["URL", (c) => ({ ...c, artifact: { ...c.artifact, url: "https://downloads.example/other" } })],
    ["size", (c) => ({ ...c, artifact: { ...c.artifact, size: c.artifact.size + 1 } })],
    ["SHA-256", (c) => ({ ...c, artifact: { ...c.artifact, sha256: "ef".repeat(32) } })],
  ];
  for (const [label, mutate] of mutations) {
    let calls = 0;
    const source = handsSource(async () => ({
      kind: "update",
      candidate: calls++ === 0
        ? handsCandidate({ channel: "pinned:1.0.17", selectedChannel: "alpha" })
        : mutate(handsCandidate({ channel: "pinned:1.0.17", selectedChannel: "alpha" })),
    }));
    await source.fetchRelease("1.0.17", CTX);
    await assert.rejects(source.fetchRelease("1.0.17", CTX), (error: unknown) => {
      assert.ok(error instanceof ComputerServiceError, label);
      assert.equal(error.code, "K_SOURCE_IDENTITY_DRIFT", label);
      return true;
    });
  }
});

test("Hands rejects wrong target and malformed artifact identity before K handoff", async () => {
  const cases: Array<[string, UpdateCandidate]> = [
    ["platform", handsCandidate({ target: { platform: "darwin", arch: "x64" } })],
    ["URL", handsCandidate({ artifact: { ...handsCandidate().artifact, url: "" } })],
    ["size", handsCandidate({ artifact: { ...handsCandidate().artifact, size: 0 } })],
    ["SHA", handsCandidate({ artifact: { ...handsCandidate().artifact, sha256: "bad" } })],
  ];
  for (const [label, candidate] of cases) {
    const source = handsSource(async () => ({ kind: "update", candidate }));
    await assert.rejects(source.checkForUpdate(CTX), (error: unknown) => {
      assert.ok(error instanceof ComputerServiceError, label);
      assert.equal(error.code, "K_SOURCE_IDENTITY_DRIFT", label);
      return true;
    });
  }
});
