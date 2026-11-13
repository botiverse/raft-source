import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "vitest";

import api from "../src/api/client";
import { CHANNEL_DETAIL_REASON_HEADER } from "../src/store/channelDetailReason";
import { useChannelStore } from "../src/store/channelStore";
import { useReadReceiptStore } from "../src/store/readReceiptStore";
import { useServerStore } from "../src/store/serverStore";

// Opening a conversation the list does not hold loads its row
// (ensureChannel) and then its read receipts, both from GET /channels/:id.
// The receipt load takes the row's answer instead of asking again.

const originalGet = api.get.bind(api);

function serve(detail: (id: string) => Record<string, unknown>) {
  const requests: Array<{ url: string; reason: unknown }> = [];
  api.get = (async (url: string, config?: { headers?: Record<string, unknown> }) => {
    requests.push({ url, reason: config?.headers?.[CHANNEL_DETAIL_REASON_HEADER] });
    const id = url.replace(/^\/channels\//, "");
    return { data: detail(id) };
  }) as typeof api.get;
  return requests;
}

beforeEach(() => {
  useServerStore.setState({ current: { id: "server-1", slug: "acme" }, serverEpoch: 1 } as never);
  useChannelStore.setState({ channels: [], dmChannels: [] } as never);
});

afterEach(() => {
  api.get = originalGet;
  useReadReceiptStore.getState().clearAll();
});

test("a channel's row load hands its detail to the read-receipt load: one request", async () => {
  const requests = serve((id) => ({
    id,
    name: id,
    type: "channel",
    createdAt: "2026-10-01T00:00:00.000Z",
    peerReadStates: [{ peerKind: "human", peerId: "user-2", maxReadSeq: 4 }],
  }));

  await useChannelStore.getState().ensureChannel("c1");
  await useReadReceiptStore.getState().hydrateScope("c1");

  assert.deepEqual(requests, [{ url: "/channels/c1", reason: "ensure" }]);
  assert.ok(useReadReceiptStore.getState().scopes.c1);
});

test("a thread's row load does not: the thread loads its receipts when it opens", async () => {
  const requests = serve((id) => ({
    id,
    name: "",
    type: "thread",
    createdAt: "2026-10-01T00:00:00.000Z",
    peerReadStates: [],
  }));

  await useChannelStore.getState().ensureChannel("t1");
  await useReadReceiptStore.getState().hydrateScope("t1");

  assert.deepEqual(requests.map((request) => request.reason), ["ensure", "receipts"]);
});

test("a refresh and a preload say so", async () => {
  const requests = serve((id) => ({ id, name: id, type: "channel", createdAt: "2026-10-01T00:00:00.000Z" }));

  await useChannelStore.getState().ensureChannel("c2", { reason: "preload" });
  await useChannelStore.getState().ensureChannel("c2", { refresh: true });

  assert.deepEqual(requests.map((request) => request.reason), ["preload", "refresh"]);
});

test("a refresh does not join a load in flight, and the older answer coming back later is dropped", async () => {
  const answers: Array<(value: { data: unknown }) => void> = [];
  const requests: unknown[] = [];
  api.get = ((_url: string, config?: { headers?: Record<string, unknown> }) => {
    requests.push(config?.headers?.[CHANNEL_DETAIL_REASON_HEADER]);
    return new Promise((resolve) => answers.push(resolve));
  }) as typeof api.get;
  const row = (name: string) => ({ data: { id: "c3", name, type: "channel", createdAt: "2026-10-01T00:00:00.000Z" } });

  const ensure = useChannelStore.getState().ensureChannel("c3");
  const refresh = useChannelStore.getState().ensureChannel("c3", { refresh: true });
  assert.deepEqual(requests, ["ensure", "refresh"], "the refresh asked on its own");

  answers[1](row("after-change"));
  await refresh;
  answers[0](row("before-change"));
  await ensure;

  const stored = useChannelStore.getState().channels.find((candidate) => candidate.id === "c3");
  assert.equal(stored?.name, "after-change");
});

test("a plain load joins a refresh in flight", async () => {
  const requests = serve((id) => ({ id, name: id, type: "channel", createdAt: "2026-10-01T00:00:00.000Z" }));

  await Promise.all([
    useChannelStore.getState().ensureChannel("c4", { refresh: true }),
    useChannelStore.getState().ensureChannel("c4"),
  ]);

  assert.deepEqual(requests.map((request) => request.reason), ["refresh"]);
});
