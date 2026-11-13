import assert from "node:assert/strict";
import { beforeEach, vi } from "vitest";

import { RUNTIME_CONFIG_VERSION, type RuntimeConfig } from "@botiverse/raft-shared";

import { isProviderConnectionsEnabled } from "./providerConnectionFeature";
import { listProviderConnections } from "./providerConnectionService";
import {
  buildRuntimeConfigFromFormValues,
  buildRuntimeFormV2ForServer,
  runtimeFormValuesFromRuntimeConfig,
  runtimeFormV2Entry,
  savedConnectionFormRevision,
  RUNTIME_FORM_V2_SAVED_CONNECTION_CAPABILITY,
  type RuntimeFormOptionSourceContext,
} from "./runtimeFormV2Registry";

vi.mock("./providerConnectionFeature", () => ({
  isProviderConnectionsEnabled: vi.fn(async () => false),
}));
vi.mock("./providerConnectionService", () => ({
  listProviderConnections: vi.fn(async () => []),
}));

const connectionsEnabled = vi.mocked(isProviderConnectionsEnabled);
const connections = vi.mocked(listProviderConnections);

beforeEach(() => {
  connectionsEnabled.mockResolvedValue(false);
  connections.mockResolvedValue([]);
});

const CONNECTION_SUMMARIES = [
  {
    id: "conn-1", name: "Team DeepSeek", providerId: "deepseek", authMethod: "api_key",
    endpointUrl: null, supportsImageInput: false, enabled: true, status: "ready",
    configVersion: 1, credentialVersion: 2, hasCredential: true, assignedAgentCount: 0,
    latestVerified: null, lastCheckedAt: null, lastErrorCategory: null,
    createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
  },
  {
    id: "conn-2", name: "Old Gateway", providerId: "openai-compatible", authMethod: "api_key",
    endpointUrl: "https://gw.example.test/v1", supportsImageInput: true, enabled: true, status: "ready",
    configVersion: 1, credentialVersion: 1, hasCredential: true, assignedAgentCount: 0,
    latestVerified: null, lastCheckedAt: null, lastErrorCategory: null,
    createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
  },
  {
    id: "conn-3", name: "Disabled DS", providerId: "deepseek", authMethod: "api_key",
    endpointUrl: null, supportsImageInput: false, enabled: false, status: "ready",
    configVersion: 1, credentialVersion: 1, hasCredential: true, assignedAgentCount: 1,
    latestVerified: null, lastCheckedAt: null, lastErrorCategory: null,
    createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
  },
] as unknown as Awaited<ReturnType<typeof listProviderConnections>>;

// ── Served form: capability, markers, revision ──

test("without the connections flag the builtin v2 form is served exactly as before", async () => {
  const form = await buildRuntimeFormV2ForServer("builtin", "server-1");
  assert.ok(form);
  assert.equal(form.revision, undefined);
  assert.ok(!(form.requiredClientCapabilities ?? []).includes(RUNTIME_FORM_V2_SAVED_CONNECTION_CAPABILITY));
  const properties = form.dataSchema.properties as Record<string, Record<string, unknown>>;
  assert.equal("x-connectionOwned" in properties.apiKey!, false);
});

test("with the flag the builtin v2 form declares the capability, marks owned fields and carries a revision", async () => {
  connectionsEnabled.mockResolvedValue(true);
  const form = await buildRuntimeFormV2ForServer("builtin", "server-1");
  assert.ok(form);
  assert.ok((form.requiredClientCapabilities ?? []).includes(RUNTIME_FORM_V2_SAVED_CONNECTION_CAPABILITY));
  const properties = form.dataSchema.properties as Record<string, Record<string, unknown>>;
  assert.equal(properties.apiKey!["x-connectionOwned"], true);
  assert.equal(properties.baseUrl!["x-connectionOwned"], true);
  assert.equal(properties.supportsImageInput!["x-connectionOwned"], true);
  assert.equal(properties.model!["x-connectionOwned"], undefined, "the model stays the user's choice");
  assert.equal(typeof form.revision, "string");
  assert.ok(form.revision!.length > 0);
  // The revision binds the form's semantics, deterministically.
  assert.equal(form.revision, savedConnectionFormRevision("builtin", runtimeFormV2Entry("builtin")!.buildForm()));
});

test("other runtimes never gain the saved-connection capability", async () => {
  connectionsEnabled.mockResolvedValue(true);
  const kimi = await buildRuntimeFormV2ForServer("kimi-sdk", "server-1");
  assert.ok(kimi);
  assert.ok(!(kimi.requiredClientCapabilities ?? []).includes(RUNTIME_FORM_V2_SAVED_CONNECTION_CAPABILITY));
  assert.equal(kimi.revision, undefined);
});

// ── Option sources: the three formRevision outcomes ──

function sourceContext(sourceId: string, overrides: Partial<RuntimeFormOptionSourceContext> = {}) {
  return {
    sourceId,
    machineId: "machine-1",
    machine: {},
    serverId: "server-1",
    agentOrchestrator: {
      detectMachineRuntimeModels: async () => { throw new Error("not used"); },
      detectMachineRuntimeModelsWithAuthority: async () => ({
        outcome: {
          kind: "live",
          value: {
            models: [
              { id: "deepseek/deepseek-chat", label: "DeepSeek Chat" },
              { id: "deepseek/deepseek-v4-pro", label: "V4 Pro" },
            ],
            catalog: { protocolVersion: 1, runtime: "builtin", runtimeVersion: "1.2.3", models: [] },
          },
        },
        daemonVersion: "1.0.0",
        computerVersion: "1.0.0",
      }),
    },
    routeToComputer: async () => "confirmed_local",
    ...overrides,
  } as unknown as RuntimeFormOptionSourceContext;
}

const resolveSource = (context: RuntimeFormOptionSourceContext) =>
  runtimeFormV2Entry("builtin")!.resolveOptionSource(context);

const currentRevision = () => savedConnectionFormRevision("builtin", runtimeFormV2Entry("builtin")!.buildForm());

test("an unrevisioned source request keeps the plain direct-option protocol: no connection options, no groups", async () => {
  connectionsEnabled.mockResolvedValue(true);
  connections.mockResolvedValue(CONNECTION_SUMMARIES);
  const resolution = await resolveSource(sourceContext("provider"));
  assert.equal(resolution.kind, "source");
  const options = (resolution as unknown as { source: { options: Array<Record<string, unknown>> } }).source.options;
  assert.ok(options.every((option) => option.connectionId === undefined), "no connection option without a revision");
  assert.ok(options.every((option) => option.group === undefined), "no group tags without a revision");
  assert.ok(options.some((option) => option.value === "deepseek"), "the direct options are unchanged");
});

test("a stale or flag-off revision is refused with 409 form_revision_stale and never probes", async () => {
  connectionsEnabled.mockResolvedValue(true);
  let probed = false;
  const context = sourceContext("provider", {
    formRevision: "not-the-current-revision",
    connectionsVisible: true,
    agentOrchestrator: {
      detectMachineRuntimeModels: async () => { throw new Error("not used"); },
      detectMachineRuntimeModelsWithAuthority: async () => { probed = true; throw new Error("must not probe"); },
    },
  } as Partial<RuntimeFormOptionSourceContext>);
  const resolution = await resolveSource(context);
  assert.deepEqual(resolution, {
    kind: "reply",
    status: 409,
    body: {
      error: "Runtime form has changed; refetch it before loading options",
      code: "form_revision_stale",
      recovery: "refetch_form",
    },
  });
  assert.equal(probed, false, "the revision gate runs before any Computer probe");

  // The flag flipping off after the form was fetched is the same stale case.
  connectionsEnabled.mockResolvedValue(false);
  const offResolution = await resolveSource(sourceContext("provider", { formRevision: currentRevision(), connectionsVisible: true }));
  assert.equal(offResolution.kind, "reply");
  assert.equal((offResolution as unknown as { status: number }).status, 409);
});

test("a matching revision serves saved connections first, with availability markers and one model key space", async () => {
  connectionsEnabled.mockResolvedValue(true);
  connections.mockResolvedValue(CONNECTION_SUMMARIES);
  const revision = currentRevision();

  const providerResolution = await resolveSource(sourceContext("provider", { formRevision: revision, connectionsVisible: true }));
  assert.equal(providerResolution.kind, "source");
  const providerSource = (providerResolution as unknown as { source: Record<string, unknown> }).source;
  const options = providerSource.options as Array<Record<string, unknown>>;
  assert.deepEqual(
    options.slice(0, 3).map((option) => option.value),
    ["connection:conn-1", "connection:conn-2", "connection:conn-3"],
    "saved providers lead the selector",
  );
  assert.deepEqual(options[0], {
    value: "connection:conn-1",
    label: "DeepSeek · Team DeepSeek",
    providerKind: "preset",
    connectionId: "conn-1",
    underlyingProviderId: "deepseek",
    group: "saved",
  });
  assert.equal(options[1]!.providerKind, "gateway");
  assert.deepEqual(
    { unavailable: options[2]!.unavailable, unavailableReason: options[2]!.unavailableReason },
    { unavailable: true, unavailableReason: "disabled" },
    "a disabled connection stays visible but not selectable",
  );
  assert.ok(options.slice(3).every((option) => option.group === "direct"), "direct options are tagged for grouping");

  const modelResolution = await resolveSource(sourceContext("model", { formRevision: revision, connectionsVisible: true }));
  assert.equal(modelResolution.kind, "source");
  const modelSource = (modelResolution as unknown as { source: Record<string, unknown> }).source;
  const optionsByValue = modelSource.optionsByValue as Record<string, Array<{ value: string }>>;
  const customByValue = modelSource.customValueAllowedByValue as Record<string, boolean>;
  assert.deepEqual(
    optionsByValue["connection:conn-1"],
    optionsByValue["deepseek"],
    "a preset connection mirrors its provider's catalog-filtered list under the same connection key",
  );
  assert.ok((optionsByValue["connection:conn-1"] ?? []).length > 0, "the fixture catalog keeps at least one deepseek model");
  assert.deepEqual(optionsByValue["connection:conn-2"], [], "a gateway connection lists nothing...");
  assert.equal(customByValue["connection:conn-2"], true, "...and keeps the gateway's typed-model semantics");
  assert.equal(customByValue["connection:conn-1"], false);
});

test("a matching revision without connection-listing authority still never serves connection options", async () => {
  connectionsEnabled.mockResolvedValue(true);
  connections.mockResolvedValue(CONNECTION_SUMMARIES);
  const resolution = await resolveSource(sourceContext("provider", { formRevision: currentRevision(), connectionsVisible: false }));
  assert.equal(resolution.kind, "source");
  const options = (resolution as unknown as { source: { options: Array<Record<string, unknown>> } }).source.options;
  assert.ok(options.every((option) => option.connectionId === undefined), "fail closed on authority");
  assert.ok(options.length > 0, "the direct options still answer");
  assert.equal(connections.mock.calls.length, 0, "the catalog is not even read without authority");
});

// ── Submit mapping ──

const connectionSubmit = (extra: Record<string, unknown> = {}) => {
  const values: Record<string, unknown> = {
    providerId: "connection:conn-1",
    model: "deepseek/deepseek-v4-pro",
    loadLocalPlugins: false,
    ...extra,
  };
  // Mirror the route: the connection's provider is resolved server-side
  // (savedConnectionProviderIdForSubmit) before the mapping decides the model
  // kind. The test reads the same mock catalog the option sources use.
  const id = String(values.providerId).slice("connection:".length);
  const providerId = (CONNECTION_SUMMARIES as unknown as Array<{ id: string; providerId: string }>)
    .find((candidate) => candidate.id === id)?.providerId;
  return buildRuntimeConfigFromFormValues("builtin", values, providerId ? { savedConnectionProviderId: providerId } : {});
};

test("a connection submit assembles provider.kind=connection and nothing else from the owned fields", () => {
  const built = connectionSubmit();
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.deepEqual(built.runtimeConfig.provider, { kind: "connection", connectionId: "conn-1" });
  assert.deepEqual(built.runtimeConfig.model, { kind: "preset", id: "deepseek/deepseek-v4-pro" });
  assert.equal("apiKey" in (built.runtimeConfig.provider as object), false, "no secret is ever copied into the agent config");
  assert.deepEqual(built.formDefinitionRef, { protocolVersion: 2, runtimeId: "builtin" });
});

test("an unlisted model on a connection submit is carried as custom for the route's per-connection check", () => {
  const built = connectionSubmit({ model: "some/typed-model" });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.deepEqual(built.runtimeConfig.model, { kind: "custom", name: "some/typed-model" });
});

test("any client-sent connection-owned field is refused: non-empty, empty string and null alike", () => {
  for (const [field, value] of [["apiKey", "sk-x"], ["apiKey", ""], ["apiKey", null], ["baseUrl", "https://x"], ["supportsImageInput", false]] as Array<[string, unknown]>) {
    const built = connectionSubmit({ [field]: value });
    assert.deepEqual(
      built,
      { ok: false, issue: { code: "connection_field_forbidden", pointer: `/formValues/${field}` } },
      `${field}=${JSON.stringify(value)}`,
    );
  }
});

test("a malformed connection value or a missing model is refused", () => {
  assert.deepEqual(
    buildRuntimeConfigFromFormValues("builtin", { providerId: "connection:", model: "m" }),
    { ok: false, issue: { code: "select_valid_provider", pointer: "/formValues/providerId" } },
  );
  assert.deepEqual(
    buildRuntimeConfigFromFormValues("builtin", { providerId: "connection:conn-1", model: "" }),
    { ok: false, issue: { code: "model_required", pointer: "/formValues/model" } },
  );
});

// ── Edit values ──

test("a bound agent's stored config maps back to the connection option value, without any secret", () => {
  const stored = {
    version: RUNTIME_CONFIG_VERSION,
    runtime: "builtin",
    provider: { kind: "connection", connectionId: "conn-1" },
    model: { kind: "preset", id: "deepseek/deepseek-v4-pro" },
    mode: { kind: "default" },
    reasoningEffort: null,
    envVars: null,
    loadLocalPlugins: true,
  } as unknown as RuntimeConfig;
  const values = runtimeFormValuesFromRuntimeConfig(stored);
  assert.deepEqual(values, {
    reasoningEffort: "",
    providerId: "connection:conn-1",
    model: "deepseek/deepseek-v4-pro",
    loadLocalPlugins: true,
    envVars: {},
  });
  assert.equal(values && "apiKey" in values, false);
});

// Independent review regression: a gateway may use a name equal to a preset ID.
test("review: gateway accepts a custom model name that collides with a preset ID", async () => {
  const { assertProviderConnectionModelCompatible } = await vi.importActual<typeof import("./providerConnectionService")>("./providerConnectionService");
  const modelName = "deepseek/deepseek-v4-pro";
  assert.doesNotThrow(() => assertProviderConnectionModelCompatible("openai-compatible", { kind: "custom", name: modelName }));
  const built = connectionSubmit({ providerId: "connection:conn-2", model: modelName });
  assert.ok(built.ok);
  if (!built.ok || built.runtimeConfig.runtime !== "builtin") return;
  assert.doesNotThrow(() => assertProviderConnectionModelCompatible("openai-compatible", built.runtimeConfig.model as RuntimeConfig["model"]));
});

// Phase 2 acceptance (archer, 2026-10-11): an old Computer pushes an old live
// catalog; the form must tolerate it — a preset connection whose provider has
// no models in that catalog still gets its option and an empty model list, so
// the required-model rule blocks the save instead of the source failing.
test("an old Computer catalog without the connection's models degrades to an empty list, not an error", async () => {
  connectionsEnabled.mockResolvedValue(true);
  connections.mockResolvedValue(CONNECTION_SUMMARIES);
  const context = sourceContext("model", {
    formRevision: currentRevision(),
    connectionsVisible: true,
    agentOrchestrator: {
      detectMachineRuntimeModels: async () => { throw new Error("not used"); },
      detectMachineRuntimeModelsWithAuthority: async () => ({
        outcome: {
          kind: "live",
          value: {
            // A catalog from an older Computer build: no deepseek models at all.
            models: [{ id: "openai/gpt-legacy", label: "Legacy" }],
            catalog: { protocolVersion: 1, runtime: "builtin", runtimeVersion: "0.9.0", models: [] },
          },
        },
        daemonVersion: "0.9.0",
        computerVersion: "0.9.0",
      }),
    },
  } as unknown as Partial<RuntimeFormOptionSourceContext>);
  const resolution = await resolveSource(context as RuntimeFormOptionSourceContext);
  assert.equal(resolution.kind, "source");
  const source = (resolution as unknown as { source: Record<string, unknown> }).source;
  const optionsByValue = source.optionsByValue as Record<string, Array<{ value: string }>>;
  const customByValue = source.customValueAllowedByValue as Record<string, boolean>;
  assert.deepEqual(optionsByValue["connection:conn-1"], [], "the preset connection mirrors the (empty) filtered list");
  assert.equal(customByValue["connection:conn-1"], false);
  assert.deepEqual(optionsByValue["connection:conn-2"], [], "the gateway connection keeps its empty list...");
  assert.equal(customByValue["connection:conn-2"], true, "...and its typed-model semantics survive any catalog");
});
