import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const SERVER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function readServerFile(relativePath: string) {
  return readFile(path.join(SERVER_ROOT, relativePath), "utf8");
}

/** The newest snapshot: the one drizzle-kit generate diffs schema.ts against (older ones are pruned). */
async function latestSnapshot() {
  const journal = JSON.parse(await readServerFile("drizzle/meta/_journal.json")) as { entries: Array<{ idx: number }> };
  const last = String(journal.entries.at(-1)!.idx).padStart(4, "0");
  return JSON.parse(await readServerFile(`drizzle/meta/${last}_snapshot.json`));
}

test("0248 keeps the large sender index out of drizzle migrate", async () => {
  const migration = await readServerFile("drizzle/0248_even_ogun.sql");

  assert.match(migration, /SELECT 1;/);
  assert.doesNotMatch(
    migration,
    /CREATE INDEX\s+"idx_messages_sender_created_at"/,
  );
});

test("the latest snapshot declares the sender index for future schema diffs", async () => {
  const snapshot = await latestSnapshot();
  assert.ok(snapshot.tables["public.messages"].indexes.idx_messages_sender_created_at, "snapshot must declare idx_messages_sender_created_at");
});
