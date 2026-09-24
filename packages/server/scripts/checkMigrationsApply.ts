// Runtime migration-apply check: applies EVERY migration to a fresh in-memory
// pglite database and asserts they all execute cleanly and materialize a schema.
//
// WHY THIS EXISTS:
// `check-migrations.yml` validates migrations STATICALLY (journal ordering +
// `drizzle-kit generate` shows no drift between schema.ts and the migration
// files). That catches "schema changed but migration not regenerated", but it
// does NOT catch a migration whose SQL fails to APPLY (bad custom SQL, a data
// migration bug, an ordering hazard between statements). Runtime apply-validity
// used to be covered implicitly by the server unit tests, whose pglite setup
// runs `migratePglite` before every suite. Those tests now run only on
// push:staging + the daily cron (CI cost — see test.yml), so this standalone
// check keeps migration *apply validity* on every migration-touching PR.
//
// It mirrors production's apply path exactly: db/index.ts does
// `new PGlite(...)` then `migratePglite(_pglite)`. A bare `new PGlite()` is an
// ephemeral in-memory DB, so this is seconds-fast and needs no external service.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { migratePglite } from "../src/db/pgliteMigrations.js";

const DRIZZLE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../drizzle",
);

function splitStatements(sqlText: string): string[] {
  return sqlText
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function verifySecondAgentBackfillFixture() {
  const client = new PGlite();
  try {
    // Keep this fixture aligned with the database schema, not the Drizzle
    // application model: product_events.id intentionally has no DB default.
    // A prior one-off harness incorrectly added DEFAULT gen_random_uuid(),
    // which masked a missing id in migration 0186 on non-empty databases.
    await client.exec(`
      CREATE TABLE agents (
        id uuid PRIMARY KEY,
        server_id uuid NOT NULL,
        creator_type text,
        creator_id uuid,
        created_at timestamptz NOT NULL,
        deleted_at timestamptz
      );
      CREATE TABLE product_events (
        id uuid PRIMARY KEY,
        subject_type text NOT NULL,
        subject_id uuid NOT NULL,
        event_type text NOT NULL,
        actor_type text,
        actor_id uuid,
        occurred_at timestamptz NOT NULL DEFAULT now(),
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        schema_version integer NOT NULL DEFAULT 1,
        source text,
        idempotency_key text,
        CONSTRAINT product_events_subject_type_whitelist
          CHECK (subject_type IN ('action_card', 'onboarding_wizard')),
        CONSTRAINT product_events_event_type_whitelist
          CHECK (event_type IN ('action_card.open', 'onboarding_wizard.completed')),
        CONSTRAINT product_events_actor_type_valid
          CHECK (actor_type IS NULL OR actor_type IN ('human', 'agent', 'system'))
      );
      CREATE UNIQUE INDEX idx_product_events_idempotency
        ON product_events(subject_id, event_type, idempotency_key)
        WHERE idempotency_key IS NOT NULL;

      INSERT INTO agents VALUES
        ('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'user', '20000000-0000-4000-8000-000000000001', '2026-05-01T00:00:00Z', NULL),
        ('00000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'user', '20000000-0000-4000-8000-000000000001', '2026-05-02T00:00:00Z', '2026-05-03T00:00:00Z'),
        ('00000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'user', '20000000-0000-4000-8000-000000000001', '2026-05-04T00:00:00Z', NULL),
        ('00000000-0000-4000-8000-000000000011', '10000000-0000-4000-8000-000000000002', NULL, NULL, '2026-03-01T00:00:00Z', NULL),
        ('00000000-0000-4000-8000-000000000012', '10000000-0000-4000-8000-000000000002', NULL, NULL, '2026-03-02T00:00:00Z', NULL),
        ('00000000-0000-4000-8000-000000000021', '10000000-0000-4000-8000-000000000003', 'user', '20000000-0000-4000-8000-000000000003', '2026-06-01T00:00:00Z', NULL),
        ('00000000-0000-4000-8000-000000000022', '10000000-0000-4000-8000-000000000003', 'agent', '00000000-0000-4000-8000-000000000021', '2026-06-02T00:00:00Z', NULL);
    `);

    const defaultResult = await client.query<{ column_default: string | null }>(
      `SELECT column_default
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'product_events'
          AND column_name = 'id'`,
    );
    if (defaultResult.rows[0]?.column_default !== null) {
      throw new Error("second-agent fixture must keep product_events.id without a DB default");
    }

    const sqlText = await readFile(
      path.join(DRIZZLE_DIR, "0186_kind_onslaught.sql"),
      "utf8",
    );
    const statements = splitStatements(sqlText);
    // Apply twice: the first pass must emit the exact eligible row with a
    // generated id; the retry must be a no-op under the partial unique index.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      for (const statement of statements) await client.exec(statement);
    }

    const events = await client.query<{
      rows: number;
      distinct_ids: number;
      subject_id: string;
      actor_id: string;
      agent_id: string;
      capture_mode: string;
    }>(`
      SELECT count(*)::int AS rows,
             count(DISTINCT id)::int AS distinct_ids,
             min(subject_id::text) AS subject_id,
             min(actor_id::text) AS actor_id,
             min(metadata->>'agent_id') AS agent_id,
             min(metadata->>'capture_mode') AS capture_mode
        FROM product_events
       WHERE event_type = 'agent.second_created'
    `);
    const row = events.rows[0];
    if (
      row?.rows !== 1 ||
      row.distinct_ids !== 1 ||
      row.subject_id !== "10000000-0000-4000-8000-000000000001" ||
      row.actor_id !== "20000000-0000-4000-8000-000000000001" ||
      row.agent_id !== "00000000-0000-4000-8000-000000000002" ||
      row.capture_mode !== "backfill"
    ) {
      throw new Error(`second-agent migration fixture mismatch: ${JSON.stringify(row)}`);
    }
  } finally {
    await client.close();
  }
}

async function verifyAgentMigrationSupportRefBackfillFixture() {
  const client = new PGlite();
  try {
    await client.exec(`
      CREATE TABLE users (id uuid PRIMARY KEY);
      CREATE TABLE agent_migrations (
        id uuid PRIMARY KEY,
        agent_id uuid NOT NULL,
        state text NOT NULL
      );
      CREATE UNIQUE INDEX idx_agent_migrations_active_agent
        ON agent_migrations(agent_id)
        WHERE state IN ('provisioning', 'prep', 'ready', 'in_transit', 'arriving', 'starting');
      INSERT INTO agent_migrations (id, agent_id, state) VALUES
        ('00000000-0000-4000-8000-000000000101', '10000000-0000-4000-8000-000000000101', 'completed'),
        ('00000000-0000-4000-8000-000000000102', '10000000-0000-4000-8000-000000000102', 'failed');
    `);

    const sqlText = await readFile(
      path.join(DRIZZLE_DIR, "0219_jittery_spiral.sql"),
      "utf8",
    );
    for (const statement of splitStatements(sqlText)) await client.exec(statement);

    const refs = await client.query<{ support_ref: string }>(`
      SELECT support_ref
        FROM agent_migrations
       ORDER BY id
    `);
    if (
      refs.rows.length !== 2
      || refs.rows.some((row) => !/^mig_[A-Za-z0-9_-]{22}$/.test(row.support_ref))
      || new Set(refs.rows.map((row) => row.support_ref)).size !== refs.rows.length
    ) {
      throw new Error(`agent migration support-ref backfill mismatch: ${JSON.stringify(refs.rows)}`);
    }
    const metadata = await client.query<{ is_nullable: string }>(`
      SELECT is_nullable
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'agent_migrations'
         AND column_name = 'support_ref'
    `);
    if (metadata.rows[0]?.is_nullable !== "NO") {
      throw new Error("agent migration support_ref must be NOT NULL after retained-row backfill");
    }
  } finally {
    await client.close();
  }
}

async function main() {
  const journal = JSON.parse(
    await readFile(path.join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8"),
  ) as { entries: unknown[] };
  const expectedCount = journal.entries.length;

  // Fresh ephemeral DB — same apply path as production (db/index.ts).
  const client = new PGlite();
  // Throws if any migration's SQL statement fails to execute.
  await migratePglite(client);

  const applied = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM "__drizzle_migrations"`,
  );
  const appliedCount = applied.rows[0]?.n ?? 0;
  const tables = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name <> '__drizzle_migrations'`,
  );
  const tableCount = tables.rows[0]?.n ?? 0;
  await client.close();

  await verifySecondAgentBackfillFixture();
  await verifyAgentMigrationSupportRefBackfillFixture();

  if (appliedCount !== expectedCount) {
    console.error(
      `✗ Applied ${appliedCount} migrations but the journal lists ${expectedCount}.`,
    );
    process.exit(1);
  }
  if (tableCount < 1) {
    console.error("✗ Migrations applied but no tables materialized.");
    process.exit(1);
  }
  console.log(
    `✓ All ${expectedCount} migrations applied cleanly to a fresh DB; ${tableCount} tables materialized.`,
  );
  console.log(
    "✓ Migration 0186 emitted one eligible row without a DB id default and remained idempotent on retry.",
  );
  console.log(
    "✓ Migration 0219 backfilled distinct support refs for retained migration rows before enforcing NOT NULL.",
  );
}

main().catch((err) => {
  console.error("✗ Migration apply check failed:", err);
  process.exit(1);
});
