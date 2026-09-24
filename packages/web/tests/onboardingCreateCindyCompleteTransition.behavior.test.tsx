import "./helpers/domSetup";

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ReactElement } from "react";
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import type { RenderOptions } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { getDefaultModel, getModelLabel } from "@botiverse/raft-shared";
import type { RuntimeSelectionOption } from "@botiverse/raft-shared";
import CreateAgentDialog from "../src/components/agent/CreateAgentDialog";
import api from "../src/api/client";
import { useAgentStore } from "../src/store/agentStore";
import type { Agent } from "../src/store/agentStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMachineStore } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";
import { TestIntlProvider } from "./helpers/intl";

function render(ui: ReactElement, options?: RenderOptions) {
  return rtlRender(<TestIntlProvider>{ui}</TestIntlProvider>, options);
}

const originalGet = api.get;
const originalPost = api.post;

const CLAUDE_RUNTIME_OPTION: RuntimeSelectionOption = {
  runtimeId: "claude",
  capabilityStatus: "available",
  admissionStatus: "available_for_new",
  admissionReason: null,
  current: false,
  availableForNew: true,
  manageableForCurrentAgent: false,
  canSelectInThisContext: true,
};

function runtimeOption(runtimeId: string): RuntimeSelectionOption {
  return {
    ...CLAUDE_RUNTIME_OPTION,
    runtimeId,
  };
}

function stubOnboardingGet(modelPayload: unknown = {
  kind: "live",
  value: { models: [{ id: "opus", label: "Claude Opus" }], default: "opus" },
}) {
  api.get = (async (url: string) => url.endsWith("/runtime-options")
    ? { data: { context: "new_agent", machineId: "machine-1", options: [CLAUDE_RUNTIME_OPTION] } }
    : { data: modelPayload }) as typeof api.get;
}

function stubOnboardingCatalog(runtimeIds: readonly string[]) {
  api.get = (async (url: string) => {
    if (url.endsWith("/runtime-options")) {
      return {
        data: {
          context: "new_agent",
          machineId: "machine-1",
          options: runtimeIds.map(runtimeOption),
        },
      };
    }
    const runtime = url.split("/").at(-1);
    const codexDefault = getDefaultModel("codex");
    const catalog = runtime === "codex"
      ? { models: [{ id: codexDefault, label: getModelLabel("codex", codexDefault) }], default: codexDefault }
      : runtime === "grok"
        ? { models: [{ id: "grok-4.5", label: "Grok 4.5" }], default: "grok-4.5" }
        : runtime === "builtin"
          ? { models: [{ id: "openai/gpt-5.5", label: "GPT-5.5" }], default: "openai/gpt-5.5" }
          : { models: [{ id: "opus", label: "Claude Opus" }], default: "opus" };
    return { data: { kind: "live", value: catalog } };
  }) as typeof api.get;
}

async function clickCreateCindy() {
  const button = screen.getByRole("button", { name: "Create Cindy" });
  await waitFor(() => assert.equal((button as HTMLButtonElement).disabled, false));
  fireEvent.click(button);
}

function makeAgent(): Agent {
  return {
    id: "agent-cindy",
    serverId: "server-1",
    name: "Cindy",
    displayName: "Cindy",
    avatarUrl: "pixel:mug",
    description: "Onboarding Assistant",
    status: "starting",
    model: "claude-opus-4-1-20250805",
    runtime: "claude",
    serverRole: null,
    runtimeConfig: null,
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
    createdAt: "2026-07-11T00:00:00.000Z",
  };
}

function seedStores(runtimes: string[] = ["claude"]) {
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
      createdAt: "2026-07-11T00:00:00.000Z",
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
      daemonVersion: "0.72.6",
      lastHeartbeat: "2026-07-11T00:00:00.000Z",
      createdAt: "2026-07-11T00:00:00.000Z",
    }],
  } as never);
  useChannelStore.setState({
    channels: [{
      id: "channel-onboarding-owner",
      name: "onboarding-owner",
      description: null,
      type: "channel",
      createdAt: "2026-07-11T00:00:00.000Z",
    }],
  } as never);
  useAgentStore.setState({ agents: [], loading: false } as never);
}

afterEach(() => {
  cleanup();
  api.get = originalGet;
  api.post = originalPost;
  useAgentStore.setState(useAgentStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useMachineStore.setState(useMachineStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
});

test("Create Cindy posts setup complete after creating the official onboarding agent", async () => {
  seedStores();
  const posts: Array<{ url: string; body: unknown }> = [];
  let closed = false;

  stubOnboardingGet();
  api.post = (async (url: string, body?: unknown) => {
    posts.push({ url, body });
    if (url === "/agents") return { data: makeAgent() };
    if (url === "/servers/server-1/setup-transition") return { data: { surface: "complete" } };
    throw new Error(`Unexpected POST ${url}`);
  }) as typeof api.post;

  render(
    <MemoryRouter initialEntries={["/s/launch"]}>
      <CreateAgentDialog onboarding onClose={() => { closed = true; }} />
    </MemoryRouter>,
  );

  await clickCreateCindy();

  await waitFor(() => {
    const agentPosts = posts.filter((post) => post.url === "/agents");
    const setupPosts = posts.filter(
      (post) => post.url === "/servers/server-1/setup-transition",
    );
    assert.equal(closed, true);
    assert.equal(agentPosts.length, 1);
    assert.equal((agentPosts[0]?.body as { name?: string }).name, "Cindy");
    assert.equal((agentPosts[0]?.body as { onboarding?: boolean }).onboarding, true);
    assert.equal((agentPosts[0]?.body as { avatarUrl?: string }).avatarUrl, "pixel:mug");
    assert.equal(setupPosts.length, 1);
    assert.deepEqual(setupPosts[0]?.body, { action: "complete" });
  });
});

test("Create Cindy locks the official identity, prefers Claude regardless of catalog order, and keeps technical controls out", async () => {
  seedStores(["builtin", "grok", "codex", "claude"]);
  stubOnboardingCatalog(["builtin", "grok", "codex", "claude"]);

  render(
    <MemoryRouter initialEntries={["/s/launch"]}>
      <CreateAgentDialog onboarding onClose={() => undefined} />
    </MemoryRouter>,
  );

  await waitFor(() => {
    const selects = screen.getAllByRole("combobox");
    assert.match(selects[0]?.textContent ?? "", /Claude Code/);
    assert.ok(selects.some((select) => /Claude Opus/.test(select.textContent ?? "")));
  });
  assert.ok(screen.getAllByText("Cindy").length > 0);
  assert.equal(screen.queryAllByRole("textbox").length, 0);
  assert.equal(screen.queryByRole("button", { name: "More" }), null);
  assert.equal(screen.queryByText("Claude Command"), null);
});

test("Create Cindy falls back from unavailable Claude to Codex with the current SSOT model", async () => {
  seedStores(["builtin", "grok", "codex"]);
  stubOnboardingCatalog(["builtin", "grok", "codex"]);

  render(
    <MemoryRouter initialEntries={["/s/launch"]}>
      <CreateAgentDialog onboarding onClose={() => undefined} />
    </MemoryRouter>,
  );

  await waitFor(() => {
    const selects = screen.getAllByRole("combobox");
    assert.match(selects[0]?.textContent ?? "", /Codex/);
    const expected = getModelLabel("codex", getDefaultModel("codex"));
    assert.ok(selects.some((select) => select.textContent?.includes(expected)));
  });
});

test("Create Cindy Later uses the supplied onboarding defer action without creating an agent", async () => {
  seedStores();
  const posts: Array<{ url: string; body: unknown }> = [];
  let laterCalls = 0;

  stubOnboardingGet({ kind: "no_models" });
  api.post = (async (url: string, body?: unknown) => {
    posts.push({ url, body });
    throw new Error(`Unexpected POST ${url}`);
  }) as typeof api.post;

  render(
    <MemoryRouter initialEntries={["/s/launch"]}>
      <CreateAgentDialog
        onboarding
        onboardingShell="step"
        onClose={() => undefined}
        onOnboardingLater={() => {
          laterCalls += 1;
        }}
      />
    </MemoryRouter>,
  );

  fireEvent.click(screen.getByRole("button", { name: "I'll set this up myself" }));

  assert.equal(laterCalls, 1);
  assert.deepEqual(posts, []);
});

test("Create Cindy retries setup complete without creating a duplicate agent after typed failure", async () => {
  seedStores();
  const posts: Array<{ url: string; body: unknown }> = [];
  let completeAttempts = 0;
  let closed = false;

  stubOnboardingGet();
  api.post = (async (url: string, body?: unknown) => {
    posts.push({ url, body });
    if (url === "/agents") return { data: makeAgent() };
    if (url === "/servers/server-1/setup-transition") {
      completeAttempts += 1;
      if (completeAttempts === 1) {
        throw {
          response: {
            status: 409,
            data: { error: "OFFICIAL_ONBOARDING_AGENT_NOT_USABLE" },
          },
        };
      }
      return { data: { surface: "complete" } };
    }
    throw new Error(`Unexpected POST ${url}`);
  }) as typeof api.post;

  render(
    <MemoryRouter initialEntries={["/s/launch"]}>
      <CreateAgentDialog onboarding onClose={() => { closed = true; }} />
    </MemoryRouter>,
  );

  await clickCreateCindy();

  await screen.findByText(/Cindy was created, but setup could not finish yet/);
  assert.equal(closed, false);

  fireEvent.click(screen.getByRole("button", { name: "Finish Setup" }));

  await waitFor(() => {
    assert.equal(closed, true);
    assert.equal(posts.filter((post) => post.url === "/agents").length, 1);
    assert.equal(posts.filter((post) => post.url === "/servers/server-1/setup-transition").length, 2);
  });
});
