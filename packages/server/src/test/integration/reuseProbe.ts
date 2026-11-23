/**
 * One in-memory test database per file (#triage:#516, step 2).
 *
 * A file's first `dbTest` / `apiTest` case restores a fresh PGlite from the run's template. When
 * a case is done (its background work drained, before the connection would close),
 * `reclaimDatabase` decides whether the next case may have the database:
 *
 * 1. `DISCARD ALL` on the connection (PGlite has exactly one): it resets session settings, named
 *    prepared statements, cursors, LISTEN, advisory locks, SET ROLE and temp tables. What the case
 *    left is counted (`discarded.<kind>`, `setting.<name>`) before it goes.
 * 2. The check. Any of these discards the database and the next case restores a fresh one
 *    (`drop.<reason>`): the case failed; a transaction is still open or aborted; the case made
 *    temp tables; the catalogs moved (DDL, roles, comments, a case's own TRUNCATE); anything
 *    DISCARD ALL should have reset is still there; a sequence no cleared table owns moved.
 * 3. The clean: the tables the case wrote (`pg_relation_size` > 0; a write rolled back still
 *    leaves pages, so this only over-clears) are truncated with their identities restarted, the
 *    template's seeded tables are restored when their rows changed, owned sequences go back to the
 *    template's values. Our own TRUNCATE moves pg_class, so the catalog mark the next case is
 *    checked against is re-read after it.
 * 4. With RAFT_TEST_DB_REUSE_CHECK on (the default), a self-check then requires every table,
 *    sequence and seeded row to match the template; a failure discards the database
 *    (`selfCheckFailed`), never the case.
 *
 * Counts go to the case's meta (`integrationReuse`: `restored` / `reused` for what the case got,
 * then `reusable`, `drop.*`, `selfCheckFailed`, ...), timings to its phases (`reuseBaseline`,
 * `reuseCheck`, `reuseDiscard`, and the clean's `reuseTruncate`, `reuseSeeded`, `reuseSequences`,
 * `reuseSelfCheck`); scripts/serverShardTimingReporter.ts sums both per file. Reclaiming never fails
 * a case: an error in it is counted as `probeError`, one that outlasts its bound (database.ts) as
 * `probeTimeout`, and either discards the database. RAFT_TEST_DB_REUSE=0 turns all of it off: every
 * case restores a fresh database and nothing is reclaimed. REUSE_OPT_OUT does the same for one file.
 */
import type { PGlite } from "@electric-sql/pglite";

export const REUSE_ENV = "RAFT_TEST_DB_REUSE";
export const REUSE_CHECK_ENV = "RAFT_TEST_DB_REUSE_CHECK";

/**
 * Files whose cases never share a database: each case restores a fresh one and nothing is reclaimed
 * (RAFT_TEST_DB_REUSE=0, for one file; counted as `optedOut`). Path from packages/server -> why, in
 * one line. For a file whose trouble with reuse we can't explain yet, instead of turning reuse off
 * for everyone. Not for a file that closes its database itself (in a case or in afterEach): that
 * already skips the reclaim (`drop.closedByCase`). In code, not an env var, so CI and local runs
 * agree and every entry is reviewed with its reason.
 */
export const REUSE_OPT_OUT: Readonly<Record<string, string>> = {};

export function reuseEnabled(): boolean {
  return process.env[REUSE_ENV] !== "0";
}

/** Whether a test file (its path from packages/server, as Vitest names it) is on REUSE_OPT_OUT. */
export function reuseOptedOut(file: string | undefined, optOut: Readonly<Record<string, string>> = REUSE_OPT_OUT): boolean {
  return file !== undefined && Object.hasOwn(optOut, file);
}

/** On by default (#triage:#516: on in CI for now); `0` skips the self-check after each clean. */
export function reuseSelfCheckEnabled(): boolean {
  return process.env[REUSE_CHECK_ENV] !== "0";
}

type ProbeClient = Pick<PGlite, "query" | "exec">;

/**
 * Catalogs whose rows DDL adds, changes or removes: a changed count or a newer row means the schema
 * moved. The last row: roles, per-role/database settings, comments, default ACLs, large objects.
 */
const CATALOGS = [
  "pg_namespace", "pg_class", "pg_attribute", "pg_attrdef", "pg_constraint", "pg_index", "pg_trigger",
  "pg_proc", "pg_type", "pg_enum", "pg_rewrite", "pg_policy", "pg_extension", "pg_sequence",
  "pg_authid", "pg_auth_members", "pg_db_role_setting", "pg_description", "pg_default_acl", "pg_largeobject_metadata",
] as const;

const CATALOG_MARK_SQL = `SELECT concat_ws('|', ${CATALOGS.map((name) =>
  `(SELECT count(*) || ':' || coalesce(max(xmin::text::bigint), 0) FROM ${name})`).join(", ")}) AS mark`;

const USER_TABLES_SQL = `
  SELECT c.oid::regclass::text AS name, pg_relation_size(c.oid) > 0 AS written
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r' AND c.relpersistence <> 't'
    AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%'`;

const SEQUENCES_SQL = `
  SELECT format('%I.%I', schemaname, sequencename) AS name, last_value::text AS value
  FROM pg_sequences ORDER BY 1`;

const SESSION_SQL = `
  SELECT
    (SELECT coalesce(string_agg(name, ',' ORDER BY name), '') FROM pg_settings WHERE source = 'session') AS settings,
    (SELECT count(*)::int FROM pg_listening_channels()) AS listening,
    (SELECT coalesce(string_agg(name, ',' ORDER BY name), '') FROM pg_prepared_statements) AS prepared,
    (SELECT count(*)::int FROM pg_cursors) AS cursors,
    (SELECT count(*)::int FROM pg_locks WHERE locktype = 'advisory') AS advisory,
    (SELECT count(*)::int FROM pg_class WHERE relpersistence = 't') AS temp_relations`;

/**
 * Each transaction takes these afresh from their `default_*` settings, so they never reach the next
 * case; once a transaction sets them (drizzle's `transaction({ isolationLevel, accessMode })`)
 * pg_settings reports them as `session` for good, and DISCARD ALL can't reset them.
 */
const PER_TRANSACTION_SETTINGS = new Set(["transaction_isolation", "transaction_read_only", "transaction_deferrable"]);

function lastingSettings(settings: string): string {
  return settings.split(",").filter((name) => name && !PER_TRANSACTION_SETTINGS.has(name)).join(",");
}

interface SessionState {
  settings: string;
  listening: number;
  prepared: string;
  cursors: number;
  advisory: number;
  temp_relations: number;
}

/**
 * Whether the session is inside a transaction block: SAVEPOINT is refused outside one (25P01) and
 * in an aborted one (25P02), and taken (then released) inside a live one. `now()` against
 * `statement_timestamp()` can't tell: under PGlite they differ outside a block too.
 */
async function transactionState(client: ProbeClient): Promise<"none" | "open" | "aborted"> {
  try {
    await client.exec("SAVEPOINT reuse_probe");
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "25P01") return "none";
    if (code === "25P02") return "aborted";
    throw error;
  }
  await client.exec("RELEASE SAVEPOINT reuse_probe");
  return "open";
}

/** The template as a fresh restore sees it: what a cleared database must equal again. */
export interface ReuseBaseline {
  catalogMark: string;
  session: SessionState;
  /** Tables the template already holds rows in, with those rows (JSON) and a checksum of them. */
  seeded: Map<string, { checksum: string; rows: string; columns: string[] }>;
  sequences: Map<string, string | null>;
  /**
   * Sequence name -> a table that owns it: an identity or serial column, or a column whose default
   * calls it without `OWNED BY` (`change_log.seq DEFAULT nextval('change_log_seq_seq')`, 0450).
   * A sequence only such a table's rows use goes back to the template's value with them.
   */
  sequenceOwners: Map<string, string>;
}

function checksumSql(table: string): string {
  return `SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS checksum FROM ${table} t`;
}

/** Every seeded table's checksum in one round trip. */
async function readChecksums(client: ProbeClient, tables: readonly string[]): Promise<string[]> {
  if (!tables.length) return [];
  const row = (await client.query<Record<string, string>>(
    `SELECT ${tables.map((table, index) => `(${checksumSql(table)}) AS c${index}`).join(", ")}`)).rows[0]!;
  return tables.map((_, index) => row[`c${index}`]!);
}

async function readSession(client: ProbeClient): Promise<SessionState> {
  return (await client.query<SessionState>(SESSION_SQL)).rows[0]!;
}

async function readCatalogMark(client: ProbeClient): Promise<string> {
  return (await client.query<{ mark: string }>(CATALOG_MARK_SQL)).rows[0]!.mark;
}

async function readSequences(client: ProbeClient): Promise<Map<string, string | null>> {
  const rows = (await client.query<{ name: string; value: string | null }>(SEQUENCES_SQL)).rows;
  return new Map(rows.map((row) => [row.name, row.value]));
}

/** Read from a database fresh from the template, before any case touches it. */
export async function readReuseBaseline(client: ProbeClient): Promise<ReuseBaseline> {
  const tables = (await client.query<{ name: string; written: boolean }>(USER_TABLES_SQL)).rows;
  const seeded = new Map<string, { checksum: string; rows: string; columns: string[] }>();
  for (const { name, written } of tables) {
    if (!written) continue;
    const { checksum } = (await client.query<{ checksum: string }>(checksumSql(name))).rows[0]!;
    const { rows } = (await client.query<{ rows: string }>(`SELECT coalesce(json_agg(t), '[]')::text AS rows FROM ${name} t`)).rows[0]!;
    const columns = (await client.query<{ column: string }>(
      `SELECT quote_ident(attname) AS column FROM pg_attribute
       WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = '' ORDER BY attnum`, [name])).rows.map((row) => row.column);
    seeded.set(name, { checksum, rows, columns });
  }
  const owners = (await client.query<{ sequence: string; owner: string }>(`
    SELECT format('%I.%I', sn.nspname, s.relname) AS sequence, d.refobjid::regclass::text AS owner
    FROM pg_depend d
    JOIN pg_class s ON s.oid = d.objid AND s.relkind = 'S'
    JOIN pg_namespace sn ON sn.oid = s.relnamespace
    WHERE d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
    UNION ALL
    SELECT format('%I.%I', sn.nspname, s.relname), ad.adrelid::regclass::text
    FROM pg_depend d
    JOIN pg_attrdef ad ON ad.oid = d.objid
    JOIN pg_class s ON s.oid = d.refobjid AND s.relkind = 'S'
    JOIN pg_namespace sn ON sn.oid = s.relnamespace
    WHERE d.classid = 'pg_attrdef'::regclass AND d.refclassid = 'pg_class'::regclass AND d.deptype = 'n'`)).rows;
  return {
    catalogMark: await readCatalogMark(client),
    session: await readSession(client),
    seeded,
    sequences: await readSequences(client),
    sequenceOwners: new Map(owners.map((row) => [row.sequence, row.owner])),
  };
}

export type ReuseCounts = Record<string, number>;

export interface ReuseVerdict {
  counts: ReuseCounts;
  /** The catalog mark to check the next case against (see the file comment); null: discard the database. */
  catalogMark: string | null;
}

/**
 * Reclaim a database a case is done with for the next case (see the file comment). `catalogMark`
 * is the one it was handed over with: the baseline's for a fresh restore, else the last clean's.
 */
export async function reclaimDatabase(
  client: ProbeClient,
  baseline: ReuseBaseline,
  options: {
    caseFailed: boolean;
    catalogMark: string;
    selfCheck: boolean;
    measure: <T>(phase: string, work: () => Promise<T>) => Promise<T>;
  },
): Promise<ReuseVerdict> {
  const counts: ReuseCounts = { probed: 1 };
  const drop = (reason: string) => { counts[`drop.${reason}`] = 1; };
  const dropped = () => Object.keys(counts).some((key) => key.startsWith("drop."));
  try {
    if (options.caseFailed) drop("caseFailed");
    // DISCARD ALL is refused inside a transaction block.
    const outside = await options.measure("reuseCheck", async () => {
      const transaction = await transactionState(client);
      if (transaction === "none") return true;
      drop(transaction === "open" ? "openTransaction" : "abortedTransaction");
      return false;
    });
    if (!outside) return { counts, catalogMark: null };

    await options.measure("reuseCheck", async () => {
      const left = await readSession(client);
      const before = new Set(baseline.session.settings.split(",").filter(Boolean));
      const after = new Set(left.settings.split(",").filter(Boolean));
      for (const name of after) if (!before.has(name)) counts[`setting.${name}`] = 1;
      for (const name of before) if (!after.has(name)) counts[`settingGone.${name}`] = 1;
      if (lastingSettings(left.settings) !== lastingSettings(baseline.session.settings)) counts["discarded.sessionSettings"] = 1;
      if (left.listening > baseline.session.listening) counts["discarded.listening"] = 1;
      if (left.prepared !== baseline.session.prepared) counts["discarded.preparedStatements"] = 1;
      if (left.cursors > baseline.session.cursors) counts["discarded.cursors"] = 1;
      if (left.advisory > baseline.session.advisory) counts["discarded.advisoryLocks"] = 1;
      // DISCARD ALL drops them too, but a case that needs temp tables is not one to share a database with.
      if (left.temp_relations > baseline.session.temp_relations) drop("tempTables");
    });
    await options.measure("reuseDiscard", () => client.exec("DISCARD ALL"));
    await options.measure("reuseCheck", async () => {
      // What DISCARD ALL should have reset: anything left means it couldn't.
      const session = await readSession(client);
      if (lastingSettings(session.settings) !== lastingSettings(baseline.session.settings)) drop("sessionSettings");
      if (session.listening > baseline.session.listening) drop("listening");
      if (session.prepared !== baseline.session.prepared) drop("preparedStatements");
      if (session.cursors > baseline.session.cursors) drop("cursors");
      if (session.advisory > baseline.session.advisory) drop("advisoryLocks");
      if (session.temp_relations > baseline.session.temp_relations) drop("tempTables");
      if (await readCatalogMark(client) !== options.catalogMark) drop("catalog");
    });
    if (dropped()) return { counts, catalogMark: null };

    if (!await clean(client, baseline, counts, options.measure)) return { counts, catalogMark: null };
    if (options.selfCheck && !await options.measure("reuseSelfCheck", () => selfCheck(client, baseline))) {
      counts.selfCheckFailed = 1;
      return { counts, catalogMark: null };
    }
    const catalogMark = await options.measure("reuseCheck", () => readCatalogMark(client));
    counts.reusable = 1;
    return { counts, catalogMark };
  } catch {
    counts.probeError = 1;
    return { counts, catalogMark: null };
  }
}

/**
 * Clear what the case wrote (see the file comment), timed in its parts (`reuseTruncate`,
 * `reuseSeeded`, `reuseSequences`; they don't overlap). False: a sequence no table owns moved.
 */
async function clean(
  client: ProbeClient,
  baseline: ReuseBaseline,
  counts: ReuseCounts,
  measure: <T>(phase: string, work: () => Promise<T>) => Promise<T>,
): Promise<boolean> {
  const tables = await measure("reuseTruncate", async () =>
    (await client.query<{ name: string; written: boolean }>(USER_TABLES_SQL)).rows);
  const written = tables.filter((table) => table.written && !baseline.seeded.has(table.name)).map((table) => table.name);
  counts.writtenTables = written.length;
  // One transaction with triggers off (session_replication_role, local to it): the schema's own
  // guards (a TRUNCATE trigger on a seeded table, FK actions) are the case's business, not the clean's.
  await client.exec("BEGIN");
  try {
    await measure("reuseTruncate", async () => {
      await client.exec("SET LOCAL session_replication_role = replica");
      if (written.length) await client.exec(`TRUNCATE ${written.join(", ")} RESTART IDENTITY CASCADE`);
    });
    // Checked after that TRUNCATE: its CASCADE may have emptied a seeded table that references a written one.
    await measure("reuseSeeded", async () => {
      let restored = 0;
      const seededNames = [...baseline.seeded.keys()];
      const checksums = await readChecksums(client, seededNames);
      for (const [index, name] of seededNames.entries()) {
        const seeded = baseline.seeded.get(name)!;
        if (checksums[index] === seeded.checksum) continue;
        restored += 1;
        await client.exec(`DELETE FROM ${name}`);
        if (seeded.columns.length) {
          const columns = seeded.columns.join(", ");
          await client.query(
            `INSERT INTO ${name} (${columns}) OVERRIDING SYSTEM VALUE SELECT ${columns} FROM json_populate_recordset(NULL::${name}, $1::json)`,
            [seeded.rows]);
        }
      }
      counts.seededRestored = restored;
    });
    await measure("reuseSequences", async () => {
      // A table's own sequences go back to the template's values (its rows are the template's again);
      // a sequence no table owns that moved means the next case would see different ids.
      for (const [name, value] of await readSequences(client)) {
        const expected = baseline.sequences.get(name) ?? null;
        if (value === expected) continue;
        if (!baseline.sequenceOwners.has(name)) {
          counts["drop.sequence"] = 1;
          counts[`sequence.${name}`] = 1;
          continue;
        }
        // Never called in the template: back to its own start value, not yet used.
        if (expected === null) {
          await client.query(`SELECT setval($1::text::regclass, (SELECT start_value FROM pg_sequences WHERE format('%I.%I', schemaname, sequencename) = $1::text), false)`, [name]);
        } else {
          await client.query("SELECT setval($1::regclass, $2::bigint, true)", [name, expected]);
        }
      }
    });
    await client.exec("COMMIT");
  } catch (error) {
    await client.exec("ROLLBACK").catch(() => {});
    throw error;
  }
  return !counts["drop.sequence"];
}

/** After clearing: nothing but the template's rows, the template's sequences, the template's schema. */
export async function selfCheck(client: ProbeClient, baseline: ReuseBaseline): Promise<boolean> {
  const tables = (await client.query<{ name: string; written: boolean }>(USER_TABLES_SQL)).rows;
  if (tables.some((table) => table.written && !baseline.seeded.has(table.name))) return false;
  const seededNames = [...baseline.seeded.keys()];
  const checksums = await readChecksums(client, seededNames);
  if (seededNames.some((name, index) => checksums[index] !== baseline.seeded.get(name)!.checksum)) return false;
  const sequences = await readSequences(client);
  for (const [name, value] of sequences) {
    if (value !== (baseline.sequences.get(name) ?? null)) return false;
  }
  return sequences.size === baseline.sequences.size;
}
