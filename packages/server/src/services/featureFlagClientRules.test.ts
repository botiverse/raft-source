import assert from "node:assert/strict";
import { openTestApp } from "../test/integration/app";
import { getDb } from "../db/index";
import { featureFlagRules, featureFlags } from "../db/schema";
import {
  FeatureFlagRuleValidationError,
  clientRuleConstraintsSatisfied,
  createFeatureFlagRule,
  createFirstServerAllowFeatureFlagRule,
  evaluateFeatureFlag,
  getFeatureFlagConfigVersion,
  updateFeatureFlag,
  updateFeatureFlagRule,
} from "./featureFlagService";

// task #1144: `client`-stage rules target servers AND require client OS / minimum build. Missing or
// unknown client facts never satisfy a constraint; the rule is skipped, never widened.

const serverX = "00000000-0000-4000-8000-00000000cc01";
const serverY = "00000000-0000-4000-8000-00000000cc02";
const testAppOptions = { humanActivityMuteFlagDefaultEnabled: true };

async function withFlag(key: string, run: () => Promise<void>): Promise<void> {
  const { close } = await openTestApp("pglite://", 0, testAppOptions);
  try {
    await getDb().insert(featureFlags).values({
      key,
      randomizationUnit: "server",
      defaultEnabled: false,
      salt: `${key}-salt`,
    });
    await run();
  } finally {
    await close();
  }
}

test("client rules: OS AND minimum build AND target server must all match", async () => {
  const key = "client_rule_matrix_v0";
  await withFlag(key, async () => {
    await getDb().insert(featureFlagRules).values({
      flagKey: key,
      stage: "client",
      decision: "allow",
      values: [serverX],
      clientOs: ["android"],
      minClientBuild: 1120131,
    });
    const hit = { key, enabled: true, reason: "client_rule" };
    const miss = { key, enabled: false, reason: "default" };
    const evaluate = (serverId: string | undefined, client: Parameters<typeof evaluateFeatureFlag>[0]["client"]) =>
      evaluateFeatureFlag({ key, serverId, platform: "mobile", client });

    assert.deepEqual(await evaluate(serverX, { os: "android", buildNumber: 1120131 }), hit);
    assert.deepEqual(await evaluate(serverX, { os: "android", buildNumber: 1120200 }), hit);
    assert.deepEqual(await evaluate(serverX, { os: "android", buildNumber: 1120130 }), miss); // old build
    assert.deepEqual(await evaluate(serverX, { os: "ios", buildNumber: 1120200 }), miss); // other OS
    assert.deepEqual(await evaluate(serverY, { os: "android", buildNumber: 1120200 }), miss); // other server
    assert.deepEqual(await evaluate(undefined, { os: "android", buildNumber: 1120200 }), { ...miss, reason: "missing_server_unit" });
    // Clients that report nothing (old app builds, web, internal callers) never match.
    assert.deepEqual(await evaluate(serverX, undefined), miss);
    assert.deepEqual(await evaluate(serverX, { os: "android", buildNumber: null }), miss);
    assert.deepEqual(await evaluate(serverX, { os: null, buildNumber: 1120200 }), miss);
  });
});

test("client rules: a deny that does not match falls through to later stages", async () => {
  const key = "client_rule_deny_fallthrough_v0";
  await withFlag(key, async () => {
    await getDb().insert(featureFlagRules).values([
      { flagKey: key, stage: "client", decision: "deny", values: [serverX], clientOs: ["ios", "ohos"] },
      { flagKey: key, stage: "server", decision: "allow", values: [serverX] },
    ]);
    assert.deepEqual(
      await evaluateFeatureFlag({ key, serverId: serverX, client: { os: "ios", buildNumber: 1 } }),
      { key, enabled: false, reason: "client_rule" },
    );
    assert.deepEqual(
      await evaluateFeatureFlag({ key, serverId: serverX, client: { os: "android", buildNumber: 1 } }),
      { key, enabled: true, reason: "server_rule" },
    );
    // Unknown OS cannot satisfy the deny either: the stage is skipped, later stages decide.
    assert.deepEqual(
      await evaluateFeatureFlag({ key, serverId: serverX }),
      { key, enabled: true, reason: "server_rule" },
    );
  });
});

test("client rules: single-constraint rules and priority order", async () => {
  const key = "client_rule_single_constraint_v0";
  await withFlag(key, async () => {
    await getDb().insert(featureFlagRules).values([
      { flagKey: key, stage: "client", priority: 0, decision: "deny", values: [serverX], minClientBuild: 5000 },
      { flagKey: key, stage: "client", priority: 1, decision: "allow", values: [serverX], clientOs: ["android"] },
    ]);
    assert.deepEqual(
      await evaluateFeatureFlag({ key, serverId: serverX, client: { os: "android", buildNumber: 6000 } }),
      { key, enabled: false, reason: "client_rule" },
    );
    assert.deepEqual(
      await evaluateFeatureFlag({ key, serverId: serverX, client: { os: "android", buildNumber: 10 } }),
      { key, enabled: true, reason: "client_rule" },
    );
  });
});

test("client rules: build type targets alpha builds without relying on build numbers", async () => {
  const key = "client_rule_build_type_v0";
  await withFlag(key, async () => {
    await getDb().insert(featureFlagRules).values({
      flagKey: key,
      stage: "client",
      decision: "allow",
      values: [serverX],
      clientOs: ["android"],
      clientBuildTypes: ["alpha"],
    });
    // Alpha builds report their own numbering (e.g. 1000031); build type is what targets them.
    assert.deepEqual(
      await evaluateFeatureFlag({ key, serverId: serverX, client: { os: "android", buildNumber: 1000031, buildType: "alpha" } }),
      { key, enabled: true, reason: "client_rule" },
    );
    for (const client of [
      { os: "android" as const, buildNumber: 11200132, buildType: "release" as const },
      { os: "android" as const, buildNumber: 1000031 },
      { os: "ios" as const, buildNumber: 1, buildType: "alpha" as const },
    ]) {
      assert.deepEqual(
        await evaluateFeatureFlag({ key, serverId: serverX, client }),
        { key, enabled: false, reason: "default" },
        JSON.stringify(client),
      );
    }
  });
});

test("client rules: database constraints keep client fields scoped to the client stage", async () => {
  const key = "client_rule_checks_v0";
  await withFlag(key, async () => {
    const db = getDb();
    const rejects = async (row: Partial<typeof featureFlagRules.$inferInsert>, constraint: string) => {
      await assert.rejects(
        db.insert(featureFlagRules).values({ flagKey: key, stage: "client", decision: "allow", values: [serverX], ...row }),
        (error: unknown) => JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(constraint),
        constraint,
      );
    };
    // A non-client stage carrying client fields would be an unguarded constraint for older evaluators.
    await rejects({ stage: "server", clientOs: ["android"] }, "feature_flag_rules_client_fields_scoped");
    await rejects({ stage: "percentage", minClientBuild: 1, percentageBasisPoints: 100 }, "feature_flag_rules_client_fields_scoped");
    await rejects({}, "feature_flag_rules_client_shape_valid"); // no constraint at all
    await rejects({ values: [], clientOs: ["android"] }, "feature_flag_rules_client_shape_valid"); // no target server
    await rejects({ clientOs: ["android"], variant: "v" }, "feature_flag_rules_client_shape_valid");
    await rejects({ clientOs: ["desktop"] }, "feature_flag_rules_client_os_valid");
    await rejects({ clientOs: [] }, "feature_flag_rules_client_os_valid");
    await rejects({ minClientBuild: -1 }, "feature_flag_rules_min_client_build_valid");
    await rejects({ stage: "server", clientBuildTypes: ["alpha"] }, "feature_flag_rules_client_fields_scoped");
    await rejects({ clientBuildTypes: [] }, "feature_flag_rules_client_build_types_valid");
    await rejects({ clientBuildTypes: ["connectedTest"] }, "feature_flag_rules_client_build_types_valid");
  });
});

test("client rules: service validation mirrors the constraints", async () => {
  const key = "client_rule_service_validation_v0";
  await withFlag(key, async () => {
    await assert.rejects(
      createFeatureFlagRule({ flagKey: key, stage: "server", decision: "allow", values: [serverX], clientOs: ["android"] }),
      FeatureFlagRuleValidationError,
    );
    await assert.rejects(
      createFeatureFlagRule({ flagKey: key, stage: "client", decision: "allow", values: [serverX] }),
      FeatureFlagRuleValidationError,
    );
    await assert.rejects(
      createFeatureFlagRule({ flagKey: key, stage: "client", decision: "allow", values: [serverX], clientOs: ["web"] }),
      FeatureFlagRuleValidationError,
    );
    await assert.rejects(
      createFeatureFlagRule({ flagKey: key, stage: "client", decision: "allow", values: [serverX], clientBuildTypes: ["beta"] }),
      FeatureFlagRuleValidationError,
    );
    const created = await createFeatureFlagRule({
      flagKey: key,
      stage: "client",
      decision: "allow",
      values: [serverX],
      clientOs: ["android"],
      minClientBuild: 1120131,
    });
    assert.deepEqual(created.clientOs, ["android"]);
    assert.equal(created.minClientBuild, 1120131);
  });
});

test("client rules: constraint predicate fails closed", () => {
  assert.equal(clientRuleConstraintsSatisfied({ clientOs: null, minClientBuild: null }, { os: "android", buildNumber: 1 }), false);
  assert.equal(clientRuleConstraintsSatisfied({ clientOs: ["android"], minClientBuild: null }, { os: "android" }), true);
  assert.equal(clientRuleConstraintsSatisfied({ clientOs: null, minClientBuild: 10 }, { buildNumber: 10 }), true);
  assert.equal(clientRuleConstraintsSatisfied({ clientOs: null, minClientBuild: 10 }, { buildNumber: Number.NaN }), false);
  assert.equal(clientRuleConstraintsSatisfied({ clientOs: null, minClientBuild: 10 }, { buildNumber: 9.5 }), false);
  assert.equal(clientRuleConstraintsSatisfied({ clientOs: ["android"], minClientBuild: 10 }, null), false);
  assert.equal(clientRuleConstraintsSatisfied({ clientOs: null, minClientBuild: null, clientBuildTypes: ["alpha"] }, { buildType: "alpha" }), true);
  assert.equal(clientRuleConstraintsSatisfied({ clientOs: null, minClientBuild: null, clientBuildTypes: ["alpha"] }, { buildType: null }), false);
});

test("client rules: a client allow and a server allow for the same server are rejected in both directions", async () => {
  const key = "client_rule_fallthrough_conflict_v0";
  await withFlag(key, async () => {
    // Without this, an old build that fails the client rule would fall through to the server allow.
    const clientAllow = await createFeatureFlagRule({
      flagKey: key, stage: "client", decision: "allow", values: [serverX], clientOs: ["android"], minClientBuild: 1120131,
    });
    await assert.rejects(
      createFeatureFlagRule({ flagKey: key, stage: "server", decision: "allow", values: [serverY, serverX] }),
      /would be bypassed/,
    );
    // A server allow for another server, and a server deny for the same server, are fine.
    const otherServer = await createFeatureFlagRule({ flagKey: key, stage: "server", decision: "allow", values: [serverY] });
    await createFeatureFlagRule({ flagKey: key, stage: "server", priority: 1, decision: "deny", values: [serverX] });
    // Widening the unrelated server allow onto serverX is the same conflict.
    await assert.rejects(updateFeatureFlagRule(key, otherServer.id, { values: [serverY, serverX] }), /would be bypassed/);
    // Reverse direction: extending the client allow onto a server that already has a server allow.
    await assert.rejects(updateFeatureFlagRule(key, clientAllow.id, { values: [serverX, serverY] }), /would be bypassed/);
    // Turning the client rule into a deny removes the conflict.
    assert.ok(await updateFeatureFlagRule(key, clientAllow.id, { decision: "deny", values: [serverX, serverY] }));
  });
});

test("client rules: the first-server-allow helper also refuses to shadow a client allow", async () => {
  const key = "client_rule_first_allow_conflict_v0";
  await withFlag(key, async () => {
    await createFeatureFlagRule({ flagKey: key, stage: "client", decision: "allow", values: [serverX], clientBuildTypes: ["alpha"] });
    await assert.rejects(
      createFirstServerAllowFeatureFlagRule({
        flagKey: key,
        serverIds: [serverX],
        expectedConfigVersion: await getFeatureFlagConfigVersion(),
        actor: { type: "agent", id: "test" },
      }),
      /would be bypassed/,
    );
  });
});

test("client rules: every later stage that could grant the flag is rejected, in both directions", async () => {
  const key = "client_rule_bypass_stages_v0";
  await withFlag(key, async () => {
    const clientAllow = await createFeatureFlagRule({
      flagKey: key, stage: "client", decision: "allow", values: [serverX], clientOs: ["android"],
    });
    // client allow first, then a later-stage allow.
    for (const later of [
      { stage: "lab" as const, values: ["composer_lab"] },
      { stage: "plan" as const, values: ["pro"] },
      { stage: "percentage" as const, values: [], percentageBasisPoints: 1 },
    ]) {
      await assert.rejects(createFeatureFlagRule({ flagKey: key, decision: "allow", ...later }), /would be bypassed/, later.stage);
    }
    // Denies and a 0% slice cannot grant anything.
    await createFeatureFlagRule({ flagKey: key, stage: "lab", decision: "deny", values: ["composer_lab"] });
    const zero = await createFeatureFlagRule({ flagKey: key, stage: "percentage", decision: "allow", values: [], percentageBasisPoints: 0 });
    await assert.rejects(updateFeatureFlagRule(key, zero.id, { percentageBasisPoints: 500 }), /would be bypassed/);
    // The flag default is the final fallback.
    await assert.rejects(updateFeatureFlag(key, { defaultEnabled: true }), /would be bypassed/);
    assert.ok(await updateFeatureFlag(key, { description: "unrelated edits still work" }));

    // Reverse direction: with a grant already present, a client allow cannot be added or re-enabled.
    await updateFeatureFlagRule(key, clientAllow.id, { decision: "deny" });
    await updateFeatureFlagRule(key, zero.id, { percentageBasisPoints: 500 });
    await assert.rejects(updateFeatureFlagRule(key, clientAllow.id, { decision: "allow" }), /would be bypassed/);
    await assert.rejects(
      createFeatureFlagRule({ flagKey: key, stage: "client", decision: "allow", values: [serverY], minClientBuild: 1 }),
      /would be bypassed/,
    );
  });
});

test("client rules: a flag that is on by default cannot take a client allow", async () => {
  const key = "client_rule_bypass_default_v0";
  const { close } = await openTestApp("pglite://", 0, testAppOptions);
  try {
    await getDb().insert(featureFlags).values({ key, randomizationUnit: "server", defaultEnabled: true, salt: "d" });
    await assert.rejects(
      createFeatureFlagRule({ flagKey: key, stage: "client", decision: "allow", values: [serverX], clientOs: ["ios"] }),
      /defaultEnabled/,
    );
  } finally {
    await close();
  }
});

test("client rules: conflicts that already exist do not block narrowing or unrelated edits", async () => {
  const key = "client_rule_existing_conflict_v0";
  await withFlag(key, async () => {
    const db = getDb();
    // Only reachable by writing rows directly (every service path rejects it); cleanup must still work.
    const [percentage] = await db.insert(featureFlagRules).values({
      flagKey: key, stage: "percentage", decision: "allow", values: [], percentageBasisPoints: 500,
    }).returning();
    await db.insert(featureFlagRules).values({
      flagKey: key, stage: "client", decision: "allow", values: [serverX], clientOs: ["android"],
    });
    assert.ok(await updateFeatureFlagRule(key, percentage.id, { percentageBasisPoints: 100 }));
    assert.ok(await updateFeatureFlag(key, { description: "unrelated edit" }));
    // A new bypass on top of the existing one is still rejected.
    await assert.rejects(updateFeatureFlag(key, { defaultEnabled: true }), /would be bypassed/);
  });
});
