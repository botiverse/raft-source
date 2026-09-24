/** Focused tests for raftdev's optional RisingWave standalone dependency. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_RISINGWAVE_IMAGE,
  hasRisingWaveSeedPostgresOwnershipProof,
  parseRisingWaveLocalProfile,
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
} from "./raftdev.ts";
import {
  buildRisingWaveBootstrapStatements,
  createCdcTableStatement,
  createdRelationName,
  RISINGWAVE_CDC_TABLES,
  RISINGWAVE_LOCAL_SOURCE,
  RISINGWAVE_PUBLICATION_TABLES,
  RISINGWAVE_REQUIRED_RELATIONS,
  RISINGWAVE_V3_VISIBILITY_ORDER,
  splitSqlStatements,
} from "./raftdev-risingwave-bootstrap.ts";

// Asserts on private CI/deploy files that the source-available snapshot does not
// carry; skipped when an exported snapshot's RELEASE_SOURCE marker is present.
const inSourceSnapshot = existsSync(new URL("../../RELEASE_SOURCE", import.meta.url));

function loadActualBootstrapArtifacts() {
  return {
    base: readFileSync(
      new URL("../../infra/risingwave/sql/024-risingwave-unread-inbox-full-materialized.sql", import.meta.url),
      "utf8",
    ),
    productionV3: readFileSync(
      new URL("../../infra/risingwave/sql/024-risingwave-inbox-v3-production-definition-2026-07-07.sql", import.meta.url),
      "utf8",
    ),
    muteV32: readFileSync(
      new URL("../../infra/risingwave/sql/039-risingwave-inbox-v03-production-mute-v3_2-ddl.sql", import.meta.url),
      "utf8",
    ),
    bornReadV33: readFileSync(
      new URL("../../infra/risingwave/sql/039-risingwave-inbox-born-read-v3_3-ddl.sql", import.meta.url),
      "utf8",
    ),
    factVisibilityV34: readFileSync(
      new URL("../../infra/risingwave/sql/056-risingwave-inbox-fact-visibility-v3_4-ddl.sql", import.meta.url),
      "utf8",
    ),
    readFrontierV1: readFileSync(
      new URL("../../infra/risingwave/sql/056-risingwave-inbox-read-frontier-v1-ddl.sql", import.meta.url),
      "utf8",
    ),
  };
}

test("RisingWave is default-off and parses full/process-only profiles explicitly", () => {
  assert.equal(parseRisingWaveLocalProfile(undefined), null);
  assert.equal(parseRisingWaveLocalProfile(""), null);
  assert.equal(parseRisingWaveLocalProfile(" 0 "), null);
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

test("dependency resolution keeps default mode disabled", () => {
  assert.deepEqual(
    resolveRisingWaveDependency(undefined, undefined, "postgresql://root@127.0.0.1:17666/dev", undefined),
    { mode: "disabled" },
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
  assert.deepEqual(
    resolveRisingWaveDependency(undefined, "   ", "unused", undefined),
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
      "risingwave:test",
      "single_node",
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
      DEFAULT_RISINGWAVE_IMAGE,
      "single_node",
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

test("CDC manifest covers the exact 15-table publication and deliberate versioned aliases", () => {
  assert.deepEqual([...RISINGWAVE_PUBLICATION_TABLES], [
    "channels",
    "messages",
    "channel_humans",
    "user_channel_read_cursors",
    "read_mutation_authorities",
    "user_channel_inbox_states",
    "thread_follows",
    "tasks",
    "message_mentions",
    "server_members",
    "joint_channels",
    "joint_channel_servers",
    "inbox_suppression_states",
    "inbox_target_mute_states",
    "inbox_notification_facts",
  ]);
  assert.equal(new Set(RISINGWAVE_PUBLICATION_TABLES).size, 15);
  assert.deepEqual(RISINGWAVE_CDC_TABLES.map((table) => table.name), [
    "rw_channels",
    "rw_messages",
    "rw_channel_humans",
    "rw_user_channel_read_cursors",
    "rw_user_channel_read_cursors_v2",
    "rw_read_mutation_authorities_v1",
    "rw_user_channel_inbox_states",
    "rw_thread_follows",
    "rw_tasks",
    "rw_message_mentions",
    "rw_message_mentions_v2",
    "rw_server_members",
    "rw_joint_channels",
    "rw_joint_channel_servers",
    "rw_inbox_suppression_states",
    "rw_inbox_notification_facts_v1",
  ]);
  assert.deepEqual(
    RISINGWAVE_CDC_TABLES
      .filter((table) => table.upstream === "message_mentions")
      .map((table) => table.name),
    ["rw_message_mentions", "rw_message_mentions_v2"],
  );
  assert.deepEqual(
    RISINGWAVE_CDC_TABLES
      .filter((table) => table.upstream === "user_channel_read_cursors")
      .map((table) => table.name),
    ["rw_user_channel_read_cursors", "rw_user_channel_read_cursors_v2"],
  );
  assert.deepEqual(
    RISINGWAVE_CDC_TABLES
      .filter((table) => table.upstream === "read_mutation_authorities")
      .map((table) => table.name),
    ["rw_read_mutation_authorities_v1"],
  );
  assert.equal(
    RISINGWAVE_CDC_TABLES.some((table) => table.upstream === "inbox_target_mute_states"),
    false,
    "RFC039 owns the sole versioned mute CDC table",
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
    "  PRIMARY KEY (id)",
    ") FROM slockdev_pg_cdc TABLE 'public.messages'",
  ].join("\n"));
  assert.doesNotMatch(messages ?? "", /search_vector|tsvector|action_metadata/);

  const mentions = RISINGWAVE_CDC_TABLES.find((table) => table.name === "rw_message_mentions_v2");
  assert.deepEqual(mentions?.primaryKey, ["id"]);
  assert.deepEqual(mentions?.columns, [
    "id varchar",
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

  const readAuthorities = RISINGWAVE_CDC_TABLES.find(
    (table) => table.name === "rw_read_mutation_authorities_v1",
  );
  assert.deepEqual(readAuthorities?.columns, [
    "server_id varchar",
    "principal_id varchar",
    "last_terminal_authority_seq bigint",
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

test("actual RFC bootstrap uses foreground settings and rewrites the production source", { skip: inSourceSnapshot && "source-available snapshot has no private CI/deploy files" }, () => {
  const statements = buildRisingWaveBootstrapStatements(loadActualBootstrapArtifacts());
  assert.equal(statements[0], "SET BACKGROUND_DDL = false");
  assert.equal(statements[1], "SET STREAMING_PARALLELISM = 1");

  const sql = statements.join(";\n");
  assert.equal(sql.match(/SET\s+BACKGROUND_DDL\s*=\s*false/gi)?.length, 5);
  assert.equal(sql.match(/SET\s+STREAMING_PARALLELISM\s*=\s*1/gi)?.length, 5);
  assert.doesNotMatch(sql, /SET\s+BACKGROUND_DDL\s*=\s*true/i);
  assert.doesNotMatch(sql, /SET\s+STREAMING_PARALLELISM\s*=\s*(?:4|8)\b/i);
  assert.doesNotMatch(sql, /\bslock_neon_cdc\b/);
  assert.match(
    sql,
    /CREATE TABLE rw_user_channel_read_cursors_v2[\s\S]*FROM slockdev_pg_cdc TABLE 'public\.user_channel_read_cursors'/,
  );
  assert.match(
    sql,
    /CREATE TABLE rw_read_mutation_authorities_v1[\s\S]*FROM slockdev_pg_cdc TABLE 'public\.read_mutation_authorities'/,
  );
  assert.match(
    sql,
    /CREATE MATERIALIZED VIEW rw_inbox_read_authorities_v1[\s\S]*FROM rw_read_mutation_authorities_v1/,
  );

  const muteCdc = statements.find(
    (statement) => createdRelationName(statement) === "rw_inbox_target_mute_states_v2",
  );
  assert.match(
    muteCdc ?? "",
    /FROM slockdev_pg_cdc TABLE 'public\.inbox_target_mute_states'/,
  );
  const notificationFactsCdc = statements.find(
    (statement) => createdRelationName(statement) === "rw_inbox_notification_facts_v1",
  );
  assert.match(
    notificationFactsCdc ?? "",
    /FROM slockdev_pg_cdc TABLE 'public\.inbox_notification_facts'/,
  );
});

test("actual RFC bootstrap preserves dependency order and excludes captured duplicate terminals", { skip: inSourceSnapshot && "source-available snapshot has no private CI/deploy files" }, () => {
  const statements = buildRisingWaveBootstrapStatements(loadActualBootstrapArtifacts());
  const names = statements
    .map(createdRelationName)
    .filter((name): name is string => name !== null);
  const cdcNames = RISINGWAVE_CDC_TABLES.map((table) => table.name);
  assert.deepEqual(names.slice(0, cdcNames.length), cdcNames);

  const firstV3 = names.indexOf(RISINGWAVE_V3_VISIBILITY_ORDER[0]);
  assert.ok(firstV3 > names.indexOf("rw_inbox_items_v2"));
  assert.deepEqual(
    names.slice(firstV3, firstV3 + RISINGWAVE_V3_VISIBILITY_ORDER.length),
    [...RISINGWAVE_V3_VISIBILITY_ORDER],
  );
  assert.ok(
    names.indexOf("rw_inbox_visibility_facts_v3") <
      names.indexOf("rw_inbox_target_mute_states_v2"),
  );
  assert.ok(
    names.indexOf("rw_inbox_target_mute_states_v2") <
      names.indexOf("rw_inbox_suppression_facts_v3_2"),
  );
  assert.ok(
    names.indexOf("rw_inbox_cloak_decisions_v3_2") <
      names.indexOf("rw_inbox_items_v2_suppressed_v3_2"),
  );
  assert.ok(
    names.indexOf("rw_inbox_items_v2_suppressed_v3_2") <
      names.indexOf("rw_inbox_items_v2_suppressed_v3_3"),
  );
  assert.ok(
    names.indexOf("rw_inbox_items_v3_2") <
      names.indexOf("rw_inbox_items_v2_suppressed_v3_3"),
  );
  assert.ok(
    names.indexOf("rw_inbox_items_v2_suppressed_v3_3") <
      names.indexOf("rw_inbox_fact_visibility_targets_v1"),
  );
  assert.ok(
    names.indexOf("rw_inbox_fact_visibility_targets_v1") <
      names.indexOf("rw_inbox_items_v2_suppressed_v3_4"),
  );

  assert.equal(names.filter((name) => name === "rw_inbox_items_v2").length, 1);
  assert.equal(names.includes("rw_inbox_items_v3"), false);
  assert.equal(names.includes("rw_inbox_cloak_decisions_v3"), false);
});

test("actual RFC bootstrap creates every serving-readiness relation exactly once", { skip: inSourceSnapshot && "source-available snapshot has no private CI/deploy files" }, () => {
  const names = buildRisingWaveBootstrapStatements(loadActualBootstrapArtifacts())
    .map(createdRelationName)
    .filter((name): name is string => name !== null);
  for (const relation of RISINGWAVE_REQUIRED_RELATIONS) {
    assert.equal(
      names.filter((name) => name === relation).length,
      1,
      `${relation} should be created exactly once`,
    );
  }
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
  const child = spawnSync(process.execPath, ["--import", "tsx", script, "ports", "clustertest"], {
    encoding: "utf8",
    env: { ...process.env },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /Ports for 'clustertest' \(offset: 68\):/);
  assert.match(child.stdout, /RisingWave : localhost:17734 \(dashboard: http:\/\/localhost:17934; reserved; opt in with --risingwave\)/);
  assert.match(child.stdout, /RW pgwire  : postgresql:\/\/root@127\.0\.0\.1:17734\/dev \(reserved\)/);
});

test("local/external conflict fails before tooling and never prints the external DSN", () => {
  const script = fileURLToPath(new URL("./raftdev.ts", import.meta.url));
  const secretDsn = "postgresql://secret-user:secret-password@example.invalid:4566/dev";
  const child = spawnSync(process.execPath, ["--import", "tsx", script, "start", "conflict", "--risingwave"], {
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
