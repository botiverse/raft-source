/**
 * Agent Lounge v0: a Lounge is a public channel on the wire (`type:
 * "channel"`, named `<agent>-lounge`) that carries `loungeAgentId`. The store
 * keeps it in its own slice so nothing that lists `channels` (the sidebar's
 * channel list, ⌘K, forward targets, browse) can show it, whichever way the
 * row arrives: a realtime event, a list, a single read, the open call.
 */
import assert from "node:assert/strict";
import api from "../src/api/client";
import { hydrateChannels, isLoungeChannel, patchChannel, removeChannel } from "../src/store/channelDomain";
import type { ChannelDomainState } from "../src/store/channelDomain";
import { createChannelRealtimeBindings } from "../src/store/channelRealtimeSync";
import { useChannelStore } from "../src/store/channelStore";
import type { ApiChannel } from "../src/store/channelStore";
import { useServerStore } from "../src/store/serverStore";

const SERVER_ID = "server-lounge";
const originalPost = api.post;
const originalGet = api.get;

function loungeRow(overrides: Partial<ApiChannel> = {}): ApiChannel {
  return {
    id: "lounge-bugen",
    serverId: SERVER_ID,
    name: "bugen-lounge",
    description: null,
    type: "channel",
    createdAt: "2026-11-01T00:00:00.000Z",
    joined: false,
    loungeAgentId: "agent-bugen",
    ...overrides,
  };
}

function generalRow(): ApiChannel {
  return {
    id: "channel-general",
    serverId: SERVER_ID,
    name: "general",
    description: null,
    type: "channel",
    createdAt: "2026-10-01T00:00:00.000Z",
    joined: true,
    loungeAgentId: null,
  };
}

function emptyState(): ChannelDomainState {
  return { channels: [], dmChannels: [], loungeChannels: [], channelActivity: {}, channelLocalMembership: {} };
}

afterEach(() => {
  api.post = originalPost;
  api.get = originalGet;
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
});

test("only a row naming its agent is a Lounge", () => {
  assert.equal(isLoungeChannel(loungeRow()), true);
  assert.equal(isLoungeChannel(generalRow()), false);
  assert.equal(isLoungeChannel({ loungeAgentId: "" }), false);
  assert.equal(isLoungeChannel({}), false);
});

test("a patched Lounge goes to the Lounge slice, never to the channel list", () => {
  const next = patchChannel(patchChannel(emptyState(), generalRow()), loungeRow());
  assert.deepEqual(next.channels.map((c) => c.id), ["channel-general"]);
  assert.deepEqual(next.loungeChannels?.map((c) => c.id), ["lounge-bugen"]);
});

test("a later patch of a kept Lounge stays in the slice even without loungeAgentId", () => {
  const withLounge = patchChannel(emptyState(), loungeRow());
  const { loungeAgentId: _drop, ...withoutField } = loungeRow({ joined: true });
  void _drop;
  const next = patchChannel(withLounge, withoutField as ApiChannel);
  assert.equal(next.channels.length, 0);
  assert.equal(next.loungeChannels?.length, 1);
  assert.equal(next.loungeChannels?.[0]?.joined, true, "the patch is merged in");
  assert.equal(next.loungeChannels?.[0]?.loungeAgentId, "agent-bugen", "the agent is kept");
});

test("a channel list that carries a Lounge keeps it out of channels", () => {
  const next = hydrateChannels(emptyState(), [generalRow(), loungeRow()]);
  assert.deepEqual(next.channels.map((c) => c.id), ["channel-general"]);
  assert.deepEqual(next.loungeChannels?.map((c) => c.id), ["lounge-bugen"]);
});

test("removing a Lounge drops it from the slice", () => {
  const next = removeChannel(patchChannel(emptyState(), loungeRow()), "lounge-bugen");
  assert.equal(next.loungeChannels?.length, 0);
});

test("a channel:updated event for a Lounge does not reach the channel list", () => {
  useServerStore.setState({ current: { id: SERVER_ID, slug: "acme", name: "Acme", role: "member" } } as never);
  useChannelStore.setState({ channels: [], dmChannels: [], loungeChannels: [] });
  const bindings = createChannelRealtimeBindings({ emit: () => undefined }, () => undefined);
  const channelUpdated = bindings.find((binding) => binding.event === "channel:updated");
  assert.ok(channelUpdated);
  channelUpdated.handler({ channel: loungeRow() });
  channelUpdated.handler({ channel: generalRow() });

  const state = useChannelStore.getState();
  assert.deepEqual(state.channels.map((c) => c.name), ["general"]);
  assert.deepEqual(state.loungeChannels.map((c) => c.id), ["lounge-bugen"]);
});

test("ensureChannel resolves a Lounge from GET /channels/:id into the slice", async () => {
  useServerStore.setState({ current: { id: SERVER_ID, slug: "acme", name: "Acme", role: "member" } } as never);
  api.get = (async () => ({ data: loungeRow() })) as typeof api.get;
  const resolved = await useChannelStore.getState().ensureChannel("lounge-bugen");
  assert.equal(resolved?.loungeAgentId, "agent-bugen");
  assert.equal(useChannelStore.getState().channels.length, 0);
  assert.equal(useChannelStore.getState().loungeChannels.length, 1);
  // A second ensure reads the slice, not the network.
  api.get = (async () => { throw new Error("no second read"); }) as typeof api.get;
  assert.equal((await useChannelStore.getState().ensureChannel("lounge-bugen"))?.id, "lounge-bugen");
});

test("openLounge posts to the agent's Lounge and keeps the answer in the slice", async () => {
  useServerStore.setState({ current: { id: SERVER_ID, slug: "acme", name: "Acme", role: "member" } } as never);
  const posts: string[] = [];
  api.post = (async (url: string) => {
    posts.push(url);
    // An answer whose row leaves loungeAgentId off still lands in the slice.
    const { loungeAgentId: _drop, ...row } = loungeRow();
    void _drop;
    return { data: { channel: row, joined: false, canPost: true } };
  }) as typeof api.post;

  const opened = await useChannelStore.getState().openLounge("agent-bugen");
  assert.deepEqual(posts, ["/agents/agent-bugen/lounge"]);
  assert.equal(opened.channel.id, "lounge-bugen");
  assert.equal(opened.joined, false);
  assert.equal(opened.canPost, true);
  const state = useChannelStore.getState();
  assert.equal(state.channels.length, 0);
  assert.equal(state.loungeChannels[0]?.loungeAgentId, "agent-bugen");
  assert.equal(state.loungeChannels[0]?.canPost, true);
});
