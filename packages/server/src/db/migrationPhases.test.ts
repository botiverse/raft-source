import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

import { readMigrationFiles } from "drizzle-orm/migrator";
import {
  acquireMigrationAdvisoryLock,
  createMigrationPhaseFolder,
  resolveMigrationPhaseConfig,
  runMigrationLockPreflight,
  runMigrationPhases,
  splitMigrationPhases,
} from "./migrationPhases.js";
import { readJournalTags } from "./migrateDeploy.js";

type Entry = { tag: string; when: number; sql: string };

const LOCK_RELEASE_BOUNDARY_TAG = "0244_ancient_ares";
const LOCK_SENSITIVE_MIGRATION_TAG = "0245_complete_sharon_ventura";
const lockContract = {
  SERVER_MIGRATION_REQUIRED_PHASE_BOUNDARY_TAGS: `${LOCK_RELEASE_BOUNDARY_TAG},${LOCK_SENSITIVE_MIGRATION_TAG}`,
  SERVER_MIGRATION_LOCK_SCHEMA: "public",
  SERVER_MIGRATION_LOCK_RELATIONS: "users,server_members",
  SERVER_MIGRATION_ADVISORY_LOCK_NAMESPACE: "1907",
  SERVER_MIGRATION_ADVISORY_LOCK_KEY: "245",
};

function writeMigrations(entries: Entry[]): string {
  const folder = mkdtempSync(path.join(tmpdir(), "migration-phases-"));
  mkdirSync(path.join(folder, "meta"));
  writeFileSync(
    path.join(folder, "meta", "_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: entries.map((entry, idx) => ({
        idx,
        version: "7",
        when: entry.when,
        tag: entry.tag,
        breakpoints: true,
      })),
    }),
  );
  for (const entry of entries) writeFileSync(path.join(folder, `${entry.tag}.sql`), entry.sql);
  return folder;
}

const entries: Entry[] = [
  { tag: "0241_users", when: 241, sql: "ALTER TABLE users ADD COLUMN retired_at text;" },
  { tag: LOCK_RELEASE_BOUNDARY_TAG, when: 244, sql: "CREATE TABLE mention_delivery_occurrences (id integer);" },
  { tag: LOCK_SENSITIVE_MIGRATION_TAG, when: 245, sql: "ALTER TABLE server_members ADD COLUMN sidebar_custom_sections json;" },
  { tag: "0246_after", when: 246, sql: "SELECT 1;" },
];

test("splitMigrationPhases starts a new phase at every configured boundary", () => {
  const folder = writeMigrations(entries);
  try {
    const migrations = readMigrationFiles({ migrationsFolder: folder });
    const phases = splitMigrationPhases(
      readJournalTags(folder),
      migrations,
      [LOCK_RELEASE_BOUNDARY_TAG, LOCK_SENSITIVE_MIGRATION_TAG],
    );
    assert.deepEqual(phases.map((phase) => phase.tags), [
      ["0241_users"],
      [LOCK_RELEASE_BOUNDARY_TAG],
      [LOCK_SENSITIVE_MIGRATION_TAG, "0246_after"],
    ]);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});


test("phase config rejects boundaries that are not in journal order", () => {
  const folder = writeMigrations(entries);
  try {
    const tags = entries.map((entry) => entry.tag);
    assert.throws(
      () => resolveMigrationPhaseConfig(
        {
          ...lockContract,
          SERVER_MIGRATION_PHASE_BOUNDARY_TAGS: `${LOCK_SENSITIVE_MIGRATION_TAG},${LOCK_RELEASE_BOUNDARY_TAG}`,
          SERVER_MIGRATION_EXPECTED_LOCK_TIMEOUT_MS: "5000",
        },
        tags,
      ),
      /MIGRATION_PHASE_BOUNDARY_ORDER_INVALID/,
    );
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("migration advisory lease fails closed when another runner owns it", async () => {
  await acquireMigrationAdvisoryLock(
    async () => ({ rows: [{ acquired: true }] }),
    1907,
    245,
  );
  await assert.rejects(
    acquireMigrationAdvisoryLock(
      async () => ({ rows: [{ acquired: false }] }),
      1907,
      245,
    ),
    /MIGRATION_ADVISORY_LOCK_UNAVAILABLE/,
  );
});

test("runMigrationLockPreflight rejects observed waits and stale transactions", async () => {
  const rows = [{ resolved_relations: 2, schema_established: 1, waiting_locks: 1, long_transactions: 0 }];
  await assert.rejects(
    runMigrationLockPreflight(async () => ({ rows }), 5000, "public", ["users", "server_members"]),
    /MIGRATION_LOCK_PREFLIGHT_BLOCKED/,
  );
  await assert.rejects(
    runMigrationLockPreflight(async () => ({ rows: [{ resolved_relations: 2, schema_established: 1, waiting_locks: 0, long_transactions: 1 }] }), 5000, "public", ["users", "server_members"]),
    /MIGRATION_LOCK_PREFLIGHT_BLOCKED/,
  );
});

test("runMigrationLockPreflight accepts a clear read-only snapshot", async () => {
  let queryText = "";
  let values: readonly unknown[] | undefined;
  await runMigrationLockPreflight(async (text, args) => {
    queryText = text;
    values = args;
    return { rows: [{ resolved_relations: 2, schema_established: 1, waiting_locks: 0, long_transactions: 0 }] };
  }, 5000, "public", ["users", "server_members"]);
  assert.match(queryText, /pg_locks/);
  assert.match(queryText, /pg_stat_activity/);
  assert.deepEqual(values, [5000, ["users", "server_members"], "public"]);
});

test("phase config requires the boundary before the lock-sensitive migration", () => {
  const base = {
    ...lockContract,
    SERVER_MIGRATION_EXPECTED_LOCK_TIMEOUT_MS: "5000",
  };
  assert.throws(
    () => resolveMigrationPhaseConfig({ ...base, SERVER_MIGRATION_PHASE_BOUNDARY_TAGS: LOCK_RELEASE_BOUNDARY_TAG }, entries.map((e) => e.tag)),
    /MIGRATION_PHASE_BOUNDARY_REQUIRED/,
  );
  assert.deepEqual(
    resolveMigrationPhaseConfig(
      { ...base, SERVER_MIGRATION_PHASE_BOUNDARY_TAGS: `${LOCK_RELEASE_BOUNDARY_TAG},${LOCK_SENSITIVE_MIGRATION_TAG}` },
      entries.map((e) => e.tag),
    ),
    {
      boundaryTags: [LOCK_RELEASE_BOUNDARY_TAG, LOCK_SENSITIVE_MIGRATION_TAG],
      requiredBoundaryTags: [LOCK_RELEASE_BOUNDARY_TAG, LOCK_SENSITIVE_MIGRATION_TAG],
      lockTimeoutMs: 5000,
      lockSchema: "public",
      lockRelations: ["users", "server_members"],
      advisoryLockNamespace: 1907,
      advisoryLockKey: 245,
    },
  );
});

test("phase config rejects unknown, duplicate, malformed, and unbounded lock settings", () => {
  const tags = entries.map((e) => e.tag);
  const cases: [string, NodeJS.ProcessEnv][] = [
    ["MIGRATION_PHASE_BOUNDARY_UNKNOWN", { ...lockContract, SERVER_MIGRATION_PHASE_BOUNDARY_TAGS: "0240_unknown", SERVER_MIGRATION_EXPECTED_LOCK_TIMEOUT_MS: "5000" }],
    ["MIGRATION_PHASE_BOUNDARY_DUPLICATE", { ...lockContract, SERVER_MIGRATION_PHASE_BOUNDARY_TAGS: `${LOCK_RELEASE_BOUNDARY_TAG},${LOCK_RELEASE_BOUNDARY_TAG},${LOCK_SENSITIVE_MIGRATION_TAG}`, SERVER_MIGRATION_EXPECTED_LOCK_TIMEOUT_MS: "5000" }],
    ["MIGRATION_PHASE_BOUNDARY_INVALID", { ...lockContract, SERVER_MIGRATION_PHASE_BOUNDARY_TAGS: `${LOCK_RELEASE_BOUNDARY_TAG},bad-tag,${LOCK_SENSITIVE_MIGRATION_TAG}`, SERVER_MIGRATION_EXPECTED_LOCK_TIMEOUT_MS: "5000" }],
    ["MIGRATION_LOCK_TIMEOUT_INVALID", { ...lockContract, SERVER_MIGRATION_PHASE_BOUNDARY_TAGS: `${LOCK_RELEASE_BOUNDARY_TAG},${LOCK_SENSITIVE_MIGRATION_TAG}`, SERVER_MIGRATION_EXPECTED_LOCK_TIMEOUT_MS: "0" }],
  ];
  for (const [code, env] of cases) assert.throws(() => resolveMigrationPhaseConfig(env, tags), new RegExp(code));
});

test("phase folder preserves canonical SQL bytes and journal timestamps", () => {
  const folder = writeMigrations(entries);
  try {
    const migrations = readMigrationFiles({ migrationsFolder: folder });
    const [phase] = splitMigrationPhases(readJournalTags(folder), migrations, [LOCK_RELEASE_BOUNDARY_TAG]);
    const phaseFolder = createMigrationPhaseFolder(folder, phase);
    try {
      assert.equal(readFileSync(path.join(phaseFolder, "0241_users.sql"), "utf8"), entries[0].sql);
      const phaseJournal = JSON.parse(readFileSync(path.join(phaseFolder, "meta", "_journal.json"), "utf8")) as { entries: Entry[] };
      assert.deepEqual(phaseJournal.entries.map((entry) => entry.tag), ["0241_users"]);
      assert.deepEqual(readMigrationFiles({ migrationsFolder: phaseFolder }), migrations.slice(0, 1));
    } finally {
      rmSync(phaseFolder, { recursive: true, force: true });
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("runMigrationPhases drives phases sequentially and cleans temporary folders", async () => {
  const folder = writeMigrations(entries);
  const seen: string[] = [];
  try {
    await runMigrationPhases(
      folder,
      [LOCK_RELEASE_BOUNDARY_TAG, LOCK_SENSITIVE_MIGRATION_TAG],
      async (phase, phaseFolder) => {
        seen.push(phase.tags.join(","));
        assert.equal(existsSync(phaseFolder), true);
        assert.deepEqual(readJournalTags(phaseFolder), phase.tags);
      },
    );
    assert.deepEqual(seen, ["0241_users", LOCK_RELEASE_BOUNDARY_TAG, `${LOCK_SENSITIVE_MIGRATION_TAG},0246_after`]);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Lock-watch scope tooth (2026-09-11, v1.13.0 cut).
//
// The v1.13.0 deadlock was on `messages` (0259 adds a FOREIGN KEY referencing
// it), but SERVER_MIGRATION_LOCK_RELATIONS watched only users,server_members —
// so the preflight that exists to refuse a contended start was structurally
// blind to the table that actually deadlocked. This tooth pins the property
// that the watched set is what decides admission: the same observed wait
// blocks when the relation is watched and passes when it is not.
//
// It cannot be satisfied by "the preflight always blocks" (the unwatched case
// must pass) nor by "it never blocks" (the watched case must fail).
// ---------------------------------------------------------------------------
test("lock preflight admits/blocks strictly by the watched relation set", async () => {
  const contended = [{ resolved_relations: 3, schema_established: 1, waiting_locks: 1, long_transactions: 0 }];

  // Watched: a waiter on the relation blocks the phase from starting.
  await assert.rejects(
    runMigrationLockPreflight(async () => ({ rows: contended }), 5000, "public", [
      "users",
      "server_members",
      "messages",
    ]),
    /MIGRATION_LOCK_PREFLIGHT_BLOCKED/,
    "a contended relation in the watched set must block admission",
  );

  // The relation set is passed through to the query itself: admission is
  // decided by what Postgres is asked about, not by a client-side filter.
  let observedRelations: readonly unknown[] | undefined;
  await runMigrationLockPreflight(async (_text, args) => {
    observedRelations = args?.[1] as readonly unknown[] | undefined;
    return { rows: [{ resolved_relations: 3, schema_established: 1, waiting_locks: 0, long_transactions: 0 }] };
  }, 5000, "public", ["messages", "servers", "server_invites"]);
  assert.deepEqual(
    observedRelations,
    ["messages", "servers", "server_invites"],
    "the locked relations must reach the pg_locks/pg_stat_activity query",
  );
});

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);
// Asserts on private CI/deploy files that the source-available snapshot does not
// carry; skipped when an exported snapshot's RELEASE_SOURCE marker is present.
const inSourceSnapshot = existsSync(path.join(repoRoot, "RELEASE_SOURCE"));

test.skipIf(inSourceSnapshot)("lock relations required by this batch's lock-heavy migrations are declared", () => {
  // Regression guard for the blind spot itself: 0259/0262 take parent locks on
  // messages/servers, 0264/0265 on server_invites/servers. The workflow env that
  // supplies the preflight must watch each, or the guard that exists to refuse a
  // contended start stays structurally blind to the table that deadlocks.
  // Reading the real workflow file means a future edit that drops one turns red.
  for (const rel of [
    ".github/workflows/deploy-aws-prod.yml",
    ".github/workflows/deploy-aws-staging.yml",
  ]) {
    const body = readFileSync(path.join(repoRoot, rel), "utf8");
    const match = body.match(/SERVER_MIGRATION_LOCK_RELATIONS:\s*'([^']*)'/);
    assert.ok(match, `${rel} must declare SERVER_MIGRATION_LOCK_RELATIONS`);
    const watched = match[1].split(",").map((entry) => entry.trim());
    for (const required of ["messages", "servers", "server_invites"]) {
      assert.ok(
        watched.includes(required),
        `${rel}: ${required} must be watched - this batch takes parent locks on it`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Relation-resolution tooth (2026-09-11, v1.13.0 cut; raised by @Hipp, same gap
// as the review's P1).
//
// The preflight's relation list is validated for SYNTAX only (non-empty,
// identifier shape, no duplicates) and the query matches with
// `relname = ANY($2::text[])`. So a name that does not exist - a typo, or drift
// after a table is renamed - matches nothing and raises nothing: the guard keeps
// passing while watching nothing. That silent blindness is the same shape as the
// bug that let the deadlock through, so an unresolvable name must fail closed
// instead of reporting a clear window.
// ---------------------------------------------------------------------------
test("lock preflight fails closed when a configured relation does not resolve", async () => {
  // One of three names resolves; the other two do not. Reporting "clear" here
  // would mean admitting a phase while watching a table that isn't there.
  await assert.rejects(
    runMigrationLockPreflight(
      async () => ({ rows: [{ resolved_relations: 1, schema_established: 1, waiting_locks: 0, long_transactions: 0 }] }),
      5000,
      "public",
      ["messages", "servers", "server_invites"],
    ),
    /MIGRATION_LOCK_PREFLIGHT_RELATION_UNRESOLVED/,
    "an unresolvable relation must not be reported as a clear window",
  );

  // All names resolve => a genuinely clear snapshot is still admitted, so the
  // tooth cannot be satisfied by "always fail closed".
  await runMigrationLockPreflight(
    async () => ({ rows: [{ resolved_relations: 3, schema_established: 1, waiting_locks: 0, long_transactions: 0 }] }),
    5000,
    "public",
    ["messages", "servers", "server_invites"],
  );

  // The resolution count must equal the configured count exactly: too few means
  // something is unwatched; a surprise extra cannot silently stand in.
  await assert.rejects(
    runMigrationLockPreflight(
      async () => ({ rows: [{ resolved_relations: 4, schema_established: 1, waiting_locks: 0, long_transactions: 0 }] }),
      5000,
      "public",
      ["messages", "servers", "server_invites"],
    ),
    /MIGRATION_LOCK_PREFLIGHT_RELATION_UNRESOLVED/,
  );

  // An unreadable resolution count is a read failure, not a clear window.
  await assert.rejects(
    runMigrationLockPreflight(
      async () => ({ rows: [{ waiting_locks: 0, long_transactions: 0 }] }),
      5000,
      "public",
      ["messages"],
    ),
    /MIGRATION_LOCK_PREFLIGHT_UNREADABLE/,
  );
});
