import assert from "node:assert/strict";
import { afterEach, test as nodeTest } from "node:test";
import "./helpers/domSetup";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { getCreatableRuntimeOptions, TOPBAR_OVERFLOW_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import api from "../src/api/client";
import ChannelMembers from "../src/components/agent/ChannelMembers";
import type { Agent } from "../src/store/agentStore";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import type { Channel } from "../src/store/channelStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMachineStore } from "../src/store/machineStore";
import type { Server, ServerMember } from "../src/store/serverStore";
import { useServerStore } from "../src/store/serverStore";
import {
  resetServerFeatureFlagsForTests,
  setServerFeatureFlagForTests,
} from "../src/store/serverFeatureFlags";
import { TestIntlProvider } from "./helpers/intl";

/**
 * Channel-settings create-agent entry (task #584; design task #1139, frozen
 * five-state mock a8fb1769 in #proj-uiux:1359ae23). The five states:
 *
 *   A  persistent secondary row at the candidate-list bottom, promising
 *      auto-join of THIS channel;
 *   B  a no-hit search steps the row up and carries the typed text as the
 *      suggested name (leading "@" stripped — display notation, not intent);
 *   C  without the createAgents capability the row stays VISIBLE but disabled
 *      with the reason — hiding it would recreate the dead end the entry
 *      exists to remove;
 *   D  create succeeded but the join failed: warning banner names the agent,
 *      says NOT to re-create it, offers retry; the agent is also staged in the
 *      ordinary add flow so either affordance completes the join;
 *   E  an invalid prefill (spaces) opens the dialog with the field already
 *      reporting — the user did not type it into that field, so silence would
 *      read as acceptance. Spaces are never rewritten for the user.
 */

// Same serialization wrapper as the other migrated behavior files: these five
// tests share zustand stores and one jsdom document, so they must not
// interleave under the vitest shim.
type TestFn = () => void | Promise<void>;
const test = (name: string, fn: TestFn) =>
  nodeTest(name, { concurrency: false }, fn);

Element.prototype.scrollIntoView ??= () => {};

const originalGet = api.get.bind(api);
const originalPost = api.post.bind(api);

function makeServer(role: Server["role"]): Server {
  return {
    id: "server-1",
    name: "Design",
    avatarUrl: null,
    slug: "design",
    ownerId: "owner-1",
    onboardingAgentId: null,
    hideHumansFromMembers: false,
    plan: "free",
    planDowngradedAt: null,
    role,
    createdAt: "2026-07-08T00:00:00.000Z",
  };
}

function makeChannel(addChannelMembers = true): Channel {
  return {
    id: "channel-1",
    serverId: "server-1",
    name: "product-design",
    description: null,
    type: "channel",
    createdAt: "2026-07-08T00:00:00.000Z",
    joined: true,
    channelCapabilities: { addChannelMembers },
    activityMuteSupported: false,
  };
}

function makeAgent(overrides: Partial<Agent>): Agent {
  return {
    id: "agent-1",
    serverId: "server-1",
    name: "agent-1",
    displayName: null,
    avatarUrl: null,
    description: null,
    status: "active",
    model: "gpt-5",
    runtime: "codex",
    serverRole: null,
    reasoningEffort: null,
    executionMode: "cloud",
    envVars: null,
    machineId: null,
    creatorType: null,
    creatorId: null,
    creator: null,
    createdAgents: [],
    deletedAt: null,
    createdAt: "2026-07-08T00:00:00.000Z",
    ...overrides,
  } as Agent;
}

function makeHuman(overrides: Partial<ServerMember>): ServerMember {
  return {
    userId: "human-1",
    serverId: "server-1",
    email: "human@example.test",
    gravatarHash: "",
    name: "human-1",
    displayName: null,
    description: null,
    avatarUrl: null,
    role: "member",
    joinedAt: "2026-07-08T00:00:00.000Z",
    ...overrides,
  };
}

type PrefetchedMembers = NonNullable<Parameters<typeof ChannelMembers>[0]["prefetchedMembers"]>;

function makePrefetched(overrides: Partial<PrefetchedMembers> = {}): PrefetchedMembers {
  return {
    channelAgents: [],
    channelHumans: [],
    channelExternalMembers: [],
    loading: false,
    addMembers: async () => ({ added: [], alreadyMembers: [] }),
    addAgent: async () => undefined,
    removeAgent: async () => undefined,
    addHuman: async () => undefined,
    removeHuman: async () => undefined,
    changeMemberRole: async () => undefined,
    roleChangeFailed: false,
    ...overrides,
  };
}

function seedStores(role: Server["role"], options: { addChannelMembers?: boolean } = {}) {
  useServerStore.setState({
    current: makeServer(role),
    members: [
      makeHuman({ userId: "owner-1", name: "owner-user", displayName: "Owner User", role: "owner" }),
      makeHuman({ userId: "human-artin", name: "artin", displayName: "artin" }),
    ],
    billing: null,
    loadBilling: async () => undefined,
  } as never);
  useAuthStore.setState({ user: { id: "owner-1" } as never });
  useChannelStore.setState({
    channels: [makeChannel(options.addChannelMembers ?? true)],
    dmChannels: [],
    channelActivity: { "channel-1": null },
  } as never);
  useAgentStore.setState({
    agents: [makeAgent({ id: "agent-scout", name: "runtime-scout", displayName: "Runtime Scout" })],
    agentActivities: {},
  } as never);
  setServerFeatureFlagForTests("server-1", TOPBAR_OVERFLOW_FEATURE_FLAG_KEY, true);
  useMachineStore.setState({
    machines: [{
      id: "machine-1",
      name: "Mac",
      description: null,
      status: "online",
      statusVersion: 1,
      apiKeyPrefix: null,
      runtimes: ["cursor"],
      hostname: "mac.local",
      os: "darwin",
      daemonVersion: "0.72.6",
      lastHeartbeat: "2026-07-14T00:00:00.000Z",
      createdAt: "2026-07-14T00:00:00.000Z",
    }],
  } as never);
  api.get = (async (url: string) => {
    if (url.endsWith("/runtime-options")) {
      const machineId = url.split("/").at(-2) ?? null;
      return {
        data: {
          context: "new_agent",
          machineId,
          options: getCreatableRuntimeOptions()
            .filter((runtime) => runtime.id === "cursor")
            .map((runtime) => ({
              runtimeId: runtime.id,
              capabilityStatus: "available",
              admissionStatus: "available_for_new",
              admissionReason: null,
              current: false,
              availableForNew: true,
              manageableForCurrentAgent: false,
              canSelectInThisContext: true,
            })),
        },
      } as never;
    }
    return { data: { models: [{ id: "auto", label: "Auto" }] } } as never;
  }) as typeof api.get;
}

function renderAddView(prefetched: PrefetchedMembers) {
  render(
    <MemoryRouter initialEntries={["/s/design"]}>
      <TestIntlProvider>
        <ChannelMembers
          channelId="channel-1"
          presentation="page"
          initialView="add"
          prefetchedMembers={prefetched}
        />
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  api.get = originalGet as typeof api.get;
  api.post = originalPost as typeof api.post;
  useAgentStore.setState({ agents: [], agentActivities: {} } as never);
  useChannelStore.setState({ channels: [], dmChannels: [], channelActivity: {} } as never);
  useServerStore.setState({ current: null, members: [] } as never);
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useMachineStore.setState({ machines: [] } as never);
  resetServerFeatureFlagsForTests();
  localStorage.clear();
});

test("A: the create entry sits at the candidate-list bottom and opens the dialog with the channel promise", async () => {
  seedStores("owner");
  renderAddView(makePrefetched());

  const list = screen.getByTestId("add-member-candidate-list");
  const entry = within(list).getByTestId("add-member-create-agent-entry");
  assert.ok(within(entry).getByText("Create a New Agent"));
  assert.ok(
    within(entry).getByText("Joins #product-design automatically after creation"),
    "the entry must state its auto-join consequence on the row itself",
  );
  // Boolean compare, never assert.equal on elements: a failing element diff
  // makes node:assert inspect the circular jsdom node and OOMs the worker.
  assert.ok(
    list.lastElementChild === entry,
    "the entry is the list's persistent bottom row, after all candidates",
  );

  fireEvent.click(entry);
  await waitFor(() => {
    assert.ok(
      screen.getByTestId("create-agent-channel-context"),
      "the dialog must carry the promise forward as a persistent context line",
    );
  });
  const contextStrip = screen.getByTestId("create-agent-channel-context");
  assert.match(contextStrip.textContent ?? "", /#product-design/);
  // The strip carries the entry's promise; the frozen mock renders it as a
  // cyan, black-bordered band — a grey caption was rejected as the weakest
  // possible carrier (Duoyu, PR #7372 design review).
  assert.match(contextStrip.className, /bg-brutal-cyan/);
  assert.match(contextStrip.className, /border-2/);
});

test("A2: with search hits, the generic row does not smuggle the search text into the dialog", async () => {
  seedStores("owner");
  renderAddView(makePrefetched());

  // "runtime" matches the seeded Runtime Scout — the row stays generic.
  fireEvent.change(screen.getByPlaceholderText("Name"), { target: { value: "runtime" } });
  const entry = screen.getByTestId("add-member-create-agent-entry");
  assert.ok(within(entry).getByText("Create a New Agent"), "row label must stay generic on a hit");

  fireEvent.click(entry);
  await waitFor(() => {
    const nameInput = document.getElementById("create-agent-name") as HTMLInputElement | null;
    assert.ok(nameInput, "the create dialog must open");
    assert.equal(nameInput.value, "", "an unpromised name must not be prefilled");
  });
});

test("B: a no-hit search steps the entry up and strips the leading @ from the suggested name", async () => {
  seedStores("owner");
  renderAddView(makePrefetched());

  fireEvent.change(screen.getByPlaceholderText("Name"), {
    target: { value: "@deploy-bot" },
  });

  const entry = screen.getByTestId("add-member-create-agent-entry");
  assert.ok(
    within(entry).getByText("Create Agent “deploy-bot”"),
    "the typed text becomes the suggested name with the display-@ removed",
  );
  assert.match(entry.className, /bg-soft-signal/, "the no-hit state promotes the entry visually");

  fireEvent.click(entry);
  await waitFor(() => {
    const nameInput = document.getElementById("create-agent-name") as HTMLInputElement | null;
    assert.ok(nameInput, "the create dialog must open");
    assert.equal(nameInput.value, "deploy-bot");
    assert.equal(nameInput.readOnly, false, "the prefilled name stays editable");
  });
});

test("C: without createAgents the entry is visible but disabled, with the reason on-screen", async () => {
  seedStores("member");
  renderAddView(makePrefetched());

  assert.ok(
    screen.queryByTestId("add-member-create-agent-entry") === null,
    "the enabled entry must not render without the createAgents capability",
  );
  const disabled = screen.getByTestId("add-member-create-agent-entry-disabled");
  assert.ok(within(disabled).getByText("Create a New Agent"));
  assert.match(
    disabled.textContent ?? "",
    /needs an owner or admin/,
    "the disabled entry must say why and name the way out",
  );
});

test("C2: without the channel member-action gate the whole add view is out of reach", () => {
  // The contract's second gate (「频道成员动作门」= canUseChannelMemberAction/
  // addChannelMembers — NOT #7315's role-actions rollout flag, which gates
  // promote/demote only) is enforced one level up: no capability, no add view,
  // and the create entry cannot exist. This tooth pins that upstream guard so
  // the entry's own createAgents check can never become the only gate.
  seedStores("owner", { addChannelMembers: false });
  renderAddView(makePrefetched());

  assert.ok(
    screen.queryByTestId("add-member-view") === null,
    "the add view itself must not render without the member-action capability",
  );
  assert.ok(screen.queryByTestId("add-member-create-agent-entry") === null);
  assert.ok(screen.queryByTestId("add-member-create-agent-entry-disabled") === null);
});

test("D: created-but-not-joined shows the warning with retry, and retry completes the join", async () => {
  seedStores("owner");
  let joinAttempts = 0;
  let failJoin = true;
  const prefetched = makePrefetched({
    // The unified facade: retry MUST come through the same batch call as
    //「添加所选」— a mock on addMembers alone therefore sees every attempt.
    addMembers: async ({ agentIds }) => {
      if (agentIds.includes("agent-new")) {
        joinAttempts += 1;
        if (failJoin) throw new Error("temporary join failure");
      }
      return { added: [], alreadyMembers: [] };
    },
  });
  useAgentStore.setState({
    createAgent: async () => makeAgent({ id: "agent-new", name: "deploy-bot" }),
  } as never);
  renderAddView(prefetched);

  fireEvent.click(screen.getByTestId("add-member-create-agent-entry"));
  const nameInput = await waitFor(() => {
    const input = document.getElementById("create-agent-name") as HTMLInputElement | null;
    assert.ok(input);
    return input;
  });
  // Same submittable-runtime recipe as createAgentValidationGating: wait for
  // the Cursor option to land before treating the form as settled.
  await waitFor(() => {
    assert.equal(
      screen.getAllByRole("combobox").some((select) => select.textContent?.includes("Cursor")),
      true,
    );
  }, { timeout: 3000 });
  fireEvent.change(nameInput, { target: { value: "deploy-bot" } });
  await waitFor(() => {
    const submit = screen.getByRole("button", { name: "Create Agent" }) as HTMLButtonElement;
    assert.equal(submit.disabled, false, "the dialog must reach a submittable state");
  }, { timeout: 3000 });
  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));

  const banner = await screen.findByTestId("add-member-create-agent-join-failed");
  assert.match(banner.textContent ?? "", /“deploy-bot” was created but could not join #product-design/);
  assert.match(
    banner.textContent ?? "",
    /do not create another one with the same name/i,
    "the banner's whole point: the agent exists — never re-create it",
  );
  assert.equal(joinAttempts, 1);

  failJoin = false;
  fireEvent.click(screen.getByTestId("add-member-create-agent-retry-join"));
  await waitFor(() => assert.equal(joinAttempts, 2));
  await waitFor(() => {
    assert.ok(
      screen.queryByTestId("add-member-create-agent-join-failed") === null,
      "a successful retry must clear the banner",
    );
  });
});

test("D2: after a failed join,「添加所选」completes it through the same batch call and clears the banner", async () => {
  seedStores("owner");
  useAgentStore.setState({
    createAgent: async () => makeAgent({ id: "agent-new", name: "deploy-bot" }),
  } as never);

  // Stateful harness: a successful batch updates channelAgents the way the
  // real hook's loadMembers refresh does, so the banner's membership-derived
  // clearing is what this test exercises — not a bespoke test-only clear.
  let failJoin = true;
  let batchCalls = 0;
  function Harness() {
    const [agents, setAgents] = useState<PrefetchedMembers["channelAgents"]>([]);
    const prefetched = makePrefetched({
      channelAgents: agents,
      addMembers: async ({ agentIds }) => {
        batchCalls += 1;
        if (failJoin) throw new Error("temporary join failure");
        setAgents(agentIds.map((id) => ({
          id,
          name: "deploy-bot",
          displayName: "deploy-bot",
          avatarUrl: null,
          description: null,
          status: "active",
          serverRole: null,
          channelRole: null,
          effectiveChannelRole: "member",
          canChangeChannelRole: false,
        }) as never));
        return { added: [], alreadyMembers: [] };
      },
    });
    return (
      <ChannelMembers
        channelId="channel-1"
        presentation="page"
        initialView="add"
        prefetchedMembers={prefetched}
      />
    );
  }
  render(
    <MemoryRouter initialEntries={["/s/design"]}>
      <TestIntlProvider>
        <Harness />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  fireEvent.click(screen.getByTestId("add-member-create-agent-entry"));
  const nameInput = await waitFor(() => {
    const input = document.getElementById("create-agent-name") as HTMLInputElement | null;
    assert.ok(input);
    return input;
  });
  await waitFor(() => {
    assert.equal(
      screen.getAllByRole("combobox").some((select) => select.textContent?.includes("Cursor")),
      true,
    );
  }, { timeout: 3000 });
  fireEvent.change(nameInput, { target: { value: "deploy-bot" } });
  await waitFor(() => {
    const submit = screen.getByRole("button", { name: "Create Agent" }) as HTMLButtonElement;
    assert.equal(submit.disabled, false);
  }, { timeout: 3000 });
  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));

  await screen.findByTestId("add-member-create-agent-join-failed");
  assert.equal(batchCalls, 1);

  // Not the retry button — the ordinary staged confirm completes the join.
  failJoin = false;
  const confirm = screen.getByTestId("add-member-confirm") as HTMLButtonElement;
  assert.equal(confirm.disabled, false, "the created agent must be staged as a selection");
  fireEvent.click(confirm);

  await waitFor(() => {
    assert.ok(
      screen.queryByTestId("add-member-create-agent-join-failed") === null,
      "membership from the SAME batch call must clear the banner",
    );
  });
  assert.equal(batchCalls, 2, "both paths must hit the one facade");
  await waitFor(() => {
    assert.ok(
      screen.queryByTestId("add-member-selected-chips") === null,
      "the staged selection clears through the ordinary confirm flow",
    );
  });
});

test("D3: while the D strip is up, a failing「添加所选」does not stack a second story", async () => {
  seedStores("owner");
  let batchCalls = 0;
  const prefetched = makePrefetched({
    addMembers: async () => {
      batchCalls += 1;
      throw new Error("temporary join failure");
    },
  });
  useAgentStore.setState({
    createAgent: async () => makeAgent({ id: "agent-new", name: "deploy-bot" }),
  } as never);
  renderAddView(prefetched);

  fireEvent.click(screen.getByTestId("add-member-create-agent-entry"));
  const nameInput = await waitFor(() => {
    const input = document.getElementById("create-agent-name") as HTMLInputElement | null;
    assert.ok(input);
    return input;
  });
  await waitFor(() => {
    assert.equal(
      screen.getAllByRole("combobox").some((select) => select.textContent?.includes("Cursor")),
      true,
    );
  }, { timeout: 3000 });
  fireEvent.change(nameInput, { target: { value: "deploy-bot" } });
  await waitFor(() => {
    const submit = screen.getByRole("button", { name: "Create Agent" }) as HTMLButtonElement;
    assert.equal(submit.disabled, false);
  }, { timeout: 3000 });
  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));

  await screen.findByTestId("add-member-create-agent-join-failed");
  assert.equal(batchCalls, 1);

  // The batch keeps failing; the user tries the ordinary confirm instead of retry.
  fireEvent.click(screen.getByTestId("add-member-confirm"));
  await waitFor(() => assert.equal(batchCalls, 2));

  // One failure, one story: the named D strip stays the only message.
  assert.ok(screen.getByTestId("add-member-create-agent-join-failed"));
  assert.ok(
    screen.queryByTestId("add-member-error") === null,
    "the generic none-added banner must not stack onto the D strip for the same failure",
  );
});

test("D4: a mixed failed batch keeps the generic banner — the strip must not swallow other members' story", async () => {
  seedStores("owner");
  const prefetched = makePrefetched({
    addMembers: async () => {
      throw new Error("temporary join failure");
    },
  });
  useAgentStore.setState({
    createAgent: async () => makeAgent({ id: "agent-new", name: "deploy-bot" }),
  } as never);
  renderAddView(prefetched);

  fireEvent.click(screen.getByTestId("add-member-create-agent-entry"));
  const nameInput = await waitFor(() => {
    const input = document.getElementById("create-agent-name") as HTMLInputElement | null;
    assert.ok(input);
    return input;
  });
  await waitFor(() => {
    assert.equal(
      screen.getAllByRole("combobox").some((select) => select.textContent?.includes("Cursor")),
      true,
    );
  }, { timeout: 3000 });
  fireEvent.change(nameInput, { target: { value: "deploy-bot" } });
  await waitFor(() => {
    const submit = screen.getByRole("button", { name: "Create Agent" }) as HTMLButtonElement;
    assert.equal(submit.disabled, false);
  }, { timeout: 3000 });
  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
  await screen.findByTestId("add-member-create-agent-join-failed");

  // The user additionally selects a human and confirms the mixed batch.
  fireEvent.click(screen.getByText("artin"));
  fireEvent.click(screen.getByTestId("add-member-confirm"));

  await screen.findByTestId("add-member-error");
  assert.ok(
    screen.getByTestId("add-member-create-agent-join-failed"),
    "the D strip stays for the agent's half of the story",
  );
});

test("E: an invalid prefill (spaces kept, not rewritten) opens the dialog already reporting", async () => {
  seedStores("owner");
  renderAddView(makePrefetched());

  fireEvent.change(screen.getByPlaceholderText("Name"), {
    target: { value: "deploy bot" },
  });
  fireEvent.click(screen.getByTestId("add-member-create-agent-entry"));

  await waitFor(() => {
    const nameInput = document.getElementById("create-agent-name") as HTMLInputElement | null;
    assert.ok(nameInput, "the create dialog must open");
    assert.equal(nameInput.value, "deploy bot", "spaces are the user's to resolve — never rewritten");
  });
  assert.ok(
    screen.getByText("Start with a letter, then letters, numbers, - or _"),
    "the invalid prefill must report from the first render, not after a submit attempt",
  );
  // "改了要说" / "不改也要说": the note names the one modification we made
  // (none here — no @) and the one we refused to make (the spaces).
  const note = screen.getByTestId("create-agent-prefill-note");
  assert.match(note.textContent ?? "", /deploy-bot/);
  assert.match(note.textContent ?? "", /deploybot/);
});

test("E2: an @-prefixed search names the strip in the dialog note", async () => {
  seedStores("owner");
  renderAddView(makePrefetched());

  fireEvent.change(screen.getByPlaceholderText("Name"), { target: { value: "@deploy-bot" } });
  fireEvent.click(screen.getByTestId("add-member-create-agent-entry"));

  await waitFor(() => {
    const note = screen.queryByTestId("create-agent-prefill-note");
    assert.ok(note, "stripping the @ must be disclosed in the dialog");
    assert.match(note.textContent ?? "", /leading @ was removed/);
  });
});
