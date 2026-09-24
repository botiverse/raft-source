import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { TestContext } from "node:test";
import { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import api from "../src/api/client";
import { AgentDmRow, getSidebarDragItemTransform, getSidebarSortableItemTransform } from "../src/components/layout/Sidebar";
import Sidebar from "../src/components/layout/Sidebar";
import { TestIntlProvider } from "./helpers/intl";
import type { Agent } from "../src/store/agentStore";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import type { Channel } from "../src/store/channelStore";
import { useChannelStore } from "../src/store/channelStore";
import { useInboxStore } from "../src/store/inboxStore";
import { useMessageStore } from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";
import { useUIStore } from "../src/store/uiStore";

describe("agent pinned DM profile behavior", { concurrency: false }, () => {

test("sidebar sortable items clamp horizontal drag unless the pinned surface opts in", () => {
  const transform = { x: 24, y: 12, scaleX: 1, scaleY: 1 };

  assert.equal(getSidebarSortableItemTransform(null), null);
  assert.deepEqual(getSidebarSortableItemTransform(transform), { x: 0, y: 12, scaleX: 1, scaleY: 1 });
  assert.deepEqual(getSidebarSortableItemTransform(transform, true), transform);

  assert.equal(getSidebarDragItemTransform(null), null);
  assert.deepEqual(getSidebarDragItemTransform(transform), { x: 0, y: 12, scaleX: 1, scaleY: 1 });
  assert.deepEqual(getSidebarDragItemTransform(transform, true), transform);
});

afterEach(async () => {
  useServerStore.setState({ current: null });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  cleanup();
  useMessageStore.setState({ unreadCounts: {}, drafts: {} });
  useAgentStore.setState({ agents: [], agentActivities: {} });
  useChannelStore.setState({ channels: [], dmChannels: [], channelActivity: {}, loading: true });
  useServerStore.setState({
    current: null,
    members: [],
    sidebarOrder: {
      channelOrder: [],
      agentOrder: [],
      dmOrder: [],
      channelSortMode: "manual",
      jointChannelSortMode: "manual",
      dmSortMode: "manual",
      pinnedSortMode: "manual",
      pinned: [],
      pinnedChannelIds: [],
      pinnedAgentIds: [],
      pinnedOrder: [],
      hiddenDmIds: [],
      channelPanelTabOrder: [],
      agentPanelTabOrder: [],
      customSections: [],
      sectionOrder: ["system:pinned", "system:joint", "system:channels", "system:dms"],
      sectionPlacements: [],
      sectionsVersion: 0,
      pinnedVersion: 0,
    },
  });
  useAuthStore.setState({ user: null });
  useUIStore.setState({ sidebarOpen: false });
  useInboxStore.setState({ items: [], loadInbox: async () => {} });
});

const noop = () => {};

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    name: "agent-name",
    displayName: "Agent fallback",
    avatarUrl: "https://example.com/agent.png",
    description: "agent fallback description",
    status: "offline",
    model: "gpt",
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
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function dm(overrides: Partial<Channel> = {}): Channel {
  return {
    id: "dm-1",
    name: "Agent DM",
    description: null,
    type: "dm",
    createdAt: "2026-01-01T00:00:00.000Z",
    peerType: "agent",
    peerId: "agent-1",
    peerName: "dm-peer-name",
    peerDisplayName: "DM profile",
    peerDescription: "DM source description",
    peerAvatarUrl: "https://example.com/dm.png",
    ...overrides,
  };
}

function renderAgentRow(props: {
  rowAgent?: Agent;
  rowDm?: Channel;
  dmId?: string;
  selected?: boolean;
  allowWrap?: boolean;
}) {
  const longPress = () => ({});
  return render(
    <TestIntlProvider>
      <AgentDmRow
        agent={props.rowAgent ?? agent()}
        dmId={props.dmId ?? props.rowDm?.id}
        dm={props.rowDm}
        selected={props.selected ?? false}
        menuOpen={false}
        onSelect={noop}
        onContextMenu={noop}
        makeLongPress={longPress}
        allowWrap={props.allowWrap}
      />
    </TestIntlProvider>,
  );
}

test("homepage agent DM keeps online presence static while busy presence still pulses", () => {
  const rowAgent = agent({ status: "active" });
  useAgentStore.setState({ agents: [rowAgent], agentActivities: {} });

  const { container, rerender } = renderAgentRow({ rowAgent, rowDm: dm() });
  const onlineDot = container.querySelector(
    '[data-sidebar-avatar-badge-shell="true"] span[title]',
  );
  assert.ok(onlineDot, "agent DM should render its presence dot");
  assert.equal(
    onlineDot.classList.contains("animate-pulse"),
    false,
    "online presence in the homepage DM list should be static",
  );

  act(() => {
    useAgentStore.setState({
      agentActivities: {
        [rowAgent.id]: {
          activity: "working",
          activityDetail: "Working",
          detailKind: "none",
        },
      },
    });
  });
  rerender(
    <TestIntlProvider>
      <AgentDmRow
        agent={rowAgent}
        dmId="dm-1"
        dm={dm()}
        selected={false}
        menuOpen={false}
        onSelect={noop}
        onContextMenu={noop}
        makeLongPress={() => ({})}
      />
    </TestIntlProvider>,
  );
  const workingDot = container.querySelector(
    '[data-sidebar-avatar-badge-shell="true"] span[title]',
  );
  assert.ok(workingDot, "working agent DM should keep its presence dot");
  assert.equal(
    workingDot.classList.contains("animate-pulse"),
    true,
    "thinking/working activity should retain the existing pulse",
  );
});

function seedCurrentUser() {
  useAuthStore.setState({
    user: {
      id: "user-1",
      email: "dev@example.com",
      gravatarHash: "",
      name: "developer",
      displayName: "Developer",
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
}

let serverSeedSequence = 0;

function seedServerOrder(overrides: Partial<ReturnType<typeof useServerStore.getState>["sidebarOrder"]>) {
  serverSeedSequence += 1;
  const serverId = `server-${serverSeedSequence}`;

  useServerStore.setState((state) => ({
    current: {
      id: serverId,
      name: "Dev",
      slug: "dev",
      role: "owner",
      avatarUrl: null,
      hideHumansFromMembers: false,
    },
    members: [],
    sidebarOrder: {
      channelOrder: [],
      agentOrder: [],
      dmOrder: [],
      channelSortMode: "manual",
      jointChannelSortMode: "manual",
      dmSortMode: "manual",
      pinnedSortMode: "manual",
      pinned: [],
      pinnedChannelIds: [],
      pinnedAgentIds: [],
      pinnedOrder: [],
      hiddenDmIds: [],
      channelPanelTabOrder: [],
      agentPanelTabOrder: [],
      customSections: [],
      sectionOrder: ["system:pinned", "system:joint", "system:channels", "system:dms"],
      sectionPlacements: [],
      sectionsVersion: 0,
      pinnedVersion: 0,
      ...overrides,
    },
    serverEpoch: state.serverEpoch + 1,
  }));
}

function seedMember(userId: string, displayName: string) {
  useServerStore.setState((state) => ({
    members: [{
      userId,
      email: null,
      gravatarHash: "",
      name: displayName.toLowerCase().replace(/\s+/g, "-"),
      displayName,
      description: null,
      avatarUrl: null,
      role: "member",
      joinedAt: "2026-01-01T00:00:00.000Z",
    }],
    sidebarOrder: state.sidebarOrder,
  }));
}

function mockSidebarOrderPatch(t: TestContext) {
  t.mock.method(api, "patch", async (_url: string, body?: unknown) => {
    return { data: body } as Awaited<ReturnType<typeof api.patch>>;
  });
}

test("pinned agent row renders live agent identity instead of a stale DM avatar", () => {
  const { container } = renderAgentRow({ rowDm: dm() });

  assert.ok(screen.getByText("Agent fallback"));
  assert.ok(screen.getByText("agent fallback description"));
  assert.equal(container.querySelector('img[alt="Agent avatar"]')?.getAttribute("src"), "https://example.com/agent.png");
  assert.equal(container.querySelectorAll(".lucide-pencil").length, 0);
});

test("pinned agent row falls back to the agent profile and selected=false without a DM", () => {
  const { container } = renderAgentRow({
    rowAgent: agent({
      displayName: null,
      name: "agent-name",
      description: null,
      avatarUrl: null,
    }),
    rowDm: undefined,
    dmId: undefined,
    selected: false,
  });

  assert.ok(screen.getByText("agent-name"));
  assert.equal(screen.queryByText("agent fallback description"), null);
  assert.equal(container.querySelector(".text-black\\/40"), null);
  assert.equal(container.querySelectorAll(".lucide-pencil").length, 0);
  assert.equal(container.querySelector("button")?.getAttribute("aria-current"), null);
  const className = container.querySelector("button")?.className ?? "";
  assert.doesNotMatch(className, /bg-brutal-pink/);
  assert.doesNotMatch(className, /font-bold/);
});

test("pinned agent row shows draft state for its own DM id", () => {
  useMessageStore.setState({ unreadCounts: {}, drafts: { "dm-1": "draft text" } });
  const { container } = renderAgentRow({ rowDm: dm() });

  assert.equal(container.querySelectorAll(".lucide-pencil").length, 1);
});

test("pinned agent row bolds its name only when its DM has unread", () => {
  useMessageStore.setState({ unreadCounts: { "dm-1": 2 }, drafts: {} });
  const { container } = renderAgentRow({ rowDm: dm() });

  const name = screen.getByText("Agent fallback");
  assert.match(name.className, /font-bold/);
  assert.ok(container.textContent?.includes("2"));
});

test("pinned agent row leaves its name unbolded when its DM has no unread", () => {
  useMessageStore.setState({ unreadCounts: {}, drafts: {} });
  renderAgentRow({ rowDm: dm() });

  const name = screen.getByText("Agent fallback");
  assert.doesNotMatch(name.className, /font-bold/);
  assert.doesNotMatch(name.className, /Stryker was here/);
});

test("pinned agent row selected state follows the matching DM id", () => {
  const { container } = renderAgentRow({ rowDm: dm(), selected: true });

  const className = container.querySelector("button")?.className ?? "";
  assert.match(className, /bg-brutal-pink/);
  assert.match(className, /font-bold/);
});

test("pinned agent row centers its trailing status independently of wrapped content", () => {
  const { container } = renderAgentRow({ rowDm: dm(), allowWrap: true });

  const row = container.querySelector("button");
  assert.match(row?.className ?? "", /items-start/, "wrapped pinned rows top-align their variable-height content");

  const trailingIndicators = row?.lastElementChild;
  assert.ok(trailingIndicators, "pinned agent row should render its trailing status group");
  assert.match(
    trailingIndicators.className,
    /self-center/,
    "the status group must center itself against the full pinned row instead of inheriting the content top edge",
  );
});

test("Sidebar renders a pinned agent row from live agent identity instead of the DM snapshot", async () => {
  const rowAgent = agent({
    id: "agent-1",
    name: "agent-fallback-name",
    displayName: "Agent fallback",
    description: "agent fallback description",
    avatarUrl: "https://example.com/agent.png",
  });
  const rowDm = dm({
    id: "dm-agent-1",
    peerId: "agent-1",
    peerName: "dm-peer-name",
    peerDisplayName: "DM profile",
    peerDescription: "DM source description",
    peerAvatarUrl: "https://example.com/dm.png",
  });

  useAuthStore.setState({
    user: {
      id: "user-1",
      email: "dev@example.com",
      gravatarHash: "",
      name: "developer",
      displayName: "Developer",
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
      id: "server-1",
      name: "Dev",
      slug: "dev",
      role: "owner",
      avatarUrl: null,
      hideHumansFromMembers: false,
    },
    members: [],
    sidebarOrder: {
      channelOrder: [],
      agentOrder: [],
      dmOrder: [],
      channelSortMode: "manual",
      jointChannelSortMode: "manual",
      dmSortMode: "manual",
      pinnedSortMode: "manual",
      pinned: [{ kind: "agent", id: "agent-1" }],
      pinnedChannelIds: [],
      pinnedAgentIds: ["agent-1"],
      pinnedOrder: ["agent-1"],
      hiddenDmIds: [],
      channelPanelTabOrder: [],
      agentPanelTabOrder: [],
      pinnedVersion: 0,
    },
  });
  useChannelStore.setState({
    channels: [],
    dmChannels: [rowDm],
    channelActivity: {},
    loading: false,
  });
  useAgentStore.setState({ agents: [rowAgent] });
  useMessageStore.setState({ unreadCounts: { "dm-agent-1": 3 }, drafts: {} });
  useInboxStore.setState({ loadInbox: async () => {} });

  const { container } = render(
    <MemoryRouter initialEntries={["/s/dev"]}>
      <TestIntlProvider>
        <Sidebar />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  const name = await screen.findByText("Agent fallback");
  assert.equal(screen.queryByText("DM source description"), null);
  assert.equal(screen.queryByText("agent fallback description"), null);
  assert.equal(container.querySelector('img[alt="Agent avatar"]')?.getAttribute("src"), "https://example.com/agent.png");
  assert.match(name.className, /font-bold/);
  assert.ok(screen.getByText("3"));
});

test("Sidebar renders a typed pinned agent ref as an agent row when the DM exists", async () => {
  const rowAgent = agent({
    id: "agent-1",
    name: "cindy",
    displayName: "Cindy",
    description: "Onboarding Assistant",
    avatarUrl: null,
  });
  const rowDm = dm({
    id: "dm-agent-1",
    peerId: "agent-1",
    peerName: "cindy",
    peerDisplayName: "Cindy",
    peerDescription: "Onboarding Assistant",
    peerAvatarUrl: null,
  });

  useAuthStore.setState({
    user: {
      id: "user-1",
      email: "dev@example.com",
      gravatarHash: "",
      name: "developer",
      displayName: "Developer",
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
      id: "server-1",
      name: "Dev",
      slug: "dev",
      role: "owner",
      avatarUrl: null,
      hideHumansFromMembers: false,
    },
    members: [],
    sidebarOrder: {
      channelOrder: [],
      agentOrder: [],
      dmOrder: [],
      channelSortMode: "manual",
      jointChannelSortMode: "manual",
      dmSortMode: "manual",
      pinnedSortMode: "manual",
      pinned: [{ kind: "agent", id: "agent-1" }],
      pinnedChannelIds: [],
      pinnedAgentIds: [],
      pinnedOrder: [],
      hiddenDmIds: [],
      channelPanelTabOrder: [],
      agentPanelTabOrder: [],
      pinnedVersion: 0,
    },
  });
  useChannelStore.setState({
    channels: [],
    dmChannels: [rowDm],
    channelActivity: {},
    loading: false,
  });
  useAgentStore.setState({ agents: [rowAgent] });
  useInboxStore.setState({ loadInbox: async () => {} });

  const { container } = render(
    <MemoryRouter initialEntries={["/s/dev"]}>
      <TestIntlProvider>
        <Sidebar />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  assert.ok(await screen.findByText("Cindy"));
  assert.equal(screen.queryByText("Onboarding Assistant"), null);
  assert.ok(container.querySelector("[data-cell-size]"), "agent DM with no custom avatar should render the pixel avatar");
  assert.equal(container.querySelector(".lucide-user"), null, "pinned agent DM must not render the human placeholder");
  assert.ok(container.querySelector("span[title]"), "pinned agent DM should render the agent activity dot");
});

test("Sidebar keeps regular agent DM descriptions sourced from the matching agent", async () => {
  const matchingAgent = agent({
    id: "agent-regular",
    name: "cindy",
    displayName: "Cindy",
    description: "Matching agent description",
    avatarUrl: null,
  });
  const wrongAgent = agent({
    id: "agent-wrong",
    name: "wrong-agent",
    displayName: "Wrong agent",
    description: "Wrong agent description",
    avatarUrl: null,
  });
  const rowDm = dm({
    id: "dm-agent-regular",
    peerId: "agent-regular",
    peerName: "cindy",
    peerDisplayName: "Cindy",
    peerDescription: "DM peer description",
    peerAvatarUrl: null,
  });

  seedCurrentUser();
  seedServerOrder({});
  useChannelStore.setState({
    channels: [],
    dmChannels: [rowDm],
    channelActivity: {},
    loading: false,
  });
  useAgentStore.setState({ agents: [wrongAgent, matchingAgent] });
  useInboxStore.setState({ loadInbox: async () => {} });

  render(
    <MemoryRouter initialEntries={["/s/dev"]}>
      <TestIntlProvider>
        <Sidebar />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  assert.ok(await screen.findByText("Cindy"));
  assert.ok(screen.getByText("Matching agent description"));
  assert.equal(screen.queryByText("Wrong agent description"), null);
  assert.equal(screen.queryByText("DM peer description"), null);
});

test("Sidebar updates a regular agent DM row when the matching agent is renamed", async () => {
  const rowAgent = agent({
    id: "agent-regular",
    name: "helper",
    displayName: "Old helper name",
    description: "Agent description",
    avatarUrl: "https://example.com/live-agent.png",
  });
  const rowDm = dm({
    id: "dm-agent-regular",
    peerId: "agent-regular",
    peerName: "helper",
    peerDisplayName: "Old helper name",
    peerDescription: "DM peer description",
    peerAvatarUrl: null,
  });

  seedCurrentUser();
  seedServerOrder({});
  useChannelStore.setState({
    channels: [],
    dmChannels: [rowDm],
    channelActivity: {},
    loading: false,
  });
  useAgentStore.setState({ agents: [rowAgent] });
  useInboxStore.setState({ loadInbox: async () => {} });

  const { container } = render(
    <MemoryRouter initialEntries={["/s/dev"]}>
      <TestIntlProvider>
        <Sidebar />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  assert.ok(await screen.findByText("Old helper name"));
  assert.equal(container.querySelector('img[alt="Agent avatar"]')?.getAttribute("src"), "https://example.com/live-agent.png");

  act(() => {
    useAgentStore.setState({
      agents: [{ ...rowAgent, displayName: "Renamed helper" }],
    });
  });

  assert.ok(screen.getByText("Renamed helper"));
  assert.equal(screen.queryByText("Old helper name"), null);
});

test("Sidebar keeps regular agent DMs stable when the matching agent has not loaded", async () => {
  const rowDm = dm({
    id: "dm-agent-missing",
    peerId: "agent-missing",
    peerName: "missing-agent",
    peerDisplayName: "Missing agent",
    peerDescription: "DM peer description",
    peerAvatarUrl: null,
  });

  seedCurrentUser();
  seedServerOrder({});
  useChannelStore.setState({
    channels: [],
    dmChannels: [rowDm],
    channelActivity: {},
    loading: false,
  });
  useAgentStore.setState({ agents: [] });
  useInboxStore.setState({ loadInbox: async () => {} });

  render(
    <MemoryRouter initialEntries={["/s/dev"]}>
      <TestIntlProvider>
        <Sidebar />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  assert.ok(await screen.findByText("Missing agent"));
  assert.equal(screen.queryByText("DM peer description"), null);
});

test("Sidebar keeps regular pinned channels on the channel row path", async () => {
  seedCurrentUser();
  seedServerOrder({
    pinned: [{ kind: "channel", id: "channel-1" }],
    pinnedChannelIds: ["channel-1"],
    pinnedOrder: ["channel-1"],
  });
  useChannelStore.setState({
    channels: [{
      id: "channel-1",
      name: "general",
      description: null,
      type: "channel",
      createdAt: "2026-01-01T00:00:00.000Z",
      joined: true,
    }],
    dmChannels: [],
    channelActivity: {},
    loading: false,
  });
  useAgentStore.setState({ agents: [] });
  useInboxStore.setState({ loadInbox: async () => {} });

  const { container } = render(
    <MemoryRouter initialEntries={["/s/dev"]}>
      <TestIntlProvider>
        <Sidebar />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  assert.ok(await screen.findByText("general"));
  assert.equal(container.querySelector("[data-cell-size]"), null);
  assert.equal(container.querySelector(".lucide-user"), null);
});

test("Sidebar keeps a pinned human DM on the human path when agent and human peer IDs collide", async () => {
  const rowDm = dm({
    id: "dm-human-1",
    peerType: "user",
    peerId: "user-2",
    peerName: "human-peer",
    peerDisplayName: "Human peer",
    peerDescription: "Human source description",
    peerAvatarUrl: null,
    peerGravatarHash: null,
  });

  seedCurrentUser();
  seedServerOrder({
    pinned: [{ kind: "human", id: "user-2" }],
    pinnedChannelIds: [],
    pinnedOrder: [],
  });
  useChannelStore.setState({
    channels: [],
    dmChannels: [rowDm],
    channelActivity: {},
    loading: false,
  });
  useAgentStore.setState({
    agents: [agent({ id: "user-2", displayName: "Colliding agent identity" })],
  });
  useInboxStore.setState({ loadInbox: async () => {} });

  const { container } = render(
    <MemoryRouter initialEntries={["/s/dev"]}>
      <TestIntlProvider>
        <Sidebar />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  assert.ok(await screen.findByText("Human peer"));
  assert.equal(screen.queryByText("Colliding agent identity"), null);
  assert.ok(screen.getByText("Human source description"));
  assert.equal(container.querySelector("[data-cell-size]"), null, "human DM must not render the agent pixel avatar");
  assert.ok(container.querySelector(".lucide-user"), "human DM without avatar or gravatar should render the human placeholder");
  assert.equal(container.querySelector('img[src*="gravatar.com/avatar/"]'), null);
});

test("Sidebar human DM prefers the uploaded peer avatar over Gravatar", async () => {
  const rowDm = dm({
    id: "dm-human-uploaded",
    peerType: "user",
    peerId: "user-uploaded",
    peerName: "uploaded-peer",
    peerDisplayName: "Uploaded peer",
    peerAvatarUrl: "/avatars/users/0123456789abcdef0123456789abcdef.webp",
    peerGravatarHash: "uploaded-peer-hash",
  });

  seedCurrentUser();
  seedServerOrder({ pinned: [{ kind: "human", id: "user-uploaded" }] });
  useChannelStore.setState({ channels: [], dmChannels: [rowDm], channelActivity: {}, loading: false });
  useAgentStore.setState({ agents: [] });
  useInboxStore.setState({ loadInbox: async () => {} });

  render(
    <MemoryRouter initialEntries={["/s/dev"]}>
      <TestIntlProvider><Sidebar /></TestIntlProvider>
    </MemoryRouter>,
  );

  const row = (await screen.findByText("Uploaded peer")).closest("button");
  assert.ok(row);
  const image = row.querySelector("img");
  assert.ok(image);
  assert.equal(image.getAttribute("src"), "/avatars/users/0123456789abcdef0123456789abcdef.webp");
});

test("Sidebar human DM falls back to the peer Gravatar when no upload exists", async () => {
  const rowDm = dm({
    id: "dm-human-gravatar",
    peerType: "user",
    peerId: "user-gravatar",
    peerName: "gravatar-peer",
    peerDisplayName: "Gravatar peer",
    peerAvatarUrl: null,
    peerGravatarHash: "peer-gravatar-hash",
  });

  seedCurrentUser();
  seedServerOrder({ pinned: [{ kind: "human", id: "user-gravatar" }] });
  useChannelStore.setState({ channels: [], dmChannels: [rowDm], channelActivity: {}, loading: false });
  useAgentStore.setState({ agents: [] });
  useInboxStore.setState({ loadInbox: async () => {} });

  render(
    <MemoryRouter initialEntries={["/s/dev"]}>
      <TestIntlProvider><Sidebar /></TestIntlProvider>
    </MemoryRouter>,
  );

  const row = (await screen.findByText("Gravatar peer")).closest("button");
  assert.ok(row);
  const image = row.querySelector("img");
  assert.ok(image);
  assert.match(image.getAttribute("src") ?? "", /^https:\/\/www\.gravatar\.com\/avatar\/peer-gravatar-hash\?s=\d+&d=404$/);
});

test("Sidebar renders pinned agent DM channels in non-manual pinned sort mode", async () => {
  const rowAgent = agent({
    id: "agent-2",
    name: "cindy",
    displayName: "Cindy",
    description: "Right agent description",
    avatarUrl: null,
  });
  const rowDm = dm({
    id: "dm-agent-2",
    peerId: "agent-2",
    peerDisplayName: "Cindy",
    peerDescription: null,
    peerAvatarUrl: null,
  });

  seedCurrentUser();
  seedServerOrder({
    pinnedSortMode: "recent",
    pinned: [{ kind: "agent", id: "agent-2" }],
    pinnedChannelIds: [],
    pinnedOrder: [],
  });
  useChannelStore.setState({
    channels: [],
    dmChannels: [rowDm],
    channelActivity: { "dm-agent-2": "2026-01-02T00:00:00.000Z" },
    loading: false,
  });
  useAgentStore.setState({
    agents: [
      agent({ id: "agent-1", displayName: "Wrong agent", description: "Wrong agent description" }),
      rowAgent,
    ],
  });
  useInboxStore.setState({ loadInbox: async () => {} });

  const { container } = render(
    <MemoryRouter initialEntries={["/s/dev"]}>
      <TestIntlProvider>
        <Sidebar />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  assert.ok(await screen.findByText("Cindy"));
  assert.equal(screen.queryByText("Right agent description"), null);
  assert.equal(screen.queryByText("Wrong agent description"), null);
  assert.ok(container.querySelector("[data-cell-size]"));
});

test("Sidebar tolerates a pinned agent DM channel before the agent list has the peer", async () => {
  const rowDm = dm({
    id: "dm-agent-missing",
    peerId: "missing-agent",
    peerDisplayName: "Cindy",
    peerDescription: null,
    peerAvatarUrl: null,
  });

  seedCurrentUser();
  seedServerOrder({
    pinned: [{ kind: "agent", id: "missing-agent" }],
    pinnedChannelIds: [],
    pinnedOrder: [],
  });
  useChannelStore.setState({
    channels: [],
    dmChannels: [rowDm],
    channelActivity: {},
    loading: false,
  });
  useAgentStore.setState({ agents: [] });
  useInboxStore.setState({ loadInbox: async () => {} });

  const { container } = render(
    <MemoryRouter initialEntries={["/s/dev"]}>
      <TestIntlProvider>
        <Sidebar />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  assert.ok(await screen.findByText("Cindy"));
  assert.ok(container.querySelector("[data-cell-size]"));
});

test("Sidebar keeps live pinned identity when a stale DM snapshot arrives and reacts to store updates", async () => {
  const rowAgent = agent({
    id: "agent-1",
    name: "agent-fallback-name",
    displayName: "Agent fallback",
    description: "agent fallback description",
  });
  const rowDm = dm({
    id: "dm-agent-1",
    peerId: "agent-1",
    peerDisplayName: "DM profile",
    peerDescription: "DM source description",
  });

  useServerStore.setState({
    current: {
      id: "server-1",
      name: "Dev",
      slug: "dev",
      role: "owner",
      avatarUrl: null,
      hideHumansFromMembers: false,
    },
    sidebarOrder: {
      channelOrder: [],
      agentOrder: [],
      dmOrder: [],
      channelSortMode: "manual",
      jointChannelSortMode: "manual",
      dmSortMode: "manual",
      pinnedSortMode: "manual",
      pinned: [{ kind: "agent", id: "agent-1" }],
      pinnedChannelIds: [],
      pinnedAgentIds: ["agent-1"],
      pinnedOrder: ["agent-1"],
      hiddenDmIds: [],
      channelPanelTabOrder: [],
      agentPanelTabOrder: [],
      pinnedVersion: 0,
    },
  });
  useChannelStore.setState({ channels: [], dmChannels: [], channelActivity: {}, loading: false });
  useAgentStore.setState({ agents: [rowAgent] });
  useInboxStore.setState({ loadInbox: async () => {} });

  const { container } = render(
    <MemoryRouter initialEntries={["/s/dev"]}>
      <TestIntlProvider>
        <Sidebar />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  assert.ok(await screen.findByText("Agent fallback"));
  assert.equal(container.querySelector('img[alt="Agent avatar"]')?.getAttribute("src"), "https://example.com/agent.png");

  act(() => {
    useChannelStore.setState({ dmChannels: [rowDm] });
  });

  assert.ok(screen.getByText("Agent fallback"));
  assert.equal(screen.queryByText("DM source description"), null);
  assert.equal(screen.queryByText("DM profile"), null);
  assert.equal(container.querySelector('img[alt="Agent avatar"]')?.getAttribute("src"), "https://example.com/agent.png");

  act(() => {
    useAgentStore.setState({
      agents: [{ ...rowAgent, avatarUrl: "https://example.com/agent-updated.png" }],
    });
  });

  assert.equal(container.querySelector('img[alt="Agent avatar"]')?.getAttribute("src"), "https://example.com/agent-updated.png");
});

test("Sidebar does not offer Archive for joint channels", async () => {
  seedCurrentUser();
  seedServerOrder({});
  useChannelStore.setState({
    channels: [{
      id: "joint-1",
      name: "partner room",
      description: null,
      type: "joint",
      createdAt: "2026-01-01T00:00:00.000Z",
      joined: true,
    }],
    dmChannels: [],
    channelActivity: {},
    loading: false,
  });
  useAgentStore.setState({ agents: [] });
  useInboxStore.setState({ loadInbox: async () => {} });

  render(
    <MemoryRouter initialEntries={["/s/dev"]}>
      <TestIntlProvider>
        <Sidebar />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  const row = await screen.findByText("partner room");
  fireEvent.contextMenu(row.closest("button")!);
  assert.ok(await screen.findByText("Mark as Unread"));
  assert.equal(screen.queryByText("Archive"), null);
});

test("Sidebar channel Move to Pinned action updates pinned order", async (t) => {
  mockSidebarOrderPatch(t);
  seedCurrentUser();
  seedServerOrder({});
  useChannelStore.setState({
    channels: [{
      id: "channel-1",
      name: "general",
      description: null,
      type: "channel",
      createdAt: "2026-01-01T00:00:00.000Z",
      joined: true,
    }],
    dmChannels: [],
    channelActivity: {},
    loading: false,
  });
  useAgentStore.setState({ agents: [] });
  useInboxStore.setState({ loadInbox: async () => {} });

  render(
    <MemoryRouter initialEntries={["/s/dev"]}>
      <TestIntlProvider>
        <Sidebar />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  const row = await screen.findByText("general");
  fireEvent.contextMenu(row.closest("button")!);
  fireEvent.click(screen.getByRole("menuitem", { name: "Move to section" }));
  const pin = within(screen.getByRole("menu", { name: "Move to section" })).getByText("Pinned");
  await act(async () => {
    fireEvent.click(pin.closest("button")!);
  });

  assert.deepEqual(useServerStore.getState().sidebarOrder.pinned, [{ kind: "channel", id: "channel-1" }]);
});

test("Sidebar channel Unpin action removes the pinned channel", async (t) => {
  mockSidebarOrderPatch(t);
  seedCurrentUser();
  seedServerOrder({
    pinned: [{ kind: "channel", id: "channel-1" }],
    pinnedChannelIds: ["channel-1"],
    pinnedOrder: ["channel-1"],
  });
  useChannelStore.setState({
    channels: [{
      id: "channel-1",
      name: "general",
      description: null,
      type: "channel",
      createdAt: "2026-01-01T00:00:00.000Z",
      joined: true,
    }],
    dmChannels: [],
    channelActivity: {},
    loading: false,
  });
  useAgentStore.setState({ agents: [] });
  useInboxStore.setState({ loadInbox: async () => {} });

  render(
    <MemoryRouter initialEntries={["/s/dev"]}>
      <TestIntlProvider>
        <Sidebar />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  const row = await screen.findByText("general");
  fireEvent.contextMenu(row.closest("button")!);
  const unpin = await screen.findByText("Unpin");
  await act(async () => {
    fireEvent.click(unpin.closest("button")!);
  });

  await waitFor(() => {
    assert.deepEqual(useServerStore.getState().sidebarOrder.pinned, []);
  });
});

test("Sidebar agent Move to Pinned action updates agent pins", async (t) => {
  mockSidebarOrderPatch(t);
  seedCurrentUser();
  seedServerOrder({});
  const rowAgent = agent({
    id: "agent-1",
    name: "cindy",
    displayName: "Cindy",
    description: "Onboarding Assistant",
    avatarUrl: null,
  });
  const rowDm = dm({
    id: "dm-agent-1",
    peerId: "agent-1",
    peerName: "cindy",
    peerDisplayName: "Cindy",
    peerDescription: "Onboarding Assistant",
    peerAvatarUrl: null,
  });
  useChannelStore.setState({
    channels: [],
    dmChannels: [rowDm],
    channelActivity: {},
    loading: false,
  });
  useAgentStore.setState({ agents: [rowAgent] });
  useInboxStore.setState({ loadInbox: async () => {} });

  render(
    <MemoryRouter initialEntries={["/s/dev"]}>
      <TestIntlProvider>
        <Sidebar />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  const row = await screen.findByText("Cindy");
  fireEvent.contextMenu(row.closest("button")!);
  fireEvent.click(screen.getByRole("menuitem", { name: "Move to section" }));
  const pin = within(screen.getByRole("menu", { name: "Move to section" })).getByText("Pinned");
  await act(async () => {
    fireEvent.click(pin.closest("button")!);
  });

  assert.deepEqual(useServerStore.getState().sidebarOrder.pinned, [{ kind: "agent", id: "agent-1" }]);
});

test("Sidebar human DM Move to Pinned action updates typed human pins", async (t) => {
  mockSidebarOrderPatch(t);
  seedCurrentUser();
  seedServerOrder({});
  seedMember("user-2", "Human peer");
  const rowDm = dm({
    id: "dm-human-1",
    peerType: "user",
    peerId: "user-2",
    peerName: "human-peer",
    peerDisplayName: "Human peer",
    peerDescription: "Human source description",
    peerAvatarUrl: null,
    peerGravatarHash: null,
  });
  useChannelStore.setState({
    channels: [],
    dmChannels: [rowDm],
    channelActivity: {},
    loading: false,
  });
  useAgentStore.setState({ agents: [] });
  useInboxStore.setState({ loadInbox: async () => {} });

  render(
    <MemoryRouter initialEntries={["/s/dev"]}>
      <TestIntlProvider>
        <Sidebar />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  const row = await screen.findByText("Human peer");
  fireEvent.contextMenu(row.closest("button")!);
  fireEvent.click(screen.getByRole("menuitem", { name: "Move to section" }));
  const pin = within(screen.getByRole("menu", { name: "Move to section" })).getByText("Pinned");
  await act(async () => {
    fireEvent.click(pin.closest("button")!);
  });

  assert.deepEqual(useServerStore.getState().sidebarOrder.pinned, [{ kind: "human", id: "user-2" }]);
});

test("Sidebar fallback DM Move to Pinned action updates typed human pins", async (t) => {
  mockSidebarOrderPatch(t);
  seedCurrentUser();
  seedServerOrder({});
  const rowDm = dm({
    id: "dm-user-fallback",
    peerType: "user",
    peerId: "user-without-member-row",
    peerName: "fallback-user",
    peerDisplayName: "Fallback DM",
    peerDescription: "Fallback description",
    peerAvatarUrl: null,
    peerGravatarHash: null,
  });
  useChannelStore.setState({
    channels: [],
    dmChannels: [rowDm],
    channelActivity: {},
    loading: false,
  });
  useAgentStore.setState({ agents: [] });
  useInboxStore.setState({ loadInbox: async () => {} });

  render(
    <MemoryRouter initialEntries={["/s/dev"]}>
      <TestIntlProvider>
        <Sidebar />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  const row = await screen.findByText("Fallback DM");
  fireEvent.contextMenu(row.closest("button")!);
  fireEvent.click(screen.getByRole("menuitem", { name: "Move to section" }));
  const pin = within(screen.getByRole("menu", { name: "Move to section" })).getByText("Pinned");
  await act(async () => {
    fireEvent.click(pin.closest("button")!);
  });

  assert.deepEqual(useServerStore.getState().sidebarOrder.pinned, [{ kind: "human", id: "user-without-member-row" }]);
});

test("Sidebar Pin for an unplaced DM survives an unrelated custom-section version advance", async (t) => {
  seedCurrentUser();
  const unrelatedPlacement = {
    kind: "channel" as const,
    id: "channel-in-project",
    sectionId: "project",
    position: 0,
  };
  seedServerOrder({
    customSections: [{ id: "project", name: "Project", emoji: null, sortMode: "manual" }],
    sectionOrder: ["system:pinned", "project", "system:joint", "system:channels", "system:dms"],
    sectionPlacements: [unrelatedPlacement],
    sectionsVersion: 6,
  });
  let persistedOrder = {
    ...useServerStore.getState().sidebarOrder,
    sectionsVersion: 8,
  };
  const patchRequests: Array<Partial<typeof persistedOrder>> = [];
  let sectionConflicts = 0;
  t.mock.method(api, "get", async () => ({ data: persistedOrder }) as Awaited<ReturnType<typeof api.get>>);
  t.mock.method(api, "patch", async (_url: string, body?: unknown) => {
    const updates = body as Partial<typeof persistedOrder>;
    patchRequests.push(updates);
    if (
      updates.sectionPlacements !== undefined
      && updates.sectionsVersion !== persistedOrder.sectionsVersion
    ) {
      sectionConflicts += 1;
      const conflict = new Error("Sidebar sections changed on another client") as Error & {
        response: { status: number };
      };
      conflict.response = { status: 409 };
      throw conflict;
    }
    persistedOrder = {
      ...persistedOrder,
      ...updates,
      pinnedVersion: persistedOrder.pinnedVersion + 1,
    };
    return { data: persistedOrder } as Awaited<ReturnType<typeof api.patch>>;
  });
  const rowDm = dm({
    id: "dm-unplaced",
    peerType: "user",
    peerId: "user-unplaced",
    peerName: "unplaced-peer",
    peerDisplayName: "Unplaced peer",
    peerDescription: null,
    peerAvatarUrl: null,
    peerGravatarHash: null,
  });
  useChannelStore.setState({
    channels: [],
    dmChannels: [rowDm],
    channelActivity: {},
    loading: false,
  });
  useAgentStore.setState({ agents: [] });
  useInboxStore.setState({ loadInbox: async () => {} });

  render(
    <MemoryRouter initialEntries={["/s/dev"]}>
      <TestIntlProvider>
        <Sidebar />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  const row = await screen.findByText("Unplaced peer");
  fireEvent.contextMenu(row.closest("button")!);
  const pin = await screen.findByRole("menuitem", { name: "Pin", exact: true });
  await act(async () => {
    fireEvent.click(pin);
  });

  await waitFor(() => {
    assert.equal(
      sectionConflicts + Number(persistedOrder.pinned.some((item) => item.kind === "human" && item.id === "user-unplaced")),
      1,
    );
  });
  const readback = (await api.get("/sidebar-order")).data;
  assert.deepEqual(
    {
      requestIncludesSectionPlacements: Object.hasOwn(patchRequests[0]!, "sectionPlacements"),
      requestIncludesSectionsVersion: Object.hasOwn(patchRequests[0]!, "sectionsVersion"),
      requestedSectionsVersion: patchRequests[0]!.sectionsVersion,
      sectionConflicts,
      readbackPinned: readback.pinned,
      clientPinned: useServerStore.getState().sidebarOrder.pinned,
    },
    {
      requestIncludesSectionPlacements: false,
      requestIncludesSectionsVersion: false,
      requestedSectionsVersion: undefined,
      sectionConflicts: 0,
      readbackPinned: [{ kind: "human", id: "user-unplaced" }],
      clientPinned: [{ kind: "human", id: "user-unplaced" }],
    },
  );
  assert.deepEqual(useServerStore.getState().sidebarOrder.sectionPlacements, [unrelatedPlacement]);
  assert.equal(useServerStore.getState().sidebarOrder.sectionsVersion, 8);
});

test("Sidebar pinned recent sort reacts to channel activity", async () => {
  seedCurrentUser();
  seedServerOrder({
    pinnedSortMode: "recent",
    pinned: [
      { kind: "channel", id: "channel-old" },
      { kind: "channel", id: "channel-new" },
    ],
    pinnedChannelIds: ["channel-old", "channel-new"],
    pinnedOrder: ["channel-old", "channel-new"],
  });
  useChannelStore.setState({
    channels: [
      {
        id: "channel-old",
        name: "older pinned channel",
        description: null,
        type: "channel",
        createdAt: "2026-01-01T00:00:00.000Z",
        joined: true,
      },
      {
        id: "channel-new",
        name: "newer pinned channel",
        description: null,
        type: "channel",
        createdAt: "2026-01-02T00:00:00.000Z",
        joined: true,
      },
    ],
    dmChannels: [],
    channelActivity: {},
    loading: false,
  });
  useAgentStore.setState({ agents: [] });
  useInboxStore.setState({ loadInbox: async () => {} });

  const { container } = render(
    <MemoryRouter initialEntries={["/s/dev"]}>
      <TestIntlProvider>
        <Sidebar />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  const channelRows = () => Array.from(container.querySelectorAll("[data-sidebar-channel-id]"))
    .map((node) => node.textContent ?? "");
  assert.match(channelRows()[0], /newer pinned channel/);

  await act(async () => {
    useChannelStore.setState({
      channelActivity: {
        "channel-old": "2026-01-03T00:00:00.000Z",
        "channel-new": "2026-01-02T00:00:00.000Z",
      },
    });
  });

  assert.match(channelRows()[0], /older pinned channel/);
});

test("Pinned rows allow long labels to wrap instead of truncating", async () => {
  const longName = "very-long-project-channel-name-that-should-wrap-in-the-sidebar-pinned-section";
  seedCurrentUser();
  seedServerOrder({
    pinned: [{ kind: "channel", id: "channel-long" }],
    pinnedChannelIds: ["channel-long"],
    pinnedOrder: ["channel-long"],
  });
  useChannelStore.setState({
    channels: [{
      id: "channel-long",
      name: longName,
      description: null,
      type: "channel",
      createdAt: "2026-01-01T00:00:00.000Z",
      joined: true,
    }],
    dmChannels: [],
    channelActivity: {},
    loading: false,
  });
  useAgentStore.setState({ agents: [] });
  useInboxStore.setState({ loadInbox: async () => {} });

  render(
    <MemoryRouter initialEntries={["/s/dev"]}>
      <TestIntlProvider>
        <Sidebar />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  const label = await screen.findByText(longName);
  assert.doesNotMatch(label.className, /truncate/);
  assert.match(label.className, /break-words/);
});

test("Pinned empty placeholder wraps without icon or dashed frame", async () => {
  seedCurrentUser();
  seedServerOrder({});
  useChannelStore.setState({
    channels: [{
      id: "channel-1",
      name: "general",
      description: null,
      type: "channel",
      createdAt: "2026-01-01T00:00:00.000Z",
      joined: true,
    }],
    dmChannels: [],
    channelActivity: {},
    loading: false,
  });
  useAgentStore.setState({ agents: [] });
  useInboxStore.setState({ loadInbox: async () => {} });

  render(
    <MemoryRouter initialEntries={["/s/dev"]}>
      <TestIntlProvider>
        <Sidebar />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  const hint = await screen.findByTestId("sidebar-pinned-empty-hint");
  const hintText = screen.getByText("Drag channels or DMs here to pin");
  assert.doesNotMatch(hintText.className, /truncate/);
  assert.match(hintText.className, /whitespace-normal/);
  assert.match(hintText.className, /break-words/);
  assert.doesNotMatch(hint.className, /border-dashed/);
  assert.doesNotMatch(hint.className, /ring-/);
  assert.equal(hint.hasAttribute("data-sidebar-section-description"), true);
  assert.match(hint.className, /(?:^|\s)text-xs(?:\s|$)/);
  assert.match(hint.className, /(?:^|\s)font-mono(?:\s|$)/);
  assert.equal(hint.querySelector(".lucide-pin"), null);
});


/**
 * A sidebar row's DOM identity must not depend on client cache state.
 *
 * `data-sidebar-channel-id` is an internal identity protocol, not a test
 * private: ordinary channel and DM rows already publish it, and the sidebar's
 * own focus/scroll code locates rows by it. It is NOT currently reachable for
 * DMs — nothing builds focus state from a DM id — so this is a consistency fix
 * for future internal consumers, not a repair of a demonstrated user-facing
 * failure. Do not restate it as fixing focus/scroll.
 *
 * The drift: `pinnedItems` picks the renderer by asking whether the agent is
 * still in the client's agent list. A hit renders `AgentDmRow`, a miss falls
 * back to the ordinary DM row. Only the latter published the attribute, so one
 * logical conversation changed DOM identity based on cache timing alone.
 *
 * Measured before the parity fix, one variable at a time:
 *
 *   pinned=true  cached=true  -> 0 rows   <- the only broken cell
 *   pinned=true  cached=false -> 1
 *   pinned=false cached=true  -> 1
 *   pinned=false cached=false -> 1
 *
 * Asserted against the rendered sidebar rather than `AgentDmRow` directly:
 * the renderer choice IS the defect, so a test mounting one renderer would pick
 * a branch itself and prove nothing.
 */
const MATRIX_AGENT_ID = "agent-identity";
const MATRIX_DM_ID = "dm-identity";

function renderPinnedAgentDmMatrix(pinned: boolean, agentStillCached: boolean) {
  const rowAgent = agent({ id: MATRIX_AGENT_ID, name: "identity", displayName: "Identity helper" });
  const rowDm = dm({ id: MATRIX_DM_ID, peerId: MATRIX_AGENT_ID, peerDisplayName: "Identity helper" });

  seedCurrentUser();
  seedServerOrder(pinned ? ({ pinned: [{ kind: "agent", id: MATRIX_AGENT_ID }] } as never) : {});
  useChannelStore.setState({
    channels: [],
    dmChannels: [rowDm],
    channelActivity: {},
    loading: false,
  });
  useAgentStore.setState({ agents: agentStillCached ? [rowAgent] : [] });
  useInboxStore.setState({ loadInbox: async () => {} });

  return render(
    <MemoryRouter initialEntries={["/s/dev"]}>
      <TestIntlProvider>
        <Sidebar />
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

describe("pinned agent DM row identity", { concurrency: false }, () => {

for (const pinned of [true, false]) {
  for (const cached of [true, false]) {
    test(
      `the same DM keeps one channel identity (pinned=${pinned}, agent cached=${cached})`,
      async () => {
        const { container } = renderPinnedAgentDmMatrix(pinned, cached);
        await screen.findAllByText("Identity helper");

        assert.equal(
          container.querySelectorAll(`[data-sidebar-channel-id="${MATRIX_DM_ID}"]`).length,
          1,
          "exactly one row must carry the DM's channel identity; 0 means the row is "
            + "unaddressable in this cache state, >1 would make it ambiguous",
        );
        // The value must be the real DM channel id. Filling the agent id here
        // would satisfy "an attribute exists" while pointing consumers at an
        // id that names no channel.
        assert.equal(
          container.querySelectorAll(`[data-sidebar-channel-id="${MATRIX_AGENT_ID}"]`).length,
          0,
          "the agent id must never stand in for a channel id",
        );
      },
    );
  }
}

test("a deleted agent's DM stays visible and its row actions stay reachable", async () => {
  // The parity fix must not be paid for by hiding history. An agent can be
  // deleted while its conversation remains meaningful, so the row has to stay
  // present and still offer its context actions.
  const { container } = renderPinnedAgentDmMatrix(true, false);
  await screen.findAllByText("Identity helper");

  const row = container.querySelector<HTMLElement>(`[data-sidebar-channel-id="${MATRIX_DM_ID}"]`);
  assert.ok(row, "the deleted agent's DM must remain in the sidebar");
  assert.equal(row.tagName, "BUTTON", "the row must remain activatable, not inert text");
  assert.ok(!row.hasAttribute("disabled"), "the row must not be disabled");

  fireEvent.contextMenu(row);
  const menu = await screen.findByRole("menuitem", { name: /Close Chat/i });
  assert.ok(menu, "row actions must stay reachable for a deleted agent's DM");
});

});

/**
 * An open DM menu must survive its peer being evicted from `members`.
 *
 * The human branch resolves the menu's identity with `members.find(...)` and
 * returns null when it misses. Everything the branch actually renders needs the
 * still-present `dmChannels` entity and `ctxMenu.id` — not the member row. So a
 * background members refresh that drops the peer unmounts the whole open menu,
 * detaching the item the user is mid-click on.
 *
 * Measured end to end in Playwright before this was written: withholding one
 * members response kept the menu alive; releasing that single peer-absent
 * response detached the exact open Close Chat node, with zero input events and
 * the DM row still present. Reopening produced a working `dm/channelId` menu,
 * so the capability is not lost — only the open surface is destroyed.
 */
test("an open human DM menu survives the peer being evicted from members", async (t) => {
  mockSidebarOrderPatch(t);
  const PEER = "peer-evicted";
  const DM_ID = "dm-peer-evicted";
  const peerDm = dm({
    id: DM_ID,
    peerType: "user",
    peerId: PEER,
    peerName: "evicted-peer",
    peerDisplayName: "Evicted Peer",
  } as never);

  seedCurrentUser();
  seedServerOrder({});
  seedMember(PEER, "Evicted Peer");
  useChannelStore.setState({ channels: [], dmChannels: [peerDm], channelActivity: {}, loading: false });
  useAgentStore.setState({ agents: [] });
  useInboxStore.setState({ loadInbox: async () => {} });

  render(
    <MemoryRouter initialEntries={["/s/dev"]}>
      <TestIntlProvider>
        <Sidebar />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  const row = await screen.findByText("Evicted Peer");
  fireEvent.contextMenu(row.closest("button")!);

  // Opened through the peer-present path, with the DM actions on it.
  assert.ok(await screen.findByText("Mark as Unread"), "menu must open with Mark as Unread");
  assert.ok(screen.getByText("Pin"), "menu must open with Pin");

  // Capture the ACTUAL nodes, not a text query. Re-querying after the eviction
  // could not tell a surviving menu from an unmounted-and-remounted one — the
  // exact distinction this test exists to make.
  const closeChatNode = screen.getByText("Close Chat").closest('[role="menuitem"]') as HTMLElement;
  assert.ok(closeChatNode, "menu must open with Close Chat");
  const menuContainer = closeChatNode.closest('[role="menu"]') ?? closeChatNode.parentElement!;
  assert.ok(menuContainer, "the Close Chat item must live in a menu container");

  // The eviction, and nothing else: no Escape, no reopen, no timer, and the DM
  // channel and sidebar order are untouched.
  await act(async () => {
    useServerStore.setState({ members: [] } as never);
  });

  // The SAME nodes must still be attached — object identity, not a fresh lookup.
  await waitFor(() => {
    assert.equal(closeChatNode.isConnected, true, "the captured Close Chat node must survive peer eviction");
  });
  assert.equal(menuContainer.isConnected, true, "the captured menu container must survive peer eviction");
  assert.ok(
    menuContainer.contains(screen.getByText("Mark as Unread")),
    "read toggle must remain inside the same menu",
  );
  assert.ok(menuContainer.contains(screen.getByText("Pin")), "pin action must remain inside the same menu");

  // Click the ORIGINALLY captured node, not one looked up after the eviction.
  await act(async () => {
    fireEvent.click(closeChatNode);
  });
  assert.deepEqual(
    useServerStore.getState().sidebarOrder.hiddenDmIds,
    [DM_ID],
    "Close Chat from the surviving menu must hide exactly this DM",
  );
});

});
