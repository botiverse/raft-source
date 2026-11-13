/**
 * Runtime form v2 batch 2: OpenCode (creatable) and the deprecated Kimi CLI and
 * Gemini CLI (edit only). Each form carries no new contract
 * feature and no requiredClientCapabilities; a v2 submit must assemble exactly
 * the runtimeConfig the legacy web form sends for the same inputs, so the
 * legacy builder (packages/web/src/utils/runtimeConfigForm.ts buildRuntimeConfig)
 * is the oracle here, called with the arguments the legacy create/edit dialogs
 * pass for these runtimes.
 *
 * Antigravity (revived on the OAR host) is here too, as it was a batch-2 form:
 * it now has the live-list model form with a reasoning effort (the OAR
 * `listModels` of the Computer's `agy`), and a stored model or effort is kept
 * on edit. CodeBuddy Code (OAR-only) has the same form shape, so it is pinned
 * beside it.
 */
import assert from "node:assert/strict";
import { parseRuntimeFormV2 } from "@botiverse/raft-runtime-form";
import {
  parseRuntimeConfig,
  RUNTIME_CONFIG_VERSION,
  RUNTIME_MODELS,
  type RuntimeConfig,
  type RuntimeModelInfo,
  type RuntimeModelSourceOutcome,
} from "@botiverse/raft-shared";

import { buildRuntimeConfig } from "../../../web/src/utils/runtimeConfigForm";
import { RouteFailureError } from "../tracing/routeFailure";
import {
  buildRuntimeConfigFromFormValues,
  buildRuntimeFormV2,
  formValuesPointerForRuntimeConfigPointer,
  reconcileRuntimeFormV2SubmissionWithLiveModels,
  runtimeFormV2Entry,
  runtimeFormValuesFromRuntimeConfig,
  staticModelFallbackOptionSource,
  type RuntimeFormOptionSourceContext,
} from "./runtimeFormV2Registry";

const wire = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

/** What the legacy web create/edit dialogs send for a runtime with no provider, fast mode, reasoning or command. */
function legacyRuntimeConfig(runtime: string, model: string, envVars: Record<string, string> | null, customModelMode = false) {
  return buildRuntimeConfig({
    runtime,
    model,
    customModelMode,
    customModelName: customModelMode ? model : undefined,
    providerMode: "default",
    providerApiUrl: "",
    providerApiKey: "",
    fastMode: false,
    // REASONING_EFFORT_RUNTIMES excludes opencode, kimi and gemini: the dialogs send null.
    reasoningEffort: null,
    envVars,
    command: "",
  });
}

function submitted(runtime: string, values: Record<string, unknown>, options: Parameters<typeof buildRuntimeConfigFromFormValues>[2] = {}) {
  const built = buildRuntimeConfigFromFormValues(runtime, values, options);
  assert.ok(built.ok, JSON.stringify(built));
  return built.runtimeConfig;
}

/**
 * The server stores the parser's output for either request, and the legacy
 * builder returns the parser's output: compare those bytes, and the assembled
 * object itself key-order-insensitively.
 */
function assertSameAsLegacy(v2: Record<string, unknown>, legacy: RuntimeConfig, message: string) {
  assert.deepEqual(v2, legacy, message);
  const parsed = parseRuntimeConfig({ runtimeConfig: v2 });
  assert.ok(parsed.ok, message);
  assert.equal(JSON.stringify(parsed.config), JSON.stringify(legacy), message);
}

const MODEL_RUNTIMES = ["opencode", "kimi", "gemini"] as const;

test("each batch-2 form: fields, order, advanced envVars, no requiredClientCapabilities", () => {
  for (const runtime of MODEL_RUNTIMES) {
    const form = buildRuntimeFormV2(runtime);
    const parsed = parseRuntimeFormV2(wire(form));
    assert.ok(parsed, runtime);
    assert.equal(parsed.runtimeId, runtime);
    assert.deepEqual(parsed.fields.map((field) => [field.key, field.kind, field.required, field.advanced]), [
      ["model", "select", true, false],
      ["envVars", "string_map", false, true],
    ], runtime);
    assert.deepEqual(Object.keys(parsed.optionSources), ["model"], runtime);
    assert.deepEqual(parsed.requiredClientCapabilities, [], runtime);
    assert.equal("requiredClientCapabilities" in form, false, runtime);
    assert.deepEqual(runtimeFormV2Entry(runtime)!.validateProjection(), [], runtime);
  }
});

test("antigravity: a model select (typed ids allowed) and a reasoning effort that follows the model", () => {
  const form = buildRuntimeFormV2("antigravity");
  const antigravity = parseRuntimeFormV2(wire(form));
  assert.ok(antigravity);
  assert.deepEqual(antigravity.fields.map((field) => [field.key, field.kind, field.required, field.advanced]), [
    ["model", "select", true, false],
    ["reasoningEffort", "derived_select", false, false],
    ["envVars", "string_map", false, true],
  ]);
  assert.deepEqual(antigravity.fields.find((field) => field.key === "reasoningEffort")?.derivedFrom, {
    key: "model",
    attribute: "supportedReasoningEfforts",
    defaultAttribute: "defaultReasoningEffort",
  });
  assert.deepEqual(Object.keys(antigravity.optionSources), ["model"]);
  assert.deepEqual(antigravity.requiredClientCapabilities, ["select.custom_value"]);
  // Still labelled edit-only in the catalog; the OAR flag admits creation.
  assert.equal(form.schemaVersion, "antigravity.edit.v1");
  assert.deepEqual(runtimeFormV2Entry("antigravity")!.validateProjection(), []);
});

test("opencode, kimi, gemini: v2 values assemble exactly the legacy runtimeConfig", () => {
  const cases: Array<[string, string, Record<string, string> | null]> = [
    ["opencode", "deepseek/deepseek-v4-pro", { OPENCODE_FLAG: "1" }],
    ["opencode", "default", null],
    ["kimi", "default", { KIMI_X: "y" }],
    ["kimi", "kimi-k2-live", null],
    ["gemini", "gemini-2.5-pro", null],
    ["gemini", "default", { A: "b" }],
  ];
  for (const [runtime, model, envVars] of cases) {
    for (const editing of [false, true]) {
      const v2 = submitted(runtime, { model, envVars: envVars ?? {} }, { editing });
      assertSameAsLegacy(v2, legacyRuntimeConfig(runtime, model, envVars), `${runtime} ${model} editing=${editing}`);
    }
  }
  // The exact shape, spelled out once so a change in the legacy builder is visible here too.
  assert.deepEqual(submitted("opencode", { model: "default", envVars: { K: "v" } }), {
    version: RUNTIME_CONFIG_VERSION,
    runtime: "opencode",
    model: { kind: "preset", id: "default" },
    mode: { kind: "default" },
    reasoningEffort: null,
    envVars: { K: "v" },
  });
});

test("model runtimes: edit values round-trip back to the stored runtimeConfig", () => {
  for (const runtime of MODEL_RUNTIMES) {
    const stored = legacyRuntimeConfig(runtime, runtime === "gemini" ? "gemini-2.5-flash" : "default", { KEEP: "1" });
    const values = runtimeFormValuesFromRuntimeConfig(stored);
    assert.deepEqual(values, { model: stored.model.kind === "preset" ? stored.model.id : "", envVars: { KEEP: "1" } }, runtime);
    assertSameAsLegacy(submitted(runtime, values!, { editing: true, existing: stored }), stored, runtime);
  }
});

test("a blank model is a clear field error, not a crash", () => {
  for (const runtime of MODEL_RUNTIMES) {
    for (const model of ["", "  ", undefined, 7]) {
      assert.deepEqual(
        buildRuntimeConfigFromFormValues(runtime, { model }),
        { ok: false, issue: { code: "model_required", pointer: "/formValues/model" } },
        `${runtime} ${String(model)}`,
      );
    }
  }
});

test("antigravity: edit keeps the stored model and effort, a stored default stays agy's choice and a stored null effort stays Default", () => {
  const stored: RuntimeConfig[] = [
    legacyRuntimeConfig("antigravity", "default", { OLD: "1" }),
    legacyRuntimeConfig("antigravity", "some-agy-model", null, true),
    // What an offline save of a typed or live-listed model with an effort stores.
    { ...legacyRuntimeConfig("antigravity", "gemini-3.8-flash", null, true), reasoningEffort: "high" } as RuntimeConfig,
  ];
  assert.deepEqual(stored[1]!.model, { kind: "custom", name: "some-agy-model" });
  for (const config of stored) {
    const values = runtimeFormValuesFromRuntimeConfig(config);
    assert.deepEqual(values, {
      model: config.model.kind === "custom" ? config.model.name : config.model.id,
      reasoningEffort: config.reasoningEffort ?? "",
      envVars: config.envVars ?? {},
    });
    const next = submitted("antigravity", values!, { editing: true, existing: config });
    assert.deepEqual(next, config, JSON.stringify(config.model));
    assert.ok(parseRuntimeConfig({ runtimeConfig: next }).ok);
  }
  // A new agent left at the preselected entry keeps agy's own choice and thought level.
  assert.deepEqual(submitted("antigravity", { model: "default", reasoningEffort: "" }), {
    version: RUNTIME_CONFIG_VERSION,
    runtime: "antigravity",
    model: { kind: "preset", id: "default" },
    mode: { kind: "default" },
    reasoningEffort: null,
    envVars: null,
  });
  assert.deepEqual(
    buildRuntimeConfigFromFormValues("antigravity", { model: "" }),
    { ok: false, issue: { code: "model_required", pointer: "/formValues/model" } },
  );
});

const AGY_LIVE: RuntimeModelSourceOutcome = {
  kind: "live",
  value: {
    models: [
      { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium", verified: "launchable" },
      { id: "gemini-4-carbon-medium", label: "Gemini 4 Carbon (Medium)", verified: "launchable" },
    ],
    default: "gemini-3.8-flash",
  },
};

test("antigravity: the Computer's agy models follow the configured default, with efforts only where agy lists them", async () => {
  const entry = runtimeFormV2Entry("antigravity")!;
  const live = optionSourceContext(async () => AGY_LIVE);
  const resolution = await entry.resolveOptionSource({ ...live.context, sourceStatus: true } as RuntimeFormOptionSourceContext);
  assert.deepEqual(live.calls, ["antigravity"]);
  assert.equal(resolution.kind, "source");
  const source = (resolution as unknown as { source: Record<string, unknown> }).source;
  assert.equal(source.status, "live");
  assert.equal(source.customValueAllowed, true);
  // "default" stays first and preselected: a new agent lets agy choose unless the user picks.
  assert.equal(source.defaultValue, "default");
  assert.deepEqual(source.options, [
    { value: "default", label: RUNTIME_MODELS.antigravity![0]!.label, supportedReasoningEfforts: [] },
    { value: "gemini-3.8-flash", label: "Gemini 3.8 Flash", supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium" },
    // A model agy lists no levels for (or whose id names its level) offers no effort.
    { value: "gemini-4-carbon-medium", label: "Gemini 4 Carbon (Medium)", supportedReasoningEfforts: [] },
  ]);

  // Not live: the configured default alone, no effort.
  const offline = optionSourceContext(async () => { throw new Error("must not probe"); }, "not_routed");
  const fallback = await entry.resolveOptionSource({ ...offline.context, sourceStatus: true } as RuntimeFormOptionSourceContext);
  const fallbackSource = (fallback as unknown as { source: Record<string, unknown> }).source;
  assert.deepEqual(fallbackSource.options, [{ value: "default", label: RUNTIME_MODELS.antigravity![0]!.label, supportedReasoningEfforts: [] }]);
  assert.equal(fallbackSource.defaultValue, "default");
  assert.equal(fallbackSource.status, "fallback");
});

test("antigravity: a submit checks the effort against the live model", () => {
  const entry = runtimeFormV2Entry("antigravity")!;
  const models = (AGY_LIVE as { value: { models: RuntimeModelInfo[] } }).value.models;
  // A live model typed or picked becomes a preset with its effort.
  const picked = submitted("antigravity", { model: "gemini-3.8-flash", reasoningEffort: "high" }) as unknown as RuntimeConfig;
  assert.deepEqual(picked.model, { kind: "custom", name: "gemini-3.8-flash" });
  assert.deepEqual(entry.reconcileWithLiveModels!(picked, "high", models), {
    kind: "updated",
    runtimeConfig: { ...picked, model: { kind: "preset", id: "gemini-3.8-flash" }, reasoningEffort: "high" },
  });
  // An effort agy did not list for the model is refused at the field.
  const carbon = submitted("antigravity", { model: "gemini-4-carbon-medium", reasoningEffort: "high" }) as unknown as RuntimeConfig;
  assert.deepEqual(entry.reconcileWithLiveModels!(carbon, "high", models), {
    kind: "rejected",
    issue: { code: "reasoning_effort_not_supported", pointer: "/formValues/reasoningEffort" },
  });
  // The configured default is not in the live list: unchanged.
  assert.deepEqual(entry.reconcileWithLiveModels!(submitted("antigravity", { model: "default" }) as unknown as RuntimeConfig, null, models), { kind: "unchanged" });
});

// CodeBuddy lists the thought levels of its current model only (OAR's projection
// of its ACP `session/new`): the others carry none.
const CODEBUDDY_LIVE: RuntimeModelSourceOutcome = {
  kind: "live",
  value: {
    models: [
      { id: "cb-default", label: "CB Default", supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium", verified: "launchable" },
      { id: "cb-other", label: "CB Other", verified: "launchable" },
    ],
  },
};

test("codebuddy: the Computer's CodeBuddy models, a typed id allowed, efforts only where CodeBuddy lists them", async () => {
  const entry = runtimeFormV2Entry("codebuddy")!;
  assert.equal(buildRuntimeFormV2("codebuddy").schemaVersion, "codebuddy.create.v1");
  const live = optionSourceContext(async () => CODEBUDDY_LIVE);
  const resolution = await entry.resolveOptionSource({ ...live.context, sourceStatus: true } as RuntimeFormOptionSourceContext);
  assert.deepEqual(live.calls, ["codebuddy"]);
  const source = (resolution as unknown as { source: Record<string, unknown> }).source;
  assert.equal(source.status, "live");
  assert.equal(source.customValueAllowed, true);
  assert.deepEqual(source.options, [
    { value: "cb-default", label: "CB Default", supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium" },
    // No levels listed: no effort, never the base set (CodeBuddy could not apply it).
    { value: "cb-other", label: "CB Other", supportedReasoningEfforts: [] },
  ]);

  const models = (CODEBUDDY_LIVE as { value: { models: RuntimeModelInfo[] } }).value.models;
  const picked = submitted("codebuddy", { model: "cb-default", reasoningEffort: "high" }) as unknown as RuntimeConfig;
  assert.ok(parseRuntimeConfig({ runtimeConfig: picked }).ok, "the shared parser takes a CodeBuddy effort");
  assert.deepEqual(entry.reconcileWithLiveModels!(picked, "high", models), {
    kind: "updated",
    runtimeConfig: { ...picked, model: { kind: "preset", id: "cb-default" }, reasoningEffort: "high" },
  });
  const other = submitted("codebuddy", { model: "cb-other", reasoningEffort: "high" }) as unknown as RuntimeConfig;
  assert.deepEqual(entry.reconcileWithLiveModels!(other, "high", models), {
    kind: "rejected",
    issue: { code: "reasoning_effort_not_supported", pointer: "/formValues/reasoningEffort" },
  });
});

test("post-assembly issues point back at the field", () => {
  for (const runtime of [...MODEL_RUNTIMES, "antigravity"]) {
    assert.equal(formValuesPointerForRuntimeConfigPointer(runtime, "/runtimeConfig/model"), "/formValues/model");
    assert.equal(formValuesPointerForRuntimeConfigPointer(runtime, "/runtimeConfig/envVars"), "/formValues/envVars");
  }
  assert.equal(formValuesPointerForRuntimeConfigPointer("antigravity", "/runtimeConfig/reasoningEffort"), "/formValues/reasoningEffort");
});

function optionSourceContext(
  detect: () => Promise<RuntimeModelSourceOutcome>,
  routing: "confirmed_local" | "handled" | "not_routed" = "confirmed_local",
  sourceId = "model",
) {
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
    routeToComputer: async () => routing,
  } as unknown as RuntimeFormOptionSourceContext;
  return { context, calls };
}

const staticSelect = (runtime: string) => ({
  protocolVersion: 1,
  runtimeId: runtime,
  schemaVersion: buildRuntimeFormV2(runtime).schemaVersion,
  sourceId: "model",
  kind: "select",
  pointer: "/model",
  options: (RUNTIME_MODELS[runtime] ?? []).map((model) => ({ value: model.id, label: model.label })),
  defaultValue: RUNTIME_MODELS[runtime]?.[0]?.id ?? "",
});

test("opencode and kimi: a live probe is the select; every non-live outcome, offline machine or probe failure falls back to the static list", async () => {
  for (const runtime of ["opencode", "kimi"]) {
    const entry = runtimeFormV2Entry(runtime)!;
    const live = optionSourceContext(async () => ({
      kind: "live",
      value: { models: [{ id: "a/one", label: "One" }, { id: "b/two", label: "Two" }], default: "b/two" },
    }));
    assert.deepEqual(await entry.resolveOptionSource(live.context), {
      kind: "source",
      source: { ...staticSelect(runtime), options: [{ value: "a/one", label: "One" }, { value: "b/two", label: "Two" }], defaultValue: "b/two" },
    }, runtime);
    assert.deepEqual(live.calls, [runtime], "probes the runtime itself");

    const nonLive: Array<() => Promise<RuntimeModelSourceOutcome>> = [
      async () => ({ kind: "missing_config" }),
      async () => ({ kind: "no_models" }),
      async () => ({ kind: "unsupported" }),
      async () => ({ kind: "error", retryable: true, code: "detect_timeout" }),
      async () => ({ kind: "live", value: { models: [] } }),
      async () => { throw new RouteFailureError("daemon_timeout", "timed out"); },
      async () => { throw new Error("boom"); },
    ];
    for (const [index, detect] of nonLive.entries()) {
      const { context } = optionSourceContext(detect);
      assert.deepEqual(await entry.resolveOptionSource(context), { kind: "source", source: staticSelect(runtime) }, `${runtime} #${index}`);
    }
    const offline = optionSourceContext(async () => { throw new Error("must not probe"); }, "not_routed");
    assert.deepEqual(await entry.resolveOptionSource(offline.context), { kind: "source", source: staticSelect(runtime) });
    assert.deepEqual(offline.calls, []);
    const replayed = optionSourceContext(async () => { throw new Error("must not probe"); }, "handled");
    assert.deepEqual(await entry.resolveOptionSource(replayed.context), { kind: "handled" });
    const unknown = optionSourceContext(async () => { throw new Error("must not probe"); }, "confirmed_local", "provider");
    assert.deepEqual(await entry.resolveOptionSource(unknown.context), { kind: "source", source: null });
  }
});

test("gemini: the static list, without asking the Computer", async () => {
  const { context, calls } = optionSourceContext(async () => { throw new Error("must not probe"); });
  assert.deepEqual(await runtimeFormV2Entry("gemini")!.resolveOptionSource(context), { kind: "source", source: staticSelect("gemini") });
  assert.deepEqual(calls, []);
  assert.ok(staticSelect("gemini").options.length > 1);
});

test("an empty static fallback list is an empty select", () => {
  const empty = staticModelFallbackOptionSource("opencode", []);
  assert.deepEqual(empty, { ...staticSelect("opencode"), options: [], defaultValue: "" });
});

test("stored configs of runtimes without a v2 form are not editable", () => {
  // Every catalog runtime has a v2 form since batch 4, so the example is an unknown id.
  const stored = { runtime: "not-a-runtime", model: { kind: "preset", id: "default" } } as unknown as RuntimeConfig;
  assert.equal(runtimeFormValuesFromRuntimeConfig(stored), null);
});

test("antigravity: an edit keeps working once the saved model lists no levels; only the saved effort falls back to Default", async () => {
  // agy lists levels for its current model only: after it moves on, the saved model has none.
  const models: RuntimeModelInfo[] = [
    { id: "gemini-4-pro", label: "Gemini 4 Pro", supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "high" },
    { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
  ];
  const existing = { ...legacyRuntimeConfig("antigravity", "gemini-3.8-flash", null), reasoningEffort: "high" } as RuntimeConfig;
  const check = (values: Record<string, unknown>, stored: RuntimeConfig | null) => reconcileRuntimeFormV2SubmissionWithLiveModels({
    runtimeConfig: submitted("antigravity", values, { editing: true, existing: stored }) as unknown as RuntimeConfig,
    submittedReasoningEffort: values.reasoningEffort,
    existing: stored,
    machineId: "machine-1",
    detect: async () => ({ kind: "live", value: { models } }),
  });
  const kept = await check(runtimeFormValuesFromRuntimeConfig(existing)!, existing);
  assert.equal(kept.kind, "updated");
  assert.deepEqual((kept as { runtimeConfig: RuntimeConfig }).runtimeConfig.model, { kind: "preset", id: "gemini-3.8-flash" });
  assert.equal((kept as { runtimeConfig: RuntimeConfig }).runtimeConfig.reasoningEffort, null);
  // A level the user picks now is refused, as is the saved one on create (nothing saved).
  for (const [values, stored] of [
    [{ model: "gemini-3.8-flash", reasoningEffort: "low" }, existing],
    [{ model: "gemini-3.8-flash", reasoningEffort: "high" }, null],
  ] as const) {
    assert.deepEqual(await check(values, stored), {
      kind: "rejected",
      issue: { code: "reasoning_effort_not_supported", pointer: "/formValues/reasoningEffort" },
    }, JSON.stringify(values));
  }
  // A model that lists levels still refuses one it does not list, saved or not.
  const pro = { ...existing, model: { kind: "preset", id: "gemini-4-pro" }, reasoningEffort: "medium" } as RuntimeConfig;
  assert.equal((await check({ model: "gemini-4-pro", reasoningEffort: "medium" }, pro)).kind, "rejected");
});
