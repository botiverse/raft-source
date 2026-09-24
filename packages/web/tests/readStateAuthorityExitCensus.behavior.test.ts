import assert from "node:assert/strict";
import test from "node:test";

import api from "../src/api/client";
import { useServerStore } from "../src/store/serverStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMessageStore } from "../src/store/messageStore";
import { useInboxStore } from "../src/store/inboxStore";
import { getAcceptedReadState, resetReadStateSyncForTests } from "../src/store/readStateSync";

/**
 * #632 C1 — authority-exit census (task #402).
 *
 * RED-FIRST, and deliberately behavioural rather than a source scan.
 *
 * @赵梓淇 rejected an earlier framing of mine that treated
 * `reduceChannelWithTrace` as one insertion point covering four channelStore
 * loops. It is a state-transition/trace wrapper: it receives a reducer closure,
 * never the response, so the `ApiChannel` payload stays closed over at each IO
 * callsite. The frozen shape is therefore ONE adapter implementation behind
 * SIX explicit IO call sites.
 *
 * This file is the census. One test per HTTP loop, each asserting the ledger
 * actually absorbed that response's union — so deleting any single adapter call
 * reddens exactly the loop it was deleted from.
 *
 * WHAT THIS DOES NOT DO (@赵梓淇 caught an earlier claim of mine that it did):
 * it is NOT an exhaustiveness guard. Adding a SEVENTH authority exit and not
 * wiring it leaves this suite green — nothing here enumerates the endpoints the
 * stores actually call. A real exhaustiveness check would have to inspect
 * source, which this repo forbids in tests, so the gap is stated rather than
 * papered over: a new authority exit is caught by review, not by this file.
 *
 * Why it must be behavioural: a grep for "does this file call the adapter"
 * passes the moment the call exists anywhere in the module, including on a
 * branch the response never reaches.
 */

const SERVER_ID = "server-1";
const realGet = api.get;

function stubGet(byUrl: Record<string, unknown>) {
  api.get = (async (url: string) => {
    for (const [prefix, data] of Object.entries(byUrl)) {
      if (url === prefix || url.startsWith(`${prefix}?`)) return { data };
    }
    return { data: [] };
  }) as typeof api.get;
}

function channelRow(id: string, maxReadSeq: string) {
  return {
    id,
    name: `c-${id}`,
    type: "channel",
    serverId: SERVER_ID,
    readState: { kind: "present", readStateVersion: 5, maxReadSeq, latestActivity: null },
  };
}

test.beforeEach(() => {
  resetReadStateSyncForTests();
  useServerStore.setState({ current: { id: SERVER_ID } as never, serverEpoch: 1 } as never);
});

test.afterEach(() => {
  api.get = realGet;
});

test("exit 1/6 — GET /channels folds its union into the ledger", async () => {
  stubGet({ "/channels": [channelRow("chan-a", "101")] });

  await useChannelStore.getState().loadChannels();

  assert.equal(
    getAcceptedReadState(SERVER_ID, "chan-a")?.maxReadSeq,
    101,
    "the channel list is an authority exit; if it does not fold, the Sidebar keeps the pre-C1 authority " +
      "whenever the user never opens Activity",
  );
});

test("exit 2/6 — GET /channels/dm folds its union into the ledger", async () => {
  stubGet({ "/channels/dm": [channelRow("dm-a", "202")] });

  await useChannelStore.getState().loadDMChannels();

  assert.equal(getAcceptedReadState(SERVER_ID, "dm-a")?.maxReadSeq, 202);
});

test("exit 3/6 — GET /channels/:id folds its union into the ledger", async () => {
  stubGet({ "/channels/chan-b": channelRow("chan-b", "303") });

  await useChannelStore.getState().ensureChannel("chan-b");

  assert.equal(
    getAcceptedReadState(SERVER_ID, "chan-b")?.maxReadSeq,
    303,
    "the single-channel hydrate is the same authority; a deep link that lands straight in a channel " +
      "must not be served stale read state",
  );
});

test("exit 4/6 — addOrRefreshDM folds its union into the ledger", async () => {
  stubGet({ "/channels/dm": [channelRow("dm-b", "404")] });

  await useChannelStore.getState().addOrRefreshDM("dm-b");

  assert.equal(getAcceptedReadState(SERVER_ID, "dm-b")?.maxReadSeq, 404);
});

test("exit 5/6 — GET /channels/unread folds its union into the ledger", async () => {
  stubGet({
    "/channels/unread": {
      // Object map keyed by channel id — the real contract shape, verified
      // against parseUnreadSnapshot. An array stub here would have passed
      // while the production payload threw.
      channels: {
        "chan-c": {
          unreadCount: 3,
          readState: { kind: "present", readStateVersion: 5, maxReadSeq: "505", latestActivity: null },
        },
      },
    },
  });

  await useMessageStore.getState().loadUnreadCounts();

  assert.equal(getAcceptedReadState(SERVER_ID, "chan-c")?.maxReadSeq, 505);
});

test("exit 6/6 — GET /channels/inbox folds its union into the ledger", async () => {
  stubGet({
    "/channels/inbox": {
      items: [
        {
          kind: "channel",
          channelId: "chan-d",
          channelName: "d",
          channelType: "channel",
          lastMessageId: "m1",
          lastMessageAt: "2026-01-01T00:00:00.000Z",
          lastMessagePreview: "",
          lastMessageSenderType: "user",
          lastMessageSenderId: "u1",
          lastMessageSenderName: null,
          firstUnreadMessageId: null,
          firstMentionMessageId: null,
          unreadCount: 1,
          hasMention: false,
          readState: { kind: "present", readStateVersion: 5, maxReadSeq: "606", latestActivity: null },
        },
      ],
    },
  });

  await useInboxStore.getState().loadInbox();

  assert.equal(getAcceptedReadState(SERVER_ID, "chan-d")?.maxReadSeq, 606);
});

test("a corrupt union from any exit does not poison the other scopes", async () => {
  stubGet({
    "/channels": [
      channelRow("chan-ok", "700"),
      { id: "chan-bad", name: "bad", type: "channel", serverId: SERVER_ID, readState: { kind: "corrupt" } },
    ],
  });

  await useChannelStore.getState().loadChannels();

  assert.equal(getAcceptedReadState(SERVER_ID, "chan-ok")?.maxReadSeq, 700);
  assert.equal(getAcceptedReadState(SERVER_ID, "chan-bad"), null);
});

// ---------------------------------------------------------------------------
// @赵梓淇's frozen final teeth 4 and 5 (task #402): a response that is not the
// one the store is waiting for must write NOTHING — not the ledger, and not
// the suppression map.
// ---------------------------------------------------------------------------

test("final 5a — a late inbox response from a superseded SERVER writes nothing to the ledger", async () => {
  const { useInboxStore } = await import("../src/store/inboxStore");
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => { release = resolve; });

  api.get = (async (url: string) => {
    if (url.startsWith("/channels/inbox")) {
      await gate;
      return {
        data: {
          items: [{
            kind: "channel",
            channelId: "chan-late",
            channelName: "late",
            channelType: "channel",
            lastMessageId: "m1",
            lastMessageAt: "2026-01-01T00:00:00.000Z",
            lastMessagePreview: "",
            lastMessageSenderType: "user",
            lastMessageSenderId: "u1",
            lastMessageSenderName: null,
            firstUnreadMessageId: null,
            firstMentionMessageId: null,
            unreadCount: 1,
            hasMention: false,
            readState: { kind: "present", readStateVersion: 5, maxReadSeq: "999", latestActivity: null },
          }],
          // Two groups: DIFFERENT content, SAME length as the baseline. A
          // length-only assertion would pass on this payload, so the deep
          // comparison is the only thing that can catch a same-length
          // replacement.
          groups: [
            { channelId: "grp-x", channelName: "xray", channelType: "channel", count: 9 },
            { channelId: "grp-y", channelName: "yankee", channelType: "channel", count: 9 },
          ],
          hasMore: false,
          totalCount: 1,
          totalUnreadCount: 1,
        },
      };
    }
    return { data: {} };
  }) as typeof api.get;

  // Seed a NON-EMPTY baseline. Comparing an empty list against an empty list
  // proves nothing, and the late payload below carries groups of the SAME
  // LENGTH but different content, so a length-only check cannot pass either.
  useInboxStore.setState({
    groups: [
      { channelId: "grp-a", channelName: "alpha", channelType: "channel", count: 1 },
      { channelId: "grp-b", channelName: "beta", channelType: "channel", count: 2 },
    ],
  } as never);
  const inboxBefore = {
    items: useInboxStore.getState().items.map((i) => JSON.stringify(i)),
    totalCount: useInboxStore.getState().totalCount,
    totalUnreadCount: useInboxStore.getState().totalUnreadCount,
    groups: JSON.stringify(useInboxStore.getState().groups),
  };
  const pending = useInboxStore.getState().loadInbox({ reset: true });
  // the user switches servers while the response is in the air
  useServerStore.setState({ current: { id: "server-2" } as never, serverEpoch: 2 } as never);
  release?.();
  await pending;

  assert.equal(
    getAcceptedReadState("server-1", "chan-late"),
    null,
    "A's late response must not write into A's ledger after the user left A",
  );
  assert.equal(
    getAcceptedReadState("server-2", "chan-late"),
    null,
    "and it must certainly not write into B's ledger — that is the A->B leak",
  );
  // "Total zero write" means the domain too. 5b was false-green for exactly
  // this reason (it checked only the ledger while the DM list still hydrated),
  // so 5a pins the inbox domain as well.
  const inboxAfter = useInboxStore.getState();
  // Groups FIRST and deliberately: the late payload carries two groups of the
  // same length as the baseline but different content, so this assertion is the
  // only one that can catch a same-length replacement. Checked before the
  // items/counts assertions so it is not masked by them when this tooth is
  // reverse-cut.
  assert.equal(
    JSON.stringify(inboxAfter.groups),
    inboxBefore.groups,
    "groups must be byte-identical — a same-length replacement is still a write",
  );
  assert.deepEqual(
    inboxAfter.items.map((i) => JSON.stringify(i)),
    inboxBefore.items,
    "no rows from a superseded server may enter the inbox domain",
  );
  assert.equal(inboxAfter.totalCount, inboxBefore.totalCount, "nor its counts");
  assert.equal(inboxAfter.totalUnreadCount, inboxBefore.totalUnreadCount);
});

test("final 5b — a late DM refresh from a superseded epoch writes nothing", async () => {
  useServerStore.setState({ current: { id: SERVER_ID } as never, serverEpoch: 1 } as never);
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => { release = resolve; });

  api.get = (async (url: string) => {
    if (url === "/channels/dm") {
      await gate;
      return { data: [channelRow("dm-late", "777")] };
    }
    return { data: [] };
  }) as typeof api.get;

  const dmChannelsBefore = useChannelStore.getState().dmChannels.map((c) => c.id);
  const pending = useChannelStore.getState().addOrRefreshDM("dm-late");
  useServerStore.setState({ current: { id: "server-2" } as never, serverEpoch: 2 } as never);
  release?.();
  await pending;

  assert.equal(getAcceptedReadState(SERVER_ID, "dm-late"), null, "no write under the superseded server");
  assert.equal(getAcceptedReadState("server-2", "dm-late"), null, "and none under the new one");
  // The frozen property is TOTAL zero write, not zero ledger write. Asserting
  // only the ledger left this tooth green while A's DM list still hydrated
  // into B's domain store (@赵梓淇 caught it).
  assert.deepEqual(
    useChannelStore.getState().dmChannels.map((c) => c.id),
    dmChannelsBefore,
    "a late response must not hydrate the superseded server's DM list into the new server",
  );
});

// ---------------------------------------------------------------------------
// @赵梓淇 item 1: the adapter is the union's ONLY interpreter, so no domain
// object may keep a copy of it. A spread preserves `readState` at runtime even
// when a cast hides it from the type, so this is asserted on the real objects.
// ---------------------------------------------------------------------------

test("the raw union never survives into the inbox domain object", async () => {
  const { useInboxStore } = await import("../src/store/inboxStore");
  stubGet({
    "/channels/inbox": {
      items: [{
        kind: "channel",
        channelId: "chan-raw",
        channelName: "raw",
        channelType: "channel",
        lastMessageId: "m1",
        lastMessageAt: "2026-01-01T00:00:00.000Z",
        lastMessagePreview: "",
        lastMessageSenderType: "user",
        lastMessageSenderId: "u1",
        lastMessageSenderName: null,
        firstUnreadMessageId: null,
        firstMentionMessageId: null,
        unreadCount: 1,
        hasMention: false,
        readState: { kind: "present", readStateVersion: 5, maxReadSeq: "10", latestActivity: { messageId: "m1", seq: "10" } },
      }],
      hasMore: false,
      totalCount: 1,
      totalUnreadCount: 1,
    },
  });

  await useInboxStore.getState().loadInbox({ reset: true });

  const row = useInboxStore.getState().items[0];
  assert.ok(row);
  assert.equal(
    Object.prototype.hasOwnProperty.call(row, "readState"),
    false,
    "a second copy of the union in the store is a second interpreter waiting to happen",
  );
  assert.equal(
    (row as { readStateLatestActivitySeq?: string | null }).readStateLatestActivitySeq,
    "10",
    "the normalised frontier is what the row keeps",
  );
});

test("the raw union never survives into channel or DM domain objects", async () => {
  stubGet({
    "/channels": [channelRow("chan-raw2", "20")],
    "/channels/dm": [channelRow("dm-raw", "30")],
  });

  await useChannelStore.getState().loadChannels();
  await useChannelStore.getState().loadDMChannels();

  const channel = useChannelStore.getState().channels.find((c) => c.id === "chan-raw2");
  const dm = useChannelStore.getState().dmChannels.find((c) => c.id === "dm-raw");
  assert.ok(channel);
  assert.ok(dm);
  assert.equal(Object.prototype.hasOwnProperty.call(channel, "readState"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(dm, "readState"), false);
  // and the adapter still consumed it
  assert.equal(getAcceptedReadState(SERVER_ID, "chan-raw2")?.maxReadSeq, 20);
  assert.equal(getAcceptedReadState(SERVER_ID, "dm-raw")?.maxReadSeq, 30);
});
