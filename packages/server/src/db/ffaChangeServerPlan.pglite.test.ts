import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { test } from "vitest";
import type { ServerPlan } from "@botiverse/raft-shared";
import type { Database, DatabaseTransaction } from "./index";
import {
  FEATURE_FLAG_ADMIN_OPERATOR_ROLE,
  reconcileAndVerifyFeatureFlagAdminPrivileges,
} from "./featureFlagAdminPrivileges";
import { migratePglite } from "./pgliteMigrations";
import * as schema from "./schema";
import {
  appSumoLicenseBindings,
  appSumoLicenses,
  prepaidProPurchases,
  servers,
  subscriptions,
  users,
} from "./schema";
import type { AppSumoLicenseKey } from "../services/appSumoContracts";
import { projectPaidSourceServerPlan } from "../services/appSumoLifecycleService";
import { getServerBillingEntitlement } from "../services/planService";
import { assertBoundedLockTimeout } from "../test/migrationLockTimeout";

const MIGRATION_SQL = readFileSync(
  new URL("../../drizzle/0724_ffa_server_plan_change.sql", import.meta.url),
  "utf8",
);

const PLANS: readonly ServerPlan[] = ["free", "founder", "partner", "pro"];

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

const SIGNATURE = "public.ffa_change_server_plan(text, text, text, text, text, text, text, text, text, text, text)";

test("0724 migration: 2s lock timeout, static SECURITY DEFINER SQL, database clock only, plan values match schema.ts", () => {
  const [firstChunk] = MIGRATION_SQL.split("--> statement-breakpoint");
  assertBoundedLockTimeout(
    (firstChunk ?? "").split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n").trim(),
    "0724 first executable statement",
    { maxMs: 2_000 },
  );
  const body = /\$ffa_change_server_plan\$([\s\S]*?)\$ffa_change_server_plan\$/.exec(MIGRATION_SQL)?.[1] ?? "";
  assert.ok(body, "expected $ffa_change_server_plan$ body");
  assert.equal(/\bEXECUTE\b/i.test(body), false, "function body must contain zero dynamic SQL");
  assert.match(MIGRATION_SQL, /SECURITY DEFINER/);
  assert.match(MIGRATION_SQL, /SET search_path = pg_catalog, public, pg_temp/);
  // No caller-supplied time: the granted signature has no timestamp argument, and the body uses now().
  assert.equal(SIGNATURE.includes("timestamp"), false);
  const header = /CREATE OR REPLACE FUNCTION public\.ffa_change_server_plan\(([\s\S]*?)\) RETURNS/.exec(MIGRATION_SQL)?.[1] ?? "";
  assert.equal(/timestamp|p_now/i.test(header), false, "no time parameter");
  assert.equal(/p_now/.test(body), false);
  assert.match(body, /p\.ends_at > \(pg_catalog\.now\(\) - interval '3 days'\)/);
  assert.match(MIGRATION_SQL, new RegExp(`GRANT EXECUTE ON FUNCTION ${SIGNATURE.replace(/[()]/g, "\\$&")} TO feature_flag_admin_operator`));
  // The only UPDATE writes the servers row the way a billing downgrade does, and nothing else.
  const updates = body.match(/UPDATE\s+[\s\S]*?;/g) ?? [];
  assert.equal(updates.length, 1);
  assert.match(
    updates[0]!,
    /^UPDATE public\.servers\s+SET plan = p_plan,\s+plan_downgraded_at = CASE WHEN p_plan = 'free' THEN pg_catalog\.now\(\) ELSE NULL END,\s+updated_at = pg_catalog\.now\(\)\s+WHERE id = v_server_id\s+AND plan = p_expected_plan/,
  );
  // The only other write is the Raft-side audit row.
  const inserts = body.match(/INSERT INTO\s+\S+/g) ?? [];
  assert.deepEqual(inserts, ["INSERT INTO public.integration_audit_events"]);
  assert.equal(/\bDELETE\b/i.test(body), false, "function deletes nothing");
  const planValues = servers.plan.enumValues as readonly string[];
  assert.deepEqual([...planValues].sort(), [...PLANS].sort());
  for (const plan of planValues) assert.match(body, new RegExp(`'${plan}'`));
});

test("ffa_change_server_plan: compare-and-set on plan only, refused while a paid source is live, never overwritten by paid-source writers", async () => {
  const pg = new PGlite();
  try {
    await migratePglite(pg);
    await pg.query(`CREATE ROLE ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE} NOLOGIN`);
    await pg.query("CREATE ROLE ffa_unprivileged_probe NOLOGIN");
    await reconcileAndVerifyFeatureFlagAdminPrivileges(
      async (text, values) => pg.query<Record<string, unknown>>(text, values),
    );
    const db = drizzle(pg, { schema }) as unknown as Database;
    // The function reads the database clock, so fixtures are relative to the real time.
    const now = new Date();
    const day = 24 * 60 * 60 * 1000;
    const ownerId = uuid(1);
    await db.insert(users).values({ id: ownerId, email: "owner@example.com", name: "owner", passwordHash: "x" });

    const ACTOR_ID = "44444444-5555-4666-8777-888888888888";
    const args = (slug: string, expected: string, plan: string, overrides: Partial<Record<"reason" | "actorType" | "actorId" | "approvedBy" | "approvalMessageId", string | null>> = {}) => [
      slug, expected, plan,
      overrides.reason !== undefined ? overrides.reason : "Founder deal",
      overrides.actorType !== undefined ? overrides.actorType : "human",
      overrides.actorId !== undefined ? overrides.actorId : ACTOR_ID,
      "Operator",
      overrides.approvedBy !== undefined ? overrides.approvedBy : "cindyz: yes, set it",
      overrides.approvalMessageId !== undefined ? overrides.approvalMessageId : "c0ffee12",
      `req-${slug}`,
      `ffa-audit-${slug}`,
    ];
    const change = async (
      slug: string, expected: string, plan: string,
      role = FEATURE_FLAG_ADMIN_OPERATOR_ROLE,
      overrides: Parameters<typeof args>[3] = {},
    ) => {
      await pg.query(`SET ROLE ${role}`);
      try {
        const res = await pg.query<{ result: Record<string, unknown> }>(
          "SELECT public.ffa_change_server_plan($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) AS result",
          args(slug, expected, plan, overrides),
        );
        return res.rows[0]!.result;
      } finally {
        await pg.query("RESET ROLE");
      }
    };
    const auditRows = async (serverId: string) => (await pg.query<Record<string, any>>(
      "SELECT * FROM integration_audit_events WHERE server_id = $1 ORDER BY created_at",
      [serverId],
    )).rows;
    const snapshot = async () => JSON.stringify(await Promise.all([
      pg.query("SELECT * FROM integration_audit_events ORDER BY id"),
      pg.query("SELECT * FROM servers ORDER BY id"),
      pg.query("SELECT * FROM subscriptions ORDER BY id"),
      pg.query("SELECT * FROM appsumo_licenses ORDER BY license_key"),
      pg.query("SELECT * FROM appsumo_license_bindings ORDER BY id"),
      pg.query("SELECT * FROM prepaid_pro_purchases ORDER BY id"),
    ].map(async (q) => (await q).rows)));

    let next = 10;
    const makeServer = async (slug: string, plan: ServerPlan, extra: Partial<typeof servers.$inferInsert> = {}) => {
      const id = uuid(next++);
      await db.insert(servers).values({ id, name: slug, slug, ownerId, plan, ...extra });
      return id;
    };

    // Privilege boundary: PUBLIC cannot execute it; the operator still cannot UPDATE servers directly.
    await makeServer("airwing", "free");
    await assert.rejects(change("airwing", "free", "founder", "ffa_unprivileged_probe"),
      (err: unknown) => (err as { code?: string }).code === "42501");
    await pg.query(`SET ROLE ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
    try {
      await assert.rejects(pg.query("UPDATE servers SET plan = 'founder' WHERE slug = 'airwing'"),
        (err: unknown) => (err as { code?: string }).code === "42501");
    } finally {
      await pg.query("RESET ROLE");
    }
    // Arguments are validated against the schema.ts plan values.
    await assert.rejects(change("airwing", "free", "max"), (err: unknown) => (err as { code?: string }).code === "22023");
    await assert.rejects(change("airwing", "business", "pro"), (err: unknown) => (err as { code?: string }).code === "22023");
    // Operator, reason and approval are mandatory.
    for (const overrides of [
      { approvedBy: null }, { approvedBy: " " }, { approvalMessageId: null }, { approvalMessageId: "ab" },
      { reason: "" }, { actorType: "system" }, { actorId: "" },
    ]) {
      await assert.rejects(change("airwing", "free", "founder", FEATURE_FLAG_ADMIN_OPERATOR_ROLE, overrides),
        (err: unknown) => (err as { code?: string }).code === "22023", JSON.stringify(overrides));
    }
    // There is no time argument to pass: the old (…, timestamptz) signature does not exist.
    await assert.rejects(
      pg.query("SELECT public.ffa_change_server_plan('airwing', 'free', 'founder', now())"),
      (err: unknown) => (err as { code?: string }).code === "42883",
    );

    // Compare-and-set: a wrong expected plan writes nothing.
    let before = await snapshot();
    assert.deepEqual(await change("airwing", "pro", "founder"), {
      outcome: "plan_mismatch", server_id: uuid(10), server_slug: "airwing", before_plan: "free", plan: "free",
    });
    assert.equal(await snapshot(), before);
    // Unknown, soft-deleted and joint-storage servers are not found.
    assert.equal((await change("no-such-server", "free", "founder")).outcome, "not_found");
    await makeServer("gone", "free", { deletedAt: new Date("2026-11-01T00:00:00Z") });
    assert.equal((await change("gone", "free", "founder")).outcome, "not_found");
    await makeServer("joint", "free", { kind: "joint_storage" });
    assert.equal((await change("joint", "free", "founder")).outcome, "not_found");

    // The airwing case: plan (and the fields a billing upgrade writes) change, one audit row, readback.
    await pg.query("UPDATE servers SET plan_downgraded_at = now() - interval '2 days' WHERE slug = 'airwing'");
    const airwingBefore = (await pg.query<Record<string, unknown>>("SELECT * FROM servers WHERE slug = 'airwing'")).rows[0]!;
    assert.equal((await auditRows(uuid(10))).length, 0);
    const updated = await change("airwing", "free", "founder");
    assert.deepEqual(updated, {
      outcome: "updated", server_id: uuid(10), server_slug: "airwing", before_plan: "free", plan: "founder", plan_downgraded_at: null,
    });
    const airwingAfter = (await pg.query<Record<string, unknown>>("SELECT * FROM servers WHERE slug = 'airwing'")).rows[0]!;
    assert.equal(airwingAfter.plan_downgraded_at, null, "an upgrade clears a pending downgrade, as billing does");
    assert.ok((airwingAfter.updated_at as Date).getTime() > (airwingBefore.updated_at as Date).getTime());
    assert.deepEqual(
      { ...airwingAfter, plan: "free", plan_downgraded_at: airwingBefore.plan_downgraded_at, updated_at: airwingBefore.updated_at },
      airwingBefore,
      "only plan, plan_downgraded_at and updated_at changed",
    );
    assert.equal((await getServerBillingEntitlement(db, uuid(10), now)).plan, "founder");
    const [audit, ...extra] = await auditRows(uuid(10));
    assert.equal(extra.length, 0, "exactly one audit row for one change");
    assert.equal(audit.event_type, "server.plan_changed");
    assert.equal(audit.event_category, "server_profile");
    assert.equal(audit.outcome, "success");
    assert.equal(audit.actor_type, "human");
    assert.equal(audit.actor_id, ACTOR_ID);
    assert.equal(audit.target_type, "server");
    assert.equal(audit.target_id, uuid(10));
    assert.equal(audit.request_id, "req-airwing");
    assert.equal(audit.correlation_id, "ffa-audit-airwing");
    assert.deepEqual(audit.diff, { plan: { before: "free", after: "founder" } });
    assert.deepEqual(audit.metadata, {
      serverSlug: "airwing", fromPlan: "free", toPlan: "founder", planDowngradedAt: null, reason: "Founder deal",
      actorId: ACTOR_ID, actorName: "Operator", approvedBy: "cindyz: yes, set it", approvalMessageId: "c0ffee12",
      via: "feature-flag-admin",
    });
    // Same plan again: a no-op, nothing written, no audit row.
    before = await snapshot();
    assert.equal((await change("airwing", "founder", "founder")).outcome, "unchanged");
    assert.equal(await snapshot(), before);
    assert.equal((await auditRows(uuid(10))).length, 1);

    // Downgrade to free is a real downgrade: plan_downgraded_at = now(), which the enforcement
    // (plan = free AND plan_downgraded_at older than DOWNGRADE_GRACE_PERIOD_DAYS) acts on.
    const downgraded = await change("airwing", "founder", "free", FEATURE_FLAG_ADMIN_OPERATOR_ROLE, { actorType: "agent", actorId: "agent-1" });
    assert.equal(downgraded.outcome, "updated");
    const dbNow = (await pg.query<{ now: Date }>("SELECT now() AS now")).rows[0]!.now;
    const afterDowngrade = (await pg.query<{ plan: string; plan_downgraded_at: Date }>(
      "SELECT plan, plan_downgraded_at FROM servers WHERE slug = 'airwing'",
    )).rows[0]!;
    assert.equal(afterDowngrade.plan, "free");
    assert.ok(afterDowngrade.plan_downgraded_at instanceof Date);
    assert.ok(Math.abs(afterDowngrade.plan_downgraded_at.getTime() - dbNow.getTime()) < 60_000, "set from the database clock");
    assert.equal(new Date(String(downgraded.plan_downgraded_at)).getTime(), afterDowngrade.plan_downgraded_at.getTime());
    const downgradeAudits = await auditRows(uuid(10));
    assert.equal(downgradeAudits.length, 2);
    const downgradeAudit = downgradeAudits.find((row) => row.metadata.toPlan === "free")!;
    assert.equal(downgradeAudit.actor_type, "agent");
    assert.equal(downgradeAudit.actor_id, null, "a non-uuid principal id stays in metadata only");
    assert.equal(downgradeAudit.metadata.actorId, "agent-1");
    assert.equal(downgradeAudit.metadata.fromPlan, "founder");

    // Every combination of current plan x paid source x target plan.
    type Source = "none" | "sub_active" | "sub_past_due" | "sub_incomplete" | "sub_canceled" | "appsumo" | "appsumo_inactive" | "prepaid" | "prepaid_queued" | "prepaid_lapsed";
    const sources: Source[] = ["none", "sub_active", "sub_past_due", "sub_incomplete", "sub_canceled", "appsumo", "appsumo_inactive", "prepaid", "prepaid_queued", "prepaid_lapsed"];
    const blocking = new Set<Source>(["sub_active", "sub_past_due", "sub_incomplete", "appsumo", "prepaid", "prepaid_queued"]);
    let n = 0;
    for (const source of sources) {
      for (const current of PLANS) {
        for (const target of PLANS) {
          if (current === target) continue;
          n += 1;
          const slug = `case-${n}`;
          const serverId = await makeServer(slug, current);
          if (source.startsWith("sub_")) {
            await db.insert(subscriptions).values({
              id: uuid(next++), serverId, plan: "pro", status: source.slice(4) as "active",
              stripeCustomerId: `cus_${n}`, stripeSubscriptionId: `sub_${n}`,
            });
          } else if (source.startsWith("appsumo")) {
            const licenseKey = uuid(next++) as AppSumoLicenseKey;
            await db.insert(appSumoLicenses).values({
              productId: "raft_appsumo", licenseKey, tier: 2,
              status: source === "appsumo" ? "active" : "inactive", verifiedAt: new Date("2026-10-01T00:00:00Z"),
            });
            await db.insert(appSumoLicenseBindings).values({
              id: uuid(next++), serverId, productId: "raft_appsumo", originalLicenseKey: licenseKey, currentLicenseKey: licenseKey,
            });
          } else if (source.startsWith("prepaid")) {
            const [startsAt, endsAt] = source === "prepaid"
              ? [now.getTime() - 10 * day, now.getTime() + 20 * day]
              : source === "prepaid_queued"
                ? [now.getTime() + 5 * day, now.getTime() + 35 * day]
                : [now.getTime() - 40 * day, now.getTime() - 4 * day];
            await db.insert(prepaidProPurchases).values({
              id: uuid(next++), serverId, kind: "period", months: 1, seatQuantity: 1,
              startsAt: new Date(startsAt), endsAt: new Date(endsAt), status: "paid",
              stripeCheckoutSessionId: `cs_${n}`, amountTotal: 2000, currency: "usd",
            });
          }

          before = await snapshot();
          const result = await change(slug, current, target);
          const audits = await auditRows(serverId);
          const label = `${source}: ${current} -> ${target}`;
          if (blocking.has(source)) {
            assert.equal(result.outcome, "paid_source_active", label);
            assert.equal(await snapshot(), before, `${label}: nothing written`);
            assert.equal(audits.length, 0, `${label}: no audit row`);
            continue;
          }
          if (target === "pro") {
            // pro is a paid-source projection: without a live source the next projection writes free back.
            assert.equal(result.outcome, "pro_owned_by_paid_sources", label);
            assert.equal(await snapshot(), before, `${label}: nothing written`);
            assert.equal(audits.length, 0, `${label}: no audit row`);
            continue;
          }
          assert.equal(result.outcome, "updated", label);
          assert.equal(result.plan, target, label);
          assert.equal(audits.length, 1, `${label}: one audit row`);
          assert.deepEqual([audits[0].metadata.fromPlan, audits[0].metadata.toPlan], [current, target], label);
          const row = (await pg.query<{ plan_downgraded_at: Date | null }>("SELECT plan_downgraded_at FROM servers WHERE id = $1", [serverId])).rows[0]!;
          assert.equal(row.plan_downgraded_at !== null, target === "free", `${label}: plan_downgraded_at iff free`);
          // What every billing reader resolves is the plan that was set.
          assert.equal((await getServerBillingEntitlement(db, serverId, now)).plan, target, `${label}: effective plan`);
          // A later Stripe/AppSumo/prepaid projection for this server (all of them call or mirror
          // projectPaidSourceServerPlan under the row lock) does not undo it.
          await db.transaction(async (tx) => projectPaidSourceServerPlan(tx as unknown as DatabaseTransaction, serverId, now));
          assert.equal(
            (await pg.query<{ plan: string }>("SELECT plan FROM servers WHERE id = $1", [serverId])).rows[0]!.plan,
            target,
            `${label}: paid-source projection keeps it`,
          );
        }
      }
    }
  } finally {
    await pg.close();
  }
});
