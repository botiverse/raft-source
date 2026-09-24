import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "vitest";

const SERVER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
// Asserts on private CI/deploy files that the source-available snapshot does not
// carry; skipped when an exported snapshot's RELEASE_SOURCE marker is present.
const inSourceSnapshot = existsSync(path.resolve(SERVER_ROOT, "../../RELEASE_SOURCE"));

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

test.skipIf(inSourceSnapshot)("server package exposes concurrent create and verify scripts", async () => {
  const packageJson = JSON.parse(await readServerFile("package.json"));
  assert.equal(
    packageJson.scripts["db:create-message-random-id-index"],
    "tsx scripts/create-message-random-id-index.ts",
  );
  assert.equal(
    packageJson.scripts["db:verify-message-random-id-index"],
    "tsx scripts/verify-message-random-id-index.ts",
  );

  const helperScript = await readServerFile(
    "scripts/message-random-id-index.ts",
  );
  assert.match(
    helperScript,
    /CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "\$\{RANDOM_ID_INDEX_NAME\}"/,
  );
  assert.match(helperScript, /MESSAGE_RANDOM_ID_INDEX_STATEMENT_TIMEOUT/);
  assert.match(helperScript, /MESSAGE_RANDOM_ID_INDEX_LOCK_TIMEOUT/);
  assert.match(helperScript, /indisvalid/);
  assert.match(helperScript, /indisready/);

  const createScript = await readServerFile(
    "scripts/create-message-random-id-index.ts",
  );
  assert.match(createScript, /set_config\('statement_timeout'/);
  assert.match(createScript, /set_config\('lock_timeout'/);

  const postSteps = JSON.parse(
    await readFile(
      path.join(
        SERVER_ROOT,
        "../../scripts/deploy/aws-server-post-migration-steps.json",
      ),
      "utf8",
    ),
  );
  assert.deepEqual(postSteps, [
    {
      name: "Create message random_id unique index",
      command: [
        "pnpm",
        "--filter",
        "@botiverse/raft-server",
        "db:create-message-random-id-index",
      ],
    },
    {
      name: "Verify message random_id unique index",
      command: [
        "pnpm",
        "--filter",
        "@botiverse/raft-server",
        "db:verify-message-random-id-index",
      ],
    },
    {
      name: "Verify inbox serving receiver/server/activity index",
      command: [
        "pnpm",
        "--filter",
        "@botiverse/raft-server",
        "db:verify-inbox-serving-rows-receiver-server-index",
      ],
    },
    {
      name: "Create messages sender/created_at index",
      command: [
        "pnpm",
        "--filter",
        "@botiverse/raft-server",
        "db:create-messages-sender-index",
      ],
    },
    {
      name: "Verify messages sender/created_at index",
      command: [
        "pnpm",
        "--filter",
        "@botiverse/raft-server",
        "db:verify-messages-sender-index",
      ],
    },
  ]);
});

test("PGlite keeps random_id replay semantics for local and test DBs", async () => {
  const pgliteMigrations = await readServerFile("src/db/pgliteMigrations.ts");

  assert.match(
    pgliteMigrations,
    /CREATE UNIQUE INDEX IF NOT EXISTS "idx_messages_user_random_id"/,
  );
  assert.doesNotMatch(pgliteMigrations, /CONCURRENTLY/);
  assert.match(
    pgliteMigrations,
    /CREATE INDEX IF NOT EXISTS "idx_inbox_serving_rows_receiver_server_last_activity"/,
  );
});
