// `createRaft({ conversationCards: true })` (glimpse G1-12): hosted agents get
// the channel and DM peer cards on reads and the one hold for an unseen card,
// by the CLI's rules. Off by default.
import assert from "node:assert/strict";
import { channelCardRev, MAX_OBSERVATIONS, renderChannelCard, SeenFrontier } from "@botiverse/raft-shared";
import { createRaft } from "./index";

const credential = "sk_agent_cards_sentinel";
const card = { id: "c-ops", name: "ops", type: "channel", description: "Release coordination. Post go/no-go here." };
const peer = { kind: "human", name: "sample-human", description: "Founder. Prefers short updates.", timezone: "Asia/Shanghai" };
const msg = (seq: number, sender: string, type: string, content: string, extra: Record<string, unknown> = {}) => ({
  id: `0000000${seq}-0000-0000-0000-000000000000`, seq, sender_name: sender, sender_type: type, timestamp: "2026-10-15T09:00:00.000Z", content, ...extra,
});

type Call = { method: string; url: string; body: Record<string, unknown> | undefined };
function server(replies: { history?: unknown[]; send?: unknown[] }) {
  const calls: Call[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ method: init?.method ?? "GET", url, body });
    const queue = url.includes("/history") ? replies.history : replies.send;
    const next = queue?.shift();
    if (next === undefined) throw new Error(`no reply for ${url}`);
    return Response.json(next);
  };
  return { calls, fetch };
}
const page = (messages: unknown[], extra: Record<string, unknown> = {}) => ({ messages, has_more: false, has_older: false, has_newer: false, ...extra });
const sent = (extra: Record<string, unknown> = {}) => ({ ok: true, state: "sent", messageId: "00000099-0000-0000-0000-000000000000", messageSeq: 99, ...extra });

test("off by default: no cards on reads, no card versions on sends", async () => {
  const { calls, fetch } = server({ history: [page([msg(1, "sample-human", "human", "hi")], { channel_card: card })], send: [sent()] });
  const raft = createRaft({ serverUrl: "https://raft.example", credential, fetch });
  raft.frontier.setContext("ctx-1");
  const read = await raft.messages.read({ target: "#ops" });
  assert.ok(read.ok && !read.text.includes("Channel #ops"));
  await raft.messages.send({ target: "#ops", content: "go" });
  assert.equal(Object.hasOwn(calls[1]!.body!, "seenCards"), false);
});

test("with a context: the card on the first read only, and the send names its version", async () => {
  const { calls, fetch } = server({
    history: [page([msg(1, "sample-human", "human", "hi")], { channel_card: card }), page([msg(1, "sample-human", "human", "hi")], { channel_card: card })],
    send: [sent()],
  });
  const raft = createRaft({ serverUrl: "https://raft.example", credential, fetch, conversationCards: true });
  const first = await raft.invoke("messages.read", { target: "#ops" }, { contextId: "ctx-1" });
  assert.ok(first.ok && first.text.startsWith('Channel #ops (public): Release coordination. Post go/no-go here.\nEquivalent: raft channel info "#ops"\n\n'), first.ok ? first.text : "");
  const second = await raft.invoke("messages.read", { target: "#ops" }, { contextId: "ctx-1" });
  assert.ok(second.ok && !second.text.includes("Channel #ops"));
  await raft.invoke("messages.send", { target: "#ops:1a2b3c4d", content: "go" }, { contextId: "ctx-1" });
  assert.deepEqual(calls[2]!.body!.seenCards, { channel: channelCardRev(card) });
});

test("a send whose context never saw the card is held once: unseen_card, then booked and resumed", async () => {
  const { calls, fetch } = server({
    send: [
      { ok: true, state: "held", holdReasons: ["channel_card"], newMessageCount: 0, heldMessages: [], channelCard: card },
      sent(),
    ],
  });
  const raft = createRaft({ serverUrl: "https://raft.example", credential, fetch, conversationCards: true, hints: "tool" });
  raft.frontier.setContext("ctx-1");
  const held = await raft.messages.send({ target: "#ops", content: "go", idempotencyKey: "k-1" });
  assert.equal(held.ok && held.state, "interrupted");
  if (!held.ok || held.state !== "interrupted") return;
  assert.deepEqual(calls[0]!.body!.seenCards, { channel: null });
  assert.equal(held.interrupt.reason, "unseen_card");
  assert.deepEqual(held.interrupt.cards, { channel: card });
  assert.match(held.text, /Equivalent: channels_info\(\{ target: "#ops" \}\)/);
  assert.match(held.next?.why ?? "", /has not seen the conversation's card/);
  assert.equal(raft.frontier.recordHeld(held.interrupt), false, "no message boundary to book");
  await raft.messages.send({ target: "#ops", content: "go", idempotencyKey: "k-1" });
  assert.deepEqual(calls[1]!.body!.seenCards, { channel: channelCardRev(card) });
});

test("unread messages and an unseen card in one hold: the card before the window, both booked", async () => {
  const { calls, fetch } = server({
    send: [
      {
        ok: true,
        state: "held",
        holdReasons: ["unread_messages", "channel_card"],
        newMessageCount: 1,
        shownMessageCount: 1,
        heldMessages: [msg(41, "sample-human", "human", "deploy at 5?")],
        seenUpToSeq: 41,
        channelCard: card,
      },
      sent(),
    ],
  });
  const raft = createRaft({ serverUrl: "https://raft.example", credential, fetch, conversationCards: true });
  raft.frontier.setContext("ctx-1");
  const held = await raft.messages.send({ target: "#ops", content: "go", idempotencyKey: "k-2" });
  if (!held.ok || held.state !== "interrupted") return assert.fail("expected an interrupt");
  assert.equal(held.interrupt.reason, "unread_messages");
  assert.deepEqual(held.interrupt.cards, { channel: card });
  const cardAt = held.text.indexOf(renderChannelCard(card).join("\n"));
  assert.ok(cardAt > 0 && cardAt < held.text.indexOf("deploy at 5?"), held.text);
  assert.equal(raft.frontier.recordHeld(held.interrupt), true);
  await raft.messages.send({ target: "#ops", content: "go", idempotencyKey: "k-2" });
  assert.deepEqual(calls[1]!.body!.seenCards, { channel: channelCardRev(card) });
  assert.equal(calls[1]!.body!.seenUpToSeq, 41);
});

test("a DM: the peer's card when nothing of them is in context; a message from them counts", async () => {
  const { calls, fetch } = server({
    history: [
      page([msg(1, "sample-agent", "agent", "ping")], { peer_card: peer }),
      page([msg(2, "sample-human", "human", "pong", { sender_description: peer.description, sender_timezone: peer.timezone })], { peer_card: peer }),
    ],
    send: [sent()],
  });
  const raft = createRaft({ serverUrl: "https://raft.example", credential, fetch, conversationCards: true });
  raft.frontier.setContext("ctx-1");
  const first = await raft.messages.read({ target: "dm:@sample-human" });
  assert.ok(first.ok && first.text.startsWith("DM peer @sample-human (human, Asia/Shanghai): Founder. Prefers short updates.\n"), first.ok ? first.text : "");
  // The card booked the peer: the message's description is not repeated either.
  const second = await raft.messages.read({ target: "dm:@sample-human" });
  assert.ok(second.ok && !second.text.includes("DM peer") && !second.text.includes("Founder."), second.ok ? second.text : "");
  await raft.messages.send({ target: "dm:@sample-human", content: "thanks" });
  assert.ok(typeof (calls[2]!.body!.seenCards as { peer?: unknown }).peer === "string");
});

test("no context: cards on every read, no card versions sent, the conversation after every send", async () => {
  const { calls, fetch } = server({
    history: [
      page([msg(1, "sample-human", "human", "hi")], { channel_card: card }),
      page([msg(1, "sample-human", "human", "hi")], { channel_card: card }),
      page([msg(98, "sample-human", "human", "deploy at 5?")], { channel_card: card }),
    ],
    send: [sent()],
  });
  const raft = createRaft({ serverUrl: "https://raft.example", credential, fetch, conversationCards: true });
  for (let i = 0; i < 2; i += 1) {
    const read = await raft.messages.read({ target: "#ops" });
    assert.ok(read.ok && read.text.startsWith("Channel #ops (public)"));
  }
  const outcome = await raft.messages.send({ target: "#ops", content: "go" });
  assert.equal(Object.hasOwn(calls[2]!.body!, "seenCards"), false);
  const attachmentRead = calls[3]!;
  assert.match(attachmentRead.url, /consume=false/);
  assert.match(attachmentRead.url, /before=00000099/);
  assert.ok(outcome.ok && /Not part of your message: the latest in #ops before it/.test(outcome.text), outcome.ok ? outcome.text : "");
});

test("card observations survive a snapshot, and stay bounded with other contexts going first", () => {
  const frontier = new SeenFrontier();
  frontier.setContext("ctx-old");
  frontier.recordCard("channel", "#old", "v1:old");
  frontier.setContext("ctx-1");
  for (let i = 0; i < MAX_OBSERVATIONS; i += 1) frontier.recordCard("sender", `human:p${i}`, `v1:${i}`);
  const restored = SeenFrontier.fromSnapshot(frontier.snapshot());
  restored.setContext("ctx-1");
  assert.equal(restored.seenCard("sender", "human:p0"), "v1:0");
  assert.equal(Object.keys(frontier.snapshot().observations ?? {}).length, MAX_OBSERVATIONS);
  restored.setContext("ctx-old");
  assert.equal(restored.seenCard("channel", "#old"), undefined, "the other context's entry went first");
});

test("a full observation list stays under 100 KB serialized, for state stores that save one value", () => {
  const frontier = new SeenFrontier();
  const long = "n".repeat(64); // twice the longest name the Server accepts
  for (let i = 0; i < MAX_OBSERVATIONS + 50; i += 1) {
    frontier.setContext(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    frontier.recordCard(i % 2 ? "sender" : "channel", i % 2 ? `human:${long}${i}` : `#${long}${i}`, channelCardRev({ ...card, name: `${i}` }));
  }
  const snapshot = frontier.snapshot();
  assert.equal(snapshot.observations?.length, MAX_OBSERVATIONS);
  assert.ok(JSON.stringify(snapshot).length < 100_000, `${JSON.stringify(snapshot).length} bytes`);
});

test("the state store keeps observations; an older SDK that drops them only costs one more card", async () => {
  const { parseRaftState, RAFT_STATE_SCHEMA } = await import("@botiverse/raft-shared");
  const frontier = new SeenFrontier();
  frontier.setContext("ctx-1");
  frontier.recordCard("channel", "#ops", channelCardRev(card));
  const state = parseRaftState(JSON.parse(JSON.stringify({ schema: RAFT_STATE_SCHEMA, version: 3, cursor: null, pendingCursor: null, frontier: frontier.snapshot() })));
  assert.ok(state);
  const restored = SeenFrontier.fromSnapshot(state.frontier);
  assert.equal(restored.seenCard("channel", "#ops"), channelCardRev(card));
  // Downgrade: a snapshot saved by an SDK that does not know `observations`.
  const { observations: _dropped, ...older } = frontier.snapshot();
  const fresh = SeenFrontier.fromSnapshot(older);
  assert.equal(fresh.seenCard("channel", "#ops"), undefined, "the card is shown (and held for) once more, nothing worse");
});

test("a per-call context: recordHeld on the root frontier books under the interrupt's context, so the resend passes", async () => {
  const { calls, fetch } = server({
    send: [{ ok: true, state: "held", holdReasons: ["channel_card"], newMessageCount: 0, heldMessages: [], channelCard: card }, sent()],
  });
  const raft = createRaft({ serverUrl: "https://raft.example", credential, fetch, conversationCards: true });
  const held = await raft.invoke("messages.send", { target: "#ops", content: "go", idempotencyKey: "k-ctx" }, { contextId: "ctx-9" });
  if (!held.ok || held.state !== "interrupted") return assert.fail("expected an interrupt");
  assert.equal(held.interrupt.contextId, "ctx-9");
  raft.frontier.recordHeld(held.interrupt);
  await raft.invoke("messages.send", { target: "#ops", content: "go", idempotencyKey: "k-ctx" }, { contextId: "ctx-9" });
  assert.deepEqual(calls[1]!.body!.seenCards, { channel: channelCardRev(card) });
});

test("a changed card after the receipt is shown, booked and saved to the state store", async () => {
  const saved: unknown[] = [];
  const store = { load: async () => null, save: async (state: unknown) => { saved.push(JSON.parse(JSON.stringify(state))); } };
  const changedCard = { ...card, description: "Release coordination only." };
  const { fetch } = server({ send: [sent({ channelCard: changedCard, channelCardChanged: true })] });
  const raft = createRaft({ serverUrl: "https://raft.example", credential, fetch, conversationCards: true, state: store });
  raft.frontier.setContext("ctx-1");
  const outcome = await raft.messages.send({ target: "#ops", content: "go" });
  assert.ok(outcome.ok && /\n\nChannel #ops \(public\), changed since you last saw it: Release coordination only\./.test(outcome.text), outcome.ok ? outcome.text : "");
  const last = saved.at(-1) as { frontier: { observations?: Array<{ id: string; rev: string }> } } | undefined;
  assert.ok(last?.frontier.observations?.some((o) => o.id === "#ops" && o.rev === channelCardRev(changedCard)), JSON.stringify(last));
});

test("an unread read: a folded message claims no description, so the next one from that sender shows it", async () => {
  const bob = { sender_description: "Reviewer.", sender_timezone: null };
  const { fetch } = server({
    history: [page([msg(5, "bob", "agent", "old", bob), msg(6, "bob", "agent", "new", bob)], { unread_after_seq: 4, read_through_seq: 6, channel_card: card })],
  });
  const raft = createRaft({ serverUrl: "https://raft.example", credential, fetch, conversationCards: true });
  raft.frontier.setContext("ctx-1");
  raft.frontier.recordUpTo("#ops", 5);
  const read = await raft.messages.read({ target: "#ops", unread: true });
  assert.ok(read.ok && /@bob — Reviewer\.: new/.test(read.text), read.ok ? read.text : "");
});

test("interleaved contexts keep their own card records", async () => {
  const { calls, fetch } = server({
    history: [page([], { channel_card: card }), page([], { channel_card: card })],
    send: [sent()],
  });
  const raft = createRaft({ serverUrl: "https://raft.example", credential, fetch, conversationCards: true });
  await raft.invoke("messages.read", { target: "#ops" }, { contextId: "ctx-A" });
  await raft.invoke("messages.read", { target: "#ops" }, { contextId: "ctx-B" });
  await raft.invoke("messages.send", { target: "#ops", content: "go" }, { contextId: "ctx-A" });
  assert.deepEqual(calls[2]!.body!.seenCards, { channel: channelCardRev(card) }, "ctx-B's read did not overwrite ctx-A's record");
});
