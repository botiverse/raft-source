import assert from "node:assert/strict";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { EXTERNAL_CHANNELS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import api from "../src/api/client";
import CreateChannelDialog from "../src/components/channel/CreateChannelDialog";
import type { ExternalInvitePreview } from "../src/components/channel/externalInvites";
import { useChannelStore } from "../src/store/channelStore";
import { resetServerFeatureFlagsForTests, setServerFeatureFlagForTests } from "../src/store/serverFeatureFlags";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import { TestIntlProvider } from "./helpers/intl";

// The product events the dialog records, by name and properties.
const tracked: Array<{ event: string; props: Record<string, unknown> }> = [];
vi.mock("../src/analytics/track", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/analytics/track")>()),
  trackEvent: (event: string, props: Record<string, unknown>) => { tracked.push({ event, props }); },
}));

// Create Channel, External: Create and Invite creates the channel, then sends
// its invites. "#name was created, but the invites weren't sent" is for a send
// that came back unsent, never while it is still running.
const SERVER_ID = "server-1";
const CHANNEL = { id: "channel-new", name: "launch-plan" };
const EMAIL = "lena@contoso.com";
const PREVIEW: ExternalInvitePreview = { valid: [EMAIL], duplicates: [], invalid: [], alreadyPending: [], alreadyMembers: [] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(options: { createFails?: unknown } = {}) {
  useServerStore.setState({
    current: { id: SERVER_ID, slug: "acme", name: "Acme", plan: "pro", role: "owner" } as Server,
    members: [],
  });
  setServerFeatureFlagForTests(SERVER_ID, EXTERNAL_CHANNELS_FEATURE_FLAG_KEY, true);
  const createChannel = vi.fn(async () => {
    if (options.createFails) throw options.createFails;
    return CHANNEL;
  });
  useChannelStore.setState({ channels: [], dmChannels: [], createChannel } as never);
  const get = vi.spyOn(api, "get").mockImplementation(async (url: string) => {
    if (url === "/channels/external-availability") return { data: { freeLimitReached: false } };
    if (url === "/channels/external-connect-servers") return { data: { servers: [] } };
    return { data: { invites: [] } };
  });
  const send = deferred<{ data: unknown }>();
  vi.spyOn(api, "post").mockImplementation(async (url: string) => {
    if (url === "/channels/external-invites/preview") return { data: PREVIEW };
    if (url === `/channels/${CHANNEL.id}/external-invites`) return send.promise;
    throw new Error(`unexpected POST ${url}`);
  });
  const onClose = vi.fn();
  render(
    <TestIntlProvider>
      <MemoryRouter>
        <CreateChannelDialog onClose={onClose} prefilledName={CHANNEL.name} prefilledVisibility="external" stayOnCreate />
      </MemoryRouter>
    </TestIntlProvider>,
  );
  return { createChannel, get, send, onClose };
}

// Step 1 -> step 2 (emails) -> review -> Create and Invite, leaving the send in flight.
async function createAndInvite({ createChannel, get }: ReturnType<typeof setup>) {
  await waitFor(() => assert.ok(get.mock.calls.some(([url]) => url === "/channels/external-availability")));
  await act(async () => {});
  fireEvent.click(screen.getByTestId("create-channel-next"));
  fireEvent.change(await screen.findByTestId("external-invite-emails"), { target: { value: EMAIL } });
  fireEvent.click(screen.getByTestId("create-channel-submit"));
  fireEvent.click(await screen.findByTestId("external-invite-send"));
  await waitFor(() => assert.equal(createChannel.mock.calls.length, 1));
  await act(async () => {});
}

afterEach(() => {
  cleanup();
  tracked.length = 0;
  vi.restoreAllMocks();
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
  resetServerFeatureFlagsForTests();
});

test("while the created channel's invites are still sending, no 'created, but not sent' notice; a sent invite closes the dialog", async () => {
  const rendered = setup();
  const { send, onClose } = rendered;
  await createAndInvite(rendered);
  assert.ok(screen.queryByTestId("create-channel-external-created") === null, "nothing has failed yet");

  await act(async () => send.resolve({ data: { sent: [EMAIL], skipped: { duplicates: [], invalid: [], alreadyPending: [], alreadyMembers: [] } } }));
  await waitFor(() => assert.equal(onClose.mock.calls.length, 1, "a sent invite closes the dialog"));
});

test("a send that fails after the create leaves the dialog open with the warning notice", async () => {
  const rendered = setup();
  const { send, onClose } = rendered;
  await createAndInvite(rendered);

  await act(async () => send.reject({ response: { status: 500, data: { error: "boom" } } }));
  const notice = await screen.findByTestId("create-channel-external-created");
  assert.match(notice.textContent ?? "", /#launch-plan was created, but the invites weren't sent/);
  assert.equal(notice.getAttribute("data-status"), "warning", "a send that failed is a warning, not a success");
  assert.equal(onClose.mock.calls.length, 0, "the dialog stays open to retry");
});

// #wg-rbac:#94: a create refused for its name was recorded as error_code other.
test("a create refused for its name (a 409 with no code, or the archived holder's) records the send as failed with channel_name_taken", async () => {
  const sendFinished = () => tracked.filter((entry) => entry.event === "external_invite_send_finished").map((entry) => entry.props);
  const rendered = setup({ createFails: { response: { status: 409, data: { error: "Channel name already taken" } } } });
  await createAndInvite(rendered);
  await waitFor(() => assert.equal(sendFinished().length, 1));
  assert.deepEqual(sendFinished(), [{ flow: "create_channel", result: "failed", error_code: "channel_name_taken", upgrade_offered: false }]);
  cleanup();
  vi.restoreAllMocks();
  tracked.length = 0;

  const archived = setup({ createFails: { response: { status: 409, data: {
    code: "archived_name_collision", error: "taken", archivedChannelId: "c-old", archivedChannelName: CHANNEL.name, archivedChannelType: "joint", canUnarchiveArchivedChannel: false,
  } } } });
  await createAndInvite(archived);
  await waitFor(() => assert.equal(sendFinished().length, 1));
  assert.equal(sendFinished()[0]!.error_code, "channel_name_taken", "an archived holder's 409 is the same refusal");
  cleanup();
  vi.restoreAllMocks();
  tracked.length = 0;

  // Any other failed create keeps the server's code (none here: other).
  const other = setup({ createFails: { response: { status: 409, data: { code: "action_card_frozen", error: "frozen" } } } });
  await createAndInvite(other);
  await waitFor(() => assert.equal(sendFinished().length, 1));
  assert.equal(sendFinished()[0]!.error_code, "other");
});
