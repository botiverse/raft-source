import "./helpers/domSetup";

import assert from "node:assert/strict";
import { assertOptionFieldLabels } from "./helpers/optionFieldLabels";

import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { AGENT_MIGRATION_FEATURE_FLAG_KEY, AGENT_MIGRATION_STATES, getStaticRuntimeModelSourceSet } from "@botiverse/raft-shared";
import type { RuntimeSelectionOption } from "@botiverse/raft-shared";
import api from "../src/api/client";
import { REGISTERED_SERVER_FEATURE_FLAG_KEYS } from "../src/store/serverFeatureFlags";
import AgentDetailPanel from "../src/components/agent/AgentDetailPanel";
import type { Locale } from "../src/i18n/locale";
import type { Agent } from "../src/store/agentStore";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMachineStore } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";
import { useThreadStore } from "../src/store/threadStore";
import { TestIntlProvider } from "./helpers/intl";

const originalPost = api.post.bind(api);
const originalGet = api.get.bind(api);
const originalPatch = api.patch.bind(api);
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

afterEach(() => {
  cleanup();
  api.post = originalPost;
  api.get = originalGet;
  api.patch = originalPatch;
  useAgentStore.setState({ agents: [], activityLogs: {}, agentActivities: {} });
  useChannelStore.setState({ channels: [], dmChannels: [], loading: true });
  useMachineStore.setState({ machines: [], loading: false });
  useServerStore.setState({
    current: null,
    members: [],
    billing: null,
    loadingBilling: false,
    sidebarOrder: {
      channelOrder: [],
      agentOrder: [],
      dmOrder: [],
      channelSortMode: "manual",
      jointChannelSortMode: "manual",
      dmSortMode: "manual",
      pinnedSortMode: "manual",
      pinnedChannelIds: [],
      pinnedAgentIds: [],
      pinnedOrder: [],
      hiddenDmIds: [],
      channelPanelTabOrder: [],
      agentPanelTabOrder: [],
      pinnedVersion: 0,
    },
  });
  useAuthStore.setState({ user: null });
  useThreadStore.setState({ threads: {} });
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    serverId: "server-1",
    name: "migration-agent",
    displayName: "Migration Agent",
    avatarUrl: null,
    description: null,
    status: "offline",
    model: "gpt-5",
    runtime: "codex",
    external: false,
    serverRole: null,
    runtimeConfig: null,
    lastRuntimeError: null,
    reasoningEffort: null,
    executionMode: "cloud",
    envVars: null,
    machineId: "source-machine",
    creatorType: null,
    creatorId: null,
    creator: null,
    createdAgents: [],
    deletedAt: null,
    createdAt: "2026-07-09T00:00:00.000Z",
    ...overrides,
  };
}

function seedPanelState(serverId: string, agent: Agent = makeAgent({ serverId })) {
  useAuthStore.setState({
    user: {
      id: "owner-user",
      email: "owner@example.com",
      gravatarHash: "",
      name: "owner",
      displayName: "Owner",
      description: null,
      avatarUrl: null,
      emailVerified: true,
      preferredLanguage: null,
      preferredTimezone: null,
      autoTranslationEnabled: false,
      preferredTranslationDisplay: "original",
      preferredTimeFormat: null,
      preferredMessageBodyFontSize: null,
      referralSource: null,
      referralSourceOther: null,
      referralSourceSkippedAt: null,
    },
  });
  useServerStore.setState({
    current: {
      id: serverId,
      name: "Botiverse",
      avatarUrl: null,
      slug: "botiverse",
      ownerId: "owner-user",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "team",
      planDowngradedAt: null,
      role: "owner",
      createdAt: "2026-07-09T00:00:00.000Z",
    },
    members: [{
      userId: "owner-user",
      email: "owner@example.com",
      gravatarHash: "",
      name: "owner",
      displayName: "Owner",
      description: null,
      avatarUrl: null,
      role: "owner",
      joinedAt: "2026-07-09T00:00:00.000Z",
    }],
    sidebarOrder: {
      channelOrder: [],
      agentOrder: [],
      dmOrder: [],
      channelSortMode: "manual",
      jointChannelSortMode: "manual",
      dmSortMode: "manual",
      pinnedSortMode: "manual",
      pinnedChannelIds: [],
      pinnedAgentIds: [],
      pinnedOrder: [],
      hiddenDmIds: [],
      channelPanelTabOrder: [],
      agentPanelTabOrder: [],
      pinnedVersion: 0,
    },
  });
  useMachineStore.setState({
    machines: [
      {
        id: "source-machine",
        name: "Source Computer",
        description: null,
        status: "online",
        statusVersion: 1,
        apiKeyPrefix: null,
        runtimes: [],
        hostname: null,
        os: null,
        daemonVersion: null,
        isComputer: true,
        computerUpgradeAvailable: false,
        lastHeartbeat: null,
        createdAt: "2026-07-09T00:00:00.000Z",
      },
      {
        id: "target-machine",
        name: "Target Computer",
        description: null,
        status: "online",
        statusVersion: 1,
        apiKeyPrefix: null,
        runtimes: [],
        hostname: null,
        os: null,
        daemonVersion: null,
        isComputer: true,
        computerUpgradeAvailable: false,
        lastHeartbeat: null,
        createdAt: "2026-07-09T00:00:00.000Z",
      },
    ],
    loading: false,
  });
  useAgentStore.setState({ agents: [agent], activityLogs: {}, agentActivities: {} });
  return agent;
}

function LocationProbe() {
  const location = useLocation();
  return (
    <>
      <output data-testid="location">{location.pathname}</output>
      <output data-testid="location-search">{location.search}</output>
    </>
  );
}

function renderPanel(agent: Agent, locale: Locale = "en") {
  return render(
    <TestIntlProvider locale={locale}>
      <MemoryRouter initialEntries={["/s/botiverse/agent/agent-1"]}>
        <AgentDetailPanel agent={agent} />
        <LocationProbe />
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

function stubAgentMigrationStatus(
  migration: unknown = null,
  billingPlanOrModelPayload: unknown = "pro",
  explicitModelPayload?: unknown,
) {
  const billingPlan = typeof billingPlanOrModelPayload === "string"
    ? billingPlanOrModelPayload
    : "pro";
  const modelPayload = typeof billingPlanOrModelPayload === "string"
    ? explicitModelPayload
    : billingPlanOrModelPayload;
  api.get = async (url: string) => {
    if (url === "/agents/agent-1/runtime-options") {
      const agent = useAgentStore.getState().agents.find((candidate) => candidate.id === "agent-1");
      const machine = useMachineStore.getState().machines.find((candidate) => candidate.id === agent?.machineId);
      const runtimeId = agent?.runtime ?? "codex";
      const capabilityAvailable = machine?.runtimes.includes(runtimeId) === true;
      const admissionReason = runtimeId === "grok"
        ? "feature_flag_off" as const
        : runtimeId === "kimi" || runtimeId === "gemini"
          ? "deprecated" as const
          : null;
      const option: RuntimeSelectionOption = {
        runtimeId,
        capabilityStatus: capabilityAvailable ? "available" : "not_installed",
        admissionStatus: admissionReason ? "grandfathered_current" : "available_for_new",
        admissionReason,
        current: true,
        availableForNew: admissionReason === null,
        manageableForCurrentAgent: capabilityAvailable,
        canSelectInThisContext: capabilityAvailable,
      };
      return {
        data: {
          context: "existing_agent",
          machineId: machine?.id ?? null,
          options: [option],
        },
      } as never;
    }
    if (url === "/agents/agent-1/migration") {
      return { data: { migration } } as never;
    }
    if (url === "/billing/subscription") {
      return {
        data: {
          plan: billingPlan,
          displayName: billingPlan === "free" ? "Free" : "Pro",
          serverPlan: billingPlan,
          source: "server",
          capacity: {
            maxHumans: 3,
            maxAgents: 3,
            maxUniversalSeats: 0,
          },
          usage: {
            humans: 1,
            agents: 1,
            universalSeats: 0,
          },
          provisioned: {
            humans: 1,
            agents: 1,
            proPackQuantity: 0,
            trialFreePackQuantity: 0,
          },
          price: null,
          subscription: null,
          stripeConfigured: true,
          permissions: {
            canReadBillingSummary: true,
            canManageBilling: true,
          },
        },
      } as never;
    }
    if (url.includes("/runtime-models/") && modelPayload !== undefined) {
      return { data: modelPayload } as never;
    }
    if (url.includes("/runtime-models/")) {
      const staticSource = getStaticRuntimeModelSourceSet(url.split("/").at(-1) ?? "");
      if (staticSource) {
        return { data: { kind: "live", value: staticSource } } as never;
      }
    }
    return { data: { reminders: [] } } as never;
  };
}

function stubMigrationFeatureFlag(serverId: string) {
  api.post = async (url: string, body?: unknown) => {
    if (url === "/feature-flags/evaluate") {
      assert.deepEqual(body, {
        serverId,
        platform: "web",
        keys: REGISTERED_SERVER_FEATURE_FLAG_KEYS,
      });
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: true }] } } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };
}

test("agent reminders do not refetch when only the locale changes", async () => {
  const agent = seedPanelState("server-reminder-locale");
  stubAgentMigrationStatus();
  const fallbackGet = api.get;
  let reminderRequests = 0;
  api.get = async (url: string, ...args: unknown[]) => {
    if (url === "/reminders") {
      reminderRequests += 1;
    }
    return fallbackGet(url, ...args);
  };
  stubMigrationFeatureFlag("server-reminder-locale");

  function PanelWithLocale({ locale }: { locale: Locale }) {
    return (
      <TestIntlProvider locale={locale}>
        <MemoryRouter initialEntries={["/s/botiverse/agent/agent-1"]}>
          <AgentDetailPanel agent={agent} />
          <LocationProbe />
        </MemoryRouter>
      </TestIntlProvider>
    );
  }

  const view = render(<PanelWithLocale locale="en" />);

  await waitFor(() => assert.equal(reminderRequests, 1));

  view.rerender(<PanelWithLocale locale="zh-cn" />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  assert.equal(reminderRequests, 1);
});

test("agent detail header renders Messages as an icon-only accessible action", async () => {
  const agent = seedPanelState("server-icon-action");
  stubAgentMigrationStatus();
  api.post = async (url: string) => {
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: false }] } } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };

  renderPanel(agent);

  const messagesAction = await screen.findByRole("button", { name: "Messages" });
  assert.equal(messagesAction.textContent, "", "the header action must not render a visible text label");
  assert.ok(messagesAction.querySelector("svg"), "the header action keeps the MessageSquare icon");
});

test("official identity update sits beside Display name and requires a field-level confirmation", async () => {
  const agent = seedPanelState("server-official-identity", makeAgent({
    serverId: "server-official-identity",
    displayName: "Cindy-a",
    description: "Onboarding Assistant",
  }));
  useServerStore.setState((state) => ({
    current: state.current ? { ...state.current, onboardingAgentId: agent.id } : null,
  }));

  const preview = {
    canAdopt: true,
    changes: [
      { field: "displayName" as const, label: "Display name", before: "Cindy-a", after: "Cindy" },
      { field: "role" as const, label: "Description", before: "Onboarding Assistant", after: "Onboarding guide" },
    ],
    currentIdentity: {
      name: "migration-agent",
      displayName: "Cindy-a",
      role: "Onboarding Assistant",
      serverRole: "member",
      avatarUrl: null,
    },
    officialIdentity: {
      name: "migration-agent",
      displayName: "Cindy",
      role: "Onboarding guide",
      serverRole: "member",
      avatarUrl: null,
    },
  };
  stubAgentMigrationStatus();
  const fallbackGet = api.get;
  api.get = async (url: string) => {
    if (url === "/agents/agent-1/onboarding-identity-adoption") {
      return { data: preview } as never;
    }
    return fallbackGet(url);
  };
  let adoptionCalls = 0;
  api.post = async (url: string) => {
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: false }] } } as never;
    }
    if (url === "/agents/agent-1/onboarding-identity-adoption") {
      adoptionCalls += 1;
      return {
        data: {
          ...preview,
          canAdopt: false,
          changes: [],
          appliedChanges: preview.changes,
          agent: { ...agent, displayName: "Cindy", description: "Onboarding guide" },
        },
      } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };

  renderPanel(agent);

  const displayNameLabel = screen.getByText("Display name");
  const displayNameSection = displayNameLabel.parentElement?.parentElement;
  assert.ok(displayNameSection, "the Display name profile section should render");
  const updateAction = await within(displayNameSection).findByRole("button", {
    name: "Update official identity",
  });
  assert.equal(screen.queryByText("Official identity"), null, "identity adoption no longer creates a standalone profile section");
  assert.equal(document.body.textContent?.includes("Cindy-a -> Cindy"), false, "field changes stay out of the profile until confirmation opens");

  fireEvent.click(updateAction);

  await screen.findByRole("heading", { name: "Update official identity" });
  screen.getByText("Review official identity changes");
  const displayNameChange = document.querySelector<HTMLElement>('[data-onboarding-identity-change="displayName"]');
  const roleChange = document.querySelector<HTMLElement>('[data-onboarding-identity-change="role"]');
  assert.ok(displayNameChange);
  assert.ok(roleChange);
  assert.equal(displayNameChange.querySelector("dt")?.textContent, "Display name");
  within(displayNameChange).getByText("Cindy-a");
  within(displayNameChange).getByText("Cindy");
  assert.equal(roleChange.querySelector("dt")?.textContent, "Description");
  within(roleChange).getByText("Onboarding Assistant");
  within(roleChange).getByText("Onboarding guide");
  assert.equal(adoptionCalls, 0, "opening the field-level preview must not apply identity changes");

  fireEvent.click(screen.getByRole("button", { name: "Update identity" }));
  await waitFor(() => assert.equal(adoptionCalls, 1, "the update is sent only after explicit confirmation"));
});

test("agent detail keeps current deprecated runtime visible with warning", async () => {
  const agent = seedPanelState("server-legacy-runtime", makeAgent({
    serverId: "server-legacy-runtime",
    runtime: "antigravity",
    model: "default",
    runtimeConfig: {
      version: 1,
      runtime: "antigravity",
      model: { kind: "preset", id: "default" },
      mode: { kind: "default" },
      reasoningEffort: null,
      envVars: null,
    },
  }));
  stubAgentMigrationStatus();
  api.post = async (url: string, body?: unknown) => {
    if (url === "/feature-flags/evaluate") {
      assert.deepEqual(body, {
        serverId: "server-legacy-runtime",
        platform: "web",
        keys: REGISTERED_SERVER_FEATURE_FLAG_KEYS,
      });
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: false }] } } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };

  renderPanel(agent);

  assert.ok(screen.getByText("Antigravity CLI (deprecated)"));
  assert.ok(screen.getByText("This agent uses a deprecated runtime. It can keep running, but new agents cannot select this runtime."));

  fireEvent.click(screen.getByTitle("Edit runtime config"));

  assert.ok(await screen.findByRole("heading", { name: "Edit runtime config" }));
  assert.ok(screen.getByText("Antigravity CLI (deprecated) (not installed)"));
});

test("flag-off current Grok stays editable only while its Computer capability is available", async () => {
  const agent = seedPanelState("server-grok-grandfathered", makeAgent({
    serverId: "server-grok-grandfathered",
    runtime: "grok",
    model: "grok-4.5",
    runtimeConfig: {
      version: 1,
      runtime: "grok",
      model: { kind: "preset", id: "grok-4.5" },
      mode: { kind: "default" },
      reasoningEffort: null,
      envVars: null,
    },
  }));
  useMachineStore.setState((state) => ({
    machines: state.machines.map((machine) => machine.id === "source-machine"
      ? { ...machine, runtimes: ["grok"] }
      : machine),
  }));
  stubAgentMigrationStatus(null, {
    kind: "live",
    value: {
      models: [
        { id: "grok-4.5", label: "Grok 4.5" },
        { id: "grok-composer-2.5-fast", label: "Composer 2.5" },
      ],
      default: "grok-4.5",
    },
  });
  api.post = async (url: string) => {
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: false }] } } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };

  renderPanel(agent);
  fireEvent.click(screen.getByTitle("Edit runtime config"));

  const modelSelect = await waitFor(() => {
    const select = screen.getAllByRole("combobox")
      .find((candidate) => candidate.textContent?.includes("Grok 4.5"));
    assert.ok(select);
    return select;
  });
  fireEvent.click(modelSelect);
  const composerOption = await screen.findByRole("option", { name: "Composer 2.5" });
  fireEvent.pointerDown(composerOption);
  fireEvent.click(composerOption);

  const saveButton = screen.getByRole("button", { name: "Save runtime config" });
  await waitFor(() => assert.equal((saveButton as HTMLButtonElement).disabled, false));

  act(() => useMachineStore.setState((state) => ({
    machines: state.machines.map((machine) => machine.id === "source-machine"
      ? { ...machine, runtimes: [] }
      : machine),
  })));
  await waitFor(() => assert.equal((saveButton as HTMLButtonElement).disabled, true));
});

test("Claude runtime editor renders the canonical model list and persists an exact preset", async (t) => {
  const agent = seedPanelState("server-claude-opus-5", makeAgent({
    serverId: "server-claude-opus-5",
    runtime: "claude",
    model: "claude-opus-4-8",
    runtimeConfig: {
      version: 1,
      runtime: "claude",
      provider: { kind: "default" },
      model: { kind: "preset", id: "claude-opus-4-8" },
      mode: { kind: "default" },
      reasoningEffort: null,
      envVars: null,
    },
  }));
  useMachineStore.setState((state) => ({
    machines: state.machines.map((machine) => machine.id === "source-machine"
      ? { ...machine, runtimes: ["claude"] }
      : machine),
  }));
  stubAgentMigrationStatus();
  api.post = async (url: string) => {
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: false }] } } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };
  const patches: Array<Record<string, unknown>> = [];
  api.patch = async (url: string, body?: unknown) => {
    assert.equal(url, "/agents/agent-1");
    const patch = body as Record<string, unknown>;
    patches.push(patch);
    return { data: { ...agent, ...patch } } as never;
  };

  renderPanel(agent);
  fireEvent.click(screen.getByTitle("Edit runtime config"));

  const modelSelect = await waitFor(() => {
    const select = screen.getAllByRole("combobox")
      .find((candidate) => candidate.textContent?.includes("Claude Opus 4.8"));
    assert.ok(select);
    return select;
  });
  fireEvent.click(modelSelect);
  t.assert.snapshot(
    screen.getAllByRole("option").map((option) => option.textContent?.trim() ?? ""),
  );
  const opus5Option = await screen.findByRole("option", { name: "Claude Opus 5" });
  fireEvent.pointerDown(opus5Option);
  fireEvent.click(opus5Option);
  await waitFor(() => assert.match(modelSelect.textContent ?? "", /Claude Opus 5/));

  const saveButton = screen.getByRole("button", { name: "Save runtime config" }) as HTMLButtonElement;
  await waitFor(() => assert.equal(saveButton.disabled, false));
  fireEvent.click(saveButton);

  await waitFor(() => assert.equal(patches.length, 1));
  assert.equal(patches[0]?.model, "claude-opus-5");
  assert.deepEqual((patches[0]?.runtimeConfig as { model: unknown }).model, {
    kind: "preset",
    id: "claude-opus-5",
  });
});

test("Built-in edit can change model while omitting the redacted provider secret", async () => {
  const runtimeConfig = {
    version: 1 as const,
    runtime: "builtin" as const,
    provider: { kind: "preset" as const, providerId: "deepseek" as const, apiKey: "" },
    model: { kind: "preset" as const, id: "deepseek/deepseek-v4-pro" },
    mode: { kind: "default" as const },
    reasoningEffort: null,
    envVars: null,
    hostUserState: "forbidden" as const,
  };
  const agent = seedPanelState("server-builtin-secret-retain", makeAgent({
    serverId: "server-builtin-secret-retain",
    runtime: "builtin",
    model: "deepseek/deepseek-v4-pro",
    runtimeConfig,
  }));
  useMachineStore.setState((state) => ({
    machines: state.machines.map((machine) => machine.id === "source-machine"
      ? { ...machine, runtimes: ["builtin"] }
      : machine),
  }));
  api.get = async (url: string) => {
    if (url === "/agents/agent-1/runtime-options") {
      return {
        data: {
          context: "existing_agent",
          machineId: "source-machine",
          options: [{
            runtimeId: "builtin",
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
    if (url === "/servers/server-builtin-secret-retain/machines/source-machine/runtime-models/builtin") {
      return {
        data: {
          kind: "live",
          value: {
            models: [
              { id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro" },
              { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash" },
            ],
            default: "deepseek/deepseek-v4-pro",
            catalog: {
              protocolVersion: 1,
              runtime: "builtin",
              runtimeVersion: "0.84.3",
            },
          },
        },
      } as never;
    }
    if (url === "/agents/agent-1/migration") return { data: { migration: null } } as never;
    return { data: { reminders: [] } } as never;
  };
  api.post = async (url: string) => {
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: false }] } } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };
  const patches: unknown[] = [];
  api.patch = async (url: string, body?: unknown) => {
    assert.equal(url, "/agents/agent-1");
    patches.push(body);
    return { data: { ...agent, ...(body as Record<string, unknown>), runtimeConfig } } as never;
  };

  renderPanel(agent);
  fireEvent.click(screen.getByTitle("Edit runtime config"));

  const modelSelect = await waitFor(() => {
    const select = screen.getAllByRole("combobox")
      .find((candidate) => candidate.textContent?.includes("DeepSeek V4 Pro"));
    assert.ok(select);
    return select;
  });
  fireEvent.click(modelSelect);
  const nextModel = await screen.findByRole("option", { name: "DeepSeek V4 Flash" });
  fireEvent.pointerDown(nextModel);
  fireEvent.click(nextModel);

  const saveButton = screen.getByRole("button", { name: "Save runtime config" }) as HTMLButtonElement;
  await waitFor(() => assert.equal(saveButton.disabled, false));
  fireEvent.click(saveButton);

  await waitFor(() => assert.equal(patches.length, 1));
  const patchBody = patches[0] as {
    runtimeConfig: { provider: Record<string, unknown>; model: unknown };
  };
  assert.deepEqual(patchBody.runtimeConfig.provider, { kind: "preset", providerId: "deepseek" });
  assert.deepEqual(patchBody.runtimeConfig.model, { kind: "preset", id: "deepseek/deepseek-v4-flash" });
});

test("Built-in gateway edit retains an omitted secret only while the canonical Base URL is unchanged", async () => {
  const gatewayBaseUrl = "https://gateway.example.test/v1";
  const runtimeConfig = {
    version: 1 as const,
    runtime: "builtin" as const,
    provider: {
      kind: "gateway" as const,
      providerId: "openai-compatible" as const,
      baseUrl: gatewayBaseUrl,
      apiKey: "",
    },
    model: { kind: "custom" as const, name: "acme/custom" },
    mode: { kind: "default" as const },
    reasoningEffort: null,
    envVars: null,
    hostUserState: "forbidden" as const,
  };
  const agent = seedPanelState("server-builtin-gateway-secret", makeAgent({
    serverId: "server-builtin-gateway-secret",
    runtime: "builtin",
    model: "acme/custom",
    runtimeConfig,
  }));
  useMachineStore.setState((state) => ({
    machines: state.machines.map((machine) => machine.id === "source-machine"
      ? { ...machine, runtimes: ["builtin"] }
      : machine),
  }));
  api.get = async (url: string) => {
    if (url === "/agents/agent-1/runtime-options") {
      return {
        data: {
          context: "existing_agent",
          machineId: "source-machine",
          options: [{
            runtimeId: "builtin",
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
    if (url === "/servers/server-builtin-gateway-secret/machines/source-machine/runtime-models/builtin") {
      return { data: { models: [], default: "" } } as never;
    }
    if (url === "/agents/agent-1/migration") return { data: { migration: null } } as never;
    return { data: { reminders: [] } } as never;
  };
  api.post = async (url: string) => {
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: false }] } } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };
  const patches: Array<Record<string, unknown>> = [];
  api.patch = async (url: string, body?: unknown) => {
    assert.equal(url, "/agents/agent-1");
    const patch = body as Record<string, unknown>;
    patches.push(patch);
    const patchedRuntimeConfig = patch.runtimeConfig as {
      provider: Record<string, unknown>;
      model: unknown;
    };
    return {
      data: {
        ...agent,
        ...patch,
        runtimeConfig: {
          ...patchedRuntimeConfig,
          provider: { ...patchedRuntimeConfig.provider, apiKey: "" },
        },
      },
    } as never;
  };

  renderPanel(agent);
  fireEvent.click(screen.getByTitle("Edit runtime config"));

  const modelInput = await screen.findByPlaceholderText("Gateway model ID") as HTMLInputElement;
  fireEvent.change(modelInput, { target: { value: "acme/next" } });
  const saveButton = screen.getByRole("button", { name: "Save runtime config" }) as HTMLButtonElement;
  await waitFor(() => assert.equal(saveButton.disabled, false));
  fireEvent.click(saveButton);

  await waitFor(() => assert.equal(patches.length, 1));
  const firstRuntimeConfig = patches[0]?.runtimeConfig as {
    provider: Record<string, unknown>;
    model: unknown;
  };
  assert.deepEqual(firstRuntimeConfig.provider, {
    kind: "gateway",
    providerId: "openai-compatible",
    baseUrl: gatewayBaseUrl,
    supportsImageInput: false,
  });
  assert.deepEqual(firstRuntimeConfig.model, { kind: "custom", name: "acme/next" });

  await waitFor(() => assert.equal(screen.queryByRole("heading", { name: "Edit runtime config" }), null));
  fireEvent.click(screen.getByTitle("Edit runtime config"));
  const baseUrlInput = await screen.findByPlaceholderText("https://gateway.example.com/v1") as HTMLInputElement;
  fireEvent.change(baseUrlInput, { target: { value: "https://attacker.example.test/v1" } });
  // See the schema dialog test: raft-ui's Checkbox exposes state via aria-checked.
  const imageInput = screen.getByTestId("runtime-supports-image-input");

  // Announced by its OPTION name, not the field's group label — see the schema
  // dialog test. Asserted at the real callsite because a hand-built copy of this
  // shape stayed green through the bug.
  const imageInputName = (imageInput.getAttribute("aria-labelledby") ?? "")
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
    .filter(Boolean)
    .join(" ");
  assert.equal(imageInputName, "Supports image input",
    `a screen reader must hear the option name; it heard "${imageInputName}"`);

  // Group label vs option name — see the schema dialog test. This gateway
  // callsite regressed the same way and for the same reason.
  assertOptionFieldLabels(imageInput, {
    groupLabel: "Image input",
    optionName: "Supports image input",
  });

  // The option's name lives on the card's own title again, and the card renders
  // as a <label>, so the whole option is the hit target — no `for` needed, and
  // the field declines adoption because its content is a Card rather than one
  // control. What changed versus the original is the chrome: `variant="option"`
  // puts it at control elevation with a field-scale title.
  const optionTitle = document.getElementById("gateway-image-input-title");
  assert.ok(optionTitle, "the option must carry its own title");
  assert.equal(
    (optionTitle.textContent ?? "").trim(),
    "Supports image input",
    "the option title is what names the control",
  );
  assert.ok(
    optionTitle.closest('[data-slot="card"]'),
    "the option must be a Card — that is what makes the whole row clickable and gives it the option chrome",
  );
  assert.equal(imageInput.getAttribute("aria-checked"), "false");
  fireEvent.click(imageInput);
  assert.equal(imageInput.getAttribute("aria-checked"), "true");
  const changedUrlSaveButton = screen.getByRole("button", { name: "Save runtime config" }) as HTMLButtonElement;
  await waitFor(() => assert.equal(changedUrlSaveButton.disabled, true));

  const apiKeyInput = screen.getByPlaceholderText("sk-...") as HTMLInputElement;
  fireEvent.change(apiKeyInput, { target: { value: "replacement-secret" } });
  await waitFor(() => assert.equal(changedUrlSaveButton.disabled, false));
  fireEvent.click(changedUrlSaveButton);

  await waitFor(() => assert.equal(patches.length, 2));
  const secondRuntimeConfig = patches[1]?.runtimeConfig as {
    provider: Record<string, unknown>;
  };
  assert.deepEqual(secondRuntimeConfig.provider, {
    kind: "gateway",
    providerId: "openai-compatible",
    baseUrl: "https://attacker.example.test/v1",
    apiKey: "replacement-secret",
    supportsImageInput: true,
  });
});

test("migration profile entry is absent from the DOM while the migration flag is off", async () => {
  const agent = seedPanelState("server-flag-off");
  let evaluateCalls = 0;
  stubAgentMigrationStatus();
  api.post = async (url: string, body?: unknown) => {
    if (url === "/feature-flags/evaluate") {
      evaluateCalls += 1;
      assert.deepEqual(body, {
        serverId: "server-flag-off",
        platform: "web",
        keys: REGISTERED_SERVER_FEATURE_FLAG_KEYS,
      });
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: false }] } } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };

  renderPanel(agent);

  await waitFor(() => assert.equal(evaluateCalls, 1));
  assert.equal(
    screen.queryByRole("button", { name: "Move to another computer" }),
    null,
    "flag-off profile must not render the migration entry",
  );
});

test("migration profile entry has no progress when no migration exists", async () => {
  const agent = seedPanelState("server-idle-migration");
  stubAgentMigrationStatus();
  stubMigrationFeatureFlag("server-idle-migration");

  renderPanel(agent);

  await screen.findByRole("button", { name: "Move to another computer" });
  assert.equal(screen.queryByRole("progressbar"), null);
});

test("post-trial Free projection gates only the new migration entry and routes to billing", async () => {
  const agent = seedPanelState("server-free-migration");
  const posts: string[] = [];
  stubAgentMigrationStatus(null, "free");
  api.post = async (url: string) => {
    posts.push(url);
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: true }] } } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };

  renderPanel(agent);

  await waitFor(() => assert.equal(useServerStore.getState().billing?.plan, "free"));
  fireEvent.click(await screen.findByRole("button", { name: "Move to another computer" }));

  assert.ok(screen.getByRole("heading", { name: "Move agents with Pro" }));
  assert.ok(screen.getByText(
    "Upgrade this server to Pro to move the agent and its workspace to another Computer.",
  ));
  assert.ok(screen.getByText(
    "Existing migration status, cancellation, cleanup, and recovery stay available.",
  ));
  assert.equal(
    screen.queryByRole("heading", { name: "Move to another computer" }),
    null,
  );
  assert.equal(posts.includes("/agents/agent-1/migrate"), false);

  fireEvent.click(screen.getByRole("button", { name: "View Plan & Billing" }));
  await waitFor(() => {
    assert.equal(screen.getByTestId("location").textContent, "/s/botiverse/settings/billing");
  });
});

test("post-trial Free projection renders the migration upgrade prompt in zh-CN", async () => {
  const agent = seedPanelState("server-free-migration-zh");
  stubAgentMigrationStatus(null, "free");
  stubMigrationFeatureFlag("server-free-migration-zh");

  renderPanel(agent, "zh-cn");

  await waitFor(() => assert.equal(useServerStore.getState().billing?.plan, "free"));
  fireEvent.click(await screen.findByRole("button", { name: "迁移到另一台计算机" }));

  assert.ok(screen.getByRole("heading", { name: "使用 Pro 迁移 Agent" }));
  assert.ok(screen.getByText(
    "将此服务器升级到 Pro，即可把 Agent 及其工作区迁移到另一台 Computer。",
  ));
  assert.ok(screen.getByText(
    "现有迁移的状态、取消、清理和恢复功能仍然可用。",
  ));
  assert.ok(screen.getByRole("button", { name: "查看套餐与账单" }));
  assert.equal(screen.queryByText("Move agents with Pro"), null);
});

test("typed backend plan denial replaces the start dialog with the same upgrade prompt", async () => {
  const agent = seedPanelState("server-stale-projection");
  let startCalls = 0;
  stubAgentMigrationStatus(null, "pro");
  api.post = async (url: string) => {
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: true }] } } as never;
    }
    if (url === "/agents/agent-1/migrate") {
      startCalls += 1;
      const error = new Error("upgrade required") as Error & {
        response?: { status?: number; data?: { code?: string; error?: string } };
      };
      error.response = {
        status: 403,
        data: {
          code: "MIGRATION_PRO_PLAN_REQUIRED",
          error: "Upgrade required",
        },
      };
      throw error;
    }
    throw new Error(`unexpected POST ${url}`);
  };

  renderPanel(agent);

  await waitFor(() => assert.equal(useServerStore.getState().billing?.plan, "pro"));
  fireEvent.click(await screen.findByRole("button", { name: "Move to another computer" }));
  fireEvent.click(screen.getByRole("button", { name: "Start Migration" }));

  assert.ok(await screen.findByRole("heading", { name: "Move agents with Pro" }));
  assert.equal(startCalls, 1);
  assert.equal(
    screen.queryByRole("heading", { name: "Move to another computer" }),
    null,
  );
  assert.equal(screen.queryByText("MIGRATION_PRO_PLAN_REQUIRED"), null);
  assert.equal(screen.queryByText("Upgrade required"), null);
});

test("Free projection preserves the current active migration status", async () => {
  const agent = seedPanelState("server-free-active-migration");
  const activeMigration = {
    agentId: "agent-1",
    migrationRef: "mig_abcdefghijklmnopqrstuv",
    state: "in_transit",
    revision: 1,
    sourceMachineId: "source-machine",
    targetMachineId: "target-machine",
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:01:00.000Z",
  };
  stubAgentMigrationStatus(activeMigration, "free");
  stubMigrationFeatureFlag("server-free-active-migration");

  renderPanel(agent);

  await waitFor(() => assert.equal(useServerStore.getState().billing?.plan, "free"));
  assert.ok(screen.getByText("Transferring workspace to Target Computer."));
  assert.equal(
    (screen.getByRole("button", { name: "Migration in progress" }) as HTMLButtonElement).disabled,
    true,
  );
  assert.equal(screen.queryByRole("heading", { name: "Move agents with Pro" }), null);
});

test("migration profile entry starts migration directly without preparing an action card", async () => {
  const agent = seedPanelState("server-flag-on");
  let evaluateCalls = 0;
  let migrationStatusCalls = 0;
  const posts: Array<{ url: string; body: unknown }> = [];
  stubAgentMigrationStatus();
  const fallbackGet = api.get;
  api.get = async (url: string) => {
    if (url === "/agents/agent-1/migration") {
      migrationStatusCalls += 1;
      const migration = migrationStatusCalls === 1
        ? null
        : {
            agentId: "agent-1",
            migrationRef: "mig_abcdefghijklmnopqrstuv",
            state: "provisioning",
            revision: 1,
            sourceMachineId: "source-machine",
            targetMachineId: "target-machine",
          };
      return { data: { migration } } as never;
    }
    return fallbackGet(url);
  };
  api.post = async (url: string, body?: unknown) => {
    posts.push({ url, body });
    if (url === "/feature-flags/evaluate") {
      evaluateCalls += 1;
      assert.deepEqual(body, {
        serverId: "server-flag-on",
        platform: "web",
        keys: REGISTERED_SERVER_FEATURE_FLAG_KEYS,
      });
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: true }] } } as never;
    }
    if (url === "/agents/agent-1/migrate") {
      return {
        data: {
          migrationRef: "mig_abcdefghijklmnopqrstuv",
          state: "provisioning",
          sourceMachineId: "source-machine",
          targetMachineId: "target-machine",
          deadlines: {
            prepDeadlineAt: "2026-07-09T01:00:00.000Z",
          },
        },
      } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };

  renderPanel(agent);

  await waitFor(() => assert.equal(evaluateCalls, 1));
  const entry = await screen.findByRole("button", { name: "Move to another computer" });
  fireEvent.click(entry);

  assert.ok(screen.getByRole("heading", { name: "Move to another computer" }));
  assert.ok(screen.getByText("Migration mode: stop before export"));
  assert.ok(screen.getByText(/Migration resets the current session/));
  assert.ok(screen.getByText(/workspace files, including MEMORY.md and notes when present/));
  assert.ok(screen.getByText(/conversation context reset/));
  const targetComputerSelect = screen.getByRole("combobox", { name: "Target computer" });
  assert.equal(targetComputerSelect.textContent?.trim(), "Target Computer");
  assert.equal(targetComputerSelect.tagName, "BUTTON");
  assert.ok(targetComputerSelect.querySelector('[data-slot="select-trigger-content"]'));

  fireEvent.click(screen.getByRole("button", { name: "Start Migration" }));

  await waitFor(() => {
    const start = posts.find((post) => post.url === "/agents/agent-1/migrate");
    assert.ok(start, "clicking the dialog submit should call the direct migration route");
    assert.deepEqual(start.body, {
      targetComputer: "target-machine",
    });
  });
  assert.equal(
    posts.some((post) => post.url.startsWith("/actions/")),
    false,
    "profile migration must not prepare or execute an action card",
  );
  assert.ok(screen.getByText("Preparing secure connection to Target Computer."));
  const progress = screen.getByRole("progressbar", { name: "Migration progress to Target Computer" });
  assert.equal(progress.getAttribute("aria-valuenow"), "13");
  assert.ok(screen.getByText("Secure connection"));
  assert.ok(screen.getByText("Prepare files"));
  assert.ok(screen.getByText("Transfer"));
  assert.ok(screen.getByText("Finish"));
  assert.equal(
    (screen.getByRole("button", { name: "Migration in progress" }) as HTMLButtonElement).disabled,
    true,
  );
});

test("migration start consumes the canonical support ref and refreshes Cancel capability", async () => {
  const agent = seedPanelState("server-start-canonical-ref");
  const migrationRef = "mig_abcdefghijklmnopqrstuv";
  const canonical = {
    agentId: "agent-1",
    migrationRef,
    state: "prep",
    revision: 1,
    sourceMachineId: "source-machine",
    targetMachineId: "target-machine",
    updatedAt: "2026-08-04T02:00:00.000Z",
  };
  let statusCalls = 0;
  let resolveRefresh!: (value: { data: unknown }) => void;
  const refreshResponse = new Promise<{ data: unknown }>((resolve) => {
    resolveRefresh = resolve;
  });
  stubAgentMigrationStatus();
  const fallbackGet = api.get;
  api.get = async (url: string) => {
    if (url === "/agents/agent-1/migration") {
      statusCalls += 1;
      return statusCalls === 1
        ? { data: { migration: null } } as never
        : refreshResponse as never;
    }
    return fallbackGet(url);
  };
  api.post = async (url: string) => {
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: true }] } } as never;
    }
    if (url === "/agents/agent-1/migrate") {
      return {
        data: {
          migrationRef,
          state: "provisioning",
          sourceMachineId: "source-machine",
          targetMachineId: "target-machine",
        },
      } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };
  const clipboardWrites: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (value: string) => { clipboardWrites.push(value); } },
  });

  renderPanel(agent);
  await waitFor(() => assert.equal(statusCalls, 1));
  fireEvent.click(await screen.findByRole("button", { name: "Move to another computer" }));
  fireEvent.click(screen.getByRole("button", { name: "Start Migration" }));

  await waitFor(() => assert.equal(statusCalls, 2));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(screen.queryByText(migrationRef), null, "the POST response must not seed visible migration state");
  assert.equal(screen.queryByRole("progressbar"), null);
  resolveRefresh({ data: { migration: canonical } });
  await screen.findByRole("button", { name: "Cancel migration" });
  fireEvent.click(screen.getByRole("button", { name: `Copy migration reference ${migrationRef}` }));
  await waitFor(() => assert.deepEqual(clipboardWrites, [migrationRef]));
  fireEvent.click(screen.getByRole("button", { name: "Cancel migration" }));
  const cancelDialog = screen.getByRole("dialog", { name: "Cancel migration?" });
  assert.ok(within(cancelDialog).getByText(migrationRef));
});

test("migration target uses the shared selector and submits the selected computer", async () => {
  const agent = seedPanelState("server-selector");
  const machines = useMachineStore.getState().machines;
  const target = machines.find((machine) => machine.id === "target-machine");
  assert.ok(target);
  useMachineStore.setState({
    machines: [
      ...machines,
      {
        ...target,
        id: "backup-machine",
        name: "Backup Computer",
      },
    ],
  });
  const posts: Array<{ url: string; body: unknown }> = [];
  stubAgentMigrationStatus();
  api.post = async (url: string, body?: unknown) => {
    posts.push({ url, body });
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: true }] } } as never;
    }
    if (url === "/agents/agent-1/migrate") {
      return {
        data: {
          migrationRef: "mig_abcdefghijklmnopqrstuv",
          state: "provisioning",
          sourceMachineId: "source-machine",
          targetMachineId: "backup-machine",
        },
      } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };

  renderPanel(agent);

  fireEvent.click(await screen.findByRole("button", { name: "Move to another computer" }));
  const selector = screen.getByRole("combobox", { name: "Target computer" });
  assert.equal(selector.tagName, "BUTTON");
  assert.ok(selector.querySelector('[data-slot="select-trigger-content"]'));
  selector.focus();
  fireEvent.keyDown(selector, { key: "ArrowDown" });
  const listbox = await screen.findByRole("listbox");
  assert.match(listbox.className, /max-h-64/);
  assert.deepEqual(
    within(listbox).getAllByRole("option").map((option) => option.textContent?.trim()),
    ["Target Computer", "Backup Computer"],
  );
  const backupOption = within(listbox).getByRole("option", { name: "Backup Computer" });
  fireEvent.pointerDown(backupOption, { pointerType: "mouse" });
  fireEvent.click(backupOption);
  await waitFor(() => assert.equal(selector.textContent?.trim(), "Backup Computer"));

  fireEvent.click(screen.getByRole("button", { name: "Start Migration" }));
  await waitFor(() => {
    assert.deepEqual(
      posts.find((post) => post.url === "/agents/agent-1/migrate")?.body,
      { targetComputer: "backup-machine" },
    );
  });
});

test("migration target selector shows a disabled empty state when no destination exists", async () => {
  const agent = seedPanelState("server-selector-empty");
  useMachineStore.setState((state) => ({
    machines: state.machines.filter((machine) => machine.id === "source-machine"),
  }));
  stubAgentMigrationStatus();
  stubMigrationFeatureFlag("server-selector-empty");

  renderPanel(agent);

  fireEvent.click(await screen.findByRole("button", { name: "Move to another computer" }));
  const selector = screen.getByRole("combobox", { name: "Target computer" });
  assert.equal(selector.textContent?.trim(), "No other attached computer");
  assert.equal((selector as HTMLButtonElement).disabled, true);
  assert.equal(
    (screen.getByRole("button", { name: "Start Migration" }) as HTMLButtonElement).disabled,
    true,
  );
});

test("Antigravity edit can save unrelated config while its model source stays unsupported", async () => {
  const agent = seedPanelState("server-antigravity", makeAgent({
    serverId: "server-antigravity",
    runtime: "antigravity",
    model: "default",
    status: "offline",
    executionMode: "byoc",
  }));
  useMachineStore.setState((state) => ({
    machines: state.machines.map((machine) => machine.id === "source-machine"
      ? { ...machine, runtimes: ["antigravity"] }
      : machine),
  }));
  stubAgentMigrationStatus(null, { kind: "unsupported" });
  api.post = async (url: string) => {
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: false }] } } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };
  let patchBody: { runtime?: string; runtimeConfig?: { envVars?: Record<string, string> | null } } | null = null;
  api.patch = async (url: string, body?: unknown) => {
    assert.equal(url, "/agents/agent-1");
    patchBody = body as typeof patchBody;
    return { data: { ...agent, ...(body as object) } } as never;
  };

  renderPanel(agent);
  fireEvent.click(await screen.findByTitle("Edit runtime config"));
  // One disclosure now (@cindyz, 2026-09-03): Command and env vars sit directly
  // inside More, so there is no second "Advanced" to open.
  fireEvent.click(await screen.findByRole("button", { name: "More" }));
  fireEvent.click(await screen.findByRole("button", { name: "Add Variable" }));
  fireEvent.change(screen.getByPlaceholderText("KEY"), { target: { value: "TEAM_FLAG" } });
  fireEvent.change(screen.getByPlaceholderText("value"), { target: { value: "1" } });

  const saveButton = screen.getByRole("button", { name: "Save runtime config" });
  await waitFor(() => assert.equal((saveButton as HTMLButtonElement).disabled, false));
  fireEvent.click(saveButton);

  await waitFor(() => assert.deepEqual(patchBody && {
    runtime: patchBody.runtime,
    envVars: patchBody.runtimeConfig?.envVars,
  }, { runtime: "antigravity", envVars: { TEAM_FLAG: "1" } }));
});

test("agent profile does not flash a raw dynamic model ID before the configured label loads", async () => {
  const agent = seedPanelState("server-kimi-label", makeAgent({
    serverId: "server-kimi-label",
    runtime: "kimi-sdk",
    model: "kimi-code/k3-256k",
    runtimeConfig: {
      version: 1,
      runtime: "kimi-sdk",
      model: { kind: "custom", name: "kimi-code/k3-256k" },
      mode: { kind: "default" },
      reasoningEffort: null,
      envVars: null,
    },
    status: "offline",
    executionMode: "byoc",
  }));
  useMachineStore.setState((state) => ({
    machines: state.machines.map((machine) => machine.id === "source-machine"
      ? { ...machine, runtimes: ["kimi-sdk"] }
      : machine),
  }));
  stubAgentMigrationStatus();
  const fallbackGet = api.get;
  let resolveModels!: (value: { data: unknown }) => void;
  api.get = async (url: string, ...args: unknown[]) => {
    if (url.includes("/runtime-models/kimi-sdk")) {
      return new Promise((resolve) => {
        resolveModels = resolve;
      }) as never;
    }
    return fallbackGet(url, ...args);
  };
  stubMigrationFeatureFlag("server-kimi-label");

  renderPanel(agent);

  const rawModelIdWasVisible = screen.queryByText("kimi-code/k3-256k") !== null;
  assert.ok(screen.getByText("Loading…"), "the profile must defer to the same pending catalog authority as mention hover");

  await act(async () => {
    resolveModels({
      data: {
        kind: "live",
        value: {
          models: [{ id: "kimi-code/k3-256k", label: "K3-256k", verified: "launchable" }],
          default: "kimi-code/k3",
        },
      },
    });
  });

  assert.ok(await screen.findByText("K3-256k"));
  assert.equal(rawModelIdWasVisible, false);
  assert.equal(screen.queryByText("kimi-code/k3-256k"), null);
});

test("retryable model error keeps a persisted Kimi model option-empty and blocks edit save", async () => {
  const agent = seedPanelState("server-kimi-error", makeAgent({
    serverId: "server-kimi-error",
    runtime: "kimi-sdk",
    model: "kimi-code/kimi-for-coding",
    status: "offline",
    executionMode: "byoc",
  }));
  useMachineStore.setState((state) => ({
    machines: state.machines.map((machine) => machine.id === "source-machine"
      ? { ...machine, runtimes: ["kimi-sdk"] }
      : machine),
  }));
  let modelChecks = 0;
  api.get = async (url: string) => {
    if (url.includes("/runtime-models/kimi-sdk")) {
      modelChecks += 1;
      return { data: { kind: "error", retryable: true } } as never;
    }
    if (url === "/agents/agent-1/migration") {
      return { data: { migration: null } } as never;
    }
    return { data: { reminders: [] } } as never;
  };
  api.post = async (url: string) => {
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: false }] } } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };
  let patchAttempts = 0;
  api.patch = async () => {
    patchAttempts += 1;
    return { data: agent } as never;
  };

  renderPanel(agent, "zh-cn");
  fireEvent.click(await screen.findByTitle("编辑运行时配置"));

  assert.ok(await screen.findByText("无法从此 Computer 加载模型。"));
  assert.equal(screen.queryByText(/Kimi is not signed in/), null);
  const modelSelect = screen.getAllByRole("combobox")[1];
  assert.ok(modelSelect, "edit must keep the non-live model control empty even with a persisted model");
  fireEvent.click(modelSelect);
  assert.equal(screen.queryByRole("option", { name: /Kimi for Coding/ }), null);

  const saveButton = screen.getByRole("button", { name: "保存运行时配置" });
  assert.equal((saveButton as HTMLButtonElement).disabled, true);
  assert.equal(patchAttempts, 0);

  const checksBeforeRetry = modelChecks;
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await waitFor(() => assert.equal(modelChecks, checksBeforeRetry + 1));
  assert.equal(patchAttempts, 0);
});

test("Cursor probe error cannot promote persisted bundled Auto into edit options or submit", async () => {
  const agent = seedPanelState("server-cursor-error", makeAgent({
    serverId: "server-cursor-error",
    runtime: "cursor",
    model: "auto",
    runtimeConfig: {
      version: 1,
      runtime: "cursor",
      model: { kind: "preset", id: "auto" },
      mode: { kind: "default" },
      reasoningEffort: null,
      envVars: null,
    },
    status: "offline",
    executionMode: "byoc",
  }));
  useMachineStore.setState((state) => ({
    machines: state.machines.map((machine) => machine.id === "source-machine"
      ? { ...machine, runtimes: ["cursor"] }
      : machine),
  }));
  stubAgentMigrationStatus(null, { kind: "error", retryable: true });
  api.post = async (url: string) => {
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: false }] } } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };
  let patchAttempts = 0;
  api.patch = async () => {
    patchAttempts += 1;
    return { data: agent } as never;
  };

  renderPanel(agent);
  fireEvent.click(await screen.findByTitle("Edit runtime config"));

  assert.ok(await screen.findByText("Could not load models from this Computer."));
  const modelSelect = screen.getAllByRole("combobox")[1];
  assert.ok(modelSelect, "Cursor error must keep the persisted preset out of the model options");
  fireEvent.click(modelSelect);
  assert.equal(screen.queryByRole("option", { name: "Auto" }), null);

  // One disclosure now (@cindyz, 2026-09-03): Command and env vars sit directly
  // inside More, so there is no second "Advanced" to open.
  fireEvent.click(await screen.findByRole("button", { name: "More" }));
  fireEvent.click(await screen.findByRole("button", { name: "Add Variable" }));
  fireEvent.change(screen.getByPlaceholderText("KEY"), { target: { value: "TEAM_FLAG" } });
  fireEvent.change(screen.getByPlaceholderText("value"), { target: { value: "1" } });

  const saveButton = screen.getByRole("button", { name: "Save runtime config" });
  assert.equal((saveButton as HTMLButtonElement).disabled, true);
  fireEvent.click(saveButton);
  assert.equal(patchAttempts, 0);
});

test("live catalog shrink preserves the persisted edit model as unverified", async () => {
  const agent = seedPanelState("server-kimi-live-shrink", makeAgent({
    serverId: "server-kimi-live-shrink",
    runtime: "kimi-sdk",
    model: "kimi-code/kimi-for-coding",
    status: "offline",
    executionMode: "byoc",
  }));
  useMachineStore.setState((state) => ({
    machines: state.machines.map((machine) => machine.id === "source-machine"
      ? { ...machine, runtimes: ["kimi-sdk"] }
      : machine),
  }));
  let modelChecks = 0;
  api.get = async (url: string) => {
    if (url.includes("/runtime-models/kimi-sdk")) {
      modelChecks += 1;
      return {
        data: {
          kind: "live",
          value: {
            models: [{ id: "kimi-code/new-model", label: "Kimi New Model", verified: "launchable" }],
            default: "kimi-code/new-model",
          },
        },
      } as never;
    }
    if (url === "/agents/agent-1/migration") {
      return { data: { migration: null } } as never;
    }
    return { data: { reminders: [] } } as never;
  };
  api.post = async (url: string) => {
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: false }] } } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };

  renderPanel(agent);
  fireEvent.click(await screen.findByTitle("Edit runtime config"));
  await waitFor(() => assert.equal(modelChecks, 1));

  const modelSelect = screen.getAllByRole("combobox")[1];
  assert.ok(modelSelect, "edit must expose the live model catalog");
  fireEvent.click(modelSelect);
  assert.ok(await screen.findByRole("option", { name: /Kimi for Coding.*not in this computer's config/ }));
});

test("migration profile entry keeps the latest completed migration visible at 100%", async () => {
  const agent = seedPanelState("server-migration-complete");
  let migrationStatusCalls = 0;
  stubAgentMigrationStatus();
  const fallbackGet = api.get;
  api.get = async (url: string) => {
    if (url === "/agents/agent-1/migration") {
      migrationStatusCalls += 1;
      const migration = migrationStatusCalls === 1
        ? null
          : {
            agentId: "agent-1",
            migrationRef: "mig_abcdefghijklmnopqrstuv",
            state: "completed",
            revision: 1,
            sourceMachineId: "source-machine",
            targetMachineId: "target-machine",
            completedAt: "2026-07-14T06:00:00.000Z",
          };
      return { data: { migration } } as never;
    }
    return fallbackGet(url);
  };
  api.post = async (url: string, body?: unknown) => {
    if (url === "/feature-flags/evaluate") {
      assert.deepEqual(body, {
        serverId: "server-migration-complete",
        platform: "web",
        keys: REGISTERED_SERVER_FEATURE_FLAG_KEYS,
      });
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: true }] } } as never;
    }
    if (url === "/agents/agent-1/migrate") {
      return {
        data: {
          migrationRef: "mig_abcdefghijklmnopqrstuv",
          state: "completed",
          sourceMachineId: "source-machine",
          targetMachineId: "target-machine",
        },
      } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };

  renderPanel(agent);

  fireEvent.click(await screen.findByRole("button", { name: "Move to another computer" }));
  fireEvent.click(screen.getByRole("button", { name: "Start Migration" }));

  await screen.findByText(/Agent moved to Target Computer and started successfully/);
  assert.equal(
    screen.getByRole("progressbar", { name: "Migration progress to Target Computer" }).getAttribute("aria-valuenow"),
    "100",
  );
  assert.ok(screen.getByText("Complete"));
  assert.ok(screen.getByText("Moved from Source Computer to Target Computer"));
  assert.ok(screen.getByText(/Migration resets the current session/));
  assert.ok(screen.getByRole("button", { name: "Move to another computer" }));
});

test("migration profile entry shows typed transport failures inline", async () => {
  const agent = seedPanelState("server-typed-error");
  const transportFailures = [
    {
      error: "Migration transport is not provisioned",
      code: "MIGRATION_TRANSPORT_NOT_PROVISIONED",
      expected: "Raft could not prepare a secure transfer between these computers. Make sure both computers are online and up to date, then try again.",
    },
    {
      error: "Migration transport provisioning failed",
      code: "MIGRATION_TRANSPORT_PROVISION_FAILED",
      expected: "Raft could not prepare the transfer. Make sure both computers are online, then try again.",
    },
    {
      error: "Migration transport was lost",
      code: "MIGRATION_TRANSPORT_LOST",
      expected: "The transfer connection ended before the agent arrived. Make sure both computers are online, then try again.",
    },
  ];
  stubAgentMigrationStatus();
  api.post = async (url: string, body?: unknown) => {
    if (url === "/feature-flags/evaluate") {
      assert.deepEqual(body, {
        serverId: "server-typed-error",
        platform: "web",
        keys: REGISTERED_SERVER_FEATURE_FLAG_KEYS,
      });
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: true }] } } as never;
    }
    if (url === "/agents/agent-1/migrate") {
      const failure = transportFailures.shift();
      assert.ok(failure, "test should only submit configured transport failure cases");
      const error = new Error(failure.error) as Error & {
        response?: { data?: { error?: string; code?: string } };
      };
      error.response = {
        data: failure,
      };
      throw error;
    }
    throw new Error(`unexpected POST ${url}`);
  };

  renderPanel(agent);

  fireEvent.click(await screen.findByRole("button", { name: "Move to another computer" }));

  for (const { code, expected } of [
    {
      code: "MIGRATION_TRANSPORT_NOT_PROVISIONED",
      expected: "Raft could not prepare a secure transfer between these computers. Make sure both computers are online and up to date, then try again.",
    },
    {
      code: "MIGRATION_TRANSPORT_PROVISION_FAILED",
      expected: "Raft could not prepare the transfer. Make sure both computers are online, then try again.",
    },
    {
      code: "MIGRATION_TRANSPORT_LOST",
      expected: "The transfer connection ended before the agent arrived. Make sure both computers are online, then try again.",
    },
  ]) {
    fireEvent.click(screen.getByRole("button", { name: "Start Migration" }));
    await screen.findByText(expected);
    assert.ok(screen.getByText(code));
  }
});

test("resumable capability error names the Computer and exposes recovery actions", async () => {
  const agent = seedPanelState("server-resumable-error");
  let startCalls = 0;
  stubAgentMigrationStatus();
  api.post = async (url: string) => {
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: true }] } } as never;
    }
    if (url === "/agents/agent-1/migrate") {
      startCalls += 1;
      const error = new Error("raw backend transport detail") as Error & {
        response?: { data?: { error?: string; code?: string; details?: unknown } };
      };
      error.response = {
        data: {
          error: "raw backend transport detail",
          code: "MIGRATION_RESUMABLE_CAPABILITY_REQUIRED",
          details: {
            side: "target",
            reason: "protocol_missing",
            capabilities: ["must-not-render"],
          },
        },
      };
      throw error;
    }
    throw new Error(`unexpected POST ${url}`);
  };

  renderPanel(agent);
  fireEvent.click(await screen.findByRole("button", { name: "Move to another computer" }));
  fireEvent.click(screen.getByRole("button", { name: "Start Migration" }));

  assert.ok(await screen.findByText(
    "Target Computer has not reported resumable migration support. Update it to Raft Computer v1.0.14 or later, restart it, wait for it to reconnect, then try again.",
  ));
  assert.equal(screen.queryByText("raw backend transport detail"), null);
  assert.equal(screen.queryByText("must-not-render"), null);
  const technicalCode = screen.getByText("MIGRATION_RESUMABLE_CAPABILITY_REQUIRED");
  const technicalDetails = technicalCode.closest("details");
  assert.ok(technicalDetails);
  assert.equal(technicalDetails.open, false);
  assert.ok(within(technicalDetails).getByText("Technical details"));

  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => assert.equal(startCalls, 2));

  fireEvent.click(screen.getByRole("button", { name: "Open Computers" }));
  await waitFor(() => {
    assert.equal(
      screen.getByTestId("location").textContent,
      "/s/botiverse/computer/target-machine",
      "an online Computer without an upgrade badge must remain directly reachable from the failure",
    );
    assert.equal(screen.getByTestId("location-search").textContent, "");
  });
});

test("computer capability error renders every structured failure as a readable list", async () => {
  const agent = seedPanelState("server-capability-error");
  stubAgentMigrationStatus();
  api.post = async (url: string) => {
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: true }] } } as never;
    }
    if (url === "/agents/agent-1/migrate") {
      const error = new Error("raw aggregate error must not render") as Error & {
        response?: { data?: { error?: string; code?: string; details?: unknown } };
      };
      error.response = {
        data: {
          error: "raw aggregate error must not render",
          code: "COMPUTER_CAPABILITY_INSUFFICIENT",
          details: {
            failures: [
              {
                side: "source",
                reason: "daemon_version_unconfirmed",
                minimumDaemonVersion: "0.72.7",
              },
              { side: "target", reason: "runtime_missing", runtime: "codex" },
            ],
          },
        },
      };
      throw error;
    }
    throw new Error(`unexpected POST ${url}`);
  };

  renderPanel(agent);
  fireEvent.click(await screen.findByRole("button", { name: "Move to another computer" }));
  fireEvent.click(screen.getByRole("button", { name: "Start Migration" }));

  assert.ok(await screen.findByText("Fix these computer requirements before starting the migration:"));
  const sourceIssue = screen.getByText(
    "Raft could not confirm Source Computer's Raft Computer version. Start or restart it, wait for it to reconnect, and make sure it is version 0.72.7 or later.",
  );
  const targetIssue = screen.getByText(
    "Target Computer does not support Codex CLI. Install or enable that runtime on this computer, or choose another computer.",
  );
  assert.equal(sourceIssue.closest("li")?.parentElement?.tagName, "UL");
  assert.equal(targetIssue.closest("li")?.parentElement?.tagName, "UL");
  assert.equal(screen.queryByText("raw aggregate error must not render"), null);
  assert.ok(screen.getByRole("button", { name: "Open Computers" }));
});

test("resumable capability recovery copy and actions render in zh-CN", async () => {
  const agent = seedPanelState("server-resumable-error-zh");
  stubAgentMigrationStatus();
  api.post = async (url: string) => {
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: true }] } } as never;
    }
    if (url === "/agents/agent-1/migrate") {
      const error = new Error("raw backend transport detail") as Error & {
        response?: { data?: { error?: string; code?: string; details?: unknown } };
      };
      error.response = {
        data: {
          error: "raw backend transport detail",
          code: "MIGRATION_RESUMABLE_CAPABILITY_REQUIRED",
          details: {
            side: "source",
            reason: "capability_missing",
          },
        },
      };
      throw error;
    }
    throw new Error(`unexpected POST ${url}`);
  };

  renderPanel(agent, "zh-cn");
  fireEvent.click(await screen.findByRole("button", { name: "迁移到另一台计算机" }));
  fireEvent.click(screen.getByRole("button", { name: "开始迁移" }));

  assert.ok(await screen.findByText(
    "Source Computer 缺少迁移所需的能力。请将它升级到 Raft Computer v1.0.14 或更高版本，重启并等待重新连接后再试。",
  ));
  assert.ok(screen.getByRole("button", { name: "打开 Computer 列表" }));
  assert.ok(screen.getByRole("button", { name: "重试" }));
  assert.ok(screen.getByText("技术详情"));
  assert.equal(screen.queryByText("raw backend transport detail"), null);
});

test("migration profile entry restores persisted migration status after refresh", async () => {
  const agent = seedPanelState("server-persisted-status");
  let statusCalls = 0;
  api.get = async (url: string) => {
    if (url === "/agents/agent-1/migration") {
      statusCalls += 1;
      return {
        data: {
          migration: {
            agentId: "agent-1",
            migrationRef: "mig_abcdefghijklmnopqrstuv",
            state: "in_transit",
            sourceMachineId: "source-machine",
            targetMachineId: "target-machine",
          },
        },
      } as never;
    }
    return { data: { reminders: [] } } as never;
  };
  api.post = async (url: string, body?: unknown) => {
    if (url === "/feature-flags/evaluate") {
      assert.deepEqual(body, {
        serverId: "server-persisted-status",
        platform: "web",
        keys: REGISTERED_SERVER_FEATURE_FLAG_KEYS,
      });
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: true }] } } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };

  renderPanel(agent);

  await waitFor(() => assert.equal(statusCalls, 1));
  assert.ok(screen.getByText("Transferring workspace to Target Computer."));
  assert.equal(
    screen.getByRole("progressbar", { name: "Migration progress to Target Computer" }).getAttribute("aria-valuenow"),
    "63",
  );
});

for (const { state, expectedProgress, expectedMessage } of [
  { state: "provisioning", expectedProgress: "13", expectedMessage: "Preparing secure connection to Target Computer." },
  { state: "prep", expectedProgress: "38", expectedMessage: "Preparing workspace files on Source Computer." },
  { state: "ready", expectedProgress: "63", expectedMessage: "Workspace bundle is ready. Starting transfer to Target Computer." },
  { state: "in_transit", expectedProgress: "63", expectedMessage: "Transferring workspace to Target Computer." },
  { state: "arriving", expectedProgress: "88", expectedMessage: "Starting the agent on Target Computer." },
  { state: "starting", expectedProgress: "88", expectedMessage: "Starting the agent on Target Computer." },
]) {
  test(`migration profile entry renders persisted ${state} progress`, async () => {
    const serverId = `server-active-${state}`;
    const agent = seedPanelState(serverId);
    const migration = {
      agentId: "agent-1",
      migrationRef: "mig_abcdefghijklmnopqrstuv",
      state,
      sourceMachineId: "source-machine",
      targetMachineId: "target-machine",
      updatedAt: "2026-07-14T06:00:00.000Z",
    };
    stubAgentMigrationStatus(migration);
    stubMigrationFeatureFlag(serverId);

    renderPanel(agent);

    await screen.findByText(expectedMessage);
    assert.equal(
      screen.getByRole("progressbar", { name: "Migration progress to Target Computer" }).getAttribute("aria-valuenow"),
      expectedProgress,
    );
    assert.equal(
      screen.getByLabelText("Migration to Target Computer").querySelectorAll(".bg-brutal-pink").length,
      2,
      "active fill and current-step marker must share the migration pink intent",
    );
    assert.equal(
      (screen.getByRole("button", { name: "Migration in progress" }) as HTMLButtonElement).disabled,
      true,
    );
  });
}

test("migration profile entry keeps prior progress across a temporary poll failure", async () => {
  const agent = seedPanelState("server-poll-failure");
  let statusCalls = 0;
  api.get = async (url: string) => {
    if (url === "/agents/agent-1/migration") {
      statusCalls += 1;
      if (statusCalls > 1) throw new Error("temporary status outage");
      const migration = {
        agentId: "agent-1",
        migrationRef: "mig_abcdefghijklmnopqrstuv",
        state: "in_transit",
        sourceMachineId: "source-machine",
        targetMachineId: "target-machine",
      };
      return { data: { migration } } as never;
    }
    return { data: { reminders: [] } } as never;
  };
  stubMigrationFeatureFlag("server-poll-failure");

  renderPanel(agent);

  await screen.findByText("Transferring workspace to Target Computer.");
  await waitFor(() => assert.equal(statusCalls, 2), { timeout: 3_500 });
  assert.equal(
    screen.getByRole("progressbar", { name: "Migration progress to Target Computer" }).getAttribute("aria-valuenow"),
    "63",
  );
  assert.ok(screen.getByText("Migration status unavailable"));
});

test("migration profile entry polls active progress until the persisted terminal state", async () => {
  const agent = seedPanelState("server-polling-progress");
  let statusCalls = 0;
  api.get = async (url: string) => {
    if (url === "/agents/agent-1/migration") {
      statusCalls += 1;
      const migration = statusCalls === 1
        ? null
        : statusCalls === 2
          ? {
              agentId: "agent-1",
              migrationRef: "mig_abcdefghijklmnopqrstuv",
              state: "provisioning",
              revision: 1,
              sourceMachineId: "source-machine",
              targetMachineId: "target-machine",
            }
          : {
              agentId: "agent-1",
              migrationRef: "mig_abcdefghijklmnopqrstuv",
              state: "completed",
              revision: 2,
              sourceMachineId: "source-machine",
              targetMachineId: "target-machine",
              completedAt: "2026-07-14T06:00:00.000Z",
            };
      return {
        data: {
          migration,
        },
      } as never;
    }
    return { data: { reminders: [] } } as never;
  };
  api.post = async (url: string, body?: unknown) => {
    if (url === "/feature-flags/evaluate") {
      assert.deepEqual(body, {
        serverId: "server-polling-progress",
        platform: "web",
        keys: REGISTERED_SERVER_FEATURE_FLAG_KEYS,
      });
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: true }] } } as never;
    }
    if (url === "/agents/agent-1/migrate") {
      return {
        data: {
          migrationRef: "mig_abcdefghijklmnopqrstuv",
          state: "provisioning",
          sourceMachineId: "source-machine",
          targetMachineId: "target-machine",
        },
      } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };

  renderPanel(agent);

  fireEvent.click(await screen.findByRole("button", { name: "Move to another computer" }));
  fireEvent.click(screen.getByRole("button", { name: "Start Migration" }));
  await screen.findByText("Preparing secure connection to Target Computer.");
  assert.equal(statusCalls, 2);

  await waitFor(() => {
    assert.equal(statusCalls, 3);
    assert.ok(screen.getAllByText(/Agent moved to Target Computer and started successfully/).length >= 1);
  }, { timeout: 3_500 });
  assert.equal(
    screen.getByRole("progressbar", { name: "Migration progress to Target Computer" }).getAttribute("aria-valuenow"),
    "100",
  );
  assert.ok(screen.getByText(/Migration resets the current session/));
  assert.ok(screen.getByRole("button", { name: "Move to another computer" }));
});

test("completed migration renders localized route and continuity copy without transfer breakdown", async () => {
  const agent = seedPanelState("server-completed-summary-zh");
  const migration = {
    agentId: "agent-1",
    migrationRef: "mig_abcdefghijklmnopqrstuv",
    state: "completed",
    revision: 2,
    sourceMachineId: "source-machine",
    targetMachineId: "target-machine",
    completedAt: "2026-07-14T06:00:00.000Z",
  };
  stubAgentMigrationStatus(migration);
  stubMigrationFeatureFlag("server-completed-summary-zh");

  renderPanel(agent, "zh-cn");

  assert.equal(
    (await screen.findByRole("progressbar", { name: "迁移到 Target Computer 的进度" }))
      .getAttribute("aria-valuenow"),
    "100",
  );
  const summary = screen.getByTestId("migration-completion-summary");
  assert.ok(within(summary).getByText("已从 Source Computer 迁移至 Target Computer"));
  assert.ok(within(summary).getByText(/目标工作区已提交/));
  assert.ok(within(summary).getByText(/MEMORY.md 和 notes/));
  assert.equal(within(summary).queryByText(/sha256|workspacePathRef|\/Users\//i), null);
});

test("prep deadline abort copy is source-specific instead of blaming both computers", async () => {
  const agent = seedPanelState("server-aborted-prep");
  const migration = {
    agentId: "agent-1",
    migrationRef: "mig_abcdefghijklmnopqrstuv",
    state: "aborted",
    sourceMachineId: "source-machine",
    targetMachineId: "target-machine",
    abortReason: "prep-deadline",
    abortedAt: "2026-07-14T06:00:00.000Z",
  };
  stubAgentMigrationStatus(migration);
  stubMigrationFeatureFlag("server-aborted-prep");

  renderPanel(agent);

  assert.ok(await screen.findByText(
    "The source Computer Source Computer did not finish preparing the workspace before the deadline. Large workspaces can take longer; make sure the source is running, then try again.",
  ));
  assert.equal(screen.queryByText(/both Computers.*online/i), null);
});

test("migration profile entry shows persisted typed transport failure after refresh", async () => {
  const agent = seedPanelState("server-persisted-failure");
  useMachineStore.setState((state) => ({
    machines: state.machines.map((machine) => machine.id === "source-machine"
      ? { ...machine, status: "online", lastHeartbeat: "2026-07-10T07:59:00.000Z" }
      : { ...machine, status: "offline", lastHeartbeat: "2026-07-10T07:57:59.999Z" }),
  }));
  api.get = async (url: string) => {
    if (url === "/agents/agent-1/migration") {
      return {
        data: {
          migration: {
            agentId: "agent-1",
            migrationRef: "mig_abcdefghijklmnopqrstuv",
            state: "failed",
            sourceMachineId: "source-machine",
            targetMachineId: "target-machine",
            failureReason: "transport_lost",
            abortReason: null,
            transportErrorCode: "MIGRATION_TRANSPORT_LOST",
            transportErrorMessage: "Target transfer object did not appear before deadline",
            transportLostAt: "2026-07-10T08:00:00.000Z",
          },
        },
      } as never;
    }
    return { data: { reminders: [] } } as never;
  };
  api.post = async (url: string, body?: unknown) => {
    if (url === "/feature-flags/evaluate") {
      assert.deepEqual(body, {
        serverId: "server-persisted-failure",
        platform: "web",
        keys: REGISTERED_SERVER_FEATURE_FLAG_KEYS,
      });
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: true }] } } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };

  renderPanel(agent);

  await screen.findByText("Migration failed");
  assert.ok(screen.getByText(/The transfer connection ended at .* before the agent arrived/));
  assert.ok(screen.getByText(/Target Computer had already missed the heartbeat window at that time/));
  assert.ok(screen.getByText(/Target Computer is offline now. Bring it online before retrying/));
  assert.ok(screen.getByText("MIGRATION_TRANSPORT_LOST"));
  assert.equal(screen.queryByText(/Target transfer object did not appear before deadline/), null);
  assert.ok(screen.getByRole("progressbar", { name: "Migration progress to Target Computer" }));
  assert.ok(screen.getByRole("button", { name: "Try migration again" }));
});

test("the latest row shows the canonical migration reference and Copy preserves the exact value", async () => {
  const agent = seedPanelState("server-migration-refs");
  const activeRef = "mig_abcdefghijklmnopqrstuv";
  const active = {
    agentId: "agent-1",
    migrationRef: activeRef,
    state: "in_transit",
    revision: 4,
    sourceMachineId: "source-machine",
    targetMachineId: "target-machine",
    updatedAt: "2026-07-20T08:00:00.000Z",
  };
  const clipboardWrites: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (value: string) => { clipboardWrites.push(value); } },
  });
  stubAgentMigrationStatus(active);
  stubMigrationFeatureFlag("server-migration-refs");

  renderPanel(agent);

  await screen.findByText(activeRef);
  fireEvent.click(screen.getByRole("button", { name: `Copy migration reference ${activeRef}` }));
  await waitFor(() => assert.deepEqual(clipboardWrites, [activeRef]));
  assert.ok(screen.getByRole("button", { name: "Migration reference copied" }));
});

test("Cancel uses one safe dialog without client-side phase guessing", async () => {
  const agent = seedPanelState("server-migration-cancel");
  const migrationRef = "mig_abcdefghijklmnopqrstuv";
  const active = {
    agentId: "agent-1",
    migrationRef,
    state: "prep",
    revision: 3,
    sourceMachineId: "source-machine",
    targetMachineId: "target-machine",
    updatedAt: "2026-07-20T08:00:00.000Z",
  };
  stubAgentMigrationStatus(active);
  stubMigrationFeatureFlag("server-migration-cancel");

  renderPanel(agent);

  fireEvent.click(await screen.findByRole("button", { name: "Cancel migration" }));
  const dialog = screen.getByRole("dialog", { name: "Cancel migration?" });
  assert.ok(within(dialog).getByText("Safe cancellation"));
  assert.ok(within(dialog).getByText(/preserve the authoritative Computer/));
  assert.ok(within(dialog).getByText(migrationRef));
  assert.equal(within(dialog).queryByText("Before computer switch"), null);
  assert.equal(within(dialog).queryByText("After computer switch"), null);
  fireEvent.click(within(dialog).getByRole("button", { name: "Keep migration" }));
  await waitFor(() => assert.equal(document.querySelector('[role="dialog"]'), null));
});

test("successful Cancel discards its POST representation and refetches authoritative status", async () => {
  const agent = seedPanelState("server-migration-cancel-refresh");
  const migrationRef = "mig_abcdefghijklmnopqrstuv";
  const active = {
    agentId: "agent-1",
    migrationRef,
    state: "prep",
    revision: 3,
    sourceMachineId: "source-machine",
    targetMachineId: "target-machine",
    updatedAt: "2026-07-20T08:00:00.000Z",
  };
  let statusCalls = 0;
  stubAgentMigrationStatus(active);
  const statusGet = api.get;
  api.get = async (url: string) => {
    if (url === "/agents/agent-1/migration") {
      statusCalls += 1;
      return { data: { migration: statusCalls === 1 ? active : null } } as never;
    }
    return statusGet(url);
  };
  api.post = async (url: string) => {
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: true }] } } as never;
    }
    if (url === "/agents/agent-1/migration/cancel") {
      return {
        data: {
          ...active,
          state: "canceled_pre_flip",
          revision: 4,
        },
      } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };

  renderPanel(agent);
  fireEvent.click(await screen.findByRole("button", { name: "Cancel migration" }));
  const dialog = screen.getByRole("dialog", { name: "Cancel migration?" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel migration" }));

  await waitFor(() => assert.equal(statusCalls, 2));
  assert.equal(
    screen.queryByText(/migration was canceled before the computer switch/i),
    null,
    "the cancel POST response must not project terminal state",
  );
  await waitFor(() => assert.equal(screen.queryByRole("dialog", { name: "Cancel migration?" }), null));
  assert.ok(screen.getByRole("button", { name: "Move to another computer" }));
});

for (const [state, message] of [
  ["canceled_pre_flip", "The migration was canceled before the computer switch. The agent remains on the source computer."],
  ["canceled_post_flip", "The migration was canceled after the computer switch. The migrated agent was stopped and cleanup was confirmed."],
] as const) {
  test(`${state} renders as a terminal canceled outcome`, async () => {
    const serverId = `server-${state}`;
    const agent = seedPanelState(serverId);
    stubAgentMigrationStatus({
      agentId: "agent-1",
      migrationRef: "mig_abcdefghijklmnopqrstuv",
      state,
      revision: 9,
      sourceMachineId: "source-machine",
      targetMachineId: "target-machine",
      canceledAt: "2026-07-20T08:02:00.000Z",
    });
    stubMigrationFeatureFlag(serverId);

    renderPanel(agent);

    assert.ok(await screen.findByText(message));
    assert.ok(screen.getByText("Migration to Target Computer canceled"));
    assert.equal(screen.queryByText("Moving to Target Computer"), null);
    assert.ok(screen.getByText("Canceled"));
    assert.equal(screen.queryByText("In progress"), null);
    assert.equal(screen.queryByRole("button", { name: "Migration in progress" }), null);
    assert.ok(screen.getByRole("button", { name: "Move to another computer" }));
  });
}

const MOVING_MIGRATION_STATES = new Set([
  "provisioning",
  "prep",
  "ready",
  "in_transit",
  "arriving",
  "starting",
]);

for (const state of AGENT_MIGRATION_STATES.filter((candidate) => !MOVING_MIGRATION_STATES.has(candidate))) {
  test(`${state} never uses the active moving header`, async () => {
    const serverId = `server-migration-header-${state}`;
    const agent = seedPanelState(serverId);
    stubAgentMigrationStatus({
      agentId: "agent-1",
      migrationRef: "mig_abcdefghijklmnopqrstuv",
      state,
      revision: 9,
      sourceMachineId: "source-machine",
      targetMachineId: "target-machine",
      updatedAt: "2026-07-20T08:02:00.000Z",
    });
    stubMigrationFeatureFlag(serverId);

    renderPanel(agent);

    await screen.findByText("mig_abcdefghijklmnopqrstuv");
    assert.equal(screen.queryByText("Moving to Target Computer"), null);
  });
}

for (const [state, extra] of [
  ["starting", { failureReason: "auto_start_failed" }],
  ["cancel_requested_pre_flip", { cancelNeedsAttention: true }],
  ["cancel_requested_post_flip", { cancelNeedsAttention: true }],
] as const) {
  test(`${state} needs-attention presentation never uses the active moving header`, async () => {
    const serverId = `server-migration-header-attention-${state}`;
    const agent = seedPanelState(serverId);
    stubAgentMigrationStatus({
      agentId: "agent-1",
      migrationRef: "mig_abcdefghijklmnopqrstuv",
      state,
      revision: 9,
      sourceMachineId: "source-machine",
      targetMachineId: "target-machine",
      updatedAt: "2026-07-20T08:02:00.000Z",
      ...extra,
    });
    stubMigrationFeatureFlag(serverId);

    renderPanel(agent);

    assert.ok(await screen.findByText("Migration to Target Computer needs attention"));
    assert.equal(screen.queryByText("Moving to Target Computer"), null);
  });
}

test("Cancel failure refreshes status and never presents terminal success", { timeout: 8_000 }, async () => {
  const agent = seedPanelState("server-migration-cancel-failure");
  const migrationRef = "mig_abcdefghijklmnopqrstuv";
  const active = {
    agentId: "agent-1",
    migrationRef,
    state: "arriving",
    revision: 7,
    sourceMachineId: "source-machine",
    targetMachineId: "target-machine",
    flippedAt: "2026-07-20T08:00:00.000Z",
    updatedAt: "2026-07-20T08:01:00.000Z",
  };
  let statusCalls = 0;
  stubAgentMigrationStatus(active);
  const statusGet = api.get;
  api.get = async (url: string) => {
    if (url === "/agents/agent-1/migration") statusCalls += 1;
    return statusGet(url);
  };
  api.post = async (url: string) => {
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: true }] } } as never;
    }
    if (url === "/agents/agent-1/migration/cancel") {
      throw { response: { data: { code: "MIGRATION_REVISION_STALE" } } };
    }
    throw new Error(`unexpected POST ${url}`);
  };

  renderPanel(agent);

  fireEvent.click(await screen.findByRole("button", { name: "Cancel migration" }));
  const dialog = screen.getByRole("dialog", { name: "Cancel migration?" });
  assert.ok(within(dialog).getByText("Safe cancellation"));
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel migration" }));
  await within(dialog).findByText(/migration changed before cancellation was submitted/i);
  await waitFor(() => assert.equal(statusCalls, 2));
  assert.equal(screen.queryByText("Migration canceled"), null);
  assert.ok(within(dialog).getByRole("button", { name: "Cancel migration" }));
});

test("migration profile entry shows a retryable automatic-start failure after arrival", async () => {
  const agent = seedPanelState("server-auto-start-failure");
  api.get = async (url: string) => {
    if (url === "/agents/agent-1/migration") {
      return {
        data: {
          migration: {
            agentId: "agent-1",
            migrationRef: "mig_abcdefghijklmnopqrstuv",
            state: "starting",
            sourceMachineId: "source-machine",
            targetMachineId: "target-machine",
            failureReason: "auto_start_failed",
            arrivedAt: "2026-07-14T06:00:00.000Z",
          },
        },
      } as never;
    }
    return { data: { reminders: [] } } as never;
  };
  api.post = async (url: string, body?: unknown) => {
    if (url === "/feature-flags/evaluate") {
      assert.deepEqual(body, {
        serverId: "server-auto-start-failure",
        platform: "web",
        keys: REGISTERED_SERVER_FEATURE_FLAG_KEYS,
      });
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: true }] } } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };

  renderPanel(agent);

  await screen.findByText("Agent did not start");
  assert.ok(screen.getByText("The workspace moved to Target Computer, but the agent did not start automatically."));
  assert.ok(screen.getByText("auto_start_failed"));
  assert.equal(screen.getByRole("button", { name: "Migration in progress" }).hasAttribute("disabled"), true);
});

test("migration profile entry translates bundle-too-large wire payload without exposing it", async () => {
  const agent = seedPanelState("server-bundle-too-large");
  const wireMessage = "MIGRATION_OBJECT_STORE_BUNDLE_TOO_LARGE:actualBytes=3690465725:maxBytes=3221225472:topEntries=.git%2F,2147483648;archive.tar,1073741824;media%2F,536870912";
  api.get = async (url: string) => {
    if (url === "/agents/agent-1/migration") {
      return {
        data: {
          migration: {
            agentId: "agent-1",
            migrationRef: "mig_abcdefghijklmnopqrstuv",
            state: "failed",
            sourceMachineId: "source-machine",
            targetMachineId: "target-machine",
            failureReason: "MIGRATION_OBJECT_STORE_BUNDLE_TOO_LARGE",
            abortReason: null,
            transportErrorCode: "MIGRATION_OBJECT_STORE_BUNDLE_TOO_LARGE",
            transportErrorMessage: wireMessage,
          },
        },
      } as never;
    }
    return { data: { reminders: [] } } as never;
  };
  api.post = async (url: string, body?: unknown) => {
    if (url === "/feature-flags/evaluate") {
      assert.deepEqual(body, {
        serverId: "server-bundle-too-large",
        platform: "web",
        keys: REGISTERED_SERVER_FEATURE_FLAG_KEYS,
      });
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: true }] } } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };

  renderPanel(agent);

  await screen.findByText("Migration failed");
  assert.ok(screen.getByText("The compressed migration bundle exceeded the 3 GiB limit. Largest workspace items before compression: .git/ (2 GiB), archive.tar (1 GiB), media/ (0.5 GiB). Ask the agent to inspect its workspace and remove unneeded large files, then try again."));
  assert.ok(screen.getByText("MIGRATION_OBJECT_STORE_BUNDLE_TOO_LARGE"));
  assert.equal(screen.queryByText(wireMessage), null);
  assert.equal(document.body.textContent?.includes("actualBytes="), false);
  assert.equal(document.body.textContent?.includes("maxBytes="), false);
});

test("migration profile entry fails closed when a new wire error has no copy yet", async () => {
  const agent = seedPanelState("server-unknown-migration-error");
  const wireMessage = "MIGRATION_FUTURE_FAILURE:quotedTable=secrets:params=token";
  api.get = async (url: string) => {
    if (url === "/agents/agent-1/migration") {
      return {
        data: {
          migration: {
            agentId: "agent-1",
            migrationRef: "mig_abcdefghijklmnopqrstuv",
            state: "failed",
            sourceMachineId: "source-machine",
            targetMachineId: "target-machine",
            failureReason: "MIGRATION_FUTURE_FAILURE",
            abortReason: null,
            transportErrorCode: "MIGRATION_FUTURE_FAILURE",
            transportErrorMessage: wireMessage,
          },
        },
      } as never;
    }
    return { data: { reminders: [] } } as never;
  };
  api.post = async (url: string, body?: unknown) => {
    if (url === "/feature-flags/evaluate") {
      assert.deepEqual(body, {
        serverId: "server-unknown-migration-error",
        platform: "web",
        keys: REGISTERED_SERVER_FEATURE_FLAG_KEYS,
      });
      return { data: { evaluations: [{ key: AGENT_MIGRATION_FEATURE_FLAG_KEY, enabled: true }] } } as never;
    }
    throw new Error(`unexpected POST ${url}`);
  };

  renderPanel(agent);

  await screen.findByText("The migration could not be completed. Make sure both computers are online, then try again.");
  assert.ok(screen.getByText("MIGRATION_FUTURE_FAILURE"));
  assert.equal(screen.queryByText(wireMessage), null);
  assert.equal(document.body.textContent?.includes("quotedTable="), false);
  assert.equal(document.body.textContent?.includes("params="), false);
});
