import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import argon2 from "argon2";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { and, eq, sql } from "drizzle-orm";
import { COMPOSER_RESOURCE_REFERENCES_FEATURE_FLAG_KEY, WIKI_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { openTestApp } from "../test/integration/app.js";
import { getDb, type DatabaseExecutor } from "../db/index.js";
import { migratePglite } from "../db/pgliteMigrations.js";
import * as dbSchema from "../db/schema.js";
import {
  featureFlagRules,
  featureFlagAudienceMembers,
  featureFlagAudiences,
  featureFlags,
  labDefinitions,
  serverLabAccess,
  serverLabAuditEvents,
  serverLabEnrollments,
  servers,
  users,
} from "../db/schema.js";
import { createServer } from "./serverService.js";
import {
  ACTIVITY_V2_FEATURE_FLAG_KEY,
  AGENT_MIGRATION_FEATURE_FLAG_KEY,
  LLM_TRANSLATION_FEATURE_FLAG_KEY,
  APPLE_WEB_LOGIN_FEATURE_FLAG_KEY,
  ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY,
  ATTACHMENT_DIRECT_UPLOAD_FEATURE_FLAG_KEY,
  CHAT_GRID_LAYOUT_FEATURE_FLAG_KEY,
  GROK_RUNTIME_FEATURE_FLAG_KEY,
  HUMAN_ACTIVITY_MUTE_FEATURE_FLAG_KEY,
  INBOX_VISIBILITY_V3_FEATURE_FLAG_KEY,
  MESSAGE_FORWARDING_FEATURE_FLAG_KEY,
  SERVER_LABS_UI_FEATURE_FLAG_KEY,
  bumpFeatureFlagConfigVersion,
  computeFeatureFlagBucket,
  createFeatureFlag,
  createFeatureFlagRule,
  deleteFeatureFlagRule,
  evaluateFeatureFlag,
  evaluateFeatureFlags,
  getFeatureFlag,
  getFeatureFlagConfigVersion,
  listFeatureFlagRules,
  updateFeatureFlag,
  updateFeatureFlagRule,
} from "./featureFlagService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

function causedByConstraint(name: string) {
  return (error: unknown): boolean => {
    const cause = error && typeof error === "object" ? (error as { cause?: unknown }).cause : null;
    return cause instanceof Error && cause.message.includes(name);
  };
}

test("feature flags: seeded Wiki gate allows only the initial Botiverse server", async () => {
  const { close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const botiverseServerId = "95f993fa-2a68-4797-b8ae-7beb7d984ada";
    const otherServerId = "00000000-0000-4000-8000-00000000ff00";

    assert.deepEqual(await evaluateFeatureFlag({
      key: WIKI_FEATURE_FLAG_KEY,
      serverId: botiverseServerId,
    }), {
      key: WIKI_FEATURE_FLAG_KEY,
      enabled: true,
      reason: "server_rule",
    });
    assert.deepEqual(await evaluateFeatureFlag({
      key: WIKI_FEATURE_FLAG_KEY,
      serverId: otherServerId,
    }), {
      key: WIKI_FEATURE_FLAG_KEY,
      enabled: false,
      reason: "default",
    });
  } finally {
    await close();
  }
});

test("feature flags: reusable audiences match user OR server while direct rules retain precedence", async () => {
  const { close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  const key = "audience_or_v0";
  const audienceKey = "insiders";
  const userId = "00000000-0000-4000-8000-00000000a101";
  const serverId = "00000000-0000-4000-8000-00000000a102";
  const directUserId = "00000000-0000-4000-8000-00000000a103";
  try {
    await createFeatureFlag({ key, randomizationUnit: "server", defaultEnabled: false, salt: "audience-or" });
    await getDb().insert(featureFlagAudiences).values({
      key: audienceKey,
      name: "Insiders",
      description: "Reusable internal cohort",
      enabled: true,
    });
    await getDb().insert(featureFlagAudienceMembers).values([
      { audienceKey, kind: "user", targetId: userId },
      { audienceKey, kind: "server", targetId: serverId },
      { audienceKey, kind: "user", targetId: directUserId },
    ]);
    await createFeatureFlagRule({
      flagKey: key,
      stage: "audience",
      priority: 0,
      decision: "allow",
      values: [audienceKey],
    });
    await createFeatureFlagRule({
      flagKey: key,
      stage: "user",
      priority: 100,
      decision: "deny",
      values: [directUserId],
    });

    assert.deepEqual(await evaluateFeatureFlag({ key, userId, serverId: "00000000-0000-4000-8000-00000000a199" }), {
      key, enabled: true, reason: "audience_rule",
    });
    assert.deepEqual(await evaluateFeatureFlag({ key, serverId }), {
      key, enabled: true, reason: "audience_rule",
    });
    assert.deepEqual(await evaluateFeatureFlag({ key, userId: directUserId, serverId }), {
      key, enabled: false, reason: "user_rule",
    });
    assert.deepEqual(await evaluateFeatureFlag({ key, serverId: "00000000-0000-4000-8000-00000000a198" }), {
      key, enabled: false, reason: "default",
    });

    await getDb().update(featureFlagAudiences).set({ enabled: false }).where(eq(featureFlagAudiences.key, audienceKey));
    assert.deepEqual(await evaluateFeatureFlag({ key, userId }), {
      key, enabled: false, reason: "missing_server_unit",
    });
  } finally {
    await close();
  }
});

test("feature flags: seeded attachment comments flag is default-on and global kill switch is fresh", async () => {
  const { close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const serverId = "00000000-0000-4000-8000-00000000ff01";
    const before = await evaluateFeatureFlag({
      key: ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY,
      serverId,
    });
    assert.deepEqual(before, {
      key: ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY,
      enabled: true,
      reason: "default",
    });

    await getDb()
      .update(featureFlags)
      .set({ killSwitch: true })
      .where(eq(featureFlags.key, ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY));

    const killedContexts = [
      { serverId },
      { serverId: "00000000-0000-4000-8000-00000000ff02" },
      {
        serverId: "00000000-0000-4000-8000-00000000ff03",
        userId: "00000000-0000-4000-8000-00000000aa01",
      },
    ];
    for (const context of killedContexts) {
      assert.deepEqual(await evaluateFeatureFlag({
        key: ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY,
        ...context,
      }), {
        key: ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY,
        enabled: false,
        reason: "kill_switch",
      });
    }
  } finally {
    await close();
  }
});

test("feature flags: seeded human Activity mute gate is default-off", async () => {
  const { close } = await openTestApp("pglite://", 0, { onboardingOpenerFlagDefaultEnabled: false, humanActivityMuteFlagDefaultEnabled: false });
  try {
    assert.deepEqual(await evaluateFeatureFlag({
      key: HUMAN_ACTIVITY_MUTE_FEATURE_FLAG_KEY,
      serverId: "00000000-0000-4000-8000-00000000ff11",
    }), {
      key: HUMAN_ACTIVITY_MUTE_FEATURE_FLAG_KEY,
      enabled: false,
      reason: "default",
    });
  } finally {
    await close();
  }
});

test("feature flags: config version cursor bumps on service writes", async () => {
  const { close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    assert.equal(await getFeatureFlagConfigVersion(), 0);
    assert.equal(await bumpFeatureFlagConfigVersion({ updatedBy: "test-operator" }), 1);
    assert.equal(await getFeatureFlagConfigVersion(), 1);

    const flag = await createFeatureFlag({
      key: "config_version_cursor_v0",
      randomizationUnit: "server",
      defaultEnabled: false,
      salt: "config-version-cursor",
    });
    assert.equal(flag.key, "config_version_cursor_v0");
    assert.equal(await getFeatureFlagConfigVersion(), 2);

    await updateFeatureFlag("config_version_cursor_v0", { defaultEnabled: true });
    assert.equal(await getFeatureFlagConfigVersion(), 3);

    const rule = await createFeatureFlagRule({
      flagKey: "config_version_cursor_v0",
      stage: "server",
      decision: "allow",
      values: ["00000000-0000-4000-8000-00000000dd01"],
    });
    assert.equal(await getFeatureFlagConfigVersion(), 4);

    await updateFeatureFlagRule("config_version_cursor_v0", rule.id, {
      values: ["00000000-0000-4000-8000-00000000dd01", "00000000-0000-4000-8000-00000000dd02"],
    });
    assert.equal(await getFeatureFlagConfigVersion(), 5);

    await deleteFeatureFlagRule("config_version_cursor_v0", rule.id);
    assert.equal(await getFeatureFlagConfigVersion(), 6);
  } finally {
    await close();
  }
});

test("feature flags: seeded message forwarding gate is default-off", async () => {
  const { close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    assert.deepEqual(await evaluateFeatureFlag({
      key: MESSAGE_FORWARDING_FEATURE_FLAG_KEY,
      serverId: "00000000-0000-4000-8000-00000000ff21",
    }), {
      key: MESSAGE_FORWARDING_FEATURE_FLAG_KEY,
      enabled: false,
      reason: "default",
    });
  } finally {
    await close();
  }
});

test("feature flags: missing direct attachment upload gate fails closed", async () => {
  const { close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    assert.deepEqual(await evaluateFeatureFlag({
      key: ATTACHMENT_DIRECT_UPLOAD_FEATURE_FLAG_KEY,
      serverId: "00000000-0000-4000-8000-00000000ff31",
    }), {
      key: ATTACHMENT_DIRECT_UPLOAD_FEATURE_FLAG_KEY,
      enabled: false,
      reason: "missing_flag",
    });
  } finally {
    await close();
  }
});

test("feature flags: seeded agent migration gate is default-off", async () => {
  const { close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    assert.deepEqual(await evaluateFeatureFlag({
      key: AGENT_MIGRATION_FEATURE_FLAG_KEY,
      serverId: "00000000-0000-4000-8000-00000000ff41",
    }), {
      key: AGENT_MIGRATION_FEATURE_FLAG_KEY,
      enabled: false,
      reason: "default",
    });
  } finally {
    await close();
  }
});

test("feature flags: agent migration seed allowlists botiverse only", () => {
  const sql = readFileSync(
    resolve(import.meta.dirname, "../../drizzle/0150_agent_migration_flag.sql"),
    "utf8",
  );

  assert.match(sql, /'agent_migration_v0'/);
  assert.match(sql, /"slug" IN \('botiverse'\)/);
  assert.doesNotMatch(sql, /'community'/);
  assert.doesNotMatch(sql, /'community-cn'/);
});

test("feature flags: agent migration is dark for botiverse after follow-up deny", () => {
  const sql = readFileSync(
    resolve(import.meta.dirname, "../../drizzle/0154_agent_migration_dark_botiverse.sql"),
    "utf8",
  );

  assert.match(sql, /'agent_migration_v0'/);
  assert.match(sql, /"slug" IN \('botiverse'\)/);
  assert.match(sql, /'server'/);
  assert.match(sql, /-10/);
  assert.match(sql, /'deny'/);
  assert.doesNotMatch(sql, /'allow'/);
  assert.doesNotMatch(sql, /'community'/);
  assert.doesNotMatch(sql, /'community-cn'/);
});

test("feature flags: chat grid layout seed allowlists botiverse only", () => {
  const sql = readFileSync(
    resolve(import.meta.dirname, "../../drizzle/0151_chat_grid_layout_flag.sql"),
    "utf8",
  );

  assert.match(sql, new RegExp(`'${CHAT_GRID_LAYOUT_FEATURE_FLAG_KEY}'`));
  assert.match(sql, /"slug" IN \('botiverse'\)/);
  assert.doesNotMatch(sql, /'community'/);
  assert.doesNotMatch(sql, /'community-cn'/);
});

test("feature flags: Activity v2 seed is globally default-off and allowlists slock-android", () => {
  const sql = readFileSync(
    resolve(import.meta.dirname, "../../drizzle/0206_activity_v2_feature_flag.sql"),
    "utf8",
  );

  assert.match(sql, new RegExp(`'${ACTIVITY_V2_FEATURE_FLAG_KEY}'`));
  assert.match(sql, /'server'/);
  assert.match(sql, /false/);
  assert.match(sql, /"slug" IN \('slock-android'\)/);
  assert.match(sql, /INSERT INTO "feature_flag_rules"/);
  assert.match(sql, /'allow'/);
  assert.doesNotMatch(sql, /'botiverse'/);
  assert.doesNotMatch(sql, /'community'/);
  assert.doesNotMatch(sql, /'community-cn'/);
});

test("feature flags: composer resource references allowlist only botiverse and slock-android", () => {
  const migration = readFileSync(
    resolve(import.meta.dirname, "../../drizzle/0234_composer_resource_references_flag.sql"),
    "utf8",
  );

  assert.match(migration, new RegExp(`'${COMPOSER_RESOURCE_REFERENCES_FEATURE_FLAG_KEY}'`));
  assert.match(migration, /'server'/);
  assert.match(migration, /false/);
  assert.match(migration, /"slug" IN \('botiverse', 'slock-android'\)/);
  assert.match(migration, /INSERT INTO "feature_flag_rules"/);
  assert.match(migration, /'allow'/);
  assert.doesNotMatch(migration, /'community'/);
  assert.doesNotMatch(migration, /'community-cn'/);
});

test("feature flags: seeded Grok runtime gate is default-off", async () => {
  const { close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    assert.deepEqual(await evaluateFeatureFlag({
      key: GROK_RUNTIME_FEATURE_FLAG_KEY,
      serverId: "00000000-0000-4000-8000-00000000ff51",
    }), {
      key: GROK_RUNTIME_FEATURE_FLAG_KEY,
      enabled: false,
      reason: "default",
    });
  } finally {
    await close();
  }
});

test("feature flags: seeded Server Labs Web UI gate is default-off", async () => {
  const { close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const flag = await getFeatureFlag(SERVER_LABS_UI_FEATURE_FLAG_KEY);
    assert.equal(flag?.randomizationUnit, "server");
    assert.equal(flag?.defaultEnabled, false);
    assert.equal(flag?.enabled, true);
    assert.deepEqual(await evaluateFeatureFlag({
      key: SERVER_LABS_UI_FEATURE_FLAG_KEY,
      serverId: "00000000-0000-4000-8000-00000000ff61",
      platform: "web",
    }), {
      key: SERVER_LABS_UI_FEATURE_FLAG_KEY,
      enabled: false,
      reason: "default",
    });
  } finally {
    await close();
  }
});

test("feature flags: seeded Apple Web login gate is present but web and mobile stay fail-closed", async () => {
  const { close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const flag = await getFeatureFlag(APPLE_WEB_LOGIN_FEATURE_FLAG_KEY);
    assert.equal(flag?.enabled, true);
    assert.equal(flag?.killSwitch, false);
    assert.equal(flag?.randomizationUnit, "user");
    assert.equal(flag?.defaultEnabled, false);
    assert.equal(flag?.defaultVariant, null);

    const rules = await listFeatureFlagRules(APPLE_WEB_LOGIN_FEATURE_FLAG_KEY);
    assert.deepEqual(rules, []);
    assert.deepEqual(await evaluateFeatureFlag({
      key: APPLE_WEB_LOGIN_FEATURE_FLAG_KEY,
      platform: "web",
    }), {
      key: APPLE_WEB_LOGIN_FEATURE_FLAG_KEY,
      enabled: false,
      reason: "missing_user_unit",
    });
    assert.deepEqual(await evaluateFeatureFlag({
      key: APPLE_WEB_LOGIN_FEATURE_FLAG_KEY,
      platform: "mobile",
    }), {
      key: APPLE_WEB_LOGIN_FEATURE_FLAG_KEY,
      enabled: false,
      reason: "missing_user_unit",
    });
  } finally {
    await close();
  }
});

test("feature flags: Apple Web login seed has no rollout rule and preserves fail-closed defaults", () => {
  const sql = readFileSync(
    resolve(import.meta.dirname, "../../drizzle/0211_apple_web_login_feature_flag.sql"),
    "utf8",
  );

  assert.match(sql, new RegExp(`'${APPLE_WEB_LOGIN_FEATURE_FLAG_KEY}'`));
  assert.match(sql, /'user'/);
  assert.match(sql, /false/);
  assert.doesNotMatch(sql, /INSERT INTO "feature_flag_rules"/);
  assert.doesNotMatch(sql, /'mobile'/);
});

test("feature flags: Server Labs Web UI seed is default-off with no rollout rule", () => {
  const sql = readFileSync(
    resolve(import.meta.dirname, "../../drizzle/0192_server_labs_ui_feature_flag.sql"),
    "utf8",
  );

  assert.match(sql, new RegExp(`'${SERVER_LABS_UI_FEATURE_FLAG_KEY}'`));
  assert.match(sql, /'server'/);
  assert.match(sql, /false/);
  assert.doesNotMatch(sql, /INSERT INTO "feature_flag_rules"/);
});

test("feature flags: Grok runtime seed allowlists botiverse only", () => {
  const sql = readFileSync(
    resolve(import.meta.dirname, "../../drizzle/0185_grok_runtime_feature_flag.sql"),
    "utf8",
  );

  assert.match(sql, new RegExp(`'${GROK_RUNTIME_FEATURE_FLAG_KEY}'`));
  assert.match(sql, /"slug" IN \('botiverse'\)/);
  assert.match(sql, /'server'/);
  assert.match(sql, /'allow'/);
  assert.doesNotMatch(sql, /'community'/);
  assert.doesNotMatch(sql, /'community-cn'/);
});

test("feature flags: inbox visibility v3 gate is absent-safe default-off", async () => {
  const { close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    assert.deepEqual(await evaluateFeatureFlag({
      key: INBOX_VISIBILITY_V3_FEATURE_FLAG_KEY,
      serverId: "00000000-0000-4000-8000-00000000ff31",
      userId: "00000000-0000-4000-8000-00000000aa31",
    }), {
      key: INBOX_VISIBILITY_V3_FEATURE_FLAG_KEY,
      enabled: false,
      reason: "missing_flag",
    });
  } finally {
    await close();
  }
});

test("feature flags: server randomization fails closed without serverId and percent thresholds are deterministic", async () => {
  const { close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const db = getDb();
    const key = "percent_test_v0";
    const salt = "test-salt";
    const belowId = "00000000-0000-4000-8000-000000000004";
    const aboveId = "00000000-0000-4000-8000-000000000046";

    assert.equal(computeFeatureFlagBucket({ key, salt, unit: "server", unitId: belowId }), 4946);
    assert.equal(computeFeatureFlagBucket({ key, salt, unit: "server", unitId: aboveId }), 5015);

    await db.insert(featureFlags).values({
      key,
      randomizationUnit: "server",
      defaultEnabled: false,
      salt,
    });
    const [rule] = await db.insert(featureFlagRules).values({
      flagKey: key,
      stage: "percentage",
      decision: "allow",
      percentageBasisPoints: 5000,
      values: [],
    }).returning();

    assert.deepEqual(await evaluateFeatureFlag({ key }), {
      key,
      enabled: false,
      reason: "missing_server_unit",
    });
    assert.deepEqual(await evaluateFeatureFlag({ key, serverId: belowId }), {
      key,
      enabled: true,
      reason: "percentage_rule",
    });
    assert.deepEqual(await evaluateFeatureFlag({ key, serverId: aboveId }), {
      key,
      enabled: false,
      reason: "default",
    });

    await db
      .update(featureFlagRules)
      .set({ percentageBasisPoints: 5100 })
      .where(eq(featureFlagRules.id, rule.id));
    assert.deepEqual(await evaluateFeatureFlag({ key, serverId: aboveId }), {
      key,
      enabled: true,
      reason: "percentage_rule",
    });
  } finally {
    await close();
  }
});

test("feature flags: explicit user rules take precedence over server rules", async () => {
  const { close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const db = getDb();
    const serverId = "00000000-0000-4000-8000-00000000bb01";
    const userId = "00000000-0000-4000-8000-00000000cc01";

    const denyKey = "user_deny_precedence_v0";
    await db.insert(featureFlags).values({
      key: denyKey,
      randomizationUnit: "server",
      defaultEnabled: false,
      salt: "user-deny-precedence",
    });
    await db.insert(featureFlagRules).values([
      {
        flagKey: denyKey,
        stage: "server",
        decision: "allow",
        values: [serverId],
      },
      {
        flagKey: denyKey,
        stage: "user",
        decision: "deny",
        values: [userId],
      },
    ]);

    assert.deepEqual(await evaluateFeatureFlag({ key: denyKey, serverId, userId }), {
      key: denyKey,
      enabled: false,
      reason: "user_rule",
    });
    assert.deepEqual(await evaluateFeatureFlag({ key: denyKey, userId }), {
      key: denyKey,
      enabled: false,
      reason: "user_rule",
    });

    const allowKey = "user_allow_precedence_v0";
    await db.insert(featureFlags).values({
      key: allowKey,
      randomizationUnit: "server",
      defaultEnabled: false,
      salt: "user-allow-precedence",
    });
    await db.insert(featureFlagRules).values([
      {
        flagKey: allowKey,
        stage: "server",
        decision: "deny",
        values: [serverId],
      },
      {
        flagKey: allowKey,
        stage: "user",
        decision: "allow",
        values: [userId],
      },
    ]);

    assert.deepEqual(await evaluateFeatureFlag({ key: allowKey, serverId, userId }), {
      key: allowKey,
      enabled: true,
      reason: "user_rule",
    });
    assert.deepEqual(await evaluateFeatureFlag({ key: allowKey, userId }), {
      key: allowKey,
      enabled: true,
      reason: "user_rule",
    });
  } finally {
    await close();
  }
});

test("feature flags: platform rules split web/mobile while omitted platform preserves legacy matching", async () => {
  const { close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const db = getDb();
    const serverId = "00000000-0000-4000-8000-00000000bc01";
    const key = "platform_split_v0";

    await db.insert(featureFlags).values({
      key,
      randomizationUnit: "server",
      defaultEnabled: false,
      salt: "platform-split",
    });
    await db.insert(featureFlagRules).values([
      {
        flagKey: key,
        stage: "platform",
        priority: 0,
        decision: "deny",
        values: ["mobile"],
      },
      {
        flagKey: key,
        stage: "server",
        priority: 0,
        decision: "allow",
        values: [serverId],
      },
    ]);

    assert.deepEqual(await evaluateFeatureFlag({ key, serverId, platform: "web" }), {
      key,
      enabled: true,
      reason: "server_rule",
    });
    assert.deepEqual(await evaluateFeatureFlag({ key, serverId, platform: "mobile" }), {
      key,
      enabled: false,
      reason: "platform_rule",
    });
    assert.deepEqual(await evaluateFeatureFlag({ key, serverId }), {
      key,
      enabled: true,
      reason: "server_rule",
    });
  } finally {
    await close();
  }
});

test("feature flags: earlier-priority server deny overrides server allow", async () => {
  const { close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const db = getDb();
    const serverId = "00000000-0000-4000-8000-00000000dd01";
    const key = "server_deny_priority_v0";

    await db.insert(featureFlags).values({
      key,
      randomizationUnit: "server",
      defaultEnabled: false,
      salt: "server-deny-priority",
    });
    await db.insert(featureFlagRules).values([
      {
        flagKey: key,
        stage: "server",
        priority: 0,
        decision: "allow",
        values: [serverId],
      },
      {
        flagKey: key,
        stage: "server",
        priority: -10,
        decision: "deny",
        values: [serverId],
      },
    ]);

    assert.deepEqual(await evaluateFeatureFlag({ key, serverId }), {
      key,
      enabled: false,
      reason: "server_rule",
    });
  } finally {
    await close();
  }
});

test("feature flags: plan rules use effective server entitlement", async () => {
  const { close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const db = getDb();
    const passwordHash = await argon2.hash("password123");
    const [owner] = await db.insert(users).values({
      email: "feature-plan-owner@slock.test",
      name: "feature-plan-owner",
      passwordHash,
      emailVerified: true,
    }).returning();
    const server = await createServer("Feature Plan", "feature-plan", owner.id);
    await db.update(servers).set({ plan: "pro" }).where(eq(servers.id, server.id));

    const key = "plan_test_v0";
    await db.insert(featureFlags).values({
      key,
      randomizationUnit: "server",
      defaultEnabled: false,
      salt: "plan-test-salt",
    });
    await db.insert(featureFlagRules).values({
      flagKey: key,
      stage: "plan",
      decision: "allow",
      values: ["pro"],
    });

    assert.deepEqual(await evaluateFeatureFlag({ key, serverId: server.id }), {
      key,
      enabled: true,
      reason: "plan_rule",
    });

    await db.update(servers).set({ plan: "free" }).where(eq(servers.id, server.id));
    assert.deepEqual(await evaluateFeatureFlag({ key, serverId: server.id }), {
      key,
      enabled: false,
      reason: "default",
    });
  } finally {
    await close();
  }
});

test("feature flags: pro plan rules match the Pro-entitled billing cohort", async () => {
  const originalDateNow = Date.now;
  Date.now = () => new Date("2026-06-24T00:00:00Z").getTime();
  let close: (() => Promise<void>) | undefined;
  try {
    ({ close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false }));
    const db = getDb();
    const passwordHash = await argon2.hash("password123");
    const [owner] = await db.insert(users).values({
      email: "feature-pro-cohort-owner@slock.test",
      name: "feature-pro-cohort-owner",
      passwordHash,
      emailVerified: true,
    }).returning();
    const server = await createServer("Feature Pro Cohort", "feature-pro-cohort", owner.id);

    const key = "plan_pro_cohort_test_v0";
    await db.insert(featureFlags).values({
      key,
      randomizationUnit: "server",
      defaultEnabled: false,
      salt: "plan-pro-cohort-test-salt",
    });
    await db.insert(featureFlagRules).values({
      flagKey: key,
      stage: "plan",
      decision: "allow",
      values: ["pro"],
    });

    for (const plan of ["pro", "founder", "partner"] as const) {
      await db.update(servers).set({ plan }).where(eq(servers.id, server.id));
      assert.deepEqual(await evaluateFeatureFlag({ key, serverId: server.id }), {
        key,
        enabled: true,
        reason: "plan_rule",
      }, `${plan} must inherit pro-gated feature flags`);
    }

    await db.update(servers).set({ plan: "free" }).where(eq(servers.id, server.id));
    Date.now = () => new Date("2026-06-14T00:00:00Z").getTime();
    assert.deepEqual(await evaluateFeatureFlag({ key, serverId: server.id }), {
      key,
      enabled: true,
      reason: "plan_rule",
    }, "an active full-featured Free trial must inherit pro-gated feature flags");

    Date.now = () => new Date("2026-06-24T00:00:00Z").getTime();
    assert.deepEqual(await evaluateFeatureFlag({ key, serverId: server.id }), {
      key,
      enabled: false,
      reason: "default",
    }, "post-trial Free stays outside pro-gated feature flags");
  } finally {
    Date.now = originalDateNow;
    await close?.();
  }
});

test("feature flags: trial Free keeps deterministic plan-rule priority", async () => {
  const originalDateNow = Date.now;
  Date.now = () => new Date("2026-06-14T00:00:00Z").getTime();
  let close: (() => Promise<void>) | undefined;
  try {
    ({ close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false }));
    const db = getDb();
    const passwordHash = await argon2.hash("password123");
    const [owner] = await db.insert(users).values({
      email: "feature-trial-priority-owner@slock.test",
      name: "feature-trial-priority-owner",
      passwordHash,
      emailVerified: true,
    }).returning();
    const server = await createServer("Feature Trial Priority", "feature-trial-priority", owner.id);

    const key = "trial_plan_priority_test_v0";
    await db.insert(featureFlags).values({
      key,
      randomizationUnit: "server",
      defaultEnabled: false,
      salt: "trial-plan-priority-test-salt",
    });
    await db.insert(featureFlagRules).values([
      {
        flagKey: key,
        stage: "plan",
        priority: 10,
        decision: "allow",
        values: ["free"],
        variant: "free-exact",
      },
      {
        flagKey: key,
        stage: "plan",
        priority: 0,
        decision: "allow",
        values: ["pro"],
        variant: "pro-cohort",
      },
    ]);

    assert.deepEqual(await evaluateFeatureFlag({ key, serverId: server.id }), {
      key,
      enabled: true,
      reason: "plan_rule",
      variant: "pro-cohort",
    }, "trial Free can match a higher-priority pro allow-rule through the Pro-capable cohort");

    await db.insert(featureFlagRules).values({
      flagKey: key,
      stage: "plan",
      priority: -10,
      decision: "deny",
      values: ["pro"],
    });

    assert.deepEqual(await evaluateFeatureFlag({ key, serverId: server.id }), {
      key,
      enabled: true,
      reason: "plan_rule",
      variant: "pro-cohort",
    }, "pro deny-rules remain exact-plan only until product explicitly defines cohort deny semantics");
  } finally {
    Date.now = originalDateNow;
    await close?.();
  }
});

test("feature flags: lab stage is effective only for master-on open enrolled servers and precedes plan", async () => {
  const { close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const db = getDb();
    const [owner] = await db.insert(users).values({
      email: "feature-lab-owner@slock.test",
      name: "feature-lab-owner",
      passwordHash: "unused-test-hash",
      emailVerified: true,
    }).returning();
    const [server] = await db.insert(servers).values({
      name: "Feature Lab",
      slug: "feature-lab",
      ownerId: owner.id,
      plan: "pro",
    }).returning();
    await db.insert(labDefinitions).values({
      key: "composer_lab",
      name: "Composer Lab",
      description: "Try the next composer.",
      state: "open",
    });
    await db.insert(serverLabAccess).values({
      serverId: server.id,
      enabled: true,
      version: 1,
      updatedByActorType: "human",
      updatedByActorId: owner.id,
    });
    await db.insert(serverLabEnrollments).values({
      serverId: server.id,
      labKey: "composer_lab",
      enabled: true,
      version: 1,
      updatedByActorType: "agent",
      updatedByActorId: "00000000-0000-4000-8000-00000000a917",
    });

    const key = "lab_stage_precedence_v0";
    await db.insert(featureFlags).values({
      key,
      randomizationUnit: "server",
      defaultEnabled: false,
      salt: "lab-stage-precedence",
    });
    await db.insert(featureFlagRules).values([
      {
        flagKey: key,
        stage: "server",
        priority: -10,
        decision: "deny",
        values: [server.id],
      },
      {
        flagKey: key,
        stage: "lab",
        priority: 0,
        decision: "allow",
        values: ["composer_lab"],
      },
      {
        flagKey: key,
        stage: "plan",
        priority: 0,
        decision: "deny",
        values: ["pro"],
      },
    ]);

    assert.deepEqual(await evaluateFeatureFlag({ key, serverId: server.id }), {
      key,
      enabled: false,
      reason: "server_rule",
    });

    await db.delete(featureFlagRules).where(and(
      eq(featureFlagRules.flagKey, key),
      eq(featureFlagRules.stage, "server"),
    ));
    assert.deepEqual(await evaluateFeatureFlag({ key, serverId: server.id }), {
      key,
      enabled: true,
      reason: "lab_rule",
    });

    await db.update(serverLabAccess).set({ enabled: false }).where(eq(serverLabAccess.serverId, server.id));
    assert.deepEqual(await evaluateFeatureFlag({ key, serverId: server.id }), {
      key,
      enabled: false,
      reason: "plan_rule",
    }, "master OFF preserves enrollment but makes the lab stage no-match");

    await db.update(serverLabAccess).set({ enabled: true }).where(eq(serverLabAccess.serverId, server.id));
    await db.update(labDefinitions).set({ state: "paused" }).where(eq(labDefinitions.key, "composer_lab"));
    assert.deepEqual(await evaluateFeatureFlag({ key, serverId: server.id }), {
      key,
      enabled: false,
      reason: "plan_rule",
    }, "paused catalog remains enrolled but cannot match");

    await db.update(labDefinitions).set({ state: "open" }).where(eq(labDefinitions.key, "composer_lab"));
    assert.deepEqual(await evaluateFeatureFlag({ key, serverId: server.id }), {
      key,
      enabled: true,
      reason: "lab_rule",
    }, "reopening the Lab restores the retained enrollment and existing rule without a rewrite");
    await db.update(serverLabEnrollments).set({ enabled: false }).where(and(
      eq(serverLabEnrollments.serverId, server.id),
      eq(serverLabEnrollments.labKey, "composer_lab"),
    ));
    assert.deepEqual(await evaluateFeatureFlag({ key, serverId: server.id }), {
      key,
      enabled: false,
      reason: "plan_rule",
    }, "disabled enrollment cannot match");

    await db.update(serverLabEnrollments).set({ enabled: true }).where(and(
      eq(serverLabEnrollments.serverId, server.id),
      eq(serverLabEnrollments.labKey, "composer_lab"),
    ));
    assert.deepEqual(await evaluateFeatureFlag({ key, serverId: server.id }), {
      key,
      enabled: true,
      reason: "lab_rule",
    }, "resume and master re-enable restore the preserved enrollment");

    await db.execute(sql`DROP TABLE server_lab_enrollments`);
    assert.deepEqual(await evaluateFeatureFlag({ key, serverId: server.id }), {
      key,
      enabled: false,
      reason: "plan_rule",
    }, "an unavailable Lab preload fails closed to no-match instead of fabricating enrollment");
  } finally {
    await close();
  }
});

test("feature flags: lab rule priority is first-match and variants remain out of v1", async () => {
  const { close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const db = getDb();
    const [owner] = await db.insert(users).values({
      email: "feature-lab-priority-owner@slock.test",
      name: "feature-lab-priority-owner",
      passwordHash: "unused-test-hash",
      emailVerified: true,
    }).returning();
    const [server] = await db.insert(servers).values({
      name: "Feature Lab Priority",
      slug: "feature-lab-priority",
      ownerId: owner.id,
    }).returning();
    await db.insert(labDefinitions).values({
      key: "priority_lab",
      name: "Priority Lab",
      description: "Priority contract.",
      state: "open",
    });
    await db.insert(serverLabAccess).values({ serverId: server.id, enabled: true });
    await db.insert(serverLabEnrollments).values({
      serverId: server.id,
      labKey: "priority_lab",
      enabled: true,
    });
    const key = "lab_priority_v0";
    await db.insert(featureFlags).values({
      key,
      randomizationUnit: "server",
      defaultEnabled: true,
      salt: "lab-priority",
    });
    await db.insert(featureFlagRules).values([
      { flagKey: key, stage: "lab", priority: 10, decision: "allow", values: ["priority_lab"] },
      { flagKey: key, stage: "lab", priority: -10, decision: "deny", values: ["priority_lab"] },
    ]);

    assert.deepEqual(await evaluateFeatureFlag({ key, serverId: server.id }), {
      key,
      enabled: false,
      reason: "lab_rule",
    });
    await assert.rejects(
      createFeatureFlagRule({
        flagKey: key,
        stage: "lab",
        decision: "allow",
        values: ["priority_lab"],
        variant: "treatment",
      }),
      /variants are not supported in v1/,
    );
    await assert.rejects(
      db.insert(featureFlagRules).values({
        flagKey: key,
        stage: "lab",
        decision: "allow",
        values: ["priority_lab"],
        variant: "direct-db-treatment",
      }),
      causedByConstraint("feature_flag_rules_lab_shape_valid"),
    );
  } finally {
    await close();
  }
});

test("feature flags: Server Labs Web UI gate cannot bootstrap itself through a lab rule", async () => {
  const { close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const db = getDb();
    await db.insert(featureFlags).values({
      key: SERVER_LABS_UI_FEATURE_FLAG_KEY,
      randomizationUnit: "server",
      defaultEnabled: false,
      salt: "server-labs-ui-test",
    }).onConflictDoNothing();
    await assert.rejects(
      createFeatureFlagRule({
        flagKey: SERVER_LABS_UI_FEATURE_FLAG_KEY,
        stage: "lab",
        decision: "allow",
        values: ["composer_lab"],
      }),
      /cannot use Lab feature-flag rules/,
    );
    const rule = await createFeatureFlagRule({
      flagKey: SERVER_LABS_UI_FEATURE_FLAG_KEY,
      stage: "server",
      decision: "allow",
      values: ["00000000-0000-4000-8000-00000000ff62"],
    });
    await assert.rejects(
      updateFeatureFlagRule(SERVER_LABS_UI_FEATURE_FLAG_KEY, rule.id, {
        stage: "lab",
        values: ["composer_lab"],
      }),
      /cannot use Lab feature-flag rules/,
    );
    const preserved = await updateFeatureFlagRule(SERVER_LABS_UI_FEATURE_FLAG_KEY, rule.id, {
      priority: 5,
      values: [
        "00000000-0000-4000-8000-00000000ff62",
        "00000000-0000-4000-8000-00000000ff63",
      ],
    });
    assert.equal(preserved?.stage, "server");
    assert.equal(preserved?.priority, 5);
    assert.deepEqual(preserved?.values, [
      "00000000-0000-4000-8000-00000000ff62",
      "00000000-0000-4000-8000-00000000ff63",
    ]);
  } finally {
    await close();
  }
});

test("Labs schema preserves agent actor parity and append-only server-version audit identity", async () => {
  const { close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const db = getDb();
    const [owner] = await db.insert(users).values({
      email: "feature-lab-audit-owner@slock.test",
      name: "feature-lab-audit-owner",
      passwordHash: "unused-test-hash",
      emailVerified: true,
    }).returning();
    const [server] = await db.insert(servers).values({
      name: "Feature Lab Audit",
      slug: "feature-lab-audit",
      ownerId: owner.id,
    }).returning();
    await db.insert(labDefinitions).values({
      key: "audit_lab",
      name: "Audit Lab",
      description: "Audit contract.",
      state: "open",
    });
    await db.insert(serverLabAccess).values({ serverId: server.id, enabled: false });

    await assert.rejects(
      db.update(serverLabAccess).set({ updatedByActorType: "agent", updatedByActorId: null }).where(eq(serverLabAccess.serverId, server.id)),
      causedByConstraint("server_lab_access_actor_complete"),
    );

    const [audit] = await db.insert(serverLabAuditEvents).values({
      serverId: server.id,
      versionBefore: 0,
      versionAfter: 1,
      operation: "enrollment_set",
      labKey: "audit_lab",
      actorType: "agent",
      actorId: "00000000-0000-4000-8000-00000000a917",
      requestId: "request-labs-audit-1",
      before: { enabled: false },
      after: { enabled: true },
    }).returning();
    assert.equal(audit.actorType, "agent");

    await assert.rejects(
      db.insert(serverLabAuditEvents).values({
        serverId: server.id,
        versionBefore: 1,
        versionAfter: 1,
        operation: "master_access_set",
        labKey: null,
        actorType: "human",
        actorId: owner.id,
        requestId: "request-labs-audit-invalid-step",
        before: { enabled: false },
        after: { enabled: true },
      }),
      causedByConstraint("server_lab_audit_events_version_step"),
    );
    await assert.rejects(
      db.insert(serverLabAuditEvents).values({
        serverId: server.id,
        versionBefore: 1,
        versionAfter: 2,
        operation: "master_access_set",
        labKey: "audit_lab",
        actorType: "human",
        actorId: owner.id,
        requestId: "request-labs-audit-invalid-target",
        before: { enabled: false },
        after: { enabled: true },
      }),
      causedByConstraint("server_lab_audit_events_lab_key_matches_operation"),
    );
  } finally {
    await close();
  }
});

test("feature flags: batch Lab and plan preload query count is constant for 1/10/50 flags", async () => {
  const client = new PGlite();
  await migratePglite(client);
  const db = drizzlePglite(client, { schema: dbSchema }) as unknown as DatabaseExecutor;
  try {
    const [owner] = await db.insert(users).values({
      email: "feature-lab-batch-owner@slock.test",
      name: "feature-lab-batch-owner",
      passwordHash: "unused-test-hash",
      emailVerified: true,
    }).returning();
    const [server] = await db.insert(servers).values({
      name: "Feature Lab Batch",
      slug: "feature-lab-batch",
      ownerId: owner.id,
      plan: "pro",
    }).returning();
    await db.insert(labDefinitions).values({
      key: "batch_lab",
      name: "Batch Lab",
      description: "Batch query contract.",
      state: "open",
    });
    await db.insert(serverLabAccess).values({ serverId: server.id, enabled: true });
    await db.insert(serverLabEnrollments).values({ serverId: server.id, labKey: "batch_lab", enabled: true });

    const flagRows = Array.from({ length: 50 }, (_, index) => ({
      key: `batch_lab_${String(index).padStart(2, "0")}_v0`,
      randomizationUnit: "server" as const,
      defaultEnabled: false,
      salt: `batch-lab-${index}`,
    }));
    await db.insert(featureFlags).values(flagRows);
    await db.insert(featureFlagRules).values(flagRows.flatMap((flag) => [
      { flagKey: flag.key, stage: "lab" as const, decision: "allow" as const, values: ["batch_lab"] },
      { flagKey: flag.key, stage: "plan" as const, decision: "deny" as const, values: ["pro"] },
    ]));

    let queryCount = 0;
    const originalQuery = client.query.bind(client);
    client.query = ((query: string, params?: unknown[], options?: unknown) => {
      queryCount += 1;
      return originalQuery(query, params, options as never);
    }) as typeof client.query;

    const counts: number[] = [];
    for (const size of [1, 10, 50]) {
      queryCount = 0;
      const evaluations = await evaluateFeatureFlags(
        flagRows.slice(0, size).map((flag) => ({ key: flag.key, serverId: server.id })),
        db,
      );
      counts.push(queryCount);
      assert.equal(evaluations.length, size);
      assert.equal(evaluations.every((evaluation) => evaluation.enabled && evaluation.reason === "lab_rule"), true);
    }
    assert.deepEqual(counts, [4, 4, 4], "flags + rules + Labs + plan each stay one query per batch");
  } finally {
    await client.close();
  }
});

// Behavioral guard for the 2026-09-07 entitlement mismatch: Pro-gated seeded
// flags must evaluate through the whole Pro-capable billing cohort.
test("feature flags: llm_translation_v0 is enabled for pro and for the comp plans", async () => {
  const { close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const db = getDb();
    const passwordHash = await argon2.hash("password123");
    const [owner] = await db.insert(users).values({
      email: "llm-translation-plan-owner@slock.test",
      name: "llm-translation-plan-owner",
      passwordHash,
      emailVerified: true,
    }).returning();
    const server = await createServer("LLM Translation Plan", "llm-translation-plan", owner.id);

    for (const plan of ["pro", "founder", "partner"] as const) {
      await db.update(servers).set({ plan }).where(eq(servers.id, server.id));
      assert.deepEqual(
        await evaluateFeatureFlag({ key: LLM_TRANSLATION_FEATURE_FLAG_KEY, serverId: server.id }),
        { key: LLM_TRANSLATION_FEATURE_FLAG_KEY, enabled: true, reason: "plan_rule" },
        `${plan} must resolve through the plan rule, not fall through to the flag default`,
      );
    }

    await db.update(servers).set({ plan: "free" }).where(eq(servers.id, server.id));
    assert.deepEqual(
      await evaluateFeatureFlag({ key: LLM_TRANSLATION_FEATURE_FLAG_KEY, serverId: server.id }),
      { key: LLM_TRANSLATION_FEATURE_FLAG_KEY, enabled: false, reason: "default" },
      "free stays outside the paid gate",
    );
  } finally {
    await close();
  }
});
