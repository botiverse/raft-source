/**
 * Pure, Docker-free contract for raftdev's managed RisingWave bootstrap.
 *
 * Runtime orchestration lives in packages/server/scripts/bootstrap-risingwave-local.ts,
 * where the server package's pg dependency is available. Keeping the manifest and
 * SQL selection here lets the fast raftdev suite prove the production-artifact
 * dependency order without starting Postgres or RisingWave.
 */

export const RISINGWAVE_LOCAL_SOURCE = "slockdev_pg_cdc";
export const RISINGWAVE_LOCAL_PUBLICATION = "slockdev_rw_publication";
export const RISINGWAVE_LOCAL_SLOT = "slockdev_rw_slot";

export const RISINGWAVE_PUBLICATION_TABLES = [
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
] as const;

export interface RisingWaveCdcTable {
  upstream: (typeof RISINGWAVE_PUBLICATION_TABLES)[number];
  name: string;
  columns: readonly string[];
  primaryKey: readonly string[];
}

/**
 * Deliberately narrow CDC projections. In particular, messages.search_vector
 * is a generated tsvector and is outside RisingWave's documented PostgreSQL
 * CDC mapping. UUIDs are represented as varchar, matching that mapping.
 */
export const RISINGWAVE_CDC_TABLES: readonly RisingWaveCdcTable[] = [
  {
    upstream: "channels",
    name: "rw_channels",
    columns: [
      "id varchar",
      "server_id varchar",
      "name varchar",
      "type varchar",
      "parent_message_id varchar",
      "created_at timestamptz",
      "archived_at timestamptz",
      "deleted_at timestamptz",
    ],
    primaryKey: ["id"],
  },
  {
    upstream: "messages",
    name: "rw_messages",
    columns: [
      "id varchar",
      "seq bigint",
      "channel_id varchar",
      "sender_type varchar",
      "sender_id varchar",
      "content varchar",
      "created_at timestamptz",
    ],
    primaryKey: ["id"],
  },
  {
    upstream: "channel_humans",
    name: "rw_channel_humans",
    columns: ["channel_id varchar", "user_id varchar"],
    primaryKey: ["channel_id", "user_id"],
  },
  {
    upstream: "user_channel_read_cursors",
    name: "rw_user_channel_read_cursors",
    columns: ["user_id varchar", "channel_id varchar", "last_read_seq int"],
    primaryKey: ["user_id", "channel_id"],
  },
  {
    upstream: "user_channel_read_cursors",
    name: "rw_user_channel_read_cursors_v2",
    columns: [
      "user_id varchar",
      "channel_id varchar",
      "last_read_seq int",
      "read_state_version int",
      "last_applied_authority_seq bigint",
    ],
    primaryKey: ["user_id", "channel_id"],
  },
  {
    upstream: "read_mutation_authorities",
    name: "rw_read_mutation_authorities_v1",
    columns: [
      "server_id varchar",
      "principal_id varchar",
      "last_terminal_authority_seq bigint",
    ],
    primaryKey: ["server_id", "principal_id"],
  },
  {
    upstream: "user_channel_inbox_states",
    name: "rw_user_channel_inbox_states",
    columns: ["user_id varchar", "channel_id varchar", "done_at timestamptz"],
    primaryKey: ["user_id", "channel_id"],
  },
  {
    upstream: "thread_follows",
    name: "rw_thread_follows",
    columns: [
      "thread_channel_id varchar",
      "follower_type varchar",
      "follower_id varchar",
      "done_at timestamptz",
      "unfollowed_at timestamptz",
    ],
    primaryKey: ["thread_channel_id", "follower_type", "follower_id"],
  },
  {
    upstream: "tasks",
    name: "rw_tasks",
    columns: [
      "id varchar",
      "message_id varchar",
      "task_number int",
      "status varchar",
      "claimed_by_type varchar",
      "claimed_by_id varchar",
    ],
    primaryKey: ["id"],
  },
  {
    upstream: "message_mentions",
    name: "rw_message_mentions",
    columns: [
      "id varchar",
      "message_seq bigint",
      "channel_id varchar",
      "target_type varchar",
      "target_id varchar",
      "notifiable_at_send boolean",
      "notified_at timestamptz",
    ],
    primaryKey: ["id"],
  },
  {
    upstream: "message_mentions",
    name: "rw_message_mentions_v2",
    columns: [
      "id varchar",
      "message_seq bigint",
      "channel_id varchar",
      "target_type varchar",
      "target_id varchar",
      "notifiable_at_send boolean",
      "notified_at timestamptz",
    ],
    primaryKey: ["id"],
  },
  {
    upstream: "server_members",
    name: "rw_server_members",
    columns: ["server_id varchar", "user_id varchar"],
    primaryKey: ["server_id", "user_id"],
  },
  {
    upstream: "joint_channels",
    name: "rw_joint_channels",
    columns: ["id varchar", "canonical_channel_id varchar", "status varchar"],
    primaryKey: ["id"],
  },
  {
    upstream: "joint_channel_servers",
    name: "rw_joint_channel_servers",
    columns: [
      "joint_channel_id varchar",
      "server_id varchar",
      "local_channel_id varchar",
      "status varchar",
    ],
    primaryKey: ["joint_channel_id", "server_id"],
  },
  {
    upstream: "inbox_suppression_states",
    name: "rw_inbox_suppression_states",
    columns: [
      "receiver_type varchar",
      "receiver_id varchar",
      "server_id varchar",
      "target_kind varchar",
      "target_channel_id varchar",
      "source_channel_id varchar",
      "done_through_seq bigint",
      "done_at timestamptz",
      "write_site varchar",
      "updated_at timestamptz",
    ],
    primaryKey: ["receiver_type", "receiver_id", "target_kind", "target_channel_id"],
  },
  {
    upstream: "inbox_notification_facts",
    name: "rw_inbox_notification_facts_v1",
    columns: [
      "id varchar",
      "receiver_type varchar",
      "receiver_id varchar",
      "server_id varchar",
      "kind varchar",
      "source_channel_id varchar",
      "message_id varchar",
      "message_seq bigint",
      "activity_at timestamptz",
      "personal_mention boolean",
      "unread_eligible boolean",
      "created_at timestamptz",
    ],
    primaryKey: ["id"],
  },
] as const;

export const RISINGWAVE_V3_VISIBILITY_ORDER = [
  "rw_inbox_visibility_channel_targets_v3",
  "rw_inbox_visibility_followed_thread_parent_resolution_v3",
  "rw_inbox_visibility_followed_thread_parent_visibility_v3",
  "rw_inbox_visibility_followed_thread_targets_v3",
  "rw_inbox_visibility_public_channel_mention_targets_v3",
  "rw_inbox_visibility_public_thread_mention_parent_resolution_v3",
  "rw_inbox_visibility_public_thread_mention_parent_visibility_v3",
  "rw_inbox_visibility_public_thread_mention_targets_v3",
  "rw_inbox_visibility_facts_v3",
] as const;

export const RISINGWAVE_REQUIRED_RELATIONS = [
  ...RISINGWAVE_CDC_TABLES.map((table) => table.name),
  "rw_inbox_target_mute_states_v2",
  "rw_followed_thread_stats_v1",
  "rw_sidebar_unread_summary_v1",
  "rw_channel_unread_counts_v2",
  "rw_inbox_visibility_facts_v3",
  "rw_inbox_suppression_facts_v3_2",
  "rw_inbox_mute_facts_v3_2",
  "rw_inbox_mute_allowed_activity_v3_2",
  "rw_inbox_cloak_decisions_v3_2",
  "rw_inbox_items_v2_suppressed_v3_2",
  "rw_inbox_notification_facts_v1",
  "rw_inbox_items_v2_suppressed_v3_3",
  "rw_inbox_fact_visibility_targets_v1",
  "rw_inbox_items_v2_suppressed_v3_4",
  "rw_inbox_items_v3_2",
  "rw_inbox_read_authorities_v1",
] as const;

export function createCdcTableStatement(table: RisingWaveCdcTable): string {
  const columns = [...table.columns, `PRIMARY KEY (${table.primaryKey.join(", ")})`]
    .map((column) => `  ${column}`)
    .join(",\n");
  return [
    `CREATE TABLE ${table.name} (`,
    columns,
    `) FROM ${RISINGWAVE_LOCAL_SOURCE} TABLE 'public.${table.upstream}'`,
  ].join("\n");
}

/** Split SQL while preserving quoted semicolons and comment text. */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let single = false;
  let double = false;
  let lineComment = false;
  let blockComment = 0;
  let dollarTag: string | null = null;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (lineComment) {
      if (ch === "\n") lineComment = false;
      continue;
    }
    if (blockComment > 0) {
      if (ch === "/" && next === "*") { blockComment++; i++; continue; }
      if (ch === "*" && next === "/") { blockComment--; i++; }
      continue;
    }
    if (dollarTag !== null) {
      if (sql.startsWith(dollarTag, i)) {
        i += dollarTag.length - 1;
        dollarTag = null;
      }
      continue;
    }
    if (single) {
      if (ch === "'" && next === "'") { i++; continue; }
      if (ch === "'") single = false;
      continue;
    }
    if (double) {
      if (ch === '"' && next === '"') { i++; continue; }
      if (ch === '"') double = false;
      continue;
    }
    if (ch === "-" && next === "-") { lineComment = true; i++; continue; }
    if (ch === "/" && next === "*") { blockComment = 1; i++; continue; }
    if (ch === "'") { single = true; continue; }
    if (ch === '"') { double = true; continue; }
    if (ch === "$") {
      const match = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) {
        dollarTag = match[0];
        i += dollarTag.length - 1;
        continue;
      }
    }
    if (ch === ";") {
      const statement = sql.slice(start, i).trim();
      if (statement !== "") statements.push(statement);
      start = i + 1;
    }
  }
  if (single || double || blockComment > 0 || dollarTag !== null) {
    throw new Error("unterminated quote or comment in RisingWave SQL artifact");
  }
  const tail = sql.slice(start).trim();
  if (tail !== "") statements.push(tail);
  return statements;
}

function leadingSqlBodyStart(statement: string): number {
  let index = 0;
  while (index < statement.length) {
    while (/\s/.test(statement[index] ?? "")) index++;
    if (statement.startsWith("--", index)) {
      const newline = statement.indexOf("\n", index + 2);
      if (newline === -1) return statement.length;
      index = newline + 1;
      continue;
    }
    if (statement.startsWith("/*", index)) {
      let depth = 1;
      index += 2;
      while (index < statement.length && depth > 0) {
        if (statement.startsWith("/*", index)) {
          depth++;
          index += 2;
        } else if (statement.startsWith("*/", index)) {
          depth--;
          index += 2;
        } else {
          index++;
        }
      }
      if (depth !== 0) throw new Error("unterminated block comment in RisingWave SQL artifact");
      continue;
    }
    break;
  }
  return index;
}

function sqlStatementBody(statement: string): string {
  return statement.slice(leadingSqlBodyStart(statement)).trimStart();
}

export function createdRelationName(statement: string): string | null {
  const match = sqlStatementBody(statement).match(
    /^CREATE\s+(?:MATERIALIZED\s+VIEW|TABLE|(?:UNIQUE\s+)?INDEX)\s+([a-zA-Z_][a-zA-Z0-9_]*)\b/i,
  );
  return match?.[1] ?? null;
}

function forceLocalDdlSettings(statement: string): string {
  const bodyStart = leadingSqlBodyStart(statement);
  const prefix = statement.slice(0, bodyStart);
  const body = statement.slice(bodyStart);
  if (/^SET\s+BACKGROUND_DDL\s*=/i.test(body)) {
    return prefix + body.replace(
      /^SET\s+BACKGROUND_DDL\s*=\s*\S+/i,
      "SET BACKGROUND_DDL = false",
    );
  }
  if (/^SET\s+STREAMING_PARALLELISM\s*=/i.test(body)) {
    return prefix + body.replace(
      /^SET\s+STREAMING_PARALLELISM\s*=\s*\S+/i,
      "SET STREAMING_PARALLELISM = 1",
    );
  }
  return statement;
}

function assertArtifactStatementShape(
  label: string,
  statements: readonly string[],
  settings: "required" | "forbidden",
): void {
  let backgroundSettings = 0;
  let parallelismSettings = 0;
  for (const statement of statements) {
    const body = sqlStatementBody(statement);
    if (body === "") continue;
    if (/^SET\s+BACKGROUND_DDL\s*=/i.test(body)) {
      backgroundSettings++;
      continue;
    }
    if (/^SET\s+STREAMING_PARALLELISM\s*=/i.test(body)) {
      parallelismSettings++;
      continue;
    }
    if (createdRelationName(statement) !== null) continue;
    throw new Error(
      `${label} artifact contains an unsupported executable statement: ${body.replace(/\s+/g, " ").slice(0, 96)}`,
    );
  }
  const expected = settings === "required" ? 1 : 0;
  if (backgroundSettings !== expected || parallelismSettings !== expected) {
    throw new Error(
      `${label} artifact must contain ${expected} BACKGROUND_DDL and ${expected} STREAMING_PARALLELISM setting(s); ` +
      `found ${backgroundSettings} and ${parallelismSettings}`,
    );
  }
}

function assertUniqueCreatedRelations(label: string, statements: readonly string[]): void {
  const seen = new Set<string>();
  for (const statement of statements) {
    const name = createdRelationName(statement);
    if (!name) continue;
    // These artifact names are deliberately unquoted, so RisingWave folds them
    // case-insensitively even though JavaScript's Set does not.
    const normalized = name.toLowerCase();
    if (seen.has(normalized)) throw new Error(`${label} creates ${name} more than once`);
    seen.add(normalized);
  }
}

export interface RisingWaveBootstrapArtifacts {
  base: string;
  productionV3: string;
  muteV32: string;
  bornReadV33: string;
  factVisibilityV34: string;
  readFrontierV1: string;
}

/**
 * Select and order the canonical repo artifacts. Required-relation, setting,
 * and uniqueness guards make a future artifact rewrite fail loudly instead of
 * silently applying a partial, unsafe, or duplicate graph.
 */
export function buildRisingWaveBootstrapStatements(
  artifacts: RisingWaveBootstrapArtifacts,
): string[] {
  const baseRaw = splitSqlStatements(artifacts.base);
  assertArtifactStatementShape("RFC024", baseRaw, "required");
  assertUniqueCreatedRelations("RFC024 artifact", baseRaw);
  const base = baseRaw.map(forceLocalDdlSettings);
  const baseNames = base.map(createdRelationName).filter((name): name is string => name !== null);
  for (const required of [
    "rw_followed_thread_stats_v1",
    "rw_sidebar_unread_summary_v1",
    "rw_channel_unread_counts_v2",
    "rw_inbox_items_v2",
  ]) {
    if (baseNames.filter((name) => name === required).length !== 1) {
      throw new Error(`RFC024 artifact must create ${required} exactly once`);
    }
  }

  const productionV3 = splitSqlStatements(artifacts.productionV3);
  assertArtifactStatementShape("v3 SHOW CREATE", productionV3, "forbidden");
  assertUniqueCreatedRelations("v3 SHOW CREATE artifact", productionV3);
  const v3ByName = new Map<string, string>();
  for (const statement of productionV3) {
    const name = createdRelationName(statement);
    if (name) {
      v3ByName.set(name, statement);
    }
  }
  const v3 = RISINGWAVE_V3_VISIBILITY_ORDER.map((name) => {
    const statement = v3ByName.get(name);
    if (!statement) throw new Error(`v3 artifact is missing ${name}`);
    return statement;
  });
  for (const duplicate of ["rw_inbox_items_v2", "rw_inbox_items_v3", "rw_inbox_cloak_decisions_v3"]) {
    if (v3.some((statement) => createdRelationName(statement) === duplicate)) {
      throw new Error(`v3 selection must exclude duplicate terminal ${duplicate}`);
    }
  }

  const sourceMatches = artifacts.muteV32.match(/\bslock_neon_cdc\b/g)?.length ?? 0;
  if (sourceMatches !== 1) {
    throw new Error(`RFC039 v3.2 artifact must reference slock_neon_cdc exactly once; found ${sourceMatches}`);
  }
  const muteV32Raw = splitSqlStatements(
    artifacts.muteV32.replace(/\bslock_neon_cdc\b/, RISINGWAVE_LOCAL_SOURCE),
  );
  assertArtifactStatementShape("RFC039 v3.2", muteV32Raw, "required");
  assertUniqueCreatedRelations("RFC039 v3.2 artifact", muteV32Raw);
  const muteV32 = muteV32Raw.map(forceLocalDdlSettings);
  const muteNames = muteV32.map(createdRelationName).filter((name): name is string => name !== null);
  for (const required of [
    "rw_inbox_target_mute_states_v2",
    "rw_inbox_suppression_facts_v3_2",
    "rw_inbox_mute_facts_v3_2",
    "rw_inbox_mute_allowed_activity_v3_2",
    "rw_inbox_cloak_decisions_v3_2",
    "rw_inbox_items_v2_suppressed_v3_2",
    "rw_inbox_items_v3_2",
  ]) {
    if (muteNames.filter((name) => name === required).length !== 1) {
      throw new Error(`RFC039 v3.2 artifact must create ${required} exactly once`);
    }
  }

  const bornReadSourceMatches = artifacts.bornReadV33.match(/\bslock_neon_cdc\b/g)?.length ?? 0;
  if (bornReadSourceMatches !== 1) {
    throw new Error(`RFC039 v3.3 artifact must reference slock_neon_cdc exactly once; found ${bornReadSourceMatches}`);
  }
  const bornReadV33Raw = splitSqlStatements(
    artifacts.bornReadV33.replace(/\bslock_neon_cdc\b/, RISINGWAVE_LOCAL_SOURCE),
  );
  assertArtifactStatementShape("RFC039 v3.3 born-read", bornReadV33Raw, "required");
  assertUniqueCreatedRelations("RFC039 v3.3 born-read artifact", bornReadV33Raw);
  const bornReadTableCreates = bornReadV33Raw.filter(
    (statement) => createdRelationName(statement) === "rw_inbox_notification_facts_v1",
  );
  if (bornReadTableCreates.length !== 1) {
    throw new Error("RFC039 v3.3 born-read artifact must create rw_inbox_notification_facts_v1 exactly once");
  }
  const bornReadV33 = bornReadV33Raw
    .filter((statement) => createdRelationName(statement) !== "rw_inbox_notification_facts_v1")
    .map(forceLocalDdlSettings);
  if (
    bornReadV33.filter(
      (statement) => createdRelationName(statement) === "rw_inbox_items_v2_suppressed_v3_3",
    ).length !== 1
  ) {
    throw new Error("RFC039 v3.3 born-read artifact must create rw_inbox_items_v2_suppressed_v3_3 exactly once");
  }

  const factVisibilityV34Raw = splitSqlStatements(artifacts.factVisibilityV34);
  assertArtifactStatementShape("RFC056 fact visibility v3.4", factVisibilityV34Raw, "required");
  assertUniqueCreatedRelations("RFC056 fact visibility v3.4 artifact", factVisibilityV34Raw);
  const factVisibilityV34 = factVisibilityV34Raw.map(forceLocalDdlSettings);
  const factVisibilityNames = factVisibilityV34
    .map(createdRelationName)
    .filter((name): name is string => name !== null);
  for (const required of [
    "rw_inbox_fact_visibility_targets_v1",
    "idx_rw_inbox_fact_visibility_targets_v1_lookup",
    "rw_inbox_items_v2_suppressed_v3_4",
    "idx_rw_inbox_items_v2_suppressed_v3_4_user_activity",
    "idx_rw_inbox_items_v2_suppressed_v3_4_user_filter",
  ]) {
    if (factVisibilityNames.filter((name) => name === required).length !== 1) {
      throw new Error(`RFC056 fact visibility v3.4 artifact must create ${required} exactly once`);
    }
  }

  const readFrontierSourceMatches = artifacts.readFrontierV1.match(/\bslock_neon_cdc\b/g)?.length ?? 0;
  if (readFrontierSourceMatches !== 2) {
    throw new Error(`RFC056 read-frontier artifact must reference slock_neon_cdc exactly twice; found ${readFrontierSourceMatches}`);
  }
  const readFrontierRaw = splitSqlStatements(
    artifacts.readFrontierV1.replaceAll(/\bslock_neon_cdc\b/g, RISINGWAVE_LOCAL_SOURCE),
  );
  assertArtifactStatementShape("RFC056 read frontier", readFrontierRaw, "required");
  assertUniqueCreatedRelations("RFC056 read frontier", readFrontierRaw);
  const readFrontier = readFrontierRaw
    .filter((statement) => createdRelationName(statement) === "rw_inbox_read_authorities_v1")
    .map(forceLocalDdlSettings);
  if (readFrontier.length !== 1) {
    throw new Error("RFC056 read-frontier artifact must create rw_inbox_read_authorities_v1 exactly once");
  }

  const statements = [
    "SET BACKGROUND_DDL = false",
    "SET STREAMING_PARALLELISM = 1",
    ...RISINGWAVE_CDC_TABLES.map(createCdcTableStatement),
    ...base,
    ...v3,
    ...muteV32,
    ...bornReadV33,
    ...factVisibilityV34,
    ...readFrontier,
  ];
  assertUniqueCreatedRelations("composed local RisingWave bootstrap", statements);
  return statements;
}
