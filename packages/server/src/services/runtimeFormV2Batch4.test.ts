/**
 * Runtime form v2 batch 4: Pi (the Pi CLI runtime, runtime "pi").
 *
 * Oracles:
 * - the legacy web form: RuntimeConfigFields' Pi branch and its runtimeConfig
 *   builder (packages/web/src/utils/runtimeConfigForm.ts: buildRuntimeConfig,
 *   supportsRuntimePiProvider, supportsRuntimeCustomModelName,
 *   piBuiltinProviderModels/DefaultModel, PI_BUILTIN_PROVIDER_IDS), its effort
 *   picker (utils/reasoningEffortOptions.ts) and REASONING_EFFORT_RUNTIMES;
 * - the contract's probe outcome → reason/retryable table
 *   (runtimeFormV2SourceStatus.ts).
 */
import assert from "node:assert/strict";
import {
  applyRuntimeFormV2Change,
  initialRuntimeFormV2Values,
  isRuntimeFormV2FieldVisible,
  parseRuntimeFormV2,
  runtimeFormV2Choices,
  runtimeFormV2Submission,
  validateRuntimeFormV2,
  type RuntimeFormV2OptionSource,
} from "@botiverse/raft-runtime-form";
import {
  BASE_REASONING_EFFORTS,
  PI_REASONING_EFFORTS,
  parseRuntimeConfig,
  REASONING_EFFORT_RUNTIMES,
  RUNTIME_FAST_MODE_RUNTIMES,
  RUNTIME_MODELS,
  type ReasoningEffort,
  type RuntimeConfig,
  type RuntimeModelInfo,
  type RuntimeModelSourceOutcome,
  PI_BUILTIN_PROVIDER_DEFAULT_MODELS,
  PI_BUILTIN_PROVIDER_MODELS,
} from "@botiverse/raft-shared";

import { reasoningEffortOptionsForModel } from "../../../web/src/utils/reasoningEffortOptions";
import {
  buildRuntimeConfig,
  PI_BUILTIN_PROVIDER_IDS,
  PI_PROVIDER_CONFIGURED,
  supportsRuntimeApiUrl,
  supportsRuntimeCommand,
} from "../../../web/src/utils/runtimeConfigForm";
import { RouteFailureError } from "../tracing/routeFailure";
import { runtimeFormV1Entry } from "./runtimeFormDefinitionService";
import {
  buildRuntimeConfigFromFormValues,
  buildRuntimeFormV2,
  formValuesPointerForRuntimeConfigPointer,
  reasoningEffortChoices,
  reconcileRuntimeFormV2SubmissionWithLiveModels,
  redactWriteOnlyRuntimeConfig,
  retainOmittedWriteOnlySecrets,
  runtimeFormV2Entry,
  runtimeFormValuesFromRuntimeConfig,
  type RuntimeFormOptionSourceContext,
} from "./runtimeFormV2Registry";
import { RUNTIME_FORM_V2_REASON_RETRYABLE } from "./runtimeFormV2SourceStatus";

// Frozen from the retired web legacy form (task #8, PR #11812): the runtimes whose
// model field accepted a typed custom name. The v2 forms must keep matching it.
const LEGACY_CUSTOM_MODEL_NAME_RUNTIMES = new Set(["builtin", "claude", "codex", "cursor", "copilot", "pi"]);
const supportsRuntimeCustomModelName = (runtime: string) => LEGACY_CUSTOM_MODEL_NAME_RUNTIMES.has(runtime);
// The retired legacy form offered Pi's provider picker for Pi only; its model
// lists and defaults came straight from the shared Pi catalog.
const supportsRuntimePiProvider = (runtime: string) => runtime === "pi";
const piBuiltinProviderModels = (providerId: string) => PI_BUILTIN_PROVIDER_MODELS[providerId] ?? null;
const piBuiltinProviderDefaultModel = (providerId: string) =>
  PI_BUILTIN_PROVIDER_DEFAULT_MODELS[providerId as keyof typeof PI_BUILTIN_PROVIDER_DEFAULT_MODELS] ?? null;

const wire = (value: unknown) => JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
const piForm = () => parseRuntimeFormV2(wire(buildRuntimeFormV2("pi")))!;

// ── The form: fields and capabilities follow the legacy Pi branch ──

test("pi form: fields by kind, in order, each model/effort pair shown for its provider", () => {
  const parsed = piForm();
  assert.ok(parsed);
  assert.deepEqual(parsed.fields.map((field) => [field.key, field.kind, field.required, field.advanced]), [
    ["provider", "select", true, false],
    ["apiKey", "secret", false, false],
    ["model", "select", true, false],
    ["reasoningEffort", "derived_select", false, false],
    ["providerModel", "dependent_select", true, false],
    ["providerReasoningEffort", "derived_select", false, false],
    ["envVars", "string_map", false, true],
  ]);
  assert.deepEqual(parsed.blockingFieldKeys, []);
  assert.deepEqual(runtimeFormV2Entry("pi")!.validateProjection(), []);
  // A v2-only form: the v1 routes and the admission row's v1 ref never see it.
  assert.equal(runtimeFormV1Entry("pi"), null);
  const builtIn = { key: "provider", in: [...PI_BUILTIN_PROVIDER_IDS] };
  const configured = { key: "provider", in: [PI_PROVIDER_CONFIGURED] };
  const visibility = Object.fromEntries(parsed.fields.map((field) => [field.key, field.visibleWhen]));
  assert.deepEqual(visibility, {
    provider: [],
    apiKey: [builtIn],
    model: [configured],
    reasoningEffort: [configured],
    providerModel: [builtIn],
    providerReasoningEffort: [builtIn],
    envVars: [],
  });
  assert.deepEqual((buildRuntimeFormV2("pi").capabilities as { writeOnlyPointers: string[] }).writeOnlyPointers, ["/apiKey"]);
  const effort = parsed.fields.find((field) => field.key === "reasoningEffort")!;
  const providerEffort = parsed.fields.find((field) => field.key === "providerReasoningEffort")!;
  assert.deepEqual(effort.derivedFrom, { key: "model", attribute: "supportedReasoningEfforts", defaultAttribute: "defaultReasoningEffort" });
  assert.deepEqual(providerEffort.derivedFrom, { key: "providerModel", attribute: "supportedReasoningEfforts", defaultAttribute: "defaultReasoningEffort" });
  assert.equal(parsed.fields.find((field) => field.key === "providerModel")!.dependsOn, "provider");
});

test("pi declares exactly the capabilities its legacy form needs", () => {
  const form = buildRuntimeFormV2("pi");
  const parsed = piForm();
  // Custom model (supportsRuntimeCustomModelName) → select.custom_value. Its
  // effort labels (choice.labels) and probed model list (option_source.status)
  // are always on and never listed.
  assert.equal(supportsRuntimeCustomModelName("pi"), true);
  assert.equal(REASONING_EFFORT_RUNTIMES.has("pi"), true);
  assert.deepEqual(form.requiredClientCapabilities, ["select.custom_value"]);
  // Nothing the legacy form lacks: no fast mode, API URL or command for Pi.
  const keys = parsed.fields.map((field) => field.key);
  assert.equal(RUNTIME_FAST_MODE_RUNTIMES.has("pi"), false);
  assert.equal(keys.includes("fastMode"), false);
  assert.equal(supportsRuntimeApiUrl("pi") || keys.includes("apiUrl"), false);
  assert.equal(supportsRuntimeCommand("pi") || keys.includes("command"), false);
  assert.equal(supportsRuntimePiProvider("pi") && keys.includes("provider") && keys.includes("apiKey"), true);
  // English effort labels on both effort fields.
  for (const key of ["reasoningEffort", "providerReasoningEffort"]) {
    assert.deepEqual(parsed.fields.find((field) => field.key === key)?.choices, reasoningEffortChoices(), key);
  }
});

// ── Option sources ──

function sourceContext(detect: () => Promise<RuntimeModelSourceOutcome>, routing: "confirmed_local" | "handled" | "not_routed" = "confirmed_local", sourceId = "model") {
  const calls: string[] = [];
  const context = {
    sourceId,
    machineId: "machine-1",
    machine: {},
    agentOrchestrator: {
      detectMachineRuntimeModels: async (_machineId: string, runtime: string) => {
        calls.push(runtime);
        return detect();
      },
      detectMachineRuntimeModelsWithAuthority: async () => { throw new Error("not used"); },
    },
    routeToComputer: async () => {
      calls.push("route");
      return routing;
    },
  } as unknown as RuntimeFormOptionSourceContext;
  return { context, calls };
}

async function resolved(sourceId: string, detect: () => Promise<RuntimeModelSourceOutcome>, routing?: "confirmed_local" | "handled" | "not_routed") {
  const { context, calls } = sourceContext(detect, routing, sourceId);
  const resolution = await runtimeFormV2Entry("pi")!.resolveOptionSource(context);
  assert.equal(resolution.kind, "source");
  return { source: wire((resolution as { source: unknown }).source), calls };
}

const neverProbe = async (): Promise<RuntimeModelSourceOutcome> => { throw new Error("must not probe"); };

test("the provider source is static: Configured plus the Pi built-in providers, never probes, no status, no typed value", async () => {
  const { source, calls } = await resolved("provider", neverProbe);
  assert.deepEqual(calls, []);
  // The legacy select: "Configured" (agent.runtimeConfig.configured) then PI_BUILTIN_PROVIDER_IDS.
  assert.deepEqual((source.options as Array<{ value: string }>).map((option) => option.value), [PI_PROVIDER_CONFIGURED, ...PI_BUILTIN_PROVIDER_IDS]);
  assert.deepEqual(source.options, [{ value: "configured", label: "Configured" }, { value: "deepseek", label: "DeepSeek" }]);
  assert.equal(source.defaultValue, PI_PROVIDER_CONFIGURED, "legacy starts on Configured");
  assert.equal(source.pointer, "/provider");
  assert.equal("status" in source, false);
  assert.equal(source.customValueAllowed, false);
});

test("the built-in providers' model source is static and locked to each provider's catalog, with the legacy default", async () => {
  const { source, calls } = await resolved("providerModel", neverProbe);
  assert.deepEqual(calls, []);
  assert.equal(source.kind, "dependent_select");
  assert.equal(source.dependsOn, "/provider");
  assert.equal("status" in source, false);
  assert.equal("customValueAllowed" in source, false);
  const optionsByValue = source.optionsByValue as Record<string, Array<{ value: string; label: string; supportedReasoningEfforts: string[] }>>;
  assert.deepEqual(Object.keys(optionsByValue), PI_BUILTIN_PROVIDER_IDS);
  for (const providerId of PI_BUILTIN_PROVIDER_IDS) {
    const legacyModels = piBuiltinProviderModels(providerId)!;
    assert.deepEqual(optionsByValue[providerId]!.map(({ value, label }) => ({ id: value, label })), legacyModels.map(({ id, label }) => ({ id, label })), providerId);
    // Legacy resets the model to the provider default on a switch (CreateAgentDialog).
    assert.equal((source.defaultValueByValue as Record<string, string>)[providerId], piBuiltinProviderDefaultModel(providerId), providerId);
    // Legacy locks the picker to the list: no Custom for a built-in provider.
    assert.equal((source.customValueAllowedByValue as Record<string, boolean>)[providerId], false, providerId);
    for (const option of optionsByValue[providerId]!) {
      assert.deepEqual(option.supportedReasoningEfforts, reasoningEffortOptionsForModel("pi", option.value, []).map((effort) => effort.value), option.value);
    }
  }
});

const NON_LIVE_CASES: Array<[string, () => Promise<RuntimeModelSourceOutcome>, string, boolean, ("not_routed" | undefined)?]> = [
  ["missing_config", async () => ({ kind: "missing_config" }), "missing_config", false],
  ["no_models", async () => ({ kind: "no_models" }), "no_models", true],
  ["live but empty", async () => ({ kind: "live", value: { models: [] } }), "no_models", true],
  ["unsupported", async () => ({ kind: "unsupported" }), "unsupported", false],
  ["error detect_timeout", async () => ({ kind: "error", retryable: true, code: "detect_timeout" }), "probe_timeout", true],
  ["error computer_offline", async () => ({ kind: "error", retryable: true, code: "computer_offline" }), "machine_offline", true],
  ["error detect_failed", async () => ({ kind: "error", retryable: false, code: "detect_failed" }), "probe_failed", true],
  ["server wait timed out", async () => { throw new RouteFailureError("daemon_timeout", "timed out"); }, "probe_timeout", true],
  ["machine socket not ready", async () => { throw new RouteFailureError("daemon_offline", "offline"); }, "machine_offline", true],
  ["probe threw", async () => { throw new Error("boom"); }, "probe_failed", true],
  ["not routed to this replica", neverProbe, "machine_offline", true, "not_routed"],
];

// What the Pi probe reports: provider/model ids, never efforts (detectPiModelsFromRegistry).
const LIVE: RuntimeModelInfo[] = [
  { id: "anthropic/claude-sonnet-live", label: "Sonnet · Anthropic", verified: "launchable" },
  { id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro · DeepSeek", verified: "launchable" },
];

test("the Configured model source: the Pi probe's list when live, else the bundled list with the table's reason", async () => {
  const live = await resolved("model", async () => ({ kind: "live", value: { models: LIVE, default: LIVE[1]!.id } }));
  assert.deepEqual(live.calls, ["route", "pi"]);
  assert.equal(live.source.status, "live");
  assert.equal("reason" in live.source, false);
  assert.equal("retryable" in live.source, false);
  assert.equal(live.source.customValueAllowed, true);
  assert.equal(live.source.defaultValue, LIVE[1]!.id);
  assert.deepEqual((live.source.options as Array<{ value: string }>).map((option) => option.value), LIVE.map((model) => model.id));
  // Efforts as the legacy picker offers them for Pi: every Pi thinking level for every model.
  for (const option of live.source.options as Array<{ value: string; supportedReasoningEfforts: string[]; defaultReasoningEffort?: string }>) {
    assert.deepEqual(option.supportedReasoningEfforts, reasoningEffortOptionsForModel("pi", option.value, LIVE).map((effort) => effort.value));
    assert.deepEqual(option.supportedReasoningEfforts, [...PI_REASONING_EFFORTS]);
    assert.equal("defaultReasoningEffort" in option, false);
  }

  for (const [label, detect, reason, retryable, routing] of NON_LIVE_CASES) {
    const { source } = await resolved("model", detect, routing);
    assert.equal(source.status, "fallback", label);
    assert.equal(source.reason, reason, label);
    assert.equal(source.retryable, retryable, label);
    assert.equal(source.retryable, RUNTIME_FORM_V2_REASON_RETRYABLE[reason as keyof typeof RUNTIME_FORM_V2_REASON_RETRYABLE], label);
    assert.equal(source.customValueAllowed, true, label);
    assert.deepEqual((source.options as Array<{ value: string }>).map((option) => option.value), RUNTIME_MODELS.pi!.map((model) => model.id), label);
    assert.equal(source.defaultValue, "default", label);
  }
  const replayed = await runtimeFormV2Entry("pi")!.resolveOptionSource(sourceContext(neverProbe, "handled").context);
  assert.deepEqual(replayed, { kind: "handled" });
  const unknown = await resolved("nope", neverProbe);
  assert.deepEqual(unknown.calls, []);
  assert.equal(unknown.source, null);
});

// ── Client state on the served form ──

async function servedSources(detect: () => Promise<RuntimeModelSourceOutcome> = async () => ({ kind: "live", value: { models: LIVE } })) {
  return {
    provider: (await resolved("provider", neverProbe)).source,
    model: (await resolved("model", detect)).source,
    providerModel: (await resolved("providerModel", neverProbe)).source,
  } as unknown as Record<string, RuntimeFormV2OptionSource>;
}

test("client state: switching to a built-in provider shows its key, list and default model; a typed Configured model hides the effort", async () => {
  const form = piForm();
  const sources = await servedSources();
  const field = (key: string) => form.fields.find((candidate) => candidate.key === key)!;
  let values = initialRuntimeFormV2Values(form, sources);
  assert.equal(values.provider, "configured");
  assert.equal(values.model, LIVE[0]!.id);
  const shown = () => form.fields.filter((candidate) => isRuntimeFormV2FieldVisible(candidate, values, sources)).map((candidate) => candidate.key);
  assert.deepEqual(shown(), ["provider", "model", "reasoningEffort", "envVars"]);
  assert.deepEqual(runtimeFormV2Choices(field("model"), sources, values), {
    kind: "select",
    options: (sources.model!.options ?? []).map((option) => ({ ...option })),
    allowEmpty: false,
    allowCustom: true,
  });

  values = applyRuntimeFormV2Change(form, sources, values, "provider", "deepseek");
  assert.deepEqual(shown(), ["provider", "apiKey", "providerModel", "providerReasoningEffort", "envVars"]);
  assert.equal(values.providerModel, piBuiltinProviderDefaultModel("deepseek"));
  const providerChoices = runtimeFormV2Choices(field("providerModel"), sources, values);
  assert.equal(providerChoices?.kind === "select" && providerChoices.allowCustom, false, "no typed model for a built-in provider");
  assert.deepEqual(validateRuntimeFormV2(form, sources, values), {});
  assert.deepEqual(runtimeFormV2Submission(form, values, sources), {
    provider: "deepseek", apiKey: "", providerModel: piBuiltinProviderDefaultModel("deepseek"), providerReasoningEffort: null, envVars: {},
  });

  values = applyRuntimeFormV2Change(form, sources, values, "provider", "configured");
  values = applyRuntimeFormV2Change(form, sources, values, "model", "my-org/typed");
  const effortChoices = runtimeFormV2Choices(field("reasoningEffort"), sources, values);
  assert.deepEqual(effortChoices?.kind === "select" ? effortChoices.options : null, [], "no effort menu for a typed custom model");
  assert.deepEqual(validateRuntimeFormV2(form, sources, values), {});
  assert.deepEqual(runtimeFormV2Submission(form, values, sources), { provider: "configured", model: "my-org/typed", reasoningEffort: null, envVars: {} });
});

// ── Submit: the legacy runtimeConfig ──

function legacy(input: {
  provider?: { providerId: string; apiKey: string };
  model: string;
  custom?: boolean;
  effort?: ReasoningEffort | null;
  envVars?: Record<string, string> | null;
}) {
  return buildRuntimeConfig({
    runtime: "pi",
    model: input.model,
    customModelMode: input.custom === true,
    customModelName: input.custom ? input.model : undefined,
    piProviderMode: input.provider?.providerId ?? PI_PROVIDER_CONFIGURED,
    piProviderApiKey: input.provider?.apiKey ?? "",
    reasoningEffort: input.effort ?? null,
    envVars: input.envVars ?? null,
  });
}

function submitted(values: Record<string, unknown>, options: Parameters<typeof buildRuntimeConfigFromFormValues>[2] = {}) {
  const built = buildRuntimeConfigFromFormValues("pi", values, options);
  assert.ok(built.ok, JSON.stringify(built));
  return built.runtimeConfig;
}

function assertSameAsLegacy(v2: Record<string, unknown>, expected: RuntimeConfig, message: string) {
  const parsed = parseRuntimeConfig({ runtimeConfig: v2 });
  assert.ok(parsed.ok, `${message}: ${parsed.ok ? "" : parsed.error}`);
  assert.equal(JSON.stringify(parsed.config), JSON.stringify(expected), message);
}

test("pi: v2 values assemble exactly the legacy runtimeConfig", () => {
  const cases: Array<[Record<string, unknown>, Parameters<typeof legacy>[0]]> = [
    // Configured: the bundled default is a preset, a typed model a custom one.
    [{ provider: "configured", model: "default", reasoningEffort: "", envVars: { K: "v" } }, { model: "default", envVars: { K: "v" } }],
    [{ provider: "configured", model: " my-org/pi-custom ", reasoningEffort: "high" }, { model: "my-org/pi-custom", custom: true, effort: "high" }],
    // A built-in provider: its key and a model from its list.
    [{ provider: "deepseek", apiKey: " sk-1 ", providerModel: "deepseek/deepseek-v4-pro", providerReasoningEffort: "xhigh" }, { provider: { providerId: "deepseek", apiKey: "sk-1" }, model: "deepseek/deepseek-v4-pro", effort: "xhigh" }],
    [{ provider: "deepseek", apiKey: "sk-2", providerModel: "deepseek/deepseek-flash", providerReasoningEffort: null, envVars: { A: "1" } }, { provider: { providerId: "deepseek", apiKey: "sk-2" }, model: "deepseek/deepseek-flash", envVars: { A: "1" } }],
    // Hidden fields' stale values are ignored, like legacy.
    [{ provider: "configured", apiKey: "stale", model: "default", providerModel: "deepseek/deepseek-flash", providerReasoningEffort: "low" }, { model: "default" }],
    [{ provider: "deepseek", apiKey: "sk-3", model: "stale/model", reasoningEffort: "low", providerModel: "deepseek/deepseek-v4-pro" }, { provider: { providerId: "deepseek", apiKey: "sk-3" }, model: "deepseek/deepseek-v4-pro" }],
  ];
  for (const [values, legacyInput] of cases) {
    assertSameAsLegacy(submitted(values), legacy(legacyInput), JSON.stringify(values));
  }
});

test("submit errors point at the field the user sees", () => {
  const issue = (values: Record<string, unknown>, options: Parameters<typeof buildRuntimeConfigFromFormValues>[2] = {}) => {
    const built = buildRuntimeConfigFromFormValues("pi", values, options);
    return built.ok ? null : built.issue;
  };
  for (const provider of [undefined, "", "default", "pi-builtin", "openai-compatible", 1]) {
    assert.deepEqual(issue({ provider, model: "default" }), { code: "select_valid_provider", pointer: "/formValues/provider" }, String(provider));
  }
  assert.deepEqual(issue({ provider: "configured", model: " " }), { code: "model_required", pointer: "/formValues/model" });
  assert.deepEqual(issue({ provider: "deepseek", apiKey: "k", providerModel: "" }), { code: "model_required", pointer: "/formValues/providerModel" });
  assert.deepEqual(issue({ provider: "deepseek", apiKey: "k", providerModel: "my-org/typed" }), { code: "select_valid_provider_model", pointer: "/formValues/providerModel" });
  assert.deepEqual(issue({ provider: "deepseek", apiKey: " ", providerModel: "deepseek/deepseek-v4-pro" }), { code: "api_key_required", pointer: "/formValues/apiKey" });
  assert.deepEqual(issue({ provider: "configured", model: "default", reasoningEffort: "turbo" }), { code: "invalid_reasoning_effort", pointer: "/formValues/reasoningEffort" });
  assert.deepEqual(issue({ provider: "configured", model: "default", reasoningEffort: 3 }), { code: "invalid_reasoning_effort", pointer: "/formValues/reasoningEffort" });
  assert.deepEqual(
    issue({ provider: "deepseek", apiKey: "k", providerModel: "deepseek/deepseek-v4-pro", providerReasoningEffort: "turbo" }),
    { code: "invalid_reasoning_effort", pointer: "/formValues/providerReasoningEffort" },
  );
  assert.equal(formValuesPointerForRuntimeConfigPointer("pi", "/runtimeConfig/provider/apiKey"), "/formValues/apiKey");
});

// ── Edit, and the write-only API key ──

const deepseek = (apiKey: string) => legacy({ provider: { providerId: "deepseek", apiKey }, model: "deepseek/deepseek-v4-pro", effort: "high", envVars: { KEEP: "1" } });

test("edit values round-trip the stored config; the API key is never part of the values", () => {
  const stored: RuntimeConfig[] = [
    deepseek("sk-stored"),
    legacy({ model: "my-org/pi-custom", custom: true, effort: "low" }),
    legacy({ model: "default", envVars: { C: "1" } }),
  ];
  for (const config of stored) {
    const values = runtimeFormValuesFromRuntimeConfig(config);
    assert.ok(values);
    assert.equal(JSON.stringify(values).includes("sk-stored"), false);
    assert.equal("apiKey" in values, false);
    // Saving the values unchanged (the key left blank) stores the same config once the PATCH path restores the key.
    const saved = retainOmittedWriteOnlySecrets(submitted({ ...values, apiKey: "" }, { editing: true, existing: config }), config);
    assertSameAsLegacy(saved as Record<string, unknown>, config, JSON.stringify(config));
  }
  assert.deepEqual(runtimeFormValuesFromRuntimeConfig(stored[0]!), {
    provider: "deepseek", providerModel: "deepseek/deepseek-v4-pro", providerReasoningEffort: "high", envVars: { KEEP: "1" },
  });
  assert.deepEqual(runtimeFormValuesFromRuntimeConfig(stored[1]!), { provider: "configured", model: "my-org/pi-custom", reasoningEffort: "low", envVars: {} });
  // A stored Pi config without a provider (older agents) is Configured.
  assert.deepEqual(
    runtimeFormValuesFromRuntimeConfig({ runtime: "pi", model: { kind: "preset", id: "default" } }),
    { provider: "configured", model: "default", reasoningEffort: "", envVars: {} },
  );
});

test("edit with a blank API key keeps the stored key only while the provider is unchanged", () => {
  const stored = deepseek("sk-stored");
  const values = { provider: "deepseek", apiKey: "", providerModel: "deepseek/deepseek-flash", providerReasoningEffort: "" };
  const built = submitted(values, { editing: true, existing: stored });
  assert.deepEqual(built.provider, { kind: "pi-builtin", providerId: "deepseek" }, "the key is omitted, not blank");
  const kept = retainOmittedWriteOnlySecrets(built, stored) as { provider: Record<string, unknown>; model: unknown };
  assert.equal(kept.provider.apiKey, "sk-stored");
  assert.deepEqual(kept.model, { kind: "preset", id: "deepseek/deepseek-flash" });

  const issue = (options: Parameters<typeof buildRuntimeConfigFromFormValues>[2]) => {
    const result = buildRuntimeConfigFromFormValues("pi", values, options);
    return result.ok ? null : result.issue;
  };
  const keyRequired = { code: "api_key_required", pointer: "/formValues/apiKey" };
  assert.deepEqual(issue({ editing: true, existing: legacy({ model: "default" }) }), keyRequired, "stored provider is Configured");
  assert.deepEqual(issue({ editing: true, existing: { ...stored, provider: { kind: "pi-builtin", providerId: "other", apiKey: "sk-other" } } as unknown as RuntimeConfig }), keyRequired, "another provider");
  assert.deepEqual(issue({ editing: true, existing: buildRuntimeConfig({ runtime: "codex", model: "gpt-5.5", customModelMode: false }) }), keyRequired, "another runtime");
  assert.deepEqual(issue({ editing: false, existing: stored }), keyRequired, "create never inherits");
  // A typed key replaces the stored one.
  const replaced = retainOmittedWriteOnlySecrets(submitted({ ...values, apiKey: "sk-new" }, { editing: true, existing: stored }), stored) as { provider: Record<string, unknown> };
  assert.equal(replaced.provider.apiKey, "sk-new");
  // Switching to Configured drops the key entirely.
  const toConfigured = retainOmittedWriteOnlySecrets(submitted({ provider: "configured", model: "default" }, { editing: true, existing: stored }), stored) as { provider: Record<string, unknown> };
  assert.deepEqual(toConfigured.provider, { kind: "default" });
});

test("legacy (v1) Pi saves are unchanged: the read keeps the key and a full legacy config passes through the PATCH path untouched", () => {
  // The legacy web edit prefills the key from GET /api/agents/:id
  // (runtimeConfigPiProviderApiKey) and refuses a blank one; see PI_BUILTIN_PROVIDER_API_KEY.
  const stored = deepseek("sk-stored");
  assert.equal(redactWriteOnlyRuntimeConfig(stored), stored);
  assert.deepEqual(runtimeFormV2Entry("pi")!.writeOnlySecrets?.map((secret) => [secret.path, secret.redactOnAgentRead]), [[["provider", "apiKey"], false]]);
  const configured = legacy({ model: "my-org/pi-custom", custom: true, effort: "medium" });
  assert.equal(redactWriteOnlyRuntimeConfig(configured), configured);
  // Every config the legacy builder produces carries the key when it has one,
  // so the PATCH path returns it as sent (same object), for every stored config.
  const incoming = [
    deepseek("sk-typed"),
    legacy({ provider: { providerId: "deepseek", apiKey: "sk-flash" }, model: "deepseek/deepseek-flash" }),
    configured,
    legacy({ model: "default" }),
  ];
  for (const existing of [stored, configured]) {
    for (const config of incoming) {
      assert.equal(retainOmittedWriteOnlySecrets(config, existing), config, `${JSON.stringify(config)} over ${JSON.stringify(existing)}`);
    }
  }
  // The secret applies only to a built-in provider.
  const secret = runtimeFormV2Entry("pi")!.writeOnlySecrets![0]!;
  assert.equal(secret.appliesTo(stored as unknown as Record<string, unknown>), true);
  assert.equal(secret.appliesTo(configured as unknown as Record<string, unknown>), false);
});

// ── Submit: the live model list ──

async function reconcile(values: Record<string, unknown>, models: RuntimeModelInfo[]) {
  const parsed = parseRuntimeConfig({ runtimeConfig: submitted(values) });
  assert.ok(parsed.ok);
  let probed = 0;
  const result = await reconcileRuntimeFormV2SubmissionWithLiveModels({
    runtimeConfig: parsed.config,
    submittedReasoningEffort: values.reasoningEffort ?? values.providerReasoningEffort ?? null,
    machineId: "machine-1",
    detect: async () => {
      probed += 1;
      return { kind: "live", value: { models } };
    },
  });
  return { result, probed };
}

test("a Configured model only the live list names is stored as a preset (legacy picks it from the list); built-in providers keep their catalog rule", async () => {
  const live = await reconcile({ provider: "configured", model: LIVE[0]!.id, reasoningEffort: "high" }, LIVE);
  assert.equal(live.result.kind, "updated");
  const config = (live.result as { runtimeConfig: RuntimeConfig }).runtimeConfig;
  assert.deepEqual(config.model, { kind: "preset", id: LIVE[0]!.id });
  assert.equal(config.reasoningEffort, "high");
  assert.deepEqual(config.provider, { kind: "default" });
  assertSameAsLegacy(config as unknown as Record<string, unknown>, legacy({ model: LIVE[0]!.id, effort: "high" }), "same as the legacy pick from the live list");
  // Pi offers every Pi thinking level for every model (Pi maps one a model
  // does not take); a value outside that set is refused at the field.
  for (const effort of ["off", "minimal", "max"]) {
    const accepted = await reconcile({ provider: "configured", model: LIVE[0]!.id, reasoningEffort: effort }, LIVE);
    assert.equal(accepted.result.kind, "updated", effort);
    assert.equal((accepted.result as { runtimeConfig: RuntimeConfig }).runtimeConfig.reasoningEffort, effort);
  }
  assert.deepEqual(
    (await reconcile({ provider: "configured", model: LIVE[0]!.id, reasoningEffort: "ultra" }, LIVE)).result,
    { kind: "rejected", issue: { code: "reasoning_effort_not_supported", pointer: "/formValues/reasoningEffort" } },
  );
  // A typed model the live list does not name stays custom.
  assert.deepEqual((await reconcile({ provider: "configured", model: "my-org/typed" }, LIVE)).result, { kind: "unchanged" });
  // A built-in provider's model is checked against its own catalog, never the Computer's list.
  assert.deepEqual(
    (await reconcile({ provider: "deepseek", apiKey: "k", providerModel: "deepseek/deepseek-v4-pro", providerReasoningEffort: "high" }, LIVE)).result,
    { kind: "unchanged" },
  );
});
