import assert from "node:assert/strict";
import test from "node:test";
import {
  getCreatableRuntimeOptions,
  getExistingAgentRuntimeOptions,
  getMachineRuntimeDisplayOptions,
  getSetupRuntimeOptions,
  RUNTIMES,
  runtimeAvailabilitySuffix,
  type RuntimeInfo,
} from "./index.js";

const builtin = RUNTIMES.find((r) => r.id === "builtin")!;
const kimiSdk = RUNTIMES.find((r) => r.id === "kimi-sdk")!;
const claude = RUNTIMES.find((r) => r.id === "claude")!;
const grok = RUNTIMES.find((r) => r.id === "grok")!;
const kimiCli = RUNTIMES.find((r) => r.id === "kimi")!;

test("in-process runtimes are Built-in Pi and Kimi Code (no CLI binary)", () => {
  assert.equal(builtin.displayName, "Built-in Pi");
  assert.equal(builtin.binary, "");
  assert.equal(kimiSdk.binary, "");
  assert.notEqual(claude.binary, "");
  assert.notEqual(kimiCli.binary, "");
});

test("Grok Build and Built-in Pi follow Claude Code and Codex CLI in picker order", () => {
  assert.deepEqual(RUNTIMES.slice(0, 4).map((runtime) => runtime.displayName), [
    "Claude Code",
    "Codex CLI",
    "Grok Build",
    "Built-in Pi",
  ]);
});

test("an unreported in-process runtime says '(update computer)', not '(not installed)'", () => {
  // The reported bug: machine on an old daemon (e.g. 0.63.7) that doesn't report
  // `builtin` showed "Built-in Pi (not installed)". There is nothing to install for
  // an in-process runtime — the computer/daemon just predates it, so prompt an
  // update. Gating is unchanged (it stays unavailable/disabled); only the wording.
  for (const r of [builtin, kimiSdk]) {
    assert.deepEqual(runtimeAvailabilitySuffix(r, []), { kind: "updateComputer" }, `${r.id} unreported → update-computer`);
    assert.deepEqual(runtimeAvailabilitySuffix(r, ["claude"]), { kind: "updateComputer" });
    // ...and no suffix once the daemon reports it.
    assert.deepEqual(runtimeAvailabilitySuffix(r, [r.id]), { kind: "none" });
  }
});

test("the observed machine asymmetry: machine.runtimes has kimi-sdk but not builtin", () => {
  // xxchan's 0.63.7 machine: daemon reported kimi-sdk but not builtin.
  const machineRuntimes = ["kimi-sdk", "claude"];
  assert.deepEqual(runtimeAvailabilitySuffix(builtin, machineRuntimes), { kind: "updateComputer" });
  assert.deepEqual(runtimeAvailabilitySuffix(kimiSdk, machineRuntimes), { kind: "none" }); // reported → available
  assert.deepEqual(runtimeAvailabilitySuffix(claude, machineRuntimes), { kind: "none" }); // reported → available
});

test("local CLI runtimes still say '(not installed)' when undetected", () => {
  for (const r of [claude, grok, kimiCli]) {
    assert.deepEqual(runtimeAvailabilitySuffix(r, []), { kind: "notInstalled" }, `${r.id} undetected → not-installed`);
    assert.deepEqual(runtimeAvailabilitySuffix(r, [r.id]), { kind: "none" });
  }
});

test("unsupported runtimes say '(coming soon)' regardless of binary/report", () => {
  const comingSoonInProcess: RuntimeInfo = { id: "future-inproc", displayName: "Future", abbreviation: "FI", binary: "", supported: false };
  const comingSoonCli: RuntimeInfo = { id: "future-cli", displayName: "Future CLI", abbreviation: "FC", binary: "future", supported: false };
  assert.deepEqual(runtimeAvailabilitySuffix(comingSoonInProcess, []), { kind: "comingSoon" });
  assert.deepEqual(runtimeAvailabilitySuffix(comingSoonCli, []), { kind: "comingSoon" });
});

test("deprecated runtimes stay known but are hidden from new/setup/display option helpers", () => {
  assert.deepEqual(RUNTIMES.filter((runtime) => runtime.deprecated).map((runtime) => runtime.id), ["antigravity", "kimi", "gemini"]);
  assert.deepEqual(getCreatableRuntimeOptions().filter((runtime) => runtime.deprecated).map((runtime) => runtime.id), []);
  assert.deepEqual(getSetupRuntimeOptions().filter((runtime) => runtime.deprecated).map((runtime) => runtime.id), []);
  assert.deepEqual(getMachineRuntimeDisplayOptions().filter((runtime) => runtime.deprecated).map((runtime) => runtime.id), []);

  assert.equal(getExistingAgentRuntimeOptions("claude").some((runtime) => runtime.id === "gemini"), false);
  assert.equal(getExistingAgentRuntimeOptions("gemini").some((runtime) => runtime.id === "gemini"), true);
});

test("Antigravity remains available only to agents already using it", () => {
  assert.equal(getCreatableRuntimeOptions().some((runtime) => runtime.id === "antigravity"), false);
  assert.equal(getSetupRuntimeOptions().some((runtime) => runtime.id === "antigravity"), false);
  assert.equal(getExistingAgentRuntimeOptions("claude").some((runtime) => runtime.id === "antigravity"), false);
  assert.equal(getExistingAgentRuntimeOptions("antigravity").some((runtime) => runtime.id === "antigravity" && runtime.supported), true);
});
