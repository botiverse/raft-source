import assert from "node:assert/strict";
import { RUNTIMES } from "@botiverse/raft-shared";
import {
  projectExistingAgentRuntimeOptions as projectExistingAgentRuntimeOptionsFor,
  projectNewAgentRuntimeOptions as projectNewAgentRuntimeOptionsFor,
  projectSetupRuntimeOptions,
  isRuntimeDeprecatedForServer,
  resolveRuntimeAdmissionPolicy,
  runtimeOptionProjectionFromHeaders,
} from "./runtimeAdmissionService";
import { KIMI_SDK_FORM_DEFINITION_REF } from "./runtimeFormDefinitionService";
import { removeRuntimeFormV2EntryForTests } from "./runtimeFormV2Registry";

// Most tests here describe the web projection, which opts into the v2 marker;
// the default (no opt-in) projection is pinned separately below.
const WEB = { includeRuntimeFormV2Marker: true };
const projectNewAgentRuntimeOptions = (installed: readonly string[]) =>
  projectNewAgentRuntimeOptionsFor(installed, WEB);
const projectExistingAgentRuntimeOptions = (installed: readonly string[], current: string) =>
  projectExistingAgentRuntimeOptionsFor(installed, current, WEB);

test("new-agent runtime options keep capability separate from admission", () => {
  const options = projectNewAgentRuntimeOptions(["codex", "grok"]);
  assert.deepEqual(options.find((option) => option.runtimeId === "codex"), {
    runtimeId: "codex",
    capabilityStatus: "available",
    admissionStatus: "available_for_new",
    admissionReason: null,
    current: false,
    availableForNew: true,
    manageableForCurrentAgent: false,
    canSelectInThisContext: true,
    // Additive (batch 3a): Codex has a v2 form.
    runtimeFormV2: { protocolVersion: 2 },
  });

  // Grok is admitted like any other runtime (the grok_runtime_v0 gate is retired).
  assert.deepEqual(options.find((option) => option.runtimeId === "grok"), {
    runtimeId: "grok",
    capabilityStatus: "available",
    admissionStatus: "available_for_new",
    admissionReason: null,
    current: false,
    availableForNew: true,
    manageableForCurrentAgent: false,
    canSelectInThisContext: true,
    // Additive (batch 3a): Grok has a v2 form.
    runtimeFormV2: { protocolVersion: 2 },
  });
});

test("new-agent runtime options distinguish local install from computer update", () => {
  const options = projectNewAgentRuntimeOptions([]);
  assert.equal(options.find((option) => option.runtimeId === "claude")?.capabilityStatus, "not_installed");
  assert.equal(options.find((option) => option.runtimeId === "builtin")?.capabilityStatus, "update_required");
  assert.equal(options.find((option) => option.runtimeId === "claude")?.canSelectInThisContext, false);
  assert.equal(options.find((option) => option.runtimeId === "builtin")?.canSelectInThisContext, false);
});

test("Kimi runtime options advertise the versioned schema form for create and edit", () => {
  const createOption = projectNewAgentRuntimeOptions(["kimi-sdk"]).find((option) => option.runtimeId === "kimi-sdk");
  assert.deepEqual(createOption?.formDefinitionRef, KIMI_SDK_FORM_DEFINITION_REF);

  const editOption = projectExistingAgentRuntimeOptions(["kimi-sdk"], "kimi-sdk").find((option) => option.runtimeId === "kimi-sdk");
  assert.deepEqual(editOption?.formDefinitionRef, KIMI_SDK_FORM_DEFINITION_REF);
});

test("current-only Kimi keeps the registered schema ref for resume/edit", () => {
  const kimiRuntime = RUNTIMES.find((runtime) => runtime.id === "kimi-sdk");
  assert.ok(kimiRuntime);
  const wasDeprecated = kimiRuntime.deprecated;
  kimiRuntime.deprecated = true;
  try {
    const currentOnlyOption = projectExistingAgentRuntimeOptions(["kimi-sdk"], "kimi-sdk").find((option) => option.runtimeId === "kimi-sdk");

    assert.equal(currentOnlyOption?.availableForNew, false);
    assert.equal(currentOnlyOption?.manageableForCurrentAgent, true);
    assert.deepEqual(currentOnlyOption?.formDefinitionRef, KIMI_SDK_FORM_DEFINITION_REF);
  } finally {
    kimiRuntime.deprecated = wasDeprecated;
  }
});

test("an existing Grok agent is current and admitted, and other agents can switch into Grok", () => {
  const existingGrok = projectExistingAgentRuntimeOptions(["codex", "grok"], "grok");
  assert.deepEqual(existingGrok.find((option) => option.runtimeId === "grok"), {
    runtimeId: "grok",
    capabilityStatus: "available",
    admissionStatus: "available_for_new",
    admissionReason: null,
    current: true,
    availableForNew: true,
    manageableForCurrentAgent: true,
    canSelectInThisContext: true,
    runtimeFormV2: { protocolVersion: 2 },
  });

  const existingCodex = projectExistingAgentRuntimeOptions(["codex", "grok"], "codex");
  assert.equal(existingCodex.find((option) => option.runtimeId === "grok")?.canSelectInThisContext, true);
});

test("deprecated current runtimes use the same explicit grandfathered contract", () => {
  for (const runtime of ["kimi", "antigravity", "copilot"]) {
    const options = projectExistingAgentRuntimeOptions([runtime], runtime);
    assert.deepEqual(options.find((option) => option.runtimeId === runtime), {
      runtimeId: runtime,
      capabilityStatus: "available",
      admissionStatus: "grandfathered_current",
      admissionReason: "deprecated",
      current: true,
      availableForNew: false,
      manageableForCurrentAgent: true,
      canSelectInThisContext: true,
      // Additive (batch 2): the current deprecated runtime is editable with its v2 form.
      runtimeFormV2: { protocolVersion: 2 },
    });
    assert.equal(projectNewAgentRuntimeOptions([runtime]).some((option) => option.runtimeId === runtime), false);
  }
});

test("setup options exclude built-in and admit Grok", () => {
  const options = projectSetupRuntimeOptions(["grok"]);
  assert.equal(options.some((option) => option.runtimeId === "builtin"), false);
  assert.equal(options.find((option) => option.runtimeId === "grok")?.canSelectInThisContext, true);
});

test("the runtimeFormV2 marker is on exactly the runtimes with a v2 form, independent of the v1 ref", () => {
  const everyRuntime = RUNTIMES.map((runtime) => runtime.id);
  const withMarker = (options: ReturnType<typeof projectNewAgentRuntimeOptions>) =>
    options.filter((option) => option.runtimeFormV2 !== undefined).map((option) => option.runtimeId).sort();
  const created = projectNewAgentRuntimeOptions(everyRuntime);
  // Deprecated runtimes with a v2 form (kimi, gemini, antigravity, copilot) are not offered for new agents.
  assert.deepEqual(withMarker(created), ["builtin", "claude", "codebuddy", "codex", "cursor", "grok", "kimi-sdk", "opencode", "pi", "qoder", "qwen"]);
  for (const option of created.filter((candidate) => candidate.runtimeFormV2)) {
    assert.deepEqual(option.runtimeFormV2, { protocolVersion: 2 });
  }
  // Server setup state never carries the marker (no client opens a v2 form from it).
  assert.deepEqual(withMarker(projectSetupRuntimeOptions(everyRuntime)), []);
  assert.deepEqual(
    withMarker(projectExistingAgentRuntimeOptions(everyRuntime, "kimi-sdk")),
    ["builtin", "claude", "codebuddy", "codex", "cursor", "grok", "kimi-sdk", "opencode", "pi", "qoder", "qwen"],
  );
  // ...and appear, with the marker, only as an edited agent's current runtime.
  for (const deprecated of ["kimi", "gemini", "antigravity", "copilot"]) {
    const options = projectExistingAgentRuntimeOptions(everyRuntime, deprecated);
    assert.deepEqual(withMarker(options), ["builtin", "claude", "codebuddy", "codex", "cursor", deprecated, "grok", "kimi-sdk", "opencode", "pi", "qoder", "qwen"].sort(), deprecated);
    const current = options.find((option) => option.runtimeId === deprecated);
    assert.equal(current?.current, true, deprecated);
    assert.equal(current?.admissionReason, "deprecated", deprecated);
    assert.equal(current && "formDefinitionRef" in current, false, `${deprecated} has no v1 form`);
  }
  for (const runtimeId of ["opencode", "codex", "grok", "claude", "cursor", "pi"]) {
    const option = created.find((candidate) => candidate.runtimeId === runtimeId);
    assert.equal(option && "formDefinitionRef" in option, false, `${runtimeId} has no v1 form`);
  }

  // Pi (batch 4) has only a v2 form: the marker, and no v1 ref for v1 clients.
  const pi = projectNewAgentRuntimeOptions(["pi"])
    .find((option) => option.runtimeId === "pi");
  assert.deepEqual(pi?.runtimeFormV2, { protocolVersion: 2 });
  assert.equal(pi && "formDefinitionRef" in pi, false);
  // The marker follows the registry: every catalog runtime has a v2 form now,
  // so take Pi out of the registry to see a runtime without one.
  const restore = removeRuntimeFormV2EntryForTests("pi");
  try {
    const piWithout = projectNewAgentRuntimeOptions(["pi"])
      .find((option) => option.runtimeId === "pi");
    assert.ok(piWithout, "the runtime is still offered");
    assert.equal("runtimeFormV2" in piWithout, false);
  } finally {
    restore();
  }
  assert.deepEqual(
    projectNewAgentRuntimeOptions(["pi"]).find((option) => option.runtimeId === "pi")?.runtimeFormV2,
    { protocolVersion: 2 },
  );
});

// Released mobile apps (1.12, 1.13: ComputersApi.kt `runtimeFormApiJson`,
// ignoreUnknownKeys = false) fail the WHOLE runtime catalog on any key they do
// not know. Without the opt-in header every row must carry exactly the keys
// those apps decode.
const RELEASED_MOBILE_OPTION_KEYS = new Set([
  "runtimeId",
  "capabilityStatus",
  "admissionStatus",
  "admissionReason",
  "current",
  "availableForNew",
  "manageableForCurrentAgent",
  "canSelectInThisContext",
  "formDefinitionRef",
]);

test("without the opt-in, runtime options carry only the keys released mobile apps decode", () => {
  const everyRuntime = RUNTIMES.map((runtime) => runtime.id);
  const noOptIn = runtimeOptionProjectionFromHeaders({});
  const catalogs = [
    projectNewAgentRuntimeOptionsFor(everyRuntime),
    projectNewAgentRuntimeOptionsFor(everyRuntime, noOptIn),
    projectSetupRuntimeOptions(everyRuntime),
    ...everyRuntime.map((current) => projectExistingAgentRuntimeOptionsFor(everyRuntime, current)),
    ...everyRuntime.map((current) => projectExistingAgentRuntimeOptionsFor(everyRuntime, current, noOptIn)),
  ];
  for (const options of catalogs) {
    assert.ok(options.length > 0);
    for (const option of options) {
      const extra = Object.keys(option).filter((key) => !RELEASED_MOBILE_OPTION_KEYS.has(key));
      assert.deepEqual(extra, [], option.runtimeId);
    }
  }
});

test("the opt-in header is exact: only `1` turns the marker on", () => {
  assert.equal(runtimeOptionProjectionFromHeaders({ "x-raft-runtime-form-v2": "1" }).includeRuntimeFormV2Marker, true);
  for (const value of [undefined, "", "0", "true", "2", ["1"]]) {
    assert.equal(runtimeOptionProjectionFromHeaders({ "x-raft-runtime-form-v2": value }).includeRuntimeFormV2Marker, false, String(value));
  }
});

// OAR-only runtimes (Qwen Code, Qoder, CodeBuddy Code) have no server flag:
// the Computer's report decides (xxchan, #proj-runtime:a5762001).
test("an OAR-only runtime is offered whenever the Computer reports it, with no server flag", () => {
  const reported = projectNewAgentRuntimeOptionsFor(["qwen", "qoder", "codebuddy", "codex"], WEB);
  for (const runtimeId of ["qwen", "qoder", "codebuddy"]) {
    const option = reported.find((candidate) => candidate.runtimeId === runtimeId);
    assert.equal(option?.capabilityStatus, "available", runtimeId);
    assert.equal(option?.canSelectInThisContext, true, runtimeId);
    assert.equal(option?.admissionReason, null, runtimeId);
  }
  // A Computer that does not report it (not installed, or too old to know it): offered, not selectable.
  const notReported = projectNewAgentRuntimeOptionsFor([], WEB).find((option) => option.runtimeId === "qwen");
  assert.equal(notReported?.capabilityStatus, "not_installed");
  assert.equal(notReported?.canSelectInThisContext, false);
});

test("an agent can switch into an OAR-only runtime its Computer reports", () => {
  const options = projectExistingAgentRuntimeOptionsFor(["qwen", "codex"], "codex", WEB);
  assert.equal(options.find((option) => option.runtimeId === "qwen")?.canSelectInThisContext, true);
});

test("server setup never offers an OAR-only runtime", () => {
  assert.equal(projectSetupRuntimeOptions(["qwen", "qoder", "codebuddy", "codex"]).some((option) => ["qwen", "qoder", "codebuddy"].includes(option.runtimeId)), false);
});

test("with no flag-gated runtime a failing flag store disables nothing and revives nothing", async () => {
  const policy = await resolveRuntimeAdmissionPolicy({ serverId: "s", userId: "u" }, async () => { throw new Error("db down"); });
  assert.deepEqual([...policy.disabledRuntimeIds], []);
  assert.deepEqual([...(policy.revivedRuntimeIds ?? [])], []);
});

const evaluateAntigravity = (enabled: boolean) => async (requests: Array<{ key: string }>) =>
  requests.map((request) => ({ key: request.key, enabled: enabled && request.key === "agent_runtime_oar_antigravity" }));

test("agent_runtime_oar_antigravity on revives Antigravity for new agents and switches (tygg, #oar-raft:e9798673)", async () => {
  const on = await resolveRuntimeAdmissionPolicy({ serverId: "s", userId: "u" }, evaluateAntigravity(true) as never);
  assert.deepEqual([...(on.revivedRuntimeIds ?? [])], ["antigravity"]);
  assert.equal(isRuntimeDeprecatedForServer("antigravity", on), false);
  assert.equal(isRuntimeDeprecatedForServer("gemini", on), true);

  const created = projectNewAgentRuntimeOptionsFor(["antigravity"], WEB, on).find((option) => option.runtimeId === "antigravity");
  assert.equal(created?.availableForNew, true);
  assert.equal(created?.canSelectInThisContext, true);
  assert.equal(created?.admissionReason, null);
  // Only creation is revived: other deprecated runtimes stay hidden.
  assert.equal(projectNewAgentRuntimeOptionsFor(["gemini"], WEB, on).some((option) => option.runtimeId === "gemini"), false);

  const current = projectExistingAgentRuntimeOptionsFor(["antigravity"], "antigravity", WEB, on).find((option) => option.runtimeId === "antigravity");
  assert.equal(current?.admissionReason, null);
  assert.equal(current?.availableForNew, true);
  const switchable = projectExistingAgentRuntimeOptionsFor(["antigravity", "claude"], "claude", WEB, on);
  assert.equal(switchable.find((option) => option.runtimeId === "antigravity")?.canSelectInThisContext, true);
  // Catalog order is kept when a revived runtime joins the list.
  const order = switchable.map((option) => option.runtimeId);
  assert.deepEqual(order, RUNTIMES.filter((runtime) => order.includes(runtime.id)).map((runtime) => runtime.id));
});

test("agent_runtime_oar_antigravity off keeps Antigravity deprecated: hidden for new agents, current-only", async () => {
  const off = await resolveRuntimeAdmissionPolicy({ serverId: "s", userId: "u" }, evaluateAntigravity(false) as never);
  assert.deepEqual([...(off.revivedRuntimeIds ?? [])], []);
  assert.equal(isRuntimeDeprecatedForServer("antigravity", off), true);
  assert.equal(projectNewAgentRuntimeOptionsFor(["antigravity"], WEB, off).some((option) => option.runtimeId === "antigravity"), false);
  assert.equal(projectExistingAgentRuntimeOptionsFor(["antigravity"], "claude", WEB, off).some((option) => option.runtimeId === "antigravity"), false);
  assert.equal(projectExistingAgentRuntimeOptionsFor(["antigravity"], "antigravity", WEB, off)
    .find((option) => option.runtimeId === "antigravity")?.admissionReason, "deprecated");
});
