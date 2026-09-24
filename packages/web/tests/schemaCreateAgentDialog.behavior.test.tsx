import "./helpers/domSetup";

import assert from "node:assert/strict";
import { assertOptionFieldLabels } from "./helpers/optionFieldLabels";

import { afterEach, test } from "node:test";
import type { ComponentProps, ReactElement } from "react";
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import type { RenderOptions } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import {
  KIMI_SDK_FORM_DEFINITION_REF,
  PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY,
} from "@botiverse/raft-shared";
import type {
  ResolvedAgentCreateFormDefinition,
  RuntimeFormDefinitionRef,
  RuntimeSelectionOption,
} from "@botiverse/raft-shared";
import api from "../src/api/client";
import { ActionCard } from "../src/components/actions/ActionCard";
import CreateAgentDialog from "../src/components/agent/CreateAgentDialog";
import { useAgentStore } from "../src/store/agentStore";
import type { Agent } from "../src/store/agentStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMachineStore } from "../src/store/machineStore";
import { useMessageStore } from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";
import {
  prefetchServerFeatureFlags,
  resetServerFeatureFlagsForTests,
} from "../src/store/serverFeatureFlags";
import { writeCreateAgentLastConfig } from "../src/utils/createAgentLastConfig";
import { TestIntlProvider } from "./helpers/intl";

function render(ui: ReactElement, options?: RenderOptions) {
  return rtlRender(<TestIntlProvider>{ui}</TestIntlProvider>, options);
}

const originalGet = api.get;
const originalPost = api.post;

const ref: RuntimeFormDefinitionRef = {
  protocolVersion: 1,
  runtimeId: "builtin",
  schemaVersion: "builtin-pi.create.v2",
};

const kimiRef: RuntimeFormDefinitionRef = KIMI_SDK_FORM_DEFINITION_REF;

function kimiDefinitionFixture(): ResolvedAgentCreateFormDefinition {
  return {
    ...kimiRef,
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
      localization: {
        model: { label: "Served Kimi model" },
        reasoningEffort: { label: "Served thinking effort" },
        envVars: { label: "Served environment" },
      },
    },
    capabilities: {
      providerKinds: [],
      writeOnlyPointers: [],
      forbiddenPointers: ["/hostUserState"],
    },
    optionSources: {
      model: {
        ...kimiRef,
        sourceId: "model",
        kind: "select",
        pointer: "/model",
        options: [
          {
            value: "kimi-code/k3",
            label: "Kimi K3",
            supportedReasoningEfforts: ["balanced-plus", "ultra"],
            defaultReasoningEffort: "balanced-plus",
          },
          { value: "kimi-code/k2", label: "Kimi K2" },
        ],
        defaultValue: "kimi-code/k3",
      },
    },
  };
}

function kimiDefinitionResponse() {
  const definition = kimiDefinitionFixture();
  return {
    ...definition,
    optionSources: {
      model: {
        ...kimiRef,
        sourceId: "model",
        kind: "select" as const,
        pointer: "/model",
      },
    },
  };
}

function definitionFixture(): ResolvedAgentCreateFormDefinition {
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
        providerId: { label: "Served Provider" },
        apiKey: { label: "Served API Key" },
        baseUrl: { label: "Served Base URL" },
        supportsImageInput: {
          label: "Served Image Input",
          hint: "Enable only for image-capable gateways.",
        },
        model: { label: "Served Model" },
        envVars: { label: "Served Environment" },
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
        options: [
          { value: "deepseek", label: "Server DeepSeek", providerKind: "preset" },
          { value: "openai-compatible", label: "Server Gateway", providerKind: "gateway" },
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
          deepseek: [{ value: "deepseek/deepseek-v4-pro", label: "Server Model" }],
          "openai-compatible": [],
        },
        defaultValueByValue: { deepseek: "deepseek/deepseek-v4-pro" },
        customValueAllowedByValue: { deepseek: false, "openai-compatible": true },
      },
    },
  };
}

function definitionResponse() {
  const definition = definitionFixture();
  return {
    ...definition,
    optionSources: {
      provider: {
        ...ref,
        sourceId: "provider",
        kind: "select" as const,
        pointer: "/providerId",
      },
      model: {
        ...ref,
        sourceId: "model",
        kind: "dependent_select" as const,
        pointer: "/model",
        dependsOn: "/providerId",
      },
    },
  };
}

function runtimeOption(runtimeId: string, formDefinitionRef?: RuntimeFormDefinitionRef): RuntimeSelectionOption {
  return {
    runtimeId,
    capabilityStatus: "available",
    admissionStatus: "available_for_new",
    admissionReason: null,
    current: false,
    availableForNew: true,
    manageableForCurrentAgent: false,
    canSelectInThisContext: true,
    formDefinitionRef,
  };
}

function makeAgent(runtime: string, runtimeConfig: unknown): Agent {
  return {
    id: `agent-${runtime}`,
    serverId: "server-1",
    name: "Alice",
    displayName: "Alice",
    avatarUrl: "pixel:mug",
    description: null,
    status: "starting",
    model: runtime === "builtin" ? "deepseek/deepseek-v4-pro" : "gpt-5",
    runtime,
    serverRole: null,
    runtimeConfig: runtimeConfig as Agent["runtimeConfig"],
    lastRuntimeError: null,
    reasoningEffort: null,
    executionMode: "byoc",
    envVars: null,
    machineId: "machine-1",
    creatorType: "user",
    creatorId: "owner-1",
    creator: null,
    createdAgents: [],
    deletedAt: null,
    createdAt: "2026-07-22T00:00:00.000Z",
  };
}

function seedStores(runtimes: string[]) {
  useServerStore.setState({
    current: {
      id: "server-1",
      name: "Launch",
      slug: "launch",
      avatarUrl: null,
      ownerId: "owner-1",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "owner",
      createdAt: "2026-07-22T00:00:00.000Z",
    },
    billing: null,
    loadBilling: async () => undefined,
  } as never);
  useMachineStore.setState({
    machines: [{
      id: "machine-1",
      name: "Mac",
      description: null,
      status: "online",
      statusVersion: 1,
      apiKeyPrefix: null,
      runtimes,
      hostname: "mac.local",
      os: "darwin",
      daemonVersion: "1.0.13",
      lastHeartbeat: "2026-07-22T00:00:00.000Z",
      createdAt: "2026-07-22T00:00:00.000Z",
    }],
  } as never);
  useChannelStore.setState({ channels: [] } as never);
  useAgentStore.setState({ agents: [], loading: false } as never);
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="create-agent-location">{location.pathname}{location.search}</output>;
}

function renderDialog({
  initialEntry = "/s/launch/channel/source",
  ...props
}: Partial<ComponentProps<typeof CreateAgentDialog>> & { initialEntry?: string } = {}) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <LocationProbe />
      <CreateAgentDialog
        defaultMachineId="machine-1"
        onClose={() => undefined}
        {...props}
      />
    </MemoryRouter>,
  );
}

function mockCodexCreateApi(createdId = "agent-created") {
  api.get = (async (url: string) => {
    if (url === "/provider-connections") return { data: { connections: [] } } as never;
    if (url.endsWith("/runtime-options")) {
      return { data: { context: "new_agent", machineId: "machine-1", options: [runtimeOption("codex")] } } as never;
    }
    if (url.includes("/runtime-models/")) return { data: { models: [] } } as never;
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
  api.post = (async (url: string, body?: unknown) => {
    if (/^\/actions\/[^/]+\/event$/.test(url)) return { data: {} } as never;
    assert.equal(url, "/agents");
    const request = body as { runtime: string; runtimeConfig: unknown };
    return {
      data: {
        ...makeAgent(request.runtime, request.runtimeConfig),
        id: createdId,
      },
    } as never;
  }) as typeof api.post;
}

async function submitManagedAgent(name = "Alice") {
  await waitFor(() => assert.ok(screen.getAllByText("Codex CLI").length > 0));
  fireEvent.change(screen.getByPlaceholderText("e.g. Alice"), { target: { value: name } });
  const create = screen.getByRole("button", { name: "Create Agent" }) as HTMLButtonElement;
  await waitFor(() => assert.equal(create.disabled, false));
  fireEvent.click(create);
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  api.get = originalGet;
  api.post = originalPost;
  useAgentStore.setState(useAgentStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useMachineStore.setState(useMachineStore.getInitialState(), true);
  useMessageStore.setState(useMessageStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
  resetServerFeatureFlagsForTests();
});

test("the mounted onboarding form owns its narrow-viewport scroll boundary", async () => {
  seedStores(["builtin"]);
  api.get = (async (url: string) => {
    if (url === "/provider-connections") return { data: { connections: [] } } as never;
    if (url.endsWith("/runtime-options")) {
      return { data: { context: "new_agent", machineId: "machine-1", options: [runtimeOption("builtin", ref)] } } as never;
    }
    if (url.includes("/runtime-form-definitions/builtin/option-sources/provider?schemaVersion=builtin-pi.create.v2")) {
      return { data: definitionFixture().optionSources.provider } as never;
    }
    if (url.includes("/runtime-form-definitions/builtin/option-sources/model?schemaVersion=builtin-pi.create.v2")) {
      return { data: definitionFixture().optionSources.model } as never;
    }
    if (url.includes("/runtime-form-definitions/builtin?schemaVersion=builtin-pi.create.v2")) {
      return { data: definitionResponse() } as never;
    }
    if (url.includes("/runtime-models/")) return { data: { models: [] } } as never;
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;

  renderDialog({ onboarding: true });

  await waitFor(() => {
    const onboardingForm = document.querySelector("#create-cindy-onboarding-form");
    const narrowFormScrollport = onboardingForm?.querySelector(".overflow-y-auto");
    assert.ok(
      narrowFormScrollport,
      "the mounted onboarding form keeps its own narrow-viewport scroll boundary",
    );
    assert.match(
      narrowFormScrollport.className,
      /max-h-\[min\(70dvh,calc\(100dvh-12rem\)\)\]/,
      "the mounted onboarding form keeps the viewport-bounded height",
    );
  });
});

test("Built-in ref fetches the exact definition, renders served options, and forwards the exact schema payload", async () => {
  seedStores(["builtin"]);
  const getCalls: string[] = [];
  const postBodies: unknown[] = [];
  api.get = (async (url: string) => {
    getCalls.push(url);
    if (url === "/provider-connections") return { data: { connections: [] } } as never;
    if (url.endsWith("/runtime-options")) {
      return { data: { context: "new_agent", machineId: "machine-1", options: [runtimeOption("builtin", ref)] } } as never;
    }
    if (url.includes("/runtime-form-definitions/builtin/option-sources/provider?schemaVersion=builtin-pi.create.v2")) {
      return { data: definitionFixture().optionSources.provider } as never;
    }
    if (url.includes("/runtime-form-definitions/builtin/option-sources/model?schemaVersion=builtin-pi.create.v2")) {
      return { data: definitionFixture().optionSources.model } as never;
    }
    if (url.includes("/runtime-form-definitions/builtin?schemaVersion=builtin-pi.create.v2")) {
      return { data: definitionResponse() } as never;
    }
    if (url.includes("/runtime-models/")) return { data: { models: [] } } as never;
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
  api.post = (async (url: string, body?: unknown) => {
    assert.equal(url, "/agents");
    postBodies.push(body);
    const request = body as { runtime: string; runtimeConfig: unknown };
    return { data: makeAgent(request.runtime, request.runtimeConfig) } as never;
  }) as typeof api.post;

  renderDialog();

  assert.ok(await screen.findByText("Server DeepSeek"));
  assert.ok(screen.getAllByText("Server Model").length > 0);
  assert.ok(getCalls.includes(
    "/servers/server-1/machines/machine-1/runtime-form-definitions/builtin?schemaVersion=builtin-pi.create.v2",
  ));
  assert.ok(getCalls.includes(
    "/servers/server-1/machines/machine-1/runtime-form-definitions/builtin/option-sources/provider?schemaVersion=builtin-pi.create.v2",
  ));
  assert.ok(getCalls.includes(
    "/servers/server-1/machines/machine-1/runtime-form-definitions/builtin/option-sources/model?schemaVersion=builtin-pi.create.v2",
  ));
  assert.equal(
    getCalls.includes("/provider-connections"),
    false,
    "disabled provider connections must not be discoverable from Agent creation",
  );
  fireEvent.change(screen.getByPlaceholderText("e.g. Alice"), { target: { value: "Alice" } });
  fireEvent.change(screen.getByTestId("schema-runtime-api-key"), { target: { value: "schema-ui-secret" } });
  assert.equal(
    screen.queryAllByRole("button", { name: "More" }).length,
    0,
    "schema-driven Built-in must not render an empty More disclosure shell",
  );
  const advancedDisclosure = screen.getByRole("button", { name: "Advanced" });
  assert.equal(advancedDisclosure.getAttribute("aria-expanded"), "false");
  assert.equal(screen.queryAllByText("Environment Variables").length, 0);
  fireEvent.click(advancedDisclosure);
  assert.equal(advancedDisclosure.getAttribute("aria-expanded"), "true");
  assert.ok(screen.getByText("Environment Variables"));
  fireEvent.click(screen.getByRole("button", { name: "Add Variable" }));
  fireEvent.change(screen.getByPlaceholderText("KEY"), { target: { value: "TEAM_FLAG" } });
  fireEvent.change(screen.getByPlaceholderText("value"), { target: { value: "1" } });
  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));

  await waitFor(() => assert.equal(postBodies.length, 1));
  const submitted = postBodies[0] as Record<string, unknown> & {
    runtimeConfig: { provider: Record<string, unknown>; envVars: Record<string, string> };
  };
  assert.deepEqual(submitted.formDefinitionRef, ref);
  assert.equal(submitted.runtime, "builtin");
  assert.deepEqual(submitted.runtimeConfig.provider, {
    kind: "preset",
    providerId: "deepseek",
    apiKey: "schema-ui-secret",
  });
  assert.deepEqual(submitted.runtimeConfig.envVars, { TEAM_FLAG: "1" });
  assert.equal(submitted.envVars, undefined, "schema env belongs only inside runtimeConfig");
  assert.equal(submitted.apiKey, undefined, "writeOnly input is never duplicated at top level");
});

test("Kimi create uses the served model-scoped effort metadata without cross-model leakage", async () => {
  seedStores(["kimi-sdk"]);
  const postBodies: unknown[] = [];
  api.get = (async (url: string) => {
    if (url === "/provider-connections") return { data: { connections: [] } } as never;
    if (url.endsWith("/runtime-options")) {
      return {
        data: {
          context: "new_agent",
          machineId: "machine-1",
          options: [runtimeOption("kimi-sdk", kimiRef)],
        },
      } as never;
    }
    if (url.includes("/runtime-form-definitions/kimi-sdk/option-sources/model?schemaVersion=")) {
      return { data: kimiDefinitionFixture().optionSources.model } as never;
    }
    if (url.includes("/runtime-form-definitions/kimi-sdk?schemaVersion=")) {
      return { data: kimiDefinitionResponse() } as never;
    }
    if (url.includes("/runtime-models/")) return { data: { models: [] } } as never;
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
  api.post = (async (url: string, body?: unknown) => {
    assert.equal(url, "/agents");
    postBodies.push(body);
    const request = body as { runtime: string; runtimeConfig: unknown };
    return { data: makeAgent(request.runtime, request.runtimeConfig) } as never;
  }) as typeof api.post;

  renderDialog();

  const modelSelect = await screen.findByTestId("schema-runtime-model-select");
  assert.ok(screen.getByTestId("schema-runtime-reasoning-select"));
  fireEvent.click(modelSelect);
  const k2Option = await screen.findByRole("option", { name: "Kimi K2" });
  fireEvent.pointerDown(k2Option);
  fireEvent.click(k2Option);
  await waitFor(() => assert.equal(screen.queryByTestId("schema-runtime-reasoning-select"), null));

  fireEvent.click(modelSelect);
  const k3Option = await screen.findByRole("option", { name: "Kimi K3" });
  fireEvent.pointerDown(k3Option);
  fireEvent.click(k3Option);
  assert.ok(await screen.findByTestId("schema-runtime-reasoning-select"));

  fireEvent.change(screen.getByPlaceholderText("e.g. Alice"), { target: { value: "KimiAlice" } });
  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
  await waitFor(() => assert.equal(postBodies.length, 1));
  const submitted = postBodies[0] as Record<string, unknown> & {
    runtimeConfig: { model: { id: string }; reasoningEffort: string | null };
  };
  assert.deepEqual(submitted.formDefinitionRef, kimiRef);
  assert.equal(submitted.runtime, "kimi-sdk");
  assert.equal(submitted.runtimeConfig.model.id, "kimi-code/k3");
  assert.equal(submitted.runtimeConfig.reasoningEffort, "balanced-plus");
  assert.equal(submitted.reasoningEffort, undefined, "open Kimi effort stays inside runtimeConfig");
});

test("Kimi create without a schema ref hides and omits the unmanaged effort field", async () => {
  seedStores(["kimi-sdk"]);
  const postBodies: unknown[] = [];
  api.get = (async (url: string) => {
    if (url === "/provider-connections") return { data: { connections: [] } } as never;
    if (url.endsWith("/runtime-options")) {
      return {
        data: {
          context: "new_agent",
          machineId: "machine-1",
          options: [runtimeOption("kimi-sdk")],
        },
      } as never;
    }
    if (url.includes("/runtime-models/kimi-sdk")) {
      return {
        data: {
          default: "kimi-code/kimi-for-coding",
          models: [{
            id: "kimi-code/kimi-for-coding",
            label: "Kimi for Coding",
            supportedReasoningEfforts: ["balanced-plus"],
            defaultReasoningEffort: "balanced-plus",
          }],
        },
      } as never;
    }
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
  api.post = (async (url: string, body?: unknown) => {
    assert.equal(url, "/agents");
    postBodies.push(body);
    const request = body as { runtime: string; runtimeConfig: unknown };
    return { data: makeAgent(request.runtime, request.runtimeConfig) } as never;
  }) as typeof api.post;

  renderDialog();
  await waitFor(() => assert.ok(screen.getAllByText(/Kimi/).length > 0));
  assert.equal(screen.queryByTestId("schema-runtime-reasoning-select"), null);
  assert.equal(screen.queryByTestId("runtime-reasoning-select"), null);

  fireEvent.change(screen.getByPlaceholderText("e.g. Alice"), { target: { value: "LegacyKimi" } });
  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
  await waitFor(() => assert.equal(postBodies.length, 1));

  const submitted = postBodies[0] as {
    formDefinitionRef?: unknown;
    reasoningEffort?: unknown;
    runtimeConfig: Record<string, unknown>;
  };
  assert.equal(submitted.formDefinitionRef, undefined);
  assert.equal(submitted.reasoningEffort, undefined);
  assert.equal(
    Object.hasOwn(submitted.runtimeConfig, "reasoningEffort"),
    false,
    "a no-schema client must not synthesize even a null Kimi effort field",
  );
});

test("a ready provider connection hides inline credentials and submits only its reference", async () => {
  seedStores(["builtin"]);
  const postBodies: unknown[] = [];
  api.get = (async (url: string) => {
    if (url === "/provider-connections") {
      return { data: { connections: [{
        id: "11111111-1111-4111-8111-111111111111",
        name: "Team DeepSeek",
        providerId: "deepseek",
        authMethod: "api_key",
        endpointUrl: null,
        supportsImageInput: false,
        enabled: true,
        status: "ready",
        configVersion: 1,
        credentialVersion: 1,
        hasCredential: true,
        assignedAgentCount: 0,
        lastCheckedAt: "2026-08-03T08:00:00.000Z",
        lastErrorCategory: null,
        createdAt: "2026-08-03T08:00:00.000Z",
        updatedAt: "2026-08-03T08:00:00.000Z",
      }] } } as never;
    }
    if (url.endsWith("/runtime-options")) {
      return { data: { context: "new_agent", machineId: "machine-1", options: [runtimeOption("builtin", ref)] } } as never;
    }
    if (url.includes("/runtime-form-definitions/builtin/option-sources/provider?schemaVersion=builtin-pi.create.v2")) {
      return { data: definitionFixture().optionSources.provider } as never;
    }
    if (url.includes("/runtime-form-definitions/builtin/option-sources/model?schemaVersion=builtin-pi.create.v2")) {
      return { data: definitionFixture().optionSources.model } as never;
    }
    if (url.includes("/runtime-form-definitions/builtin?schemaVersion=builtin-pi.create.v2")) {
      return { data: definitionResponse() } as never;
    }
    if (url.includes("/runtime-models/")) return { data: { models: [] } } as never;
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
  api.post = (async (url: string, body?: unknown) => {
    if (url === "/feature-flags/evaluate") {
      return {
        data: { evaluations: [{ key: PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY, enabled: true }] },
      } as never;
    }
    assert.equal(url, "/agents");
    postBodies.push(body);
    const request = body as { runtime: string; runtimeConfig: unknown };
    return { data: makeAgent(request.runtime, request.runtimeConfig) } as never;
  }) as typeof api.post;

  await prefetchServerFeatureFlags("server-1");
  renderDialog();
  const connectionSelect = await screen.findByTestId("create-agent-provider-connection");
  fireEvent.click(connectionSelect);
  const connectionOption = await screen.findByRole("option", { name: "Team DeepSeek" });
  fireEvent.pointerDown(connectionOption);
  fireEvent.click(connectionOption);
  await waitFor(() => assert.equal(screen.queryByTestId("schema-runtime-api-key"), null));
  fireEvent.change(screen.getByPlaceholderText("e.g. Alice"), { target: { value: "Alice" } });
  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));

  await waitFor(() => assert.equal(postBodies.length, 1));
  const submitted = postBodies[0] as {
    runtimeConfig: { provider: Record<string, unknown> };
  };
  assert.deepEqual(submitted.runtimeConfig.provider, {
    kind: "connection",
    connectionId: "11111111-1111-4111-8111-111111111111",
  });
  assert.equal(JSON.stringify(submitted).includes("apiKey"), false);
});

test("gateway image-input checkbox resets on provider switch and submits only when checked", async () => {
  seedStores(["builtin"]);
  const postBodies: unknown[] = [];
  api.get = (async (url: string) => {
    if (url === "/provider-connections") return { data: { connections: [] } } as never;
    if (url.endsWith("/runtime-options")) {
      return { data: { context: "new_agent", machineId: "machine-1", options: [runtimeOption("builtin", ref)] } } as never;
    }
    if (url.includes("/runtime-form-definitions/builtin/option-sources/provider?schemaVersion=builtin-pi.create.v2")) {
      return { data: definitionFixture().optionSources.provider } as never;
    }
    if (url.includes("/runtime-form-definitions/builtin/option-sources/model?schemaVersion=builtin-pi.create.v2")) {
      return { data: definitionFixture().optionSources.model } as never;
    }
    if (url.includes("/runtime-form-definitions/builtin?schemaVersion=builtin-pi.create.v2")) {
      return { data: definitionResponse() } as never;
    }
    if (url.includes("/runtime-models/")) return { data: { models: [] } } as never;
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
  api.post = (async (url: string, body?: unknown) => {
    assert.equal(url, "/agents");
    postBodies.push(body);
    const request = body as { runtime: string; runtimeConfig: unknown };
    return { data: makeAgent(request.runtime, request.runtimeConfig) } as never;
  }) as typeof api.post;

  renderDialog();
  assert.ok(await screen.findByText("Server DeepSeek"));
  const providerSelect = screen.getByTestId("schema-runtime-provider-select");
  const chooseProvider = async (name: string) => {
    fireEvent.click(providerSelect);
    const option = await screen.findByRole("option", { name });
    fireEvent.pointerDown(option);
    fireEvent.click(option);
  };

  const advancedDisclosure = screen.getByRole("button", { name: "Advanced" });
  fireEvent.click(advancedDisclosure);
  assert.ok(screen.getByText("Environment Variables"));
  await chooseProvider("Server Gateway");
  assert.equal(
    screen.getByRole("button", { name: "Advanced" }).getAttribute("aria-expanded"),
    "false",
  );
  assert.equal(screen.queryAllByText("Environment Variables").length, 0);
  // `aria-checked`, not `.checked`: this is raft-ui's Switch, which renders a
  // `role="switch"` element plus a hidden input, so the input no longer carries
  // the test id. The behaviour asserted is unchanged — verified by driving the
  // control before this assertion was touched.
  const imageInput = await screen.findByTestId("schema-runtime-supports-image-input");

  // "Served Image Input" — the SCHEMA's own label — not the hardcoded
  // "Supports image input" this asserted before.
  //
  // The Card is still here; what changed is that the OPTION NAME now prefers the
  // schema-supplied label. Previously the field rendered the schema label while
  // the CardTitle inside it hardcoded a different string, so the control was
  // announced by the hardcoded one and the runtime form definition's own copy
  // was overruled at the callsite. The schema wins the name it announces, which
  // is the point of a server-driven form definition; the Field keeps its own
  // generic group label above it (asserted just below).
  const imageInputName = (imageInput.getAttribute("aria-labelledby") ?? "")
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
    .filter(Boolean)
    .join(" ");
  assert.equal(imageInputName, "Served Image Input",
    `a screen reader must hear the schema's own label; it heard "${imageInputName}"`);

  // Group label vs option name — the level no assertion covered, which is how
  // the option name got hoisted into the group label and shipped twice.
  assertOptionFieldLabels(imageInput, {
    groupLabel: "Image input",
    optionName: "Served Image Input",
  });

  // The option's name lives on the card's own title again, and the card renders
  // as a <label>, so the whole option is the hit target — no `for` needed, and
  // the field declines adoption because its content is a Card rather than one
  // control. What changed versus the original is the chrome: `variant="option"`
  // puts it at control elevation with a field-scale title.
  const optionTitle = document.getElementById("schema-image-input-title");
  assert.ok(optionTitle, "the option must carry its own title");
  assert.equal(
    (optionTitle.textContent ?? "").trim(),
    "Served Image Input",
    "the option title is what names the control",
  );
  assert.ok(
    optionTitle.closest('[data-slot="card"]'),
    "the option must be a Card — that is what makes the whole row clickable and gives it the option chrome",
  );
  assert.equal(imageInput.getAttribute("aria-checked"), "false");
  fireEvent.click(imageInput);
  assert.equal(imageInput.getAttribute("aria-checked"), "true");

  await chooseProvider("Server DeepSeek");
  assert.equal(screen.queryByTestId("schema-runtime-supports-image-input"), null);
  await chooseProvider("Server Gateway");
  const resetImageInput = await screen.findByTestId("schema-runtime-supports-image-input");
  assert.equal(resetImageInput.getAttribute("aria-checked"), "false");
  fireEvent.click(resetImageInput);

  fireEvent.change(screen.getByPlaceholderText("e.g. Alice"), { target: { value: "GatewayAlice" } });
  fireEvent.change(screen.getByTestId("schema-runtime-api-key"), { target: { value: "schema-gateway-secret" } });
  fireEvent.change(screen.getByTestId("schema-runtime-base-url"), { target: { value: "https://gateway.example.test/v1" } });
  fireEvent.change(screen.getByTestId("schema-runtime-custom-model"), { target: { value: "acme/vision" } });
  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));

  await waitFor(() => assert.equal(postBodies.length, 1));
  const submitted = postBodies[0] as {
    runtimeConfig: { provider: Record<string, unknown> };
  };
  assert.deepEqual(submitted.runtimeConfig.provider, {
    kind: "gateway",
    providerId: "openai-compatible",
    baseUrl: "https://gateway.example.test/v1",
    apiKey: "schema-gateway-secret",
    supportsImageInput: true,
  });
});

test("remembered Built-in waits for the complete catalog instead of committing a legacy fallback", async () => {
  seedStores(["codex", "builtin"]);
  writeCreateAgentLastConfig("server-1", {
    machineId: "machine-1",
    runtime: "builtin",
    model: "deepseek/deepseek-v4-pro",
    customModelMode: false,
  });
  const getCalls: string[] = [];
  let releaseDefinition!: () => void;
  const definitionGate = new Promise<void>((resolve) => {
    releaseDefinition = resolve;
  });
  api.get = (async (url: string) => {
    if (url === "/provider-connections") return { data: { connections: [] } } as never;
    getCalls.push(url);
    if (url.endsWith("/runtime-options")) {
      return {
        data: {
          context: "new_agent",
          machineId: "machine-1",
          options: [runtimeOption("codex"), runtimeOption("builtin", ref)],
        },
      } as never;
    }
    if (url.includes("/runtime-form-definitions/builtin/option-sources/provider?schemaVersion=builtin-pi.create.v2")) {
      return { data: definitionFixture().optionSources.provider } as never;
    }
    if (url.includes("/runtime-form-definitions/builtin/option-sources/model?schemaVersion=builtin-pi.create.v2")) {
      return { data: definitionFixture().optionSources.model } as never;
    }
    if (url.includes("/runtime-form-definitions/builtin?schemaVersion=builtin-pi.create.v2")) {
      await definitionGate;
      return { data: definitionResponse() } as never;
    }
    if (url.includes("/runtime-models/")) return { data: { models: [] } } as never;
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;

  renderDialog();

  await waitFor(() => {
    assert.equal(getCalls.filter((url) => url.includes("/runtime-form-definitions/builtin?")).length, 1);
  });
  const runtimeSelect = screen.getAllByRole("combobox")[1];
  assert.ok(runtimeSelect);
  assert.doesNotMatch(runtimeSelect.textContent ?? "", /Codex CLI/);
  assert.equal(screen.queryByText("Loading runtime configuration…"), null);

  releaseDefinition();
  await waitFor(() => {
    assert.match(runtimeSelect.textContent ?? "", /Built-in Pi/);
    assert.equal(getCalls.filter((url) => url.includes("/runtime-form-definitions/")).length, 3);
  });
  assert.ok(screen.getByText("Server DeepSeek"));
  assert.ok(screen.getByTestId("schema-runtime-api-key"));
  assert.ok(screen.getAllByText("Server Model").length > 0);
  assert.equal(screen.queryByText("Loading runtime configuration…"), null);
  fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
  assert.ok(screen.getByText("Environment Variables"));

  const requestCountBeforeSwitch = getCalls.filter((url) => url.includes("/runtime-form-definitions/")).length;
  fireEvent.click(runtimeSelect);
  const codexOption = await screen.findByRole("option", { name: "Codex CLI" });
  fireEvent.pointerDown(codexOption);
  fireEvent.click(codexOption);
  await waitFor(() => assert.match(runtimeSelect.textContent ?? "", /Codex CLI/));
  fireEvent.click(runtimeSelect);
  const builtInOption = await screen.findByRole("option", { name: "Built-in Pi" });
  fireEvent.pointerDown(builtInOption);
  fireEvent.click(builtInOption);

  await waitFor(() => assert.match(runtimeSelect.textContent ?? "", /Built-in Pi/));
  assert.equal(
    getCalls.filter((url) => url.includes("/runtime-form-definitions/")).length,
    requestCountBeforeSwitch,
  );
  assert.equal(
    screen.getByRole("button", { name: "Advanced" }).getAttribute("aria-expanded"),
    "false",
  );
  assert.equal(screen.queryAllByText("Environment Variables").length, 0);
  assert.equal(screen.queryByText("Loading runtime configuration…"), null);
});

test("dialog preloads Built-in definition sources before selection and runtime switching is request-free", async () => {
  seedStores(["codex", "builtin"]);
  const getCalls: string[] = [];
  api.get = (async (url: string) => {
    if (url === "/provider-connections") return { data: { connections: [] } } as never;
    getCalls.push(url);
    if (url.endsWith("/runtime-options")) {
      return {
        data: {
          context: "new_agent",
          machineId: "machine-1",
          options: [runtimeOption("codex"), runtimeOption("builtin", ref)],
        },
      } as never;
    }
    if (url.includes("/runtime-form-definitions/builtin/option-sources/provider?schemaVersion=builtin-pi.create.v2")) {
      return { data: definitionFixture().optionSources.provider } as never;
    }
    if (url.includes("/runtime-form-definitions/builtin/option-sources/model?schemaVersion=builtin-pi.create.v2")) {
      return { data: definitionFixture().optionSources.model } as never;
    }
    if (url.includes("/runtime-form-definitions/builtin?schemaVersion=builtin-pi.create.v2")) {
      return { data: definitionResponse() } as never;
    }
    if (url.includes("/runtime-models/")) return { data: { models: [] } } as never;
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;

  renderDialog();

  await waitFor(() => {
    assert.equal(getCalls.filter((url) => url.includes("/runtime-form-definitions/")).length, 3);
  });
  const runtimeSelect = screen.getAllByRole("combobox")[1];
  assert.ok(runtimeSelect);
  assert.match(runtimeSelect.textContent ?? "", /Codex CLI/);
  assert.equal(screen.queryByText("Loading runtime configuration…"), null);
  const requestCountBeforeSelection = getCalls.filter((url) => url.includes("/runtime-form-definitions/")).length;

  fireEvent.click(runtimeSelect);
  const builtInOption = await screen.findByRole("option", { name: "Built-in Pi" });
  fireEvent.pointerDown(builtInOption);
  fireEvent.click(builtInOption);

  assert.ok(await screen.findByText("Server DeepSeek"));
  assert.ok(screen.getByTestId("schema-runtime-api-key"));
  assert.ok(screen.getAllByText("Server Model").length > 0);
  assert.equal(screen.queryByText("Loading runtime configuration…"), null);
  await waitFor(() => {
    assert.equal(
      getCalls.filter((url) => url.includes("/runtime-form-definitions/")).length,
      requestCountBeforeSelection,
    );
  });
});

test("changing Computer preloads only the new Computer catalog", async () => {
  seedStores(["codex", "builtin"]);
  useMachineStore.setState((state) => ({
    machines: [
      state.machines[0],
      {
        ...state.machines[0],
        id: "machine-2",
        name: "Studio",
        hostname: "studio.local",
      },
    ],
  }));
  const getCalls: string[] = [];
  api.get = (async (url: string) => {
    if (url === "/provider-connections") return { data: { connections: [] } } as never;
    getCalls.push(url);
    if (url.endsWith("/runtime-options")) {
      const machineId = url.includes("/machines/machine-2/") ? "machine-2" : "machine-1";
      return {
        data: {
          context: "new_agent",
          machineId,
          options: [runtimeOption("codex"), runtimeOption("builtin", ref)],
        },
      } as never;
    }
    if (url.includes("/runtime-form-definitions/builtin/option-sources/provider?schemaVersion=builtin-pi.create.v2")) {
      return { data: definitionFixture().optionSources.provider } as never;
    }
    if (url.includes("/runtime-form-definitions/builtin/option-sources/model?schemaVersion=builtin-pi.create.v2")) {
      return { data: definitionFixture().optionSources.model } as never;
    }
    if (url.includes("/runtime-form-definitions/builtin?schemaVersion=builtin-pi.create.v2")) {
      return { data: definitionResponse() } as never;
    }
    if (url.includes("/runtime-models/")) return { data: { models: [] } } as never;
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;

  renderDialog();
  const definitionCallsFor = (machineId: string) => getCalls.filter(
    (url) => url.includes(`/machines/${machineId}/runtime-form-definitions/`),
  ).length;
  await waitFor(() => assert.equal(definitionCallsFor("machine-1"), 3));

  const computerSelect = screen.getAllByRole("combobox")[0];
  assert.ok(computerSelect);
  fireEvent.click(computerSelect);
  const studioOption = await screen.findByRole("option", { name: "Studio (studio.local)" });
  fireEvent.pointerDown(studioOption);
  fireEvent.click(studioOption);

  await waitFor(() => assert.equal(definitionCallsFor("machine-2"), 3));
  assert.equal(definitionCallsFor("machine-1"), 3);
  const runtimeSelect = screen.getAllByRole("combobox")[1];
  fireEvent.click(runtimeSelect);
  const builtInOption = await screen.findByRole("option", { name: "Built-in Pi" });
  fireEvent.pointerDown(builtInOption);
  fireEvent.click(builtInOption);
  assert.ok(await screen.findByText("Server DeepSeek"));
  assert.equal(screen.queryByText("Loading runtime configuration…"), null);
  assert.equal(definitionCallsFor("machine-2"), 3);
  assert.equal(definitionCallsFor("machine-1"), 3);
});

for (const mode of ["malformed", "failed", "source-failed"] as const) {
  test(`malformed or failed Built-in definition stays fail-closed: ${mode}`, async () => {
    cleanup();
    seedStores(["builtin"]);
    let postCalls = 0;
    api.get = (async (url: string) => {
      if (url === "/provider-connections") return { data: { connections: [] } } as never;
      if (url.endsWith("/runtime-options")) {
        return { data: { context: "new_agent", machineId: "machine-1", options: [runtimeOption("builtin", ref)] } } as never;
      }
      if (url.includes("/runtime-form-definitions/")) {
        if (mode === "failed") throw new Error("definition unavailable");
        if (mode === "source-failed" && url.includes("/option-sources/")) {
          throw new Error("option source unavailable");
        }
        if (mode === "source-failed") return { data: definitionResponse() } as never;
        return { data: { ...definitionResponse(), protocolVersion: 2 } } as never;
      }
      if (url.includes("/runtime-models/")) return { data: { models: [] } } as never;
      throw new Error(`unexpected GET ${url}`);
    }) as typeof api.get;
    api.post = (async (url: string) => {
      if (url === "/feature-flags/evaluate") {
        return { data: { evaluations: [] } } as never;
      }
      postCalls += 1;
      throw new Error("must not submit");
    }) as typeof api.post;

    renderDialog();
    assert.ok(await screen.findByTestId("schema-runtime-unavailable"));
    fireEvent.change(screen.getByPlaceholderText("e.g. Alice"), { target: { value: "Alice" } });
    const create = screen.getByRole("button", { name: "Create Agent" }) as HTMLButtonElement;
    assert.equal(create.disabled, true);
    const form = create.closest("form");
    assert.ok(form);
    fireEvent.submit(form);
    assert.equal(postCalls, 0);
  });
}

test("a no-ref Codex row skips definition fetch and submits through the legacy path", async () => {
  seedStores(["codex"]);
  const getCalls: string[] = [];
  const postBodies: unknown[] = [];
  api.get = (async (url: string) => {
    if (url === "/provider-connections") return { data: { connections: [] } } as never;
    getCalls.push(url);
    if (url.endsWith("/runtime-options")) {
      return { data: { context: "new_agent", machineId: "machine-1", options: [runtimeOption("codex")] } } as never;
    }
    if (url.includes("/runtime-models/")) return { data: { models: [] } } as never;
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
  api.post = (async (url: string, body?: unknown) => {
    assert.equal(url, "/agents");
    postBodies.push(body);
    const request = body as { runtime: string; runtimeConfig: unknown };
    return { data: makeAgent(request.runtime, request.runtimeConfig) } as never;
  }) as typeof api.post;

  renderDialog();
  await waitFor(() => assert.ok(screen.getAllByText("Codex CLI").length > 0));
  await waitFor(() => assert.equal(getCalls.some((url) => url.includes("runtime-form-definitions")), false));
  assert.equal(screen.queryByTestId("schema-runtime-unavailable"), null);
  fireEvent.change(screen.getByPlaceholderText("e.g. Alice"), { target: { value: "Alice" } });
  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));

  await waitFor(() => assert.equal(postBodies.length, 1));
  const submitted = postBodies[0] as Record<string, unknown> & { runtimeConfig: { runtime: string } };
  assert.equal(submitted.formDefinitionRef, undefined);
  assert.equal(submitted.runtimeConfig.runtime, "codex");
});

test("managed create stays on its current surface when another agent already exists", async () => {
  seedStores(["codex"]);
  useServerStore.setState((state) => ({ current: { ...state.current!, slug: "server", plan: "pro" } }));
  useAgentStore.setState({ agents: [makeAgent("codex", { runtime: "codex" })] });
  useChannelStore.setState({
    channels: [{ id: "all-channel", name: "all" }],
  } as never);
  mockCodexCreateApi();
  let closed = false;

  renderDialog({
    initialEntry: "/s/server/channel/channel-1",
    onClose: () => { closed = true; },
  });
  await submitManagedAgent("Second");

  await waitFor(() => assert.equal(closed, true));
  assert.equal(screen.getByTestId("create-agent-location").textContent, "/s/server/channel/channel-1");
  assert.equal(useAgentStore.getState().agents.length, 2);
});

test("first managed create lands on the real all channel", async () => {
  seedStores(["codex"]);
  useServerStore.setState((state) => ({ current: { ...state.current!, slug: "server" } }));
  useChannelStore.setState({
    channels: [{ id: "all-id", name: "all" }],
  } as never);
  mockCodexCreateApi();
  let closed = false;

  renderDialog({
    initialEntry: "/s/server/channel/channel-1",
    onClose: () => { closed = true; },
  });
  await submitManagedAgent("First");

  await waitFor(() => assert.equal(closed, true));
  await waitFor(() => {
    assert.equal(screen.getByTestId("create-agent-location").textContent, "/s/server/channel/all-id");
  });
});

test("external create lands on the new agent setup route", async () => {
  seedStores(["codex"]);
  useServerStore.setState((state) => ({ current: { ...state.current!, slug: "server" } }));
  let requestBody: Record<string, unknown> | undefined;
  api.post = (async (url: string, body?: unknown) => {
    assert.equal(url, "/agents");
    requestBody = body as Record<string, unknown>;
    return {
      data: {
        ...makeAgent("external", null),
        id: "external-agent",
        machineId: null,
      },
    } as never;
  }) as typeof api.post;
  let closed = false;

  renderDialog({
    external: true,
    initialEntry: "/s/server/channel/channel-1",
    onClose: () => { closed = true; },
  });
  fireEvent.change(screen.getByPlaceholderText("e.g. Alice"), { target: { value: "External" } });
  const create = screen.getByRole("button", { name: "Create External Agent" }) as HTMLButtonElement;
  await waitFor(() => assert.equal(create.disabled, false));
  fireEvent.click(create);

  await waitFor(() => assert.equal(closed, true));
  await waitFor(() => {
    assert.equal(screen.getByTestId("create-agent-location").textContent, "/s/server/agent/external-agent");
  });
  assert.equal(requestBody?.external, true);
  assert.ok(
    requestBody !== undefined && !("externalPurpose" in requestBody),
    "ordinary External Agent create must not send an externalPurpose field",
  );
});

test("agent:create ActionCard keeps a first-agent create on the card surface", async () => {
  seedStores(["codex"]);
  useServerStore.setState((state) => ({ current: { ...state.current!, slug: "server" } }));
  useChannelStore.setState({
    channels: [
      { id: "all-id", name: "all" },
      {
        id: "source-channel",
        serverId: "server-1",
        name: "source-channel",
        type: "channel",
        joined: true,
        archivedAt: null,
      },
    ],
  } as never);
  const messageId = "action-card-message";
  const channelId = "source-channel";
  const metadata = {
    kind: "action-card",
    state: "prepared",
    action: {
      type: "agent:create",
      name: "Guided",
    },
  } as const;
  useMessageStore.setState({
    currentChannelId: channelId,
    channelMessages: {
      [channelId]: [{
        id: messageId,
        channelId,
        senderType: "agent",
        senderId: "guide-agent",
        content: "",
        createdAt: "2026-08-20T00:00:00.000Z",
        actionMetadata: metadata,
      }],
    },
    messages: [{
      id: messageId,
      channelId,
      senderType: "agent",
      senderId: "guide-agent",
      content: "",
      createdAt: "2026-08-20T00:00:00.000Z",
      actionMetadata: metadata,
    }],
  } as never);
  const postCalls: string[] = [];
  api.get = (async (url: string) => {
    if (url === "/provider-connections") return { data: { connections: [] } } as never;
    if (url.endsWith("/runtime-options")) {
      return { data: { context: "new_agent", machineId: "machine-1", options: [runtimeOption("codex")] } } as never;
    }
    if (url.includes("/runtime-models/")) return { data: { models: [] } } as never;
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
  api.post = (async (url: string, body?: unknown) => {
    postCalls.push(url);
    if (url === "/agents") {
      const request = body as { runtime: string; runtimeConfig: unknown };
      return { data: { ...makeAgent(request.runtime, request.runtimeConfig), id: "guided-agent" } } as never;
    }
    if (url === `/actions/${messageId}/mark-executed`) {
      return {
        data: {
          messageId,
          metadata: {
            ...metadata,
            state: "executed",
            result: { kind: "agent", id: "guided-agent", name: "Guided" },
          },
        },
      } as never;
    }
    if (url === `/actions/${messageId}/event`) return { data: {} } as never;
    throw new Error(`unexpected POST ${url}`);
  }) as typeof api.post;

  render(
    <MemoryRouter initialEntries={["/s/server/channel/channel-1"]}>
      <LocationProbe />
      <ActionCard
        messageId={messageId}
        channelId={channelId}
        metadata={metadata as never}
      />
    </MemoryRouter>,
  );

  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
  await waitFor(() => assert.ok(screen.getAllByText("Codex CLI").length > 0));
  const createButtons = screen.getAllByRole("button", { name: "Create Agent" });
  const submit = createButtons.find((button) => button.closest("form")) as HTMLButtonElement | undefined;
  assert.ok(submit);
  await waitFor(() => assert.equal(submit.disabled, false));
  fireEvent.click(submit);

  await waitFor(() => assert.ok(postCalls.includes(`/actions/${messageId}/mark-executed`)));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.ok(postCalls.includes("/agents"));
  assert.equal(screen.getByTestId("create-agent-location").textContent, "/s/server/channel/channel-1");
});
