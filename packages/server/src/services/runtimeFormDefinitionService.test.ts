import assert from "node:assert/strict";
import { test } from "vitest";
import type { ResolvedAgentCreateFormDefinition } from "@botiverse/raft-shared";
import {
  buildBuiltInPiFormDefinition,
  buildBuiltInPiFormOptionSource,
  buildBuiltInPiResolvedFormDefinition,
  BUILTIN_PI_FORM_DEFINITION_REF,
  buildKimiSdkFormDefinition,
  buildKimiSdkFormOptionSource,
  KIMI_SDK_FORM_DEFINITION_REF,
  validateKimiSdkDefinitionProjection,
  validateKimiSdkSelection,
  validateBuiltInPiDefinitionProjection,
  validateRuntimeFormDefinitionRef,
} from "./runtimeFormDefinitionService.js";

const cloneDefinition = () => JSON.parse(JSON.stringify(buildBuiltInPiResolvedFormDefinition())) as ResolvedAgentCreateFormDefinition;

test("Built-in Pi form definition is a version-bound parser/registry projection", () => {
  const definition = buildBuiltInPiFormDefinition();
  assert.deepEqual(
    {
      protocolVersion: definition.protocolVersion,
      runtimeId: definition.runtimeId,
      schemaVersion: definition.schemaVersion,
    },
    BUILTIN_PI_FORM_DEFINITION_REF,
  );
  assert.deepEqual(validateBuiltInPiDefinitionProjection(), []);
  const apiKeySchema = definition.dataSchema.properties.apiKey;
  assert.equal(apiKeySchema.type, "string");
  assert.equal(apiKeySchema.type === "string" ? apiKeySchema.writeOnly : false, true);
  assert.equal("default" in definition.dataSchema.properties.apiKey, false);
  assert.equal(definition.schemaVersion, "builtin-pi.create.v2");
  assert.equal(definition.dataSchema.properties.supportsImageInput?.type, "boolean");
  assert.deepEqual(
    definition.uiSchema.visibility.find((rule) => rule.pointer === "/supportsImageInput"),
    {
      pointer: "/supportsImageInput",
      when: {
        pointer: "/providerId",
        in: ["openai-compatible", "anthropic-compatible"],
      },
    },
  );
  assert.deepEqual(definition.capabilities.forbiddenPointers, ["/hostUserState"]);
  assert.deepEqual(Object.keys(definition.optionSources.provider).sort(), [
    "kind", "pointer", "protocolVersion", "runtimeId", "schemaVersion", "sourceId",
  ]);
  assert.equal(buildBuiltInPiFormOptionSource("provider")?.kind, "select");
  assert.equal(buildBuiltInPiFormOptionSource("model")?.kind, "dependent_select");
  assert.equal(buildBuiltInPiFormOptionSource("unknown"), null);
});

test("Built-in Pi form lists Qwen Token Plan global and CN as first-class presets", () => {
  const providerSource = buildBuiltInPiFormOptionSource("provider");
  assert.equal(providerSource?.kind, "select");
  if (!providerSource || providerSource.kind !== "select") return;
  assert.deepEqual(
    providerSource.options.filter((option) => option.value.startsWith("qwen-token-plan")),
    [
      { value: "qwen-token-plan", label: "Qwen Token Plan", providerKind: "preset" },
      { value: "qwen-token-plan-cn", label: "Qwen Token Plan CN", providerKind: "preset" },
    ],
  );

  const modelSource = buildBuiltInPiFormOptionSource("model");
  assert.equal(modelSource?.kind, "dependent_select");
  if (!modelSource || modelSource.kind !== "dependent_select") return;
  assert.equal(modelSource.defaultValueByValue["qwen-token-plan"], "qwen-token-plan/qwen3.7-max");
  assert.equal(modelSource.defaultValueByValue["qwen-token-plan-cn"], "qwen-token-plan-cn/qwen3.7-max");
  assert.equal(modelSource.customValueAllowedByValue["qwen-token-plan"], false);
  assert.equal(modelSource.customValueAllowedByValue["qwen-token-plan-cn"], false);
  assert.ok(modelSource.optionsByValue["qwen-token-plan"]?.some(
    (option) => option.value === "qwen-token-plan/qwen3.8-max",
  ));
  assert.ok(modelSource.optionsByValue["qwen-token-plan-cn"]?.some(
    (option) => option.value === "qwen-token-plan-cn/qwen3.8-max",
  ));
});

test("projection mutation teeth fail on provider, kind, model, default, and mode-policy drift", () => {
  const providerDrift = cloneDefinition();
  const providerSource = providerDrift.optionSources.provider;
  assert.equal(providerSource.kind, "select");
  if (providerSource.kind === "select") providerSource.options.pop();
  assert.equal(validateBuiltInPiDefinitionProjection(providerDrift)[0]?.code, "definition_provider_registry_drift");

  const providerKindDrift = cloneDefinition();
  const providerKindSource = providerKindDrift.optionSources.provider;
  if (providerKindSource.kind === "select") {
    providerKindSource.options[0]!.providerKind = providerKindSource.options[0]!.providerKind === "preset"
      ? "gateway"
      : "preset";
  }
  assert.ok(validateBuiltInPiDefinitionProjection(providerKindDrift).some(
    (issue) => issue.code === "definition_provider_kind_registry_drift",
  ));

  const modelDrift = cloneDefinition();
  const modelSource = modelDrift.optionSources.model;
  assert.equal(modelSource.kind, "dependent_select");
  if (modelSource.kind === "dependent_select") {
    const presetId = Object.keys(modelSource.optionsByValue).find((providerId) => modelSource.optionsByValue[providerId].length > 0)!;
    modelSource.optionsByValue[presetId].push({ value: "mutated/model", label: "Mutated" });
  }
  assert.ok(validateBuiltInPiDefinitionProjection(modelDrift).some((issue) => issue.code === "definition_model_registry_drift"));

  const defaultModelDrift = cloneDefinition();
  const defaultModelSource = defaultModelDrift.optionSources.model;
  if (defaultModelSource.kind === "dependent_select") {
    const presetId = Object.keys(defaultModelSource.defaultValueByValue)[0]!;
    defaultModelSource.defaultValueByValue[presetId] = "mutated/default";
  }
  assert.ok(validateBuiltInPiDefinitionProjection(defaultModelDrift).some(
    (issue) => issue.code === "definition_default_model_registry_drift",
  ));

  const presetPolicyDrift = cloneDefinition();
  const presetPolicySource = presetPolicyDrift.optionSources.model;
  if (presetPolicySource.kind === "dependent_select") {
    const presetId = Object.keys(presetPolicySource.defaultValueByValue)[0]!;
    presetPolicySource.customValueAllowedByValue[presetId] = true;
  }
  assert.ok(validateBuiltInPiDefinitionProjection(presetPolicyDrift).some(
    (issue) => issue.code === "definition_preset_custom_model_drift",
  ));

  const gatewayModelDrift = cloneDefinition();
  const gatewayModelSource = gatewayModelDrift.optionSources.model;
  if (gatewayModelSource.kind === "dependent_select") {
    gatewayModelSource.optionsByValue["openai-compatible"] = [{ value: "mutated/model", label: "Mutated" }];
  }
  assert.ok(validateBuiltInPiDefinitionProjection(gatewayModelDrift).some(
    (issue) => issue.code === "definition_gateway_model_policy_drift",
  ));

  const gatewayDrift = cloneDefinition();
  const gatewaySource = gatewayDrift.optionSources.model;
  if (gatewaySource.kind === "dependent_select") gatewaySource.customValueAllowedByValue["openai-compatible"] = false;
  assert.ok(validateBuiltInPiDefinitionProjection(gatewayDrift).some((issue) => issue.code === "definition_gateway_custom_model_drift"));

  const topologyDrift = cloneDefinition();
  const topologySource = topologyDrift.optionSources.model;
  if (topologySource.kind === "dependent_select") topologySource.dependsOn = "/wrong";
  assert.ok(validateBuiltInPiDefinitionProjection(topologyDrift).some(
    (issue) => issue.code === "definition_option_source_topology_drift",
  ));

  const sourceRefDrift = buildBuiltInPiFormDefinition();
  sourceRefDrift.optionSources.provider.pointer = "/wrong";
  assert.ok(validateBuiltInPiDefinitionProjection(buildBuiltInPiResolvedFormDefinition(), sourceRefDrift).some(
    (issue) => issue.code === "definition_option_source_ref_drift",
  ));

  const sourceVersionDrift = cloneDefinition();
  (sourceVersionDrift.optionSources.provider as { schemaVersion: string }).schemaVersion = "stale";
  assert.ok(validateBuiltInPiDefinitionProjection(sourceVersionDrift).some(
    (issue) => issue.code === "definition_option_source_ref_drift",
  ));

  const imageInputDrift = cloneDefinition();
  (imageInputDrift.dataSchema.properties.supportsImageInput as { type: string }).type = "string";
  assert.ok(validateBuiltInPiDefinitionProjection(imageInputDrift).some(
    (issue) => issue.code === "definition_image_input_topology_drift",
  ));

  const imageVisibilityDrift = cloneDefinition();
  imageVisibilityDrift.uiSchema.visibility = imageVisibilityDrift.uiSchema.visibility.filter(
    (rule) => rule.pointer !== "/supportsImageInput",
  );
  assert.ok(validateBuiltInPiDefinitionProjection(imageVisibilityDrift).some(
    (issue) => issue.code === "definition_image_input_topology_drift",
  ));
});

test("form refs fail closed for unknown protocol, runtime, version, and fields", () => {
  assert.deepEqual(validateRuntimeFormDefinitionRef(BUILTIN_PI_FORM_DEFINITION_REF), []);
  assert.deepEqual(validateRuntimeFormDefinitionRef(KIMI_SDK_FORM_DEFINITION_REF), []);
  assert.equal(validateRuntimeFormDefinitionRef({ ...BUILTIN_PI_FORM_DEFINITION_REF, protocolVersion: 2 })[0]?.code, "unsupported_form_protocol");
  assert.equal(validateRuntimeFormDefinitionRef({ ...BUILTIN_PI_FORM_DEFINITION_REF, runtimeId: "claude" })[0]?.code, "unknown_form_runtime");
  assert.equal(validateRuntimeFormDefinitionRef({ ...BUILTIN_PI_FORM_DEFINITION_REF, schemaVersion: "old" })[0]?.code, "stale_form_schema");
  assert.equal(validateRuntimeFormDefinitionRef({ ...BUILTIN_PI_FORM_DEFINITION_REF, surprise: true })[0]?.code, "unknown_form_ref_field");
});

test("Kimi form registry and live option source preserve per-model effort authority", () => {
  const definition = buildKimiSdkFormDefinition();
  assert.deepEqual(
    {
      protocolVersion: definition.protocolVersion,
      runtimeId: definition.runtimeId,
      schemaVersion: definition.schemaVersion,
    },
    KIMI_SDK_FORM_DEFINITION_REF,
  );
  assert.deepEqual(validateKimiSdkDefinitionProjection(definition), []);

  const source = buildKimiSdkFormOptionSource({
    defaultModel: "kimi-code/k3",
    models: [
      {
        id: "kimi-code/k3",
        label: "K3",
        supportedReasoningEfforts: ["balanced-plus", "max", "balanced-plus", " bad"],
        defaultReasoningEffort: "balanced-plus",
      },
      { id: "kimi-code/k2", label: "K2" },
      {
        id: "kimi-code/k4",
        label: "K4",
        supportedReasoningEfforts: ["balanced-plus"],
        defaultReasoningEffort: "max",
      },
    ],
  });
  assert.equal(source.kind, "select");
  if (source.kind !== "select") return;
  assert.deepEqual(source.options, [
    {
      value: "kimi-code/k3",
      label: "K3",
      supportedReasoningEfforts: ["balanced-plus", "max"],
      defaultReasoningEffort: "balanced-plus",
    },
    { value: "kimi-code/k2", label: "K2" },
    {
      value: "kimi-code/k4",
      label: "K4",
      supportedReasoningEfforts: ["balanced-plus"],
    },
  ]);
  assert.deepEqual(validateKimiSdkSelection({ source, model: "kimi-code/k3", reasoningEffort: "balanced-plus" }), []);
  assert.equal(
    validateKimiSdkSelection({ source, model: "kimi-code/k2", reasoningEffort: "balanced-plus" })[0]?.pointer,
    "/runtimeConfig/reasoningEffort",
  );
  assert.deepEqual(validateKimiSdkSelection({ source, model: "kimi-code/k2", reasoningEffort: null }), []);
});
