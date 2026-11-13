/**
 * Runtime form v2 batch 3a: Codex and Grok, the first forms that need client
 * capabilities (`select.custom_value`; `choice.labels` and `option_source.status`
 * are always on and never listed).
 *
 * Oracles:
 * - the legacy web form: its runtimeConfig builder
 *   (packages/web/src/utils/runtimeConfigForm.ts buildRuntimeConfig), its effort
 *   picker (utils/reasoningEffortOptions.ts) and its English copy (i18n en.ts);
 * - the contract's probe outcome → reason/retryable table
 *   (runtimeFormV2SourceStatus.ts).
 */
import assert from "node:assert/strict";
import {
  parseRuntimeFormV2,
  RUNTIME_FORM_V2_OPTION_SOURCE_REASONS,
  worseRuntimeFormV2OptionSourceStatus,
  type RuntimeFormV2OptionSourceStatus,
} from "@botiverse/raft-runtime-form";
import {
  BASE_REASONING_EFFORTS,
  parseRuntimeConfig,
  REASONING_EFFORTS,
  RUNTIME_CONFIG_VERSION,
  RUNTIME_MODELS,
  type ReasoningEffort,
  type RuntimeConfig,
  type RuntimeModelInfo,
  type RuntimeModelSourceOutcome,
} from "@botiverse/raft-shared";

import { en } from "../../../web/src/i18n/messages/en";
import { reasoningEffortOptionsForModel } from "../../../web/src/utils/reasoningEffortOptions";
import { buildRuntimeConfig } from "../../../web/src/utils/runtimeConfigForm";
import { RouteFailureError } from "../tracing/routeFailure";
import { runtimeFormV1Entry } from "./runtimeFormDefinitionService";
import {
  buildRuntimeConfigFromFormValues,
  buildRuntimeFormV2,
  reasoningEffortChoices,
  reasoningModelOptionSource,
  reconcileRuntimeFormV2SubmissionWithLiveModels,
  runtimeFormV2Entry,
  runtimeFormV2RuntimeIds,
  runtimeFormValuesFromRuntimeConfig,
  type RuntimeFormOptionSourceContext,
} from "./runtimeFormV2Registry";
import {
  optionSourceReasonForOutcome,
  optionSourceReasonForProbeError,
  RUNTIME_FORM_V2_REASON_RETRYABLE,
} from "./runtimeFormV2SourceStatus";

const wire = (value: unknown) => JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

// ── Forms ──

test("codex and grok forms: fields by kind, capabilities, effort labels", () => {
  const expectations = {
    codex: {
      fields: [
        ["model", "select", true, false],
        ["reasoningEffort", "derived_select", false, false],
        ["fastMode", "boolean", false, false],
        ["envVars", "string_map", false, true],
      ],
      capabilities: ["select.custom_value"],
    },
    grok: {
      fields: [
        ["model", "select", true, false],
        ["reasoningEffort", "derived_select", false, false],
        ["envVars", "string_map", false, true],
      ],
      capabilities: [],
    },
  } as const;
  for (const [runtime, expected] of Object.entries(expectations)) {
    const form = buildRuntimeFormV2(runtime);
    const parsed = parseRuntimeFormV2(wire(form));
    assert.ok(parsed, runtime);
    assert.deepEqual(parsed.fields.map((field) => [field.key, field.kind, field.required, field.advanced]), expected.fields, runtime);
    assert.deepEqual(parsed.requiredClientCapabilities, expected.capabilities, runtime);
    assert.deepEqual(parsed.blockingFieldKeys, [], runtime);
    assert.deepEqual(parsed.fields.find((field) => field.key === "reasoningEffort")?.derivedFrom, {
      key: "model", attribute: "supportedReasoningEfforts", defaultAttribute: "defaultReasoningEffort",
    }, runtime);
    assert.deepEqual(parsed.fields.find((field) => field.key === "reasoningEffort")?.choices, reasoningEffortChoices(), runtime);
    assert.deepEqual(runtimeFormV2Entry(runtime)!.validateProjection(), [], runtime);
    // A v2-only form: the v1 routes and the admission row's v1 ref never see it.
    assert.equal(runtimeFormV1Entry(runtime), null, runtime);
  }
});

test("effort choices carry exactly the legacy web picker's English labels and descriptions", () => {
  const messages = en as Record<string, string>;
  const choices = reasoningEffortChoices();
  assert.deepEqual(Object.keys(choices), REASONING_EFFORTS.map((effort) => effort.id));
  for (const effort of REASONING_EFFORTS) {
    assert.deepEqual(choices[effort.id], {
      label: messages[`agent.reasoningEffort.${effort.id}`],
      description: messages[`agent.reasoningEffort.${effort.id}Description`],
    }, effort.id);
  }
});

// ── Option sources: status per the probe outcome ──

function sourceContext(detect: () => Promise<RuntimeModelSourceOutcome>, routing: "confirmed_local" | "handled" | "not_routed" = "confirmed_local", sourceId = "model") {
  const calls: string[] = [];
  const context = {
    sourceId,
    machineId: "machine-1",
    machine: {},
    // The v2 endpoint; the capability test below also resolves as v1.
    sourceStatus: true,
    agentOrchestrator: {
      detectMachineRuntimeModels: async (_machineId: string, runtime: string) => {
        calls.push(runtime);
        return detect();
      },
      detectMachineRuntimeModelsWithAuthority: async () => { throw new Error("not used"); },
    },
    routeToComputer: async () => routing,
  } as unknown as RuntimeFormOptionSourceContext;
  return { context, calls };
}

async function resolvedSource(runtime: string, detect: () => Promise<RuntimeModelSourceOutcome>, routing?: "confirmed_local" | "handled" | "not_routed") {
  const resolution = await runtimeFormV2Entry(runtime)!.resolveOptionSource(sourceContext(detect, routing).context);
  assert.equal(resolution.kind, "source");
  return wire((resolution as { source: unknown }).source);
}

const LIVE: RuntimeModelInfo[] = [
  { id: "gpt-live-a", label: "Live A", supportedReasoningEfforts: ["low", "medium", "max"], defaultReasoningEffort: "medium" },
  { id: "gpt-5.5", label: "GPT-5.5 (live)" },
];

/** Every probe outcome, with the reason and retryable the contract table assigns. */
const NON_LIVE_CASES: Array<[string, () => Promise<RuntimeModelSourceOutcome>, string, boolean, ("not_routed" | undefined)?]> = [
  ["missing_config", async () => ({ kind: "missing_config" }), "missing_config", false],
  ["no_models", async () => ({ kind: "no_models" }), "no_models", true],
  ["live but empty", async () => ({ kind: "live", value: { models: [] } }), "no_models", true],
  ["unsupported", async () => ({ kind: "unsupported" }), "unsupported", false],
  ["error detect_timeout", async () => ({ kind: "error", retryable: true, code: "detect_timeout" }), "probe_timeout", true],
  ["error computer_offline", async () => ({ kind: "error", retryable: true, code: "computer_offline" }), "machine_offline", true],
  ["error detect_failed", async () => ({ kind: "error", retryable: false, code: "detect_failed" }), "probe_failed", true],
  ["error runtime_not_found", async () => ({ kind: "error", retryable: true, code: "runtime_not_found" }), "probe_failed", true],
  ["error without code", async () => ({ kind: "error", retryable: true }), "probe_failed", true],
  ["server wait timed out", async () => { throw new RouteFailureError("daemon_timeout", "timed out"); }, "probe_timeout", true],
  ["machine socket not ready", async () => { throw new RouteFailureError("daemon_offline", "offline"); }, "machine_offline", true],
  ["probe threw", async () => { throw new Error("boom"); }, "probe_failed", true],
  ["not routed to this replica", async () => { throw new Error("must not probe"); }, "machine_offline", true, "not_routed"],
];

test("status per probe outcome: live has no reason; every non-live outcome falls back to the bundled list with the table's reason and retryable", async () => {
  for (const runtime of ["codex", "grok"]) {
    const live = await resolvedSource(runtime, async () => ({ kind: "live", value: { models: LIVE, default: "gpt-5.5" } }));
    assert.equal(live.status, "live", runtime);
    assert.equal("reason" in live, false, runtime);
    assert.equal("retryable" in live, false, runtime);
    assert.equal(live.defaultValue, "gpt-5.5");
    assert.deepEqual((live.options as Array<{ value: string }>).map((option) => option.value), ["gpt-live-a", "gpt-5.5"]);
    assert.equal(live.customValueAllowed, runtime === "codex" ? true : undefined, runtime);

    for (const [label, detect, reason, retryable, routing] of NON_LIVE_CASES) {
      const source = await resolvedSource(runtime, detect, routing);
      assert.equal(source.status, "fallback", `${runtime} ${label}`);
      assert.equal(source.reason, reason, `${runtime} ${label}`);
      assert.equal(source.retryable, retryable, `${runtime} ${label}`);
      assert.deepEqual(
        (source.options as Array<{ value: string }>).map((option) => option.value),
        (RUNTIME_MODELS[runtime] ?? []).map((model) => model.id),
        `${runtime} ${label}: the bundled list, as legacy offers`,
      );
      assert.equal(source.defaultValue, RUNTIME_MODELS[runtime]![0]!.id, `${runtime} ${label}`);
    }
    const replayed = await runtimeFormV2Entry(runtime)!.resolveOptionSource(sourceContext(async () => { throw new Error("no"); }, "handled").context);
    assert.deepEqual(replayed, { kind: "handled" });
    const unknown = await runtimeFormV2Entry(runtime)!.resolveOptionSource(sourceContext(async () => { throw new Error("no"); }, "confirmed_local", "provider").context);
    assert.deepEqual(unknown, { kind: "source", source: null });
  }
});

test("the reason table covers every contract reason, and each mapping helper follows it", () => {
  assert.deepEqual(Object.keys(RUNTIME_FORM_V2_REASON_RETRYABLE).sort(), [...RUNTIME_FORM_V2_OPTION_SOURCE_REASONS].sort());
  assert.equal(optionSourceReasonForOutcome({ kind: "live", value: { models: LIVE } }), null);
  assert.equal(optionSourceReasonForProbeError(new RouteFailureError("daemon_timeout", "t")), "probe_timeout");
  assert.equal(optionSourceReasonForProbeError(new RouteFailureError("daemon_offline", "o")), "machine_offline");
  assert.equal(optionSourceReasonForProbeError(new Error("x")), "probe_failed");
  assert.equal(optionSourceReasonForProbeError(undefined), "probe_failed");
});

test("no bundled list to fall back on: unavailable with no options", () => {
  for (const reason of RUNTIME_FORM_V2_OPTION_SOURCE_REASONS) {
    const source = wire(reasoningModelOptionSource("codex", [], undefined, reason, { customModel: true }));
    assert.equal(source.status, "unavailable", reason);
    assert.deepEqual(source.options, [], reason);
    assert.equal(source.defaultValue, "", reason);
    assert.equal(source.reason, reason);
    assert.equal(source.retryable, RUNTIME_FORM_V2_REASON_RETRYABLE[reason], reason);
  }
});

test("per source, the worst status wins: unavailable > fallback > live", () => {
  const statuses: RuntimeFormV2OptionSourceStatus[] = ["live", "fallback", "unavailable"];
  for (const a of statuses) {
    for (const b of statuses) {
      const expected = statuses[Math.max(statuses.indexOf(a), statuses.indexOf(b))];
      assert.equal(worseRuntimeFormV2OptionSourceStatus(a, b), expected, `${a} vs ${b}`);
    }
  }
});

test("every model option carries its efforts, resolved exactly like the legacy web picker", async () => {
  for (const runtime of ["codex", "grok"]) {
    const liveModels: RuntimeModelInfo[] = [
      ...LIVE,
      // A live entry without efforts for a bundled model: the bundled declaration applies.
      { id: RUNTIME_MODELS[runtime]![0]!.id, label: "Bundled first, live" },
      // Unknown effort ids are not offered (the picker filters the catalog).
      { id: "odd", label: "Odd", supportedReasoningEfforts: ["turbo", "high"], defaultReasoningEffort: "turbo" },
    ];
    const lists = [
      await resolvedSource(runtime, async () => ({ kind: "live", value: { models: liveModels } })),
      await resolvedSource(runtime, async () => ({ kind: "missing_config" })),
    ];
    for (const source of lists) {
      const models = source.status === "live" ? liveModels : RUNTIME_MODELS[runtime]!;
      for (const option of source.options as Array<{ value: string; supportedReasoningEfforts?: string[]; defaultReasoningEffort?: string }>) {
        const legacy = reasoningEffortOptionsForModel(runtime, option.value, models).map((effort) => effort.value);
        assert.ok(option.supportedReasoningEfforts && option.supportedReasoningEfforts.length > 0, `${runtime} ${option.value} carries efforts`);
        assert.deepEqual(option.supportedReasoningEfforts, legacy, `${runtime} ${option.value}`);
      }
    }
    const liveOptions = lists[0]!.options as Array<{ value: string; supportedReasoningEfforts: string[]; defaultReasoningEffort?: string }>;
    assert.deepEqual(liveOptions.find((option) => option.value === "gpt-live-a"), {
      value: "gpt-live-a", label: "Live A", supportedReasoningEfforts: ["low", "medium", "max"], defaultReasoningEffort: "medium",
    });
    // No declared set: the BASE efforts and no default (the runtime's own default applies).
    const undeclared = liveOptions.find((option) => option.value === "gpt-5.5");
    assert.deepEqual(undeclared?.supportedReasoningEfforts, [...BASE_REASONING_EFFORTS], runtime);
    assert.equal(undeclared && "defaultReasoningEffort" in undeclared, false, runtime);
    assert.equal(liveOptions.find((option) => option.value === "odd")?.defaultReasoningEffort, undefined, "a default outside the set is dropped");
  }
  // Codex GPT-5.6 Luna declares no ultra; Sol does.
  const codexFallback = (await resolvedSource("codex", async () => ({ kind: "unsupported" }))).options as Array<{ value: string; supportedReasoningEfforts: string[]; defaultReasoningEffort?: string }>;
  assert.deepEqual(codexFallback.find((option) => option.value === "gpt-5.6-luna")?.supportedReasoningEfforts, ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(codexFallback.find((option) => option.value === "gpt-5.6-sol")?.defaultReasoningEffort, "medium");
  assert.deepEqual(codexFallback.find((option) => option.value === "gpt-5.5")?.supportedReasoningEfforts, [...BASE_REASONING_EFFORTS]);
});

// ── Forms without the capability keep their option-source behaviour ──

// Runtimes whose model source keeps the pre-status body (no probe status);
// every other model source says whether it is live (`option_source.status`,
// always on, never listed).
const UNPROBED_MODEL_RUNTIMES = new Set(["opencode", "kimi", "gemini"]);

test("no form lists choice.labels or option_source.status; status follows the probe, customValueAllowed the listed capability", async () => {
  const outcomes: Array<[() => Promise<RuntimeModelSourceOutcome>, ("not_routed" | undefined)?]> = [
    [async () => ({ kind: "live", value: { models: LIVE } })],
    ...NON_LIVE_CASES.map(([, detect, , , routing]) => [detect, routing] as [() => Promise<RuntimeModelSourceOutcome>, ("not_routed" | undefined)?]),
  ];
  for (const runtime of runtimeFormV2RuntimeIds()) {
    const entry = runtimeFormV2Entry(runtime)!;
    const form = buildRuntimeFormV2(runtime);
    const capabilities = new Set(form.requiredClientCapabilities ?? []);
    const localization = form.uiSchema?.localization ?? {};
    assert.equal(capabilities.has("choice.labels"), false, `${runtime}: choice.labels is never required`);
    assert.equal(capabilities.has("option_source.status"), false, `${runtime}: option_source.status is never required`);
    for (const copy of Object.values(localization)) {
      if (copy && "choices" in copy) assert.equal(typeof copy.choices, "object", `${runtime}: choices`);
    }
    // A runtime that also has a v1 form must keep status off its v1 bodies:
    // v1 clients parse strictly and never asked for it.
    const hasV1 = runtimeFormV1Entry(runtime) !== null;
    for (const sourceId of Object.keys(form.optionSources ?? {})) {
      for (const [detect, routing] of outcomes) {
        const context = sourceContext(detect, routing, sourceId).context;
        (context.agentOrchestrator as unknown as Record<string, unknown>).detectMachineRuntimeModelsWithAuthority = async () => {
          throw new RouteFailureError("daemon_offline", "offline");
        };
        if (hasV1) {
          const v1Resolution = await entry.resolveOptionSource({ ...context, sourceStatus: false }).catch(() => null);
          if (v1Resolution?.kind === "source" && v1Resolution.source) {
            for (const key of ["status", "reason", "retryable"]) {
              assert.equal(key in v1Resolution.source, false, `${runtime}/${sourceId}: no ${key} on v1`);
            }
          }
        }
        let resolution;
        try {
          resolution = await entry.resolveOptionSource(context);
        } catch {
          continue; // builtin's catalog error stays a typed 409, as before
        }
        if (resolution.kind !== "source" || !resolution.source) continue;
        const source = resolution.source as unknown as Record<string, unknown>;
        for (const key of ["status", "reason", "retryable"]) {
          if (UNPROBED_MODEL_RUNTIMES.has(runtime)) assert.equal(key in source, false, `${runtime}/${sourceId}: ${key}`);
        }
        if (!capabilities.has("select.custom_value")) assert.equal("customValueAllowed" in source, false, `${runtime}/${sourceId}: customValueAllowed`);
        // A probed model source always carries status; customValueAllowed
        // whenever the form lists select.custom_value. A
        // static source (Claude's provider select) has no probe to report on and
        // never allows a typed value (status omitted, customValueAllowed false).
        if (sourceId === "model") {
          if (!UNPROBED_MODEL_RUNTIMES.has(runtime)) assert.ok(typeof source.status === "string", `${runtime}/${sourceId}: status`);
          assert.equal(source.customValueAllowed === true, capabilities.has("select.custom_value"), `${runtime}/${sourceId}: customValueAllowed`);
        } else {
          assert.equal("status" in source, false, `${runtime}/${sourceId}: a static source has no status`);
          assert.notEqual(source.customValueAllowed, true, `${runtime}/${sourceId}: no typed value`);
        }
      }
    }
  }
});

// ── Submit: the legacy runtimeConfig ──

function legacy(runtime: string, input: { model: string; custom?: boolean; fast?: boolean; effort?: ReasoningEffort | null; envVars?: Record<string, string> | null }) {
  return buildRuntimeConfig({
    runtime,
    model: input.model,
    customModelMode: input.custom === true,
    customModelName: input.custom ? input.model : undefined,
    providerMode: "default",
    providerApiUrl: "",
    providerApiKey: "",
    fastMode: input.fast === true,
    reasoningEffort: input.effort ?? null,
    envVars: input.envVars ?? null,
    command: "",
  });
}

function submitted(runtime: string, values: Record<string, unknown>, options: Parameters<typeof buildRuntimeConfigFromFormValues>[2] = {}) {
  const built = buildRuntimeConfigFromFormValues(runtime, values, options);
  assert.ok(built.ok, JSON.stringify(built));
  return built.runtimeConfig;
}

function assertSameAsLegacy(v2: Record<string, unknown>, expected: RuntimeConfig, message: string) {
  const parsed = parseRuntimeConfig({ runtimeConfig: v2 });
  assert.ok(parsed.ok, message);
  assert.equal(JSON.stringify(parsed.config), JSON.stringify(expected), message);
}

test("codex and grok: v2 values assemble exactly the legacy runtimeConfig, create and edit", () => {
  const cases: Array<[string, Record<string, unknown>, Parameters<typeof legacy>[1]]> = [
    ["codex", { model: "gpt-5.6-sol", reasoningEffort: "ultra", fastMode: true, envVars: { K: "v" } }, { model: "gpt-5.6-sol", effort: "ultra", fast: true, envVars: { K: "v" } }],
    ["codex", { model: "gpt-5.6-luna", reasoningEffort: "max", fastMode: false, envVars: {} }, { model: "gpt-5.6-luna", effort: "max" }],
    ["codex", { model: "gpt-5.5", reasoningEffort: null, fastMode: false }, { model: "gpt-5.5" }],
    ["codex", { model: "gpt-5.5", reasoningEffort: "", fastMode: true }, { model: "gpt-5.5", fast: true }],
    // Custom model: a typed value that is not listed.
    ["codex", { model: "my-org/codex-custom", reasoningEffort: "high", fastMode: false }, { model: "my-org/codex-custom", custom: true, effort: "high" }],
    ["codex", { model: "  my-org/padded  ", reasoningEffort: null, fastMode: true }, { model: "my-org/padded", custom: true, fast: true }],
    ["grok", { model: "grok-4.5", reasoningEffort: "high", envVars: { G: "1" } }, { model: "grok-4.5", effort: "high", envVars: { G: "1" } }],
    ["grok", { model: "grok-composer-2.5-fast", reasoningEffort: "" }, { model: "grok-composer-2.5-fast" }],
    // Grok has no custom model: an unlisted value is still a preset, as legacy sends it.
    ["grok", { model: "grok-live-only", reasoningEffort: "low" }, { model: "grok-live-only", effort: "low" }],
  ];
  for (const [runtime, values, legacyInput] of cases) {
    for (const editing of [false, true]) {
      assertSameAsLegacy(submitted(runtime, values, { editing }), legacy(runtime, legacyInput), `${runtime} ${JSON.stringify(values)} editing=${editing}`);
    }
  }
  // Grok has no fast mode field: a stray value is ignored like legacy (fast mode is Codex/Claude only).
  assertSameAsLegacy(submitted("grok", { model: "grok-4.5", fastMode: true }), legacy("grok", { model: "grok-4.5" }), "grok fastMode ignored");
  assert.deepEqual(submitted("codex", { model: "gpt-5.5", fastMode: true, envVars: { K: "v" } }), {
    version: RUNTIME_CONFIG_VERSION,
    runtime: "codex",
    model: { kind: "preset", id: "gpt-5.5" },
    mode: { kind: "fast" },
    reasoningEffort: null,
    envVars: { K: "v" },
  });
});

test("edit values round-trip the stored config: preset, custom model, fast mode, effort", () => {
  const stored: RuntimeConfig[] = [
    legacy("codex", { model: "gpt-5.6-sol", effort: "xhigh", fast: true, envVars: { KEEP: "1" } }),
    legacy("codex", { model: "my-org/custom", custom: true, effort: "low" }),
    legacy("codex", { model: "gpt-5.5" }),
    legacy("grok", { model: "grok-4.5", effort: "medium", envVars: { G: "1" } }),
  ];
  for (const config of stored) {
    const values = runtimeFormValuesFromRuntimeConfig(config);
    assert.ok(values, config.runtime);
    assert.equal("fastMode" in values, config.runtime === "codex", config.runtime);
    assertSameAsLegacy(submitted(config.runtime, values, { editing: true, existing: config }), config, JSON.stringify(config));
  }
  assert.deepEqual(runtimeFormValuesFromRuntimeConfig(stored[1]!), { model: "my-org/custom", reasoningEffort: "low", fastMode: false, envVars: {} });
});

test("codex/grok submit errors point at the field", () => {
  for (const runtime of ["codex", "grok"]) {
    assert.deepEqual(buildRuntimeConfigFromFormValues(runtime, { model: " " }), { ok: false, issue: { code: "model_required", pointer: "/formValues/model" } });
    assert.deepEqual(buildRuntimeConfigFromFormValues(runtime, { model: "m", reasoningEffort: 3 }), { ok: false, issue: { code: "invalid_reasoning_effort", pointer: "/formValues/reasoningEffort" } });
  }
  assert.deepEqual(buildRuntimeConfigFromFormValues("codex", { model: "m", fastMode: "yes" }), { ok: false, issue: { code: "invalid_boolean", pointer: "/formValues/fastMode" } });
  // An effort outside the vocabulary fails the ordinary validation (a 400 the route points at /formValues/reasoningEffort).
  const parsed = parseRuntimeConfig({ runtimeConfig: submitted("codex", { model: "gpt-5.5", reasoningEffort: "turbo" }) });
  assert.equal(parsed.ok, false);
});

// ── Submit: the live model list decides what the bundled one cannot ──

function normalized(runtime: string, values: Record<string, unknown>): RuntimeConfig {
  const parsed = parseRuntimeConfig({ runtimeConfig: submitted(runtime, values) });
  assert.ok(parsed.ok);
  return parsed.config;
}

async function reconcile(runtime: string, values: Record<string, unknown>, detect: () => Promise<RuntimeModelSourceOutcome>, machineId: string | null = "machine-1") {
  const probes: string[] = [];
  const result = await reconcileRuntimeFormV2SubmissionWithLiveModels({
    runtimeConfig: normalized(runtime, values),
    submittedReasoningEffort: submitted(runtime, values).reasoningEffort,
    machineId,
    detect: async (_machineId, probed) => {
      probes.push(probed);
      return detect();
    },
  });
  return { result, probes };
}

const liveList = (models: RuntimeModelInfo[]) => async (): Promise<RuntimeModelSourceOutcome> => ({ kind: "live", value: { models } });

test("an effort the live list offers for a live-only model is kept (the static rule alone would drop it)", async () => {
  // Grok: a model the bundled list does not know gets the BASE efforts from the
  // static rule, so `max` is normalized away before the live check.
  const grokValues = { model: "grok-live-only", reasoningEffort: "max" };
  assert.equal(normalized("grok", grokValues).reasoningEffort, null, "static rule: dropped");
  const grok = await reconcile("grok", grokValues, liveList([{ id: "grok-live-only", label: "Live", supportedReasoningEfforts: ["low", "max"] }]));
  assert.equal(grok.result.kind, "updated");
  const grokConfig = (grok.result as { runtimeConfig: RuntimeConfig }).runtimeConfig;
  assert.equal(grokConfig.reasoningEffort, "max");
  assert.deepEqual(grokConfig.model, { kind: "preset", id: "grok-live-only" });
  assert.deepEqual(grok.probes, ["grok"]);

  // Codex: a model only the live list names is stored as a preset (legacy
  // picks it from the live list), with the live-offered effort.
  const codex = await reconcile("codex", { model: "gpt-7-live", reasoningEffort: "ultra" }, liveList([
    { id: "gpt-7-live", label: "GPT-7", supportedReasoningEfforts: ["medium", "ultra"], defaultReasoningEffort: "medium" },
  ]));
  assert.equal(codex.result.kind, "updated");
  const codexConfig = (codex.result as { runtimeConfig: RuntimeConfig }).runtimeConfig;
  assert.deepEqual(codexConfig.model, { kind: "preset", id: "gpt-7-live" });
  assert.equal(codexConfig.reasoningEffort, "ultra");
  assert.ok(parseRuntimeConfig({ runtimeConfig: codexConfig }).ok, "the reconciled config is still a valid config");
});

test("an effort the live list does not offer for the selected model is refused at /formValues/reasoningEffort", async () => {
  const cases: Array<[string, Record<string, unknown>, RuntimeModelInfo[]]> = [
    ["codex", { model: "gpt-5.6-sol", reasoningEffort: "ultra" }, [{ id: "gpt-5.6-sol", label: "Sol", supportedReasoningEfforts: ["low", "medium"] }]],
    // A live model without declared efforts, unknown to the bundle: BASE only.
    ["grok", { model: "grok-live-only", reasoningEffort: "max" }, [{ id: "grok-live-only", label: "Live" }]],
  ];
  for (const [runtime, values, models] of cases) {
    const { result } = await reconcile(runtime, values, liveList(models));
    assert.deepEqual(result, { kind: "rejected", issue: { code: "reasoning_effort_not_supported", pointer: "/formValues/reasoningEffort" } }, runtime);
  }
});

test("without a live list naming the model the static rule stands; nothing to decide means no probe", async () => {
  const values = { model: "grok-live-only", reasoningEffort: "max" };
  for (const detect of [
    async (): Promise<RuntimeModelSourceOutcome> => ({ kind: "missing_config" }),
    async (): Promise<RuntimeModelSourceOutcome> => ({ kind: "error", retryable: true, code: "detect_timeout" }),
    async (): Promise<RuntimeModelSourceOutcome> => { throw new RouteFailureError("daemon_offline", "offline"); },
    liveList([]),
    liveList([{ id: "someone-else", label: "Other", supportedReasoningEfforts: ["max"] }]),
  ]) {
    const { result } = await reconcile("grok", values, detect);
    assert.deepEqual(result, { kind: "unchanged" });
  }
  // A custom Codex model the live list does not name stays custom, with its effort (custom models are not gated).
  const custom = await reconcile("codex", { model: "my-org/custom", reasoningEffort: "high" }, liveList(LIVE));
  assert.deepEqual(custom.result, { kind: "unchanged" });
  assert.equal(normalized("codex", { model: "my-org/custom", reasoningEffort: "high" }).reasoningEffort, "high");

  const noEffort = await reconcile("codex", { model: "gpt-5.5", reasoningEffort: null }, liveList(LIVE));
  assert.deepEqual(noEffort, { result: { kind: "unchanged" }, probes: [] });
  const noMachine = await reconcile("codex", { model: "gpt-5.5", reasoningEffort: "low" }, liveList(LIVE), null);
  assert.deepEqual(noMachine, { result: { kind: "unchanged" }, probes: [] });
  // Runtimes without a live-model hook are never probed here.
  const opencode = await reconcileRuntimeFormV2SubmissionWithLiveModels({
    runtimeConfig: normalized("opencode", { model: "default" }),
    submittedReasoningEffort: "high",
    machineId: "machine-1",
    detect: async () => { throw new Error("must not probe"); },
  });
  assert.deepEqual(opencode, { kind: "unchanged" });
});
