import assert from "node:assert/strict";
import "../../../../tests/helpers/domSetup";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import api from "../../../api/client";
import { ChannelMembers } from "../ChannelMembers";
import type { Agent } from "../../../store/agentStore";
import { useAgentStore } from "../../../store/agentStore";
import { useAuthStore } from "../../../store/authStore";
import type { Channel } from "../../../store/channelStore";
import { useChannelStore } from "../../../store/channelStore";
import type { Server, ServerMember } from "../../../store/serverStore";
import { useServerStore } from "../../../store/serverStore";
import {
  resetServerFeatureFlagsForTests,
} from "../../../store/serverFeatureFlags";
import { TestIntlProvider } from "../../../../tests/helpers/intl";

Element.prototype.scrollIntoView ??= () => {};

const originalGet = api.get.bind(api);
const originalPost = api.post.bind(api);

function makeServer(): Server {
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
    role: "owner",
    createdAt: "2026-07-08T00:00:00.000Z",
  };
}

function makeChannel(): Channel {
  return {
    id: "channel-1",
    serverId: "server-1",
    name: "design",
    description: null,
    type: "channel",
    createdAt: "2026-07-08T00:00:00.000Z",
    joined: true,
    channelCapabilities: { addChannelMembers: true },
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
  };
}

function makeHuman(overrides: Partial<ServerMember>): ServerMember {
  return {
    userId: "human-1",
    serverId: "server-1",
    email: "human@example.test",
    name: "human-1",
    displayName: null,
    description: null,
    avatarUrl: null,
    role: "member",
    joinedAt: "2026-07-08T00:00:00.000Z",
    ...overrides,
  };
}

function seedAddMemberCandidates() {
  const channel = makeChannel();

  api.get = (async (url: string) => {
    if (url === `/channels/${channel.id}/members`) {
      return { data: { agents: [], humans: [] } };
    }
    return { data: {} };
  }) as typeof api.get;

  useServerStore.setState({
    current: makeServer(),
    members: [
      makeHuman({
        userId: "owner-1",
        name: "owner-user",
        displayName: "Owner User",
        role: "owner",
      }),
      makeHuman({
        userId: "human-with-description",
        name: "human-with-description",
        displayName: "Design Partner",
        description: "Reviews visual hierarchy before release.",
      }),
      makeHuman({
        userId: "human-without-description",
        name: "human-without-description",
        displayName: "No Description Human",
        description: "   ",
      }),
    ],
  });
  useAuthStore.setState({ user: { id: "owner-1" } as never });
  useChannelStore.setState({
    channels: [channel],
    dmChannels: [],
    channelActivity: { [channel.id]: null },
  });
  useAgentStore.setState({
    agents: [
      makeAgent({
        id: "agent-with-description",
        name: "agent-with-description",
        displayName: "Runtime Scout",
        description: "Investigates runtime regressions.",
      }),
      makeAgent({
        id: "agent-without-description",
        name: "agent-without-description",
        displayName: "Blank Agent",
        description: "   ",
      }),
    ],
    agentActivities: {},
  });

  return channel;
}

async function openAddMemberView(channelId: string) {
  render(
    createElement(TestIntlProvider, null,
      createElement(ChannelMembers, { channelId, presentation: "page" }),
    ),
  );

  fireEvent.click(await screen.findByRole("button", { name: "Add member" }));
}

/** A candidate's row: raft-ui ChoiceList's item around its label. */
function getCandidateRow(label: string) {
  const labelNode = screen.getByText(label);
  const row = labelNode.closest<HTMLElement>("[data-slot=choice-list-item]");
  assert.ok(row, `${label} should render as a ChoiceList row`);
  return row;
}

/** The row's description lines, in order. */
function descriptionLines(row: HTMLElement) {
  return [...row.querySelectorAll<HTMLElement>("[data-slot=choice-list-description]")];
}

afterEach(() => {
  cleanup();
  api.get = originalGet as typeof api.get;
  api.post = originalPost as typeof api.post;
  useAgentStore.setState({ agents: [], agentActivities: {} });
  useChannelStore.setState({ channels: [], dmChannels: [], channelActivity: {} });
  useServerStore.setState({ current: null, members: [] });
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  resetServerFeatureFlagsForTests();
  localStorage.clear();
});

test("channel add-member candidates: a checkbox row with the avatar, the name and the description as its own line", async () => {
  const channel = seedAddMemberCandidates();
  await openAddMemberView(channel.id);

  await waitFor(() => {
    assert.ok(screen.getByText("Runtime Scout"));
  });

  // Each candidate is a checkbox named by its row's name alone; the
  // description is its own line, read as the checkbox's description.
  for (const [name, description] of [
    ["Runtime Scout", "Investigates runtime regressions."],
    ["Design Partner", "Reviews visual hierarchy before release."],
  ] as const) {
    const row = getCandidateRow(name);
    assert.ok(row.querySelector("[data-slot=choice-list-media]"), `${name} has its avatar`);
    const lines = descriptionLines(row);
    assert.deepEqual(lines.map((line) => line.textContent), [description]);
    assert.match(lines[0]!.className, /truncate/);
    const box = screen.getByRole("checkbox", { name });
    const describedBy = document.getElementById(box.getAttribute("aria-describedby") ?? "");
    assert.equal(describedBy?.textContent, description);
  }

  // A candidate with no description draws no empty line.
  for (const name of ["Blank Agent", "No Description Human"]) {
    const row = getCandidateRow(name);
    assert.deepEqual(descriptionLines(row), []);
    assert.equal(screen.getByRole("checkbox", { name }).hasAttribute("aria-describedby"), false);
  }
});

test("channel members panel submits a mixed selection in one batch request", async () => {
  const channel = seedAddMemberCandidates();
  const posts: Array<{ url: string; body: unknown }> = [];
  api.post = (async (url: string, body: unknown) => {
    if (url === `/channels/${channel.id}/members/batch`) posts.push({ url, body });
    return {
      data: {
        ok: true,
        added: {
          userIds: ["human-with-description"],
          agentIds: ["agent-with-description"],
        },
        alreadyMembers: { userIds: [], agentIds: [] },
      },
    };
  }) as typeof api.post;

  await openAddMemberView(channel.id);
  await screen.findByText("Runtime Scout");
  fireEvent.click(screen.getByRole("checkbox", { name: "Runtime Scout" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Design Partner" }));
  const confirm = screen.getByTestId("add-member-confirm");
  await waitFor(() => {
    assert.equal(confirm.textContent, "Add selected (2)");
    assert.equal(confirm.hasAttribute("disabled"), false);
  });
  fireEvent.click(confirm);

  await waitFor(() => assert.equal(posts.length, 1));
  assert.deepEqual(posts, [{
    url: `/channels/${channel.id}/members/batch`,
    body: {
      userIds: ["human-with-description"],
      agentIds: ["agent-with-description"],
    },
  }]);
});

test("channel participants distinguish Slack projections from Raft members", async () => {
  const channel = makeChannel();
  api.get = (async (url: string) => {
    if (url === `/channels/${channel.id}/members`) {
      return {
        data: {
          agents: [],
          humans: [],
          externalMembers: [{
            id: "projection-1",
            provider: "slack",
            displayName: "Taylor from Slack",
            handles: ["taylor"],
            actorKind: "human",
            avatarUrl: null,
          }],
        },
      };
    }
    return { data: {} };
  }) as typeof api.get;
  useServerStore.setState({ current: makeServer(), members: [] });
  useAuthStore.setState({ user: { id: "owner-1" } as never });
  useChannelStore.setState({
    channels: [{
      ...channel,
      bridge: {
        provider: "slack",
        providerConversationId: "C_DESIGN",
        state: "active",
      },
    }],
    dmChannels: [],
    channelActivity: { [channel.id]: null },
  });
  useAgentStore.setState({ agents: [], agentActivities: {} });

  render(
    createElement(TestIntlProvider, null,
      createElement(ChannelMembers, { channelId: channel.id, presentation: "page" }),
    ),
  );

  await screen.findByText("Taylor from Slack");
  assert.ok(screen.getByText("Slack participants"));
  assert.ok(screen.getByText("Slack"));
  assert.ok(screen.getByText("@taylor"));
});
