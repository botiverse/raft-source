import assert from "node:assert/strict";
import {
  FEATURE_FLAG_DEFAULT_ON_EXCEPTIONS,
  describeEffectiveDefault,
  effectiveDefaultEnabled,
  featureFlagDefaultOnException,
  featureFlagDefaultPolicyFromEnv,
  parseFeatureFlagsDefaultOn,
} from "./featureFlagDefaultPolicy";

const off = { key: "some_feature_v0", defaultEnabled: false };

test("default-on parses only true/1; no server is exempt", () => {
  for (const raw of ["true", "TRUE", " 1 ", "True"]) assert.equal(parseFeatureFlagsDefaultOn(raw), true, raw);
  for (const raw of [undefined, null, "", "0", "false", "on", "yes", "2"]) assert.equal(parseFeatureFlagsDefaultOn(raw), false, String(raw));
  // The retired FEATURE_FLAGS_DEFAULT_ON_EXCEPT_SERVERS is not read.
  const policy = featureFlagDefaultPolicyFromEnv({ FEATURE_FLAGS_DEFAULT_ON: "1", FEATURE_FLAGS_DEFAULT_ON_EXCEPT_SERVERS: "10000000-0000-4000-8000-000000000255" });
  assert.deepEqual(policy, { defaultOn: true });
  assert.equal(featureFlagDefaultPolicyFromEnv(undefined).defaultOn, false);
});

test("default-on off: the stored default is the answer", () => {
  assert.deepEqual(describeEffectiveDefault(off, { defaultOn: false }), { enabled: false, source: "stored" });
  assert.deepEqual(describeEffectiveDefault({ ...off, defaultEnabled: true }, { defaultOn: false }), { enabled: true, source: "stored" });
});

test("default-on: a stored-off fallback answers on, except for exceptions", () => {
  const policy = { defaultOn: true };
  assert.deepEqual(describeEffectiveDefault(off, policy), { enabled: true, source: "default_on" });
  // A stored-on fallback is never turned off.
  assert.deepEqual(describeEffectiveDefault({ ...off, defaultEnabled: true }, policy), { enabled: true, source: "stored" });
  assert.deepEqual(describeEffectiveDefault({ key: "pro_seat_add", defaultEnabled: false }, policy), {
    enabled: false,
    source: "exception",
    reason: FEATURE_FLAG_DEFAULT_ON_EXCEPTIONS.pro_seat_add,
  });
  assert.equal(effectiveDefaultEnabled({ key: "wiki_v0", defaultEnabled: false }, policy), false);
  // Focus is half built (state only, no delivery yet): off on staging too.
  assert.equal(effectiveDefaultEnabled({ key: "agent_focus_v0", defaultEnabled: false }, policy), false);
  // The DM reply placement prompt (#triage:#540) is on the standard policy: off in production, on under staging's default-on.
  const dmReplyPlacement = { key: "dm_reply_placement_prompt", defaultEnabled: false };
  assert.deepEqual(describeEffectiveDefault(dmReplyPlacement, policy), { enabled: true, source: "default_on" });
  assert.deepEqual(describeEffectiveDefault(dmReplyPlacement, { defaultOn: false }), { enabled: false, source: "stored" });
  // The wake-up notice with the Server's numbers (#wg-ax:#42) is on the standard policy too: both halves ship together.
  const inboxNoticeServerRows = { key: "inbox_notice_server_rows_v0", defaultEnabled: false };
  assert.deepEqual(describeEffectiveDefault(inboxNoticeServerRows, policy), { enabled: true, source: "default_on" });
  assert.deepEqual(describeEffectiveDefault(inboxNoticeServerRows, { defaultOn: false }), { enabled: false, source: "stored" });
  assert.equal(effectiveDefaultEnabled(off, policy), true);
});

test("exception entries: exact keys, `prefix_*` entries, and a reason for every one", () => {
  assert.equal(featureFlagDefaultOnException("closed_server_purge"), FEATURE_FLAG_DEFAULT_ON_EXCEPTIONS.closed_server_purge);
  assert.equal(featureFlagDefaultOnException("antiproton_hosted_runtime"), FEATURE_FLAG_DEFAULT_ON_EXCEPTIONS["antiproton_*"]);
  assert.equal(featureFlagDefaultOnException("antiproton_model_picker"), FEATURE_FLAG_DEFAULT_ON_EXCEPTIONS["antiproton_*"]);
  assert.equal(featureFlagDefaultOnException("agent_runtime_oar_codex"), FEATURE_FLAG_DEFAULT_ON_EXCEPTIONS["agent_runtime_oar_*"]);
  // Prefixes match only at the start; `*` is not a general glob.
  assert.equal(featureFlagDefaultOnException("my_antiproton_v0"), null);
  assert.equal(featureFlagDefaultOnException("antiproton"), null);
  assert.equal(featureFlagDefaultOnException("wiki_v1"), null);
  // Inherited Object keys are not exceptions.
  assert.equal(featureFlagDefaultOnException("toString"), null);
  for (const [key, reason] of Object.entries(FEATURE_FLAG_DEFAULT_ON_EXCEPTIONS)) {
    assert.ok(reason.trim().length > 0, `${key} needs a reason`);
    assert.match(key, /^[a-z0-9][a-z0-9_.-]*\*?$/, `${key} is an exact key or a prefix_* entry`);
    if (key.endsWith("*")) assert.ok(key.length > 1, "a bare * would exempt every flag");
  }
});

test("flags under security review stay off under default-on (Tenny, task #255)", () => {
  const policy = featureFlagDefaultPolicyFromEnv({ FEATURE_FLAGS_DEFAULT_ON: "1" });
  for (const key of ["prepared_request_card_v0", "data_export_v0"]) {
    assert.match(featureFlagDefaultOnException(key) ?? "", /^security: /, key);
    assert.equal(effectiveDefaultEnabled({ key, defaultEnabled: false }, policy), false, key);
  }
});

test("Sign in with Raft in the desktop browser is no longer held off (review closed: Tenny, xxchan's Mac pass, #proj-workspace:1ed9baf2)", () => {
  const policy = featureFlagDefaultPolicyFromEnv({ FEATURE_FLAGS_DEFAULT_ON: "1" });
  assert.equal(featureFlagDefaultOnException("desktop_browser_raft_sign_in_v0"), null);
  assert.equal(effectiveDefaultEnabled({ key: "desktop_browser_raft_sign_in_v0", defaultEnabled: false }, policy), true);
});

test("minimum supported mobile build gates stay off under default-on", () => {
  const policy = featureFlagDefaultPolicyFromEnv({ FEATURE_FLAGS_DEFAULT_ON: "1" });
  for (const key of ["mobile_min_build_android_v1", "mobile_min_build_ios_v1"]) {
    assert.match(featureFlagDefaultOnException(key) ?? "", /^inverted: /, key);
    assert.equal(effectiveDefaultEnabled({ key, defaultEnabled: false }, policy), false, key);
  }
});

test("flags under staged acceptance stay off under default-on", () => {
  const policy = featureFlagDefaultPolicyFromEnv({ FEATURE_FLAGS_DEFAULT_ON: "1" });
  for (const key of ["inbox_row_position_v1"]) {
    assert.match(featureFlagDefaultOnException(key) ?? "", /^acceptance: /, key);
    assert.equal(effectiveDefaultEnabled({ key, defaultEnabled: false }, policy), false, key);
  }
});
