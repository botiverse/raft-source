import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "vitest";
import { assertThreadParentChannelIndexReady } from "../../scripts/channels-thread-parent-channel-index";

// idx_channels_thread_parent_channel is built concurrently outside the
// transactional Drizzle migration (same contract as 0236 / 0248 / 0293).
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function readServerFile(relativePath: string) {
  return readFile(path.join(SERVER_ROOT, relativePath), "utf8");
}

/** The newest snapshot: the one drizzle-kit generate diffs schema.ts against (older ones are pruned). */
async function latestSnapshot() {
  const journal = JSON.parse(await readServerFile("drizzle/meta/_journal.json")) as { entries: Array<{ idx: number }> };
  const last = String(journal.entries.at(-1)!.idx).padStart(4, "0");
  return JSON.parse(await readServerFile(`drizzle/meta/${last}_snapshot.json`));
}

test("0298 keeps the thread parent-channel index out of drizzle migrate", async () => {
  const migration = await readServerFile("drizzle/0298_channels_thread_parent_channel_index.sql");
  assert.equal(migration.replace(/--.*$/gm, "").replace(/\s/g, ""), "SELECT1;");
});

test("the latest snapshot declares the thread parent-channel partial index for future schema diffs", async () => {
  const snapshot = await latestSnapshot();
  const index = snapshot.tables["public.channels"].indexes.idx_channels_thread_parent_channel;
  assert.ok(index, "snapshot must declare idx_channels_thread_parent_channel");
  assert.deepEqual(index.columns.map((column: { expression: string }) => column.expression), ["parent_channel_id", "id"]);
  assert.equal(index.where, "type = 'thread' AND deleted_at IS NULL");
});

test("the readiness check accepts exactly the built shape", () => {
  const ready = { exists: true, isUnique: false, isValid: true, isReady: true, columns: ["parent_channel_id", "id"], predicate: "((type = 'thread'::text) AND (deleted_at IS NULL))" };
  assert.doesNotThrow(() => assertThreadParentChannelIndexReady(ready));
  assert.throws(() => assertThreadParentChannelIndexReady({ ...ready, isValid: false }), /not ready\/valid/);
  assert.throws(() => assertThreadParentChannelIndexReady({ ...ready, columns: ["parent_channel_id"] }), /unexpected columns/);
  assert.throws(() => assertThreadParentChannelIndexReady({ ...ready, predicate: "(type = 'thread'::text)" }), /unexpected predicate/);
});
