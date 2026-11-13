import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "vitest";

// idx_messages_channel_thread_parent was built concurrently outside the
// transactional Drizzle migration (0293) and is dropped the same way (0309):
// DROP INDEX CONCURRENTLY cannot run inside the migrator's transaction.
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

const stripSql = (sql: string) => sql.replace(/--.*$/gm, "").replace(/\s/g, "");

test("0293 and 0309 keep the thread-parent index out of drizzle migrate", async () => {
  assert.equal(stripSql(await readServerFile("drizzle/0293_messages_channel_thread_parent_index.sql")), "SELECT1;");
  assert.equal(stripSql(await readServerFile("drizzle/0309_messages_drop_channel_thread_parent_index.sql")), "SELECT1;");
});

test("the latest snapshot does not declare the thread-parent index", async () => {
  const snapshot = await latestSnapshot();
  assert.equal(snapshot.tables["public.messages"].indexes.idx_messages_channel_thread_parent, undefined);
});
