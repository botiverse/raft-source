import assert from "node:assert/strict";
import { onboardingRuntimeCandidates, pickCreateAgentRuntime, reconcileCreateAgentRuntime, suggestedRuntimeUnavailable } from "../src/features/agent/pickCreateAgentRuntime";
import { pickSignedInRuntime, runtimeSignInState } from "../src/utils/runtimeSignInState";
import type { RuntimeSignInState } from "../src/utils/runtimeSignInState";
import type { RuntimeAuthView } from "../src/utils/runtimeAuthClient";

const AVAILABLE = ["claude", "codex", "kimi-sdk"];
const SUPPORTED = new Set(["claude", "codex", "kimi-sdk", "builtin"]);
const REMEMBERED = { machineId: "m1", runtime: "kimi-sdk" };

test("no suggestion: the remembered runtime when this computer can run it, else the first it can", () => {
  assert.equal(pickCreateAgentRuntime(AVAILABLE, SUPPORTED, false, REMEMBERED), "kimi-sdk");
  assert.equal(pickCreateAgentRuntime(AVAILABLE, SUPPORTED, false, { machineId: "m1", runtime: "builtin" }), "claude");
  assert.equal(pickCreateAgentRuntime(AVAILABLE, SUPPORTED, false, null), "claude");
});

test("a card's suggested runtime comes before the remembered one", () => {
  assert.equal(pickCreateAgentRuntime(AVAILABLE, SUPPORTED, false, REMEMBERED, "codex"), "codex");
});

test("a suggestion this computer cannot run picks nothing: no fallback to the remembered or first runtime", () => {
  assert.equal(pickCreateAgentRuntime(AVAILABLE, SUPPORTED, false, REMEMBERED, "builtin"), "");
  assert.equal(pickCreateAgentRuntime(AVAILABLE, SUPPORTED, false, null, "opencode"), "");
  // Listed by the computer but not a runtime the server rows support: still nothing.
  assert.equal(pickCreateAgentRuntime(["claude", "pi"], new Set(["claude"]), false, null, "pi"), "");
  // Another computer that can run it: preselected again.
  assert.equal(pickCreateAgentRuntime(["claude", "builtin"], SUPPORTED, false, REMEMBERED, "builtin"), "builtin");
});

test("onboarding keeps its own priority", () => {
  assert.equal(pickCreateAgentRuntime(["kimi-sdk", "codex"], SUPPORTED, true, REMEMBERED), "codex");
});

test("the unavailable notice: only with a suggestion, a loaded list that lacks it, and no runtime chosen yet", () => {
  const base = {
    suggestedRuntime: "builtin", runtime: "", catalogReady: true, availableRuntimes: AVAILABLE, supportedRuntimes: SUPPORTED,
    computerRuntimes: ["claude", "codex", "kimi-sdk"], admittedRuntimes: new Set(["claude", "codex", "kimi-sdk", "builtin"]),
  };
  assert.equal(suggestedRuntimeUnavailable(base), "not_on_computer");
  assert.equal(suggestedRuntimeUnavailable({ ...base, catalogReady: false }), null);
  assert.equal(suggestedRuntimeUnavailable({ ...base, runtime: "claude" }), null, "the person chose one");
  assert.equal(suggestedRuntimeUnavailable({ ...base, suggestedRuntime: "codex" }), null, "this computer has it");
  assert.equal(suggestedRuntimeUnavailable({ ...base, suggestedRuntime: undefined }), null);
});

test("the notice follows the cause: the computer reports the runtime but this server does not offer it for new agents", () => {
  const notAdmitted = {
    suggestedRuntime: "antigravity", runtime: "", catalogReady: true, availableRuntimes: ["claude"], supportedRuntimes: new Set(["claude"]),
    computerRuntimes: ["claude", "antigravity"], admittedRuntimes: new Set(["claude"]),
  };
  assert.equal(suggestedRuntimeUnavailable(notAdmitted), "not_admitted");
  // Not reported by the computer: the computer is the cause, whatever the server offers.
  assert.equal(suggestedRuntimeUnavailable({ ...notAdmitted, computerRuntimes: ["claude"] }), "not_on_computer");
});

// Mail #214: a bundled runtime (Kimi Code) is always "available", signed in or
// not, so Create Cindy picked it on a Windows Computer where it was signed out
// and Cindy exited a second after every start.
const signIn = (states: Record<string, RuntimeSignInState>) => (runtimeId: string): RuntimeSignInState => states[runtimeId] ?? "unknown";

test("onboarding skips a signed-out runtime and starts on a signed-in one, priority or not", () => {
  assert.equal(
    pickCreateAgentRuntime(["claude", "codex", "kimi-sdk"], SUPPORTED, true, null, undefined, signIn({ claude: "signed_out", codex: "signed_out", "kimi-sdk": "signed_in" })),
    "kimi-sdk",
  );
  assert.equal(
    pickCreateAgentRuntime(["claude", "codex", "kimi-sdk"], SUPPORTED, true, null, undefined, signIn({ claude: "signed_out", codex: "signed_in", "kimi-sdk": "signed_in" })),
    "codex",
    "among signed-in ones, its priority still decides",
  );
  // A signed-in one beats a higher-priority one the Computer could not report.
  assert.equal(pickCreateAgentRuntime(["claude", "kimi-sdk"], SUPPORTED, true, null, undefined, signIn({ "kimi-sdk": "signed_in" })), "kimi-sdk");
});

test("onboarding picks nothing when every runtime is signed out, and preselects an unknown one", () => {
  assert.equal(pickCreateAgentRuntime(["kimi-sdk"], SUPPORTED, true, null, undefined, signIn({ "kimi-sdk": "signed_out" })), "");
  assert.equal(pickCreateAgentRuntime(["claude", "kimi-sdk"], SUPPORTED, true, null, undefined, signIn({ claude: "signed_out", "kimi-sdk": "signed_out" })), "");
  // Unknown (an older Computer, or the read not in yet): preselected, as before; the dialog shows its notice.
  assert.equal(pickCreateAgentRuntime(["claude", "kimi-sdk"], SUPPORTED, true, null), "claude");
  assert.equal(pickCreateAgentRuntime(["claude", "kimi-sdk"], SUPPORTED, true, null, undefined, signIn({ claude: "signed_out" })), "kimi-sdk");
  // The candidates: its priority first, then the rest this computer can run.
  assert.deepEqual(onboardingRuntimeCandidates(["kimi-sdk", "codex", "claude"], SUPPORTED), ["claude", "codex", "kimi-sdk"]);
});

test("the Computer's report decides the state: Kimi Code reads Kimi's sign-in; Built-in has none", () => {
  const view: RuntimeAuthView = {
    status: { collectedAt: "2026-11-17T10:00:00.000Z", runtimes: { claude: { kind: "logged_in" }, kimi: { kind: "logged_out" } } },
    availability: "ok",
    canAct: true,
  };
  assert.equal(runtimeSignInState(view, "claude"), "signed_in");
  assert.equal(runtimeSignInState(view, "kimi-sdk"), "signed_out");
  assert.equal(runtimeSignInState(view, "codex"), "unknown", "not in the report");
  assert.equal(runtimeSignInState(null, "claude"), "unknown", "not read");
  assert.equal(runtimeSignInState(view, "builtin"), "no_sign_in");
  assert.equal(pickSignedInRuntime(["kimi-sdk", "claude"], (id) => runtimeSignInState(view, id)), "claude");
});

test("Create Cindy's re-pick follows the sign-in read until the person chooses", () => {
  const available = ["claude", "kimi-sdk"];
  let states: Record<string, RuntimeSignInState> = {};
  const pick = () => pickCreateAgentRuntime(available, SUPPORTED, true, null, undefined, signIn(states));
  // Before the read lands everything is unknown: Claude Code, as before.
  let runtime = reconcileCreateAgentRuntime("", available, true, pick);
  assert.equal(runtime, "claude");
  // The read lands: Claude Code signed out, Kimi Code signed in. Still following: re-picked.
  states = { claude: "signed_out", "kimi-sdk": "signed_in" };
  runtime = reconcileCreateAgentRuntime(runtime, available, true, pick);
  assert.equal(runtime, "kimi-sdk");
  // The person picks Claude Code themselves: kept, whatever the read says next.
  assert.equal(reconcileCreateAgentRuntime("claude", available, false, pick), "claude", "stops once the person chooses");
  // ...unless it can no longer be picked on this Computer.
  assert.equal(reconcileCreateAgentRuntime("codex", available, false, pick), "kimi-sdk");
  // No rows yet: unchanged.
  assert.equal(reconcileCreateAgentRuntime("claude", [], true, pick), "claude");
});
