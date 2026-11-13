/**
 * Channel settings › "Visible to visitors" (#wg-rbac:#51): server owners and
 * admins (channelCapabilities.manageVisitorAccess) choose whether signed-out
 * visitors can read a channel on the server's public page. The switch saves
 * PATCH /channels/:id { visitorVisible } at once. It is offered while it is on
 * (so it can always be turned off) or while nothing the client knows would
 * refuse turning it on; a refusal says why on the row and puts it back.
 * Absence is asserted as `assert.ok(x === null)`, never with a DOM node
 * inside node:assert.
 */
import assert from "node:assert/strict";
import "../../../../tests/helpers/domSetup";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TestIntlProvider } from "../../../../tests/helpers/intl";
import api from "../../../api/client";
import { EditChannelDialog } from "../EditChannelDialog";
import { useChannelStore } from "../../../store/channelStore";
import { useServerStore } from "../../../store/serverStore";
import { useAuthStore } from "../../../store/authStore";
import { resetServerFeatureFlagsForTests } from "../../../store/serverFeatureFlags";
import { en as enMessages } from "../../../i18n/messages/en";
import { zhCn as zhCnMessages } from "../../../i18n/messages/zh-cn";

const en = enMessages as Record<string, string>;
const zh = zhCnMessages as Record<string, string>;
const originalPatch = api.patch;
const SERVER_ID = "server-public";
const CHANNEL_ID = "channel-lobby";
let patches: Array<{ url: string; body: Record<string, unknown> }> = [];

afterEach(() => {
  cleanup();
  api.patch = originalPatch;
  patches = [];
  useServerStore.setState(useServerStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useAuthStore.setState({ user: null } as never);
  resetServerFeatureFlagsForTests();
});

type Seed = {
  role?: "owner" | "admin" | "member";
  publicPageLive?: boolean;
  channel?: Record<string, unknown>;
};

function seed({ role = "owner", publicPageLive = true, channel = {} }: Seed = {}) {
  const server = { id: SERVER_ID, slug: "s", name: "S", role, plan: "pro", publicPageLive };
  useAuthStore.setState({ user: { id: "u1", name: "U" }, initialized: true } as never);
  useServerStore.setState({ servers: [server], current: server, members: [], loading: false } as never);
  useChannelStore.setState({
    channels: [{
      id: CHANNEL_ID, serverId: SERVER_ID, name: "lobby", description: "", type: "channel",
      archivedAt: null, jointServers: [], joined: true,
      visitorVisible: false, guestVisible: false, hasExternalRelation: false,
      channelCapabilities: {
        editChannelMetadata: true,
        changeChannelVisibility: true,
        manageVisitorAccess: role !== "member",
      },
      ...channel,
    }],
  } as never);
}

function stubPatch(respond: (body: Record<string, unknown>) => Promise<unknown>) {
  api.patch = (async (url: string, body: Record<string, unknown>) => {
    patches.push({ url, body });
    return respond(body);
  }) as typeof api.patch;
}

function accept() {
  stubPatch(async (body) => {
    const current = useChannelStore.getState().channels.find((c) => c.id === CHANNEL_ID)!;
    return { data: { ...current, visitorVisible: body.visitorVisible, guestVisible: body.visitorVisible } };
  });
}

function refuse(status: number, code: string) {
  stubPatch(async () => {
    throw Object.assign(new Error(code), { response: { status, data: { error: `server says ${code}`, code } } });
  });
}

function renderSettings(locale: "en" | "zh-cn" = "en", name = "lobby") {
  return render(
    <TestIntlProvider locale={locale}>
      <MemoryRouter>
        <EditChannelDialog
          channelId={CHANNEL_ID}
          initialName={name}
          initialDescription=""
          onLeaveChannel={async () => {}}
          onClose={() => {}}
        />
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

const SWITCH = "channel-settings-visitor-visible-switch";
const STATUS = "channel-settings-visitor-visible-status";
const switchState = () => screen.getByTestId(SWITCH).getAttribute("aria-checked");
// The details read first: the channel's name heads them (the fields come only after Edit).
const rendered = (name = "lobby") => document.querySelector('[data-testid="channel-overflow-title-text"]')?.textContent === name;

for (const role of ["owner", "admin"] as const) {
  test(`${role}: a public channel of a public server offers the switch, and turning it on sends visitorVisible: true`, async () => {
    seed({ role });
    accept();
    renderSettings();
    const row = screen.getByTestId("channel-settings-visitor-visible");
    assert.match(row.textContent ?? "", new RegExp(en["channel.edit.visitorVisibleTitle"]!));
    assert.match(row.textContent ?? "", /without signing in/);
    assert.equal(switchState(), "false");
    fireEvent.click(screen.getByTestId(SWITCH));
    await waitFor(() => assert.equal(JSON.stringify(patches), JSON.stringify([{ url: `/channels/${CHANNEL_ID}`, body: { visitorVisible: true } }])));
    await waitFor(() => assert.equal(switchState(), "true"));
    // Applies at once and says nothing: the switch is the confirmation (no "Saved").
    await waitFor(() => assert.equal(screen.getByTestId(STATUS).getAttribute("data-status"), "idle"));
    assert.equal(screen.getByTestId(STATUS).textContent, "");
    assert.equal(useChannelStore.getState().channels[0]!.visitorVisible, true);
  });
}

test("a member (no manageVisitorAccess) never sees it, on or off", () => {
  for (const visitorVisible of [false, true]) {
    seed({ role: "member", channel: { visitorVisible, guestVisible: visitorVisible } });
    renderSettings();
    assert.ok(rendered(), "the settings rendered");
    assert.ok(screen.queryByTestId("channel-settings-visitor-visible") === null, `member, visitorVisible ${visitorVisible}`);
    cleanup();
  }
});

const CANNOT_TURN_ON: Array<[string, Seed]> = [
  ["a private channel", { channel: { type: "private" } }],
  ["a server whose public page isn't live", { publicPageLive: false }],
  ["a channel with people or invites from outside", { channel: { hasExternalRelation: true } }],
];

for (const [what, over] of CANNOT_TURN_ON) {
  test(`off and impossible to turn on: ${what} shows no row; on, the same channel shows it to turn off`, async () => {
    seed(over);
    renderSettings();
    assert.ok(rendered(), "the settings rendered");
    assert.ok(screen.queryByTestId("channel-settings-visitor-visible") === null, `${what}, off`);
    cleanup();

    seed({ ...over, channel: { ...over.channel, visitorVisible: true, guestVisible: true } });
    accept();
    renderSettings();
    assert.equal(switchState(), "true");
    fireEvent.click(screen.getByTestId(SWITCH));
    await waitFor(() => assert.equal(JSON.stringify(patches.map((p) => p.body)), JSON.stringify([{ visitorVisible: false }])));
    await waitFor(() => assert.equal(switchState(), "false"));
    // The row stays in this mount, though it could not be turned on again.
    await waitFor(() => assert.equal(screen.getByTestId(STATUS).getAttribute("data-status"), "idle"));
    assert.ok(screen.getByTestId(SWITCH));
  });
}

test("#all shows it only while it is on (to turn it off); joint channels and archived channels never show it", () => {
  // cindyz (#wg-rbac:0d0df0ad): #all can't be made visible to visitors; one that already is keeps its switch.
  seed({ channel: { name: "all" } });
  renderSettings("en", "all");
  assert.ok(screen.queryByTestId(SWITCH) === null, "#all, off: hidden");
  cleanup();
  seed({ channel: { name: "all", visitorVisible: true } });
  renderSettings("en", "all");
  assert.ok(screen.queryByTestId(SWITCH) !== null, "#all, on: shown so it can be turned off");
  cleanup();
  for (const channel of [{ type: "joint", visitorVisible: true }, { archivedAt: "2026-11-01T00:00:00.000Z", visitorVisible: true }]) {
    seed({ channel });
    renderSettings();
    assert.ok(screen.queryByTestId("channel-settings-visitor-visible") === null, JSON.stringify(channel));
    cleanup();
  }
});

test("an older payload with only guestVisible reads as on", () => {
  seed({ channel: { visitorVisible: undefined, guestVisible: true } });
  renderSettings();
  assert.equal(switchState(), "true");
});

const REFUSALS: Array<[number, string, string]> = [
  [400, "visitor_visibility_requires_public_server", "channel.edit.visitorVisibleRequiresPublicServer"],
  [400, "visitor_visibility_requires_public_channel", "channel.edit.visitorVisibleRequiresPublicChannel"],
  [400, "visitor_visibility_unsupported_channel", "channel.edit.visitorVisibleUnsupportedChannel"],
  [403, "visitor_visibility_forbidden", "channel.edit.visitorVisibleForbidden"],
  [400, "visitor_visible_invalid", "channel.edit.visitorVisibleSaveFailed"],
  [400, "visitor_visible_conflict", "channel.edit.visitorVisibleSaveFailed"],
];

for (const [status, code, messageId] of REFUSALS) {
  test(`refusal ${code}: its copy on the row, and the switch goes back off`, async () => {
    seed();
    refuse(status, code);
    renderSettings();
    fireEvent.click(screen.getByTestId(SWITCH));
    await waitFor(() => assert.equal(screen.getByTestId(STATUS).textContent, en[messageId]));
    assert.equal(switchState(), "false");
    assert.equal(useChannelStore.getState().channels[0]!.visitorVisible, false);
  });
}

test("zh-cn: the row and a refusal read in Chinese", async () => {
  seed();
  refuse(400, "visitor_visibility_requires_public_server");
  renderSettings("zh-cn");
  const row = screen.getByTestId("channel-settings-visitor-visible");
  assert.match(row.textContent ?? "", /游客可见/);
  fireEvent.click(screen.getByTestId(SWITCH));
  await waitFor(() => assert.equal(screen.getByTestId(STATUS).textContent, zh["channel.edit.visitorVisibleRequiresPublicServer"]));
});
