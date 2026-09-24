import assert from "node:assert/strict";
import test from "node:test";
import { resolveRefTarget } from "../src/utils/refTarget";
import type { RefNavContext } from "../src/utils/refTarget";

type Channel = RefNavContext["channels"][number];

function ch(over: Partial<Channel>): Channel {
  return {
    id: "id",
    name: "name",
    type: "channel",
    ...over,
  } as Channel;
}

function makeCtx(channels: Channel[]): { ctx: RefNavContext; calls: string[] } {
  const calls: string[] = [];
  const ctx: RefNavContext = {
    serverSlug: "server",
    getAuthority: () => ({ serverSlug: "server", serverEpoch: 1 }),
    channels,
    summaries: {},
    followedThreads: [],
    loadThreadContext: async () => ({ targetMessageId: null }),
    toChannel: (id) => calls.push(`toChannel:${id}`),
    toDm: (id) => calls.push(`toDm:${id}`),
    toMessage: (cid, mid) => calls.push(`toMessage:${cid}:${mid}`),
    toDmMessage: (cid, mid) => calls.push(`toDmMessage:${cid}:${mid}`),
    openThread: ({ parentChannelId, parentMessageId, focusedMessageId }) =>
      calls.push(
        focusedMessageId
          ? `openThread:${parentChannelId}:${parentMessageId}:focus=${focusedMessageId}`
          : `openThread:${parentChannelId}:${parentMessageId}`,
      ),
  };
  return { ctx, calls };
}

test("channel refs resolve only channel-like surfaces, including joint projections", () => {
  for (const type of ["channel", "private", "joint"] as const) {
    const { ctx, calls } = makeCtx([ch({ id: `${type}-id`, type, name: "ProjectRoom" })]);
    const ref = resolveRefTarget("#projectroom", ctx);
    assert.ok(ref, `${type} channel ref should parse`);
    assert.equal(ref.resolvable, true, `${type} channel ref should resolve case-insensitively`);
    ref.navigate();
    assert.deepEqual(calls, [`toChannel:${type}-id`]);
  }
});

test("channel refs reject non-channel-like surfaces and wrong names", () => {
  const sameNameThread = makeCtx([ch({ id: "thread-id", type: "thread", name: "ProjectRoom" })]);
  assert.equal(resolveRefTarget("#ProjectRoom", sameNameThread.ctx)?.resolvable, false);
  assert.deepEqual(sameNameThread.calls, []);

  const sameNameDm = makeCtx([ch({ id: "dm-id", type: "dm", name: "ProjectRoom" })]);
  assert.equal(resolveRefTarget("#ProjectRoom", sameNameDm.ctx)?.resolvable, false);
  assert.deepEqual(sameNameDm.calls, []);

  const wrongName = makeCtx([ch({ id: "channel-id", type: "joint", name: "ProjectRoom" })]);
  assert.equal(resolveRefTarget("#OtherRoom", wrongName.ctx)?.resolvable, false);
  assert.deepEqual(wrongName.calls, []);
});
