import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentCreateFormDefinition,
  AgentCreateFormOptionSource,
  ResolvedAgentCreateFormDefinition,
  RuntimeFormDefinitionRef,
} from "@botiverse/raft-shared";
import { KIMI_SDK_FORM_DEFINITION_REF } from "@botiverse/raft-shared";
import {
  parseAgentCreateFormDefinition,
  parseAgentCreateFormOptionSource,
  resolveAgentCreateFormDefinition,
} from "../src/hooks/useRuntimeFormDefinition.js";
import { buildRuntimeConfig, builtInProviderDefaultModel } from "../src/utils/runtimeConfigForm.js";
import { buildSchemaDrivenBuiltInConfig, buildSchemaDrivenKimiConfig } from "../src/utils/schemaRuntimeConfigForm.js";

const ref: RuntimeFormDefinitionRef = {
  protocolVersion: 1,
  runtimeId: "builtin",
  schemaVersion: "builtin-pi.create.v2",
};

function definitionFixture(): AgentCreateFormDefinition {
  return {
    ...ref,
    dataSchema: {
      type: "object",
      additionalProperties: false,
      required: ["providerId", "apiKey", "model"],
      properties: {
        providerId: { type: "string", title: "Provider", minLength: 1 },
        apiKey: { type: "string", title: "API Key", minLength: 1, writeOnly: true },
        baseUrl: { type: "string", title: "Base URL", minLength: 1, format: "uri" },
        supportsImageInput: { type: "boolean", title: "Image input" },
        model: { type: "string", title: "Model", minLength: 1 },
        envVars: { type: "object", title: "Environment Variables", additionalProperties: { type: "string" } },
      },
    },
    uiSchema: {
      order: ["providerId", "apiKey", "baseUrl", "supportsImageInput", "model", "envVars"],
      layout: { advanced: ["/envVars"] },
      visibility: [
        { pointer: "/baseUrl", when: { pointer: "/providerId", in: ["openai-compatible"] } },
        { pointer: "/supportsImageInput", when: { pointer: "/providerId", in: ["openai-compatible"] } },
      ],
      localization: {
        providerId: { label: "Provider" },
        apiKey: { label: "API Key" },
        baseUrl: { label: "Base URL" },
        supportsImageInput: { label: "Supports image input" },
        model: { label: "Model" },
        envVars: { label: "Environment Variables" },
      },
    },
    capabilities: {
      providerKinds: ["preset", "gateway"],
      writeOnlyPointers: ["/apiKey"],
      forbiddenPointers: ["/hostUserState"],
    },
    optionSources: {
      provider: {
        ...ref,
        sourceId: "provider",
        kind: "select",
        pointer: "/providerId",
      },
      model: {
        ...ref,
        sourceId: "model",
        kind: "dependent_select",
        pointer: "/model",
        dependsOn: "/providerId",
      },
    },
  };
}

function sourceFixtures(): Record<string, AgentCreateFormOptionSource> {
  const defaultModel = builtInProviderDefaultModel("deepseek")!;
  return {
    provider: {
      ...ref,
      sourceId: "provider",
      kind: "select",
      pointer: "/providerId",
      options: [
        { value: "deepseek", label: "DeepSeek", providerKind: "preset" },
        { value: "openai-compatible", label: "OpenAI-compatible", providerKind: "gateway" },
      ],
      defaultValue: "deepseek",
    },
    model: {
      ...ref,
      sourceId: "model",
      kind: "dependent_select",
      pointer: "/model",
      dependsOn: "/providerId",
      optionsByValue: {
        deepseek: [{ value: defaultModel, label: defaultModel }],
        "openai-compatible": [],
      },
      defaultValueByValue: { deepseek: defaultModel },
      customValueAllowedByValue: { deepseek: false, "openai-compatible": true },
    },
  };
}

function fixture(): ResolvedAgentCreateFormDefinition {
  const resolved = resolveAgentCreateFormDefinition(definitionFixture(), sourceFixtures());
  assert.ok(resolved);
  return resolved;
}

test("schema-backed Built-in preset and gateway payloads preserve legacy parity", () => {
  const definition = fixture();
  const presetModel = builtInProviderDefaultModel("deepseek")!;
  assert.deepEqual(
    buildSchemaDrivenBuiltInConfig({
      definition,
      providerId: "deepseek",
      apiKey: " sk-deepseek-test ",
      baseUrl: "",
      supportsImageInput: false,
      model: presetModel,
      envVars: { TEAM_FLAG: "1" },
    }),
    buildRuntimeConfig({
      runtime: "builtin",
      model: presetModel,
      customModelMode: false,
      builtInProviderMode: "deepseek",
      builtInProviderApiKey: " sk-deepseek-test ",
      envVars: { TEAM_FLAG: "1" },
    }),
  );
  assert.deepEqual(
    buildSchemaDrivenBuiltInConfig({
      definition,
      providerId: "openai-compatible",
      apiKey: " sk-gateway-test ",
      baseUrl: " https://gateway.example.test/v1 ",
      supportsImageInput: true,
      model: "acme/custom-model",
      envVars: null,
    }),
    buildRuntimeConfig({
      runtime: "builtin",
      model: "acme/custom-model",
      customModelMode: true,
      customModelName: "acme/custom-model",
      builtInProviderMode: "openai-compatible",
      builtInProviderApiKey: " sk-gateway-test ",
      builtInProviderBaseUrl: " https://gateway.example.test/v1 ",
      builtInProviderSupportsImageInput: true,
      envVars: null,
    }),
  );
});

test("renderer definition validator rejects unknown controls/protocol and secret defaults", () => {
  const parsedDefinition = parseAgentCreateFormDefinition(definitionFixture(), ref);
  assert.ok(parsedDefinition);
  const parsedSources = Object.fromEntries(Object.entries(sourceFixtures()).map(([key, source]) => {
    const sourceRef = parsedDefinition.optionSources[key]!;
    const parsed = parseAgentCreateFormOptionSource(source, sourceRef);
    assert.ok(parsed);
    return [key, parsed];
  }));
  assert.ok(resolveAgentCreateFormDefinition(parsedDefinition, parsedSources));

  const unknownKeyword = definitionFixture() as unknown as Record<string, unknown>;
  (unknownKeyword.dataSchema as Record<string, unknown>).oneOf = [];
  assert.equal(parseAgentCreateFormDefinition(unknownKeyword, ref), null);

  const secretDefault = definitionFixture() as unknown as { dataSchema: { properties: { apiKey: Record<string, unknown> } } };
  secretDefault.dataSchema.properties.apiKey.default = "must-never-ship";
  assert.equal(parseAgentCreateFormDefinition(secretDefault, ref), null);

  const secretNotWriteOnly = definitionFixture();
  const secretSchema = secretNotWriteOnly.dataSchema.properties.apiKey;
  if (secretSchema.type === "string") secretSchema.writeOnly = false;
  assert.equal(parseAgentCreateFormDefinition(secretNotWriteOnly, ref), null);

  const missingRequired = definitionFixture();
  missingRequired.dataSchema.required = [];
  assert.equal(parseAgentCreateFormDefinition(missingRequired, ref), null);

  const wrongProtocol = definitionFixture();
  (wrongProtocol as unknown as { protocolVersion: number }).protocolVersion = 2;
  assert.equal(parseAgentCreateFormDefinition(wrongProtocol, ref), null);

  const unknownOptionControl = sourceFixtures().provider as unknown as { options: Array<Record<string, unknown>> };
  unknownOptionControl.options[0]!.surprise = true;
  assert.equal(parseAgentCreateFormOptionSource(unknownOptionControl, parsedDefinition.optionSources.provider!), null);

  const invalidOptionShape = sourceFixtures().model as unknown as {
    optionsByValue: Record<string, Array<Record<string, unknown>>>;
  };
  invalidOptionShape.optionsByValue.deepseek![0]!.value = 42;
  assert.equal(parseAgentCreateFormOptionSource(invalidOptionShape, parsedDefinition.optionSources.model!), null);

  const staleSource = sourceFixtures().provider as unknown as { schemaVersion: string };
  staleSource.schemaVersion = "stale";
  assert.equal(parseAgentCreateFormOptionSource(staleSource, parsedDefinition.optionSources.provider!), null);

  const wrongPointer = definitionFixture();
  wrongPointer.optionSources.provider.pointer = "/wrong";
  assert.equal(parseAgentCreateFormDefinition(wrongPointer, ref), null);

  const providerKindDrift = sourceFixtures();
  const providerSource = providerKindDrift.provider;
  if (providerSource?.kind === "select") providerSource.options[0]!.providerKind = "gateway";
  assert.equal(resolveAgentCreateFormDefinition(parsedDefinition, providerKindDrift), null);
});

test("schema payload builder rejects custom preset models and unknown fields stay unrepresentable", () => {
  assert.throws(() => buildSchemaDrivenBuiltInConfig({
    definition: fixture(),
    providerId: "deepseek",
    apiKey: "key",
    baseUrl: "",
    supportsImageInput: false,
    model: "unregistered/custom",
    envVars: null,
  }), /valid provider model/);
  assert.equal("hostUserState" in fixture().dataSchema.properties, false);
});

test("Kimi schema uses model-scoped live effort metadata and rejects cross-model leakage", () => {
  const definition: AgentCreateFormDefinition = {
    ...KIMI_SDK_FORM_DEFINITION_REF,
    dataSchema: {
      type: "object",
      additionalProperties: false,
      required: ["model"],
      properties: {
        model: { type: "string", title: "Model", minLength: 1 },
        reasoningEffort: { type: "string", title: "Thinking effort", minLength: 1 },
        envVars: { type: "object", title: "Environment Variables", additionalProperties: { type: "string" } },
      },
    },
    uiSchema: {
      order: ["model", "reasoningEffort", "envVars"],
      layout: { advanced: ["/envVars"] },
      visibility: [],
      localization: {},
    },
    capabilities: { providerKinds: [], writeOnlyPointers: [], forbiddenPointers: ["/hostUserState"] },
    optionSources: {
      model: {
        ...KIMI_SDK_FORM_DEFINITION_REF,
        sourceId: "model",
        kind: "select",
        pointer: "/model",
      },
    },
  };
  const source: AgentCreateFormOptionSource = {
    ...KIMI_SDK_FORM_DEFINITION_REF,
    sourceId: "model",
    kind: "select",
    pointer: "/model",
    options: [
      {
        value: "kimi-code/k3",
        label: "K3",
        supportedReasoningEfforts: ["balanced-plus"],
        defaultReasoningEffort: "balanced-plus",
      },
      { value: "kimi-code/k2", label: "K2" },
    ],
    defaultValue: "kimi-code/k3",
  };
  const parsed = parseAgentCreateFormDefinition(definition, KIMI_SDK_FORM_DEFINITION_REF);
  assert.ok(parsed);
  const parsedSource = parseAgentCreateFormOptionSource(source, parsed.optionSources.model!);
  assert.ok(parsedSource);
  const resolved = resolveAgentCreateFormDefinition(parsed, { model: parsedSource });
  assert.ok(resolved);
  assert.equal(
    buildSchemaDrivenKimiConfig({
      definition: resolved,
      model: "kimi-code/k3",
      reasoningEffort: "balanced-plus",
      envVars: null,
    }).reasoningEffort,
    "balanced-plus",
  );
  assert.throws(() => buildSchemaDrivenKimiConfig({
    definition: resolved,
    model: "kimi-code/k2",
    reasoningEffort: "balanced-plus",
    envVars: null,
  }), /supported by this model/);
  assert.equal(buildSchemaDrivenKimiConfig({
    definition: resolved,
    model: "kimi-code/k2",
    reasoningEffort: null,
    envVars: null,
  }).reasoningEffort, null);
});
