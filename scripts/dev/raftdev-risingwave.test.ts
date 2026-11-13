/** Focused tests for raftdev's optional RisingWave standalone dependency. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_RISINGWAVE_IMAGE,
  hasRisingWaveSeedPostgresOwnershipProof,
  ORPHAN_RISINGWAVE_GRACE_MS,
  orphanRisingWaveContainers,
  parseRisingWaveMemoryBytes,
  RISINGWAVE_CONFIG,
  RISINGWAVE_CONFIG_IN_CONTAINER,
  RAFTDEV_OWNER_LABEL,
  raftdevOwner,
  parseRisingWaveLocalProfile,
  RISINGWAVE_DISABLED_WARNING,
  postgresDockerRunArgs,
  RAFTDEV_MANAGED_LABEL,
  replicaMetricsPort,
  replicaServerPort,
  resolveRisingWaveDependency,
  risingWaveDockerRunArgs,
  risingWaveDashboardPort,
  risingWaveDatabaseUrlCommandAssignment,
  risingWaveNeedsBootstrap,
  risingWavePort,
  risingWaveServerEnvironment,
  scrubExternalRisingWaveDatabaseUrl,
  shouldRefuseExternalRisingWaveTransition,
  shouldRefuseRisingWaveSeedWithoutState,
  waitForRisingWaveReadiness,
} from "./raftdev";
import {
  buildRisingWaveBootstrapStatements,
  createCdcTableStatement,
  createdIndexTarget,
  createdRelationName,
  referencedRelations,
  RISINGWAVE_ARTIFACT_CDC_TABLES,
  RISINGWAVE_BOOTSTRAP_ARTIFACTS,
  RISINGWAVE_CDC_TABLES,
  RISINGWAVE_LOCAL_SOURCE,
  RISINGWAVE_PUBLICATION_TABLES,
  RISINGWAVE_REQUIRED_RELATIONS,
  RISINGWAVE_SERVER_READ_RELATIONS,
  splitSqlStatements,
} from "./raftdev-risingwave-bootstrap";
import { renderReleaseQaRisingWaveBootstrap } from "./emit-risingwave-bootstrap";

// Asserts on private CI/deploy files that the source-available snapshot does not
// carry; skipped when an exported snapshot's RELEASE_SOURCE marker is present.
const inSourceSnapshot = existsSync(new URL("../../RELEASE_SOURCE", import.meta.url));

function loadActualBootstrapArtifacts(): Record<string, string> {
  return Object.fromEntries(RISINGWAVE_BOOTSTRAP_ARTIFACTS.map((artifact) => [
    artifact.file,
    readFileSync(new URL(`../../${artifact.file}`, import.meta.url), "utf8"),
  ]));
}

test("the RisingWave switch parses unset, the 0 opt-out, and full/process-only profiles", () => {
  assert.equal(parseRisingWaveLocalProfile(undefined), null);
  assert.equal(parseRisingWaveLocalProfile(""), null);
  assert.equal(parseRisingWaveLocalProfile(" 0 "), "off");
  assert.equal(parseRisingWaveLocalProfile(" 1 "), "full");
  assert.equal(parseRisingWaveLocalProfile(" full "), "full");
  assert.equal(parseRisingWaveLocalProfile(" process-only "), "process-only");
  for (const raw of ["true", "false", "yes", "2", "-1", "00", "01", "1.0", "process"]) {
    assert.throws(
      () => parseRisingWaveLocalProfile(raw),
      /must be 0, 1, full, or process-only/,
    );
  }
});

test("dependency resolution starts managed local full by default; 0 / --no-risingwave opts out", () => {
  const local = {
    mode: "local",
    profile: "full",
    databaseUrl: "postgresql://root@127.0.0.1:17666/dev",
    image: DEFAULT_RISINGWAVE_IMAGE,
  };
  // Unset and blank both mean the default.
  assert.deepEqual(resolveRisingWaveDependency(undefined, undefined, "postgresql://root@127.0.0.1:17666/dev", undefined), local);
  assert.deepEqual(resolveRisingWaveDependency(" ", undefined, "postgresql://root@127.0.0.1:17666/dev", undefined), local);
  // --risingwave stays accepted and means the default.
  assert.deepEqual(resolveRisingWaveDependency("1", undefined, "postgresql://root@127.0.0.1:17666/dev", undefined), local);
  assert.deepEqual(resolveRisingWaveDependency("0", undefined, "postgresql://root@127.0.0.1:17666/dev", undefined), { mode: "disabled" });
});

test("the CLI maps --no-risingwave to 0 and keeps --risingwave as the default alias", () => {
  const source = readFileSync(new URL("./raftdev.ts", import.meta.url), "utf8");
  assert.match(source, /a === "--no-risingwave"\) \{\s*risingWaveLocalRaw = "0";/);
  assert.match(source, /a === "--risingwave"\) \{[^}]*risingWaveLocalRaw = "1";/);
  assert.match(
    RISINGWAVE_DISABLED_WARNING.join(" "),
    /Activity endpoints \(inbox, followed threads, unread summary, channel unread\)\s+will return 503/,
  );
});

test("dependency resolution selects full local CDC by default and preserves process-only", () => {
  assert.deepEqual(
    resolveRisingWaveDependency("1", undefined, "postgresql://root@127.0.0.1:17734/dev", undefined),
    {
      mode: "local",
      profile: "full",
      databaseUrl: "postgresql://root@127.0.0.1:17734/dev",
      image: DEFAULT_RISINGWAVE_IMAGE,
    },
  );
  assert.deepEqual(
    resolveRisingWaveDependency("1", undefined, "postgresql://root@127.0.0.1:17734/dev", " rw:test "),
    {
      mode: "local",
      profile: "full",
      databaseUrl: "postgresql://root@127.0.0.1:17734/dev",
      image: "rw:test",
    },
  );
  assert.deepEqual(
    resolveRisingWaveDependency(
      "process-only",
      undefined,
      "postgresql://root@127.0.0.1:17734/dev",
      undefined,
    ),
    {
      mode: "local",
      profile: "process-only",
      databaseUrl: "postgresql://root@127.0.0.1:17734/dev",
      image: DEFAULT_RISINGWAVE_IMAGE,
    },
  );
});

test("only a managed local full profile runs CDC/MV bootstrap", () => {
  assert.equal(risingWaveNeedsBootstrap({ mode: "local", profile: "full" }), true);
  assert.equal(risingWaveNeedsBootstrap({ mode: "local", profile: "process-only" }), false);
  assert.equal(risingWaveNeedsBootstrap({ mode: "external", databaseUrl: "postgres://rw/dev" }), false);
  assert.equal(risingWaveNeedsBootstrap({ mode: "disabled" }), false);
});

test("managed RisingWave defaults to the reviewed exact v2.8.0 image digest", () => {
  assert.equal(
    DEFAULT_RISINGWAVE_IMAGE,
    "risingwavelabs/risingwave@sha256:ba5915a5e85c938a3ec62d76c63c6e4cb37d4f4e3c5c30886f0d2eff61b70073",
  );
});

test("dependency resolution supports an external URL without exposing a local container", () => {
  assert.deepEqual(
    resolveRisingWaveDependency(undefined, " postgresql://rw.example:4566/dev ", "unused", undefined),
    { mode: "external", databaseUrl: "postgresql://rw.example:4566/dev" },
  );
  // The 0 opt-out only skips the managed container; an explicit external URL
  // is still used.
  assert.deepEqual(
    resolveRisingWaveDependency("0", "postgresql://rw.example:4566/dev", "unused", undefined),
    { mode: "external", databaseUrl: "postgresql://rw.example:4566/dev" },
  );
  assert.deepEqual(
    resolveRisingWaveDependency("0", "   ", "unused", undefined),
    { mode: "disabled" },
  );
});

test("external DSN is scrubbed from the ambient child-process environment", () => {
  const environment: NodeJS.ProcessEnv = {
    RISINGWAVE_DATABASE_URL: "postgresql://secret-user:secret-password@example.invalid/dev",
    RISINGWAVE_POOL_MAX: "17",
    UNRELATED: "kept",
  };
  const config = resolveRisingWaveDependency(
    undefined,
    environment.RISINGWAVE_DATABASE_URL,
    "unused",
    undefined,
  );
  scrubExternalRisingWaveDatabaseUrl(config, environment);
  assert.equal(config.databaseUrl, "postgresql://secret-user:secret-password@example.invalid/dev");
  assert.equal(environment.RISINGWAVE_DATABASE_URL, undefined);
  assert.equal(environment.RISINGWAVE_POOL_MAX, "17");
  assert.equal(environment.UNRELATED, "kept");
});

test("reseed fails closed when RisingWave ownership state is lost or invalid", () => {
  assert.equal(shouldRefuseRisingWaveSeedWithoutState(true, true, true, "present"), false);
  assert.equal(shouldRefuseRisingWaveSeedWithoutState(false, true, false, "absent"), true);
  assert.equal(shouldRefuseRisingWaveSeedWithoutState(false, false, true, "absent"), true);
  assert.equal(shouldRefuseRisingWaveSeedWithoutState(false, false, false, "present"), true);
  assert.equal(shouldRefuseRisingWaveSeedWithoutState(false, false, false, "unknown"), true);
  assert.equal(shouldRefuseRisingWaveSeedWithoutState(false, false, false, "absent"), false);
});

test("reseed requires positive Postgres ownership proof", () => {
  assert.equal(hasRisingWaveSeedPostgresOwnershipProof(true, null, false), true);
  assert.equal(hasRisingWaveSeedPostgresOwnershipProof(false, "local", false), true);
  assert.equal(hasRisingWaveSeedPostgresOwnershipProof(false, null, true), true);
  assert.equal(hasRisingWaveSeedPostgresOwnershipProof(false, "external", false), false);
  assert.equal(hasRisingWaveSeedPostgresOwnershipProof(false, null, false), false);
});

test("external profile refuses to orphan managed local RisingWave residue", () => {
  assert.equal(shouldRefuseExternalRisingWaveTransition("local", true, false, false, false), true);
  assert.equal(shouldRefuseExternalRisingWaveTransition("local", false, false, true, false), true);
  assert.equal(shouldRefuseExternalRisingWaveTransition(null, true, true, false, false), true);
  assert.equal(shouldRefuseExternalRisingWaveTransition(null, false, false, true, true), true);
  assert.equal(shouldRefuseExternalRisingWaveTransition(null, true, false, true, false), false);
  assert.equal(shouldRefuseExternalRisingWaveTransition("local", false, false, false, false), false);
  assert.equal(shouldRefuseExternalRisingWaveTransition("external", true, true, true, true), false);
});

test("local and external RisingWave modes are mutually exclusive", () => {
  assert.throws(
    () => resolveRisingWaveDependency("1", "postgresql://rw.example:4566/dev", "local", undefined),
    /cannot be combined/,
  );
});

test("disabled mode injects no server env and preserves the default command", () => {
  assert.deepEqual(
    risingWaveServerEnvironment({ mode: "disabled" }, {
      RISINGWAVE_POOL_MAX: "17",
      RISINGWAVE_CONNECTION_TIMEOUT_MS: "750",
    }),
    {},
  );
  assert.deepEqual(
    risingWaveServerEnvironment({
      mode: "disabled",
      databaseUrl: "must-not-leak",
    }, {
      RISINGWAVE_POOL_MAX: "17",
    }),
    {},
  );
});

test("enabled mode injects the URL and only explicitly supplied tuning", () => {
  assert.deepEqual(
    risingWaveServerEnvironment({
      mode: "local",
      databaseUrl: "postgresql://root@127.0.0.1:17734/dev",
    }, {
      RISINGWAVE_POOL_MAX: "17",
      RISINGWAVE_INBOX_RFC056_SERVING_MODE: "shadow",
      RISINGWAVE_CONNECTION_TIMEOUT_MS: undefined,
      UNRELATED: "must-not-pass",
    }),
    {
      RISINGWAVE_DATABASE_URL: "postgresql://root@127.0.0.1:17734/dev",
      RISINGWAVE_POOL_MAX: "17",
      RISINGWAVE_INBOX_RFC056_SERVING_MODE: "shadow",
    },
  );
});

test("external DSN command assignment reads a protected file without embedding credentials", () => {
  const secretDsn = "postgresql://secret-user:secret-password@example.invalid:4566/dev";
  const assignment = risingWaveDatabaseUrlCommandAssignment({
    mode: "external",
    databaseUrl: secretDsn,
  }, "/tmp/raftdev env/risingwave-dsn");
  assert.equal(
    assignment,
    "RISINGWAVE_DATABASE_URL=\"$(cat -- '/tmp/raftdev env/risingwave-dsn')\"",
  );
  assert.doesNotMatch(assignment ?? "", /secret-user|secret-password|example\.invalid/);
  assert.equal(
    risingWaveDatabaseUrlCommandAssignment({
      mode: "local",
      databaseUrl: "postgresql://root@127.0.0.1:17734/dev",
    }, "unused"),
    "RISINGWAVE_DATABASE_URL=postgresql://root@127.0.0.1:17734/dev",
  );
});

test("RisingWave host ports occupy deterministic disjoint bands", () => {
  const rwSql = new Set<number>();
  const rwDashboard = new Set<number>();
  const existing = new Set<number>();
  for (let offset = 0; offset <= 99; offset++) {
    rwSql.add(risingWavePort(offset));
    rwDashboard.add(risingWaveDashboardPort(offset));

    // Every existing raftdev band that neighbors or could reach the new ones.
    existing.add(14001 + offset); // latency proxy
    existing.add(15173 + offset); // web
    existing.add(15432 + offset); // Postgres
    existing.add(16379 + offset); // Redis
    existing.add(17317 + offset); // otelcol gRPC
    existing.add(17417 + offset); // otelcol HTTP
    existing.add(18787 + offset); // trace worker
    existing.add(19000 + offset); // RustFS
    existing.add(19100 + offset); // RustFS console
    for (let replica = 1; replica <= 8; replica++) {
      existing.add(replicaServerPort(offset, replica));
      const metrics = replicaMetricsPort(offset, replica);
      if (metrics !== null) existing.add(metrics);
    }
  }

  assert.equal(rwSql.size, 100);
  assert.equal(rwDashboard.size, 100);
  for (const port of rwSql) {
    assert.ok(!rwDashboard.has(port), `RisingWave SQL/dashboard collision at ${port}`);
    assert.ok(!existing.has(port), `RisingWave SQL/existing collision at ${port}`);
  }
  for (const port of rwDashboard) {
    assert.ok(!existing.has(port), `RisingWave dashboard/existing collision at ${port}`);
  }
});

test("an environment's RisingWave is orphaned only when it is this checkout's, its tmux session is gone, and it has run past the grace", () => {
  const now = Date.parse("2026-10-23T08:00:00Z");
  const old = now - ORPHAN_RISINGWAVE_GRACE_MS - 1;
  const running = new Set(["slock-alive"]);
  assert.deepEqual(
    orphanRisingWaveContainers([
      { name: "slock-dev-alive-risingwave", startedAt: old, owner: "me" },
      { name: "slock-dev-gone-risingwave", startedAt: old, owner: "me" },
      { name: "slock-dev-starting-risingwave", startedAt: now - 60_000, owner: "me" },
      { name: "slock-dev-gone-pg", startedAt: old, owner: "me" },
      // Another agent's or user's: its tmux session isn't visible from here.
      { name: "slock-dev-theirs-risingwave", startedAt: old, owner: "someone-else" },
      // No owner (started before owner labels): never touched.
      { name: "slock-dev-legacy-risingwave", startedAt: old },
    ], "me", (session) => running.has(session), now),
    ["slock-dev-gone-risingwave"],
  );
});

test("RisingWave carries the owner label when given, and owners differ per checkout", () => {
  const args = risingWaveDockerRunArgs({
    RISINGWAVE_CONTAINER: "slock-dev-demo-risingwave",
    RISINGWAVE_PORT: 17734,
    RISINGWAVE_DASHBOARD_PORT: 17934,
  }, "risingwave:test", undefined, { owner: "abc123" });
  assert.ok(args.includes(`${RAFTDEV_OWNER_LABEL}=abc123`));
  assert.equal(raftdevOwner("/a").length, 16);
  assert.notEqual(raftdevOwner("/a"), raftdevOwner("/b"));
});

test("RisingWave's memory: 2 GiB by default, the Docker limit 1 GiB above, the compactor's limit from a mounted config", () => {
  assert.equal(parseRisingWaveMemoryBytes(undefined), 2147483648);
  assert.equal(parseRisingWaveMemoryBytes("4294967296"), 4294967296);
  assert.equal(parseRisingWaveMemoryBytes("2147483648"), 2147483648);
  const args = risingWaveDockerRunArgs({
    RISINGWAVE_CONTAINER: "slock-dev-demo-risingwave",
    RISINGWAVE_PORT: 17734,
    RISINGWAVE_DASHBOARD_PORT: 17934,
  }, "risingwave:test", undefined, { memoryBytes: 4294967296, configFile: "/env/risingwave.toml" });
  assert.deepEqual(args.slice(args.indexOf("--memory"), args.indexOf("--memory") + 6), [
    "--memory", "5368709120", "--memory-swap", "5368709120", "-v", `/env/risingwave.toml:${RISINGWAVE_CONFIG_IN_CONTAINER}:ro`,
  ]);
  assert.deepEqual(args.slice(-4), ["--total-memory-bytes", "4294967296", "--config-path", RISINGWAVE_CONFIG_IN_CONTAINER]);
  assert.match(RISINGWAVE_CONFIG, /^\[storage\]\ncompactor_memory_limit_mb = 768$/m);
});

test("process-only RisingWave Docker args bind pgwire/dashboard without a CDC network", () => {
  assert.deepEqual(
    risingWaveDockerRunArgs({
      RISINGWAVE_CONTAINER: "slock-dev-demo-risingwave",
      RISINGWAVE_PORT: 17734,
      RISINGWAVE_DASHBOARD_PORT: 17934,
    }, "risingwave:test"),
    [
      "run", "-d", "--pull=always", "--name", "slock-dev-demo-risingwave",
      "--label", `${RAFTDEV_MANAGED_LABEL}=true`,
      "-p", "127.0.0.1:17734:4566",
      "-p", "127.0.0.1:17934:5691",
      "--memory", "3221225472",
      "--memory-swap", "3221225472",
      "risingwave:test",
      "single_node",
      "--total-memory-bytes", "2147483648",
    ],
  );
});

test("full RisingWave Docker args join the per-environment CDC network", () => {
  assert.deepEqual(
    risingWaveDockerRunArgs({
      RISINGWAVE_CONTAINER: "slock-dev-demo-risingwave",
      RISINGWAVE_PORT: 17734,
      RISINGWAVE_DASHBOARD_PORT: 17934,
    }, DEFAULT_RISINGWAVE_IMAGE, "slock-dev-demo-risingwave-net"),
    [
      "run", "-d", "--pull=always", "--name", "slock-dev-demo-risingwave",
      "--label", `${RAFTDEV_MANAGED_LABEL}=true`,
      "--network", "slock-dev-demo-risingwave-net",
      "-p", "127.0.0.1:17734:4566",
      "-p", "127.0.0.1:17934:5691",
      "--memory", "3221225472",
      "--memory-swap", "3221225472",
      DEFAULT_RISINGWAVE_IMAGE,
      "single_node",
      "--total-memory-bytes", "2147483648",
    ],
  );
});

test("Postgres Docker args keep the non-CDC shape while adding ownership", () => {
  assert.deepEqual(
    postgresDockerRunArgs({
      CONTAINER: "slock-dev-demo-postgres",
      PG_PORT: 15500,
      POSTGRES_PASSWORD: "dev-secret",
      RISINGWAVE_NETWORK: "unused",
    }),
    [
      "run", "-d", "--name", "slock-dev-demo-postgres",
      "--label", `${RAFTDEV_MANAGED_LABEL}=true`,
      "-e", "POSTGRES_DB=slock",
      "-e", "POSTGRES_USER=postgres",
      "-e", "POSTGRES_PASSWORD=dev-secret",
      "-p", "15500:5432",
      "postgres:16-alpine",
    ],
  );
});

test("full Postgres Docker args enable bounded logical replication on the shared network", () => {
  assert.deepEqual(
    postgresDockerRunArgs({
      CONTAINER: "slock-dev-demo-postgres",
      PG_PORT: 15500,
      POSTGRES_PASSWORD: "dev-secret",
      RISINGWAVE_NETWORK: "slock-dev-demo-risingwave-net",
    }, true),
    [
      "run", "-d", "--name", "slock-dev-demo-postgres",
      "--label", `${RAFTDEV_MANAGED_LABEL}=true`,
      "--network", "slock-dev-demo-risingwave-net",
      "-e", "POSTGRES_DB=slock",
      "-e", "POSTGRES_USER=postgres",
      "-e", "POSTGRES_PASSWORD=dev-secret",
      "-p", "15500:5432",
      "postgres:16-alpine",
      "-c", "wal_level=logical",
      "-c", "max_replication_slots=10",
      "-c", "max_wal_senders=10",
      "-c", "max_slot_wal_keep_size=256MB",
    ],
  );
});

test("CDC manifest covers the exact 16-table publication and deliberate versioned aliases", () => {
  assert.deepEqual([...RISINGWAVE_PUBLICATION_TABLES], [
    "channels",
    "messages",
    "channel_humans",
    "channel_agents",
    "user_channel_read_cursors",
    "agent_channel_read_cursors",
    "user_channel_inbox_states",
    "thread_follows",
    "message_mentions",
    "server_members",
    "joint_channels",
    "joint_channel_servers",
    "inbox_suppression_states",
    "inbox_target_mute_states",
    "servers",
    "tasks",
  ]);
  assert.equal(new Set(RISINGWAVE_PUBLICATION_TABLES).size, 16);
  assert.deepEqual(RISINGWAVE_CDC_TABLES.map((table) => table.name), [
    "rw_channels",
    "rw_messages",
    "rw_channel_humans",
    "rw_channel_agents",
    "rw_user_channel_read_cursors_v2",
    "rw_agent_channel_read_cursors",
    "rw_user_channel_inbox_states",
    "rw_thread_follows",
    "rw_message_mentions_v2",
    "rw_server_members",
    "rw_joint_channels",
    "rw_joint_channel_servers",
    "rw_inbox_suppression_states",
    "rw_tasks",
  ]);
  assert.deepEqual(
    RISINGWAVE_CDC_TABLES
      .filter((table) => table.upstream === "user_channel_read_cursors")
      .map((table) => table.name),
    ["rw_user_channel_read_cursors_v2"],
  );
  // Every publication table feeds exactly the CDC relations the graph reads;
  // the two artifact-owned ones (061) come with their production DDL.
  const fed = new Set([
    ...RISINGWAVE_CDC_TABLES.map((table) => table.upstream),
    ...RISINGWAVE_ARTIFACT_CDC_TABLES.map((table) => table.upstream),
  ]);
  assert.deepEqual([...fed].sort(), [...RISINGWAVE_PUBLICATION_TABLES].sort());
  assert.equal(
    RISINGWAVE_CDC_TABLES.some((table) => table.upstream === "inbox_target_mute_states"),
    false,
    "the RFC-061 chain artifact owns the sole versioned mute CDC table",
  );
});

test("explicit CDC statements preserve upstream PKs and exclude unsupported message columns", () => {
  const statements = RISINGWAVE_CDC_TABLES.map(createCdcTableStatement);
  for (const [index, statement] of statements.entries()) {
    const table = RISINGWAVE_CDC_TABLES[index];
    assert.match(statement, new RegExp(`^CREATE TABLE ${table.name} \\(`));
    assert.match(
      statement,
      new RegExp(`PRIMARY KEY \\(${table.primaryKey.join(", ")}\\)`),
    );
    assert.match(
      statement,
      new RegExp(`FROM ${RISINGWAVE_LOCAL_SOURCE} TABLE 'public\\.${table.upstream}'$`),
    );
    assert.doesNotMatch(statement, /\(\*\)|IF NOT EXISTS/);
  }

  const messages = statements.find((statement) => statement.startsWith("CREATE TABLE rw_messages "));
  assert.equal(messages, [
    "CREATE TABLE rw_messages (",
    "  id varchar,",
    "  seq bigint,",
    "  channel_id varchar,",
    "  sender_type varchar,",
    "  sender_id varchar,",
    "  content varchar,",
    "  created_at timestamptz,",
    "  message_type varchar,",
    "  causal_actor_type varchar,",
    "  causal_actor_id varchar,",
    "  system_subtype varchar,",
    "  task_status varchar,",
    "  task_number int,",
    "  task_assignee_type varchar,",
    "  task_assignee_id varchar,",
    "  PRIMARY KEY (id)",
    ") FROM slockdev_pg_cdc TABLE 'public.messages'",
  ].join("\n"));
  assert.doesNotMatch(messages ?? "", /search_vector|tsvector|action_metadata/);

  const mentions = RISINGWAVE_CDC_TABLES.find((table) => table.name === "rw_message_mentions_v2");
  assert.deepEqual(mentions?.primaryKey, ["id"]);
  assert.deepEqual(mentions?.columns, [
    "id varchar",
    "message_id varchar",
    "message_seq bigint",
    "channel_id varchar",
    "target_type varchar",
    "target_id varchar",
    "notifiable_at_send boolean",
    "notified_at timestamptz",
  ]);

  const readCursors = RISINGWAVE_CDC_TABLES.find(
    (table) => table.name === "rw_user_channel_read_cursors_v2",
  );
  assert.deepEqual(readCursors?.columns, [
    "user_id varchar",
    "channel_id varchar",
    "last_read_seq int",
    "read_state_version int",
    "last_applied_authority_seq bigint",
  ]);

});

test("SQL splitter ignores semicolons in strings, identifiers, comments, and dollar quotes", () => {
  const statements = splitSqlStatements([
    "SELECT ';' AS value;",
    "SELECT \"semi;colon\" FROM t; -- ignored ;",
    "/* ignored ; /* nested ; */ still ignored */ SELECT $$body;value$$;",
  ].join("\n"));
  assert.equal(statements.length, 3);
  assert.match(statements[0], /SELECT ';' AS value/);
  assert.match(statements[1], /SELECT \"semi;colon\" FROM t/);
  assert.match(statements[2], /SELECT \$\$body;value\$\$/);
});

test("actual RFC bootstrap uses foreground settings and rewrites the production source", { skip: inSourceSnapshot }, () => {
  const statements = buildRisingWaveBootstrapStatements(loadActualBootstrapArtifacts());
  assert.equal(statements[0], "SET BACKGROUND_DDL = false");
  assert.equal(statements[1], "SET STREAMING_PARALLELISM = 1");

  const sql = statements.join(";\n");
  assert.ok((sql.match(/SET\s+BACKGROUND_DDL\s*=\s*false/gi)?.length ?? 0) >= 1);
  assert.ok((sql.match(/SET\s+STREAMING_PARALLELISM\s*=\s*1/gi)?.length ?? 0) >= 1);
  assert.doesNotMatch(sql, /SET\s+BACKGROUND_DDL\s*=\s*true/i);
  assert.doesNotMatch(sql, /SET\s+STREAMING_PARALLELISM\s*=\s*(?:4|8)\b/i);
  assert.doesNotMatch(sql, /\bslock_neon_cdc\b/);
  assert.match(
    sql,
    /CREATE TABLE rw_user_channel_read_cursors_v2[\s\S]*FROM slockdev_pg_cdc TABLE 'public\.user_channel_read_cursors'/,
  );
  const muteCdc = statements.find(
    (statement) => createdRelationName(statement) === "rw_inbox_target_mute_states_v2",
  );
  assert.match(
    muteCdc ?? "",
    /FROM slockdev_pg_cdc TABLE 'public\.inbox_target_mute_states'/,
  );
});

test("actual RFC bootstrap preserves dependency order and excludes superseded generations", { skip: inSourceSnapshot }, () => {
  const statements = buildRisingWaveBootstrapStatements(loadActualBootstrapArtifacts());
  const names = statements
    .map(createdRelationName)
    .filter((name): name is string => name !== null);
  const cdcNames = RISINGWAVE_CDC_TABLES.map((table) => table.name);
  assert.deepEqual(names.slice(0, cdcNames.length), cdcNames);

  // Independent point-order checks (self-referential whole-list comparisons
  // prove nothing — #8017 lesson). The v4 base (063-unified) precedes the v5
  // arms (063-chain-v5) even though the file names sort the other way.
  const before = (a: string, b: string) =>
    assert.ok(names.indexOf(a) >= 0 && names.indexOf(a) < names.indexOf(b), `${a} before ${b}`);
  before("rw_inbox_target_mute_states_v2", "rw_subs_v2");
  before("rw_servers", "rw_target_eligible_v1");
  before("rw_message_target_v3", "rw_target_latest_v4");
  before("rw_target_eligible_v1", "rw_inbox_normal_v5");
  before("rw_target_latest_v4", "rw_inbox_normal_v5");
  before("rw_receiver_cursors_v1", "rw_inbox_muted_prefix_v2");
  before("rw_muted_subs_v1", "rw_inbox_muted_full_v1");
  before("rw_receiver_cursors_v1", "rw_inbox_muted_full_v1");
  before("rw_thread_parent_v3", "rw_conversation_parent_v1");
  before("rw_conversation_parent_v1", "rw_inbox_mention_v7");
  before("rw_target_eligible_v1", "rw_inbox_mention_v7");
  before("rw_inbox_mention_v7", "rw_inbox_items_v13");
  before("rw_inbox_muted_prefix_v2", "rw_inbox_items_v13");
  before("rw_conversation_parent_v1", "rw_inbox_items_v13");
  before("rw_conversation_parent_v1", "rw_activity_watermark_v7");
  before("rw_activity_watermark_v7", "rw_inbox_serving_v9");
  before("rw_inbox_items_v13", "rw_inbox_serving_v9");
  before("rw_inbox_items_v13", "rw_inbox_preview_need_v1");
  before("rw_task_conversation_unread_v1", "rw_inbox_preview_need_v1");
  before("rw_inbox_preview_need_v1", "rw_inbox_preview_seq_v1");
  before("rw_conversation_parent_v1", "rw_inbox_preview_parent_v1");
  before("rw_inbox_preview_seq_v1", "rw_inbox_serving_v9");
  before("rw_inbox_preview_parent_v1", "rw_inbox_serving_v9");
  before("rw_inbox_preview_seq_v1", "rw_conversation_unread_v4");
  before("rw_tasks", "rw_inbox_serving_v9");
  before("rw_message_target_v3", "rw_task_conversation_replies_v1");
  before("rw_task_conversation_replies_v1", "rw_inbox_serving_v9");
  before("rw_receiver_cursors_v1", "rw_task_conversation_unread_v1");
  before("rw_task_conversation_unread_v1", "rw_inbox_serving_v9");
  before("rw_task_conversation_unread_v1", "rw_conversation_unread_v4");
  before("rw_inbox_serving_v9", "rw_activity_totals_v7");
  before("rw_inbox_normal_v5", "rw_agent_inbox_v7");
  before("rw_conversation_parent_v1", "rw_agent_inbox_v7");
  before("rw_inbox_muted_full_v1", "rw_conversation_unread_v4");
  before("rw_conversation_parent_v1", "rw_conversation_unread_v4");
  before("rw_receiver_cursors_v1", "rw_followed_threads_v5");
  before("rw_tasks", "rw_followed_threads_v5");

  // Superseded / retired generations must not resurface.
  for (const retired of [
    "rw_inbox_items_v2",
    "rw_inbox_items_v2_suppressed_v3_4",
    "rw_sidebar_unread_summary_v1",
    "rw_channel_unread_counts_v2",
    "rw_channel_latest_message_v1",
    "rw_user_channel_unread_v1",
    "rw_inbox_serving_v3",
    "rw_inbox_serving_v4",
    "rw_inbox_serving_v5",
    "rw_inbox_items_v7",
    "rw_inbox_items_v8",
    "rw_inbox_items_v9",
    "rw_inbox_mention_v4",
    "rw_inbox_mention_v5",
    "rw_activity_totals_v1",
    "rw_activity_totals_v2",
    "rw_activity_totals_v3",
    "rw_activity_watermark_v4",
    "rw_agent_inbox_v1",
    "rw_agent_inbox_v2",
    "rw_agent_inbox_v3",
    "rw_agent_inbox_v4",
    "rw_conversation_unread_v1",
    "rw_conversation_unread_v2",
    "rw_inbox_normal_v4",
    "rw_inbox_muted_prefix_v1",
    // 078's conversation unread reads 066's rw_inbox_muted_full_v1 instead.
    "rw_inbox_muted_full_v2",
    "rw_inbox_items_v10",
    "rw_inbox_serving_v6",
    "rw_activity_totals_v4",
    "rw_agent_inbox_v5",
    "rw_inbox_serving_v7",
    "rw_activity_totals_v5",
    "rw_activity_watermark_v5",
    // Superseded by 078 (task conversations as sub-conversations).
    "rw_inbox_mention_v6",
    "rw_inbox_items_v11",
    "rw_inbox_items_v12",
    "rw_activity_watermark_v6",
    "rw_inbox_serving_v8",
    "rw_activity_totals_v6",
    "rw_agent_inbox_v6",
    "rw_conversation_unread_v3",
    // The retired task-anchor generation of 078 (never deployed).
    "rw_message_target_v4",
    "rw_target_latest_v5",
    "rw_target_eligible_v2",
    "rw_inbox_normal_v6",
    "rw_inbox_muted_full_v3",
    "rw_inbox_muted_prefix_v3",
    "rw_followed_thread_stats_v1",
    "rw_followed_thread_stats_v2",
    "rw_followed_thread_stats_v3",
    "rw_followed_threads_v4",
    "rw_message_mentions",
    "rw_inbox_notification_facts_v1",
    "rw_read_mutation_authorities_v1",
  ]) {
    assert.equal(names.includes(retired), false, `${retired} must stay out of the bootstrap`);
  }

  // Indexes ride with their base relation and only with it.
  for (const statement of statements) {
    const target = createdIndexTarget(statement);
    if (target) assert.ok(names.indexOf(target) < names.indexOf(createdRelationName(statement)!), target);
  }
});

test("actual RFC bootstrap creates every server-read relation and required relation exactly once", { skip: inSourceSnapshot }, () => {
  const names = buildRisingWaveBootstrapStatements(loadActualBootstrapArtifacts())
    .map(createdRelationName)
    .filter((name): name is string => name !== null);
  for (const relation of [...RISINGWAVE_REQUIRED_RELATIONS, ...RISINGWAVE_SERVER_READ_RELATIONS]) {
    assert.equal(
      names.filter((name) => name === relation).length,
      1,
      `${relation} should be created exactly once`,
    );
  }
  // Mirrors UNIFIED_CHAIN_VIEWS / CONVERSATION_UNREAD_VIEW in packages/server/src/db/risingwave.ts.
  const serverSource = readFileSync(new URL("../../packages/server/src/db/risingwave.ts", import.meta.url), "utf8");
  for (const view of serverSource.matchAll(/^\s+\w+: "(rw_[a-z0-9_]+)",$|^export const CONVERSATION_UNREAD_VIEW = "(rw_[a-z0-9_]+)";$/gm)) {
    const name = view[1] ?? view[2];
    assert.ok((RISINGWAVE_SERVER_READ_RELATIONS as readonly string[]).includes(name), `${name} is read by the server`);
  }
});

test("release-QA uses production CDC columns while retaining the raftdev view graph", { skip: inSourceSnapshot }, () => {
  const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
  const rendered = renderReleaseQaRisingWaveBootstrap(sourceRoot);
  const productionMirrors = [
    "rw_agent_channel_read_cursors", "rw_channel_agents", "rw_channel_humans",
    "rw_channels", "rw_inbox_suppression_states", "rw_inbox_target_mute_states_v2",
    "rw_joint_channel_servers", "rw_joint_channels", "rw_message_mentions_v2",
    "rw_messages", "rw_read_mutation_authorities_v1", "rw_server_members",
    "rw_servers", "rw_tasks", "rw_thread_follows", "rw_user_channel_inbox_states",
    "rw_user_channel_read_cursors", "rw_user_channel_read_cursors_v2",
  ];
  assert.deepEqual([...rendered.contract.publication_tables].sort(),
    [...RISINGWAVE_PUBLICATION_TABLES, "read_mutation_authorities"].sort());
  assert.deepEqual(rendered.contract.cdc_relations, productionMirrors);
  assert.deepEqual(rendered.contract.artifact_cdc_relations, []);
  assert.deepEqual(rendered.contract.required_relations,
    [...new Set([...RISINGWAVE_REQUIRED_RELATIONS, ...productionMirrors])]);
  assert.deepEqual(rendered.contract.server_read_relations, [...RISINGWAVE_SERVER_READ_RELATIONS]);
  assert.match(rendered.cdcSql, /CREATE SOURCE :"rw_source_name"/);
  assert.doesNotMatch(rendered.cdcSql, /\bslockdev_pg_cdc\b|\bslock_neon_cdc\b/);
  for (const name of productionMirrors) {
    assert.equal((rendered.cdcSql.match(new RegExp(`CREATE TABLE ${name}\\b`, "g")) ?? []).length, 1);
    assert.doesNotMatch(rendered.manifestSql, new RegExp(`CREATE TABLE ${name}\\b`));
  }
  assert.doesNotMatch(rendered.cdcSql, /CREATE TABLE rw_message_mentions\s*\(/);
  assert.match(rendered.cdcSql, /auto\.schema\.change = 'false'/);
  assert.doesNotMatch(rendered.cdcSql, /\(\s*\*\s*\)/);
  const catalog = readFileSync(new URL(
    "../../infra/aws-server/envs/release-qa/sql/risingwave-cdc-bootstrap.sql", import.meta.url), "utf8");
  for (const statement of splitSqlStatements(catalog)) {
    const name = createdRelationName(statement);
    if (!name || name === "rw_message_mentions") continue;
    const ddl = statement.slice(statement.indexOf("CREATE TABLE")).trim();
    assert.ok(rendered.cdcSql.includes(ddl), `${name}: preserve every production column, type, PK and order`);
  }
  for (const relation of RISINGWAVE_SERVER_READ_RELATIONS) {
    assert.match(`${rendered.cdcSql}\n${rendered.manifestSql}`, new RegExp(`CREATE (?:TABLE|MATERIALIZED VIEW) ${relation}\\b`));
  }
  assert.doesNotMatch(rendered.manifestSql, /rw_followed_thread_stats_v1|rw_channel_unread_counts_v2/);
  assert.match(rendered.manifestSql, /SET BACKGROUND_DDL = false;/);
  assert.doesNotMatch(rendered.manifestSql, /SET BACKGROUND_DDL = true;/);
});

test("bootstrap composition rejects out-of-order, unknown-source, and missing relations", { skip: inSourceSnapshot }, () => {
  const actual = loadActualBootstrapArtifacts();
  const chain078 = "infra/risingwave/sql/078-task-conversations.sql";
  const chain075 = "infra/risingwave/sql/075-inbox-cursor-decouple.sql";
  // A selected relation that the artifact no longer creates (the mention arm,
  // the conversation parent renamed away).
  assert.throws(
    () => buildRisingWaveBootstrapStatements({
      ...actual,
      [chain078]: actual[chain078].replace("CREATE MATERIALIZED VIEW rw_inbox_mention_v7 ", "CREATE MATERIALIZED VIEW rw_inbox_mention_v7_gone "),
    }),
    /rw_inbox_mention_v7 exactly once/,
  );
  assert.throws(
    () => buildRisingWaveBootstrapStatements({
      ...actual,
      [chain078]: actual[chain078].replace("CREATE MATERIALIZED VIEW rw_conversation_parent_v1 ", "CREATE MATERIALIZED VIEW rw_conversation_parent_v1_gone "),
    }),
    /rw_conversation_parent_v1 exactly once/,
  );
  // 078 without 075: rw_inbox_items_v13 reads rw_inbox_normal_v5, not yet created.
  assert.throws(
    () => buildRisingWaveBootstrapStatements({ ...actual, [chain075]: "" }),
    /rw_inbox_normal_v5 exactly once/,
  );
  // 078's conversation unread reads 066's muted arm; without 066 the arm is missing.
  assert.throws(
    () => buildRisingWaveBootstrapStatements({ ...actual, "infra/risingwave/sql/066-conversation-unread-v1.sql": "" }),
    /rw_inbox_muted_full_v1 exactly once/,
  );
  assert.throws(
    () => buildRisingWaveBootstrapStatements({
      ...actual,
      [chain078]: actual[chain078].replace("FROM rw_message_mentions_v2", "FROM rw_message_mentions_v9"),
    }),
    /reads rw_message_mentions_v9, which is not created before it/,
  );
  const chain061 = "infra/risingwave/sql/061-inbox-derivation-chain.sql";
  assert.throws(
    () => buildRisingWaveBootstrapStatements({
      ...actual,
      [chain061]: actual[chain061].replaceAll("slock_neon_cdc", "other_prod_cdc"),
    }),
    /unknown CDC source other_prod_cdc/,
  );
  assert.throws(
    () => buildRisingWaveBootstrapStatements({ ...actual, [chain078]: `${actual[chain078]}\nDROP MATERIALIZED VIEW rw_x;` }),
    /unsupported executable statement/,
  );
  assert.deepEqual(
    referencedRelations("CREATE MATERIALIZED VIEW rw_a AS SELECT 'rw_fake' FROM rw_b -- rw_comment\nJOIN public.rw_c ON true"),
    ["rw_b", "rw_c"],
  );
});

test("readiness requires a real SQL success and stops immediately on container exit", () => {
  let sqlAttempts = 0;
  let sleeps = 0;
  assert.equal(waitForRisingWaveReadiness({
    attempts: 5,
    containerRunning: () => true,
    sqlReady: () => ++sqlAttempts === 3,
    sleep: () => { sleeps += 1; },
  }), "ready");
  assert.equal(sqlAttempts, 3);
  assert.equal(sleeps, 2);

  sqlAttempts = 0;
  sleeps = 0;
  assert.equal(waitForRisingWaveReadiness({
    attempts: 90,
    containerRunning: () => false,
    sqlReady: () => { sqlAttempts += 1; return true; },
    sleep: () => { sleeps += 1; },
  }), "container-exited");
  assert.equal(sqlAttempts, 0);
  assert.equal(sleeps, 0);
});

test("readiness times out after the exact configured attempt budget", () => {
  let sqlAttempts = 0;
  let sleeps = 0;
  assert.equal(waitForRisingWaveReadiness({
    attempts: 4,
    containerRunning: () => true,
    sqlReady: () => { sqlAttempts += 1; return false; },
    sleep: () => { sleeps += 1; },
  }), "timeout");
  assert.equal(sqlAttempts, 4);
  assert.equal(sleeps, 3);
});

test("ports CLI exposes the deterministic clustertest pgwire/dashboard anchors", () => {
  const script = fileURLToPath(new URL("./raftdev.ts", import.meta.url));
  const child = spawnSync(process.execPath, ["--import", "@oxc-node/core/register", script, "ports", "clustertest"], {
    encoding: "utf8",
    env: { ...process.env },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /Ports for 'clustertest' \(offset: 68\):/);
  assert.match(child.stdout, /RisingWave : localhost:17734 \(dashboard: http:\/\/localhost:17934; reserved; not running \(started with --no-risingwave, or not started\)\)/);
  assert.match(child.stdout, /RW pgwire  : postgresql:\/\/root@127\.0\.0\.1:17734\/dev \(reserved\)/);
});

test("local/external conflict fails before tooling and never prints the external DSN", () => {
  const script = fileURLToPath(new URL("./raftdev.ts", import.meta.url));
  const secretDsn = "postgresql://secret-user:secret-password@example.invalid:4566/dev";
  const child = spawnSync(process.execPath, ["--import", "@oxc-node/core/register", script, "start", "conflict", "--risingwave"], {
    encoding: "utf8",
    env: {
      ...process.env,
      RISINGWAVE_DATABASE_URL: secretDsn,
      PATH: "",
    },
  });
  assert.equal(child.status, 1);
  assert.match(child.stdout, /cannot be combined/);
  assert.doesNotMatch(child.stdout + child.stderr, /secret-user|secret-password|example\.invalid/);
  assert.doesNotMatch(child.stdout, /requires POSIX dev tools/);
});
