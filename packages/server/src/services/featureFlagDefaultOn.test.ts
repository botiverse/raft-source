// Task #255: FEATURE_FLAGS_DEFAULT_ON flips the final `default_enabled`
// fallback of evaluateFlagRow and of the pre-auth evaluator, and answers a key
// with no row on (evaluateFlagRow only). Kill switch, enabled=false and every
// matching rule keep their answers; exception keys keep stored defaults. No
// server is exempt: the retired FEATURE_FLAGS_DEFAULT_ON_EXCEPT_SERVERS is
// ignored. Env is injected through the evaluators' `env` parameter.
import { dbTest as test } from "../test/integration/dbTest";
import assert from "node:assert/strict";
import { FEATURE_FLAG_DEFAULT_ON_EXCEPTIONS } from "@botiverse/raft-shared";
import { featureFlagRules, featureFlags } from "../db/schema";
import {
  evaluateFeatureFlag,
  evaluateFeatureFlags,
  evaluatePreAuthFeatureFlags,
  featureFlagDefaultPolicy,
  featureFlagDefaultPolicyStartupLine,
} from "./featureFlagService";

const SERVER_A = "00000000-0000-4000-8000-0000000255a1";
/** Named by the retired FEATURE_FLAGS_DEFAULT_ON_EXCEPT_SERVERS in ON, which must change nothing. */
const SERVER_B = "00000000-0000-4000-8000-0000000255b1";
const USER = "00000000-0000-4000-8000-0000000255c1";
const OFF: NodeJS.ProcessEnv = {};
const ON: NodeJS.ProcessEnv = {
  DEPLOYMENT_ENV: "staging",
  FEATURE_FLAGS_DEFAULT_ON: "true",
  FEATURE_FLAGS_DEFAULT_ON_EXCEPT_SERVERS: ` ${SERVER_B.toUpperCase()} , `,
};

test("featureFlagDefaultPolicy reads only true/1 from the injected env", () => {
  assert.equal(featureFlagDefaultPolicy({}).defaultOn, false);
  for (const raw of ["true", "TRUE", " 1 "]) assert.equal(featureFlagDefaultPolicy({ DEPLOYMENT_ENV: "staging", FEATURE_FLAGS_DEFAULT_ON: raw }).defaultOn, true, raw);
  for (const raw of ["", "0", "false", "yes", "on"]) assert.equal(featureFlagDefaultPolicy({ DEPLOYMENT_ENV: "staging", FEATURE_FLAGS_DEFAULT_ON: raw }).defaultOn, false, raw);
  assert.deepEqual(featureFlagDefaultPolicy(ON), { defaultOn: true });
});

test("default-on flips only the fallback; precedence is unchanged", async ({ db }) => {
  await db.insert(featureFlags).values([
    { key: "t255_plain_v0", randomizationUnit: "server", defaultEnabled: false, defaultVariant: "v2", salt: "t255" },
    { key: "t255_killed_v0", randomizationUnit: "server", defaultEnabled: false, killSwitch: true, salt: "t255" },
    { key: "t255_disabled_v0", randomizationUnit: "server", defaultEnabled: false, enabled: false, salt: "t255" },
    { key: "t255_denied_v0", randomizationUnit: "server", defaultEnabled: false, salt: "t255" },
    { key: "t255_user_deny_v0", randomizationUnit: "user", defaultEnabled: false, salt: "t255" },
    { key: "t255_platform_deny_v0", randomizationUnit: "server", defaultEnabled: false, salt: "t255" },
    { key: "t255_stored_on_v0", randomizationUnit: "server", defaultEnabled: true, salt: "t255" },
    { key: "slack_bridge_v0", randomizationUnit: "server", defaultEnabled: false, salt: "t255" },
    { key: "antiproton_t255_v0", randomizationUnit: "server", defaultEnabled: false, salt: "t255" },
  ]).onConflictDoUpdate({ target: featureFlags.key, set: { defaultEnabled: false, enabled: true, killSwitch: false } });
  await db.insert(featureFlagRules).values([
    { flagKey: "t255_denied_v0", stage: "server", decision: "deny", values: [SERVER_A] },
    { flagKey: "t255_user_deny_v0", stage: "user", decision: "deny", values: [USER] },
    { flagKey: "t255_platform_deny_v0", stage: "platform", decision: "deny", values: ["mobile"] },
  ]);
  const evaluate = (env: NodeJS.ProcessEnv, key: string, context: { serverId?: string; userId?: string; platform?: "web" | "mobile" } = { serverId: SERVER_A }) =>
    evaluateFeatureFlag({ key, ...context }, db, env);

  // Env off: unchanged.
  assert.deepEqual(await evaluate(OFF, "t255_plain_v0"), { key: "t255_plain_v0", enabled: false, reason: "default" });
  // Env on: a default-off row answers on, with its default variant.
  assert.deepEqual(await evaluate(ON, "t255_plain_v0"), { key: "t255_plain_v0", enabled: true, reason: "default", variant: "v2" });
  assert.deepEqual(await evaluate(ON, "t255_stored_on_v0"), { key: "t255_stored_on_v0", enabled: true, reason: "default" });
  // Earlier steps still win.
  assert.deepEqual(await evaluate(ON, "t255_killed_v0"), { key: "t255_killed_v0", enabled: false, reason: "kill_switch" });
  assert.deepEqual(await evaluate(ON, "t255_disabled_v0"), { key: "t255_disabled_v0", enabled: false, reason: "flag_disabled" });
  assert.deepEqual(await evaluate(ON, "t255_denied_v0"), { key: "t255_denied_v0", enabled: false, reason: "server_rule" });
  assert.deepEqual(await evaluate(ON, "t255_user_deny_v0", { userId: USER }), { key: "t255_user_deny_v0", enabled: false, reason: "user_rule" });
  assert.deepEqual(await evaluate(ON, "t255_platform_deny_v0", { serverId: SERVER_A, platform: "mobile" }), { key: "t255_platform_deny_v0", enabled: false, reason: "platform_rule" });
  // The missing-unit guard is before the fallback too.
  assert.deepEqual(await evaluate(ON, "t255_plain_v0", { userId: USER }), { key: "t255_plain_v0", enabled: false, reason: "missing_server_unit" });
  // Exceptions (exact and prefix) keep the stored default.
  assert.ok(FEATURE_FLAG_DEFAULT_ON_EXCEPTIONS.slack_bridge_v0);
  assert.deepEqual(await evaluate(ON, "slack_bridge_v0"), { key: "slack_bridge_v0", enabled: false, reason: "default" });
  assert.deepEqual(await evaluate(ON, "antiproton_t255_v0"), { key: "antiproton_t255_v0", enabled: false, reason: "default" });
  // No server keeps stored defaults, including one the retired var names.
  assert.deepEqual(await evaluateFeatureFlags([
    { key: "t255_plain_v0", serverId: SERVER_B },
    { key: "t255_plain_v0", serverId: SERVER_A },
  ], db, ON), [
    { key: "t255_plain_v0", enabled: true, reason: "default", variant: "v2" },
    { key: "t255_plain_v0", enabled: true, reason: "default", variant: "v2" },
  ]);
});

test("the pre-auth evaluator follows default-on for marked rows only", async ({ db }) => {
  await db.insert(featureFlags).values([
    { key: "t255_pre_auth_v0", randomizationUnit: "user", defaultEnabled: false, preAuthEvaluable: true, salt: "t255" },
    { key: "t255_pre_auth_deny_v0", randomizationUnit: "user", defaultEnabled: false, preAuthEvaluable: true, salt: "t255" },
    { key: "t255_pre_auth_killed_v0", randomizationUnit: "user", defaultEnabled: false, preAuthEvaluable: true, killSwitch: true, salt: "t255" },
    { key: "t255_unmarked_v0", randomizationUnit: "user", defaultEnabled: false, salt: "t255" },
  ]);
  // A pre-auth exception key (seeded by migration 0211) keeps its stored default.
  await db.insert(featureFlags)
    .values({ key: "apple_web_login_v0", randomizationUnit: "user", defaultEnabled: false, preAuthEvaluable: true, salt: "t255" })
    .onConflictDoUpdate({ target: featureFlags.key, set: { enabled: true, killSwitch: false, defaultEnabled: false, preAuthEvaluable: true } });
  await db.insert(featureFlagRules).values({ flagKey: "t255_pre_auth_deny_v0", stage: "platform", decision: "deny", values: ["mobile"] });
  const keys = ["t255_pre_auth_v0", "t255_pre_auth_deny_v0", "t255_pre_auth_killed_v0", "t255_unmarked_v0", "t255_missing_v0", "apple_web_login_v0"];

  assert.deepEqual(await evaluatePreAuthFeatureFlags(keys, "mobile", db, OFF), {
    t255_pre_auth_v0: false, t255_pre_auth_deny_v0: false, t255_pre_auth_killed_v0: false,
    t255_unmarked_v0: false, t255_missing_v0: false, apple_web_login_v0: false,
  });
  // Marked rows only; a missing or unmarked key stays off before login.
  assert.deepEqual(await evaluatePreAuthFeatureFlags(keys, "mobile", db, ON), {
    t255_pre_auth_v0: true, t255_pre_auth_deny_v0: false, t255_pre_auth_killed_v0: false,
    t255_unmarked_v0: false, t255_missing_v0: false, apple_web_login_v0: false,
  });
  assert.equal((await evaluatePreAuthFeatureFlags(["t255_pre_auth_deny_v0"], "web", db, ON)).t255_pre_auth_deny_v0, true);
});

test("a key with no row: on under default-on, off without it, off for exceptions", async ({ db }) => {
  const missing = (env: NodeJS.ProcessEnv, key: string, serverId: string | undefined = SERVER_A) =>
    evaluateFeatureFlag({ key, serverId, userId: USER }, db, env);
  assert.deepEqual(await missing(OFF, "t255_missing_v0"), { key: "t255_missing_v0", enabled: false, reason: "missing_flag" });
  assert.deepEqual(await missing(ON, "t255_missing_v0"), { key: "t255_missing_v0", enabled: true, reason: "missing_flag" });
  // No server in the context: on too.
  assert.deepEqual(await missing(ON, "t255_missing_v0", undefined), { key: "t255_missing_v0", enabled: true, reason: "missing_flag" });
  // Exact and prefix exceptions (neither has a row in a fresh database).
  assert.deepEqual(await missing(ON, "computer_version_enforcement"), { key: "computer_version_enforcement", enabled: false, reason: "missing_flag" });
  assert.deepEqual(await missing(ON, "agent_runtime_oar_t255"), { key: "agent_runtime_oar_t255", enabled: false, reason: "missing_flag" });
  assert.deepEqual(await missing(ON, "t255_missing_v0", SERVER_B), { key: "t255_missing_v0", enabled: true, reason: "missing_flag" });
  // The batch answers each input on its own.
  assert.deepEqual((await evaluateFeatureFlags([
    { key: "t255_missing_v0", serverId: SERVER_B },
    { key: "t255_missing_v0", serverId: SERVER_A },
    { key: "remote_computer_upgrade_hold_linux", serverId: SERVER_A },
  ], db, ON)).map((evaluation) => evaluation.enabled), [true, true, false]);
});

test("FEATURE_FLAGS_DEFAULT_ON changes nothing unless DEPLOYMENT_ENV is staging", async ({ db }) => {
  for (const deployment of ["production", undefined, "", "Staging", "slockdev"]) {
    const env: NodeJS.ProcessEnv = { ...ON, DEPLOYMENT_ENV: deployment };
    if (deployment === undefined) delete env.DEPLOYMENT_ENV;
    assert.equal(featureFlagDefaultPolicy(env).defaultOn, false, String(deployment));
    assert.equal(featureFlagDefaultPolicyStartupLine(env), null, String(deployment));
    const missing = await evaluateFeatureFlag({ key: "task255_no_row_prod_guard", serverId: SERVER_A, userId: USER }, db, env);
    assert.equal(missing.enabled, false, String(deployment));
    const preAuth = await evaluatePreAuthFeatureFlags(["task255_no_row_prod_guard"], null, db, env);
    assert.equal(preAuth.task255_no_row_prod_guard, false, String(deployment));
  }
  assert.match(featureFlagDefaultPolicyStartupLine(ON) ?? "", /default ON \(staging/);
});
