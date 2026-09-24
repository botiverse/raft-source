import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";

import api from "../src/api/client";
import ArchivedChannelsSection from "../src/components/settings/ArchivedChannelsSection";
import SettingsPanel from "../src/components/settings/SettingsPanel";
import { useChannelStore } from "../src/store/channelStore";
import type { Channel } from "../src/store/channelStore";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import { renderWithIntl } from "./helpers/intl";

const originalPost = api.post;

afterEach(() => {
  cleanup();
  api.post = originalPost;
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
});

function makeServer(role: Server["role"] = "owner"): Server {
  return {
    id: "server-1",
    name: "Test Server",
    avatarUrl: null,
    slug: "test-server",
    ownerId: "owner-1",
    onboardingAgentId: null,
    hideHumansFromMembers: false,
    plan: "free",
    planDowngradedAt: null,
    role,
    createdAt: "2026-08-01T00:00:00.000Z",
  };
}

function makeChannel(
  id: string,
  name: string,
  options: Partial<Channel> = {},
): Channel {
  return {
    id,
    serverId: "server-1",
    name,
    description: null,
    type: "channel",
    createdAt: "2026-08-01T00:00:00.000Z",
    joined: true,
    archivedAt: null,
    archivedByUserId: null,
    ...options,
  };
}

function seed(role: Server["role"], channels: Channel[], loading = false) {
  useServerStore.setState({
    servers: [makeServer(role)],
    current: makeServer(role),
    members: [],
    loading: false,
    serverEpoch: 1,
  } as never);
  useChannelStore.setState({ channels, loading });
}

function LocationProbe() {
  return <div data-testid="location-probe">{useLocation().pathname}</div>;
}

function renderSection(locale: "en" | "zh-cn" = "en") {
  return renderWithIntl(
    <MemoryRouter initialEntries={["/s/test-server/settings/server"]}>
      <ArchivedChannelsSection />
    </MemoryRouter>,
    { locale },
  );
}

test("Server Profile shows only manageable archived channels, newest first, between Profile and Danger Zone", () => {
  seed("owner", [
    makeChannel("active", "active"),
    makeChannel("public-old", "public-old", { archivedAt: "2026-08-02T12:00:00.000Z" }),
    makeChannel("private-new", "private-new", { type: "private", archivedAt: "2026-08-04T12:00:00.000Z" }),
    makeChannel("joint-middle", "joint-middle", { type: "joint", archivedAt: "2026-08-03T12:00:00.000Z" }),
    makeChannel("archived-dm", "archived-dm", { type: "dm", archivedAt: "2026-08-05T12:00:00.000Z" }),
    makeChannel("archived-thread", "archived-thread", { type: "thread", archivedAt: "2026-08-06T12:00:00.000Z" }),
  ]);

  renderWithIntl(
    <MemoryRouter>
      <SettingsPanel tab="server" />
      <LocationProbe />
    </MemoryRouter>,
  );

  const section = screen.getByTestId("archived-channels-section");
  assert.match(section.textContent ?? "", /Archived channels\s*3/);
  assert.equal(within(section).queryByText("#active"), null);
  assert.equal(within(section).queryByText("#archived-dm"), null);
  assert.equal(within(section).queryByText("#archived-thread"), null);

  const rows = Array.from(section.querySelectorAll<HTMLElement>("[data-testid^='archived-channel-row-']"));
  assert.deepEqual(rows.map((row) => row.dataset.testid), [
    "archived-channel-row-private-new",
    "archived-channel-row-joint-middle",
    "archived-channel-row-public-old",
  ]);
  assert.ok(within(rows[0]!).getByLabelText("Private channel"));
  assert.ok(within(rows[1]!).getByLabelText("Joint channel"));
  assert.ok(within(rows[2]!).getByLabelText("Public channel"));
  assert.match(rows[0]!.textContent ?? "", /Private channel · Archived/);
  assert.match(rows[1]!.textContent ?? "", /Joint channel · Archived/);
  assert.match(rows[2]!.textContent ?? "", /Public channel · Archived/);

  const profile = screen.getByTestId("server-profile-card");
  const danger = screen.getByTestId("server-danger-delete-card");
  assert.ok(profile.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING);
  assert.ok(section.compareDocumentPosition(danger) & Node.DOCUMENT_POSITION_FOLLOWING);

  fireEvent.click(within(rows[0]!).getByRole("button", { name: "Open private-new" }));
  assert.equal(screen.getByTestId("location-probe").textContent, "/s/test-server/channel/private-new");
});

test("members, loading state, and an empty archived collection do not expose the management section", () => {
  const archived = makeChannel("archived", "archived", { archivedAt: "2026-08-04T12:00:00.000Z" });

  seed("member", [archived]);
  const memberView = renderSection();
  assert.equal(screen.queryByTestId("archived-channels-section"), null);
  memberView.unmount();

  seed("owner", [archived], true);
  const loadingView = renderSection();
  assert.equal(screen.queryByTestId("archived-channels-section"), null);
  loadingView.unmount();

  seed("owner", [makeChannel("active", "active")]);
  renderSection();
  assert.equal(screen.queryByTestId("archived-channels-section"), null);
});

test("unarchive posts through the canonical store action and immediately removes the restored row", async () => {
  const archived = makeChannel("archived", "archived", { archivedAt: "2026-08-04T12:00:00.000Z" });
  seed("admin", [archived]);

  let requestedUrl = "";
  let resolveRequest!: (value: { data: Channel }) => void;
  api.post = ((url: string) => {
    requestedUrl = url;
    return new Promise((resolve) => {
      resolveRequest = resolve;
    });
  }) as typeof api.post;

  renderSection();
  fireEvent.click(screen.getByRole("button", { name: "Unarchive archived" }));

  assert.equal(requestedUrl, "/channels/archived/unarchive");
  assert.ok(screen.getByRole("button", { name: "Unarchive archived" }).hasAttribute("disabled"));
  assert.match(screen.getByRole("button", { name: "Unarchive archived" }).textContent ?? "", /Unarchiving/);

  await act(async () => {
    resolveRequest({ data: { ...archived, archivedAt: null, archivedByUserId: null } });
  });

  await waitFor(() => {
    assert.equal(screen.queryByTestId("archived-channel-row-archived"), null);
    assert.equal(screen.queryByTestId("archived-channels-section"), null);
  });
  assert.equal(useChannelStore.getState().channels[0]?.archivedAt, null);
});

test("a failed unarchive keeps the row actionable and renders the server error", async () => {
  const archived = makeChannel("archived", "archived", { archivedAt: "2026-08-04T12:00:00.000Z" });
  seed("owner", [archived]);
  api.post = (async () => {
    throw { response: { data: { error: "Channel restore is temporarily unavailable" } } };
  }) as typeof api.post;

  renderSection();
  fireEvent.click(screen.getByRole("button", { name: "Unarchive archived" }));

  await waitFor(() => {
    assert.equal(screen.getByTestId("archived-channels-error").textContent, "Channel restore is temporarily unavailable");
  });
  assert.ok(screen.getByTestId("archived-channel-row-archived"));
  assert.equal(screen.getByRole("button", { name: "Unarchive archived" }).hasAttribute("disabled"), false);

  await act(async () => {
    useServerStore.setState({
      current: { ...makeServer("owner"), id: "server-2", slug: "server-2" },
      serverEpoch: 2,
    });
    useChannelStore.setState({
      channels: [makeChannel("other", "other", { serverId: "server-2", archivedAt: "2026-08-05T12:00:00.000Z" })],
    });
  });
  assert.equal(screen.queryByTestId("archived-channels-error"), null);
  assert.ok(screen.getByTestId("archived-channel-row-other"));
});

test("archived-channel management copy is localized in zh-CN", () => {
  seed("owner", [
    makeChannel("private", "私密讨论", { type: "private", archivedAt: "2026-08-04T12:00:00.000Z" }),
  ]);

  renderSection("zh-cn");
  const section = screen.getByTestId("archived-channels-section");
  assert.match(section.textContent ?? "", /已归档频道\s*1/);
  assert.ok(within(section).getByLabelText("私有频道"));
  assert.ok(within(section).getByRole("button", { name: "打开 私密讨论" }));
  assert.ok(within(section).getByRole("button", { name: "取消归档 私密讨论" }));
  assert.match(section.textContent ?? "", /归档于/);
});
