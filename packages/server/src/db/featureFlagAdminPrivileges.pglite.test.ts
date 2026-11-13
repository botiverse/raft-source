import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { test } from "vitest";
import { FEATURE_FLAG_ADMIN_OPERATOR_ROLE, reconcileAndVerifyFeatureFlagAdminPrivileges } from "./featureFlagAdminPrivileges";
import { migratePglite } from "./pgliteMigrations";

// Feature Flag Admin edits server_guest_v0 as its own role, which has no
// privilege on change_log. The guest access trigger (0458) logs the change as
// its owner (0583), so the edit succeeds and the reset still reaches sync.
// The production migration chain on a fresh PGlite, then the production grants.

const guestAccessRows = async (pg: PGlite) =>
  (await pg.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM public.change_log WHERE entity = 'guest_access' AND entity_id = 'server_guest_v0' AND op = 'reset'",
  )).rows[0]?.n;

test("as feature_flag_admin_operator, a server_guest_v0 rule write logs one guest_access reset and needs no change_log privilege", async () => {
  const pg = new PGlite();
  try {
    await migratePglite(pg);
    await pg.query(`CREATE ROLE ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE} NOLOGIN`);
    await reconcileAndVerifyFeatureFlagAdminPrivileges(async (text, values) => pg.query<Record<string, unknown>>(text, values));
    const before = await guestAccessRows(pg);
    const ruleId = randomUUID();
    await pg.query(`SET ROLE ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
    try {
      await pg.query(
        "INSERT INTO public.feature_flag_rules (id, flag_key, stage, decision, values) VALUES ($1, 'server_guest_v0', 'server', 'allow', '[]'::jsonb)",
        [ruleId],
      );
    } finally {
      await pg.query("RESET ROLE");
    }
    assert.equal(await guestAccessRows(pg), (before ?? 0) + 1);

    await pg.query(`SET ROLE ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
    try {
      await pg.query("UPDATE public.feature_flag_rules SET decision = 'deny' WHERE id = $1", [ruleId]);
    } finally {
      await pg.query("RESET ROLE");
    }
    assert.equal(await guestAccessRows(pg), (before ?? 0) + 2);

    // Still no change_log privilege of its own, nor EXECUTE on the definer function.
    const { rows: [grant] } = await pg.query<{ insert: boolean; execute: boolean }>(
      `SELECT pg_catalog.has_table_privilege($1, 'public.change_log', 'INSERT') AS insert,
              pg_catalog.has_function_privilege($1, 'public.change_log_guest_access_fn()', 'EXECUTE') AS execute`,
      [FEATURE_FLAG_ADMIN_OPERATOR_ROLE],
    );
    assert.deepEqual(grant, { insert: false, execute: false });
  } finally {
    await pg.close();
  }
});
