import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import {
  parseChannel,
  readChannel,
  writeChannel,
  runChannelShow,
  runChannelSet,
  listChannelVersions,
  runChannelVersions,
  DEFAULT_CHANNEL,
} from "./channel.js";
import { channelPath } from "./paths.js";
import { CliExit } from "./output.js";
import { ComputerError } from "./lib/errors.js";

// PR-E §2.1 regression guard — release channel state.

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "slock-pr-e-channel-"));
  const old = process.env.SLOCK_HOME;
  process.env.SLOCK_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (old === undefined) delete process.env.SLOCK_HOME;
    else process.env.SLOCK_HOME = old;
    await rm(home, { recursive: true, force: true });
  }
}

function captureOut(): { restore: () => void; text: () => string } {
  const oo = process.stdout.write.bind(process.stdout);
  const oe = process.stderr.write.bind(process.stderr);
  let buf = "";
  const sink = ((c: unknown) => {
    buf += String(c);
    return true;
  });
  process.stdout.write = sink as typeof process.stdout.write;
  process.stderr.write = sink as typeof process.stderr.write;
  return {
    restore: () => {
      process.stdout.write = oo;
      process.stderr.write = oe;
    },
    text: () => buf,
  };
}

test("parseChannel: latest / alpha accepted", () => {
  assert.equal(parseChannel("latest"), "latest");
  assert.equal(parseChannel("alpha"), "alpha");
  assert.equal(parseChannel("  latest  "), "latest"); // trims
});

test("parseChannel: pinned:<semver> accepted for valid semver", () => {
  assert.equal(parseChannel("pinned:0.52.2"), "pinned:0.52.2");
  assert.equal(parseChannel("pinned:1.0.0-alpha"), "pinned:1.0.0-alpha");
  assert.equal(parseChannel("pinned:1.0.0-beta.1"), "pinned:1.0.0-beta.1");
});

test("parseChannel: invalid values rejected → null", () => {
  assert.equal(parseChannel(""), null);
  assert.equal(parseChannel("staging"), null);
  assert.equal(parseChannel("PINNED:1.2.3"), null); // case-sensitive
  assert.equal(parseChannel("pinned:not-a-version"), null);
  assert.equal(parseChannel("pinned:1.2"), null); // incomplete semver
  assert.equal(parseChannel("latest@1.0"), null);
});

test("readChannel: missing file → returns DEFAULT_CHANNEL (latest)", async () => {
  await withHome(async (home) => {
    assert.equal(await readChannel(home), DEFAULT_CHANNEL);
    assert.equal(DEFAULT_CHANNEL, "latest");
  });
});

test("readChannel: corrupt content → falls back to DEFAULT_CHANNEL (lenient read)", async () => {
  await withHome(async (home) => {
    await mkdir(join(home, "computer"), { recursive: true });
    await writeFile(channelPath(home), "garbage-value");
    assert.equal(await readChannel(home), DEFAULT_CHANNEL);
  });
});

test("writeChannel: persists + readChannel round-trip", async () => {
  await withHome(async (home) => {
    await writeChannel(home, "alpha");
    assert.equal(await readChannel(home), "alpha");
    await writeChannel(home, "pinned:0.52.2");
    assert.equal(await readChannel(home), "pinned:0.52.2");
    await writeChannel(home, "latest");
    assert.equal(await readChannel(home), "latest");
  });
});

test("writeChannel: writes file with mode 0600", async () => {
  await withHome(async (home) => {
    await writeChannel(home, "alpha");
    const { stat } = await import("node:fs/promises");
    const s = await stat(channelPath(home));
    assert.equal(s.mode & 0o777, 0o600);
  });
});

test("runChannelShow: prints current channel", async () => {
  await withHome(async (home) => {
    await writeChannel(home, "alpha");
    const cap = captureOut();
    try {
      await runChannelShow(home);
    } finally {
      cap.restore();
    }
    assert.match(cap.text(), /alpha/);
  });
});

test("runChannelShow: prints default when unset", async () => {
  await withHome(async (home) => {
    const cap = captureOut();
    try {
      await runChannelShow(home);
    } finally {
      cap.restore();
    }
    assert.match(cap.text(), /latest/);
  });
});

test("runChannelSet: valid channel persisted + success message", async () => {
  await withHome(async (home) => {
    const cap = captureOut();
    try {
      await runChannelSet(home, "alpha");
    } finally {
      cap.restore();
    }
    assert.match(cap.text(), /Channel set to alpha/);
    assert.match(cap.text(), /next `raft-computer upgrade` uses alpha/);
    assert.doesNotMatch(cap.text(), /restart/i);
    assert.equal(await readChannel(home), "alpha");
    // Verify file contents persisted correctly
    const raw = (await readFile(channelPath(home), "utf8")).trim();
    assert.equal(raw, "alpha");
  });
});

test("runChannelSet: invalid channel → CHANNEL_INVALID + CliExit", async () => {
  await withHome(async (home) => {
    const cap = captureOut();
    try {
      await assert.rejects(
        () => runChannelSet(home, "staging"),
        (e) => e instanceof CliExit && e.exitCode === 1,
      );
    } finally {
      cap.restore();
    }
    assert.match(cap.text(), /CHANNEL_INVALID/);
    // File must NOT be written on failure
    assert.equal(await readChannel(home), DEFAULT_CHANNEL);
  });
});

const SHA_22 = "2".repeat(64);
const SHA_21 = "1".repeat(64);

function versionIndexResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    schema_version: 1,
    app: { id: "app-1", slug: "raft-computer-cli", platform: "cli" },
    channel: "alpha",
    target: { platform: "darwin", arch: "arm64" },
    truncated: false,
    versions: [
      {
        version: "1.0.22",
        version_code: 1_000_022,
        status: "active",
        published_at: Date.UTC(2026, 7, 31),
        release_id: "release-22",
        sha256: SHA_22,
        size_bytes: 22,
      },
      {
        version: "1.0.21",
        version_code: 1_000_021,
        status: "superseded",
        published_at: Date.UTC(2026, 7, 30),
        release_id: "release-21",
        sha256: SHA_21,
        size_bytes: 21,
      },
    ],
    ...overrides,
  }), { status: 200, headers: { "content-type": "application/json" } });
}

test("listChannelVersions: reads authoritative alpha index and preserves installable superseded versions", async () => {
  let requested = "";
  const result = await listChannelVersions("alpha", 20, {
    platform: "darwin",
    arch: "arm64",
    installedVersion: "1.0.21",
    fetchFn: async (input) => {
      requested = String(input);
      return versionIndexResponse();
    },
  });
  const url = new URL(requested);
  assert.equal(url.pathname, "/public/v2/apps/raft-computer-cli/versions");
  assert.equal(url.searchParams.get("channel"), "alpha");
  assert.equal(url.searchParams.get("platform"), "darwin");
  assert.equal(url.searchParams.get("arch"), "arm64");
  assert.equal(url.searchParams.get("limit"), "20");
  assert.deepEqual(result.versions.map(({ version, label, installed }) => ({ version, label, installed })), [
    { version: "1.0.22", label: "latest", installed: false },
    { version: "1.0.21", label: "available", installed: true },
  ]);
});

test("listChannelVersions: maps latest to the authoritative main channel", async () => {
  let requested = "";
  const response = versionIndexResponse({
    channel: "main",
    target: { platform: "linux", arch: "x64" },
    versions: [],
  });
  const result = await listChannelVersions("latest", 1, {
    platform: "linux",
    arch: "x64",
    fetchFn: async (input) => {
      requested = String(input);
      return new Response(await response.text(), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(new URL(requested).searchParams.get("channel"), "main");
  assert.deepEqual(result.versions, []);
});

test("listChannelVersions: rejects malformed provider identity and invalid limits", async () => {
  await assert.rejects(
    () => listChannelVersions("alpha", 0),
    (error) => error instanceof ComputerError && error.code === "CHANNEL_VERSIONS_LIMIT_INVALID",
  );
  await assert.rejects(
    () => listChannelVersions("alpha", 20, {
      platform: "darwin",
      arch: "arm64",
      fetchFn: async () => versionIndexResponse({
        versions: [{
          version: "1.0.22",
          version_code: 1_000_022,
          status: "active",
          published_at: 1,
          release_id: "release-22",
          sha256: "not-a-sha",
          size_bytes: 22,
        }],
      }),
    }),
    (error) => error instanceof ComputerError && error.code === "CHANNEL_VERSIONS_INVALID",
  );
  await assert.rejects(
    () => listChannelVersions("alpha", 20, {
      platform: "darwin",
      arch: "arm64",
      fetchFn: async () => new Response("not-json", { status: 200 }),
    }),
    (error) => error instanceof ComputerError && error.code === "CHANNEL_VERSIONS_INVALID",
  );
});

test("listChannelVersions: transport and provider failures are typed", async () => {
  await assert.rejects(
    () => listChannelVersions("alpha", 20, {
      fetchFn: async () => { throw new Error("offline"); },
    }),
    (error) => error instanceof ComputerError && error.code === "CHANNEL_VERSIONS_FAILED",
  );
  await assert.rejects(
    () => listChannelVersions("alpha", 20, {
      fetchFn: async () => new Response(JSON.stringify({ code: "channel_not_found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    }),
    (error) => error instanceof ComputerError && error.code === "CHANNEL_VERSIONS_UNAVAILABLE",
  );
});

test("runChannelVersions: saved channel human output distinguishes latest, available, and installed", async () => {
  await withHome(async (home) => {
    await writeChannel(home, "alpha");
    const cap = captureOut();
    try {
      await runChannelVersions(home, undefined, {}, {
        platform: "darwin",
        arch: "arm64",
        installedVersion: "1.0.21",
        fetchFn: async () => versionIndexResponse(),
      });
    } finally {
      cap.restore();
    }
    assert.match(cap.text(), /VERSION\s+CHANNEL\s+STATUS\s+PUBLISHED/u);
    assert.match(cap.text(), /1\.0\.22\s+alpha\s+latest/u);
    assert.match(cap.text(), /1\.0\.21\s+alpha\s+available,installed/u);
  });
});

test("runChannelVersions: JSON output is stable and pinned selectors fail before network", async () => {
  await withHome(async (home) => {
    const cap = captureOut();
    try {
      await runChannelVersions(home, "alpha", { json: true, limit: 7 }, {
        platform: "darwin",
        arch: "arm64",
        installedVersion: "1.0.22",
        fetchFn: async () => versionIndexResponse(),
      });
    } finally {
      cap.restore();
    }
    const parsed = JSON.parse(cap.text()) as { schemaVersion: number; channel: string; versions: Array<{ installed: boolean }> };
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.channel, "alpha");
    assert.equal(parsed.versions[0]?.installed, true);

    let fetched = false;
    const failure = captureOut();
    try {
      await assert.rejects(
        () => runChannelVersions(home, "pinned:1.0.21", {}, {
          fetchFn: async () => {
            fetched = true;
            return versionIndexResponse();
          },
        }),
        (error) => error instanceof CliExit && error.code === "CHANNEL_VERSIONS_PINNED",
      );
    } finally {
      failure.restore();
    }
    assert.equal(fetched, false);
    assert.match(failure.text(), /CHANNEL_VERSIONS_PINNED/u);
    assert.match(failure.text(), /read-only command did not change local Computer state/u);
  });
});
