import "./helpers/domSetup";

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
} from "@testing-library/react";
const render: typeof rtlRender = (ui, options) =>
  rtlRender(ui, { wrapper: TestIntlProvider, ...options });
const renderZh: typeof rtlRender = (ui, options) =>
  rtlRender(ui, {
    wrapper: ({ children }) => (
      <TestIntlProvider locale="zh-cn">{children}</TestIntlProvider>
    ),
    ...options,
  });
// oxlint-disable-next-line no-restricted-imports -- Whole-module React shim for classic-runtime test dependencies.
import * as React from "react";
import { act } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import api from "../src/api/client";
import type { HumanProfile } from "../src/components/member/HumanDetailPanel";
import { subscribeChannelMembersChanged } from "../src/store/channelMemberEvents";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import type { Channel } from "../src/store/channelStore";
import { useProfileStore } from "../src/store/profileStore";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import { useThreadStore } from "../src/store/threadStore";
import { TestIntlProvider } from "./helpers/intl";

(globalThis as typeof globalThis & { React?: typeof React }).React = React;
const HumanDetailPanel = (
  await import("../src/components/member/HumanDetailPanel")
).default;
const originalApiDelete = api.delete;

const server: Server = {
  id: "server-1",
  name: "Design",
  avatarUrl: null,
  slug: "design",
  ownerId: "user-self",
  onboardingAgentId: null,
  hideHumansFromMembers: false,
  plan: "free",
  planDowngradedAt: null,
  role: "owner",
  createdAt: "2026-07-14T00:00:00.000Z",
};

function selfHuman(overrides: Partial<HumanProfile> = {}): HumanProfile {
  return {
    userId: "user-self",
    serverId: "server-1",
    serverName: "Design",
    serverSlug: "design",
    email: "self@example.com",
    gravatarHash: "hash",
    name: "self",
    displayName: "Self User",
    description: null,
    avatarUrl: null,
    role: "owner",
    joinedAt: "2026-07-14T00:00:00.000Z",
    membershipStatus: "active",
    createdAgents: [],
    ...overrides,
  };
}

function dmChannel(id = "dm-self"): Channel {
  return {
    id,
    name: "Self User",
    description: null,
    type: "dm",
    createdAt: "2026-07-14T00:00:00.000Z",
    peerType: "user",
    peerId: "user-self",
    peerName: "self",
    peerDisplayName: "Self User",
    peerDescription: null,
    peerGravatarHash: "hash",
    peerAvatarUrl: null,
  };
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function seedStores(openUserDM: (userId: string) => Promise<Channel>) {
  useAuthStore.setState({
    user: {
      id: "user-self",
      name: "self",
      email: "self@example.com",
      displayName: "Self User",
      avatarUrl: null,
      gravatarHash: "hash",
    },
  } as never);
  useServerStore.setState({
    current: server,
    members: [
      {
        userId: "user-self",
        name: "self",
        displayName: "Self User",
        email: "self@example.com",
        gravatarHash: "hash",
        role: "owner",
        joinedAt: "2026-07-14T00:00:00.000Z",
        membershipStatus: "active",
      },
    ],
  } as never);
  useChannelStore.setState({
    channels: [],
    dmChannels: [],
    openUserDM,
  } as never);
}

afterEach(() => {
  cleanup();
  api.delete = originalApiDelete;
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useProfileStore.setState(useProfileStore.getInitialState(), true);
  useThreadStore.setState(useThreadStore.getInitialState(), true);
});

test("removing a human from their profile invalidates every mounted channel member snapshot", async () => {
  let deletedUrl: string | null = null;
  api.delete = (async (url: string) => {
    deletedUrl = url;
    return { data: { ok: true } };
  }) as typeof api.delete;
  seedStores(async () => dmChannel());
  useServerStore.setState((state) => ({
    members: [
      ...state.members,
      {
        userId: "user-member",
        name: "member",
        displayName: "Member User",
        email: "member@example.com",
        gravatarHash: "member-hash",
        role: "member",
        joinedAt: "2026-07-14T00:00:00.000Z",
        membershipStatus: "active",
      },
    ],
  }));
  const invalidations: Array<string | null> = [];
  const unsubscribe = subscribeChannelMembersChanged((channelId) => {
    invalidations.push(channelId);
  });

  render(
    <TestIntlProvider>
      <MemoryRouter initialEntries={["/s/design/human/user-member"]}>
        <HumanDetailPanel
          human={selfHuman({
            userId: "user-member",
            name: "member",
            displayName: "Member User",
            email: "member@example.com",
            gravatarHash: "member-hash",
            role: "member",
          })}
        />
      </MemoryRouter>
    </TestIntlProvider>,
  );

  fireEvent.click(screen.getByRole("button", { name: "Remove Member" }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  });

  await waitFor(() => {
    assert.equal(deletedUrl, "/servers/server-1/members/user-member");
  });
  assert.deepEqual(invalidations, [null]);
  assert.equal(
    useServerStore
      .getState()
      .members.some((member) => member.userId === "user-member"),
    false,
  );
  unsubscribe();
});

test("self human profile Message opens the supported self-DM channel", async () => {
  let openedUserId: string | null = null;
  seedStores(async (userId) => {
    openedUserId = userId;
    return dmChannel();
  });

  render(
    <MemoryRouter initialEntries={["/s/design/human/user-self"]}>
      <HumanDetailPanel human={selfHuman()} />
      <LocationProbe />
    </MemoryRouter>,
  );

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Message" }));
  });

  assert.equal(openedUserId, "user-self");
  await waitFor(() => {
    assert.equal(
      screen.getByTestId("location").textContent,
      "/s/design/dm/dm-self",
    );
  });
});

test("human profile Message action stays icon-only at desktop widths", () => {
  seedStores(async () => dmChannel());

  render(
    <MemoryRouter initialEntries={["/s/design/human/user-self"]}>
      <HumanDetailPanel human={selfHuman()} />
    </MemoryRouter>,
  );

  const messageButton = screen.getByRole("button", { name: "Message" });
  assert.equal(
    messageButton.textContent,
    "",
    "visible Message copy must not return at a responsive breakpoint",
  );
  assert.equal(messageButton.getAttribute("title"), "Message");
  assert.ok(
    messageButton.querySelector("svg"),
    "the icon remains the visible affordance",
  );
  assert.match(messageButton.className, /\bsize-7\b/);
  assert.doesNotMatch(messageButton.className, /\bmd:w-auto\b|\bmd:px-/);
});

test("remote joint human profile still hides Message", () => {
  seedStores(async () => dmChannel("dm-remote"));

  render(
    <MemoryRouter initialEntries={["/s/design/human/user-remote"]}>
      <HumanDetailPanel
        human={selfHuman({
          userId: "user-remote",
          serverId: "server-remote",
          serverName: "Partner",
          serverSlug: "partner",
          name: "remote",
          displayName: "Remote User",
          role: null,
          email: null,
          gravatarHash: "",
        })}
      />
    </MemoryRouter>,
  );

  assert.equal(screen.queryByRole("button", { name: "Message" }), null);
});

test("self human profile editor and avatar chrome render from the zh-cn catalog", () => {
  seedStores(async () => dmChannel());

  renderZh(
    <MemoryRouter initialEntries={["/s/design/human/user-self"]}>
      <HumanDetailPanel human={selfHuman()} />
    </MemoryRouter>,
  );

  assert.ok(screen.getByRole("button", { name: "发消息" }));
  assert.ok(screen.getByRole("button", { name: "上传图片" }));
  assert.ok(screen.getByText("描述"));
  assert.ok(screen.getByText("暂无描述"));
  assert.ok(screen.getByText("（你）"));
  assert.equal(screen.queryByRole("button", { name: "Message" }), null);

  fireEvent.click(screen.getByRole("button", { name: "编辑描述" }));

  assert.ok(
    screen.getByPlaceholderText(
      "描述你自己，让此服务器中的其他人类和 Agent 了解你",
    ),
  );
  assert.ok(screen.getByRole("button", { name: "保存" }));
  assert.ok(screen.getByRole("button", { name: "取消" }));
  assert.equal(
    screen.queryByPlaceholderText(
      "Describe yourself for other humans and agents in this server",
    ),
    null,
  );
  assert.equal(screen.queryByRole("button", { name: "Save" }), null);
});

test("member profile role and remove actions render from the zh-cn catalog", () => {
  seedStores(async () => dmChannel("dm-member"));
  useServerStore.setState((state) => ({
    members: [
      ...state.members,
      {
        userId: "user-member",
        name: "member",
        displayName: "Member User",
        email: "member@example.com",
        gravatarHash: "member-hash",
        role: "member",
        joinedAt: "2026-07-14T00:00:00.000Z",
        membershipStatus: "active",
      },
    ],
  }));

  renderZh(
    <MemoryRouter initialEntries={["/s/design/human/user-member"]}>
      <HumanDetailPanel
        human={selfHuman({
          userId: "user-member",
          name: "member",
          displayName: "Member User",
          email: "member@example.com",
          gravatarHash: "member-hash",
          role: "member",
        })}
      />
    </MemoryRouter>,
  );

  assert.ok(screen.getByText("信息"));
  assert.ok(screen.getByText("角色"));
  assert.ok(screen.getByText("成员"));
  assert.ok(screen.getByText("邮箱"));
  assert.ok(screen.getByText("加入时间"));
  assert.ok(screen.getByText("已创建的 Agent"));
  assert.ok(screen.getByText("暂无已创建的 Agent"));
  assert.ok(screen.getByText("操作"));
  assert.ok(screen.getByRole("button", { name: "移除成员" }));
  assert.equal(screen.queryByText("No created agents"), null);

  fireEvent.click(screen.getByRole("button", { name: "编辑角色" }));

  assert.ok(screen.getByRole("button", { name: "所有者" }));
  assert.ok(screen.getByRole("button", { name: "管理员" }));
  assert.ok(screen.getAllByRole("button", { name: "成员" }).length >= 1);
  fireEvent.click(screen.getByRole("button", { name: "取消" }));

  fireEvent.click(screen.getByRole("button", { name: "移除成员" }));

  assert.ok(
    screen.getByText(
      "Member User 会从此服务器的所有频道中移除，但过往消息仍会保留在历史记录中。",
    ),
  );
  assert.ok(screen.getByRole("button", { name: "移除" }));
  assert.ok(screen.getByRole("button", { name: "取消" }));
  assert.equal(
    screen.queryByText(/They will be removed from all channels/u),
    null,
  );
});
