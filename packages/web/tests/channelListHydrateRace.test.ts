import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "vitest";

import api from "../src/api/client";
import { createChannelRealtimeBindings } from "../src/store/channelRealtimeSync";
import { useChannelStore } from "../src/store/channelStore";
import type { ApiChannel } from "../src/store/channelStore";
import { triggerServerReset } from "../src/store/serverResetRegistry";
import { useServerStore } from "../src/store/serverStore";

// #239: a GET /channels can start before a channel is created, joined, added
// or removed and answer after it. That stale answer must not undo the local
// change (drop the new channel from the sidebar and search, or bring back a
// deleted one); everything else still follows the answer.

const originalGet = api.get.bind(api);
const originalPost = api.post.bind(api);
const originalDelete = api.delete.bind(api);

function apiChannel(id: string, overrides: Partial<ApiChannel> = {}): ApiChannel {
  return {
    id,
    serverId: "server-1",
    name: id,
    description: null,
    type: "channel",
    createdAt: "2026-10-01T00:00:00.000Z",
    archivedAt: null,
    joined: true,
    ...overrides,
  };
}

let epoch = 1;

/** Each GET is held open until its test answers it, by URL. */
const heldGets = new Map<string, (data: unknown) => void>();

function holdGets() {
  api.get = (async (url: string) => ({
    data: await new Promise((resolve) => { heldGets.set(url, resolve); }),
  })) as typeof api.get;
}

/** Answers the held GET for `url`, then waits for the action that sent it. */
async function answer(url: string, data: unknown, inflight: Promise<unknown>) {
  const release = heldGets.get(url);
  assert.ok(release, `a GET ${url} is held`);
  heldGets.delete(url);
  release(data);
  await inflight;
}

/** Starts loadChannels with GET /channels held open; `answer` releases it. */
function startHeldList() {
  holdGets();
  const inflight = useChannelStore.getState().loadChannels();
  return { answer: (rows: ApiChannel[]) => answer("/channels", rows, inflight) };
}

/** A plain GET /channels answered at once. */
async function loadList(rows: ApiChannel[]) {
  api.get = (async () => ({ data: rows })) as typeof api.get;
  await useChannelStore.getState().loadChannels();
}

function names(): string[] {
  return useChannelStore.getState().channels.map((channel) => channel.name);
}

beforeEach(async () => {
  epoch += 1;
  useServerStore.setState({ current: { id: "server-1", slug: "acme" }, serverEpoch: epoch } as never);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  await loadList([apiChannel("general"), apiChannel("design")]);
});

afterEach(() => {
  heldGets.clear();
  api.get = originalGet;
  api.post = originalPost;
  api.delete = originalDelete;
});

test("a GET /channels started before a create and answered after it keeps the new channel", async () => {
  const list = startHeldList();
  api.post = (async () => ({ data: apiChannel("roadmap") })) as typeof api.post;
  await useChannelStore.getState().createChannel("roadmap");

  await list.answer([apiChannel("general"), apiChannel("design")]);
  assert.deepEqual(names(), ["general", "design", "roadmap"]);
});

test("a channel:updated that lands while the GET is in flight is kept", async () => {
  const channelUpdated = createChannelRealtimeBindings({ emit: () => undefined }, () => {})
    .find((binding) => binding.event === "channel:updated");
  assert.ok(channelUpdated);
  const list = startHeldList();
  channelUpdated.handler({ channel: apiChannel("added-to-me") });
  channelUpdated.handler({ channel: apiChannel("design", { name: "design-renamed" }) });

  await list.answer([apiChannel("general"), apiChannel("design")]);
  assert.deepEqual(names(), ["general", "design-renamed", "added-to-me"]);
});

test("a channel deleted while the GET is in flight is not brought back", async () => {
  const list = startHeldList();
  api.delete = (async () => ({ data: {} })) as typeof api.delete;
  await useChannelStore.getState().deleteChannel("design");

  await list.answer([apiChannel("general"), apiChannel("design")]);
  assert.deepEqual(names(), ["general"]);
});

test("a channel archived while the GET is in flight stays archived", async () => {
  const list = startHeldList();
  api.post = (async () => ({ data: apiChannel("design", { archivedAt: "2026-11-05T00:00:00.000Z" }) })) as typeof api.post;
  await useChannelStore.getState().archiveChannel("design");

  await list.answer([apiChannel("general"), apiChannel("design")]);
  const design = useChannelStore.getState().channels.find((channel) => channel.id === "design");
  assert.equal(design?.archivedAt, "2026-11-05T00:00:00.000Z");
});

test("a channel gone server-side and not patched since the request started is dropped", async () => {
  // Patched before the request: the answer is newer, so it decides.
  useChannelStore.getState().applyChannelPatch(apiChannel("short-lived"));
  assert.deepEqual(names(), ["general", "design", "short-lived"]);

  await loadList([apiChannel("general")]);
  assert.deepEqual(names(), ["general"]);
});

// A single-row read answers with the row as of its request start, not as of
// when it lands: against a list request, the one that started later wins.
test("a GET /channels/:id started before the list and answered first does not beat the fresher list", async () => {
  holdGets();
  const refresh = useChannelStore.getState().ensureChannel("design", { refresh: true });
  const list = useChannelStore.getState().loadChannels();
  await answer("/channels/design", apiChannel("design", { name: "design-old" }), refresh);
  assert.deepEqual(names(), ["general", "design-old"]);

  await answer("/channels", [apiChannel("general"), apiChannel("design", { name: "design-fresh" })], list);
  assert.deepEqual(names(), ["general", "design-fresh"]);
});

test("a GET /channels/:id started after the list is newer than the list's answer", async () => {
  holdGets();
  const list = useChannelStore.getState().loadChannels();
  const refresh = useChannelStore.getState().ensureChannel("design", { refresh: true });
  await answer("/channels/design", apiChannel("design", { name: "design-fresh" }), refresh);

  await answer("/channels", [apiChannel("general"), apiChannel("design", { name: "design-old" })], list);
  assert.deepEqual(names(), ["general", "design-fresh"]);
});

test("a normal hydrate follows the answer and keeps the list when nothing changed", async () => {
  const before = useChannelStore.getState().channels;
  await loadList([apiChannel("general"), apiChannel("design")]);
  assert.equal(useChannelStore.getState().channels, before, "same array for the same answer");

  await loadList([apiChannel("general", { name: "general-2" }), apiChannel("new-on-server")]);
  assert.deepEqual(names(), ["general-2", "new-on-server"]);
});

test("after a server switch the old server's late answer writes nothing and the new server's list is protected", async () => {
  const list = startHeldList();
  useChannelStore.getState().applyChannelPatch(apiChannel("from-a"));

  useServerStore.setState({ current: { id: "server-2", slug: "beta" }, serverEpoch: ++epoch } as never);
  triggerServerReset();
  assert.deepEqual(useChannelStore.getState().channels, []);

  await list.answer([apiChannel("general"), apiChannel("design")]);
  assert.deepEqual(useChannelStore.getState().channels, []);

  // On the new server, a list started before a patch still keeps it.
  const next = startHeldList();
  useChannelStore.getState().applyChannelPatch(apiChannel("b-new", { serverId: "server-2" }));
  await next.answer([apiChannel("b-general", { serverId: "server-2" })]);
  assert.deepEqual(names(), ["b-general", "b-new"]);
});
