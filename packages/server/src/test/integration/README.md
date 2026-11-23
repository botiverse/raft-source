# Server integration tests

Use Vitest fixtures to remove per-case migrations, login setup, and cleanup
boilerplate. A file's cases share one PGlite restored from a migrated template
file built once per run, cleared back to the template between cases (see
[One database per file](#one-database-per-file)). Commits and inner transaction
rollbacks remain real.

```ts
import assert from "node:assert/strict";
import { apiTest } from "../test/integration/apiTest.js";

apiTest("lists the channel the reader can access", async ({ seed, http }) => {
  const reader = await seed.human();
  const server = await seed.server({ owner: reader });
  const channel = await seed.channel({ server, members: [reader] });
  const response = await http.as(reader, server).get("/api/channels");
  assert.equal(response.status, 200);
  const rows = await response.json() as Array<{ id: string }>;
  assert.ok(rows.some(row => row.id === channel.id));
});
```

- `dbTest` supplies `db`, `seed`, and `lifecycle`; `apiTest` also supplies `app`
  and `http`. Unused fixtures do not start a DB or import the app.
- Keep production defaults. For an intentional flag/configuration variant use
  `createApiTest({ humanActivityMuteFlagDefaultEnabled: true })`. Vitest 2 binds
  fixture dependencies at extension time, so do not override `appOptions` later.
- `http.as` and `tokenForHuman` issue real access tokens and run production auth.
  Tests of login, session families, refresh, or revocation must use real login.
  `fixturePasswordHash` caches only immutable fixture hashes, never auth results.
- Seed only preconditions. Call production code for the operation under test;
  include valid-access and unaffected-record witnesses in denial/filter tests.
- Register extra resources with `lifecycle.own(async () => stopAndJoinWork())`.
  Cleanup stops HTTP, drains registered DB work, then closes DB. Cleanup failures
  fail the case; a poisoned environment refuses further cases. Restore custom
  dependency overrides and environment variables in the test's own `finally`.
- Use `test.skipIf` and file parallelism. Vitest 2's runtime `context.skip()` skips
  teardown, so integration fixtures reject it; concurrent cases share a DB module
  and are rejected. Existing runner, worker, shard, and watchdog policy is retained.
- Loops, suite hooks, custom app options, and Playwright can use `openTestApp` /
  `openTestDatabase` with explicit `try/finally`. Close before opening another DB.
  Migration tests and real-Postgres contracts keep the production initializer.

## Choose PGlite or real PostgreSQL by contract

PGlite is the default for ordinary integration behavior, but it is not an
oracle for PostgreSQL wire-protocol limits. In particular, bind-parameter
boundary tests must run against real PostgreSQL:

- PostgreSQL accepts at most 65,535 bound parameters in one statement and
  rejects an over-limit bind with SQLSTATE `08P01`.
- PGlite reaches a different 32,767-parameter boundary and has been observed to
  fail silently beyond it. A passing or non-throwing PGlite result therefore
  cannot prove production behavior at either boundary.
- Put large fan-out, bulk `VALUES`, large `IN (...)`, and parameter-chunking
  boundary teeth in a `*.realPg.test.ts` contract backed by a hosted PostgreSQL
  service. Make CI set both the test URL and a `*_REQUIRED=1` guard so a missing
  database fails the job instead of turning the contract into a skip.
- PGlite remains useful for behavior comfortably below these limits. If a test
  asks what PostgreSQL accepts, rejects, or reports at the bind boundary, only
  the real-PostgreSQL result is authoritative.

Run existing shard commands. `RAFT_TEST_PROFILE=1` adds per-case elapsed time,
DB/app/seed/cleanup timings and process memory. `cleanup` contains the close
subphases; do not add overlapping phases. Use `lifecycle.measure("operation", fn)`
for an explicit operation measurement. Without the flag, each file's phase totals
still reach the shard's `[serverShardTimings]` lines (one line per file).

## One database per file

A file's first `dbTest` / `apiTest` case restores a fresh database; when a case ends, `reuseProbe.ts`
reclaims it for the next case (#triage:#516, step 2): `DISCARD ALL` resets the session (settings,
prepared statements, cursors, LISTEN, advisory locks, SET ROLE), then a check discards the database,
and the next case restores a fresh one, if the case failed, left a transaction open or aborted, made
temp tables, moved the catalogs (DDL, roles, comments, its own TRUNCATE) or a sequence no table owns.
Otherwise the tables the case wrote are truncated with identities restarted, changed seeded tables
are restored, sequences go back to the template's values, and with `RAFT_TEST_DB_REUSE_CHECK` on (the
default) a self-check against the template must pass, or the database is discarded (never the case).
Kept databases are detached between cases (`isDatabaseInitialized()` is false) and closed with the
file. Explicit `openTestDatabase` / `openTestApp` calls and a case that closes its own database never
share one. Counts (`restored` / `reused`, `reusable`, `drop.<reason>`, `discarded.<kind>`,
`selfCheckFailed`, `probeError`, `probeTimeout`, `closeTimeout`, `writtenTables`, `seededRestored`, `setting.<name>`,
`sequence.<name>`) reach the `[serverShardTimings]` lines as `reuse`, time as the `reuseBaseline`,
`reuseCheck`, `reuseDiscard`, `reuseTruncate`, `reuseSeeded`, `reuseSequences` and `reuseSelfCheck`
phases (inside `databaseClose`, itself inside `cleanup`). `RAFT_TEST_DB_REUSE=0` restores a fresh
database for every case; a file on `REUSE_OPT_OUT` (reuseProbe.ts, with a one-line reason) does so for
its own cases (counted as `optedOut`).

A test PGlite closes only once no `query` / `exec` / `transaction` call runs on it (`pgliteClose.ts`):
PGlite spins forever, synchronously, when a statement runs on an instance closed under it, and work a
case never awaited (an `AgentOrchestrator`'s `setIO` sweeps) can still be querying when the case's
database closes. From the close on, new calls are refused ("PGlite is closing"). A database still busy
5 s later is left open and counted as `closeTimeout`: a stuck case costs one database, not the file.

## PGlite template file

- The Vitest globalSetup (`src/test/setup/pgliteTemplate.global.ts`) builds the
  migrated datadir in a child process and caches it at
  `node_modules/.cache/raft-pglite-template/pglite-template-<key>.tar` (newest 3 kept).
- The key hashes the drizzle journal, every migration's SQL, the PGlite
  compatibility statements, the installed `@electric-sql/pglite` version and
  `TEMPLATE_FORMAT_VERSION`; `migratePglite` still runs after each restore.
- A worker reads the template file once and restores every fresh database from
  that one in-memory copy (Vitest gives each test file its own worker).
- `RAFT_TEST_PGLITE_TEMPLATE=rebuild` forces a fresh build; `=off` disables it.
- A Vitest worker without the template warns and migrates per file; under CI it
  fails. Playwright servers and scripts keep a process-local snapshot.
