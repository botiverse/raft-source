import assert from "node:assert/strict";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import api from "../src/api/client";
import CreateChannelDialog from "../src/components/channel/CreateChannelDialog";
import CreateJointChannelDialog from "../src/components/channel/CreateJointChannelDialog";
import { useChannelStore } from "../src/store/channelStore";
import { resetServerFeatureFlagsForTests } from "../src/store/serverFeatureFlags";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import { TestIntlProvider } from "./helpers/intl";

// A new channel is never a Guest's bound channel: the server refuses a Guest
// among its initial members (403 guest_other_channel, #15358), so the create
// pickers never offer one. Members are offered as before.
const human = { email: null, description: null, avatarUrl: null, joinedAt: "2026-08-21T00:00:00.000Z" };
const MEMBERS = [
  { ...human, userId: "user-mei", name: "mei", displayName: "Mei", role: "member" },
  { ...human, userId: "user-gus", name: "gus", displayName: "Gus", role: "guest", guestChannel: { id: "channel-other", name: "other" } },
];

function setup(members: unknown[] = MEMBERS) {
  useServerStore.setState({
    current: { id: "server-1", slug: "acme", name: "Acme", plan: "pro", role: "owner" } as Server,
    members,
  } as never);
  const createChannel = vi.fn(async () => ({ id: "channel-new", name: "launch-plan" }));
  useChannelStore.setState({ channels: [], dmChannels: [], createChannel } as never);
  vi.spyOn(api, "get").mockImplementation(async () => ({ data: {} }));
  return { createChannel };
}

function renderDialog(dialog: ReactElement) {
  render(
    <TestIntlProvider>
      <MemoryRouter>{dialog}</MemoryRouter>
    </TestIntlProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
  resetServerFeatureFlagsForTests();
});

test("Create Channel offers a member but no Guest, and drops a Guest an action card prefilled", async () => {
  const { createChannel } = setup();
  renderDialog(
    <CreateChannelDialog onClose={() => {}} prefilledName="launch-plan" prefilledHumanIds={["user-mei", "user-gus"]} />,
  );

  await screen.findByText("Mei");
  assert.ok(screen.queryByText("Gus") === null, "the Guest is not offered");

  fireEvent.submit(screen.getByTestId("create-channel-details"));
  await waitFor(() => assert.equal(createChannel.mock.calls.length, 1));
  const [, , opts] = createChannel.mock.calls[0] as unknown as [string, string | undefined, { userIds: string[] }];
  assert.deepEqual(opts.userIds, ["user-mei"], "the prefilled Guest is not sent");
});

function sentUserIds(createChannel: ReturnType<typeof setup>["createChannel"]) {
  const [, , opts] = createChannel.mock.calls[0] as unknown as [string, string | undefined, { userIds: string[] }];
  return opts.userIds;
}

test("Create Channel sends no prefilled id it can't resolve to a loaded member, e.g. a Guest outside a partial directory", async () => {
  const { createChannel } = setup(MEMBERS.filter((member) => member.userId !== "user-gus"));
  renderDialog(
    <CreateChannelDialog onClose={() => {}} prefilledName="launch-plan" prefilledHumanIds={["user-mei", "user-gus"]} />,
  );

  await screen.findByText("Mei");
  fireEvent.submit(screen.getByTestId("create-channel-details"));
  await waitFor(() => assert.equal(createChannel.mock.calls.length, 1));
  assert.deepEqual(sentUserIds(createChannel), ["user-mei"], "the unresolved Guest is not sent");
});

test("Create Channel keeps an action card's prefill until members load, then sends the member but not the Guest", async () => {
  const { createChannel } = setup([]);
  renderDialog(
    <CreateChannelDialog onClose={() => {}} prefilledName="launch-plan" prefilledHumanIds={["user-mei", "user-gus"]} />,
  );

  act(() => useServerStore.setState({ members: MEMBERS } as never));
  await screen.findByText("Mei");
  fireEvent.submit(screen.getByTestId("create-channel-details"));
  await waitFor(() => assert.equal(createChannel.mock.calls.length, 1));
  assert.deepEqual(sentUserIds(createChannel), ["user-mei"], "the late-loaded member is sent, the Guest is not");
});

test("Create Joint Channel offers a member but no Guest", async () => {
  setup();
  renderDialog(<CreateJointChannelDialog onClose={() => {}} />);

  await screen.findByText("Mei");
  assert.ok(screen.queryByText("Gus") === null, "the Guest is not offered");
});
