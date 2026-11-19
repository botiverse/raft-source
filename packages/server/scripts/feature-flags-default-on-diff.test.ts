import assert from "node:assert/strict";
import {
  DEFAULT_ON_CANDIDATES_SQL,
  classifyDefaultOnCandidates,
  scanFlagKeysInCode,
  scanFlagKeysInSource,
} from "./feature-flags-default-on-diff";

const row = (key: string) => ({ key, randomizationUnit: "server", preAuthEvaluable: false, allowRules: 0, denyRules: 0, ruleStages: "" });

test("the candidate query is a read-only SELECT over enabled, unkilled, default-off rows", () => {
  assert.match(DEFAULT_ON_CANDIDATES_SQL.trim(), /^SELECT /);
  assert.doesNotMatch(DEFAULT_ON_CANDIDATES_SQL, /\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE)\b/i);
  assert.match(DEFAULT_ON_CANDIDATES_SQL, /WHERE f\.enabled AND NOT f\.kill_switch AND NOT f\.default_enabled/);
});

test("rows and no-row code keys split by the default-on exceptions", () => {
  const diff = classifyDefaultOnCandidates(
    [row("t255_plain_v0"), row("slack_bridge_v0")],
    new Set(["t255_plain_v0", "slack_bridge_v0", "t255_disabled_v0"]),
    new Map([
      ["t255_plain_v0", ["a.ts"]],
      ["t255_disabled_v0", ["a.ts"]],
      ["t255_code_only_v0", ["b.ts"]],
      ["antiproton_t255", ["c.ts"]],
    ]),
  );
  assert.deepEqual(diff.wouldChange.map((item) => item.key), ["t255_plain_v0"]);
  assert.deepEqual(diff.heldByException.map((item) => item.key), ["slack_bridge_v0"]);
  assert.deepEqual(diff.noRowWouldTurnOn, [{ key: "t255_code_only_v0", files: ["b.ts"] }]);
  assert.deepEqual(diff.noRowHeldByException.map((item) => item.key), ["antiproton_t255"]);
});

test("the static scan reads *FLAG_KEY constants and *FLAG_KEYS maps, and skips non-key strings", () => {
  const source = `
export const PASSIVE_AX_FEATURE_FLAG_KEY = "passive_ax";
export const JOINT_FEATURE_FLAG_KEY =
  "joint_human_membership_v1";
export const READ_RECEIPTS_FLAG_KEY = "read_receipts_v0";
export const OAR_FEATURE_FLAG_KEYS = { codex: "agent_runtime_oar_codex", grok: "agent_runtime_oar_grok" } as const;
export const RETIRED_FEATURE_FLAG_KEYS = ["slack_reaction_sync"] as const;
export const FEATURE_FLAG_CONFIG_SCOPE_GLOBAL = "global";
export const FEATURE_FLAG_ADMIN_OPERATOR_ROLE = "feature_flag_admin_operator";
const SOME_FLAG_KEY = "1.15.0";
`;
  assert.deepEqual(scanFlagKeysInSource(source).sort(), [
    "agent_runtime_oar_codex", "agent_runtime_oar_grok", "joint_human_membership_v1", "passive_ax", "read_receipts_v0", "slack_reaction_sync",
  ]);
  // Positive control on the real tree: code-only flags that must stay off are found.
  const keys = scanFlagKeysInCode();
  for (const key of ["computer_version_enforcement", "remote_computer_upgrade_hold_linux", "closed_server_purge", "passive_ax"]) {
    assert.ok(keys.has(key), key);
  }
});
