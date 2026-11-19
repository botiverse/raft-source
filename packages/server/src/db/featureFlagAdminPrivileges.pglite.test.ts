import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { test } from "vitest";
import { FEATURE_FLAG_ADMIN_OPERATOR_ROLE, reconcileAndVerifyFeatureFlagAdminPrivileges } from "./featureFlagAdminPrivileges";
import { migratePglite } from "./pgliteMigrations";

// Feature Flag Admin edits flags as its own role, which has no privilege on
// change_log. server_guest_v0 is retired: its guest_access trigger (0458,
// definer rights since 0583) is dropped, so an edit of that flag's rules
// still succeeds and logs nothing.
// The production migration chain on a fresh PGlite, then the production grants.

const guestAccessRows = async (pg: PGlite) =>
  (await pg.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM public.change_log WHERE entity = 'guest_access' AND op = 'reset'",
  )).rows[0]?.n;

test("as feature_flag_admin_operator, a rule write on the retired guest flag succeeds, logs no guest_access reset, and needs no change_log privilege", async () => {
  const pg = new PGlite();
  try {
    await migratePglite(pg);
    await pg.query(`CREATE ROLE ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE} NOLOGIN`);
    await reconcileAndVerifyFeatureFlagAdminPrivileges(async (text, values) => pg.query<Record<string, unknown>>(text, values));
    const before = await guestAccessRows(pg);
    const ruleId = randomUUID();
    await pg.query(`SET ROLE ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
    try {
      // The flag row is still seeded (0253); only its trigger is gone.
      await pg.query(
        "INSERT INTO public.feature_flag_rules (id, flag_key, stage, decision, values) VALUES ($1, 'server_guest_v0', 'server', 'allow', '[]'::jsonb)",
        [ruleId],
      );
      await pg.query("UPDATE public.feature_flag_rules SET decision = 'deny' WHERE id = $1", [ruleId]);
      await pg.query("UPDATE public.feature_flags SET kill_switch = NOT kill_switch WHERE key = 'server_guest_v0'");
    } finally {
      await pg.query("RESET ROLE");
    }
    assert.equal(await guestAccessRows(pg), before, "the retired guest flag logs no guest_access reset");

    const { rows: [leftovers] } = await pg.query<{ triggers: number; fn: string | null }>(
      `SELECT (SELECT count(*)::int FROM pg_catalog.pg_trigger WHERE tgname LIKE 'change_log_guest_access%') AS triggers,
              pg_catalog.to_regprocedure('public.change_log_guest_access_fn()')::text AS fn`,
    );
    assert.deepEqual(leftovers, { triggers: 0, fn: null });

    // Still no change_log privilege of its own.
    const { rows: [grant] } = await pg.query<{ insert: boolean }>(
      "SELECT pg_catalog.has_table_privilege($1, 'public.change_log', 'INSERT') AS insert",
      [FEATURE_FLAG_ADMIN_OPERATOR_ROLE],
    );
    assert.deepEqual(grant, { insert: false });
  } finally {
    await pg.close();
  }
});
