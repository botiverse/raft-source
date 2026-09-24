import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";

import {
  detectLegacyMigration,
  type LegacyMachineRosterClient,
} from "./migration.js";
import type { LegacyMachineRosterEntry } from "../apiClient.js";
import { serverAttachmentPath } from "../paths.js";
import { MIGRATION_DETECTION_KINDS, isMigrationDetectionKind } from "./types.js";

// PR-v9.9 §X.4 migration detection — server-roster ∩ local-history
// intersection on apiKeyFingerprint, plus three-gate `--migrate-from`
// validator.
//
// Coverage anchors:
//   - kinds tuple closed-set (`matched` / `zero_match` /
//     `no_local_evidence` / `roster_unavailable`)
//   - empty intersection (no local owners) returns no_local_evidence without
//     hitting the server (best-effort short-circuit)
//   - non-empty local + roster success → intersection on fingerprint
//   - roster failure → `roster_unavailable` (Trigger #4)
//   - corrupt / missing-fingerprint owner.json swallowed (no throw)
//     and success path returns candidate carrying server display fields
//
// Discipline anchors:
//   - Lib-pure (no env reads, no terminal IO, no process.exit)
//   - Filesystem error swallow on local owner.json scan
//   - Cody redline (msg=ec68c27f): apiKeyFingerprint is the join key, not
//     machineId; server daemonId / machineName flow back as display only.

const TARGET_SERVER = "alpha";

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "raft-computer-migration-"));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function writeOwner(
  home: string,
  machineDirName: string,
  owner: {
    apiKeyFingerprint?: string;
    raw?: string;
    serverUrl?: string;
    schemaVersion?: number;
    kind?: string;
    serverId?: string;
    serverMachineId?: string;
  } | null,
): Promise<string> {
  const dir = join(home, "machines", machineDirName, "daemon.lock");
  await mkdir(dir, { recursive: true });
  const ownerPath = join(dir, "owner.json");
  if (owner === null) return ownerPath;
  if (owner.raw !== undefined) {
    await writeFile(ownerPath, owner.raw);
    return ownerPath;
  }
  await writeFile(
    ownerPath,
    JSON.stringify({
      pid: 12345,
      hostname: "test-host",
      startedAt: new Date().toISOString(),
      ...(owner.apiKeyFingerprint ? { apiKeyFingerprint: owner.apiKeyFingerprint } : {}),
      ...(owner.serverUrl ? { serverUrl: owner.serverUrl } : {}),
      ...(owner.schemaVersion === undefined ? {} : { schemaVersion: owner.schemaVersion }),
      ...(owner.kind ? { kind: owner.kind } : {}),
      ...(owner.serverId ? { serverId: owner.serverId } : {}),
      ...(owner.serverMachineId ? { serverMachineId: owner.serverMachineId } : {}),
    }),
  );
  return ownerPath;
}

const ATTACHED_SERVER_ID = "11111111-1111-4111-8111-111111111111";

function fingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

async function writeAttachment(
  home: string,
  input: { apiKey?: string; legacyApiKeyFingerprint?: string; raw?: Record<string, unknown> },
): Promise<void> {
  const path = serverAttachmentPath(home, ATTACHED_SERVER_ID);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify(input.raw ?? {
      kind: "computer-attachment",
      serverId: ATTACHED_SERVER_ID,
      serverMachineId: "22222222-2222-4222-8222-222222222222",
      apiKey: input.apiKey ?? "sk_computer_managed",
      serverUrl: "https://api.example.test",
      ...(input.legacyApiKeyFingerprint ? { legacyApiKeyFingerprint: input.legacyApiKeyFingerprint } : {}),
    }),
  );
}

type TestRosterEntry = Omit<LegacyMachineRosterEntry, "legacyKeyMigratedAt"> & {
  legacyKeyMigratedAt?: string | null;
};

function normalizeRosterEntry(entry: TestRosterEntry): LegacyMachineRosterEntry {
  return {
    ...entry,
    legacyKeyMigratedAt: entry.legacyKeyMigratedAt ?? null,
  };
}

function stubRoster(entries: TestRosterEntry[]): LegacyMachineRosterClient {
  return {
    list: async () => ({ status: "success", entries: entries.map(normalizeRosterEntry) }),
  };
}

function stubRosterUnavailable(): LegacyMachineRosterClient {
  return {
    list: async () => ({ status: "error", code: "request_failed" }),
  };
}

function detectWithClient(
  home: string,
  client: LegacyMachineRosterClient,
) {
  return detectLegacyMigration(home, TARGET_SERVER, () => client);
}

test("§X closed-set discipline — MIGRATION_DETECTION_KINDS tuple matches union", () => {
  assert.deepEqual([...MIGRATION_DETECTION_KINDS].sort(), [
    "matched",
    "no_local_evidence",
    "roster_unavailable",
    "zero_match",
  ]);
  assert.equal(isMigrationDetectionKind("matched"), true);
  assert.equal(isMigrationDetectionKind("zero_match"), true);
  assert.equal(isMigrationDetectionKind("no_local_evidence"), true);
  assert.equal(isMigrationDetectionKind("roster_unavailable"), true);
  assert.equal(isMigrationDetectionKind("match"), false);
  assert.equal(isMigrationDetectionKind(42), false);
  assert.equal(isMigrationDetectionKind(undefined), false);
});

test("detection: no local evidence short-circuits without hitting roster", async () => {
  await withHome(async (home) => {
    // No machines/ dir at all → fresh-attach Trigger #1 path.
    let listCalled = 0;
    const client: LegacyMachineRosterClient = {
      list: async () => {
        listCalled += 1;
        return { status: "success", entries: [] };
      },
    };
    const result = await detectWithClient(home, client);
    assert.equal(result.kind, "no_local_evidence");
    // Short-circuit: roster MUST NOT be hit when there's no local evidence.
    assert.equal(listCalled, 0);
  });
});

test("detection: v2 managed owner is local-managed evidence and skips roster", async () => {
  await withHome(async (home) => {
    const apiKey = "sk_computer_managed";
    const fp = fingerprint(apiKey);
    await writeAttachment(home, { apiKey });
    await writeOwner(home, `machine-${fp}`, {
      schemaVersion: 2,
      kind: "managed_computer_runner",
      serverId: ATTACHED_SERVER_ID,
      serverMachineId: "22222222-2222-4222-8222-222222222222",
      apiKeyFingerprint: fp,
    });
    let listCalls = 0;
    const result = await detectWithClient(home, {
      list: async () => {
        listCalls += 1;
        return { status: "success", entries: [] };
      },
    });
    assert.equal(result.kind, "no_local_evidence");
    assert.equal(listCalls, 0);
  });
});

test("detection: incomplete v2 managed-looking owner remains fail-closed legacy evidence", async () => {
  const incompleteOwners: Array<[string, Record<string, unknown>]> = [
    ["missing server identity", {
      schemaVersion: 2,
      kind: "managed_computer_runner",
      apiKeyFingerprint: "aaaaaaaaaaaaaaaa",
    }],
    ["blank serverId", {
      schemaVersion: 2,
      kind: "managed_computer_runner",
      apiKeyFingerprint: "aaaaaaaaaaaaaaaa",
      serverId: " ",
      serverMachineId: "22222222-2222-4222-8222-222222222222",
    }],
    ["blank serverMachineId", {
      schemaVersion: 2,
      kind: "managed_computer_runner",
      apiKeyFingerprint: "aaaaaaaaaaaaaaaa",
      serverId: ATTACHED_SERVER_ID,
      serverMachineId: " ",
    }],
    ["invalid owner fingerprint", {
      schemaVersion: 2,
      kind: "managed_computer_runner",
      apiKeyFingerprint: "not-a-fingerprint",
      serverId: ATTACHED_SERVER_ID,
      serverMachineId: "22222222-2222-4222-8222-222222222222",
    }],
  ];

  for (const [label, owner] of incompleteOwners) {
    await withHome(async (home) => {
      await writeOwner(home, "machine-aaaaaaaaaaaaaaaa", {
        raw: JSON.stringify(owner),
      });
      let listCalls = 0;
      const result = await detectWithClient(home, {
        list: async () => {
          listCalls += 1;
          return { status: "success", entries: [] };
        },
      });
      assert.equal(result.kind, "zero_match", label);
      assert.equal(listCalls, 1, label);
      if (result.kind !== "zero_match") return;
      assert.equal(result.excluded.length, 1, label);
    });
  }
});

test("detection: v2 raw owner stays in normal roster comparison", async () => {
  await withHome(async (home) => {
    await writeOwner(home, "machine-aaaaaaaaaaaaaaaa", {
      schemaVersion: 2,
      kind: "legacy_raw_daemon",
      apiKeyFingerprint: "aaaaaaaaaaaaaaaa",
    });
    let listCalls = 0;
    const result = await detectWithClient(home, {
      list: async () => {
        listCalls += 1;
        return stubRoster([{
          daemonId: "11111111-1111-4111-8111-111111111111",
          apiKeyFingerprint: "aaaaaaaaaaaaaaaa",
          machineName: "raw-daemon",
          hostname: null,
          lastSeenAt: null,
        }]).list(TARGET_SERVER);
      },
    });
    assert.equal(result.kind, "matched");
    assert.equal(listCalls, 1);
  });
});

test("detection: managed and raw owners coexist — only the raw owner enters roster adjudication", async () => {
  await withHome(async (home) => {
    const managedApiKey = "sk_computer_managed";
    const managedFp = fingerprint(managedApiKey);
    await writeAttachment(home, { apiKey: managedApiKey });
    await writeOwner(home, `machine-${managedFp}`, {
      schemaVersion: 2,
      kind: "managed_computer_runner",
      serverId: ATTACHED_SERVER_ID,
      serverMachineId: "22222222-2222-4222-8222-222222222222",
      apiKeyFingerprint: managedFp,
    });
    await writeOwner(home, "machine-bbbbbbbbbbbbbbbb", {
      schemaVersion: 2,
      kind: "legacy_raw_daemon",
      apiKeyFingerprint: "bbbbbbbbbbbbbbbb",
    });

    let listCalls = 0;
    const result = await detectWithClient(home, {
      list: async () => {
        listCalls += 1;
        return stubRoster([{
          daemonId: "33333333-3333-4333-8333-333333333333",
          apiKeyFingerprint: "bbbbbbbbbbbbbbbb",
          machineName: "raw-daemon",
          hostname: null,
          lastSeenAt: null,
        }]).list(TARGET_SERVER);
      },
    });
    assert.equal(result.kind, "matched");
    if (result.kind !== "matched") return;
    assert.equal(listCalls, 1);
    assert.deepEqual(result.candidates.map((candidate) => candidate.apiKeyFingerprint), [
      "bbbbbbbbbbbbbbbb",
    ]);
    assert.equal(result.excluded.length, 0);
  });
});

test("detection: v2 raw owner with empty roster remains zero_match", async () => {
  await withHome(async (home) => {
    await writeOwner(home, "machine-bbbbbbbbbbbbbbbb", {
      schemaVersion: 2,
      kind: "legacy_raw_daemon",
      apiKeyFingerprint: "bbbbbbbbbbbbbbbb",
    });
    const result = await detectWithClient(home, stubRoster([]));
    assert.equal(result.kind, "zero_match");
    if (result.kind !== "zero_match") return;
    assert.equal(result.excluded.length, 1);
    assert.deepEqual(result.excluded[0]!.reasons, ["not_in_roster"]);
  });
});

for (const attachmentJoin of ["current_key", "legacy_fingerprint"] as const) {
  test(`detection: v1 exact-managed owner skips roster via ${attachmentJoin}`, async () => {
    await withHome(async (home) => {
      const apiKey = "sk_computer_managed";
      const currentFp = fingerprint(apiKey);
      const ownerFp = attachmentJoin === "current_key" ? currentFp : "abcdefabcdefabcd";
      await writeAttachment(home, {
        apiKey,
        ...(attachmentJoin === "legacy_fingerprint" ? { legacyApiKeyFingerprint: ownerFp } : {}),
      });
      await writeOwner(home, `machine-${ownerFp}`, { apiKeyFingerprint: ownerFp });
      let listCalls = 0;
      const result = await detectWithClient(home, {
        list: async () => {
          listCalls += 1;
          return { status: "success", entries: [] };
        },
      });
      assert.equal(result.kind, "no_local_evidence");
      assert.equal(listCalls, 0);
    });
  });
}

test("detection: corrupt or secret-less attachment cannot classify v1 owner as managed", async () => {
  await withHome(async (home) => {
    const ownerFp = "aaaaaaaaaaaaaaaa";
    await writeAttachment(home, {
      raw: {
        kind: "computer-attachment",
        serverId: ATTACHED_SERVER_ID,
        serverMachineId: "22222222-2222-4222-8222-222222222222",
        serverUrl: "https://api.example.test",
        legacyApiKeyFingerprint: ownerFp,
      },
    });
    await writeOwner(home, `machine-${ownerFp}`, { apiKeyFingerprint: ownerFp });
    let listCalls = 0;
    const result = await detectWithClient(home, {
      list: async () => {
        listCalls += 1;
        return { status: "success", entries: [] };
      },
    });
    assert.equal(result.kind, "zero_match");
    assert.equal(listCalls, 1);
  });
});

test("detection: v1 unknown_legacy with empty server roster → zero_match (never skip)", async () => {
  await withHome(async (home) => {
    await writeOwner(home, "machine-aaaaaaaaaaaaaaaa", {
      apiKeyFingerprint: "aaaaaaaaaaaaaaaa",
    });
    const result = await detectWithClient(home, stubRoster([]));
    assert.equal(result.kind, "zero_match");
    if (result.kind !== "zero_match") return;
    assert.equal(result.excluded.length, 1);
    assert.deepEqual(result.excluded[0]!.reasons, ["not_in_roster"]);
  });
});

test("detection: intersection on apiKeyFingerprint surfaces server display fields", async () => {
  await withHome(async (home) => {
    const ownerPath = await writeOwner(home, "machine-aaaaaaaaaaaaaaaa", {
      apiKeyFingerprint: "aaaaaaaaaaaaaaaa",
    });
    const result = await detectWithClient(
      home,
      stubRoster([
        {
          daemonId: "11111111-1111-4111-8111-111111111111",
          apiKeyFingerprint: "aaaaaaaaaaaaaaaa",
          machineName: "alice-laptop",
          hostname: "alice-host",
          lastSeenAt: "2026-05-29T12:00:00.000Z",
        },
      ]),
    );
    assert.equal(result.kind, "matched");
    if (result.kind !== "matched") return;
    assert.equal(result.candidates.length, 1);
    const c = result.candidates[0]!;
    assert.equal(c.apiKeyFingerprint, "aaaaaaaaaaaaaaaa");
    assert.equal(c.daemonId, "11111111-1111-4111-8111-111111111111");
    assert.equal(c.localPath, ownerPath);
    assert.equal(c.machineName, "alice-laptop");
    assert.equal(c.hostname, "alice-host");
    assert.equal(c.lastSeenAt, "2026-05-29T12:00:00.000Z");
  });
});

test("detection: multi-match ordering — lastSeenAt DESC, apiKeyFingerprint ASC tiebreak (RFC §X.2)", async () => {
  await withHome(async (home) => {
    // Four local owners; the roster surfaces all four. Test pins the
    // documented sort: lastSeenAt DESC primary, apiKeyFingerprint ASC
    // tiebreak; lastSeenAt-missing rows sort to the end.
    await writeOwner(home, "machine-aaaaaaaaaaaaaaaa", { apiKeyFingerprint: "aaaaaaaaaaaaaaaa" });
    await writeOwner(home, "machine-bbbbbbbbbbbbbbbb", { apiKeyFingerprint: "bbbbbbbbbbbbbbbb" });
    await writeOwner(home, "machine-cccccccccccccccc", { apiKeyFingerprint: "cccccccccccccccc" });
    await writeOwner(home, "machine-dddddddddddddddd", { apiKeyFingerprint: "dddddddddddddddd" });
    // Intentionally feed the roster in scrambled order to prove the sort
    // is implementation-driven, not roster-driven.
    const result = await detectWithClient(
      home,
      stubRoster([
        // Same lastSeenAt as `aaaa…` — tiebreak by fingerprint asc puts aaaa first.
        {
          daemonId: "33333333-3333-4333-8333-333333333333",
          apiKeyFingerprint: "cccccccccccccccc",
          machineName: "tied-with-aaa",
          hostname: null,
          lastSeenAt: "2026-05-30T10:00:00.000Z",
        },
        // No lastSeenAt — must sort to the end regardless of fingerprint.
        {
          daemonId: "44444444-4444-4444-8444-444444444444",
          apiKeyFingerprint: "bbbbbbbbbbbbbbbb",
          machineName: "no-lastSeen",
          hostname: null,
          lastSeenAt: null,
        },
        // Most recent — must be first.
        {
          daemonId: "11111111-1111-4111-8111-111111111111",
          apiKeyFingerprint: "dddddddddddddddd",
          machineName: "most-recent",
          hostname: null,
          lastSeenAt: "2026-05-30T12:00:00.000Z",
        },
        // Tied lastSeenAt with cccc — fingerprint asc puts aaaa before cccc.
        {
          daemonId: "22222222-2222-4222-8222-222222222222",
          apiKeyFingerprint: "aaaaaaaaaaaaaaaa",
          machineName: "tied-with-ccc",
          hostname: null,
          lastSeenAt: "2026-05-30T10:00:00.000Z",
        },
      ]),
    );
    assert.equal(result.kind, "matched");
    if (result.kind !== "matched") return;
    assert.deepEqual(
      result.candidates.map((c) => c.apiKeyFingerprint),
      [
        "dddddddddddddddd", // most recent
        "aaaaaaaaaaaaaaaa", // tied at 10:00, fp asc → aaa before ccc
        "cccccccccccccccc",
        "bbbbbbbbbbbbbbbb", // null lastSeenAt → end
      ],
    );
  });
});

test("detection: roster_unavailable surfaces when local has evidence + roster fetch fails", async () => {
  await withHome(async (home) => {
    await writeOwner(home, "machine-aaaaaaaaaaaaaaaa", {
      apiKeyFingerprint: "aaaaaaaaaaaaaaaa",
    });
    const result = await detectWithClient(home, stubRosterUnavailable());
    assert.deepEqual(result, { kind: "roster_unavailable", localCount: 1 });
  });
});

test("detection: corrupt owner.json swallowed (no throw) — candidate excluded", async () => {
  await withHome(async (home) => {
    await writeOwner(home, "machine-aaaaaaaaaaaaaaaa", { raw: "{ this is not json" });
    await writeOwner(home, "machine-bbbbbbbbbbbbbbbb", {
      apiKeyFingerprint: "bbbbbbbbbbbbbbbb",
    });
    const result = await detectWithClient(
      home,
      stubRoster([
        {
          daemonId: "22222222-2222-4222-8222-222222222222",
          apiKeyFingerprint: "bbbbbbbbbbbbbbbb",
          machineName: "bob-laptop",
          hostname: null,
          lastSeenAt: null,
        },
      ]),
    );
    assert.equal(result.kind, "matched");
    if (result.kind !== "matched") return;
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0]!.apiKeyFingerprint, "bbbbbbbbbbbbbbbb");
    assert.equal(result.excluded.length, 1);
    assert.deepEqual(result.excluded[0]!.reasons, ["owner_malformed", "no_fingerprint_evidence"]);
  });
});

test("detection: invalid apiKeyFingerprint is missing_fingerprint and may use dir fallback", async () => {
  await withHome(async (home) => {
    // Wrong length (15 chars).
    await writeOwner(home, "machine-aaaaaaaaaaaaaaaa", {
      apiKeyFingerprint: "aaaaaaaaaaaaaaa",
    });
    // Non-hex characters.
    await writeOwner(home, "machine-bbbbbbbbbbbbbbbb", {
      apiKeyFingerprint: "ZZZZZZZZZZZZZZZZ",
    });
    // Owner with no fingerprint at all (predates v9.9 backfill).
    await writeOwner(home, "machine-cccccccccccccccc", {});
    const result = await detectWithClient(
      home,
      stubRoster([
        {
          daemonId: "33333333-3333-4333-8333-333333333333",
          apiKeyFingerprint: "aaaaaaaaaaaaaaaa",
          machineName: "would-not-match",
          hostname: null,
          lastSeenAt: null,
        },
      ]),
    );
    assert.equal(result.kind, "matched");
    if (result.kind !== "matched") return;
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0]!.apiKeyFingerprint, "aaaaaaaaaaaaaaaa");
    assert.equal(result.excluded.length, 2);
    assert.deepEqual(
      result.excluded.map((entry) => entry.evidence.ownerState),
      ["missing_fingerprint", "missing_fingerprint"],
    );
  });
});

test("detection: old-schema owner.json missing fingerprint falls back to 16-hex machine dir", async () => {
  await withHome(async (home) => {
    await writeOwner(home, "machine-cccccccccccccccc", {});
    const result = await detectWithClient(
      home,
      stubRoster([
        {
          daemonId: "33333333-3333-4333-8333-333333333333",
          apiKeyFingerprint: "cccccccccccccccc",
          machineName: "old-schema-daemon",
          hostname: null,
          lastSeenAt: "2026-07-07T10:00:00.000Z",
        },
      ]),
    );
    assert.equal(result.kind, "matched");
    if (result.kind !== "matched") return;
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0]!.apiKeyFingerprint, "cccccccccccccccc");
  });
});

test("detection: serverUrl mismatch is annotated on zero-match exclusions", async () => {
  await withHome(async (home) => {
    await writeOwner(home, "machine-aaaaaaaaaaaaaaaa", {
      apiKeyFingerprint: "aaaaaaaaaaaaaaaa",
      serverUrl: "https://api.raft.build",
    });
    const result = await detectWithClient(
      home,
      {
        targetServerUrl: "https://api-aws-staging.botiverse.dev",
        ...stubRoster([]),
      },
    );
    assert.equal(result.kind, "zero_match");
    if (result.kind !== "zero_match") return;
    assert.equal(result.excluded.length, 1);
    assert.deepEqual(result.excluded[0]!.reasons, ["not_in_roster", "server_url_mismatch"]);
    assert.equal(result.excluded[0]!.evidence.ownerServerUrl, "https://api.raft.build");
  });
});

test("detection: non-prefix dirs under machines/ ignored", async () => {
  await withHome(async (home) => {
    // Computer-side state lives under machines/ too — must not count as
    // legacy daemon evidence.
    await mkdir(join(home, "machines", "computer"), { recursive: true });
    await mkdir(join(home, "machines", "scratch"), { recursive: true });
    const result = await detectWithClient(home, stubRoster([]));
    assert.equal(result.kind, "no_local_evidence");
  });
});

test("detection: legacy daemon clean-shutdown (owner.json removed) still detected via machine-<fp> dir name", async () => {
  await withHome(async (home) => {
    // Canonical upgrade journey: old daemon running → Ctrl-C → run Computer
    // setup. A clean `@slock-ai/daemon` shutdown removes `daemon.lock/`
    // (owner.json with it) but leaves the `machine-<fp16>/` directory, whose
    // name encodes the same apiKeyFingerprint. Discovery must survive this —
    // otherwise the user silently fresh-attaches a duplicate machine.
    await mkdir(join(home, "machines", "machine-aaaaaaaaaaaaaaaa"), { recursive: true });
    const result = await detectWithClient(
      home,
      stubRoster([
        {
          daemonId: "11111111-1111-4111-8111-111111111111",
          apiKeyFingerprint: "aaaaaaaaaaaaaaaa",
          machineName: "alice-laptop",
          hostname: "alice-host",
          lastSeenAt: "2026-05-29T12:00:00.000Z",
        },
      ]),
    );
    assert.equal(result.kind, "matched");
    if (result.kind !== "matched") return;
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0]!.apiKeyFingerprint, "aaaaaaaaaaaaaaaa");
    // localPath falls back to the machine dir when owner.json is gone.
    assert.equal(result.candidates[0]!.localPath, join(home, "machines", "machine-aaaaaaaaaaaaaaaa"));
  });
});

test("detection: machine-<non-hex> dir without owner.json is not surfaced via dir-name fallback", async () => {
  await withHome(async (home) => {
    // Only a well-formed 16-hex suffix is a usable fingerprint; a stray
    // machine-prefixed dir must not manufacture a bogus candidate.
    await mkdir(join(home, "machines", "machine-not-a-fingerprint"), { recursive: true });
    const result = await detectWithClient(
      home,
      stubRoster([
        {
          daemonId: "22222222-2222-4222-8222-222222222222",
          apiKeyFingerprint: "bbbbbbbbbbbbbbbb",
          machineName: "bob-laptop",
          hostname: null,
          lastSeenAt: null,
        },
      ]),
    );
    assert.equal(result.kind, "zero_match");
    if (result.kind !== "zero_match") return;
    assert.equal(result.excluded.length, 1);
    assert.deepEqual(result.excluded[0]!.reasons, ["no_fingerprint_evidence"]);
  });
});

test("detection: present-but-unreadable owner.json does NOT fall back to dir name (Jianwei contract)", async () => {
  await withHome(async (home) => {
    // The dir-name fallback is gated on ENOENT only. Here owner.json EXISTS
    // but is unreadable — we make it a directory so `readFile` fails with
    // EISDIR (deterministic, no chmod). A present-but-unreadable owner.json is
    // authoritative: the candidate must be excluded, NOT recovered from the
    // dir name. Otherwise a corrupt/permission-locked owner.json would be
    // silently overridden by a string parse.
    await mkdir(
      join(home, "machines", "machine-cccccccccccccccc", "daemon.lock", "owner.json"),
      { recursive: true },
    );
    const result = await detectWithClient(
      home,
      stubRoster([
        {
          daemonId: "33333333-3333-4333-8333-333333333333",
          apiKeyFingerprint: "cccccccccccccccc",
          machineName: "carol-laptop",
          hostname: null,
          lastSeenAt: "2026-05-29T12:00:00.000Z",
        },
      ]),
    );
    assert.equal(result.kind, "zero_match");
    if (result.kind !== "zero_match") return;
    assert.equal(result.excluded.length, 1);
    assert.deepEqual(
      result.excluded[0]!.reasons,
      ["owner_unreadable", "no_fingerprint_evidence"],
      "EISDIR owner.json must not fall back to dir name",
    );
  });
});
