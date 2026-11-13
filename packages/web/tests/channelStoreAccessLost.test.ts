import assert from "node:assert/strict";
import { AxiosError } from "axios";
import { afterEach, beforeEach, test } from "vitest";

import api from "../src/api/client";
import { useChannelStore } from "../src/store/channelStore";
import type { Channel } from "../src/store/channelStore";
import { useServerStore } from "../src/store/serverStore";

// A refresh of a channel (channel:members-updated, channel:updated) that the
// server answers 404 means this person can no longer read it: the store drops
// it, as deleteChannel does. Only that answer, only for the row the request
// was about, only on the same server.

const originalGet = api.get.bind(api);
const originalConsoleError = console.error;

function channel(id: string, overrides: Partial<Channel> = {}): Channel {
  return {
    id,
    name: id,
    description: null,
    type: "private",
    createdAt: "2026-10-01T00:00:00.000Z",
    joined: true,
    ...overrides,
  } as Channel;
}

function notFound(): AxiosError {
  return new AxiosError("Channel not found", "ERR_BAD_REQUEST", undefined, undefined, { status: 404 } as never);
}

/** GET /channels/:id answers with `answer` once `during` has run (the round trip). */
function serveChannel(answer: () => unknown, during: () => void = () => {}) {
  api.get = (async (url: string) => {
    assert.match(url, /^\/channels\/[^/]+$/);
    during();
    const result = answer();
    if (result instanceof Error) throw result;
    return { data: result };
  }) as typeof api.get;
}

function ids(): string[] {
  return useChannelStore.getState().channels.map((candidate) => candidate.id);
}

beforeEach(() => {
  console.error = () => {};
  useServerStore.setState({ current: { id: "server-1", slug: "acme" }, serverEpoch: 1 } as never);
  useChannelStore.setState({ channels: [channel("p"), channel("general", { type: "channel" })], dmChannels: [channel("dm-1", { type: "dm" })] } as never);
});

afterEach(() => {
  api.get = originalGet;
  console.error = originalConsoleError;
});

test("a refresh answered 404 drops the channel (or DM)", async () => {
  serveChannel(notFound);
  assert.equal(await useChannelStore.getState().ensureChannel("p", { refresh: true }), null);
  assert.deepEqual(ids(), ["general"]);

  await useChannelStore.getState().ensureChannel("dm-1", { refresh: true });
  assert.deepEqual(useChannelStore.getState().dmChannels, []);
});

test("re-added during the round trip: the stale 404 leaves the newer row alone", async () => {
  const readded = channel("p", { joined: true, name: "p-again" });
  serveChannel(notFound, () => {
    // channel:updated {joined:true} patches it back in before the 404 lands.
    useChannelStore.setState((state) => ({ channels: state.channels.map((candidate) => (candidate.id === "p" ? readded : candidate)) }));
  });
  await useChannelStore.getState().ensureChannel("p", { refresh: true });
  assert.deepEqual(ids(), ["p", "general"]);
  assert.equal(useChannelStore.getState().channels[0], readded);
});

test("a 404 for a channel the store does not list (a non-member's room-wide event) changes nothing", async () => {
  serveChannel(notFound);
  const before = useChannelStore.getState();
  await useChannelStore.getState().ensureChannel("elsewhere", { refresh: true });
  assert.equal(useChannelStore.getState(), before, "the same state, not new arrays");
});

test("a 404 for a plain load (no refresh) changes nothing", async () => {
  serveChannel(notFound);
  const before = useChannelStore.getState();
  assert.equal(await useChannelStore.getState().ensureChannel("elsewhere"), null);
  assert.equal(useChannelStore.getState(), before);
});

test("another error leaves the channel", async () => {
  serveChannel(() => new AxiosError("Server error", "ERR_BAD_RESPONSE", undefined, undefined, { status: 500 } as never));
  await useChannelStore.getState().ensureChannel("p", { refresh: true });
  serveChannel(() => new Error("Network down"));
  await useChannelStore.getState().ensureChannel("p", { refresh: true });
  assert.deepEqual(ids(), ["p", "general"]);
});

test("a 404 that lands after a server switch leaves the store alone", async () => {
  serveChannel(notFound, () => {
    useServerStore.setState({ serverEpoch: 2 } as never);
  });
  await useChannelStore.getState().ensureChannel("p", { refresh: true });
  assert.deepEqual(ids(), ["p", "general"]);
});
