/**
 * Task #47 — RENDER ISOLATION GATE (mine to own; #4434 class).
 *
 * Requirement (5): a reply arriving in ONE thread must update ONLY that message.
 * It must not re-render the timeline.
 *
 * The risk is concrete, not theoretical: `ChatPanel` subscribes to the thread
 * store wholesale, so if a live reply replaced the scopes map with a fresh object
 * whose entries were all rebuilt, EVERY message's props would change identity and
 * every memoized MessageItem would re-render — on every reply, in every thread.
 * That is the exact regression class I gate for on the grid work.
 *
 * This test asserts the property the isolation actually rests on, at the store
 * level: after a reply lands in thread A, the scope object for thread A is NEW and
 * the scope object for every other thread is REFERENCE-IDENTICAL. That is what
 * lets `memo(MessageItem)` skip. Asserting it here (rather than only through a
 * rendered tree) makes it a cheap, unavoidable regression guard.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { useThreadStore } from "../src/store/threadStore";
import type { ThreadReplyPreview } from "../src/store/threadRepliesReadModel";

function reply(seq: number, messageId = `m-${seq}`): ThreadReplyPreview {
  return {
    messageId,
    seq,
    preview: `reply ${seq}`,
    senderId: "u-1",
    senderType: "user",
    senderName: "alice",
    senderAvatarUrl: null,
    createdAt: "2026-07-12T00:00:00Z",
  };
}

function resetStore() {
  useThreadStore.setState({ replyScopes: {} });
}

test("a reply in thread A leaves every OTHER thread's scope reference-identical", () => {
  resetStore();
  const store = useThreadStore.getState();

  store.hydrateReplyScope("parent-A", [reply(1)], 1);
  store.hydrateReplyScope("parent-B", [reply(1, "b-1")], 1);
  store.hydrateReplyScope("parent-C", [reply(1, "c-1")], 1);

  const before = useThreadStore.getState().replyScopes;
  const beforeB = before["parent-B"];
  const beforeC = before["parent-C"];

  // A reply lands in thread A only.
  useThreadStore.getState().applyReplyFrame("parent-A", reply(2, "a-2"), 2);

  const after = useThreadStore.getState().replyScopes;

  assert.notEqual(after["parent-A"], before["parent-A"], "the touched scope must be a new object");
  assert.equal(
    after["parent-B"], beforeB,
    "an untouched thread's scope MUST keep its exact reference — otherwise memo(MessageItem) "
    + "re-renders message B for a reply that belongs to thread A (the #4434 regression)",
  );
  assert.equal(after["parent-C"], beforeC, "and so must every other untouched thread");
});

test("a stale / duplicate frame does not churn the map at all", () => {
  resetStore();
  const store = useThreadStore.getState();
  store.hydrateReplyScope("parent-A", [reply(5), reply(6), reply(7)], 7);
  store.hydrateReplyScope("parent-B", [reply(1, "b-1")], 1);

  const before = useThreadStore.getState().replyScopes;

  // Below the snapshot seam (a reconnect replay) — nothing changed.
  useThreadStore.getState().applyReplyFrame("parent-A", reply(6), 7);

  const after = useThreadStore.getState().replyScopes;

  assert.equal(
    after, before,
    "a no-op frame must not even replace the map — a fresh map object would re-run "
    + "ChatPanel's message-list memo for a reply that changed nothing on screen",
  );
  assert.equal(after["parent-A"], before["parent-A"], "and the scope itself must not churn");
});

test("only the touched scope's contents advance", () => {
  resetStore();
  const store = useThreadStore.getState();
  store.hydrateReplyScope("parent-A", [reply(1)], 1);
  store.hydrateReplyScope("parent-B", [reply(1, "b-1")], 9);

  useThreadStore.getState().applyReplyFrame("parent-A", reply(2, "a-2"), 2);

  const scopes = useThreadStore.getState().replyScopes;
  assert.equal(scopes["parent-A"].replyCount, 2, "thread A advanced");
  assert.equal(scopes["parent-B"].replyCount, 9, "thread B untouched");
  assert.deepEqual(scopes["parent-B"].replies.map((r) => r.seq), [1]);
});
