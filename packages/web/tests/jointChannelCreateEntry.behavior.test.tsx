import assert from "node:assert/strict";
import { afterEach, test as nodeTest } from "node:test";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import api from "../src/api/client";
import CreateJointChannelDialog from "../src/components/channel/CreateJointChannelDialog";
import Sidebar from "../src/components/layout/Sidebar";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMachineStore } from "../src/store/machineStore";
import { useMessageStore } from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";
import { useWorkspaceGridNavigationStore } from "../src/components/workspace/workspaceGridNavigationStore";
import { TestIntlProvider } from "./helpers/intl";

// Mounted-DOM replacement for the sidebar/dialog half of
// tests/jointChannelCreateEntryContract.test.ts. The contracts are
// driven through the real stores: capability-gated create entry, section
// ordering, invite-draft collection, and the submit payload.
//
// The zh-cn render of the same dialog (paywall, allowance, invite numbering)
// is owned by tests/createJointChannelDialog.i18n.behavior.test.tsx; this file
// deliberately stays in en and pins the wiring the zh file does not.

type TestFn = () => void | Promise<void>;
const test = (name: string, fn: TestFn) =>
  nodeTest(name, { concurrency: false }, fn);

const originalGet = api.get;
const originalPatch = api.patch;

globalThis.IntersectionObserver = globalThis.IntersectionObserver ?? class {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
} as typeof IntersectionObserver;

afterEach(() => {
  cleanup();
  api.get = originalGet;
  api.patch = originalPatch;
  window.localStorage.clear();
  useMessageStore.setState({ unreadCounts: {}, drafts: {}, mentionFlags: {} } as never);
  useAgentStore.setState({ agents: [], agentActivities: {}, loading: true } as never);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useMachineStore.setState({ machines: [], loading: true } as never);
  useServerStore.setState(useServerStore.getInitialState(), true);
  useAuthStore.setState({ user: null, loading: false, initialized: true } as never);
  useWorkspaceGridNavigationStore.setState({ active: false, enabled: false, railMode: null } as never);
});

function installApiStub() {
  api.get = (async (url: string) => {
    if (url === "/channels/inbox") {
      return { data: { items: [], hasMore: false, totalCount: 0, totalUnreadCount: 0 } };
    }
    return { data: [] };
  }) as typeof api.get;
  api.patch = (async () => ({ data: {} })) as typeof api.patch;
}

function seedSidebar({ role = "owner" }: { role?: "owner" | "member" } = {}) {
  installApiStub();
  useAuthStore.setState({
    user: { id: "user-1", email: "owner@example.com", name: "owner", displayName: "Owner" } as never,
    loading: false,
    initialized: true,
  });
  useServerStore.setState({
    current: {
      id: "server-1",
      name: "Server",
      avatarUrl: null,
      slug: "server",
      ownerId: "user-1",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "pro",
      planDowngradedAt: null,
      role,
      createdAt: "2026-07-12T00:00:00.000Z",
    },
    servers: [],
    members: [],
    loading: false,
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
      customSections: [],
      sectionOrder: ["system:pinned", "system:joint", "system:channels", "system:dms"],
      sectionPlacements: [],
      sectionsVersion: 0,
      pinnedVersion: 0,
    },
  } as never);
  useChannelStore.setState({ channels: [], dmChannels: [], channelActivity: {}, loading: false } as never);
  useMachineStore.setState({ machines: [], loading: false } as never);
  useAgentStore.setState({ agents: [], agentActivities: {}, loading: false } as never);
}

function renderSidebar() {
  return render(
    <MemoryRouter initialEntries={["/s/server"]}>
      <TestIntlProvider locale="en">
        <Sidebar mobileInline />
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

test("the joint section's create entry is capability-gated and opens the joint dialog", async () => {
  seedSidebar({ role: "owner" });
  renderSidebar();

  const jointSection = screen.getByTestId("sidebar-section-block-joint");
  const createJoint = within(jointSection).getByRole("button", { name: "Create Joint Channel" });
  fireEvent.click(createJoint);

  // DialogCard chrome, not role="dialog": assert the dialog content directly.
  await screen.findByText("Invite servers");
  assert.ok(screen.getAllByText("Create Joint Channel").length >= 2, "dialog title and submit button");
  assert.ok(screen.getByRole("button", { name: "Add server" }));

  cleanup();

  // Members can create ordinary channels but cannot federate: the joint entry
  // must disappear while the channel one stays.
  seedSidebar({ role: "member" });
  renderSidebar();

  const memberJointSection = screen.getByTestId("sidebar-section-block-joint");
  assert.ok(
    within(memberJointSection).queryByRole("button", { name: "Create Joint Channel" }) === null,
    "members lack federateChannels, so the joint create entry must not render",
  );
  const channelSection = screen.getByTestId("sidebar-section-block-channels");
  assert.ok(
    within(channelSection).getByRole("button", { name: "Create Channel" }),
    "the ordinary channel entry stays for members",
  );
  assert.ok(screen.queryByText("Invite servers") === null, "no dialog carried over");
});

test("joint channels render in their own section above ordinary channels", () => {
  seedSidebar();
  useChannelStore.setState({
    channels: [
      {
        id: "joint-channel",
        serverId: "server-1",
        name: "joint-channel",
        type: "joint",
        joined: true,
        archivedAt: null,
        createdAt: "2026-07-12T00:00:00.000Z",
      },
      {
        id: "regular-channel",
        serverId: "server-1",
        name: "regular-channel",
        type: "public",
        joined: true,
        archivedAt: null,
        createdAt: "2026-07-12T00:00:00.000Z",
      },
    ],
  } as never);
  renderSidebar();

  const jointBlock = screen.getByTestId("sidebar-section-block-joint");
  const channelBlock = screen.getByTestId("sidebar-section-block-channels");
  assert.ok(
    jointBlock.compareDocumentPosition(channelBlock) & Node.DOCUMENT_POSITION_FOLLOWING,
    "the joint section must render above ordinary channels in document order",
  );
  assert.ok(
    Number(jointBlock.style.order) < Number(channelBlock.style.order),
    "the joint section must sort above ordinary channels in the persisted order too",
  );
  assert.ok(within(jointBlock).getByTestId("sidebar-section-toggle-joint-channels"));
  assert.ok(within(jointBlock).getByText("joint-channel"), "joint channels render in the joint section");
  assert.ok(within(channelBlock).getByText("regular-channel"));
  assert.ok(
    within(channelBlock).queryByText("joint-channel") === null,
    "joint channels must not leak into the ordinary channel section",
  );
});

function seedDialogStores({ plan = "pro" }: { plan?: "pro" | "free" } = {}) {
  useAuthStore.setState({ user: { id: "u1", name: "U" }, initialized: true } as never);
  useServerStore.setState({
    servers: [{ id: "s1", slug: "s1", name: "S", role: "owner", plan }],
    current: { id: "s1", slug: "s1", name: "S", role: "owner", plan },
    loading: false,
    members: [{ userId: "u2", name: "bob", displayName: "Bob" }],
  } as never);
  useAgentStore.setState({ agents: [] } as never);
}

function renderDialog() {
  return render(
    <TestIntlProvider locale="en">
      <MemoryRouter>
        <CreateJointChannelDialog onClose={() => undefined} />
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

test("the dialog collects at most two server invites and submits visibility joint with jointInvites", async () => {
  seedDialogStores();
  const created: Array<{ args: unknown[] }> = [];
  useChannelStore.setState({
    channels: [],
    createChannel: async (...args: unknown[]) => {
      created.push({ args });
      return { id: "joint-new", name: "partner-launch", type: "joint" };
    },
  } as never);

  renderDialog();

  // Three servers total, including this one: the dialog starts with one
  // invite draft and allows at most TWO (MAX_JOINT_CHANNEL_SERVERS - 1).
  assert.ok(screen.getByPlaceholderText("partner-workspace"), "the initial invite draft renders");
  const addServer = screen.getByRole("button", { name: "Add server" });
  fireEvent.click(addServer);
  assert.ok(screen.getByText("Server invite 1"));
  assert.ok(screen.getByText("Server invite 2"));
  assert.ok(
    (screen.getByRole("button", { name: "Add server" }) as HTMLButtonElement).disabled,
    "the third invite draft is capped by MAX_JOINT_CHANNEL_SERVERS - 1",
  );
  assert.ok(screen.getByText("Joint channels support a maximum of 3 servers, including this server."));

  fireEvent.change(screen.getByPlaceholderText("e.g. partner-launch"), { target: { value: "partner-launch" } });
  const slugInputs = screen.getAllByPlaceholderText("partner-workspace");
  const peopleInputs = screen.getAllByPlaceholderText("@admin or admin@example.com");
  assert.equal(slugInputs.length, 2);
  fireEvent.change(slugInputs[0], { target: { value: "partner-a" } });
  fireEvent.change(peopleInputs[0], { target: { value: "admin@a.example.com" } });
  fireEvent.change(slugInputs[1], { target: { value: "partner-b" } });
  fireEvent.change(peopleInputs[1], { target: { value: "admin@b.example.com" } });

  fireEvent.click(screen.getByRole("button", { name: "Create Joint Channel" }));

  await waitFor(() => assert.equal(created.length, 1));
  assert.deepEqual(created[0].args, [
    "partner-launch",
    undefined,
    {
      visibility: "joint",
      agentIds: [],
      userIds: [],
      jointInvites: [
        { targetServerSlug: "partner-a", invitedPeople: ["admin@a.example.com"] },
        { targetServerSlug: "partner-b", invitedPeople: ["admin@b.example.com"] },
      ],
    },
  ]);
});

test("a free server sees the limited-time allowance with creation left enabled", () => {
  seedDialogStores({ plan: "free" });
  useChannelStore.setState({ channels: [] } as never);

  renderDialog();

  assert.ok(screen.getByText("Free can create one Joint Channel for free for a limited time."));
  assert.ok(
    !(screen.getByRole("button", { name: "Create Joint Channel" }) as HTMLButtonElement).disabled,
    "the limited-time Free allowance must leave submit enabled",
  );
});

test("the free-limit error renders localized recovery with a billing route", async () => {
  seedDialogStores({ plan: "free" });
  useChannelStore.setState({
    channels: [],
    createChannel: async () => {
      throw {
        response: {
          data: {
            code: "joint_channel_free_limit_reached",
            error: "Creating a second Joint Channel requires the Pro plan.",
          },
        },
      };
    },
  } as never);

  renderDialog();

  fireEvent.change(screen.getByPlaceholderText("e.g. partner-launch"), { target: { value: "second" } });
  fireEvent.change(screen.getByPlaceholderText("partner-workspace"), { target: { value: "partner" } });
  fireEvent.change(screen.getByPlaceholderText("@admin or admin@example.com"), { target: { value: "admin@example.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Create Joint Channel" }));

  assert.ok(await screen.findByText("A second Joint Channel requires the Pro plan."));
  assert.ok(screen.getByRole("button", { name: "View Billing" }));
  assert.ok(
    !(document.body.textContent ?? "").includes("Creating a second Joint Channel"),
    "the raw server error must not leak past the localized recovery copy",
  );
});
