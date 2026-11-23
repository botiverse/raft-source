import assert from "node:assert/strict";
import type { InboxItem } from "../src/store/inboxStore";
import { projectInboxItem } from "../src/store/inboxReadProjection";
import { projectReadStateFromMessages } from "../src/store/loadedReadStateProjection";
import type { Message } from "../src/store/messageStore";

// #triage:#244 (AndyLok, 2026-11-19): 1,215 `projection` lowerings from one tab
// kept rows far below the server's count (served 53, shown 1) on every re-read.
// A loaded-messages projection may only LOWER a row when the read covers the
// row's activity, or the loaded window is complete (no gap, reaches the latest
// and back to the read) and holds the row's activity message. Message seqs are
// server-wide, so a conversation's are interleaved (10, 37, 52, 90), never
// contiguous: the proof must not rely on integer adjacency.

const row = (unreadCount: number, seqs: { latest?: string | null; readState?: string | null } = {}) => ({
  kind: "thread", threadChannelId: "t", channelId: "c", unreadCount, hasMention: false,
  firstUnreadMessageId: "r1", firstMentionMessageId: null,
  latestActivitySeq: seqs.latest ?? null, readStateLatestActivitySeq: seqs.readState ?? null,
} as unknown as InboxItem);

type WindowMeta = { hasNewer?: boolean; hasGap?: boolean; loadingGap?: boolean };

/** The projection messageStore makes from loaded messages with these seqs and this window meta, read through `readSeq`. */
function projectionOf(seqs: number[], readSeq: number, meta: WindowMeta = { hasNewer: false, hasGap: false, loadingGap: false }) {
  const messages = seqs.map((seq) => ({ id: `m${seq}`, channelId: "t", seq, senderType: "user", senderId: "other" }) as unknown as Message);
  return projectReadStateFromMessages(messages, meta, "me", readSeq);
}

test("a complete window with interleaved seqs that holds the row's activity message lowers it", () => {
  const served = row(5, { latest: "90", readState: "90" });
  assert.equal(projectInboxItem(served, projectionOf([10, 37, 52, 90], 37)).unreadCount, 2);
});

test("a window with a gap does not lower the served count", () => {
  const served = row(5, { latest: "90", readState: "90" });
  for (const meta of [{ hasGap: true }, { loadingGap: true }]) {
    assert.equal(projectInboxItem(served, projectionOf([10, 37, 52, 90], 37, meta)).unreadCount, 5, JSON.stringify(meta));
  }
});

test("a window with a newer page, or that does not reach back to the read, does not lower the served count", () => {
  const served = row(5, { latest: "90", readState: "90" });
  assert.equal(projectInboxItem(served, projectionOf([10, 37, 52, 90], 37, { hasNewer: true })).unreadCount, 5);
  assert.equal(projectInboxItem(served, projectionOf([52, 90], 37)).unreadCount, 5, "oldest loaded is after the read");
});

test("a window that does not reach the row's activity does not lower the served count", () => {
  // A frozen tab missed the newest reply (seq 120): the row's activity is past the newest loaded.
  const served = row(53, { latest: "120", readState: "120" });
  assert.equal(projectInboxItem(served, projectionOf([10, 37, 52, 90], 10)).unreadCount, 53);
});

test("a window whose newest loaded is past the row's activity but lacks that message does not lower it", () => {
  const served = row(5, { latest: "70", readState: "70" });
  assert.equal(projectInboxItem(served, projectionOf([10, 37, 52, 90], 37)).unreadCount, 5);
});

test("a row with no known activity seq is not lowered (nothing proves the loaded messages cover it)", () => {
  assert.equal(projectInboxItem(row(53), projectionOf([10, 37], 10)).unreadCount, 53);
});

test("a row with no activity seq is lowered when its last message is loaded in a complete window", () => {
  const served = { ...row(5), latestActivityMessageId: "m90" } as unknown as InboxItem;
  const seqOf = (id: string) => (id === "m90" ? 90 : null);
  assert.equal(projectInboxItem(served, projectionOf([10, 37, 52, 90], 37), seqOf).unreadCount, 2);
});

test("a read covering the row lowers it to read without needing loaded messages above it", () => {
  const served = row(3, { latest: "90", readState: "90" });
  assert.equal(projectInboxItem(served, projectionOf([52, 90], 90)).unreadCount, 0);
});

test("the display latest activity seq (a reply-less thread's parent channel seq) does not decide the proof", () => {
  // Reply-less thread: its display seq is the parent channel's (200), another seq domain.
  const served = row(5, { latest: "200", readState: "90" });
  assert.equal(projectInboxItem(served, projectionOf([10, 37, 52, 90], 37)).unreadCount, 2);
});

test("raising a row is unchanged: a covered projection above the served count still applies", () => {
  const served = row(1, { latest: "90", readState: "90" });
  assert.equal(projectInboxItem(served, projectionOf([10, 37, 52, 90], 10)).unreadCount, 3);
});
