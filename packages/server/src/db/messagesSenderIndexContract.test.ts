import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "vitest";

const SERVER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function readServerFile(relativePath: string) {
  return readFile(path.join(SERVER_ROOT, relativePath), "utf8");
}

test("0248 keeps the large sender index out of drizzle migrate", async () => {
  const migration = await readServerFile("drizzle/0248_even_ogun.sql");

  assert.match(migration, /SELECT 1;/);
  assert.doesNotMatch(
    migration,
    /CREATE INDEX\s+"idx_messages_sender_created_at"/,
  );
});

test("snapshot declares the sender index for future schema diffs", async () => {
  const snapshot = await readServerFile("drizzle/meta/0248_snapshot.json");
  assert.match(snapshot, /idx_messages_sender_created_at/);
});

test("server package exposes concurrent sender index create and verify scripts", async () => {
  const packageJson = JSON.parse(await readServerFile("package.json"));
  assert.equal(
    packageJson.scripts["db:create-messages-sender-index"],
    "tsx scripts/create-messages-sender-index.ts",
  );
  assert.equal(
    packageJson.scripts["db:verify-messages-sender-index"],
    "tsx scripts/verify-messages-sender-index.ts",
  );

  const helperScript = await readServerFile("scripts/messages-sender-index.ts");
  assert.match(
    helperScript,
    /CREATE INDEX CONCURRENTLY IF NOT EXISTS "\$\{SENDER_INDEX_NAME\}"/,
  );
  assert.match(helperScript, /"sender_id", "created_at", "id"/);
  assert.match(helperScript, /MESSAGES_SENDER_INDEX_STATEMENT_TIMEOUT/);
  assert.match(helperScript, /MESSAGES_SENDER_INDEX_LOCK_TIMEOUT/);
  assert.match(helperScript, /indisvalid/);
  assert.match(helperScript, /indisready/);

  const createScript = await readServerFile(
    "scripts/create-messages-sender-index.ts",
  );
  assert.match(createScript, /set_config\('statement_timeout'/);
  assert.match(createScript, /set_config\('lock_timeout'/);
});

test("PGlite builds the sender index for local and test DBs", async () => {
  const pgliteMigrations = await readServerFile("src/db/pgliteMigrations.ts");

  assert.match(
    pgliteMigrations,
    /CREATE INDEX IF NOT EXISTS "idx_messages_sender_created_at"/,
  );
  assert.doesNotMatch(pgliteMigrations, /CONCURRENTLY/);
});
