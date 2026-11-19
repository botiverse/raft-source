import assert from "node:assert/strict";
import { pickCreateAgentRuntime, suggestedRuntimeUnavailable } from "../src/features/agent/pickCreateAgentRuntime";

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
