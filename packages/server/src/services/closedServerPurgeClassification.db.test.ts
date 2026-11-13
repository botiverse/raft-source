// The contract that makes every foreign key to servers.id or agents.id get a
// closed-server purge decision (closedServerPurgeClassification.ts, Tenny
// #55), read from the live schema: pg_constraint, pg_index and pg_attribute
// of the database every migration has built (the db tests' PGlite), so a
// table or key that only a migration creates, or one outside db/schema.ts,
// is seen too. It holds:
//  - exactly the database's keys are classified, each with its ON DELETE;
//  - every step's deletes, followed through every ON DELETE CASCADE, reach
//    only tables that are deleted too or acknowledged, never a kept one;
//  - a `by` step really reaches the table it claims;
//  - server_rows: public tables only, the right target, its order allowed
//    by the RESTRICT / NO ACTION keys, every channel column named (kept
//    channels' rows are excluded through them), an index on the key and on
//    every column that references a deleted table (or a reason), and no
//    table a writer registry guards.
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import { getDb } from "../db/index";
import { dbTest as test } from "../test/integration/dbTest";
import { JOINT_WRITE_TABLES } from "../test/jointUsersFirstEntryPoints";
import {
  CLOSED_SERVER_PURGE_CASCADES,
  CLOSED_SERVER_PURGE_CLASSIFICATION,
  CLOSED_SERVER_PURGE_KEEP_REASONS,
  CLOSED_SERVER_PURGE_ROW_STEPS,
  CLOSED_SERVER_PURGE_STEP_TABLES,
  closedServerPurgeRowDeletes,
  type ClosedServerPurgeKeyClassification,
} from "./closedServerPurgeClassification";
import { CLOSED_SERVER_PURGE_FINISH_STEPS } from "./closedServerPurgeFinish";

interface ForeignKey { from: string; column: string; to: string; toColumn: string; onDelete: string; columns: number }

const ON_DELETE: Record<string, string> = { a: "no action", r: "restrict", c: "cascade", n: "set null", d: "set default" };
const qualified = (schema: string, table: string) => (schema === "public" ? table : `${schema}.${table}`);
const rowsOf = <T>(result: unknown) => (result as { rows: T[] }).rows;

async function liveSchema() {
  const db = getDb();
  const keys = rowsOf<{ from_schema: string; from_table: string; from_col: string; to_schema: string; to_table: string; to_col: string; deltype: string; n: number }>(await db.execute(sql`
    SELECT nf.nspname AS from_schema, cf.relname AS from_table, af.attname AS from_col,
           nt.nspname AS to_schema, ct.relname AS to_table, at.attname AS to_col,
           c.confdeltype::text AS deltype, cardinality(c.conkey)::int AS n
      FROM pg_constraint c
      JOIN pg_class cf ON cf.oid = c.conrelid JOIN pg_namespace nf ON nf.oid = cf.relnamespace
      JOIN pg_class ct ON ct.oid = c.confrelid JOIN pg_namespace nt ON nt.oid = ct.relnamespace
      JOIN pg_attribute af ON af.attrelid = c.conrelid AND af.attnum = c.conkey[1]
      JOIN pg_attribute at ON at.attrelid = c.confrelid AND at.attnum = c.confkey[1]
     WHERE c.contype = 'f'`)).map((row): ForeignKey => ({
    from: qualified(row.from_schema, row.from_table),
    column: row.from_col,
    to: qualified(row.to_schema, row.to_table),
    toColumn: row.to_col,
    onDelete: ON_DELETE[row.deltype]!,
    columns: Number(row.n),
  }));
  const leading = new Map<string, Set<string>>();
  for (const row of rowsOf<{ schema: string; table: string; col: string }>(await db.execute(sql`
    SELECT n.nspname AS schema, t.relname AS table, a.attname AS col
      FROM pg_index i
      JOIN pg_class t ON t.oid = i.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = i.indkey[0]
     WHERE i.indisvalid`))) {
    const table = qualified(row.schema, row.table);
    if (!leading.has(table)) leading.set(table, new Set());
    leading.get(table)!.add(row.col);
  }
  const uuidColumns = new Map<string, Set<string>>();
  for (const row of rowsOf<{ schema: string; table: string; col: string }>(await db.execute(sql`
    SELECT table_schema AS schema, table_name AS table, column_name AS col
      FROM information_schema.columns WHERE data_type = 'uuid' AND table_schema NOT IN ('pg_catalog', 'information_schema')`))) {
    const table = qualified(row.schema, row.table);
    if (!uuidColumns.has(table)) uuidColumns.set(table, new Set());
    uuidColumns.get(table)!.add(row.col);
  }
  return { keys, leading, uuidColumns };
}

const classified = CLOSED_SERVER_PURGE_CLASSIFICATION as Record<string, ClosedServerPurgeKeyClassification>;
const keyOf = (fk: { from: string; column: string }) => `${fk.from}.${fk.column}`;
const tableOfKey = (key: string) => key.slice(0, key.lastIndexOf("."));

test("the live schema: every key to servers.id or agents.id is classified, each step's cascades are deleted or acknowledged, and the server_rows deletes are safe", async ({ db }) => {
  assert.ok(db);
  const { keys, leading, uuidColumns } = await liveSchema();
  const problems: string[] = [];
  const check = (ok: unknown, problem: string) => {
    if (!ok) problems.push(problem);
  };

  // 1. Exactly the database's keys, with its ON DELETE.
  const scoped = keys.filter((fk) => (fk.to === "servers" || fk.to === "agents") && fk.toColumn === "id");
  check(scoped.some((fk) => fk.from.startsWith("app_")), "the apps' schemas are read too");
  for (const fk of scoped) {
    check(fk.columns === 1, `${keyOf(fk)}: a composite key to ${fk.to}`);
    const classification = classified[keyOf(fk)];
    check(classification, `${keyOf(fk)} (${fk.onDelete}): not classified; add it to closedServerPurgeClassification.ts (deleted by which step, or kept with a reason)`);
    if (classification) check(classification.onDelete === fk.onDelete, `${keyOf(fk)}: the database says ${fk.onDelete}, classified ${classification.onDelete}`);
  }
  const live = new Set(scoped.map(keyOf));
  for (const key of Object.keys(classified)) check(live.has(key), `${key}: classified, but no such key in the database`);
  for (const [key, classification] of Object.entries(classified)) {
    if (classification.purge === "keep") check(classification.reason in CLOSED_SERVER_PURGE_KEEP_REASONS, `${key}: unknown reason`);
    if ("via" in classification) {
      const other = classified[classification.via];
      check(other && tableOfKey(classification.via) === tableOfKey(key) && ("by" in other || "ownedBy" in other), `${key}: via a deleting key of the same table`);
    }
  }

  // 2. Every step's deletes and what they cascade into.
  const cascadesInto = (table: string) => keys.filter((fk) => fk.to === table && fk.onDelete === "cascade" && fk.from !== table);
  const keptTables = new Set(Object.entries(classified).filter(([, c]) => c.purge === "keep").map(([key]) => tableOfKey(key)));
  const deletedTables = new Set(Object.entries(classified).filter(([, c]) => c.purge === "delete").map(([key]) => tableOfKey(key)));
  const reachedBy = new Map<string, Set<string>>();
  for (const [step, tables] of Object.entries(CLOSED_SERVER_PURGE_STEP_TABLES)) {
    const reached = new Set<string>(tables);
    for (const table of reached) for (const fk of cascadesInto(table)) reached.add(fk.from);
    reachedBy.set(step, reached);
    for (const table of reached) {
      if (tables.includes(table)) continue;
      check(!keptTables.has(table), `${step}: cascades into ${table}, which the classification keeps; delete it with that step (by "${step}") or change the key`);
      check(deletedTables.has(table) || table in CLOSED_SERVER_PURGE_CASCADES, `${step}: cascades into ${table}; classify it or acknowledge it in CLOSED_SERVER_PURGE_CASCADES`);
    }
  }
  for (const [key, classification] of Object.entries(classified)) {
    if (!("by" in classification) || (CLOSED_SERVER_PURGE_ROW_STEPS as readonly string[]).includes(classification.by)) continue;
    check(reachedBy.get(classification.by)?.has(tableOfKey(key)), `${key}: by "${classification.by}", but that step neither deletes nor cascades into ${tableOfKey(key)}`);
  }
  for (const [key, classification] of Object.entries(classified)) {
    if ("ownedBy" in classification) check(CLOSED_SERVER_PURGE_STEP_TABLES[classification.ownedBy].includes(tableOfKey(key)), `${key}: ownedBy ${classification.ownedBy}, which does not list ${tableOfKey(key)} as deleting it`);
  }
  for (const [key, classification] of Object.entries(classified)) {
    if (!("cascadeFrom" in classification)) continue;
    const parent = classification.cascadeFrom;
    check(keys.some((fk) => fk.from === tableOfKey(key) && fk.to === parent && fk.onDelete === "cascade"), `${key}: cascadeFrom ${parent}, but ${tableOfKey(key)} has no ON DELETE CASCADE key to it`);
    check([...reachedBy.values()].some((set) => set.has(parent)), `${key}: cascadeFrom ${parent}, which no step deletes`);
  }
  const everReached = new Set([...reachedBy.values()].flatMap((set) => [...set]));
  for (const table of Object.keys(CLOSED_SERVER_PURGE_CASCADES)) check(everReached.has(table), `${table}: acknowledged, but no step cascades into it`);

  // 3. The row steps (server_rows, then credential_revoke, app_installs, slack_bridge: their order is the finish's).
  const deletes = closedServerPurgeRowDeletes();
  const position = new Map(deletes.map((entry, index) => [entry.table, index]));
  const guarded = new Set([...Object.values(JOINT_WRITE_TABLES).map((table) => table.sqlName), "inbox_suppression_states"]);
  const indexed = (table: string, column: string) => leading.get(table)?.has(column) ?? false;
  for (const entry of deletes) {
    const classification = classified[entry.key] as { scan?: string };
    check(!entry.table.includes("."), `${entry.key}: core never deletes an app's table (its purgeServer does)`);
    const fk = scoped.find((candidate) => keyOf(candidate) === entry.key);
    check(fk && entry.agentKey === (fk.to === "agents"), `${entry.key}: deleted by ${entry.agentKey ? "the server's agents" : "the server"}`);
    // A step's own non-row deletes (the uninstall's install rows, the Slack step's installs) run before its row deletes.
    check(indexed(entry.table, entry.column) || classification.scan, `${entry.key}: no index leads with ${entry.column}; add one or give the reason a scan is fine (scan)`);
    check(!guarded.has(entry.table), `${entry.key}: a writer registry guards ${entry.table}; go through it`);
    // Kept channels' rows stay: every channel column is named, and only those.
    const channelColumns = new Set([
      ...keys.filter((candidate) => candidate.from === entry.table && candidate.to === "channels").map((candidate) => candidate.column),
      ...[...(uuidColumns.get(entry.table) ?? [])].filter((column) => /channel_id$/.test(column)),
    ]);
    if (entry.channelExempt) check(entry.channelColumns.length === 0 && channelColumns.size > 0, `${entry.key}: channelExempt only for a table with channel columns, none declared`);
    else check(JSON.stringify([...channelColumns].sort()) === JSON.stringify([...entry.channelColumns].sort()),
      `${entry.key}: its channel columns are [${[...channelColumns].sort().join(", ")}]; declare exactly these (channels) so kept channels' rows stay`);
    for (const ref of keys.filter((candidate) => candidate.to === entry.table && candidate.from !== entry.table)) {
      const refKey = keyOf(ref);
      if (ref.onDelete === "restrict" || ref.onDelete === "no action") {
        const before = position.get(ref.from);
        check((before !== undefined && before < position.get(entry.table)!) || entry.unlessReferencedBy.includes(refKey),
          `${entry.key}: ${refKey} (${ref.onDelete}) would refuse the delete: delete ${ref.from} first, or keep what it names (unlessReferencedBy)`);
      }
    }
    for (const refKey of entry.unlessReferencedBy) {
      const ref = keys.find((candidate) => keyOf(candidate) === refKey);
      check(ref && ref.to === entry.table && ref.toColumn === "id", `${entry.key}: ${refKey} is not a key to ${entry.table}.id`);
    }
  }

  // Each row a row step deletes (its row deletes and its own) looks up the rows naming it: an index on every referencing column.
  for (const step of CLOSED_SERVER_PURGE_ROW_STEPS) {
    for (const table of new Set(CLOSED_SERVER_PURGE_STEP_TABLES[step])) {
      for (const ref of keys.filter((candidate) => candidate.to === table && candidate.from !== table)) {
        const refScan = (classified[keyOf(ref)] as { scan?: string } | undefined)?.scan;
        check(indexed(ref.from, ref.column) || refScan, `${keyOf(ref)} references ${table} (deleted by ${step}): no index leads with it, so every delete scans ${ref.from}`);
      }
    }
  }

  assert.deepEqual(problems, []);
});

test("the finish has every step the classification names, none pending: done is reachable", () => {
  const steps = new Map(CLOSED_SERVER_PURGE_FINISH_STEPS.map((step) => [step.name, step]));
  for (const step of CLOSED_SERVER_PURGE_FINISH_STEPS) assert.ok(!("pending" in step), `${step.name}: pending`);
  for (const name of ["hosted_runtimes", "wechat_bridge", "agent_tombstones", ...CLOSED_SERVER_PURGE_ROW_STEPS]) assert.ok(steps.has(name), name);
  const order = CLOSED_SERVER_PURGE_FINISH_STEPS.map((step) => step.name);
  const rowOrder = CLOSED_SERVER_PURGE_ROW_STEPS.map((name) => order.indexOf(name));
  assert.deepEqual(rowOrder, [...rowOrder].sort((a, b) => a - b), "the row steps run in CLOSED_SERVER_PURGE_ROW_STEPS order");
});
