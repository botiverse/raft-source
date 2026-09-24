import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import "./helpers/domSetup";
import { TestIntlProvider } from "./helpers/intl";
import AgentDetailPanel from "../src/components/agent/AgentDetailPanel";
import api from "../src/api/client";
import {
  KIMI_SDK_FORM_DEFINITION_REF,
  PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY,
} from "@botiverse/raft-shared";
import type {
  ResolvedAgentCreateFormDefinition,
  RuntimeFormDefinitionRef,
} from "@botiverse/raft-shared";
import {
  resetServerFeatureFlagsForTests,
  setServerFeatureFlagForTests,
} from "../src/store/serverFeatureFlags";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMachineStore } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";

// task #22 behavior tooth. Selecting a saved Provider connection means the credential
// comes from the connection reference, so the agent-local built-in provider block must
// not render at all. A regex over the source cannot see this: it stays green when the
// prop is never passed down the edit path, when a default flips to true, or when the
// condition is inverted. This renders the real edit dialog instead.
const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const originalGet = api.get.bind(api);
const originalPost = api.post.bind(api);
const originalPatch = api.patch.bind(api);
const noop = () => undefined;
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

function connectedAgent(useConnection: boolean) {
  return {
    id: "agent-1",
    name: "witty",
    runtime: "builtin",
    status: "active",
    machineId: "machine-1",
    runtimeConfig: {
      version: 1,
      runtime: "builtin",
      provider: useConnection
        ? { kind: "connection", connectionId: CONNECTION_ID }
        : { kind: "preset", providerId: "deepseek", apiKey: "" },
      model: { kind: "preset", id: "deepseek-v4-pro" },
      mode: { kind: "default" },
      reasoningEffort: null,
    },
  };
}

function seed(agent: Record<string, unknown>, machineName = "m") {
  useAuthStore.setState({ user: { id: "user-1", name: "Owner" } } as never);
  useServerStore.setState({
    current: { id: "server-1", slug: "s", name: "S", role: "owner" },
    members: [],
  } as never);
  useMachineStore.setState({ machines: [{ id: "machine-1", name: machineName, status: "online" }] } as never);
  useChannelStore.setState({ openDM: noop } as never);
  useAgentStore.setState({ agents: [agent], activityLogs: {}, agentActivities: {} } as never);

  // `useProviderConnections` reads the feature flag from the serverFeatureFlags
  // STORE, not from the evaluate endpoint — stubbing `api.post` alone leaves the
  // catalog disabled, and the provider-connection select then never renders at
  // all. That is why it sat outside every assertion here until now.
  setServerFeatureFlagForTests("server-1", PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY, true);

  api.post = (async (url: string) =>
    url === "/feature-flags/evaluate"
      ? { data: { flags: { provider_connections_v0: { enabled: true } } } }
      : { data: {} }) as never;
  api.get = (async (url: string) =>
    url === "/provider-connections"
      ? {
          data: {
            connections: [{
              id: CONNECTION_ID, name: "ds official api", providerId: "deepseek",
              authMethod: "api_key", endpointUrl: null, supportsImageInput: false,
              enabled: true, status: "ready", configVersion: 1, credentialVersion: 1,
            }],
            providerOptions: [{ providerId: "deepseek", label: "DeepSeek", authMethods: ["api_key"] }],
          },
        }
      : { data: {} }) as never;
}

async function openRuntimeEditor(useConnection: boolean) {
  const agent = connectedAgent(useConnection);
  seed(agent);
  render(
    <MemoryRouter>
      <TestIntlProvider locale="en">
        <AgentDetailPanel agent={agent as never} />
      </TestIntlProvider>
    </MemoryRouter>,
  );
  const opener = await waitFor(() => {
    const el = document.querySelector('[title="Edit runtime config"]');
    assert.ok(el, "runtime-config edit control not found");
    return el as HTMLElement;
  });
  fireEvent.click(opener);
  await waitFor(() => assert.ok(document.querySelector('[class*="card-brutal"]'), "dialog did not open"));
}

afterEach(() => {
  cleanup();
  resetServerFeatureFlagsForTests();
  api.get = originalGet;
  api.post = originalPost;
  api.patch = originalPatch;
  useAgentStore.setState({ agents: [], activityLogs: {}, agentActivities: {} } as never);
  useServerStore.setState({ current: null, members: [] } as never);
  useAuthStore.setState({ user: null } as never);
});

test("connection mode hides the agent-local API key field and its required error", async () => {
  await openRuntimeEditor(true);
  await waitFor(() => {
    assert.equal(screen.queryAllByPlaceholderText("sk-...").length, 0,
      "a saved connection supplies the credential — no agent-local key field may render");
  });
  assert.equal(screen.queryAllByText(/needs an API key/i).length, 0,
    "the required-key error must not render while a connection is selected");
});

test("agent-local mode still renders the API key field", async () => {
  await openRuntimeEditor(false);
  await waitFor(() => {
    assert.ok(screen.queryAllByPlaceholderText("sk-...").length > 0,
      "without a connection the agent-local key field must still render");
  });
});

test("Kimi edit preserves an incompatible value as read-only and cannot write effort without model metadata", async () => {
  const agent = {
    id: "agent-1",
    name: "kimi",
    runtime: "kimi-sdk",
    status: "inactive",
    machineId: "machine-1",
    reasoningEffort: null,
    runtimeConfig: {
      version: 1,
      runtime: "kimi-sdk",
      provider: { kind: "default" },
      model: { kind: "preset", id: "kimi-code/k3" },
      mode: { kind: "default" },
      reasoningEffort: "legacy-effort",
      envVars: null,
    },
  };
  seed(agent);
  useMachineStore.setState((state) => ({
    machines: state.machines.map((machine) => ({ ...machine, runtimes: ["kimi-sdk"] })),
  }));
  const patches: Array<Record<string, unknown>> = [];
  api.get = (async (url: string) => {
    if (url === "/provider-connections") return { data: { connections: [] } } as never;
    if (url === "/agents/agent-1/runtime-options") {
      return {
        data: {
          context: "existing_agent",
          machineId: "machine-1",
          options: [{
            runtimeId: "kimi-sdk",
            capabilityStatus: "available",
            admissionStatus: "available_for_new",
            admissionReason: null,
            current: true,
            availableForNew: true,
            manageableForCurrentAgent: true,
            canSelectInThisContext: true,
            formDefinitionRef: kimiRef,
          }],
        },
      } as never;
    }
    if (url.includes("/runtime-form-definitions/kimi-sdk/option-sources/model?schemaVersion=")) {
      return { data: kimiDefinitionFixture().optionSources.model } as never;
    }
    if (url.includes("/runtime-form-definitions/kimi-sdk?schemaVersion=")) {
      return { data: kimiDefinitionResponse() } as never;
    }
    if (url.includes("/runtime-models/kimi-sdk")) {
      return {
        data: {
          models: [
            { id: "kimi-code/k3", label: "Kimi K3" },
            { id: "kimi-code/k2", label: "Kimi K2" },
          ],
          default: "kimi-code/k3",
        },
      } as never;
    }
    return { data: { reminders: [] } } as never;
  }) as typeof api.get;
  api.patch = (async (url: string, body?: unknown) => {
    assert.equal(url, "/agents/agent-1");
    patches.push(body as Record<string, unknown>);
    return { data: { ...agent, ...(body as Record<string, unknown>) } } as never;
  }) as typeof api.patch;

  render(
    <MemoryRouter>
      <TestIntlProvider locale="en">
        <AgentDetailPanel agent={agent as never} />
      </TestIntlProvider>
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByTitle("Edit runtime config"));

  const modelSelect = await screen.findByTestId("schema-runtime-model-select");
  const incompatibleEffort = await screen.findByTestId("schema-runtime-reasoning-select");
  assert.match(incompatibleEffort.textContent ?? "", /legacy-effort/);
  fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
  fireEvent.click(screen.getByRole("button", { name: "Add Variable" }));
  fireEvent.change(screen.getByPlaceholderText("KEY"), { target: { value: "UNCHANGED_EFFORT_PROBE" } });
  fireEvent.change(screen.getByPlaceholderText("value"), { target: { value: "1" } });
  const saveButton = screen.getByRole("button", { name: "Save runtime config" }) as HTMLButtonElement;
  assert.equal(saveButton.disabled, true, "an incompatible persisted effort is display-only");

  fireEvent.click(modelSelect);
  const k2Option = await screen.findByRole("option", { name: "Kimi K2" });
  fireEvent.pointerDown(k2Option);
  fireEvent.click(k2Option);
  await waitFor(() => assert.equal(screen.queryByTestId("schema-runtime-reasoning-select"), null));
  await waitFor(() => assert.equal(saveButton.disabled, false));
  fireEvent.click(saveButton);

  await waitFor(() => assert.equal(patches.length, 1));
  const submitted = patches[0] as {
    formDefinitionRef?: RuntimeFormDefinitionRef;
    reasoningEffort?: unknown;
    runtimeConfig?: { model?: { id?: string }; reasoningEffort?: unknown };
  };
  assert.deepEqual(submitted.formDefinitionRef, kimiRef);
  assert.equal(submitted.reasoningEffort, null);
  assert.equal(submitted.runtimeConfig?.model?.id, "kimi-code/k2");
  assert.equal(submitted.runtimeConfig?.reasoningEffort, null,
    "a model without effort metadata cannot receive a newly written effort");
});

test("Kimi edit without a schema ref preserves open effort ownership across safe and model-changing edits", async () => {
  const agent = {
    id: "agent-1",
    name: "legacy-kimi-open-effort",
    runtime: "kimi-sdk",
    status: "inactive",
    machineId: "machine-1",
    reasoningEffort: null,
    runtimeConfig: {
      version: 1,
      runtime: "kimi-sdk",
      model: { kind: "preset", id: "kimi-code/k3" },
      mode: { kind: "default" },
      reasoningEffort: "balanced-plus",
      envVars: null,
    },
  };
  seed(agent);
  useMachineStore.setState((state) => ({
    machines: state.machines.map((machine) => ({ ...machine, runtimes: ["kimi-sdk"] })),
  }));
  const patches: unknown[] = [];
  api.get = (async (url: string) => {
    if (url === "/provider-connections") return { data: { connections: [] } } as never;
    if (url === "/agents/agent-1/runtime-options") {
      return {
        data: {
          context: "existing_agent",
          machineId: "machine-1",
          options: [{
            runtimeId: "kimi-sdk",
            capabilityStatus: "available",
            admissionStatus: "available_for_new",
            admissionReason: null,
            current: true,
            availableForNew: true,
            manageableForCurrentAgent: true,
            canSelectInThisContext: true,
          }],
        },
      } as never;
    }
    if (url.includes("/runtime-models/kimi-sdk")) {
      return {
        data: {
          default: "kimi-code/k3",
          models: [
            {
              id: "kimi-code/k3",
              label: "Kimi K3",
              supportedReasoningEfforts: ["balanced-plus"],
            },
            { id: "kimi-code/k2", label: "Kimi K2" },
          ],
        },
      } as never;
    }
    return { data: { reminders: [] } } as never;
  }) as typeof api.get;
  api.patch = (async (_url: string, body?: unknown) => {
    patches.push(body);
    return { data: agent } as never;
  }) as typeof api.patch;

  render(
    <MemoryRouter>
      <TestIntlProvider locale="en">
        <AgentDetailPanel agent={agent as never} />
      </TestIntlProvider>
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByTitle("Edit runtime config"));
  assert.equal(screen.queryByTestId("schema-runtime-reasoning-select"), null);
  assert.equal(screen.queryByTestId("runtime-reasoning-select"), null);
  assert.equal(screen.queryByTestId("kimi-reasoning-upgrade-required"), null);

  const modelSelect = screen.getByRole("combobox", { name: "Model" });
  fireEvent.click(modelSelect);
  const k2Option = await screen.findByRole("option", { name: "Kimi K2" });
  fireEvent.pointerDown(k2Option);
  fireEvent.click(k2Option);
  assert.ok(await screen.findByTestId("kimi-reasoning-upgrade-required"));
  const saveButton = screen.getByRole("button", { name: "Save runtime config" }) as HTMLButtonElement;
  assert.equal(saveButton.disabled, true, "a no-schema client cannot reselect a model carrying an open effort");

  fireEvent.click(modelSelect);
  const k3Option = await screen.findByRole("option", { name: "Kimi K3" });
  fireEvent.pointerDown(k3Option);
  fireEvent.click(k3Option);
  await waitFor(() => assert.equal(screen.queryByTestId("kimi-reasoning-upgrade-required"), null));

  // One disclosure now: env vars sit directly inside More. (The schema-driven
  // path keeps its own "Advanced", which is a separate control.)
  fireEvent.click(screen.getByRole("button", { name: "More" }));
  fireEvent.click(screen.getByRole("button", { name: "Add Variable" }));
  fireEvent.change(screen.getByPlaceholderText("KEY"), { target: { value: "SAFE_EDIT_PROBE" } });
  fireEvent.change(screen.getByPlaceholderText("value"), { target: { value: "1" } });
  assert.equal(saveButton.disabled, false);
  fireEvent.click(saveButton);
  await waitFor(() => assert.equal(patches.length, 1));
  const submitted = patches[0] as { reasoningEffort?: unknown; runtimeConfig?: Record<string, unknown> };
  assert.equal(submitted.reasoningEffort, undefined);
  assert.equal(Object.hasOwn(submitted.runtimeConfig ?? {}, "reasoningEffort"), false);
});

test("Kimi edit without a schema ref omits effort when no open value needs protection", async () => {
  const agent = {
    id: "agent-1",
    name: "legacy-kimi-default-effort",
    runtime: "kimi-sdk",
    status: "inactive",
    machineId: "machine-1",
    reasoningEffort: null,
    runtimeConfig: {
      version: 1,
      runtime: "kimi-sdk",
      model: { kind: "preset", id: "kimi-code/k3" },
      mode: { kind: "default" },
      reasoningEffort: null,
      envVars: null,
    },
  };
  seed(agent);
  useMachineStore.setState((state) => ({
    machines: state.machines.map((machine) => ({ ...machine, runtimes: ["kimi-sdk"] })),
  }));
  const patches: Array<Record<string, unknown>> = [];
  api.get = (async (url: string) => {
    if (url === "/provider-connections") return { data: { connections: [] } } as never;
    if (url === "/agents/agent-1/runtime-options") {
      return {
        data: {
          context: "existing_agent",
          machineId: "machine-1",
          options: [{
            runtimeId: "kimi-sdk",
            capabilityStatus: "available",
            admissionStatus: "available_for_new",
            admissionReason: null,
            current: true,
            availableForNew: true,
            manageableForCurrentAgent: true,
            canSelectInThisContext: true,
          }],
        },
      } as never;
    }
    if (url.includes("/runtime-models/kimi-sdk")) {
      return {
        data: {
          default: "kimi-code/k3",
          models: [{ id: "kimi-code/k3", label: "Kimi K3" }],
        },
      } as never;
    }
    return { data: { reminders: [] } } as never;
  }) as typeof api.get;
  api.patch = (async (url: string, body?: unknown) => {
    assert.equal(url, "/agents/agent-1");
    patches.push(body as Record<string, unknown>);
    return { data: agent } as never;
  }) as typeof api.patch;

  render(
    <MemoryRouter>
      <TestIntlProvider locale="en">
        <AgentDetailPanel agent={agent as never} />
      </TestIntlProvider>
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByTitle("Edit runtime config"));
  // One disclosure now: env vars sit directly inside More. (The schema-driven
  // path keeps its own "Advanced", which is a separate control.)
  fireEvent.click(screen.getByRole("button", { name: "More" }));
  fireEvent.click(screen.getByRole("button", { name: "Add Variable" }));
  fireEvent.change(screen.getByPlaceholderText("KEY"), { target: { value: "SAFE_EDIT_PROBE" } });
  fireEvent.change(screen.getByPlaceholderText("value"), { target: { value: "1" } });
  fireEvent.click(screen.getByRole("button", { name: "Save runtime config" }));
  await waitFor(() => assert.equal(patches.length, 1));

  const submitted = patches[0] as { reasoningEffort?: unknown; runtimeConfig?: Record<string, unknown> };
  assert.equal(submitted.reasoningEffort, undefined);
  assert.equal(Object.hasOwn(submitted.runtimeConfig ?? {}, "reasoningEffort"), false);
});

/**
 * Was: "…use the modal-local input sizing contract", selecting on
 * `.runtime-config-select-trigger`.
 *
 * That class was a stylesheet override holding raft-ui's own trigger contract
 * down with `!important` to preserve the pre-migration 40px look on this page
 * while Create Agent moved to 32px. Retiring the legacy arm deleted it, so the
 * old selector now matches nothing — and a test that selects nothing passes its
 * loop vacuously. Rewritten to pin what replaced it: Edit Agent's selects are on
 * the SAME field chrome as Create Agent's, which is the whole point of the
 * migration and the thing that would silently regress if a callsite dropped it.
 */
test("runtime config selects render on the field chrome, like Create Agent", async () => {
  await openRuntimeEditor(true);
  // Asserted on the TRIGGER, not the Select root: raft-ui's root renders no DOM
  // of its own, so `chrome` never appears as an attribute anywhere. It arrives
  // through context and shows up as the trigger's metric classes.
  const triggers = await waitFor(() => {
    const rendered = Array.from(document.querySelectorAll<HTMLElement>('[role="combobox"]'));
    assert.ok(rendered.length > 0, "the runtime config dialog must render select triggers");
    return rendered;
  });

  for (const trigger of triggers) {
    assert.match(
      trigger.className,
      /(?:^| )text-field(?: |$)/,
      "every runtime-config trigger must carry the field type contract — default chrome is BUTTON metrics (h-8/text-sm/font-bold), which is exactly what made Edit Agent measure differently from Create Agent",
    );
    assert.match(
      trigger.className,
      /(?:^| )font-field(?: |$)/,
      "…including weight: the old override had to fight this with a `* { font-weight: inherit !important }` descendant rule",
    );
    assert.match(
      trigger.className,
      /(?:^| )w-full(?: |$)/,
      "the trigger still spans the field",
    );
  }

  assert.equal(
    document.querySelectorAll(".runtime-config-select-trigger").length,
    0,
    "the legacy override class must not come back — it pinned this page to 40px with !important",
  );
});

test("agent Computer row separates a long wrapping machine name from its metadata", async () => {
  const machineName = "this-is-a-very-long-computer-name-that-must-wrap-without-crushing-status-metadata";
  const agent = connectedAgent(false);
  seed(agent, machineName);
  render(
    <MemoryRouter>
      <TestIntlProvider locale="en">
        <AgentDetailPanel agent={agent as never} />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  const nameButton = screen.getByRole("button", { name: machineName });
  const row = nameButton.parentElement;
  assert.ok(row);
  const metadata = nameButton.nextElementSibling as HTMLElement | null;
  assert.ok(metadata, "Computer metadata must render as a sibling after the machine name");
  assert.equal(row.children.length, 2);
  assert.match(row.className, /(?:^| )min-w-0(?: |$)/);
  assert.match(row.className, /(?:^| )space-y-1\.5(?: |$)/);
  assert.match(nameButton.className, /(?:^| )block(?: |$)/);
  assert.match(nameButton.className, /(?:^| )break-all(?: |$)/);
  assert.match(metadata.className, /(?:^| )flex-wrap(?: |$)/);
  assert.match(metadata.textContent ?? "", /Connected.*online/i);
});

/**
 * The provider-connection select stays OUTSIDE RuntimeConfigFields — it chooses
 * which saved connection to use and toggles the runtime fields beneath it, so it
 * is an upper-level switch, not a sibling field. But its appearance must match
 * theirs (@cindyz, task #28: "可以不在 runtimeConfigFields 里，但是 ui 应该保持一致").
 *
 * That requirement needs a guard precisely BECAUSE the split is deliberate. The
 * two used to match for a reason that no longer exists: both inherited one
 * global `.runtime-config-select-trigger` override. Retiring the legacy chrome
 * deleted it, so nothing structural holds them together — a future change to
 * RuntimeConfigFields' chrome would leave this select behind silently.
 *
 * Compared against a live sibling rather than against hardcoded class names, so
 * the assertion tracks whatever the runtime fields use rather than a copy of it
 * that can go stale.
 */
test("the provider-connection select matches the runtime fields it sits above", async () => {
  await openRuntimeEditor(true);

  const connectionTrigger = await waitFor(() => {
    const el = document.querySelector<HTMLElement>('[data-testid="edit-agent-provider-connection"]');
    assert.ok(el, "the provider-connection select must render when a connection is in use");
    return el;
  });
  const runtimeTrigger = Array.from(document.querySelectorAll<HTMLElement>('[role="combobox"]'))
    .find((el) => el !== connectionTrigger);
  assert.ok(runtimeTrigger, "a RuntimeConfigFields select must render alongside it to compare against");

  for (const metric of ["text-field", "font-field"]) {
    const pattern = new RegExp(`(?:^| )${metric}(?: |$)`);
    assert.match(
      runtimeTrigger.className,
      pattern,
      `precondition: the runtime select carries ${metric}`,
    );
    assert.match(
      connectionTrigger.className,
      pattern,
      `the provider-connection select must carry ${metric} too — it is separate code, so nothing makes it follow the runtime fields automatically`,
    );
  }
});
