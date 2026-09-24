import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { TOPBAR_OVERFLOW_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import api from "../src/api/client";
import ChannelMembers from "../src/components/agent/ChannelMembers";
import type { Agent } from "../src/store/agentStore";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import type { Channel } from "../src/store/channelStore";
import { useChannelStore } from "../src/store/channelStore";
import type { Server, ServerMember } from "../src/store/serverStore";
import { useServerStore } from "../src/store/serverStore";
import {
  resetServerFeatureFlagsForTests,
  setServerFeatureFlagForTests,
} from "../src/store/serverFeatureFlags";
import { TestIntlProvider } from "./helpers/intl";

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

async function openAddMemberModal(channelId: string) {
  render(
    createElement(TestIntlProvider, null,
      createElement(ChannelMembers, { channelId }),
    ),
  );

  fireEvent.click(screen.getByTitle("View participants"));
  fireEvent.click(await screen.findByRole("button", { name: "Add Member" }));
}

function getCandidateRow(label: string) {
  const labelNode = screen.getByText(label);
  const row = labelNode.closest("button");
  assert.ok(row, `${label} should render inside an add-member button`);
  return row;
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

test("channel add-member candidates render descriptions as behavior, not source text", async () => {
  const channel = seedAddMemberCandidates();
  await openAddMemberModal(channel.id);

  await waitFor(() => {
    assert.ok(screen.getByText("Runtime Scout"));
  });

  const agentRow = getCandidateRow("Runtime Scout");
  assert.match(agentRow.className, /items-center/);
  const agentAvatar = agentRow.firstElementChild;
  assert.ok(agentAvatar);
  assert.match(agentAvatar.className, /self-center/);
  assert.doesNotMatch(agentAvatar.className, /mt-0\.5/);
  assert.doesNotMatch(agentAvatar.className, /self-start/);
  const agentDescription = within(agentRow).getByText("Investigates runtime regressions.");
  assert.equal(agentDescription.getAttribute("title"), "Investigates runtime regressions.");
  assert.match(agentDescription.className, /truncate/);
  assert.match(agentDescription.className, /text-xs/);

  const humanRow = getCandidateRow("Design Partner");
  assert.match(humanRow.className, /items-center/);
  const humanAvatar = humanRow.firstElementChild;
  assert.ok(humanAvatar);
  assert.match(humanAvatar.className, /self-center/);
  assert.doesNotMatch(humanAvatar.className, /mt-0\.5/);
  assert.doesNotMatch(humanAvatar.className, /self-start/);
  const humanDescription = within(humanRow).getByText("Reviews visual hierarchy before release.");
  assert.equal(humanDescription.getAttribute("title"), "Reviews visual hierarchy before release.");
  assert.match(humanDescription.className, /truncate/);
  assert.match(humanDescription.className, /text-xs/);

  const blankAgentRow = getCandidateRow("Blank Agent");
  assert.match(blankAgentRow.className, /items-center/);
  assert.doesNotMatch(blankAgentRow.className, /items-start/);
  const blankAgentAvatar = blankAgentRow.firstElementChild;
  assert.ok(blankAgentAvatar);
  assert.match(blankAgentAvatar.className, /self-center/);
  assert.doesNotMatch(blankAgentAvatar.className, /mt-0\.5/);
  assert.doesNotMatch(blankAgentAvatar.className, /self-start/);
  assert.equal(blankAgentRow.textContent, "Blank Agent");

  const blankHumanRow = getCandidateRow("No Description Human");
  assert.match(blankHumanRow.className, /items-center/);
  assert.doesNotMatch(blankHumanRow.className, /items-start/);
  const blankHumanAvatar = blankHumanRow.firstElementChild;
  assert.ok(blankHumanAvatar);
  assert.match(blankHumanAvatar.className, /self-center/);
  assert.doesNotMatch(blankHumanAvatar.className, /mt-0\.5/);
  assert.doesNotMatch(blankHumanAvatar.className, /self-start/);
  assert.equal(blankHumanRow.textContent, "No Description Human");
});

test("channel members panel submits a mixed selection in one batch request", async () => {
  const channel = seedAddMemberCandidates();
  setServerFeatureFlagForTests("server-1", TOPBAR_OVERFLOW_FEATURE_FLAG_KEY, true);
  const posts: Array<{ url: string; body: unknown }> = [];
  api.post = (async (url: string, body: unknown) => {
    posts.push({ url, body });
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

  await openAddMemberModal(channel.id);
  await screen.findByText("Runtime Scout");
  fireEvent.click(getCandidateRow("Runtime Scout"));
  fireEvent.click(getCandidateRow("Design Partner"));
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
  setServerFeatureFlagForTests("server-1", TOPBAR_OVERFLOW_FEATURE_FLAG_KEY, true);

  render(
    createElement(TestIntlProvider, null,
      createElement(ChannelMembers, { channelId: channel.id }),
    ),
  );
  fireEvent.click(await screen.findByTitle("View participants"));

  await screen.findByText("Taylor from Slack");
  assert.ok(screen.getByText("Slack participants"));
  assert.ok(screen.getByText("Slack"));
  assert.ok(screen.getByText("@taylor"));
});
