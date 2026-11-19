import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { test } from "vitest";
import {
  PRO_PREPAID_GRACE_DAYS,
  featureFlagDefaultPolicyFromEnv,
  parseFfaServerPlanEntitlementInputs,
  resolveEffectiveServerBillingPlan,
  type ServerPlan,
} from "@botiverse/raft-shared";
import {
  evaluateFeatureFlagRow,
  type FeatureFlagRowInput,
  type FeatureFlagRuleRowInput,
} from "@botiverse/raft-shared/feature-flag-evaluation";
import type { Database } from "./index";
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
import { getServerBillingEntitlement, getServerBillingEntitlements } from "../services/planService";
import { assertBoundedLockTimeout } from "../test/migrationLockTimeout";

const MIGRATION_SQL = readFileSync(
  new URL("../../drizzle/0716_ffa_server_plan_entitlement_inputs.sql", import.meta.url),
  "utf8",
);

function stripLeadingLineComments(sqlText: string): string {
  return sqlText
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .trim();
}

function deterministicUuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function createMulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("0716 migration enforces a 2s lock timeout, static SECURITY DEFINER SQL, and PRO_PREPAID_GRACE_DAYS lockstep", () => {
  const [firstChunk] = MIGRATION_SQL.split("--> statement-breakpoint");
  assertBoundedLockTimeout(
    stripLeadingLineComments(firstChunk ?? ""),
    "0716 first executable statement",
    { maxMs: 2_000 },
  );

  const fnMatch = /\$ffa_server_plan_entitlement_inputs\$([\s\S]*?)\$ffa_server_plan_entitlement_inputs\$/.exec(
    MIGRATION_SQL,
  );
  assert.ok(fnMatch, "expected $ffa_server_plan_entitlement_inputs$ dollar-quoted body");
  const fnBody = fnMatch[1] ?? "";
  assert.equal(/\bEXECUTE\b/i.test(fnBody), false, "function body must contain zero dynamic SQL");
  assert.match(MIGRATION_SQL, /SECURITY DEFINER/);
  assert.match(MIGRATION_SQL, /STABLE/);
  assert.match(MIGRATION_SQL, /SET search_path = pg_catalog, pg_temp/);
  assert.match(
    fnBody,
    new RegExp(`interval '${PRO_PREPAID_GRACE_DAYS} days'`),
    "SQL grace window must stay in lockstep with PRO_PREPAID_GRACE_DAYS",
  );
});

test("ffa_server_plan_entitlement_inputs preserves the operator privilege boundary and matches getServerBillingEntitlements", async () => {
  const pg = new PGlite();
  try {
    await migratePglite(pg);
    await pg.query(`CREATE ROLE ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE} NOLOGIN`);
    await pg.query("CREATE ROLE ffa_unprivileged_probe NOLOGIN");
    await reconcileAndVerifyFeatureFlagAdminPrivileges(
      async (text, values) => pg.query<Record<string, unknown>>(text, values),
    );

    const db = drizzle(pg, { schema }) as unknown as Database;
    const now = new Date("2026-11-15T12:00:00.000Z");
    const ownerId = deterministicUuid(1);
    await db.insert(users).values({
      id: ownerId,
      email: "owner@example.com",
      name: "owner",
      passwordHash: "placeholder-hash",
    });

    // Unprivileged roles (PUBLIC) cannot execute the SECURITY DEFINER function.
    await pg.query("SET ROLE ffa_unprivileged_probe");
    try {
      await assert.rejects(
        pg.query(
          "SELECT public.ffa_server_plan_entitlement_inputs($1::uuid, $2::timestamptz)",
          [deterministicUuid(9999), now.toISOString()],
        ),
        (err: unknown) => (err as { code?: string }).code === "42501",
      );
    } finally {
      await pg.query("RESET ROLE");
    }

    // Operator role cannot pass NULL parameters (22023) and cannot read secret/billing tables directly (42501).
    await pg.query(`SET ROLE ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
    try {
      await assert.rejects(
        pg.query("SELECT public.ffa_server_plan_entitlement_inputs(NULL, $1::timestamptz)", [now.toISOString()]),
        (err: unknown) => (err as { code?: string }).code === "22023",
      );
      await assert.rejects(
        pg.query("SELECT public.ffa_server_plan_entitlement_inputs($1::uuid, NULL)", [deterministicUuid(9999)]),
        (err: unknown) => (err as { code?: string }).code === "22023",
      );
      for (const forbiddenSql of [
        "SELECT license_key FROM public.appsumo_licenses",
        "SELECT tier FROM public.appsumo_licenses",
        "SELECT current_license_key FROM public.appsumo_license_bindings",
        "SELECT stripe_checkout_session_id FROM public.prepaid_pro_purchases",
        "SELECT amount_total FROM public.prepaid_pro_purchases",
        "SELECT kind FROM public.prepaid_pro_purchases",
        "SELECT stripe_customer_id FROM public.subscriptions",
      ]) {
        await assert.rejects(
          pg.query(forbiddenSql),
          (err: unknown) => (err as { code?: string }).code === "42501",
          forbiddenSql,
        );
      }
    } finally {
      await pg.query("RESET ROLE");
    }

    const readAsOperator = async (serverId: string): Promise<{ raw: unknown; plan: ServerPlan }> => {
      await pg.query(`SET ROLE ${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`);
      try {
        const res = await pg.query<{ inputs: unknown }>(
          "SELECT public.ffa_server_plan_entitlement_inputs($1::uuid, $2::timestamptz) AS inputs",
          [serverId, now.toISOString()],
        );
        const raw = res.rows[0]?.inputs ?? null;
        const parsed = parseFfaServerPlanEntitlementInputs(raw);
        return {
          raw,
          plan: parsed.found ? resolveEffectiveServerBillingPlan(parsed.inputs, now) : "free",
        };
      } finally {
        await pg.query("RESET ROLE");
      }
    };

    // 1. Missing server UUID -> NULL -> free
    const missingId = deterministicUuid(9000);
    const missingOperator = await readAsOperator(missingId);
    assert.equal(missingOperator.raw, null);
    assert.equal(missingOperator.plan, (await getServerBillingEntitlement(db, missingId, now)).plan);

    let nextId = 10;
    const allocUuid = () => deterministicUuid(nextId++);

    // 2. Soft-deleted server with active paid rows -> NULL -> free
    const deletedServerId = allocUuid();
    await db.insert(servers).values({
      id: deletedServerId,
      name: "Deleted Pro",
      slug: "deleted-pro",
      ownerId,
      plan: "pro",
      deletedAt: new Date("2026-11-14T00:00:00.000Z"),
    });
    await db.insert(subscriptions).values({
      id: allocUuid(),
      serverId: deletedServerId,
      plan: "pro",
      status: "active",
      stripeCustomerId: "cus_del",
      stripeSubscriptionId: "sub_del",
    });
    const deletedOperator = await readAsOperator(deletedServerId);
    assert.equal(deletedOperator.raw, null);
    assert.equal(deletedOperator.plan, "free");
    assert.equal(deletedOperator.plan, (await getServerBillingEntitlement(db, deletedServerId, now)).plan);

    // 3. Stale servers.plan='pro' + canceled subscription + active AppSumo -> pro (appsumo)
    const appsumoServerId = allocUuid();
    const appsumoKey = allocUuid() as AppSumoLicenseKey;
    await db.insert(servers).values({
      id: appsumoServerId,
      name: "AppSumo Server",
      slug: "appsumo-srv",
      ownerId,
      plan: "pro",
    });
    await db.insert(subscriptions).values({
      id: allocUuid(),
      serverId: appsumoServerId,
      plan: "pro",
      status: "canceled",
      stripeCustomerId: "cus_old_canceled",
      stripeSubscriptionId: "sub_old_canceled",
    });
    await db.insert(appSumoLicenses).values({
      productId: "raft_appsumo",
      licenseKey: appsumoKey,
      tier: 3,
      status: "active",
      verifiedAt: new Date("2026-10-01T00:00:00.000Z"),
    });
    await db.insert(appSumoLicenseBindings).values({
      id: allocUuid(),
      serverId: appsumoServerId,
      productId: "raft_appsumo",
      originalLicenseKey: appsumoKey,
      currentLicenseKey: appsumoKey,
    });
    const appsumoOperator = await readAsOperator(appsumoServerId);
    assert.equal(appsumoOperator.plan, "pro");
    assert.equal(appsumoOperator.plan, (await getServerBillingEntitlement(db, appsumoServerId, now)).plan);
    assert.equal(JSON.stringify(appsumoOperator.raw).includes(appsumoKey), false);
    assert.equal(JSON.stringify(appsumoOperator.raw).includes("cus_old_canceled"), false);

    // 4. Seeded randomized servers covering every combination of plan, kind, deletedAt,
    //    subscription status, AppSumo license state, and Prepaid Pro windows/statuses.
    const rng = createMulberry32(0x20261115);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(rng() * items.length)]!;
    const randomServerIds: string[] = [];

    for (let i = 0; i < 120; i += 1) {
      const serverId = allocUuid();
      randomServerIds.push(serverId);
      const serverPlan = pick<ServerPlan>(["free", "pro", "founder", "partner"]);
      const kind = rng() < 0.88 ? "normal" : "joint_storage";
      const isDeleted = rng() < 0.1;

      await db.insert(servers).values({
        id: serverId,
        name: `Rand ${i}`,
        slug: `rand-srv-${i}`,
        ownerId,
        kind,
        plan: serverPlan,
        deletedAt: isDeleted ? new Date("2026-11-10T00:00:00.000Z") : null,
      });

      if (rng() < 0.65) {
        const status = pick(["active", "past_due", "canceled", "incomplete"] as const);
        await db.insert(subscriptions).values({
          id: allocUuid(),
          serverId,
          plan: "pro",
          status,
          stripeCustomerId: `cus_${i}`,
          stripeSubscriptionId: `sub_${i}`,
        });
      }

      if (rng() < 0.45) {
        const licenseKey = allocUuid() as AppSumoLicenseKey;
        const licenseStatus = pick(["pending", "inactive", "active", "deactivated"] as const);
        const tier = licenseStatus === "active" ? pick([1, 2, 3, 4]) : pick([null, 1, 2]);
        const verifiedAt = licenseStatus === "active"
          ? new Date("2026-10-05T00:00:00.000Z")
          : rng() < 0.5
            ? new Date("2026-10-05T00:00:00.000Z")
            : null;
        await db.insert(appSumoLicenses).values({
          productId: "raft_appsumo",
          licenseKey,
          tier,
          status: licenseStatus,
          verifiedAt,
        });
        await db.insert(appSumoLicenseBindings).values({
          id: allocUuid(),
          serverId,
          productId: "raft_appsumo",
          originalLicenseKey: licenseKey,
          currentLicenseKey: licenseKey,
        });
      }

      const purchaseCount = Math.floor(rng() * 4);
      for (let p = 0; p < purchaseCount; p += 1) {
        const purchaseKind = rng() < 0.7 ? "period" : "seats";
        const purchaseStatus = pick(["paid", "paid", "refunded", "conflict"] as const);
        const windowVariant = Math.floor(rng() * 6);
        const dayMs = 24 * 60 * 60 * 1000;
        let startsAt: Date;
        let endsAt: Date;
        if (windowVariant === 0) {
          // Active covering period
          startsAt = new Date(now.getTime() - 10 * dayMs);
          endsAt = new Date(now.getTime() + 20 * dayMs);
        } else if (windowVariant === 1) {
          // Chained renewal period ahead
          startsAt = new Date(now.getTime() + 20 * dayMs);
          endsAt = new Date(now.getTime() + 50 * dayMs);
        } else if (windowVariant === 2) {
          // Inside 3-day grace window (2 days ago)
          startsAt = new Date(now.getTime() - 32 * dayMs);
          endsAt = new Date(now.getTime() - 2 * dayMs);
        } else if (windowVariant === 3) {
          // Exact 3-day grace boundary (lapsed)
          startsAt = new Date(now.getTime() - 33 * dayMs);
          endsAt = new Date(now.getTime() - PRO_PREPAID_GRACE_DAYS * dayMs);
        } else if (windowVariant === 4) {
          // Lapsed 1ms before grace boundary (still in grace!)
          startsAt = new Date(now.getTime() - 33 * dayMs);
          endsAt = new Date(now.getTime() - PRO_PREPAID_GRACE_DAYS * dayMs + 1_000);
        } else {
          // Future-only period
          startsAt = new Date(now.getTime() + 5 * dayMs);
          endsAt = new Date(now.getTime() + 35 * dayMs);
        }
        await db.insert(prepaidProPurchases).values({
          id: allocUuid(),
          serverId,
          kind: purchaseKind,
          months: purchaseKind === "period" ? 1 : null,
          seatQuantity: 1 + Math.floor(rng() * 5),
          startsAt,
          endsAt,
          status: purchaseStatus,
          conflictReason: purchaseStatus === "conflict" ? "paid_source" : null,
          stripeCheckoutSessionId: `cs_test_${i}_${p}`,
          amountTotal: 2000,
          currency: "usd",
        });
      }
    }

    const serverEntitlements = await getServerBillingEntitlements(db, randomServerIds, now);
    const defaultPolicy = featureFlagDefaultPolicyFromEnv({});
    const flagRow: FeatureFlagRowInput = {
      key: "plan_parity_v0",
      enabled: true,
      killSwitch: false,
      randomizationUnit: "server",
      defaultEnabled: false,
      defaultVariant: null,
      salt: "plan-parity-salt",
    };
    const ruleVariants: FeatureFlagRuleRowInput[][] = [
      [{
        id: deterministicUuid(8001),
        stage: "plan",
        priority: 0,
        decision: "allow",
        values: ["pro"],
        percentageBasisPoints: null,
        variant: "pro-variant",
        createdAt: "2026-11-01T00:00:00.000Z",
      }],
      [{
        id: deterministicUuid(8002),
        stage: "plan",
        priority: 0,
        decision: "deny",
        values: ["pro"],
        percentageBasisPoints: null,
        variant: null,
        createdAt: "2026-11-01T00:00:00.000Z",
      }],
      [{
        id: deterministicUuid(8003),
        stage: "plan",
        priority: 0,
        decision: "allow",
        values: ["partner"],
        percentageBasisPoints: null,
        variant: null,
        createdAt: "2026-11-01T00:00:00.000Z",
      }],
      [{
        id: deterministicUuid(8004),
        stage: "plan",
        priority: 0,
        decision: "allow",
        values: ["free"],
        percentageBasisPoints: null,
        variant: null,
        createdAt: "2026-11-01T00:00:00.000Z",
      }],
    ];

    for (const serverId of randomServerIds) {
      const operatorRead = await readAsOperator(serverId);
      const livePlan = serverEntitlements.get(serverId)?.plan ?? "free";
      assert.equal(operatorRead.plan, livePlan, `plan mismatch for ${serverId}`);

      for (const rules of ruleVariants) {
        const previewEval = evaluateFeatureFlagRow({
          flag: flagRow,
          rules,
          input: { key: flagRow.key, serverId },
          cohorts: {
            matchingAudienceKeys: new Set(),
            lab: { status: "ready", effectiveLabKeys: new Set() },
            plan: { status: "ready", entitlementPlan: operatorRead.plan, now },
          },
          defaultPolicy,
        });
        const serverEval = evaluateFeatureFlagRow({
          flag: flagRow,
          rules,
          input: { key: flagRow.key, serverId },
          cohorts: {
            matchingAudienceKeys: new Set(),
            lab: { status: "ready", effectiveLabKeys: new Set() },
            plan: { status: "ready", entitlementPlan: livePlan, now },
          },
          defaultPolicy,
        });
        assert.deepEqual(previewEval, serverEval, `evaluation mismatch for ${serverId}`);
      }
    }
  } finally {
    await pg.close();
  }
});
