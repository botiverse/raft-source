/**
 * Pure, Docker-free contract for the managed RisingWave bootstrap used by
 * raftdev (`./raftdev start`, on by default) and the `risingwave-real` CI job.
 *
 * Runtime orchestration lives in packages/server/scripts/bootstrap-risingwave-local.ts,
 * where the server package's pg dependency is available. Keeping the manifest and
 * SQL selection here lets the fast raftdev suite prove the production-artifact
 * dependency order without starting Postgres or RisingWave.
 *
 * The bootstrap builds exactly the relations the server reads today (see
 * RISINGWAVE_SERVER_READ_RELATIONS, which mirrors UNIFIED_CHAIN_VIEWS /
 * CONVERSATION_UNREAD_VIEW in packages/server/src/db/risingwave.ts plus the
 * direct rw_* reads in packages/server/src/services) and their transitive
 * dependencies, taken statement-by-statement from the production artifacts in
 * infra/risingwave/sql. Superseded generations in those files are skipped.
 */

export const RISINGWAVE_LOCAL_SOURCE = "slockdev_pg_cdc";
export const RISINGWAVE_LOCAL_PUBLICATION = "slockdev_rw_publication";
export const RISINGWAVE_LOCAL_SLOT = "slockdev_rw_slot";
/** The production CDC source name the artifacts are written against. */
export const RISINGWAVE_PRODUCTION_SOURCE = "slock_neon_cdc";

export const RISINGWAVE_PUBLICATION_TABLES = [
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
] as const;

export interface RisingWaveCdcTable {
  upstream: (typeof RISINGWAVE_PUBLICATION_TABLES)[number];
  name: string;
  columns: readonly string[];
  primaryKey: readonly string[];
}

/**
 * Deliberately narrow CDC projections: exactly the columns the selected views
 * and server reads use. messages.search_vector is a generated tsvector and is
 * outside RisingWave's documented PostgreSQL CDC mapping. UUIDs are represented
 * as varchar, matching that mapping.
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
      // Task conversations (078): the local parent channel and the task.
      "parent_channel_id varchar",
      "task_id varchar",
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
      // RFC-063 send-verdict columns (rw_message_target_v3 and the unread arms).
      "message_type varchar",
      "causal_actor_type varchar",
      "causal_actor_id varchar",
      "system_subtype varchar",
      // Task badge columns (rw_message_preview_v1).
      "task_status varchar",
      "task_number int",
      "task_assignee_type varchar",
      "task_assignee_id varchar",
    ],
    primaryKey: ["id"],
  },
  {
    upstream: "channel_humans",
    name: "rw_channel_humans",
    columns: ["channel_id varchar", "user_id varchar", "joined_at timestamptz"],
    primaryKey: ["channel_id", "user_id"],
  },
  {
    upstream: "channel_agents",
    name: "rw_channel_agents",
    columns: ["channel_id varchar", "agent_id varchar", "added_at timestamptz"],
    primaryKey: ["channel_id", "agent_id"],
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
    upstream: "agent_channel_read_cursors",
    name: "rw_agent_channel_read_cursors",
    columns: [
      "agent_id varchar",
      "channel_id varchar",
      "last_read_seq int",
      "last_read_seq8 bigint",
      "read_state_version int",
    ],
    primaryKey: ["agent_id", "channel_id"],
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
      "created_at timestamptz",
      "done_at timestamptz",
      "unfollowed_at timestamptz",
    ],
    primaryKey: ["thread_channel_id", "follower_type", "follower_id"],
  },
  {
    upstream: "message_mentions",
    name: "rw_message_mentions_v2",
    columns: [
      "id varchar",
      // The first-mention anchor (078 rw_inbox_mention_v7, serve-time outsider lookup).
      "message_id varchar",
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
    // The parent message's task in rw_followed_threads_v5 (074); in
    // rw_inbox_serving_v9 (078) also a task conversation's task (by
    // channels.task_id). Production carries the full table as `rw_tasks (*)`;
    // this is the slice 074 and 078 read.
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
] as const;

/**
 * CDC tables whose DDL is owned by an artifact (061) rather than by the explicit
 * projections above. The orchestrator waits for their count parity too.
 */
export const RISINGWAVE_ARTIFACT_CDC_TABLES = [
  { upstream: "inbox_target_mute_states", name: "rw_inbox_target_mute_states_v2" },
  { upstream: "servers", name: "rw_servers" },
] as const satisfies readonly { upstream: (typeof RISINGWAVE_PUBLICATION_TABLES)[number]; name: string }[];

/**
 * Every relation the server reads from RisingWave today. The serving views
 * mirror UNIFIED_CHAIN_VIEWS / CONVERSATION_UNREAD_VIEW in
 * packages/server/src/db/risingwave.ts; the rest are direct reads in
 * channelService (followed-thread stats, the sidebar public arm, the read-cursor
 * join on the Activity page) and the CDC integrity checker's windowed tables.
 */
export const RISINGWAVE_SERVER_READ_RELATIONS = [
  "rw_inbox_serving_v9",
  "rw_activity_totals_v7",
  "rw_agent_inbox_v7",
  "rw_conversation_unread_v4",
  "rw_followed_threads_v5",
  "rw_target_latest_v4",
  "rw_target_eligible_v1",
  "rw_channels",
  "rw_channel_humans",
  "rw_user_channel_read_cursors_v2",
  "rw_messages",
  "rw_message_mentions_v2",
] as const;

export interface RisingWaveBootstrapArtifact {
  /** Repo-relative path of the production SQL artifact. */
  file: string;
  /**
   * CREATE TABLE / CREATE [MATERIALIZED] VIEW names to take from the file, in
   * file order. Every other relation in the file is a superseded generation
   * and is skipped. Indexes are taken iff their base relation is built.
   */
  relations: readonly string[];
}

/**
 * Application order. This is dependency order, not file-number order:
 * 063-unified-inbox-chain.sql (the v4 chain base) precedes 063-chain-v5.sql,
 * which reads rw_target_eligible_v1 / rw_receiver_cursors_v1 /
 * rw_message_target_v3 from it.
 *
 * Deliberately NOT applied, because every relation in them is superseded and no
 * server path reads it: 063-agent-inbox.sql (rw_agent_inbox_v1),
 * 064-agent-inbox-v3.sql (rw_agent_inbox_v3), 065-agent-inbox-v4.sql
 * (rw_agent_inbox_v4); all replaced by rw_agent_inbox_v5 in 068. Nor
 * 068-chain-mention-v6-consumers.sql: its generation (items v10, serving v6,
 * totals v4, agent inbox v5, conversation unread v2) is superseded by 076.
 * Nor 067, 076 and 077 any more: every relation they create that the server
 * reads, or that feeds one, has a 078 generation that treats task
 * conversations as sub-conversations (078-task-conversations.sql); 075's arms
 * stay (078 reads them). 066 is applied for rw_inbox_muted_full_v1 only: 078's
 * conversation unread reads it instead of 075's rw_inbox_muted_full_v2 (same
 * columns and semantics), which is therefore not built.
 */
export const RISINGWAVE_BOOTSTRAP_ARTIFACTS: readonly RisingWaveBootstrapArtifact[] = [
  {
    // No MV from 024 is read any more: rw_followed_thread_stats_v1 is superseded
    // by v3 (070) and the rest is the retired sidebar/unread generation. Applied
    // only for its production indexes on the CDC tables (rw_messages,
    // rw_message_mentions_v2), which ride with their already-created base.
    file: "infra/risingwave/sql/024-risingwave-unread-inbox-full-materialized.sql",
    relations: [],
  },
  {
    // Two CDC tables (production source name rewritten) plus the shared
    // message/thread-parent helpers; the v3 inbox chain in this file is retired.
    file: "infra/risingwave/sql/061-inbox-derivation-chain.sql",
    relations: [
      "rw_inbox_target_mute_states_v2",
      "rw_servers",
      "rw_message_channel_slim_v1",
      "rw_message_preview_v1",
      "rw_thread_parent_v3",
    ],
  },
  {
    // v4 chain base. rw_inbox_normal_v4 is superseded by v5 (075); the v4
    // mention/watermark/items/serving/totals by 063-chain-v5 + 067 + 076 + 077
    // and then 078.
    file: "infra/risingwave/sql/063-unified-inbox-chain.sql",
    relations: [
      "rw_message_target_v3",
      "rw_target_latest_v4",
      "rw_target_eligible_v1",
      "rw_receiver_cursors_v1",
      "rw_subs_v2",
    ],
  },
  {
    // Muted subscriptions. The per-(receiver, server) watermark v5 is superseded
    // by v6 (077) and v7 (078); the muted prefix arm v1 by v2 (075); items v9,
    // serving v5, totals v3 and agent inbox v2 by 076, 077 and 078.
    file: "infra/risingwave/sql/063-chain-v5.sql",
    relations: ["rw_muted_subs_v1"],
  },
  {
    // The muted full-count arm rw_conversation_unread_v4 (078) reads.
    // rw_conversation_unread_v1 in the same file is superseded.
    file: "infra/risingwave/sql/066-conversation-unread-v1.sql",
    relations: ["rw_inbox_muted_full_v1"],
  },
  {
    // The cursor-decoupled arms: the read cursor is a join condition, not a
    // grouping key. Supersede rw_inbox_normal_v4 (063) and
    // rw_inbox_muted_prefix_v1 (063-chain-v5). rw_inbox_muted_full_v2 is not
    // built: 078 reads 066's rw_inbox_muted_full_v1 instead.
    file: "infra/risingwave/sql/075-inbox-cursor-decouple.sql",
    relations: ["rw_inbox_normal_v5", "rw_inbox_muted_prefix_v2"],
  },
  {
    // Task conversations (channels.type = 'task') are sub-conversations like
    // threads: rw_conversation_parent_v1 (rw_thread_parent_v3 plus task
    // conversations) and the generation on it, which supersedes 067's mention
    // arm, 076's items / agent inbox / conversation unread and 077's watermark
    // / items / serving / totals.
    file: "infra/risingwave/sql/078-task-conversations.sql",
    relations: [
      "rw_conversation_parent_v1",
      "rw_task_conversation_replies_v1",
      "rw_task_conversation_unread_v1",
      "rw_inbox_mention_v7",
      "rw_activity_watermark_v7",
      "rw_inbox_items_v13",
      "rw_inbox_preview_need_v1",
      "rw_inbox_preview_seq_v1",
      "rw_inbox_preview_parent_v1",
      "rw_inbox_serving_v9",
      "rw_activity_totals_v7",
      "rw_agent_inbox_v7",
      "rw_conversation_unread_v4",
    ],
  },
  {
    // Index-only: the sidebar unread public arm's indexes on rw_channels,
    // rw_channel_humans and rw_target_eligible_v1 (063). Like 024, the indexes
    // ride with their already-created base relations.
    file: "infra/risingwave/sql/071-unread-summary-public-arm-indexes.sql",
    relations: [],
  },
  {
    // The active followed-threads list in one row per thread: v3's stats plus
    // the parent message and its task (rw_tasks), joint projections included
    // (canonical parent, local joint parent channel). Reads
    // rw_receiver_cursors_v1 (063). Supersedes 072 (rw_followed_threads_v4).
    // Threads only: followed task conversations are read from Postgres.
    file: "infra/risingwave/sql/074-followed-threads-v5.sql",
    relations: ["rw_followed_threads_v5"],
  },
] as const;

/** Every table/view/MV the bootstrap creates, in creation order. */
export const RISINGWAVE_REQUIRED_RELATIONS: readonly string[] = [
  ...RISINGWAVE_CDC_TABLES.map((table) => table.name),
  ...RISINGWAVE_BOOTSTRAP_ARTIFACTS.flatMap((artifact) => artifact.relations),
];

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
    /^CREATE\s+(?:(?:MATERIALIZED\s+)?VIEW|TABLE|(?:UNIQUE\s+)?INDEX)\s+([a-zA-Z_][a-zA-Z0-9_]*)\b/i,
  );
  return match?.[1] ?? null;
}

/** Base relation of a `CREATE [UNIQUE] INDEX name ON relation (...)` statement. */
export function createdIndexTarget(statement: string): string | null {
  const match = sqlStatementBody(statement).match(
    /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+[a-zA-Z_][a-zA-Z0-9_]*\s+ON\s+([a-zA-Z_][a-zA-Z0-9_]*)\b/i,
  );
  return match?.[1]?.toLowerCase() ?? null;
}

function isCreateRelation(statement: string): boolean {
  return /^CREATE\s+(?:(?:MATERIALIZED\s+)?VIEW|TABLE)\b/i.test(sqlStatementBody(statement));
}

/** Statement text with comments and string literals blanked, for identifier scans. */
function codeOnly(statement: string): string {
  let out = "";
  for (let i = 0; i < statement.length; i++) {
    const ch = statement[i];
    const next = statement[i + 1];
    if (ch === "-" && next === "-") {
      const newline = statement.indexOf("\n", i);
      i = newline === -1 ? statement.length : newline;
      out += " ";
      continue;
    }
    if (ch === "/" && next === "*") {
      const close = statement.indexOf("*/", i + 2);
      i = close === -1 ? statement.length : close + 1;
      out += " ";
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      while (j < statement.length) {
        if (statement[j] === "'" && statement[j + 1] === "'") { j += 2; continue; }
        if (statement[j] === "'") break;
        j++;
      }
      i = j;
      out += "''";
      continue;
    }
    out += ch;
  }
  return out;
}

/** rw_* relations a statement reads (its own created name excluded). */
export function referencedRelations(statement: string): string[] {
  const own = (createdRelationName(statement) ?? "").toLowerCase();
  const names = new Set<string>();
  for (const match of codeOnly(statement).matchAll(/\brw_[a-z0-9_]+\b/gi)) {
    const name = match[0].toLowerCase();
    if (name !== own) names.add(name);
  }
  return [...names];
}

function isDdlSetting(body: string): boolean {
  return /^SET\s+(?:BACKGROUND_DDL|STREAMING_PARALLELISM)\s*=/i.test(body);
}

/**
 * Select, rewrite, and order the canonical repo artifacts.
 *
 * `artifacts` maps each RISINGWAVE_BOOTSTRAP_ARTIFACTS file to its contents.
 * Guards make a future artifact rewrite fail loudly instead of silently
 * applying a partial, unsafe, duplicate, or out-of-order graph:
 *   - an artifact may contain only CREATE TABLE / [MATERIALIZED] VIEW / INDEX and
 *     the two DDL settings (which are dropped: the prelude pins foreground DDL);
 *   - every selected relation exists exactly once in its artifact;
 *   - leading comments are dropped (history notes may quote superseded settings);
 *   - the production CDC source name is rewritten to the local source, and no
 *     other source reference survives;
 *   - every rw_* relation a selected statement reads was created earlier;
 *   - every server-read relation is created, and every CDC table feeds something.
 */
export function buildRisingWaveBootstrapStatements(
  artifacts: Readonly<Record<string, string>>,
): string[] {
  const created = new Set<string>();
  const referenced = new Set<string>();
  const statements: string[] = [
    "SET BACKGROUND_DDL = false",
    "SET STREAMING_PARALLELISM = 1",
  ];
  const add = (statement: string, label: string) => {
    const name = createdRelationName(statement)?.toLowerCase() ?? null;
    const indexTarget = createdIndexTarget(statement);
    const deps = referencedRelations(statement).filter((dep) => dep !== indexTarget || !indexTarget);
    for (const dep of deps) {
      if (!created.has(dep)) {
        throw new Error(`${label}: ${name ?? "statement"} reads ${dep}, which is not created before it`);
      }
      referenced.add(dep);
    }
    if (indexTarget) referenced.add(indexTarget);
    if (name && isCreateRelation(statement)) {
      if (created.has(name)) throw new Error(`${label} creates ${name} more than once`);
      created.add(name);
    }
    statements.push(statement);
  };

  for (const table of RISINGWAVE_CDC_TABLES) add(createCdcTableStatement(table), "CDC projection");

  for (const artifact of RISINGWAVE_BOOTSTRAP_ARTIFACTS) {
    const raw = artifacts[artifact.file];
    if (raw === undefined) throw new Error(`missing RisingWave artifact ${artifact.file}`);
    const label = artifact.file.split("/").pop() ?? artifact.file;
    const wanted = new Set(artifact.relations.map((name) => name.toLowerCase()));
    const found = new Map<string, number>();
    const selected: string[] = [];
    for (const statement of splitSqlStatements(raw)) {
      const body = sqlStatementBody(statement);
      if (body === "" || isDdlSetting(body)) continue;
      const name = createdRelationName(statement)?.toLowerCase();
      if (!name) {
        throw new Error(
          `${label} contains an unsupported executable statement: ${body.replace(/\s+/g, " ").slice(0, 96)}`,
        );
      }
      if (isCreateRelation(statement)) {
        found.set(name, (found.get(name) ?? 0) + 1);
        if (wanted.has(name)) selected.push(sqlStatementBody(statement));
        continue;
      }
      // An index rides with its base relation: built iff that relation is.
      const target = createdIndexTarget(statement);
      if (target && (wanted.has(target) || created.has(target))) selected.push(sqlStatementBody(statement));
    }
    for (const name of wanted) {
      const count = found.get(name) ?? 0;
      if (count !== 1) throw new Error(`${label} must create ${name} exactly once; found ${count}`);
    }
    for (const original of selected) {
      const statement = original.replaceAll(
        new RegExp(`\\b${RISINGWAVE_PRODUCTION_SOURCE}\\b`, "g"),
        RISINGWAVE_LOCAL_SOURCE,
      );
      const sources = [...codeOnly(statement).matchAll(/\bFROM\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+TABLE\s*''/gi)]
        .map((match) => match[1]);
      for (const source of sources) {
        if (source !== RISINGWAVE_LOCAL_SOURCE) {
          throw new Error(`${label}: ${createdRelationName(statement)} reads unknown CDC source ${source}`);
        }
      }
      add(statement, label);
    }
  }

  for (const relation of RISINGWAVE_SERVER_READ_RELATIONS) {
    if (!created.has(relation)) throw new Error(`bootstrap does not create server-read relation ${relation}`);
  }
  const serverReads = new Set<string>(RISINGWAVE_SERVER_READ_RELATIONS);
  for (const table of RISINGWAVE_CDC_TABLES) {
    if (!referenced.has(table.name) && !serverReads.has(table.name)) {
      throw new Error(`CDC table ${table.name} feeds no selected relation or server read`);
    }
  }
  return statements;
}
