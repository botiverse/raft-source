/**
 * Runtime form v3 at the edge (runtimeFormV3.ts): each item of the v3 plan on
 * the server's own forms and sources. The wire bodies themselves are locked
 * by runtimeFormV3Fixtures.test.ts.
 */
import assert from "node:assert/strict";
import {
  buildRuntimeConfigFromFormValues,
  buildRuntimeFormV2,
  clientRendersDependentCustomWithOptions,
  runtimeFormV2Entry,
  validateRuntimeFormV2SubmitRef,
  type RuntimeFormOptionSourceContext,
  type RuntimeFormV2OptionSourceBody,
} from "./runtimeFormV2Registry";
import {
  isRuntimeFormV3Request,
  resolveRuntimeFormV3OptionSource,
  runtimeFormV3Revision,
  toRuntimeFormV3,
} from "./runtimeFormV3";

const V3 = ["runtime_form.v3"];
const asV3 = (runtimeId: string, form = buildRuntimeFormV2(runtimeId)) =>
  toRuntimeFormV3(form, { revision: runtimeFormV3Revision(runtimeId, form, V3) });
type Rules = Array<{ scope: string; effect: string; condition: { scope: string; schema: Record<string, unknown> } }>;
const rulesOf = (form: { uiSchema?: { rules?: unknown } }) => (form.uiSchema?.rules ?? []) as Rules;

function sourceContext(sourceId: string, outcome: unknown): RuntimeFormOptionSourceContext {
  return {
    sourceId,
    machineId: "machine-1",
    machine: {},
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

test("saved provider connections are removed: no owned-field rules, and a connection value is not a provider", () => {
  const v3 = asV3("builtin");
  assert.equal(v3.dataSchema.allOf, undefined);
  assert.equal(JSON.stringify(v3).includes("connection:"), false);
  assert.ok((v3.dataSchema.required ?? []).includes("apiKey"), "the API key is required as on any direct provider");
  const built = buildRuntimeConfigFromFormValues("builtin", { providerId: "connection:conn-1", model: "deepseek/deepseek-v4-pro" }, {});
  assert.equal(built.ok, false);
  assert.deepEqual(!built.ok && built.issue, { code: "select_valid_provider", pointer: "/formValues/providerId" });
});

test("revision: every v3 form has one; it changes with the advertised capabilities", () => {
  const plain = asV3("codex");
  assert.ok(plain.revision);
  const form = buildRuntimeFormV2("builtin");
  const none = runtimeFormV3Revision("builtin", form, V3);
  assert.equal(runtimeFormV3Revision("builtin", form, V3), none);
  assert.notEqual(runtimeFormV3Revision("builtin", form, [...V3, "dependent_select.custom_value_with_options"]), none);
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

test("submit accepts formDefinitionRef protocolVersion 2 or 3 and nothing else", () => {
  assert.deepEqual(validateRuntimeFormV2SubmitRef({ protocolVersion: 2, runtimeId: "codex" }), []);
  assert.deepEqual(validateRuntimeFormV2SubmitRef({ protocolVersion: 3, runtimeId: "codex" }), []);
  assert.deepEqual(validateRuntimeFormV2SubmitRef({ protocolVersion: 4, runtimeId: "codex" }), [{ code: "unsupported_form_protocol", pointer: "/formDefinitionRef/protocolVersion" }]);
});
