import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import "./helpers/domSetup";
import { TestIntlProvider } from "./helpers/intl";
import api from "../src/api/client";
import WikiPanel from "../src/components/wiki/WikiPanel";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMachineStore } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";
import { en as enMessages } from "../src/i18n/messages/en";

const originalGet = api.get;
const originalPost = api.post;
const en = enMessages as Record<string, string>;

afterEach(() => {
  cleanup();
  api.get = originalGet;
  api.post = originalPost;
  useServerStore.setState(useServerStore.getInitialState(), true);
  useAgentStore.setState(useAgentStore.getInitialState(), true);
  useMachineStore.setState(useMachineStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useAuthStore.setState({ user: null } as never);
});

function wikiAgent(id: string, name: string) {
  return {
    id,
    serverId: "server-1",
    name,
    displayName: name,
    avatarUrl: null,
    description: null,
    status: "starting",
    model: "opus",
    runtime: "claude",
    serverRole: null,
    runtimeConfig: null,
    lastRuntimeError: null,
    reasoningEffort: null,
    executionMode: "byoc",
    envVars: null,
    machineId: "machine-1",
    creatorType: "user",
    creatorId: "user-1",
    creator: null,
    createdAgents: [],
    deletedAt: null,
    createdAt: "2026-07-22T00:00:00.000Z",
  };
}

function seedWikiServer() {
  useAuthStore.setState({
    user: { id: "user-1", name: "Owner", displayName: "Owner" },
  } as never);
  useServerStore.setState({
    current: {
      id: "server-1",
      slug: "wiki-server",
      name: "Wiki Server",
      role: "owner",
      plan: "free",
      ownerId: "user-1",
    },
    members: [],
    billing: null,
    loadBilling: async () => undefined,
  } as never);
  useMachineStore.setState({
    machines: [{
      id: "machine-1",
      name: "Mac",
      status: "online",
      runtimes: ["claude"],
      daemonVersion: "1.0.15",
      isComputer: true,
    }],
    loadMachines: async () => undefined,
  } as never);
  useAgentStore.setState({ agents: [], loading: false } as never);
  useChannelStore.setState({
    channels: [],
    openDM: async () => ({ id: "dm-1" }),
  } as never);
}

function stubApis(setupPosts: Array<{ url: string; body: unknown }>) {
  let agentSerial = 0;
  let channelSerial = 0;
  api.get = (async (url: string) => {
    if (url === "/wiki/status") {
      return {
        data: {
          space: { status: "setup_required" as const },
          lastJob: null,
        },
      };
    }
    if (url === "/provider-connections") return { data: { connections: [], providerOptions: [] } };
    if (url.endsWith("/runtime-options")) {
      return {
        data: {
          context: "new_agent",
          machineId: "machine-1",
          options: [{
            runtimeId: "claude",
            capabilityStatus: "available",
            admissionStatus: "available_for_new",
            admissionReason: null,
            current: false,
            availableForNew: true,
            manageableForCurrentAgent: false,
            canSelectInThisContext: true,
          }],
        },
      };
    }
    if (url.includes("/runtime-models/")) {
      return { data: { kind: "live", value: { models: [{ id: "opus", label: "Claude Opus" }], default: "opus" } } };
    }
    return { data: {} };
  }) as typeof api.get;
  api.post = (async (url: string, body?: unknown) => {
    if (url === "/feature-flags/evaluate") return { data: { evaluations: [] } };
    if (url === "/agents") {
      agentSerial += 1;
      const name = (body as { name?: string })?.name || "WikiAgent";
      return { data: wikiAgent(`wiki-agent-${agentSerial}`, name) };
    }
    if (url === "/channels") {
      channelSerial += 1;
      setupPosts.push({ url, body });
      return {
        data: {
          id: `wiki-channel-${channelSerial}`,
          serverId: "server-1",
          name: (body as { name?: string })?.name || "Wiki",
          description: null,
          type: "channel",
          createdAt: "2026-07-22T00:00:00.000Z",
        },
      };
    }
    if (url === "/wiki/setup") {
      setupPosts.push({ url, body });
      return { data: {} };
    }
    return { data: {} };
  }) as typeof api.post;
}

function renderWiki() {
  return render(
    <MemoryRouter>
      <TestIntlProvider locale="en">
        <WikiPanel />
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

async function completeCreateAgentForm() {
  assert.ok(await screen.findByRole("heading", { name: /create agent/i }));
  const create = await waitFor(() => {
    const button = screen.getByRole("button", { name: "Create Agent" }) as HTMLButtonElement;
    assert.equal(button.disabled, false, "Create Agent should enable after runtime admission");
    return button;
  });
  fireEvent.click(create);
  assert.ok(await screen.findByText("@WikiAgent"));
}

async function createDedicatedWikiAgent() {
  fireEvent.click(screen.getByRole("button", { name: en["wiki.setup.createAgent"] }));
  await completeCreateAgentForm();
}

async function createDedicatedWikiChannel() {
  fireEvent.click(screen.getByRole("button", { name: "Create Wiki Channel" }));
  assert.ok(await screen.findByRole("heading", { name: en["channel.create.title"] }));
  const preselected = await waitFor(() => {
    const rows = screen.getAllByRole("button", { name: /WikiAgent/ });
    const selected = rows.filter((row) => /bg-brutal-pink/.test(row.className) && row.querySelector("svg"));
    assert.equal(selected.length, 1, "exactly the current Wiki Agent must be preselected");
    return selected[0];
  });
  assert.ok(preselected);
  fireEvent.click(screen.getByRole("button", { name: en["channel.create.title"] }));
  assert.ok(await screen.findByText("#Wiki"));
}

test("wiki setup creates dedicated Agent and channel resources instead of selecting existing ones", async () => {
  const posts: Array<{ url: string; body: unknown }> = [];
  seedWikiServer();
  stubApis(posts);
  renderWiki();

  fireEvent.click(await screen.findByRole("button", { name: "Setup Wiki" }));
  assert.ok(await screen.findByRole("heading", { name: "Setup Wiki" }));
  assert.ok(screen.getByRole("button", { name: "Create Wiki Agent" }));
  const createChannel = screen.getByRole("button", { name: "Create Wiki Channel" });
  assert.equal(createChannel.hasAttribute("disabled") || createChannel.getAttribute("aria-disabled") === "true" || (createChannel as HTMLButtonElement).disabled, true);
  assert.ok(screen.getByText("Create the Wiki Agent first so it is preselected as a channel member."));
  assert.equal(screen.getByRole("button", { name: "Finish Wiki setup" }).disabled, true);
  assert.equal(screen.queryByRole("combobox"), null);
  assert.equal(document.querySelector("select"), null);

  await createDedicatedWikiAgent();
  await createDedicatedWikiChannel();
  fireEvent.click(screen.getByRole("button", { name: en["wiki.setup.replaceAgent"] }));
  await completeCreateAgentForm();
  assert.ok(screen.getByText(en["wiki.status.notCreated"]));
  assert.equal(screen.getByRole("button", { name: "Finish Wiki setup" }).disabled, true);

  await createDedicatedWikiChannel();
  fireEvent.click(screen.getByRole("button", { name: "Finish Wiki setup" }));
  await waitFor(() => {
    const setup = posts.find((post) => post.url === "/wiki/setup");
    assert.ok(setup);
    assert.deepEqual(setup.body, {
      agentId: "wiki-agent-2",
      agentName: "WikiAgent",
      channelId: "wiki-channel-2",
      channelName: "Wiki",
    });
  });
  const channelCreates = posts.filter((post) => post.url === "/channels");
  assert.equal(channelCreates.length, 2);
  assert.deepEqual((channelCreates[0]?.body as { agentIds?: string[] }).agentIds, ["wiki-agent-1"]);
  assert.deepEqual((channelCreates[1]?.body as { agentIds?: string[] }).agentIds, ["wiki-agent-2"]);
});
