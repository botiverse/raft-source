/** Focused tests for how raftdev builds its Postgres: the production migration path. */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  classifyDevDatabaseSchema,
  DEV_MIGRATION_PHASE_FIELDS,
  DEV_MIGRATION_RETRY_FIELDS,
  DEV_SKIPPED_DEPLOY_STEPS,
  devMigrationEnv,
  devMigrationSteps,
  PROJECT_DIR,
} from "./raftdev";
import { POST_MIGRATION_INDEXES } from "../../packages/server/src/db/postMigrationIndexes";

const packageScripts = (JSON.parse(
  readFileSync(join(PROJECT_DIR, "packages/server/package.json"), "utf8"),
) as { scripts: Record<string, string> }).scripts;
const indexCreateScripts = POST_MIGRATION_INDEXES.map((index) => index.createScript);

const step = (script: string): string => `node --import @oxc-node/core/register ${script}`;
const scriptOf = (command: string): string => command.trim().split(" ").at(-1)!;

test("raftdev runs db:migrate:deploy's migrator and index steps in order, minus the production-only checks", () => {
  const steps = devMigrationSteps(packageScripts, indexCreateScripts);
  assert.equal(steps[0], "scripts/migrate-deploy.ts");
  assert.equal(steps.at(-1), "scripts/verify-post-migration-indexes.ts");
  // A new non-index step in db:migrate:deploy needs a decision: run it
  // locally, or add it to DEV_SKIPPED_DEPLOY_STEPS with the reason.
  for (const script of steps.slice(1, -1)) assert.match(script, /^scripts\/create-[\w-]+\.ts$/);
  for (const skipped of Object.keys(DEV_SKIPPED_DEPLOY_STEPS)) assert.ok(!steps.includes(skipped));
  const deploy = packageScripts["db:migrate:deploy"]!.split("&&").map(scriptOf)
    .filter((script) => !(script in DEV_SKIPPED_DEPLOY_STEPS));
  // The deploy's own steps keep their order.
  assert.deepEqual(steps.filter((script) => deploy.includes(script)), deploy);
  assert.equal(new Set(steps).size, steps.length);
});

test("raftdev builds every post-migration index, including those the deploy leaves to a one-off script", () => {
  const steps = devMigrationSteps(packageScripts, indexCreateScripts);
  for (const name of indexCreateScripts) assert.ok(steps.includes(scriptOf(packageScripts[name]!)), name);
  // Built once by hand in production (postMigrationIndexes.ts); missing from a
  // database built by the deploy steps alone.
  for (const name of ["db:create-message-random-id-index", "db:create-messages-sender-index", "db:create-channels-thread-parent-channel-index"]) {
    assert.ok(indexCreateScripts.includes(name), name);
    assert.ok(!packageScripts["db:migrate:deploy"]!.includes(scriptOf(packageScripts[name]!)), name);
  }
});

const minimalDeploy = [
  "scripts/migration-preflight.ts",
  "scripts/migrate-deploy.ts",
  ...Object.keys(DEV_SKIPPED_DEPLOY_STEPS).filter((script) => script !== "scripts/migration-preflight.ts"),
  "scripts/create-a.ts",
  "scripts/verify-post-migration-indexes.ts",
].map(step).join(" && ");

test("devMigrationSteps inserts the extra index scripts before the check, once each", () => {
  assert.deepEqual(
    devMigrationSteps({
      "db:migrate:deploy": minimalDeploy,
      "db:create-a": step("scripts/create-a.ts"),
      "db:create-b": step("scripts/create-b.ts"),
    }, ["db:create-a", "db:create-b", "db:create-b"]),
    ["scripts/migrate-deploy.ts", "scripts/create-a.ts", "scripts/create-b.ts", "scripts/verify-post-migration-indexes.ts"],
  );
});

test("devMigrationSteps refuses steps it cannot run as a script and notices dropped ones", () => {
  assert.throws(
    () => devMigrationSteps({ "db:migrate:deploy": `${minimalDeploy} && drizzle-kit migrate` }, []),
    /unexpected db:migrate:deploy step: drizzle-kit migrate/,
  );
  assert.throws(
    () => devMigrationSteps({ "db:migrate:deploy": step("scripts/migrate-deploy.ts") }, []),
    /db:migrate:deploy no longer runs scripts\/migration-preflight\.ts/,
  );
  assert.throws(
    () => devMigrationSteps({ "db:migrate:deploy": minimalDeploy }, ["db:create-missing"]),
    /db:create-missing is not a package script/,
  );
});

test("classifyDevDatabaseSchema tells a migrated database from a pushed one", () => {
  assert.equal(classifyDevDatabaseSchema(0, null), "empty");
  assert.equal(classifyDevDatabaseSchema(0, 0), "empty");
  assert.equal(classifyDevDatabaseSchema(180, 512), "migrated");
  // drizzle-kit push builds the tables and never writes migration history.
  assert.equal(classifyDevDatabaseSchema(180, null), "push-built");
  assert.equal(classifyDevDatabaseSchema(180, 0), "push-built");
});

test("a migration step pins the migrations folder and the deploy phase contract, so neither the shell nor packages/server/.env can change them", () => {
  const env = devMigrationEnv({
    PATH: "/bin",
    DATABASE_URL: "postgresql://elsewhere/db",
    MIGRATIONS_FOLDER: "/tmp/other",
    SERVER_MIGRATION_PHASE_CONTRACT_REQUIRED: "true",
    SERVER_MIGRATION_LOCK_SCHEMA: "public",
    SERVER_MIGRATION_RETRY_MAX_ATTEMPTS: "9",
  }, "postgresql://local/slock");
  assert.equal(env.PATH, "/bin");
  assert.equal(env.DATABASE_URL, "postgresql://local/slock");
  // Set, not deleted: `import "dotenv/config"` in the child fills only unset
  // variables, and the migrator's `??` would treat "" as a folder.
  assert.equal(env.MIGRATIONS_FOLDER, join(PROJECT_DIR, "packages/server/drizzle"));
  assert.ok(existsSync(join(env.MIGRATIONS_FOLDER!, "meta/_journal.json")));
  assert.equal(env.SERVER_MIGRATION_PHASE_CONTRACT_REQUIRED, "false");
  for (const name of [...DEV_MIGRATION_PHASE_FIELDS, ...DEV_MIGRATION_RETRY_FIELDS]) {
    assert.equal(env[name], "", name);
  }
  assert.equal(env.POST_MIGRATION_INDEX_GUARD_REQUIRED, "1");
});

test("the pinned phase fields are exactly the ones migrate-deploy.ts refuses without the contract", () => {
  const source = readFileSync(join(PROJECT_DIR, "packages/server/scripts/migrate-deploy.ts"), "utf8");
  const list = source.match(/const phaseContractFields = \[([^\]]*)\]/);
  assert.ok(list, "migrate-deploy.ts no longer declares phaseContractFields");
  const fields = [...list[1]!.matchAll(/"(SERVER_MIGRATION_[A-Z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...DEV_MIGRATION_PHASE_FIELDS].sort(), fields.sort());
  // Every SERVER_MIGRATION_* the deploy migrator reads is pinned.
  const read = new Set(
    [source, readFileSync(join(PROJECT_DIR, "packages/server/src/db/migrateDeploy.ts"), "utf8")]
      .flatMap((text) => [...text.matchAll(/"(SERVER_MIGRATION_[A-Z_]+)"/g)].map((m) => m[1]!)),
  );
  const pinned = new Set<string>([
    "SERVER_MIGRATION_PHASE_CONTRACT_REQUIRED",
    ...DEV_MIGRATION_PHASE_FIELDS,
    ...DEV_MIGRATION_RETRY_FIELDS,
  ]);
  for (const name of read) assert.ok(pinned.has(name), `${name} is read by the migrator but not pinned by devMigrationEnv`);
});
