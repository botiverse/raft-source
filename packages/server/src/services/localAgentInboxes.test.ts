import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { afterEach, beforeEach, vi } from "vitest";
import type { AgentMessage } from "@botiverse/raft-shared";
import { LocalAgentInboxes } from "./localAgentInboxes";

function message(seq?: number, extra: Partial<AgentMessage> = {}): AgentMessage {
  return {
    channel_id: "channel-1", channel_name: "general", channel_type: "channel",
    sender_id: "user-1", sender_name: "sender", sender_type: "human",
    content: "hello", timestamp: new Date(0).toISOString(),
    ...(seq === undefined ? {} : { seq }),
    ...extra,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

test("receive and peek retain replayable messages until an explicit acknowledgement", async () => {
  const inboxes = new LocalAgentInboxes();
  const first = message(1, { message_id: "m1" });
  const seqless = message(undefined, { message_id: "notice" });
  inboxes.enqueue("agent", first);
  inboxes.enqueue("agent", message(1, { content: "duplicate seq" }));
  inboxes.enqueue("agent", seqless);
  inboxes.enqueue("agent", message(undefined, { message_id: "notice", content: "duplicate id" }));

  assert.deepEqual(await inboxes.receive("agent", false, 0), [first, seqless]);
  const snapshot = inboxes.peek("agent");
  snapshot.splice(0);
  assert.deepEqual(await inboxes.receive("agent", false, 0), [first, seqless]);
  assert.deepEqual(inboxes.acknowledge("agent", [1]), { removedCount: 1 });
  assert.deepEqual(inboxes.peek("agent"), [seqless]);
  assert.deepEqual(inboxes.acknowledge("agent", [], ["notice"]), { removedCount: 1 });
  assert.deepEqual(inboxes.peek("agent"), []);
});

test("capacity keeps the newest 1000 entries in order", () => {
  const inboxes = new LocalAgentInboxes();
  for (let seq = 1; seq <= 1001; seq++) inboxes.enqueue("agent", message(seq));
  assert.deepEqual(inboxes.peek("agent").map(item => item.seq), Array.from({ length: 1000 }, (_, i) => i + 2));
});

test("a superseded receive releases its timer and abort listener without cancelling its replacement", async () => {
  const inboxes = new LocalAgentInboxes();
  const old = new AbortController();
  const current = new AbortController();
  const first = inboxes.receive("agent", true, 10, old.signal);
  vi.advanceTimersByTime(5);
  const second = inboxes.receive("agent", true, 100, current.signal);
  assert.deepEqual(await first, []);
  assert.equal(getEventListeners(old.signal, "abort").length, 0);

  old.abort();
  vi.advanceTimersByTime(10);
  assert.equal(inboxes.snapshot("agent")?.receiving, true);
  const next = message(1);
  inboxes.enqueue("agent", next);
  assert.deepEqual(await second, [next]);
  assert.equal(inboxes.snapshot("agent")?.receiving, false);
  assert.equal(getEventListeners(current.signal, "abort").length, 0);
  assert.equal(vi.getTimerCount(), 0);
  assert.deepEqual(inboxes.peek("agent"), [next], "delivery did not acknowledge the message");
});

test("delivery finishes the listener as well as the receive; a later abort cannot clear a new waiter", async () => {
  const inboxes = new LocalAgentInboxes();
  const old = new AbortController();
  const first = inboxes.receive("agent", true, 10, old.signal);
  const delivered = message(1);
  inboxes.enqueue("agent", delivered);
  assert.deepEqual(await first, [delivered]);
  assert.equal(getEventListeners(old.signal, "abort").length, 0);
  inboxes.acknowledge("agent", [1]);
  const second = inboxes.receive("agent", true, 100);
  old.abort();
  vi.advanceTimersByTime(10);
  assert.equal(inboxes.snapshot("agent")?.receiving, true);
  inboxes.enqueue("agent", message(2));
  assert.deepEqual(await second, [message(2)]);
  assert.equal(vi.getTimerCount(), 0);
});

test("clear finishes an old receive and its resources before the same agent is recreated", async () => {
  const inboxes = new LocalAgentInboxes();
  const old = new AbortController();
  const first = inboxes.receive("agent", true, 10, old.signal);
  assert.equal(inboxes.clear("agent"), true);
  assert.deepEqual(await first, []);
  assert.equal(getEventListeners(old.signal, "abort").length, 0);
  assert.equal(inboxes.has("agent"), false);
  const second = inboxes.receive("agent", true, 100);
  old.abort();
  vi.advanceTimersByTime(10);
  assert.equal(inboxes.snapshot("agent")?.receiving, true);
  inboxes.enqueue("agent", message(2));
  assert.deepEqual(await second, [message(2)]);
  assert.equal(vi.getTimerCount(), 0);
});

test("timeout and abort finish empty without acknowledging silently buffered messages", async () => {
  const inboxes = new LocalAgentInboxes();
  for (const completion of ["timeout", "abort"] as const) {
    const controller = new AbortController();
    const pending = inboxes.receive(completion, true, 10, controller.signal);
    inboxes.enqueue(completion, message(1), { notifyPendingReceive: false });
    assert.equal(inboxes.snapshot(completion)?.receiving, true);
    if (completion === "timeout") vi.advanceTimersByTime(10);
    else controller.abort();
    assert.deepEqual(await pending, []);
    assert.deepEqual(inboxes.peek(completion), [message(1)]);
    assert.equal(inboxes.snapshot(completion)?.receiving, false);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  }
  assert.equal(vi.getTimerCount(), 0);
});

test("a pre-aborted empty receive supersedes the old waiter without installing another", async () => {
  const inboxes = new LocalAgentInboxes();
  const first = inboxes.receive("agent", true, 100);
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await inboxes.receive("agent", true, 100, controller.signal), []);
  assert.deepEqual(await first, []);
  assert.equal(inboxes.snapshot("agent")?.receiving, false);
  assert.equal(vi.getTimerCount(), 0);
});

test("clearing one agent leaves another receive active; clearing all releases every remaining entry", async () => {
  const inboxes = new LocalAgentInboxes();
  const a = new AbortController();
  const b = new AbortController();
  const first = inboxes.receive("a", true, 100, a.signal);
  const second = inboxes.receive("b", true, 100, b.signal);
  inboxes.enqueue("c", message(1));
  assert.equal(inboxes.clear("a"), true);
  assert.deepEqual(await first, []);
  assert.equal(inboxes.snapshot("b")?.receiving, true);
  assert.deepEqual(inboxes.peek("c"), [message(1)]);
  inboxes.clearAll();
  assert.deepEqual(await second, []);
  assert.equal(inboxes.has("b"), false);
  assert.equal(inboxes.has("c"), false);
  assert.equal(getEventListeners(a.signal, "abort").length + getEventListeners(b.signal, "abort").length, 0);
  assert.equal(vi.getTimerCount(), 0);
});

test("only explicit membership reconciliation replaces a queued non-member projection, without waking a receiver", async () => {
  const inboxes = new LocalAgentInboxes();
  const pending = inboxes.receive("agent", true, 100);
  const limited = message(1, { non_member_mention: true });
  const member = message(1);
  inboxes.enqueue("agent", limited, { notifyPendingReceive: false });
  inboxes.enqueue("agent", member);
  assert.deepEqual(inboxes.peek("agent"), [limited]);
  inboxes.enqueue("agent", member, { reconcileNonMemberMention: true });
  assert.deepEqual(inboxes.peek("agent"), [member]);
  assert.equal(inboxes.snapshot("agent")?.receiving, true);
  inboxes.enqueue("agent", message(2));
  assert.deepEqual(await pending, [member, message(2)]);
});

test("channel acknowledgements cannot remove another channel or seq-less notifications", () => {
  const inboxes = new LocalAgentInboxes();
  const other = message(2, { channel_id: "other" });
  const notice = message(undefined, { message_id: "notice" });
  for (const item of [message(1), other, notice, message(3)]) inboxes.enqueue("agent", item);
  assert.deepEqual(inboxes.acknowledgeForChannel("agent", "channel-1", [1, 2]), { removedCount: 1 });
  assert.deepEqual(inboxes.acknowledgeForChannelUpToSeq("agent", "channel-1", 3), { removedCount: 1 });
  assert.deepEqual(inboxes.peek("agent"), [other, notice]);
});

test("wake removal, guarded discards and channel purges keep unrelated entries", () => {
  const inboxes = new LocalAgentInboxes();
  const wake = message(1, { message_id: "shared-id" });
  const guarded = message(2, { channel_id: "other" });
  const notice = message(undefined, { message_id: "notice" });
  for (const item of [wake, guarded, notice, message(3)]) inboxes.enqueue("agent", item);
  assert.deepEqual(inboxes.discard("agent", [message(undefined, { message_id: "shared-id" })]), { removedCount: 0 });
  assert.equal(inboxes.removeWakeMessage("agent", wake), true);
  assert.deepEqual(inboxes.discard("agent", [notice]), { removedCount: 1 });
  assert.deepEqual(inboxes.discardForChannels("agent", ["channel-1"]), { removedCount: 1 });
  assert.deepEqual(inboxes.peek("agent"), [guarded]);
  assert.deepEqual(inboxes.retain("agent", item => item.channel_id !== "other"), { removedCount: 1 });
  assert.deepEqual(inboxes.peek("agent"), []);
});
