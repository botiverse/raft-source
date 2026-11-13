// Agent read progress (agent_read_progress_v0, artin's "A+B"): the frame
// merge (forward only, agents the hydrate exposed only) and the projection of
// the agents' read positions onto the loaded messages: who is shown, which
// row each face sits on, and the line under your latest message (only the
// agents it will not reach).
import assert from "node:assert/strict";
import { createIntl } from "react-intl";

import { en } from "../src/i18n/messages/en";
import { zhCn } from "../src/i18n/messages/zh-cn";
import {
  AGENT_READ_RELEVANCE_WINDOW,
  AGENT_READ_STATUS_MESSAGE_IDS,
  agentReadPositions,
  agentsMutedChannel,
  agentsStoppedFollowing,
  agentReadStatusRuns,
  formatAgentReadStatus,
  ownLatestMessageId,
  placeAgentReads,
  projectAgentReadStatus,
  relevantReadAgentIds,
} from "../src/store/agentReadProgressDomain";
import type { AgentReadMessageSlice, AgentReadStatusEntry } from "../src/store/agentReadProgressDomain";
import { mergeReadProgressPeers, normalizeReadProgressUpdated } from "../src/store/readReceiptDomain";
import type { ReadReceiptScope } from "../src/store/readReceiptDomain";

const peers = (states: Record<string, number>, humans: Record<string, number> = {}): ReadReceiptScope => ({
  kind: "peers",
  peers: [
    ...Object.entries(humans).map(([peerId, maxReadSeq]) => ({ peerKind: "human" as const, peerId, maxReadSeq })),
    ...Object.entries(states).map(([peerId, maxReadSeq]) => ({ peerKind: "agent" as const, peerId, maxReadSeq })),
  ],
});

function chat(id: string, seq: number | undefined, sender: string, extra: Partial<AgentReadMessageSlice> = {}): AgentReadMessageSlice {
  return {
    id,
    seq,
    senderType: sender.startsWith("a-") ? "agent" : "user",
    senderId: sender,
    messageType: "chat",
    ...extra,
  };
}

const mention = (...ids: string[]) => ids.map((id) => ({ type: "agent", id }));

// ── Frames ───────────────────────────────────────────────

test("a read_progress:updated frame normalizes its peers and drops malformed ones", () => {
  assert.deepEqual(
    normalizeReadProgressUpdated({
      scopeId: "c-1",
      peers: [
        { peerId: "a-1", maxReadSeq: 12 },
        { peerId: "", maxReadSeq: 3 },
        { peerId: "a-2", maxReadSeq: -1 },
        { peerId: "a-3", maxReadSeq: 1.5 },
        "junk",
        { peerId: "a-4", maxReadSeq: 0 },
      ],
    }),
    { scopeId: "c-1", peers: [{ peerId: "a-1", maxReadSeq: 12 }, { peerId: "a-4", maxReadSeq: 0 }] },
  );
  assert.equal(normalizeReadProgressUpdated({ scopeId: "c-1", peers: [] }), null, "nothing to apply");
  assert.equal(normalizeReadProgressUpdated({ scopeId: "", peers: [{ peerId: "a-1", maxReadSeq: 1 }] }), null);
  assert.equal(normalizeReadProgressUpdated({ scopeId: "c-1" }), null);
  assert.equal(normalizeReadProgressUpdated(null), null);
});

test("a frame only moves exposed agents forward and never adds a peer", () => {
  const scope = peers({ "a-1": 10, "a-2": 20 }, { "u-1": 5 });
  const next = mergeReadProgressPeers(scope, {
    scopeId: "c-1",
    peers: [
      { peerId: "a-1", maxReadSeq: 15 },
      { peerId: "a-2", maxReadSeq: 18 },
      { peerId: "a-9", maxReadSeq: 99 },
      { peerId: "u-1", maxReadSeq: 50 },
    ],
  });
  assert.deepEqual(next, peers({ "a-1": 15, "a-2": 20 }, { "u-1": 5 }), "a-2 does not go back; unknown and human ids are ignored");
  assert.equal(
    mergeReadProgressPeers(scope, { scopeId: "c-1", peers: [{ peerId: "a-1", maxReadSeq: 10 }] }),
    scope,
    "an equal position keeps the same object (no store write)",
  );
  const summary: ReadReceiptScope = { kind: "summary", summary: { peerCount: 60, readCountAtSeq: [] } };
  assert.equal(mergeReadProgressPeers(summary, { scopeId: "c-1", peers: [{ peerId: "a-1", maxReadSeq: 99 }] }), summary);
  assert.equal(mergeReadProgressPeers(undefined, { scopeId: "c-1", peers: [{ peerId: "a-1", maxReadSeq: 99 }] }), undefined);
});

// ── Positions and relevance ──────────────────────────────

test("positions are the agents of a per-peer scope; a summary, no hydrate or no agent shows nothing", () => {
  assert.deepEqual([...agentReadPositions(peers({ "a-1": 3 }, { "u-1": 9 }))!], [["a-1", 3]], "humans never");
  assert.equal(agentReadPositions(peers({}, { "u-1": 9 })), null);
  assert.equal(agentReadPositions({ kind: "summary", summary: { peerCount: 60, readCountAtSeq: [] } }), null);
  assert.equal(agentReadPositions(undefined), null);
});

test("relevant agents: working first, then who spoke or was mentioned most recently in the last 30 messages", () => {
  const positions = new Map([["a-old", 1], ["a-niko", 1], ["a-tenny", 1], ["a-cindy", 1], ["a-kirby", 1], ["a-quiet", 1]]);
  const messages: AgentReadMessageSlice[] = [
    chat("m-0", 1, "a-old"),
    ...Array.from({ length: AGENT_READ_RELEVANCE_WINDOW - 3 }, (_, index) => chat(`f-${index}`, 2 + index, "u-2")),
    chat("m-1", 100, "a-niko"),
    chat("m-2", 101, "u-1", { mentions: mention("a-cindy", "a-ghost") }),
    chat("m-3", 102, "a-tenny", { messageType: "system" }),
  ];
  assert.equal(messages.length, AGENT_READ_RELEVANCE_WINDOW + 1);
  assert.deepEqual(
    relevantReadAgentIds(messages, positions, ["a-kirby"]),
    ["a-kirby", "a-cindy", "a-niko"],
    "a-old is out of the window, a system line does not count, a-ghost has no position, a-quiet never appears",
  );
  assert.deepEqual(relevantReadAgentIds(messages, positions, ["a-niko"]), ["a-niko", "a-cindy"], "each agent once");
});

// ── A: placement ─────────────────────────────────────────

test("each face sits on the last loaded row at or below its position, in the given order", () => {
  const messages = [chat("m-10", 10, "u-2"), chat("m-20", 20, "a-niko"), chat("m-30", 30, "u-1"), chat("m-40", 40, "a-tenny")];
  const positions = new Map([["a-tenny", 40], ["a-niko", 45], ["a-cindy", 30], ["a-kirby", 25], ["a-behind", 5]]);
  const placement = placeAgentReads(messages, positions, ["a-tenny", "a-niko", "a-cindy", "a-kirby", "a-behind", "a-none"]);
  assert.deepEqual(Object.fromEntries(placement), {
    "m-40": ["a-tenny", "a-niko"],
    "m-30": ["a-cindy"],
    "m-20": ["a-kirby"],
  }, "read several at once: straight to the last; older than every loaded row: no face");
});

test("rows without a real seq never carry a face; a folded system line gives way to its group's row", () => {
  const messages = [
    chat("m-10", 10, "u-2"),
    chat("s-11", 11, "u-2", { messageType: "system" }),
    chat("s-12", 12, "u-2", { messageType: "system" }),
    chat("pending", undefined, "u-1"),
  ];
  const folded = new Map([["s-12", "s-11"]]);
  const placement = placeAgentReads(messages, new Map([["a-1", 12], ["a-2", 99]]), ["a-1", "a-2"], folded);
  assert.deepEqual(Object.fromEntries(placement), { "s-11": ["a-1", "a-2"] });
});

test("in a context window an agent that read past the last loaded row gets no face, never a false one on that row", () => {
  const messages = [chat("m-10", 10, "u-2"), chat("m-20", 20, "a-niko"), chat("m-30", 30, "u-1")];
  const positions = new Map([["a-past", 99], ["a-at-end", 30], ["a-inside", 25]]);
  const ids = ["a-past", "a-at-end", "a-inside"];
  assert.deepEqual(Object.fromEntries(placeAgentReads(messages, positions, ids, undefined, true)), {
    "m-30": ["a-at-end"],
    "m-20": ["a-inside"],
  }, "newer messages are not loaded: a-past stopped somewhere this window does not show");
  assert.deepEqual(Object.fromEntries(placeAgentReads(messages, positions, ids)), {
    "m-30": ["a-past", "a-at-end"],
    "m-20": ["a-inside"],
  }, "at the live edge the last row is the conversation's last message, so it is right");
});

// ── B: the line under your latest message ────────────────

test("your latest message, at the live edge and within the window only", () => {
  const messages = [chat("m-1", 1, "u-1"), chat("m-2", 2, "a-niko"), chat("m-3", 3, "u-2"), chat("m-4", 4, "u-1", { messageType: "system" })];
  assert.equal(ownLatestMessageId(messages, "u-1", false), "m-1");
  assert.equal(ownLatestMessageId(messages, "u-1", true), null, "a context window is not the conversation's end");
  assert.equal(ownLatestMessageId(messages, null, false), null);
  assert.equal(ownLatestMessageId(messages, "u-1", false, 3), null, "older than the window");
});

test("B: no line when your message reaches every agent: replied, working, read or not yet say nothing (the faces do)", () => {
  const messages = [
    chat("m-1", 10, "u-1", { mentions: mention("a-kirby", "a-cindy", "a-tenny", "a-niko") }),
    chat("m-2", 20, "a-niko"),
    chat("m-3", 30, "a-tenny"),
  ];
  const positions = new Map([["a-niko", 30], ["a-tenny", 30], ["a-cindy", 10], ["a-kirby", 9]]);
  const relevant = ["a-tenny", "a-niko", "a-cindy", "a-kirby"];
  assert.equal(projectAgentReadStatus(messages, "m-1", positions, relevant, ["a-tenny"]), null, "mentioned: replied, working, read, not yet");
  assert.equal(
    projectAgentReadStatus([chat("m-1", 10, "u-1"), chat("m-2", 20, "a-niko")], "m-1", positions, ["a-niko", "a-cindy", "a-kirby"], []),
    null,
    "no mention: replied, read, not yet",
  );
  assert.equal(
    projectAgentReadStatus(messages, "m-1", positions, relevant, ["a-tenny"], [], new Set(), new Set()),
    null,
    "no follow or mute data at all",
  );
});

test("B: nothing for no one to count, a send without a seq, or no message", () => {
  const messages = [chat("m-1", 10, "u-1"), chat("pending", undefined, "u-1")];
  const positions = new Map([["a-1", 3]]);
  const stopped = new Set(["a-1"]);
  assert.deepEqual(projectAgentReadStatus(messages, "m-1", positions, ["a-1"], [], [], stopped), [{ agentId: "a-1", state: "stoppedFollowing" }]);
  assert.equal(projectAgentReadStatus(messages, "m-1", positions, [], [], [], stopped), null);
  assert.equal(projectAgentReadStatus(messages, "pending", positions, ["a-1"], [], [], stopped), null);
  assert.equal(projectAgentReadStatus(messages, null, positions, ["a-1"], [], [], stopped), null);
});

test("who stopped following comes from the detail's agents only; unknown is never stopped", () => {
  const scope: ReadReceiptScope = {
    kind: "peers",
    peers: [
      { peerKind: "agent", peerId: "a-1", maxReadSeq: 3, stoppedFollowing: true },
      { peerKind: "agent", peerId: "a-2", maxReadSeq: 3 },
      { peerKind: "human", peerId: "u-1", maxReadSeq: 3, stoppedFollowing: true },
    ],
  };
  assert.deepEqual([...agentsStoppedFollowing(scope)], ["a-1"]);
  assert.deepEqual([...agentsStoppedFollowing(peers({ "a-1": 3 }))], [], "a server without the field");
  assert.deepEqual([...agentsStoppedFollowing({ kind: "summary", summary: { peerCount: 2, readCountAtSeq: [] } })], []);
  assert.deepEqual([...agentsStoppedFollowing(undefined)], []);
});

test("B: an agent that stopped following and is not mentioned is the line, and only it", () => {
  const messages = [chat("m-1", 10, "a-jasper"), chat("m-2", 20, "u-1")];
  const positions = new Map([["a-jasper", 10], ["a-niko", 5], ["a-cindy", 20]]);
  assert.deepEqual(
    projectAgentReadStatus(messages, "m-2", positions, ["a-cindy", "a-niko", "a-jasper"], [], [], new Set(["a-jasper"])),
    [{ agentId: "a-jasper", state: "stoppedFollowing" }],
    "Cindy read it and Niko will: neither is on the line",
  );
});

test("B: a mention reaches an agent that stopped following: no line, before the detail catches up", () => {
  const messages = [chat("m-1", 10, "a-jasper"), chat("m-2", 20, "u-1", { mentions: mention("a-jasper") })];
  const stopped = new Set(["a-jasper", "a-niko"]);
  const positions = new Map([["a-jasper", 10], ["a-niko", 10]]);
  assert.equal(projectAgentReadStatus(messages, "m-2", positions, ["a-jasper", "a-niko"], [], [], stopped), null);
  assert.equal(projectAgentReadStatus(messages, "m-2", new Map([["a-jasper", 20]]), ["a-jasper"], [], [], stopped), null);
});

test("B: what an agent already did with your message stands after it stopped following: no line", () => {
  const stopped = new Set(["a-read", "a-replied", "a-working", "a-thread"]);
  const messages = [chat("m-1", 10, "u-1"), chat("m-2", 20, "a-replied")];
  const positions = new Map([["a-read", 10], ["a-replied", 5], ["a-working", 5], ["a-thread", 5]]);
  assert.equal(
    projectAgentReadStatus(messages, "m-1", positions, ["a-read", "a-replied", "a-working", "a-thread"], ["a-working"], ["a-thread", "u-9"], stopped),
    null,
    "read it, replied after it, typing, replied in its thread",
  );
});

test("B's words for stopped following: the verb first, shared by its names", () => {
  const intl = createIntl({ locale: "en", messages: en });
  const zh = createIntl({ locale: "zh-CN", messages: zhCn });
  const name = (agentId: string) => agentId.slice(2);
  const format = (target: typeof intl, entries: AgentReadStatusEntry[]) => formatAgentReadStatus(
    entries, name, target.formatMessage, (names) => target.formatList(names, { type: "conjunction" }),
  );
  const jasper: AgentReadStatusEntry = { agentId: "a-Jasper", state: "stoppedFollowing" };
  const ray: AgentReadStatusEntry = { agentId: "a-Ray", state: "stoppedFollowing" };
  assert.equal(format(intl, [jasper]), "Stopped following: Jasper");
  assert.equal(format(zh, [jasper]), "已停止关注：Jasper");
  assert.equal(format(intl, [jasper, ray]), "Stopped following: Jasper and Ray");
  assert.equal(format(intl, []), "");
});

test("B never folds stopped following into a line's +N: past the cap it keeps its count in its segment", () => {
  const intl = createIntl({ locale: "en", messages: en });
  const name = (agentId: string) => agentId.slice(2);
  const list = (names: string[]) => intl.formatList(names, { type: "conjunction" });
  const format = (entries: AgentReadStatusEntry[], maxNames?: number, hint?: string) => (
    formatAgentReadStatus(entries, name, intl.formatMessage, list, maxNames, hint)
  );
  const stopped = (...names: string[]) => names.map((agent): AgentReadStatusEntry => ({ agentId: `a-${agent}`, state: "stoppedFollowing" }));

  assert.equal(format(stopped("A", "B", "C")), "Stopped following: A, B, and C");
  assert.equal(
    format(stopped("A", "B", "C", "D", "E")),
    "Stopped following: A, B, C +2",
    "three names, and the rest stay counted in the segment",
  );
  assert.equal(
    format(stopped("Jasper"), 3, "Mention them to reach them"),
    "Stopped following: Jasper · Mention them to reach them",
    "the hint follows the agents it is about",
  );
  assert.equal(
    format(stopped("A", "B", "C", "D"), 4),
    "Stopped following: A, B, C, and D",
    "the tooltip: every name, the same order, no hint (the line shows it)",
  );
  assert.equal(
    format(stopped("A", "B", "C", "D"), 4, "Mention them to reach them"),
    "Stopped following: A, B, C, and D · Mention them to reach them",
    "the screen-reader text: every name, then the hint, once",
  );

  const zh = createIntl({ locale: "zh-CN", messages: zhCn });
  assert.equal(
    formatAgentReadStatus(stopped("A", "B", "C", "D"), name, zh.formatMessage, (names) => zh.formatList(names, { type: "conjunction" })),
    "已停止关注：A、B、C +1",
    "the list that goes on uses the locale's own separator",
  );
});

test("B's segments for the line: a state, its names as one list, and the count past the cap apart from them", () => {
  const intl = createIntl({ locale: "en", messages: en });
  const zh = createIntl({ locale: "zh-CN", messages: zhCn });
  const name = (agentId: string) => agentId.slice(2);
  const list = (target: typeof intl) => (names: string[]) => target.formatList(names, { type: "conjunction" });
  const as = (state: AgentReadStatusEntry["state"], ...names: string[]) => names.map((agent): AgentReadStatusEntry => ({ agentId: `a-${agent}`, state }));

  assert.deepEqual(agentReadStatusRuns(as("muted", "Niko"), name, list(intl)), [{ state: "muted", names: "Niko", more: 0, total: 1 }]);
  assert.deepEqual(
    agentReadStatusRuns(as("muted", "A", "B", "C", "D"), name, list(intl)),
    [{ state: "muted", names: "A, B, C", more: 1, total: 4 }],
    "a list that goes on: no \"and\", the rest counted apart, so the line can cut the names and keep the count",
  );
  assert.deepEqual(agentReadStatusRuns(as("muted", "A", "B", "C", "D"), name, list(zh)), [{ state: "muted", names: "A、B、C", more: 1, total: 4 }]);
  assert.deepEqual(
    agentReadStatusRuns([...as("stoppedFollowing", "A", "B", "C"), ...as("muted", "D", "E")], name, list(intl)),
    [{ state: "stoppedFollowing", names: "A, B", more: 1, total: 3 }, { state: "muted", names: "D", more: 1, total: 2 }],
    "each segment keeps a name; stopped following first",
  );
  assert.deepEqual(agentReadStatusRuns([], name, list(intl)), []);
  // The count a segment shows when not one name fits, in its verb's {names} slot.
  const agentCount = (target: typeof intl, count: number) => target.formatMessage(
    { id: AGENT_READ_STATUS_MESSAGE_IDS.muted },
    { names: target.formatMessage({ id: AGENT_READ_STATUS_MESSAGE_IDS.agentCount }, { count }) },
  );
  assert.equal(agentCount(intl, 4), "Muted: 4 agents");
  assert.equal(agentCount(intl, 1), "Muted: 1 agent");
  assert.equal(agentCount(zh, 4), "已静音：4 个 Agent");
});

test("who muted the channel comes from the detail's agents only; unknown is never muted", () => {
  const scope: ReadReceiptScope = {
    kind: "peers",
    peers: [
      { peerKind: "agent", peerId: "a-1", maxReadSeq: 3, mutedChannel: true },
      { peerKind: "agent", peerId: "a-2", maxReadSeq: 3, stoppedFollowing: true },
      { peerKind: "human", peerId: "u-1", maxReadSeq: 3, mutedChannel: true },
    ],
  };
  assert.deepEqual([...agentsMutedChannel(scope)], ["a-1"]);
  assert.deepEqual([...agentsStoppedFollowing(scope)], ["a-2"], "the two facts stay apart");
  assert.deepEqual([...agentsMutedChannel(peers({ "a-1": 3 }))], [], "a server without the field");
  assert.deepEqual([...agentsMutedChannel({ kind: "summary", summary: { peerCount: 2, readCountAtSeq: [] } })], []);
  assert.deepEqual([...agentsMutedChannel(undefined)], []);
});

test("B: muted among agents that read or replied: the line is only the muted one; stopped following comes before muted", () => {
  const messages = [chat("m-1", 10, "a-jasper"), chat("m-2", 20, "u-1"), chat("m-3", 30, "a-replied")];
  const positions = new Map([["a-jasper", 10], ["a-niko", 5], ["a-cindy", 20], ["a-replied", 30]]);
  const muted = new Set(["a-jasper", "a-cindy", "a-replied"]);
  assert.deepEqual(
    projectAgentReadStatus(messages, "m-2", positions, ["a-replied", "a-cindy", "a-niko", "a-jasper"], [], [], new Set(), muted),
    [{ agentId: "a-jasper", state: "muted" }],
    "Cindy (muted) read it, Replied (muted) answered, Niko will read it",
  );
  assert.deepEqual(
    projectAgentReadStatus(messages, "m-2", positions, ["a-jasper", "a-niko"], [], [], new Set(["a-niko"]), new Set(["a-jasper"])),
    [{ agentId: "a-niko", state: "stoppedFollowing" }, { agentId: "a-jasper", state: "muted" }],
    "stopped following first, then muted",
  );
});

test("B: a mention pierces a channel mute: no line", () => {
  const messages = [chat("m-1", 10, "a-jasper"), chat("m-2", 20, "u-1", { mentions: mention("a-jasper") })];
  const muted = new Set(["a-jasper", "a-niko"]);
  const positions = new Map([["a-jasper", 10], ["a-niko", 10]]);
  assert.equal(
    projectAgentReadStatus(messages, "m-2", positions, ["a-jasper", "a-niko"], [], [], new Set(), muted),
    null,
    "the mentioned agent will read it; the others are not the message's audience",
  );
});

test("B's words for muted: the verb first, past the cap counted in its segment, beside stopped following with one hint after both", () => {
  const intl = createIntl({ locale: "en", messages: en });
  const zh = createIntl({ locale: "zh-CN", messages: zhCn });
  const name = (agentId: string) => agentId.slice(2);
  const format = (target: typeof intl, entries: AgentReadStatusEntry[], maxNames?: number, hint?: string) => formatAgentReadStatus(
    entries, name, target.formatMessage, (names) => target.formatList(names, { type: "conjunction" }), maxNames, hint,
  );
  const as = (state: AgentReadStatusEntry["state"], ...names: string[]) => names.map((agent): AgentReadStatusEntry => ({ agentId: `a-${agent}`, state }));
  const hint = "Mention them to reach them";

  assert.equal(format(intl, as("muted", "Jasper")), "Muted: Jasper");
  assert.equal(format(zh, as("muted", "Jasper")), "已静音：Jasper");
  assert.equal(format(intl, as("muted", "Jasper", "Ray")), "Muted: Jasper and Ray");
  assert.equal(format(intl, as("muted", "A", "B", "C", "D")), "Muted: A, B, C +1", "past the cap, counted in its own segment");
  assert.equal(format(intl, as("muted", "Jasper"), 3, hint), "Muted: Jasper · Mention them to reach them");
  // Both kinds at once: each keeps a segment and at least one name, the hint comes once, after both.
  assert.equal(
    format(intl, [...as("stoppedFollowing", "A", "B", "C"), ...as("muted", "D", "E")]),
    "Stopped following: A, B +1 · Muted: D +1",
  );
  assert.equal(
    format(intl, [...as("stoppedFollowing", "A"), ...as("muted", "D")], 2, hint),
    "Stopped following: A · Muted: D · Mention them to reach them",
  );
  assert.equal(
    format(zh, as("muted", "A", "B", "C", "D")),
    "已静音：A、B、C +1",
  );
});
