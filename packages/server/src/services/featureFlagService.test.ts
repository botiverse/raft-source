import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import argon2 from "argon2";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { and, eq, sql } from "drizzle-orm";
import { MOBILE_INBOX_INPLACE_FEATURE_FLAG_KEY, WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { openTestApp } from "../test/integration/app";
import { openTestApp as startTestApp } from "../test/integration/app";
import { getDb, type DatabaseExecutor } from "../db/index";
import { migratePglite } from "../db/pgliteMigrations";
import * as dbSchema from "../db/schema";
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
} from "../db/schema";
import { createServer } from "./serverService";
import {
  AGENT_READ_PROGRESS_FEATURE_FLAG_KEY,
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
} from "./featureFlagService";

function splitSqlTuple(tuple: string): string[] {
  const values: string[] = [];
  let start = 0;
  let quote = false;
  for (let index = 0; index < tuple.length; index += 1) {
    const char = tuple[index];
    if (char === "'") {
      if (quote && tuple[index + 1] === "'") {
        index += 1;
      } else {
        quote = !quote;
      }
    } else if (char === "," && !quote) {
      values.push(tuple.slice(start, index).trim());
      start = index + 1;
    }
  }
  values.push(tuple.slice(start).trim());
  return values;
}

function parseChannelJointMigration(sqlText: string): Record<string, string> {
  const match = sqlText.match(/INSERT\s+INTO\s+"feature_flags"\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/is);
  assert.ok(match, "channel conversion migration must contain a feature_flags INSERT");
  const columns = splitSqlTuple(match[1]).map((column) => column.replaceAll('"', "").trim());
  const values = splitSqlTuple(match[2]);
  assert.equal(columns.length, values.length, "migration INSERT columns and VALUES must stay positionally aligned");
  return Object.fromEntries(columns.map((column, index) => [column, values[index]]));
}
const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

function causedByConstraint(name: string) {
  return (error: unknown): boolean => {
    const cause = error && typeof error === "object" ? (error as { cause?: unknown }).cause : null;
    return cause instanceof Error && cause.message.includes(name);
  };
}

test("feature flags: reusable audiences match user OR server while direct rules retain precedence", async () => {
  const { close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
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

test("feature flags: a default-on flag's global kill switch is fresh for every context", async () => {
  const { close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const key = "kill_switch_fresh_v0";
    const serverId = "00000000-0000-4000-8000-00000000ff01";
    await createFeatureFlag({ key, randomizationUnit: "server", defaultEnabled: true, salt: "kill-switch-fresh" });
    const before = await evaluateFeatureFlag({
      key,
      serverId,
    });
    assert.deepEqual(before, {
      key,
      enabled: true,
      reason: "default",
    });

    await getDb()
      .update(featureFlags)
      .set({ killSwitch: true })
      .where(eq(featureFlags.key, key));

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
        key,
        ...context,
      }), {
        key,
        enabled: false,
        reason: "kill_switch",
      });
    }
  } finally {
    await close();
  }
});

test("feature flags: a default-on flag is immediately killable", async () => {
  const { close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const key = "default_on_kill_switch_v0";
    const serverId = "00000000-0000-4000-8000-00000000ff11";
    await createFeatureFlag({ key, randomizationUnit: "server", defaultEnabled: true, salt: "default-on-kill-switch" });
    assert.deepEqual(await evaluateFeatureFlag({ key, serverId }), {
      key,
      enabled: true,
      reason: "default",
    });

    await getDb()
      .update(featureFlags)
      .set({ killSwitch: true })
      .where(eq(featureFlags.key, key));

    assert.deepEqual(await evaluateFeatureFlag({ key, serverId }), {
      key,
      enabled: false,
      reason: "kill_switch",
    });
  } finally {
    await close();
  }
});

test("feature flags: seeded human Activity mute gate is default-off", async () => {
  const { close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: false });
  try {
    assert.deepEqual(await evaluateFeatureFlag({
      key: "human_activity_mute_v0",
      serverId: "00000000-0000-4000-8000-00000000ff11",
    }), {
      key: "human_activity_mute_v0",
      enabled: false,
      reason: "default",
    });
  } finally {
    await close();
  }
});

test("feature flags: config version cursor bumps on service writes", async () => {
  const { close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const initialVersion = await getFeatureFlagConfigVersion();
    assert.equal(await bumpFeatureFlagConfigVersion({ updatedBy: "test-operator" }), initialVersion + 1);
    assert.equal(await getFeatureFlagConfigVersion(), initialVersion + 1);

    const flag = await createFeatureFlag({
      key: "config_version_cursor_v0",
      randomizationUnit: "server",
      defaultEnabled: false,
      salt: "config-version-cursor",
    });
    assert.equal(flag.key, "config_version_cursor_v0");
    assert.equal(await getFeatureFlagConfigVersion(), initialVersion + 2);

    await updateFeatureFlag("config_version_cursor_v0", { defaultEnabled: true });
    assert.equal(await getFeatureFlagConfigVersion(), initialVersion + 3);

    const rule = await createFeatureFlagRule({
      flagKey: "config_version_cursor_v0",
      stage: "server",
      decision: "allow",
      values: ["00000000-0000-4000-8000-00000000dd01"],
    });
    assert.equal(await getFeatureFlagConfigVersion(), initialVersion + 4);

    await updateFeatureFlagRule("config_version_cursor_v0", rule.id, {
      values: ["00000000-0000-4000-8000-00000000dd01", "00000000-0000-4000-8000-00000000dd02"],
    });
    assert.equal(await getFeatureFlagConfigVersion(), initialVersion + 5);

    await deleteFeatureFlagRule("config_version_cursor_v0", rule.id);
    assert.equal(await getFeatureFlagConfigVersion(), initialVersion + 6);
  } finally {
    await close();
  }
});

test("feature flags: historical message forwarding row remains default-off", async () => {
  const { close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    assert.deepEqual(await evaluateFeatureFlag({
      key: "message_forwarding_v0",
      serverId: "00000000-0000-4000-8000-00000000ff21",
    }), {
      key: "message_forwarding_v0",
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

// The retired conversion flag's migration, as shipped (the key left code with #wg-rbac:#50).
const RETIRED_CHANNEL_TO_JOINT_CONVERSION_FLAG_KEY = "channel_to_joint_conversion_v0";

test("feature flags: channel-to-joint conversion is default-off without slug allowlists", () => {
  const migration = readFileSync(
    resolve(import.meta.dirname, "../../drizzle/0266_channel_joint_conversion.sql"),
    "utf8",
  );

  assert.match(migration, new RegExp(`'${RETIRED_CHANNEL_TO_JOINT_CONVERSION_FLAG_KEY}'`));
  assert.match(migration, /'server'/);
  const mapped = parseChannelJointMigration(migration);
  assert.equal(mapped.key, `'${RETIRED_CHANNEL_TO_JOINT_CONVERSION_FLAG_KEY}'`);
  assert.equal(mapped.default_enabled, "false", "channel conversion must be disabled by default");
  assert.equal(mapped.randomization_unit, "'server'");
  assert.doesNotMatch(migration, /INSERT INTO "feature_flag_rules"/);
  assert.doesNotMatch(migration, /botiverse/);
});

test("feature flags: channel-to-joint default-off assertion detects a default_enabled-only mutation", () => {
  const migrationPath = resolve(import.meta.dirname, "../../drizzle/0266_channel_joint_conversion.sql");
  const migration = readFileSync(migrationPath, "utf8");
  const mutated = migration.replace(/('server',\s*)false,/, "$1true,");
  assert.notEqual(mutated, migration, "mutation oracle must change only the default_enabled literal");
  assert.throws(
    () => assert.equal(parseChannelJointMigration(mutated).default_enabled, "false"),
  );
});

test("feature flags: thread-unread badge is default-off without allow rules", () => {
  const migration = readFileSync(
    resolve(import.meta.dirname, "../../drizzle/0353_thread_unread_badge_flag.sql"),
    "utf8",
  );

  const mapped = parseChannelJointMigration(migration);
  assert.equal(mapped.key, "'thread_unread_badge_v0'");
  assert.equal(mapped.enabled, "true");
  assert.equal(mapped.kill_switch, "false");
  assert.equal(mapped.default_enabled, "false", "thread-unread badge must be disabled by default");
  assert.equal(mapped.randomization_unit, "'server'");
  assert.doesNotMatch(migration, /INSERT INTO "feature_flag_rules"/);
});

test("feature flags: the continuation pilot is default-off, server-scoped, without allow rules", () => {
  const migration = readFileSync(
    resolve(import.meta.dirname, "../../drizzle/0464_continuations_pilot_flag.sql"),
    "utf8",
  );

  const mapped = parseChannelJointMigration(migration);
  assert.equal(mapped.key, "'continuations_pilot_v0'");
  assert.equal(mapped.enabled, "true");
  assert.equal(mapped.kill_switch, "false");
  assert.equal(mapped.default_enabled, "false", "every server keeps the draft flow until FFA allows it");
  assert.equal(mapped.randomization_unit, "'server'");
  assert.doesNotMatch(migration, /INSERT INTO "feature_flag_rules"/);
});

test("feature flags: computers rack overview is default-off without allow rules", () => {
  const migration = readFileSync(
    resolve(import.meta.dirname, "../../drizzle/0440_computers_rack_overview_flag.sql"),
    "utf8",
  );

  const mapped = parseChannelJointMigration(migration);
  assert.equal(mapped.key, "'computers_rack_overview_v0'");
  assert.equal(mapped.enabled, "true");
  assert.equal(mapped.kill_switch, "false");
  assert.equal(mapped.default_enabled, "false", "the rack overview must be disabled by default");
  assert.equal(mapped.randomization_unit, "'server'");
  assert.doesNotMatch(migration, /INSERT INTO "feature_flag_rules"/);
});

test("feature flags: web preview is default-off, server-scoped and without rules", () => {
  const migration = readFileSync(
    resolve(import.meta.dirname, "../../drizzle/0677_web_preview_flag.sql"),
    "utf8",
  );

  const mapped = parseChannelJointMigration(migration);
  assert.equal(mapped.key, "'web_preview_v0'");
  assert.equal(mapped.enabled, "true");
  assert.equal(mapped.kill_switch, "false");
  assert.equal(mapped.default_enabled, "false", "web preview must be disabled by default");
  assert.equal(mapped.randomization_unit, "'server'");
  assert.equal(mapped.pre_auth_evaluable, "false");
  assert.doesNotMatch(migration, /INSERT INTO "feature_flag_rules"/);
});

test("feature flags: inbox read in place (#244 step 3a) is default-off, server-scoped and without rules", () => {
  const migration = readFileSync(
    resolve(import.meta.dirname, "../../drizzle/0678_inbox_read_inplace_flag.sql"),
    "utf8",
  );

  const mapped = parseChannelJointMigration(migration);
  assert.equal(mapped.key, "'inbox_read_inplace_v1'");
  assert.equal(mapped.enabled, "true");
  assert.equal(mapped.kill_switch, "false");
  assert.equal(mapped.default_enabled, "false", "inbox read in place must be disabled by default");
  assert.equal(mapped.randomization_unit, "'server'");
  assert.equal(mapped.pre_auth_evaluable, "false");
  assert.doesNotMatch(migration, /INSERT INTO "feature_flag_rules"/);
});

test("feature flags: mobile inbox in place (#245) is default-off, user-scoped and without rules", () => {
  const migration = readFileSync(
    resolve(import.meta.dirname, "../../drizzle/0679_mobile_inbox_inplace_flag.sql"),
    "utf8",
  );

  const mapped = parseChannelJointMigration(migration);
  assert.equal(mapped.key, "'mobile_inbox_inplace_v0'");
  assert.equal(mapped.key, `'${MOBILE_INBOX_INPLACE_FEATURE_FLAG_KEY}'`);
  assert.equal(mapped.enabled, "true");
  assert.equal(mapped.kill_switch, "false");
  assert.equal(mapped.default_enabled, "false", "mobile inbox in place must be disabled by default");
  assert.equal(mapped.randomization_unit, "'user'", "evaluated per user, so FFA can open it for internal users only");
  assert.equal(mapped.pre_auth_evaluable, "false");
  assert.doesNotMatch(migration, /INSERT INTO "feature_flag_rules"/);
});

test("feature flags: desktop web preview view is default-off, server-scoped and without rules", () => {
  const migration = readFileSync(
    resolve(import.meta.dirname, "../../drizzle/0686_desktop_web_preview_view_flag.sql"),
    "utf8",
  );

  const mapped = parseChannelJointMigration(migration);
  assert.equal(mapped.key, "'desktop_web_preview_view_v0'");
  assert.equal(mapped.enabled, "true");
  assert.equal(mapped.kill_switch, "false");
  assert.equal(mapped.default_enabled, "false", "the desktop web preview view must be disabled by default");
  assert.equal(mapped.randomization_unit, "'server'");
  assert.equal(mapped.pre_auth_evaluable, "false");
  assert.doesNotMatch(migration, /INSERT INTO "feature_flag_rules"/);
});

test("feature flags: deep links v1 is default-off, server-scoped and answerable before login", () => {
  const migration = readFileSync(
    resolve(import.meta.dirname, "../../drizzle/0436_deep_links_flag.sql"),
    "utf8",
  );

  const mapped = parseChannelJointMigration(migration);
  assert.equal(mapped.key, "'deep_links_v1'");
  assert.equal(mapped.enabled, "true");
  assert.equal(mapped.kill_switch, "false");
  assert.equal(mapped.default_enabled, "false", "deep links must be disabled by default");
  assert.equal(mapped.randomization_unit, "'server'");
  // The in-app browser guide also shows signed out, which only the pre-auth
  // endpoint can answer; it still answers false until FFA turns it on.
  assert.equal(mapped.pre_auth_evaluable, "true");
  assert.doesNotMatch(migration, /INSERT INTO "feature_flag_rules"/);
});

test("feature flags: drafts section is default-off and allowed for botiverse and raft only", () => {
  const migration = readFileSync(
    resolve(import.meta.dirname, "../../drizzle/0530_drafts_section_flag.sql"),
    "utf8",
  );

  const mapped = parseChannelJointMigration(migration);
  assert.equal(mapped.key, "'drafts_section_v0'");
  assert.equal(mapped.enabled, "true");
  assert.equal(mapped.kill_switch, "false");
  assert.equal(mapped.default_enabled, "false", "Drafts must be off by default");
  assert.equal(mapped.randomization_unit, "'server'");
  assert.equal(mapped.pre_auth_evaluable, "false");
  // artin (#triage:#127): on for the two servers trying it, nowhere else.
  assert.match(migration, /INSERT INTO "feature_flag_rules"/);
  assert.match(migration, /"slug" IN \('botiverse', 'raft'\)/);
  assert.match(migration, /'drafts_section_v0',\s*'server',\s*0,\s*'allow'/);
  assert.doesNotMatch(migration, /'deny'/);
  assert.doesNotMatch(migration, /'community'/);
});

test("feature flags: agent read progress is default-off, server-scoped and without rules", () => {
  const migration = readFileSync(
    resolve(import.meta.dirname, "../../drizzle/0576_agent_read_progress_flag.sql"),
    "utf8",
  );

  const mapped = parseChannelJointMigration(migration);
  assert.equal(mapped.key, `'${AGENT_READ_PROGRESS_FEATURE_FLAG_KEY}'`);
  assert.equal(mapped.enabled, "true");
  assert.equal(mapped.kill_switch, "false");
  assert.equal(mapped.default_enabled, "false", "agent read progress must be off by default");
  assert.equal(mapped.randomization_unit, "'server'");
  assert.equal(mapped.pre_auth_evaluable, "false");
  assert.doesNotMatch(migration, /INSERT INTO "feature_flag_rules"/);
});

test("feature flags: activity conversation list is default-off without allow rules", () => {
  const migration = readFileSync(
    resolve(import.meta.dirname, "../../drizzle/0362_activity_conversation_list_flag.sql"),
    "utf8",
  );

  const mapped = parseChannelJointMigration(migration);
  assert.equal(mapped.key, "'activity_conversation_list_v0'");
  assert.equal(mapped.enabled, "true");
  assert.equal(mapped.kill_switch, "false");
  assert.equal(mapped.default_enabled, "false", "activity conversation list must be disabled by default");
  assert.equal(mapped.randomization_unit, "'server'");
  assert.doesNotMatch(migration, /INSERT INTO "feature_flag_rules"/);
});

test("feature flags: workspace artifacts is default-off without allow rules", () => {
  // By name, not number: the branch's one migration is renumbered on every
  // staging merge (docs/development/workspace-artifacts.md).
  const drizzleDir = resolve(import.meta.dirname, "../../drizzle");
  const file = readdirSync(drizzleDir).find((entry) => /^\d{4}_workspace_artifacts\.sql$/.test(entry));
  assert.ok(file, "the workspace_artifacts migration exists");
  const migration = readFileSync(resolve(drizzleDir, file), "utf8");

  const mapped = parseChannelJointMigration(migration);
  assert.equal(mapped.key, `'${WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY}'`);
  assert.equal(mapped.enabled, "true");
  assert.equal(mapped.kill_switch, "false");
  assert.equal(mapped.default_enabled, "false", "workspace artifacts must be disabled by default");
  assert.equal(mapped.randomization_unit, "'server'");
  assert.doesNotMatch(migration, /INSERT INTO "feature_flag_rules"/);
});

test("feature flags: Activity v2 seed is globally default-off and allowlists slock-android", () => {
  const sql = readFileSync(
    resolve(import.meta.dirname, "../../drizzle/0206_activity_v2_feature_flag.sql"),
    "utf8",
  );

  assert.match(sql, /'activity_v2'/);
  assert.match(sql, /'server'/);
  assert.match(sql, /false/);
  assert.match(sql, /"slug" IN \('slock-android'\)/);
  assert.match(sql, /INSERT INTO "feature_flag_rules"/);
  assert.match(sql, /'allow'/);
  assert.doesNotMatch(sql, /'botiverse'/);
  assert.doesNotMatch(sql, /'community'/);
  assert.doesNotMatch(sql, /'community-cn'/);
});

test("feature flags: seeded Server Labs Web UI gate is default-off", async () => {
  const { close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
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

test("feature flags: Apple Web login seed has no rollout rule and preserves fail-closed defaults", () => {
  const sql = readFileSync(
    resolve(import.meta.dirname, "../../drizzle/0211_apple_web_login_feature_flag.sql"),
    "utf8",
  );

  assert.match(sql, /'apple_web_login_v0'/);
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

test("feature flags: an absent flag key evaluates default-off with missing_flag", async () => {
  const { close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    assert.deepEqual(await evaluateFeatureFlag({
      key: "test_absent_flag_gate_v0",
      serverId: "00000000-0000-4000-8000-00000000ff31",
      userId: "00000000-0000-4000-8000-00000000aa31",
    }), {
      key: "test_absent_flag_gate_v0",
      enabled: false,
      reason: "missing_flag",
    });
  } finally {
    await close();
  }
});

test("feature flags: server randomization fails closed without serverId and percent thresholds are deterministic", async () => {
  const { close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
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
  const { close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
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
  const { close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
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
  const { close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
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
  const { close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
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
    ({ close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true }));
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
    ({ close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true }));
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
  const { close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
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
  const { close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
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
  const { close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
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
  const { close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
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

    for (const source of ["ordinary", "appsumo"] as const) {
      if (source === "appsumo") {
        const { parseAppSumoLicenseKey } = await import("./appSumoContracts");
        const licenseKey = parseAppSumoLicenseKey("c8f3a7be-cf94-4e71-87b8-864a4c701801")!;
        await db.insert(dbSchema.appSumoLicenses).values({
          productId: "batch-query-test", licenseKey,
          tier: 2, status: "active", verifiedAt: new Date(),
        });
        await db.insert(dbSchema.appSumoLicenseBindings).values({
          productId: "batch-query-test", originalLicenseKey: licenseKey, currentLicenseKey: licenseKey,
          serverId: server.id, boundByUserId: owner.id, activatedAt: new Date(),
        });
      }
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
      // Plan is two batched reads since prepaid Pro (#12857): the entitlement
      // join, then the prepaid grants for the same server ids.
      assert.deepEqual(counts, [5, 5, 5], `${source}: flags + rules + Labs + plan (entitlements, prepaid grants) each stay one query per batch`);
    }
  } finally {
    await client.close();
  }
});

// Regression for the RFC-063 Stage 3 gate. evaluateFeatureFlags used to collapse
// a batch by key and answer each key from whichever input came first, so a batch
// that spans servers (the Activity totals read) got the first server's answer for
// every server. Both orderings are asserted because the bug is invisible in one
// of them: with the ramped server first, the wrong implementation looks right.
test("feature flags: a batch spanning servers answers each server on its own identity", async () => {
  const { close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const key = "server_ramp_batch_identity_v0";
    const rampedServerId = "00000000-0000-4000-8000-00000000ee01";
    const otherServerId = "00000000-0000-4000-8000-00000000ee02";
    await createFeatureFlag({ key, randomizationUnit: "server", defaultEnabled: false, salt: "server-ramp-batch-identity" });
    await createFeatureFlagRule({ flagKey: key, stage: "server", decision: "allow", values: [rampedServerId] });

    for (const order of [[rampedServerId, otherServerId], [otherServerId, rampedServerId]]) {
      const evaluations = await evaluateFeatureFlags(order.map((serverId) => ({ key, serverId })));
      assert.equal(evaluations.length, order.length, "one evaluation per input, not per distinct key");
      assert.deepEqual(
        order.map((serverId, index) => [serverId === rampedServerId, evaluations[index].enabled]),
        order.map((serverId) => [serverId === rampedServerId, serverId === rampedServerId]),
        `each server must be answered on its own identity, ramped server at position ${order.indexOf(rampedServerId)}`,
      );
      assert.equal(evaluations[order.indexOf(rampedServerId)].reason, "server_rule");
    }
  } finally {
    await close();
  }
});
