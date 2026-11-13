import assert from "node:assert/strict";

import { ACTIVITY_TURN_APP_EVENTS_LIMIT, type ActivityTurnAppEventView } from "@botiverse/raft-shared";
import {
  attachTriggerAppEvents,
  attachTurnAppEvents,
  attachTurnSentMessages,
  triggerAppEventRef,
  TURN_SENT_MESSAGES_LIMIT,
  turnWindows,
  viewTurnSummaries,
  type TurnTriggerFacts,
  type TurnTriggerRefs,
} from "./activityTurnSummaryView";

test("task #17: each turn lists the messages it sent that the viewer can see, and only counts the rest", async () => {
  const turns = [
    { id: "late", startedAt: 200, endedAt: 300 },
    { id: "early", startedAt: 100, endedAt: 150 },
    { id: "quiet", startedAt: 160, endedAt: 190 },
  ];
  const sends = [
    { at: 110, messageId: "m1", channelId: "public" },
    { at: 120, messageId: "m2", channelId: "secret" },
    { at: 130, messageId: "m3", channelId: "public" },
    { at: 250, messageId: "m4", channelId: "dm-with-someone" },
    { at: 260, messageId: "m5", channelId: "public" },
    { at: 400, messageId: "m6", channelId: "public" }, // after the last turn's end, within the edge
  ];
  const asked: string[] = [];
  const out = await attachTurnSentMessages(turns, sends, async (channelId) => {
    asked.push(channelId);
    return channelId === "public";
  });
  assert.deepEqual(out.map((turn) => [turn.id, turn.sentMessageIds, turn.hiddenSentCount]), [
    ["late", ["m5", "m6"], 1],
    ["early", ["m1", "m3"], 1],
    ["quiet", undefined, undefined],
  ]);
  assert.deepEqual(asked.sort(), ["dm-with-someone", "public", "secret"], "one check per channel");
  assert.ok(!JSON.stringify(out).includes("secret") && !JSON.stringify(out).includes("dm-with"), "no hidden channel is named");
});

test("task #17: a long turn lists at most the cap", async () => {
  const sends = Array.from({ length: TURN_SENT_MESSAGES_LIMIT + 5 }, (_, i) => ({ at: 10 + i, messageId: `m${i}`, channelId: "public" }));
  const [turn] = await attachTurnSentMessages([{ startedAt: 0, endedAt: 1000 }], sends, async () => true);
  assert.equal(turn!.sentMessageIds?.length, TURN_SENT_MESSAGES_LIMIT);
});

test("task #17: clock skew cannot hand a turn's messages to the next turn", async () => {
  // The daemon's clock runs 3 s behind the server's: in server time the
  // reply lands after the turn ended and after the next one started.
  const turns = [
    { id: "first", startedAt: 0, endedAt: 10_000, lastReplyMessageId: "reply-1" },
    { id: "second", startedAt: 11_000, endedAt: 20_000 },
  ];
  const sends = [
    { at: 10_800, messageId: "also-first", channelId: "public" },
    { at: 13_000, messageId: "reply-1", channelId: "public" },
    { at: 13_500, messageId: "second-early", channelId: "public" },
  ];
  const out = await attachTurnSentMessages(turns, sends, async () => true);
  assert.deepEqual(out.map((turn) => turn.sentMessageIds), [["also-first", "reply-1"], ["second-early"]]);
});

test("task #17: a message at a page edge belongs to the same turn on both pages", async () => {
  const older = { id: "older", startedAt: 0, endedAt: 100_000, lastReplyMessageId: "older-reply" };
  const newer = { id: "newer", startedAt: 110_000, endedAt: 120_000 };
  const sends = [
    { at: 102_000, messageId: "older-reply", channelId: "public" },
    { at: 108_000, messageId: "newer-early", channelId: "public" },
  ];
  const [pageOne] = await attachTurnSentMessages([newer], sends, async () => true, { neighbours: [older] });
  const [pageTwo] = await attachTurnSentMessages([older], sends, async () => true, { neighbours: [newer] });
  assert.deepEqual([pageOne!.sentMessageIds, pageTwo!.sentMessageIds], [["newer-early"], ["older-reply"]]);
});

test("task #17: overlapping turn times never list one message twice", async () => {
  const turns = [
    { id: "long", startedAt: 0, endedAt: 1000 },
    { id: "inside", startedAt: 100, endedAt: 200 },
    { id: "after", startedAt: 300, endedAt: 400 },
  ];
  const out = await attachTurnSentMessages(turns, [{ at: 350, messageId: "x", channelId: "public" }], async () => true);
  assert.equal(out.filter((turn) => turn.sentMessageIds?.includes("x")).length, 1);
});

test("task #17: turns older than what the query returned keep the last-reply card instead of a partial list", async () => {
  const turns = [{ startedAt: 100_000, endedAt: 110_000 }, { startedAt: 0, endedAt: 10_000 }];
  // The query stopped at 7 s: the older turn's earlier sends may have been cut.
  const sends = [
    { at: 7_000, messageId: "old", channelId: "public" },
    { at: 105_000, messageId: "new", channelId: "public" },
  ];
  const out = await attachTurnSentMessages(turns, sends, async () => true, { listedFromMs: 7_000 });
  assert.deepEqual(out.map((turn) => turn.sentMessageIds), [["new"], undefined]);
  // Sends in the very millisecond the query stopped at may also have been cut.
  const [edge] = await attachTurnSentMessages([{ startedAt: 0, endedAt: 10_000 }], sends, async () => true, { listedFromMs: -60_000 });
  assert.equal(edge!.sentMessageIds, undefined);
});

test("task #17: the visible count is kept when the id list is capped", async () => {
  const sends = Array.from({ length: TURN_SENT_MESSAGES_LIMIT + 10 }, (_, i) => ({ at: 10 + i, messageId: `m${i}`, channelId: "public" }));
  const [turn] = await attachTurnSentMessages([{ startedAt: 0, endedAt: 1000 }], sends, async () => true);
  assert.equal(turn!.sentMessageCount, TURN_SENT_MESSAGES_LIMIT + 10);
});

function appEvent(id: string, deliveredAt: number, extra: Record<string, unknown> = {}): ActivityTurnAppEventView {
  return { id, appName: "Stamp", clientKey: "stamp", logoUrl: null, summary: `event ${id}`, deliveredAt, kind: "event", ...extra };
}

test("app notifications: each app event delivered during a turn lands in that turn, oldest first", () => {
  const turns = [
    { id: "late", startedAt: 200, endedAt: 300 },
    { id: "early", startedAt: 100, endedAt: 150 },
  ];
  // xxchan's case: three Stamp events arrive mid-turn (given newest first, as the query returns them).
  const out = attachTurnAppEvents(turns, [appEvent("c", 280), appEvent("b", 250), appEvent("a", 210), appEvent("x", 120)]);
  assert.deepEqual(out.map((turn) => [turn.id, turn.appEvents?.map((event) => event.id), turn.appEventCount]), [
    ["late", ["a", "b", "c"], 3],
    ["early", ["x"], 1],
  ]);
});

test("app notifications: an event between two turns is split at the boundary in the idle gap", () => {
  const turns = [
    { id: "first", startedAt: 0, endedAt: 10_000 },
    { id: "second", startedAt: 20_000, endedAt: 30_000 },
  ];
  // The boundary sits halfway into the gap, at 15 s.
  const out = attachTurnAppEvents(turns, [appEvent("before", 14_999), appEvent("at", 15_000), appEvent("after", 16_000)]);
  assert.deepEqual(out.map((turn) => turn.appEvents?.map((event) => event.id)), [["before"], ["at", "after"]]);
});

test("app notifications: events split exactly like sent messages, page edges and own last reply included", async () => {
  const older = { id: "older", startedAt: 0, endedAt: 100_000, lastReplyMessageId: "older-reply" };
  const turn = { id: "page", startedAt: 110_000, endedAt: 120_000 };
  const sends = [{ at: 106_000, messageId: "older-reply", channelId: "public" }];
  // The older turn's reply (daemon clock behind) moves the boundary from 105 s to just past 106 s.
  assert.deepEqual(turnWindows([turn], { neighbours: [older], sends }), [{ from: 106_001, to: 180_000 }]);
  const [withEvents] = attachTurnAppEvents([turn], [appEvent("older-own", 105_500), appEvent("page-own", 107_000)], { neighbours: [older], sends });
  const [withSends] = await attachTurnSentMessages([turn], sends, async () => true, { neighbours: [older] });
  assert.deepEqual(withEvents!.appEvents?.map((event) => event.id), ["page-own"]);
  assert.equal(withSends!.sentMessageIds, undefined, "the reply stays with the older turn on both lists");
});

test("app notifications: a long turn lists at most the cap and counts every event", () => {
  const events = Array.from({ length: ACTIVITY_TURN_APP_EVENTS_LIMIT + 7 }, (_, i) => appEvent(`e${String(i).padStart(3, "0")}`, 10 + i));
  const [turn] = attachTurnAppEvents([{ startedAt: 0, endedAt: 1000 }], events);
  assert.equal(turn!.appEvents?.length, ACTIVITY_TURN_APP_EVENTS_LIMIT);
  assert.equal(turn!.appEventCount, ACTIVITY_TURN_APP_EVENTS_LIMIT + 7);
  assert.equal(turn!.appEvents?.[0]?.id, "e000");
});

test("app notifications: a turn older than what a truncated query returned gets no partial list", () => {
  const turns = [{ startedAt: 100_000, endedAt: 110_000 }, { startedAt: 0, endedAt: 10_000 }];
  const out = attachTurnAppEvents(turns, [appEvent("new", 105_000), appEvent("old", 7_000)], { listedFromMs: 7_000 });
  assert.deepEqual(out.map((turn) => turn.appEvents?.map((event) => event.id)), [["new"], undefined]);
});

test("app notifications: only the fields the overview shows are passed on, never a payload", () => {
  const leaky = appEvent("e", 50, { payload: { secret: "token" }, payloadHash: "h", resource: "urn:x", accessTokenId: "tok" });
  const [turn] = attachTurnAppEvents([{ startedAt: 0, endedAt: 100 }], [leaky]);
  assert.deepEqual(Object.keys(turn!.appEvents![0]!).sort(), ["appName", "clientKey", "deliveredAt", "id", "kind", "logoUrl", "summary"]);
  assert.doesNotMatch(JSON.stringify(turn), /secret|token|urn:x|payload/);
});

test("app notifications: a turn woken by an app event names it when resolved, and keeps the bare trigger when not", () => {
  const turns = [
    { id: "resolved", trigger: { target: "agent-event:1a2b3c4d" } },
    { id: "pruned", trigger: { target: "agent-event:deadbeef" } },
    { id: "message", trigger: { target: "#general", channelId: "c1", sender: "tenny" } },
    { id: "hidden", trigger: { hidden: "dm" as const } },
    { id: "none" },
  ];
  assert.deepEqual(turns.map((turn) => triggerAppEventRef(turn.trigger)), ["1a2b3c4d", "deadbeef", null, null, null]);
  const out = attachTriggerAppEvents(turns, new Map([["1a2b3c4d", { appName: "Stamp", summary: "CI failed on #10827" }]]));
  assert.deepEqual(out.map((turn) => turn.trigger), [
    { target: "agent-event:1a2b3c4d", appEvent: { appName: "Stamp", summary: "CI failed on #10827" } },
    { target: "agent-event:deadbeef" },
    { target: "#general", channelId: "c1", sender: "tenny" },
    { hidden: "dm" },
    undefined,
  ]);
});

test("turn triggers: the view rebuilds a trigger from its known fields, so a producer's server-owned trigger fields never pass", async () => {
  const forged = {
    startedAt: 0,
    endedAt: 10,
    trigger: { target: "agent-event:1a2b3c4d", appEvent: { appName: "Forged", summary: "forged" }, hidden: "dm", unresolved: true, display: { kind: "dm" }, extra: "x" },
  };
  const loads: TurnTriggerRefs[] = [];
  const [view] = await viewTurnSummaries([forged as never], async () => true, async (refs) => {
    loads.push(refs);
    return noFacts;
  });
  assert.deepEqual(view, { startedAt: 0, endedAt: 10, trigger: { target: "agent-event:1a2b3c4d" } });
  assert.deepEqual(loads, [], "an app event trigger is resolved elsewhere (attachTriggerAppEvents)");
});

const noFacts: TurnTriggerFacts = { channels: new Map(), messages: new Map() };
const publicId = "c-public";
const facts: TurnTriggerFacts = {
  channels: new Map([
    [publicId, { type: "channel", name: "general" }],
    ["c-thread", { type: "thread", name: "thread-9b526607", parent: { type: "channel", name: "proj-runtime" } }],
    ["c-orphan-thread", { type: "thread", name: "thread-deadbeef", parent: null }],
    ["c-dm", { type: "dm", name: "dm-x", dmPeerName: "alice" }],
    ["c-dm-thread", { type: "thread", name: "thread-0badf00d", parent: { type: "dm", name: "dm-x" } }],
    // This server's face of a joint channel and of a joint thread: messages live in canonical storage.
    ["c-joint", { type: "joint", name: "shared", storageChannelId: "c-canonical" }],
    ["c-joint-thread", { type: "thread", name: "thread-1a2b3c4d", storageChannelId: "c-canonical-thread", parentMessageId: null, parent: { type: "joint", name: "shared" } }],
    // A thread a Slack root mention was handed in, under that root message.
    ["c-root-thread", { type: "thread", name: "thread-5e6f7a8b", parentMessageId: "m-root", parent: { type: "channel", name: "general" } }],
  ]),
  messages: new Map([
    ["m-public", { channelId: publicId, senderName: "richard" }],
    ["m-thread", { channelId: "c-thread", senderName: "tenny" }],
    ["m-dm", { channelId: "c-dm", senderName: "bob" }],
    ["m-dm-thread", { channelId: "c-dm-thread", senderName: "bob" }],
    ["m-system", { channelId: publicId }],
    ["m-joint", { channelId: "c-canonical", senderName: "alice" }],
    ["m-joint-reply", { channelId: "c-canonical-thread", senderName: "alice" }],
    ["m-root", { channelId: publicId, senderName: "Slack Root Author" }],
  ]),
};

test("turn triggers: names come from the server's channel and message rows, never the producer's target or sender", async () => {
  const turn = (trigger: Record<string, string>) => ({ startedAt: 0, endedAt: 1, trigger });
  const views = await viewTurnSummaries([
    // A forged name and sender over a public channel and a real message in it.
    turn({ target: "#ceo-private", channelId: publicId, sender: "ceo", messageId: "m-public" }),
    // A thread claimed with a wrong short id: the thread is the message's.
    turn({ target: "#proj-runtime:00000000", channelId: "c-thread", sender: "tenny", messageId: "m-thread" }),
    // Says a thread, is not one.
    turn({ target: "#general:9b526607", channelId: publicId, sender: "richard", messageId: "m-public" }),
    turn({ target: "dm:@mallory", channelId: "c-dm", sender: "mallory", messageId: "m-dm" }),
    turn({ target: "dm:@mallory:0badf00d", channelId: "c-dm-thread", sender: "mallory", messageId: "m-dm-thread" }),
    // No message id: the DM's peer, and for a channel no sender at all.
    turn({ target: "dm:@mallory", channelId: "c-dm", sender: "mallory" }),
    turn({ target: "#ceo-private", channelId: publicId, sender: "ceo" }),
    // A message without a sender handle (a system message).
    turn({ target: "#general", channelId: publicId, sender: "ceo", messageId: "m-system" }),
    // Joint: handed over with this server's channel, stored in the canonical one.
    turn({ target: "#shared", channelId: "c-joint", sender: "alice", messageId: "m-joint" }),
    turn({ target: "#shared:1a2b3c4d", channelId: "c-joint-thread", sender: "alice", messageId: "m-joint-reply" }),
    // A Slack root mention: handed over in the thread under the message.
    turn({ target: "#general:5e6f7a8b", channelId: "c-root-thread", sender: "Slack Root Author", messageId: "m-root" }),
  ], async () => true, async () => facts);
  assert.deepEqual(views.map((view) => (view.trigger as { display?: unknown }).display), [
    { kind: "channel", channelName: "general", senderName: "richard" },
    { kind: "thread", channelName: "proj-runtime", senderName: "tenny" },
    { kind: "channel", channelName: "general", senderName: "richard" },
    { kind: "dm", senderName: "bob" },
    { kind: "dm", senderName: "bob" },
    { kind: "dm", peerName: "alice" },
    { kind: "channel", channelName: "general" },
    { kind: "channel", channelName: "general" },
    { kind: "channel", channelName: "shared", senderName: "alice" },
    { kind: "thread", channelName: "shared", senderName: "alice" },
    { kind: "thread", channelName: "general", senderName: "Slack Root Author" },
  ]);
  // The producer's own fields stay as sent, for older web clients.
  assert.deepEqual(views[0]!.trigger, {
    target: "#ceo-private", channelId: publicId, sender: "ceo", messageId: "m-public",
    display: { kind: "channel", channelName: "general", senderName: "richard" },
  });
});

test("turn triggers: a trigger the server's rows do not bear out comes back unresolved, without the producer's text", async () => {
  const turn = (trigger: Record<string, string>) => ({ startedAt: 0, endedAt: 1, trigger });
  const views = await viewTurnSummaries([
    // The message is in another channel than the trigger says.
    turn({ target: "#ceo-private", channelId: publicId, sender: "ceo", messageId: "m-thread" }),
    // An unknown message, an unknown channel, a thread without a known parent.
    turn({ target: "#ceo-private", channelId: publicId, sender: "ceo", messageId: "m-gone" }),
    turn({ target: "#ceo-private", channelId: "c-gone", sender: "ceo", messageId: "m-public" }),
    turn({ target: "#ceo-private:deadbeef", channelId: "c-orphan-thread", sender: "ceo" }),
    // Another channel's message, whatever the storage: not this joint channel's, not this thread's parent.
    turn({ target: "#ceo-private", channelId: "c-joint", sender: "ceo", messageId: "m-joint-reply" }),
    turn({ target: "#ceo-private", channelId: "c-root-thread", sender: "ceo", messageId: "m-public" }),
  ], async () => true, async () => facts);
  assert.deepEqual(views.map((view) => view.trigger), Array.from({ length: 6 }, () => ({ unresolved: true })));
  assert.doesNotMatch(JSON.stringify(views), /ceo/);
});

test("turn triggers: a turn whose trigger is hidden from the viewer does not show the agent's output text", async () => {
  const views = await viewTurnSummaries([
    { startedAt: 0, endedAt: 1, lastText: "Replied in #general.", trigger: { target: "#general", channelId: publicId, sender: "richard", messageId: "m-public" } },
    { startedAt: 2, endedAt: 3, lastText: "The CEO asked about the layoffs.", trigger: { target: "#secret", channelId: "c-secret", sender: "ceo", messageId: "m-secret" } },
    { startedAt: 4, endedAt: 5, lastText: "Answered in the DM.", trigger: { target: "dm:@ceo", channelId: "c-secret-dm" } },
    { startedAt: 6, endedAt: 7, lastText: "Read the PR event." },
  ], async (channelId) => channelId === publicId, async () => facts);
  assert.deepEqual(views.map((view) => (view as { lastText?: string }).lastText), ["Replied in #general.", undefined, undefined, "Read the PR event."]);
  assert.doesNotMatch(JSON.stringify(views), /layoffs|Answered in the DM/);
});

test("turn triggers: one batched lookup per page of the distinct visible channels and messages; a hidden trigger is never looked up", async () => {
  const turn = (trigger: Record<string, string>) => ({ startedAt: 0, endedAt: 1, trigger });
  const loads: TurnTriggerRefs[] = [];
  const asked: string[] = [];
  const views = await viewTurnSummaries([
    turn({ target: "#general", channelId: publicId, sender: "richard", messageId: "m-public" }),
    turn({ target: "#general", channelId: publicId, sender: "richard", messageId: "m-public" }),
    turn({ target: "dm:@alice", channelId: "c-dm" }),
    turn({ target: "#secret", channelId: "c-secret", sender: "ceo", messageId: "m-secret" }),
    turn({ target: "dm:@ceo", channelId: "c-secret-dm", sender: "ceo", messageId: "m-secret-dm" }),
    turn({ target: "#nowhere", sender: "ceo" }),
    turn({ target: "agent-event:1a2b3c4d" }),
  ], async (channelId) => {
    asked.push(channelId);
    return channelId === publicId || channelId === "c-dm";
  }, async (refs) => {
    loads.push(refs);
    return facts;
  });
  assert.deepEqual(asked, [publicId, "c-dm", "c-secret", "c-secret-dm"], "one access check per distinct channel");
  assert.deepEqual(loads, [{ channelIds: [publicId, "c-dm"], messageIds: ["m-public"], dmPeerChannelIds: ["c-dm"] }]);
  assert.deepEqual(views.slice(3).map((view) => view.trigger), [
    { hidden: "private_channel" },
    { hidden: "dm" },
    { hidden: "private_channel" },
    { target: "agent-event:1a2b3c4d" },
  ], "hidden exactly as before");
  // No visible message trigger on the page: no lookup at all.
  await viewTurnSummaries([turn({ target: "#secret", channelId: "c-secret" })], async () => false, async (refs) => {
    loads.push(refs);
    return facts;
  });
  assert.equal(loads.length, 1);
});
