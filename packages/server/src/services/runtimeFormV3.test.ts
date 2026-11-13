/**
 * Runtime form v3 at the edge (runtimeFormV3.ts): each item of the v3 plan on
 * the server's own forms and sources. The wire bodies themselves are locked
 * by runtimeFormV3Fixtures.test.ts.
 */
import assert from "node:assert/strict";
import {
  initialRuntimeFormV2Values,
  isRuntimeFormV2FieldVisible,
  parseRuntimeFormV2,
  runtimeFormV2Submission,
  validateRuntimeFormV2,
  type RuntimeFormV2Sources,
} from "@botiverse/raft-runtime-form";

import {
  buildRuntimeConfigFromFormValues,
  buildRuntimeFormV2,
  clientRendersDependentCustomWithOptions,
  runtimeFormV2Entry,
  validateRuntimeFormV2SubmitRef,
  withSavedConnectionForm,
  type RuntimeFormOptionSourceContext,
  type RuntimeFormV2OptionSourceBody,
} from "./runtimeFormV2Registry";
import {
  isRuntimeFormV3Request,
  resolveRuntimeFormV3OptionSource,
  runtimeFormV3Revision,
  toRuntimeFormV3,
  toRuntimeFormV3OptionSource,
  type RuntimeFormV3Connection,
} from "./runtimeFormV3";

const V3 = ["runtime_form.v3"];
const GATEWAY_CONNECTION: RuntimeFormV3Connection = { value: "connection:gw", underlyingProviderId: "openai-compatible" };
const PRESET_CONNECTION: RuntimeFormV3Connection = { value: "connection:ds", underlyingProviderId: "deepseek" };
const builtinEntry = runtimeFormV2Entry("builtin")!;
const savedBuiltin = () => withSavedConnectionForm(builtinEntry, buildRuntimeFormV2("builtin"), V3);
const asV3 = (runtimeId: string, form = buildRuntimeFormV2(runtimeId), connections: RuntimeFormV3Connection[] = []) =>
  toRuntimeFormV3(form, { connections, revision: runtimeFormV3Revision(runtimeId, form, V3, connections) });
type Rules = Array<{ scope: string; effect: string; condition: { scope: string; schema: Record<string, unknown> } }>;
const rulesOf = (form: { uiSchema?: { rules?: unknown } }) => (form.uiSchema?.rules ?? []) as Rules;

function sourceContext(sourceId: string, outcome: unknown): RuntimeFormOptionSourceContext {
  return {
    sourceId,
    machineId: "machine-1",
    machine: {},
    sourceStatus: true,
    clientCapabilities: V3,
    agentOrchestrator: { detectMachineRuntimeModels: async () => outcome },
    routeToComputer: async () => "confirmed_local",
  } as unknown as RuntimeFormOptionSourceContext;
}

test("the capability switch: only runtime_form.v3 asks for v3, and it implies dependent_select.custom_value_with_options", () => {
  assert.equal(isRuntimeFormV3Request(V3), true);
  assert.equal(isRuntimeFormV3Request(["dependent_select.custom_value_with_options"]), false);
  assert.equal(isRuntimeFormV3Request(undefined), false);
  assert.equal(clientRendersDependentCustomWithOptions(V3), true);
});

test("item 5: visibility becomes one SHOW rule per field; v3 has no visibility and no required capabilities", () => {
  const v2 = buildRuntimeFormV2("claude");
  const v3 = asV3("claude", v2);
  assert.equal(v3.protocolVersion, 3);
  assert.equal("requiredClientCapabilities" in v3, false);
  assert.equal(v3.uiSchema?.visibility, undefined);
  assert.deepEqual(rulesOf(v3), (v2.uiSchema?.visibility ?? []).map((rule) => ({
    scope: `#/properties/${rule.pointer.slice(1)}`,
    effect: "SHOW",
    condition: { scope: `#/properties/${rule.when.pointer.slice(1)}`, schema: { enum: rule.when.in } },
  })));
  assert.ok(rulesOf(v3).length > 0);
  assert.equal(buildRuntimeFormV2("claude").protocolVersion, 2, "the registry's own form is untouched");
});

test("item 2: owned fields hide by rule on a connection, apiKey is required only without one, and no x-connectionOwned is sent", () => {
  const v3 = asV3("builtin", savedBuiltin(), [GATEWAY_CONNECTION, PRESET_CONNECTION]);
  const properties = v3.dataSchema.properties;
  for (const key of builtinEntry.savedConnection!.connectionOwnedFields) assert.equal("x-connectionOwned" in properties[key]!, false, key);
  const byScope = new Map(rulesOf(v3).map((rule) => [rule.scope, rule]));
  assert.deepEqual(byScope.get("#/properties/apiKey"), {
    scope: "#/properties/apiKey", effect: "HIDE", condition: { scope: "#/properties/providerId", schema: { pattern: "^connection:" } },
  });
  assert.equal((v3.dataSchema.required ?? []).includes("apiKey"), false);
  assert.deepEqual(v3.dataSchema.allOf, [{ if: { properties: { providerId: { pattern: "^connection:" } } }, else: { required: ["apiKey"] } }]);
  // A gateway URL is owned: no connection value is listed for it.
  assert.equal(JSON.stringify(byScope.get("#/properties/baseUrl")).includes("connection:"), false);
  // The limit fields are not owned: the gateway connection is listed, the preset one is not.
  for (const key of ["contextWindow", "maxOutputTokens"]) {
    const values = byScope.get(`#/properties/${key}`)!.condition.schema.enum as string[];
    assert.ok(values.includes("connection:gw"), key);
    assert.equal(values.includes("connection:ds"), false, key);
  }

  // The shared client state follows: a connection hides and drops the owned fields.
  const parsed = parseRuntimeFormV2(JSON.parse(JSON.stringify(v3)))!;
  const sources: RuntimeFormV2Sources = {
    provider: { sourceId: "provider", kind: "select", pointer: "/providerId", options: [{ value: "connection:gw", label: "GW" }, { value: "openai-compatible", label: "Gateway" }], defaultValue: "openai-compatible" },
    model: { sourceId: "model", kind: "dependent_select", pointer: "/model", dependsOn: "/providerId", optionsByValue: { "connection:gw": [], "openai-compatible": [] }, defaultValueByValue: {}, customValueAllowedByValue: { "connection:gw": true, "openai-compatible": true } },
  };
  const values = { ...initialRuntimeFormV2Values(parsed, sources), providerId: "connection:gw", model: "m", apiKey: "", baseUrl: "" };
  assert.deepEqual(validateRuntimeFormV2(parsed, sources, values), {});
  const body = runtimeFormV2Submission(parsed, values, sources);
  for (const key of builtinEntry.savedConnection!.connectionOwnedFields) assert.equal(key in body, false, key);
  const limit = parsed.fields.find((field) => field.key === "contextWindow")!;
  assert.equal(isRuntimeFormV2FieldVisible(limit, values, sources), true, "a gateway connection keeps the limit fields");
});

test("item 2: the submit refuses every owned field on a connection, from savedConnection.connectionOwnedFields", () => {
  for (const owned of builtinEntry.savedConnection!.connectionOwnedFields) {
    const built = buildRuntimeConfigFromFormValues("builtin", { providerId: "connection:conn-1", model: "deepseek/deepseek-v4-pro", [owned]: "" }, {});
    assert.equal(built.ok, false, owned);
    assert.deepEqual(!built.ok && built.issue, { code: "connection_field_forbidden", pointer: `/formValues/${owned}` });
  }
});

test("revision: every v3 form has one; it changes with the connection set and the advertised capabilities", () => {
  const plain = asV3("codex");
  assert.ok(plain.revision);
  const form = savedBuiltin();
  const none = runtimeFormV3Revision("builtin", form, V3, []);
  assert.notEqual(runtimeFormV3Revision("builtin", form, V3, [GATEWAY_CONNECTION]), none);
  assert.equal(runtimeFormV3Revision("builtin", form, V3, [PRESET_CONNECTION, GATEWAY_CONNECTION]), runtimeFormV3Revision("builtin", form, V3, [GATEWAY_CONNECTION, PRESET_CONNECTION]));
  assert.notEqual(runtimeFormV3Revision("builtin", form, [...V3, "dependent_select.custom_value_with_options"], []), none);
  assert.notEqual(none, form.revision, "never the v2 token");
});

test("item 1: reasoning effort becomes a dependent_select on the model (Codex, Grok, Claude, Copilot, Kimi Code, Pi)", () => {
  for (const [runtime, fields] of [
    ["codex", { reasoningEffort: "model" }],
    ["grok", { reasoningEffort: "model" }],
    ["claude", { reasoningEffort: "model" }],
    ["copilot", { reasoningEffort: "model" }],
    ["kimi-sdk", { reasoningEffort: "model" }],
    ["pi", { reasoningEffort: "model", providerReasoningEffort: "providerModel" }],
  ] as const) {
    const v3 = asV3(runtime);
    for (const [key, parent] of Object.entries(fields)) {
      const property = v3.dataSchema.properties[key]!;
      assert.equal("x-optionsFrom" in property, false, `${runtime}/${key}`);
      assert.equal(property["x-optionSource"], key, `${runtime}/${key}`);
      assert.deepEqual(
        { ...v3.optionSources![key], protocolVersion: undefined, runtimeId: undefined, schemaVersion: undefined },
        { sourceId: key, kind: "dependent_select", pointer: `/${key}`, dependsOn: `/${parent}`, protocolVersion: undefined, runtimeId: undefined, schemaVersion: undefined },
        `${runtime}/${key}`,
      );
    }
  }
});

test("item 1: the effort source has Default first, the model's default, no key for a model without efforts, and the model's status", async () => {
  const live = {
    kind: "live",
    value: {
      models: [
        { id: "plain", label: "Plain" },
        { id: "picky", label: "Picky", supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "high" },
      ],
      default: "plain",
    },
  };
  const form = buildRuntimeFormV2("codex");
  const resolved = await resolveRuntimeFormV3OptionSource(form, sourceContext("reasoningEffort", live));
  const source = (resolved as { source: RuntimeFormV2OptionSourceBody & { optionsByValue: Record<string, Array<{ value: string; label: string }>>; defaultValueByValue: Record<string, string> } }).source;
  assert.equal(source.status, "live");
  assert.deepEqual(source.optionsByValue.picky, [{ value: "", label: "Default" }, { value: "low", label: "Low" }, { value: "high", label: "High" }]);
  assert.equal(source.defaultValueByValue.picky, "high");
  assert.equal(source.optionsByValue.plain![0]!.value, "", "a model declaring none offers the base set after Default");
  assert.equal(source.defaultValueByValue.plain, "");
  assert.equal(Object.hasOwn(source.optionsByValue, "my-org/typed"), false, "a typed model has no key");

  // The model source is unavailable: so is the effort source.
  const down = await resolveRuntimeFormV3OptionSource(buildRuntimeFormV2("grok"), sourceContext("reasoningEffort", { kind: "no_models" }));
  const downSource = (down as { source: RuntimeFormV2OptionSourceBody }).source;
  const model = await runtimeFormV2Entry("grok")!.resolveOptionSource(sourceContext("model", { kind: "no_models" }));
  assert.equal(downSource.status, (model as { source: RuntimeFormV2OptionSourceBody }).source!.status);

  // A runtime source the form does not derive stays the entry's own (and 404s stay 404s).
  assert.deepEqual(await resolveRuntimeFormV3OptionSource(form, sourceContext("nope", live)), { kind: "source", source: null });

  // Submitting the Default ("") stores no effort, as before.
  const built = buildRuntimeConfigFromFormValues("codex", { model: "picky", reasoningEffort: "" }, {});
  assert.equal(built.ok && built.runtimeConfig.reasoningEffort, null);
});

test("item 3: a v3 source moves unavailable options to unavailableOptions with plain-text reasons and connection metadata", () => {
  const source = {
    protocolVersion: 1, runtimeId: "builtin", schemaVersion: "builtin-pi.create.v3",
    sourceId: "provider", kind: "select", pointer: "/providerId", defaultValue: "deepseek",
    options: [
      { value: "connection:off", label: "DeepSeek · Old", providerKind: "preset", connectionId: "off", underlyingProviderId: "deepseek", group: "saved", unavailable: true, unavailableReason: "disabled" },
      { value: "connection:nokey", label: "DeepSeek · No key", providerKind: "preset", connectionId: "nokey", underlyingProviderId: "deepseek", group: "saved", unavailable: true, unavailableReason: "missing_credential" },
      { value: "deepseek", label: "DeepSeek", group: "direct" },
    ],
  } as unknown as RuntimeFormV2OptionSourceBody;
  const v3 = toRuntimeFormV3OptionSource(source) as RuntimeFormV2OptionSourceBody & { options: Array<{ value: string }> };
  assert.deepEqual(v3.options.map((option) => option.value), ["deepseek"]);
  assert.deepEqual(v3.unavailableOptions, [
    { value: "connection:off", label: "DeepSeek · Old", reason: "This saved provider is disabled.", connectionId: "off", underlyingProviderId: "deepseek", group: "saved", providerKind: "preset" },
    { value: "connection:nokey", label: "DeepSeek · No key", reason: "This saved provider has no credential.", connectionId: "nokey", underlyingProviderId: "deepseek", group: "saved", providerKind: "preset" },
  ]);
  const plain = { ...source, options: [{ value: "deepseek", label: "DeepSeek" }] } as unknown as RuntimeFormV2OptionSourceBody;
  assert.equal(toRuntimeFormV3OptionSource(plain), plain, "nothing unavailable: unchanged");
});

test("submit accepts formDefinitionRef protocolVersion 2 or 3 and nothing else", () => {
  assert.deepEqual(validateRuntimeFormV2SubmitRef({ protocolVersion: 2, runtimeId: "codex" }), []);
  assert.deepEqual(validateRuntimeFormV2SubmitRef({ protocolVersion: 3, runtimeId: "codex" }), []);
  assert.deepEqual(validateRuntimeFormV2SubmitRef({ protocolVersion: 4, runtimeId: "codex" }), [{ code: "unsupported_form_protocol", pointer: "/formDefinitionRef/protocolVersion" }]);
});
