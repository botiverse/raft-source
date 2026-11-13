import assert from "node:assert/strict";

import { GENERIC_RUNTIME_ERROR_MESSAGE, RUNTIME_ERROR_CODE_SENTENCES, RUNTIME_ERROR_CODES } from "@botiverse/raft-shared";

import { en } from "../src/i18n/messages/en";
import { zhCn } from "../src/i18n/messages/zh-cn";
import { getActivityText } from "../src/utils/activity";
import { classifyRuntimeError, classifyRuntimeErrorCode, classifyTypedRuntimeError, RUNTIME_ERROR_CODE_MESSAGE_ID, RUNTIME_ERROR_LABEL_ID, RUNTIME_LOOKUP_DISPLAY_MESSAGE_ID, runtimeLookupDisplayForReason } from "../src/utils/classifyRuntimeError";

// Runtime-error sentinel teeth (@Wug 2026-08-04): only enumerable stable
// patterns classify; unknown text stays null so the caller falls back without
// mistranslating or swallowing.

test("known runtime error patterns classify to their kinds", () => {
  assert.equal(classifyRuntimeError("Claude Code is not logged in on this machine. Please log in locally."), "notLoggedIn");
  assert.equal(classifyRuntimeError("Codex CLI is not installed on this computer."), "notInstalled");
  assert.equal(classifyRuntimeError("Authentication failed. Check your credentials."), "authFailed");
  assert.equal(classifyRuntimeError("invalid API key"), "authFailed");
});

test("unknown runtime error text stays null (never mistranslated)", () => {
  assert.equal(classifyRuntimeError("The daemon lost its connection to the workspace broker."), null);
  assert.equal(classifyRuntimeError(""), null);
  // A near-miss must not over-match: "installed" alone is not "not installed".
  assert.equal(classifyRuntimeError("The runtime was installed but is not responding."), null);
});

// task #735 — the lookup-reason split shared by the detect (runtime-models
// source state) and launch (spawn-failure carrier) consumption sites.

test("task #735: both reason vocabularies map to the same display arms", () => {
  // Only a confirmed miss may keep install guidance.
  assert.equal(runtimeLookupDisplayForReason("not_installed"), "confirmed_missing");
  assert.equal(runtimeLookupDisplayForReason("not_on_path"), "confirmed_missing");
  // The check itself never answered.
  assert.equal(runtimeLookupDisplayForReason("probe_timeout"), "timeout");
  assert.equal(runtimeLookupDisplayForReason("lookup_timed_out"), "timeout");
  assert.equal(runtimeLookupDisplayForReason("permission_denied"), "permission_denied");
  assert.equal(runtimeLookupDisplayForReason("lookup_permission_denied"), "permission_denied");
  assert.equal(runtimeLookupDisplayForReason("probe_failed"), "unconfirmed");
  assert.equal(runtimeLookupDisplayForReason("lookup_failed"), "unconfirmed");
});

test("task #735: an absent (old daemon) or unknown reason is unresolved, never a confirmed miss", () => {
  assert.equal(runtimeLookupDisplayForReason(undefined), "unconfirmed");
  assert.equal(runtimeLookupDisplayForReason(null), "unconfirmed");
  assert.equal(runtimeLookupDisplayForReason("some_future_reason"), "unconfirmed");
});

test("task #735: every non-install arm resolves to agent.runtimeModels.* catalog copy; a confirmed miss names the runtime (#proj-runtime:#32)", () => {
  assert.deepEqual(RUNTIME_LOOKUP_DISPLAY_MESSAGE_ID, {
    confirmed_missing: "agent.runtimeError.notInstalledNamed",
    timeout: "agent.runtimeModels.runtimeLookupTimeout",
    permission_denied: "agent.runtimeModels.runtimeLookupPermissionDenied",
    unconfirmed: "agent.runtimeModels.runtimeLookupUnresolved",
  });
});

test("Claude root guidance is not classified from display text", () => {
  assert.equal(classifyRuntimeError("Claude Code cannot start with root or sudo privileges while permission checks are disabled. Run Raft Computer as a non-root user, then start the agent again."), null);
  assert.equal(classifyRuntimeError("JavaScript error: root object is undefined"), null);
});

// task #1351 — billing exhaustion is reachable only from the typed carrier.
test("task #1351: a typed BillingError / billing_exhausted classifies as billingExhausted", () => {
  assert.equal(classifyTypedRuntimeError({ errorClass: "BillingError", errorReason: "billing_exhausted" }), "billingExhausted");
  assert.equal(classifyTypedRuntimeError({ errorReason: "billing_exhausted" }), "billingExhausted");
  assert.equal(classifyTypedRuntimeError({ errorClass: "BillingError" }), "billingExhausted");
  assert.equal(RUNTIME_ERROR_LABEL_ID.billingExhausted, "agent.runtimeError.billingExhausted");
});

test("task #1351: 402 / insufficient-balance text never classifies as billing", () => {
  assert.equal(classifyRuntimeError("402 Insufficient Balance"), null);
  assert.equal(classifyRuntimeError("API Error: 402 {\"error\":{\"message\":\"Insufficient Balance\"}}"), null);
  assert.equal(classifyRuntimeError("Your credit balance is too low to access the API. Billing exhausted."), null);
  // Other typed classes stay what they were.
  assert.equal(classifyTypedRuntimeError({ errorClass: "RateLimitError", errorReason: "rate_limited" }), null);
});

// #wg-rbac:#57 — members get no error text, only the code: the code classifies.
test("#wg-rbac:#57: every shared runtime error code classifies to itself and has its own copy", () => {
  for (const code of RUNTIME_ERROR_CODES) {
    assert.equal(classifyRuntimeErrorCode(code), code);
    const ids = RUNTIME_ERROR_CODE_MESSAGE_ID[code];
    for (const id of [ids.title, ids.member, ids.manager]) {
      assert.ok(en[id], `${code}: ${id} is in en`);
      assert.ok(zhCn[id], `${code}: ${id} is in zh-cn`);
    }
    assert.notEqual(en[ids.member], en[ids.manager], `${code}: a member and a manager read different next steps`);
  }
  assert.deepEqual(Object.keys(RUNTIME_ERROR_CODE_MESSAGE_ID).sort(), [...RUNTIME_ERROR_CODES].sort());
});

test("#wg-rbac:#57: no code, an unknown (newer) code, or a non-string is no code", () => {
  assert.equal(classifyRuntimeErrorCode(undefined), null);
  assert.equal(classifyRuntimeErrorCode(null), null);
  assert.equal(classifyRuntimeErrorCode("some_future_code"), null);
  assert.equal(classifyRuntimeErrorCode(42), null);
});

test("#wg-rbac:#57: an error row reads the code's title, and the server's generic member line reads as the catalog fallback", () => {
  assert.equal(getActivityText("error", RUNTIME_ERROR_CODE_SENTENCES.usage_limit, "runtime_error", "usage_limit"), "Usage limit reached");
  assert.equal(getActivityText("error", "429 quota exceeded for sk-…", "runtime_error", "usage_limit"), "Usage limit reached");
  assert.equal(getActivityText("error", GENERIC_RUNTIME_ERROR_MESSAGE, "runtime_error"), "Agent encountered an error");
  // A code only reads on an error; a manager's uncoded text stays as it was.
  assert.equal(getActivityText("online", "", "idle", "usage_limit"), "Online");
  assert.equal(getActivityText("error", "socket hang up", "runtime_error"), "Error: socket hang up");
});
