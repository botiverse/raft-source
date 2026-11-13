import assert from "node:assert/strict";

import { parseRuntimeFormV2, RUNTIME_FORM_V3_UNSUPPORTED_RULE } from "./v2";
import {
  applyRuntimeFormV2Change,
  initialRuntimeFormV2Values,
  isRuntimeFormV2FieldRequired,
  isRuntimeFormV2FieldVisible,
  runtimeFormV2Choices,
  runtimeFormV2Submission,
  validateRuntimeFormV2,
  type RuntimeFormV2Sources,
} from "./v2State";

// A v3 form shaped like the server's Built-in and Codex output: a provider
// select with saved connections, owned fields hidden by rule, a model and a
// reasoning effort dependent_select keyed by model.
const v3Json = () => ({
  protocolVersion: 3,
  runtimeId: "example",
  schemaVersion: "example.create.v1",
  revision: "rev-3",
  dataSchema: {
    type: "object",
    required: ["providerId", "model"],
    properties: {
      providerId: { type: "string", title: "Provider", "x-optionSource": "provider" },
      apiKey: { type: "string", title: "API key", writeOnly: true },
      baseUrl: { type: "string", title: "Base URL", format: "uri" },
      contextWindow: { type: "string", title: "Context window" },
      model: { type: "string", title: "Model", "x-optionSource": "model" },
      reasoningEffort: { type: "string", title: "Reasoning", "x-optionSource": "reasoningEffort" },
    },
    allOf: [{ if: { properties: { providerId: { pattern: "^connection:" } } }, else: { required: ["apiKey"] } }],
  },
  uiSchema: {
    order: ["providerId", "apiKey", "baseUrl", "contextWindow", "model", "reasoningEffort"],
    rules: [
      { scope: "#/properties/apiKey", effect: "HIDE", condition: { scope: "#/properties/providerId", schema: { pattern: "^connection:" } } },
      { scope: "#/properties/baseUrl", effect: "SHOW", condition: { scope: "#/properties/providerId", schema: { enum: ["gateway"] } } },
      { scope: "#/properties/contextWindow", effect: "SHOW", condition: { scope: "#/properties/providerId", schema: { enum: ["gateway", "connection:gw"] } } },
    ],
  },
  optionSources: {
    provider: { sourceId: "provider", kind: "select", pointer: "/providerId" },
    model: { sourceId: "model", kind: "select", pointer: "/model" },
    reasoningEffort: { sourceId: "reasoningEffort", kind: "dependent_select", pointer: "/reasoningEffort", dependsOn: "/model" },
  },
});
const form = parseRuntimeFormV2(v3Json())!;
const field = (key: string) => form.fields.find((candidate) => candidate.key === key)!;

const sources = (overrides: Partial<RuntimeFormV2Sources> = {}): RuntimeFormV2Sources => ({
  provider: {
    sourceId: "provider", kind: "select", pointer: "/providerId",
    options: [
      { value: "connection:ok", label: "DeepSeek · Team", connectionId: "ok", underlyingProviderId: "deepseek", group: "saved" },
      { value: "connection:gw", label: "Gateway · Team", connectionId: "gw", underlyingProviderId: "gateway", group: "saved" },
      { value: "deepseek", label: "DeepSeek", group: "direct" },
      { value: "gateway", label: "Gateway", group: "direct" },
    ],
    defaultValue: "deepseek",
    unavailableOptions: [{ value: "connection:off", label: "DeepSeek · Old", reason: "This saved provider is disabled.", connectionId: "off", group: "saved" }],
  },
  model: {
    sourceId: "model", kind: "select", pointer: "/model",
    options: [{ value: "m-effort", label: "With effort" }, { value: "m-plain", label: "No effort" }],
    defaultValue: "m-effort",
    customValueAllowed: true,
    unavailableOptions: [{ value: "m-disabled", label: "Disabled model" }],
  },
  reasoningEffort: {
    sourceId: "reasoningEffort", kind: "dependent_select", pointer: "/reasoningEffort", dependsOn: "/model",
    optionsByValue: { "m-effort": [{ value: "", label: "Default" }, { value: "low", label: "low" }, { value: "high", label: "high" }] },
    defaultValueByValue: { "m-effort": "high" },
  },
  ...overrides,
} as RuntimeFormV2Sources);

test("v3 parse: protocolVersion 3, rules and conditional required on the fields, no capabilities", () => {
  assert.equal(form.protocolVersion, 3);
  assert.equal(form.revision, "rev-3");
  assert.deepEqual(form.requiredClientCapabilities, []);
  assert.deepEqual(field("apiKey").rule, { effect: "HIDE", condition: { key: "providerId", schema: { pattern: "^connection:" } } });
  assert.deepEqual(field("apiKey").requiredWhen, [{ condition: { properties: { providerId: { pattern: "^connection:" } } }, when: false }]);
  assert.equal(field("apiKey").required, false);
  assert.equal(field("reasoningEffort").kind, "dependent_select");
  assert.equal(field("reasoningEffort").dependsOn, "model");
});

test("v3 parse: an unknown effect, scope or keyword makes the whole form unavailable", () => {
  const mutations: Array<(json: ReturnType<typeof v3Json>) => void> = [
    (json) => { (json.uiSchema.rules[0] as Record<string, unknown>).effect = "DISABLE"; },
    (json) => { json.uiSchema.rules[0]!.condition.schema = { minLength: 1 } as never; },
    (json) => { json.uiSchema.rules[0]!.scope = "#/properties/a/b"; },
    (json) => { json.uiSchema.rules.push(json.uiSchema.rules[0]!); },
    (json) => { json.dataSchema.allOf[0]!.if = { type: "string" } as never; },
  ];
  for (const mutate of mutations) {
    const json = v3Json();
    mutate(json);
    assert.deepEqual(parseRuntimeFormV2(json)!.requiredClientCapabilities, [RUNTIME_FORM_V3_UNSUPPORTED_RULE]);
  }
  // A v2 body never reads rules: they are ignored there, as any unknown key.
  const v2 = { ...v3Json(), protocolVersion: 2 };
  v2.uiSchema.rules[0]!.condition.schema = { minLength: 1 } as never;
  assert.deepEqual(parseRuntimeFormV2(v2)!.requiredClientCapabilities, []);
  assert.equal(parseRuntimeFormV2({ ...v3Json(), protocolVersion: 4 }), null);
});

test("v3 effort: the server's Default option comes first, the model's default is preselected, a model change re-defaults", () => {
  const src = sources();
  const values = initialRuntimeFormV2Values(form, src);
  assert.equal(values.reasoningEffort, "high");
  const choices = runtimeFormV2Choices(field("reasoningEffort"), src, values);
  assert.deepEqual(choices?.kind === "select" && choices.options.map((option) => [option.value, option.label]), [["", "Default"], ["low", "low"], ["high", "high"]]);
  const defaulted = { ...values, reasoningEffort: "" };
  assert.deepEqual(validateRuntimeFormV2(form, src, { ...defaulted, apiKey: "sk" }), {});
  assert.equal(runtimeFormV2Submission(form, { ...defaulted, apiKey: "sk" }, src).reasoningEffort, "");
});

test("v3 effort on edit: a stored null or absent effort stays Default; create and a model change take the model's default", () => {
  const src = sources({
    reasoningEffort: {
      sourceId: "reasoningEffort", kind: "dependent_select", pointer: "/reasoningEffort", dependsOn: "/model",
      optionsByValue: {
        "m-effort": [{ value: "", label: "Default" }, { value: "low", label: "low" }, { value: "high", label: "high" }],
        "m-other": [{ value: "", label: "Default" }, { value: "low", label: "low" }, { value: "high", label: "high" }],
      },
      defaultValueByValue: { "m-effort": "high", "m-other": "low" },
    },
  });
  assert.equal(initialRuntimeFormV2Values(form, src).reasoningEffort, "high", "create starts at the model's default");
  for (const stored of [{ reasoningEffort: null }, {}]) {
    const edit = parseRuntimeFormV2({ ...v3Json(), values: { providerId: "deepseek", model: "m-effort", ...stored } })!;
    const values = initialRuntimeFormV2Values(edit, src);
    assert.equal(values.reasoningEffort, "", "the server's Default, not defaultValueByValue");
    assert.equal(isRuntimeFormV2FieldVisible(field("reasoningEffort"), values, src), true);
    assert.deepEqual(validateRuntimeFormV2(edit, src, values, { editing: true }), {});
    assert.equal(runtimeFormV2Submission(edit, values, src).reasoningEffort, "", "saved untouched: still Default");
    assert.equal(applyRuntimeFormV2Change(edit, src, values, "model", "m-other").reasoningEffort, "low", "a model change takes the new model's default");
  }
  const explicit = parseRuntimeFormV2({ ...v3Json(), values: { providerId: "deepseek", model: "m-effort", reasoningEffort: "low" } })!;
  assert.equal(initialRuntimeFormV2Values(explicit, src).reasoningEffort, "low", "a stored effort is kept");
  // A branch the saved agent is not on (no stored model, e.g. Pi's "configured" model while it uses a provider):
  // the effort there does not apply, so it starts as on create, not at Default.
  const offBranch = parseRuntimeFormV2({ ...v3Json(), values: { providerId: "deepseek" } })!;
  assert.equal(initialRuntimeFormV2Values(offBranch, src).reasoningEffort, initialRuntimeFormV2Values(form, src).reasoningEffort);
});

test("v3 effort: a model with no key hides the optional field and keeps its value (edit submits the stored one)", () => {
  const src = sources();
  const edit = parseRuntimeFormV2({ ...v3Json(), values: { providerId: "deepseek", model: "my/typed", reasoningEffort: "high" } })!;
  const values = initialRuntimeFormV2Values(edit, src);
  assert.equal(values.reasoningEffort, "high", "the stored value is kept");
  const effort = edit.fields.find((candidate) => candidate.key === "reasoningEffort")!;
  assert.equal(isRuntimeFormV2FieldVisible(effort, values, src), false);
  assert.deepEqual(validateRuntimeFormV2(edit, src, values, { editing: true }), {});
  assert.equal(runtimeFormV2Submission(edit, values, src).reasoningEffort, "high");
  // On create there is no stored value: the field is left out.
  const created = applyRuntimeFormV2Change(form, src, { ...initialRuntimeFormV2Values(form, src), apiKey: "sk" }, "model", "m-plain");
  assert.equal(isRuntimeFormV2FieldVisible(field("reasoningEffort"), created, src), false);
  assert.equal("reasoningEffort" in runtimeFormV2Submission(form, created, src), false);
  assert.deepEqual(validateRuntimeFormV2(form, src, created), {});
});

test("v3 connection: a connection hides the owned fields, lifts their required rule, and they are not submitted", () => {
  const src = sources();
  const direct = { ...initialRuntimeFormV2Values(form, src), apiKey: "" };
  assert.equal(isRuntimeFormV2FieldRequired(field("apiKey"), direct), true);
  assert.deepEqual(validateRuntimeFormV2(form, src, direct), { apiKey: "required" });
  const viaConnection = applyRuntimeFormV2Change(form, src, { ...direct, apiKey: "sk-direct" }, "providerId", "connection:ok");
  assert.equal(isRuntimeFormV2FieldVisible(field("apiKey"), viaConnection, src), false);
  assert.equal(isRuntimeFormV2FieldRequired(field("apiKey"), viaConnection), false);
  assert.deepEqual(validateRuntimeFormV2(form, src, viaConnection), {});
  const body = runtimeFormV2Submission(form, viaConnection, src);
  assert.equal("apiKey" in body, false);
  assert.equal("baseUrl" in body, false);
  assert.equal(body.providerId, "connection:ok");
});

test("v3 connection: a gateway connection listed in the SHOW condition keeps the limit fields; others hide them", () => {
  const src = sources();
  const base = initialRuntimeFormV2Values(form, src);
  assert.equal(isRuntimeFormV2FieldVisible(field("contextWindow"), { ...base, providerId: "connection:gw" }, src), true);
  assert.equal(isRuntimeFormV2FieldVisible(field("baseUrl"), { ...base, providerId: "connection:gw" }, src), false, "owned: no alias in v3");
  assert.equal(isRuntimeFormV2FieldVisible(field("contextWindow"), { ...base, providerId: "connection:ok" }, src), false);
  assert.equal(isRuntimeFormV2FieldVisible(field("contextWindow"), { ...base, providerId: "gateway" }, src), true);
});

test("v3 unavailable: a value equal to an unavailableOptions entry blocks (option_unavailable), except on a typed-values source", () => {
  const src = sources();
  const edit = parseRuntimeFormV2({ ...v3Json(), values: { providerId: "connection:off", model: "m-disabled" } })!;
  const values = initialRuntimeFormV2Values(edit, src);
  assert.equal(values.providerId, "connection:off", "the binding is kept, never rewritten");
  assert.deepEqual(validateRuntimeFormV2(edit, src, values, { editing: true }), { providerId: "option_unavailable" });
  // The model source takes typed values: a stored disabled model is accepted as typed.
  const direct = { ...values, providerId: "deepseek", apiKey: "sk" };
  assert.deepEqual(validateRuntimeFormV2(edit, src, direct, { editing: true }), {});
  // Without customValueAllowed the same model blocks.
  const strict = sources({ model: { ...sources().model!, customValueAllowed: false } });
  assert.deepEqual(validateRuntimeFormV2(edit, strict, direct, { editing: true }), { model: "option_unavailable" });
});
