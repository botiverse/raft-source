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

test("0140 keeps the large partial index out of drizzle migrate", async () => {
  const migration = await readServerFile("drizzle/0140_great_blacklash.sql");

  assert.match(
    migration,
    /ALTER TABLE "messages" ADD COLUMN "random_id" text/,
  );
  assert.doesNotMatch(
    migration,
    /CREATE UNIQUE INDEX\s+"idx_messages_user_random_id"/,
  );
});
