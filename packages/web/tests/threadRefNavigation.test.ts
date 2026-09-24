import assert from "node:assert/strict";
import test from "node:test";
import {
  buildThreadRefHandoffPath,
  buildThreadRoutePath,
  captureThreadRouteAuthorityGuard,
  consumeThreadRefHandoffSearch,
  executeThreadRefHandoffOnce,
  findThreadRefParentChannel,
  isThreadRouteAuthorityCurrent,
  findThreadParentMessageIdByShortId,
  parseThreadRefHandoff,
  resolveThreadParentMessageIdByShortId,
  resolveThreadTargetByShortId,
} from "../src/utils/threadRefNavigation";
import type { FollowedThread, ThreadSummary } from "../src/store/threadStore";

const summary: ThreadSummary = {
  threadChannelId: "thread-1",
  replyCount: 1,
  lastReplyAt: null,
  participantIds: [],
  unreadCount: 0,
  firstUnreadMessageId: null,
};

function followed(parentChannelId: string, parentMessageId: string): Pick<FollowedThread, "parentChannelId" | "parentMessageId" | "threadChannelId"> {
  return { parentChannelId, parentMessageId, threadChannelId: "thread-followed" };
}

test("summary ids alone do not establish parent-channel authority", () => {
  assert.equal(
    findThreadParentMessageIdByShortId({
      parentChannelId: "channel-1",
      shortId: "abcdef12",
      summaries: {
        "abcdef12-1111-2222-3333-444444444444": summary,
      },
      followedThreads: [],
    }),
    null,
  );
});

test("findThreadParentMessageIdByShortId filters followed threads by parent channel", () => {
  assert.equal(
    findThreadParentMessageIdByShortId({
      parentChannelId: "channel-1",
      shortId: "abcdef12",
      summaries: {},
      followedThreads: [
        followed("channel-other", "abcdef12-0000-0000-0000-000000000000"),
        followed("channel-1", "abcdef12-1111-2222-3333-444444444444"),
      ],
    }),
    "abcdef12-1111-2222-3333-444444444444",
  );
});

test("findThreadParentMessageIdByShortId returns null for ambiguous local matches", () => {
  assert.equal(
    findThreadParentMessageIdByShortId({
      parentChannelId: "channel-1",
      shortId: "abcdef",
      summaries: {},
      followedThreads: [
        followed("channel-1", "abcdef12-1111-2222-3333-444444444444"),
        followed("channel-1", "abcdef99-1111-2222-3333-444444444444"),
      ],
    }),
    null,
  );
});

test("resolveThreadParentMessageIdByShortId falls back to message context lookup", async () => {
  const calls: Array<{ parentChannelId: string; shortId: string }> = [];
  const parentMessageId = await resolveThreadParentMessageIdByShortId({
    serverSlug: "server-1",
    parentChannelId: "channel-1",
    shortId: "29a90e07",
    summaries: {},
    followedThreads: [],
    loadContext: async (parentChannelId, shortId) => {
      calls.push({ parentChannelId, shortId });
      return { targetMessageId: "29a90e07-1111-2222-3333-444444444444" };
    },
  });

  assert.equal(parentMessageId, "29a90e07-1111-2222-3333-444444444444");
  assert.deepEqual(calls, [{ parentChannelId: "channel-1", shortId: "29a90e07" }]);
});

test("resolveThreadParentMessageIdByShortId does not call fallback when local match is unique", async () => {
  let fallbackCalled = false;
  const parentMessageId = await resolveThreadParentMessageIdByShortId({
    serverSlug: "server-1",
    parentChannelId: "channel-1",
    shortId: "abcdef12",
    summaries: {
      "abcdef12-1111-2222-3333-444444444444": summary,
    },
    followedThreads: [followed("channel-1", "abcdef12-1111-2222-3333-444444444444")],
    loadContext: async () => {
      fallbackCalled = true;
      return { targetMessageId: "remote" };
    },
  });

  assert.equal(parentMessageId, "abcdef12-1111-2222-3333-444444444444");
  assert.equal(fallbackCalled, false);
});

test("resolveThreadTargetByShortId maps thread replies to parent thread with focus", async () => {
  const target = await resolveThreadTargetByShortId({
    serverSlug: "server-1",
    parentChannelId: "channel-1",
    shortId: "feedface",
    summaries: {},
    followedThreads: [],
    loadContext: async () => ({
      targetMessageId: "feedface-1111-2222-3333-444444444444",
      canonicalTarget: {
        kind: "thread",
        messageId: "feedface-1111-2222-3333-444444444444",
        threadParentMessageId: "29a90e07-1111-2222-3333-444444444444",
      },
    }),
  });

  assert.deepEqual(target, {
    serverSlug: "server-1",
    parentChannelId: "channel-1",
    parentMessageId: "29a90e07-1111-2222-3333-444444444444",
    threadChannelId: null,
    focusedMessageId: "feedface-1111-2222-3333-444444444444",
  });
});

test("resolveThreadTargetByShortId preserves the authoritative joint projection route", async () => {
  const target = await resolveThreadTargetByShortId({
    serverSlug: "guest-server",
    parentChannelId: "clicked-host-channel",
    shortId: "feedface",
    summaries: {},
    followedThreads: [],
    loadContext: async () => ({
      targetMessageId: "feedface-1111-2222-3333-444444444444",
      canonicalTarget: {
        kind: "thread",
        channelId: "guest-parent-projection",
        messageId: "feedface-1111-2222-3333-444444444444",
        threadParentMessageId: "29a90e07-1111-2222-3333-444444444444",
        threadChannelId: "guest-thread-projection",
      },
    }),
  });

  assert.deepEqual(target, {
    serverSlug: "guest-server",
    parentChannelId: "guest-parent-projection",
    parentMessageId: "29a90e07-1111-2222-3333-444444444444",
    threadChannelId: "guest-thread-projection",
    focusedMessageId: "feedface-1111-2222-3333-444444444444",
  });
});

test("cross-server thread intents never bind a same-named local channel", () => {
  assert.equal(
    findThreadRefParentChannel(
      {
        serverSlug: "host-server",
        parentChannelName: "src",
        shortId: "abcdef12",
      },
      "guest-server",
      [{ id: "guest-src", name: "src", type: "channel" }],
    ),
    null,
  );
});

test("thread handoff is an explicit server-scoped intent and malformed input fails closed", () => {
  const path = buildThreadRefHandoffPath({
    serverSlug: "host-server",
    parentChannelName: "src",
    shortId: "abcdef12",
    focusedMessageId: "feedface-1111-2222-3333-444444444444",
  });
  const url = new URL(path, "https://app.slock.ai");
  const handoffId = url.searchParams.get("threadRefNonce");
  assert.ok(handoffId);
  const secondUrl = new URL(buildThreadRefHandoffPath({
    serverSlug: "host-server",
    parentChannelName: "src",
    shortId: "abcdef12",
  }), "https://app.slock.ai");
  assert.notEqual(secondUrl.searchParams.get("threadRefNonce"), handoffId, "each explicit click gets a fresh nonce");

  assert.deepEqual(parseThreadRefHandoff("host-server", url.search), {
    serverSlug: "host-server",
    handoffId,
    parentChannelName: "src",
    parentChannelType: "channel",
    shortId: "abcdef12",
    focusedMessageId: "feedface-1111-2222-3333-444444444444",
  });
  assert.equal(parseThreadRefHandoff("host-server", "?threadRef=abcdef12"), null);
  assert.equal(
    consumeThreadRefHandoffSearch(`${url.search}&keep=1`),
    "?keep=1",
    "the authority handoff is consumed exactly once without deleting unrelated query state",
  );
});

test("typed thread routes are cold-startable and preserve reply focus", () => {
  assert.equal(
    buildThreadRoutePath({
      serverSlug: "guest-server",
      parentChannelId: "guest-parent-projection",
      parentMessageId: "29a90e07-1111-2222-3333-444444444444",
      threadChannelId: "guest-thread-projection",
      focusedMessageId: "feedface-1111-2222-3333-444444444444",
    }),
    "/s/guest-server/channel/guest-parent-projection?thread=guest-parent-projection%3A29a90e07-1111-2222-3333-444444444444&msg=feedface-1111-2222-3333-444444444444",
  );
});

test("thread route authority rejects stale epochs even after switching back to the same server", () => {
  assert.equal(isThreadRouteAuthorityCurrent("host", 7, "host", 7), true);
  assert.equal(isThreadRouteAuthorityCurrent("host", 7, "guest", 8), false);
  assert.equal(
    isThreadRouteAuthorityCurrent("host", 7, "host", 9),
    false,
    "A to B to A cannot revive an old handoff response",
  );
});

test("captured thread route authority cannot be revived by returning to the same slug", () => {
  let authority = { serverSlug: "host" as string | null, serverEpoch: 7 };
  const isCurrent = captureThreadRouteAuthorityGuard("host", () => authority);

  assert.equal(isCurrent(), true);
  authority = { serverSlug: "guest", serverEpoch: 8 };
  assert.equal(isCurrent(), false);
  authority = { serverSlug: "host", serverEpoch: 9 };
  assert.equal(isCurrent(), false);
});

test("production handoff consumes before await and a thrown resolve cannot replay the old entry", async () => {
  const consumedHandoffs = new Set<string>();
  const events: string[] = [];
  let resolveCalls = 0;
  const options = {
    consumedHandoffs,
    intent: {
      handoffId: "nonce-1",
      serverSlug: "host",
      parentChannelName: "src",
      shortId: "abcdef12",
    },
    serverSlug: "host",
    serverEpoch: 7,
    channels: [{ id: "host-src", name: "src", type: "channel" }],
    consume: () => { events.push("consume"); },
    resolve: async () => {
      resolveCalls += 1;
      assert.match(events.at(-1) ?? "", /^consume/, "the URL handoff is consumed before resolve starts");
      if (resolveCalls === 1) throw new Error("switch/resolve failed");
      return {
        serverSlug: "host",
        parentChannelId: "host-src",
        parentMessageId: "abcdef12-1111-2222-3333-444444444444",
      };
    },
    getAuthority: () => ({ serverSlug: "host", serverEpoch: 7 }),
    onOpen: () => { events.push("open"); },
    onFailure: () => { events.push("failure"); },
  };

  assert.equal(await executeThreadRefHandoffOnce(options), "failed");
  assert.equal(await executeThreadRefHandoffOnce(options), "already-consumed");
  assert.equal(resolveCalls, 1, "the consumed nonce cannot resolve a second time");
  assert.equal(
    await executeThreadRefHandoffOnce({
      ...options,
      intent: { ...options.intent, handoffId: "nonce-2" },
      consume: () => { events.push("consume-new"); },
    }),
    "opened",
  );
  assert.equal(resolveCalls, 2, "a fresh nonce for the same target remains actionable");
  assert.deepEqual(events, ["consume", "failure", "consume-new", "open"]);
});

test("production handoff tombstones have bounded FIFO retention", async () => {
  const consumedHandoffs = new Set<string>();
  const base = {
    consumedHandoffs,
    maxConsumedHandoffs: 2,
    serverSlug: "host",
    serverEpoch: 7,
    channels: [{ id: "host-src", name: "src", type: "channel" }],
    consume: () => {},
    resolve: async () => null,
    getAuthority: () => ({ serverSlug: "host", serverEpoch: 7 }),
    onOpen: () => {},
    onFailure: () => {},
  };
  for (const handoffId of ["nonce-1", "nonce-2", "nonce-3"]) {
    await executeThreadRefHandoffOnce({
      ...base,
      intent: { handoffId, serverSlug: "host", parentChannelName: "src", shortId: "abcdef12" },
    });
  }

  assert.deepEqual([...consumedHandoffs], ["nonce-2", "nonce-3"]);
});

test("production handoff drops an old response after a server epoch round trip", async () => {
  let authority = { serverSlug: "host", serverEpoch: 7 };
  const events: string[] = [];
  const result = await executeThreadRefHandoffOnce({
    consumedHandoffs: new Set(),
    intent: { handoffId: "nonce-stale", serverSlug: "host", parentChannelName: "src", shortId: "abcdef12" },
    serverSlug: "host",
    serverEpoch: 7,
    channels: [{ id: "host-src", name: "src", type: "channel" }],
    consume: () => { events.push("consume"); },
    resolve: async () => {
      authority = { serverSlug: "host", serverEpoch: 9 };
      return {
        serverSlug: "host",
        parentChannelId: "host-src",
        parentMessageId: "abcdef12-1111-2222-3333-444444444444",
      };
    },
    getAuthority: () => authority,
    onOpen: () => { events.push("open"); },
    onFailure: () => { events.push("failure"); },
  });

  assert.equal(result, "stale");
  assert.deepEqual(events, ["consume"], "a stale response neither opens nor emits a current-server failure");
});

test("resolver failures return no route target instead of falling back to a local channel", async () => {
  const target = await resolveThreadTargetByShortId({
    serverSlug: "host-server",
    parentChannelId: "host-src",
    shortId: "missing",
    summaries: {},
    followedThreads: [],
    loadContext: async () => {
      throw new Error("not found");
    },
  });

  assert.equal(target, null);
});
