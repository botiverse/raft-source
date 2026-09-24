import assert from "node:assert/strict";
import test from "node:test";
import {
  parseRefToken,
  resolveRef,
  resolveRefTarget,
} from "../src/utils/refTarget";
import type {
  RefNavContext,
} from "../src/utils/refTarget";

type Channel = RefNavContext["channels"][number];

function ch(over: Partial<Channel>): Channel {
  return {
    id: "id",
    name: "name",
    type: "channel",
    ...over,
  } as Channel;
}

function makeCtx(channels: Channel[], over: Partial<RefNavContext> = {}): {
  ctx: RefNavContext;
  calls: string[];
  loadCount: () => number;
} {
  const calls: string[] = [];
  let loads = 0;
  const ctx: RefNavContext = {
    serverSlug: "server",
    getAuthority: () => ({ serverSlug: "server", serverEpoch: 1 }),
    channels,
    summaries: {},
    followedThreads: [],
    loadThreadContext: async () => {
      loads++;
      return { targetMessageId: "PARENT_FROM_BACKEND" };
    },
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
    onThreadUnavailable: (m) => calls.push(`notice:${m}`),
    ...over,
  };
  return { ctx, calls, loadCount: () => loads };
}

test("parseRefToken: longest form wins, non-refs rejected", () => {
  assert.deepEqual(parseRefToken("#engineering:969e361f"), {
    channelName: "engineering",
    threadShortId: "969e361f",
  });
  assert.deepEqual(parseRefToken("#engineering"), { channelName: "engineering" });
  assert.deepEqual(parseRefToken("dm:@Bernard:1a2b3c4d"), {
    dmPeer: "Bernard",
    threadShortId: "1a2b3c4d",
  });
  assert.deepEqual(parseRefToken("dm:@Bernard"), { dmPeer: "Bernard" });
  assert.equal(parseRefToken("not a ref"), null);
  // partial / embedded must NOT parse as a whole-token ref
  assert.equal(parseRefToken("prefix#engineering"), null);
});

test("resolveRef is synchronous and side-effect free (no loadThreadContext at resolve)", () => {
  const { ctx, calls, loadCount } = makeCtx([ch({ id: "C1", name: "engineering" })]);
  const r = resolveRef({ channelName: "engineering", threadShortId: "969e361f" }, ctx);
  assert.equal(r.kind, "channel-thread");
  assert.equal(r.resolvable, true);
  assert.equal(loadCount(), 0, "resolve must not hit the backend");
  assert.deepEqual(calls, [], "resolve must not navigate");
});

test("channel ref: resolvable navigates to channel", () => {
  const { ctx, calls } = makeCtx([ch({ id: "C1", name: "engineering" })]);
  const r = resolveRefTarget("#engineering", ctx);
  assert.ok(r);
  assert.equal(r!.resolvable, true);
  r!.navigate();
  assert.deepEqual(calls, ["toChannel:C1"]);
});

test("joint channel ref: resolvable navigates to joint projection", () => {
  const { ctx, calls } = makeCtx([ch({ id: "J1", type: "joint", name: "proj-joint-channel" })]);
  const r = resolveRefTarget("#proj-joint-channel", ctx);
  assert.ok(r);
  assert.equal(r!.resolvable, true);
  r!.navigate();
  assert.deepEqual(calls, ["toChannel:J1"]);
});

test("unknown channel → plain-text fallback (not a dead link)", () => {
  const { ctx } = makeCtx([ch({ id: "C1", name: "engineering" })]);
  const r = resolveRefTarget("#nope", ctx);
  assert.ok(r);
  assert.equal(r!.resolvable, false);
  assert.equal(r!.label, "#nope");
});

test("thread ref stays resolvable on local miss; navigate() awaits backend then opens thread", async () => {
  const { ctx, calls, loadCount } = makeCtx([ch({ id: "C1", name: "engineering" })]);
  const r = resolveRefTarget("#engineering:969e361f", ctx);
  assert.ok(r);
  // Bugen caveat: parent not in local summaries/followed ≠ unresolvable.
  assert.equal(r!.resolvable, true);
  await r!.navigate();
  assert.equal(loadCount(), 1);
  assert.deepEqual(calls, [
    "toMessage:C1:PARENT_FROM_BACKEND",
    "openThread:C1:PARENT_FROM_BACKEND",
  ]);
});

test("an async thread ref drops a stale context response after a server epoch round trip", async () => {
  let authority = { serverSlug: "server", serverEpoch: 7 };
  let resolveContext: ((value: { targetMessageId: string }) => void) | null = null;
  const { ctx, calls } = makeCtx([ch({ id: "C1", name: "engineering" })], {
    loadThreadContext: async () => new Promise((resolve) => {
      resolveContext = resolve;
    }),
  });
  ctx.getAuthority = () => authority;

  const pending = resolveRefTarget("#engineering:969e361f", ctx)!.navigate();
  authority = { serverSlug: "other-server", serverEpoch: 8 };
  authority = { serverSlug: "server", serverEpoch: 9 };
  assert.ok(resolveContext);
  resolveContext({ targetMessageId: "PARENT_FROM_BACKEND" });
  await pending;

  assert.deepEqual(calls, [], "the old completion cannot navigate or open after A to B to A");
});

test("an async DM thread ref drops a stale context response after a server epoch round trip", async () => {
  let authority = { serverSlug: "server", serverEpoch: 7 };
  let resolveContext: ((value: { targetMessageId: string }) => void) | null = null;
  const { ctx, calls } = makeCtx([
    ch({ id: "D1", type: "dm", name: "dm-bernard", peerName: "Bernard" }),
  ], {
    loadThreadContext: async () => new Promise((resolve) => {
      resolveContext = resolve;
    }),
  });
  ctx.getAuthority = () => authority;

  const pending = resolveRefTarget("dm:@Bernard:1a2b3c4d", ctx)!.navigate();
  authority = { serverSlug: "other-server", serverEpoch: 8 };
  authority = { serverSlug: "server", serverEpoch: 9 };
  assert.ok(resolveContext);
  resolveContext({ targetMessageId: "PARENT_FROM_BACKEND" });
  await pending;

  assert.deepEqual(calls, [], "the old DM completion cannot navigate or open after A to B to A");
});

test("thread ref: backend miss surfaces notice, no navigation", async () => {
  const { ctx, calls } = makeCtx([ch({ id: "C1", name: "engineering" })], {
    loadThreadContext: async () => ({ targetMessageId: null }),
  });
  const r = resolveRefTarget("#engineering:deadbeef", ctx)!;
  await r.navigate();
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^notice:/);
});

test("thread ref pointing at a reply opens the parent thread and focuses the reply", async () => {
  const { ctx, calls } = makeCtx([ch({ id: "C1", name: "engineering" })], {
    loadThreadContext: async () => ({
      targetMessageId: "REPLY_FROM_BACKEND",
      canonicalTarget: {
        kind: "thread",
        messageId: "REPLY_FROM_BACKEND",
        threadParentMessageId: "PARENT_FROM_CANONICAL_TARGET",
      },
    }),
  });

  const r = resolveRefTarget("#engineering:969e361f", ctx)!;
  await r.navigate();

  assert.deepEqual(calls, [
    "toMessage:C1:PARENT_FROM_CANONICAL_TARGET",
    "openThread:C1:PARENT_FROM_CANONICAL_TARGET:focus=REPLY_FROM_BACKEND",
  ]);
});

test("dm + dm-thread forms resolve against dm channels", async () => {
  const channels = [ch({ id: "D1", type: "dm", name: "dm-bernard", peerName: "Bernard" })];
  const { ctx, calls } = makeCtx(channels);

  resolveRefTarget("dm:@Bernard", ctx)!.navigate();
  assert.deepEqual(calls, ["toDm:D1"]);

  calls.length = 0;
  const t = resolveRefTarget("dm:@Bernard:1a2b3c4d", ctx)!;
  assert.equal(t.kind, "dm-thread");
  await t.navigate();
  assert.deepEqual(calls, [
    "toDmMessage:D1:PARENT_FROM_BACKEND",
    "openThread:D1:PARENT_FROM_BACKEND",
  ]);
});
