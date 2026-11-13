import { describe, expect, it } from "vitest";

import {
  NO_PARENT_THREAD_UNREAD,
  groupThreadUnreadByParent,
  orderParentUnreadThreadsForJump,
  summarizeParentThreadUnread,
} from "../src/utils/threadUnreadByParent";

type Row = {
  threadChannelId: string;
  parentChannelId: string;
  unreadCount: number;
  hasMention?: boolean;
  lastReplyAt: string | null;
  parentMessageCreatedAt?: string;
  conversationKind?: "thread" | "task";
};

function thread(id: string, parentChannelId: string, unreadCount: number, extra: Partial<Row> = {}): Row {
  return { threadChannelId: id, parentChannelId, unreadCount, lastReplyAt: null, ...extra };
}

describe("summarizeParentThreadUnread", () => {
  it("counts unread threads (not replies) under one parent", () => {
    const threads = [
      thread("t1", "general", 4),
      thread("t2", "general", 1),
      thread("t3", "general", 0),
      thread("t4", "random", 7),
    ];
    expect(summarizeParentThreadUnread(threads, "general")).toEqual({ count: 2, hasMention: false });
    expect(summarizeParentThreadUnread(threads, "random")).toEqual({ count: 1, hasMention: false });
  });

  it("leaves out task conversations, whose unread shows in Activity only", () => {
    // The channel cannot lead to a task conversation or mark it read, so an
    // unread one (even with a mention) never lights the channel's mark.
    const threads = [
      thread("t1", "general", 2),
      thread("c1", "general", 3, { conversationKind: "task", hasMention: true }),
    ];
    expect(summarizeParentThreadUnread(threads, "general")).toEqual({ count: 1, hasMention: false });
    expect(summarizeParentThreadUnread([threads[1]!], "general")).toBe(NO_PARENT_THREAD_UNREAD);
  });

  it("lights the mention only from a thread that still has unread replies", () => {
    expect(summarizeParentThreadUnread([thread("t1", "general", 2, { hasMention: true })], "general"))
      .toEqual({ count: 1, hasMention: true });
    // A stale flag on a fully read thread neither counts nor mentions.
    expect(summarizeParentThreadUnread([thread("t1", "general", 0, { hasMention: true })], "general"))
      .toBe(NO_PARENT_THREAD_UNREAD);
  });

  it("matches a joint thread by the local parent id the server already resolved", () => {
    // /channels/threads/followed serves a joint thread with this server's joint
    // channel as parentChannelId, so the sidebar row id matches directly.
    const threads = [thread("joint-thread", "local-joint-channel", 3)];
    expect(summarizeParentThreadUnread(threads, "local-joint-channel")).toEqual({ count: 1, hasMention: false });
    expect(summarizeParentThreadUnread(threads, "canonical-joint-channel")).toBe(NO_PARENT_THREAD_UNREAD);
  });

  it("returns the shared empty value when nothing is unread", () => {
    expect(summarizeParentThreadUnread([], "general")).toBe(NO_PARENT_THREAD_UNREAD);
  });
});

describe("groupThreadUnreadByParent", () => {
  it("folds every parent in one pass and reuses the index for the same list", () => {
    const threads = [
      thread("t1", "general", 4),
      thread("t2", "general", 1, { hasMention: true }),
      thread("t3", "random", 0),
      thread("t4", "random", 7),
    ];
    const byParent = groupThreadUnreadByParent(threads);
    expect([...byParent.entries()]).toEqual([
      ["general", { count: 2, hasMention: true }],
      ["random", { count: 1, hasMention: false }],
    ]);
    // Every sidebar row reads the same index: no rescan per row.
    expect(groupThreadUnreadByParent(threads)).toBe(byParent);
    expect(summarizeParentThreadUnread(threads, "general")).toBe(byParent.get("general"));
  });

  it("recomputes for a replaced list (the store never mutates it in place)", () => {
    const before = [thread("t1", "general", 1)];
    const after = [...before, thread("t2", "general", 2)];
    expect(groupThreadUnreadByParent(before).get("general")).toEqual({ count: 1, hasMention: false });
    expect(groupThreadUnreadByParent(after).get("general")).toEqual({ count: 2, hasMention: false });
  });
});

describe("orderParentUnreadThreadsForJump", () => {
  it("jumps top to bottom by parent message time, not by the latest reply", () => {
    const threads = [
      // Earliest parent, but the most recent reply: still first.
      thread("top", "general", 1, { parentMessageCreatedAt: "2026-10-14T08:00:00Z", lastReplyAt: "2026-10-14T18:00:00Z" }),
      thread("bottom", "general", 1, { parentMessageCreatedAt: "2026-10-14T12:00:00Z", lastReplyAt: "2026-10-14T13:00:00Z" }),
      thread("middle", "general", 1, { parentMessageCreatedAt: "2026-10-14T10:00:00Z", lastReplyAt: "2026-10-14T11:00:00Z", hasMention: true }),
      thread("read", "general", 0, { parentMessageCreatedAt: "2026-10-14T07:00:00Z" }),
      thread("other", "random", 1, { parentMessageCreatedAt: "2026-10-14T06:00:00Z" }),
    ];
    expect(orderParentUnreadThreadsForJump(threads, "general").map((t) => t.threadChannelId))
      .toEqual(["top", "middle", "bottom"]);
  });

  it("an older server without the parent time keeps the latest-reply order; a mention does not jump the queue", () => {
    const threads = [
      thread("newest", "general", 1, { lastReplyAt: "2026-10-14T12:00:00Z" }),
      thread("oldest", "general", 1, { lastReplyAt: "2026-10-14T08:00:00Z" }),
      thread("mention", "general", 1, { lastReplyAt: "2026-10-14T13:00:00Z", hasMention: true }),
      thread("read", "general", 0, { lastReplyAt: "2026-10-14T07:00:00Z" }),
      thread("other", "random", 1, { lastReplyAt: "2026-10-14T06:00:00Z" }),
    ];
    expect(orderParentUnreadThreadsForJump(threads, "general").map((t) => t.threadChannelId))
      .toEqual(["oldest", "newest", "mention"]);
  });

  it("sorts threads without a reply time last", () => {
    const threads = [
      thread("unknown", "general", 1),
      thread("known", "general", 1, { lastReplyAt: "2026-10-14T08:00:00Z" }),
    ];
    expect(orderParentUnreadThreadsForJump(threads, "general").map((t) => t.threadChannelId))
      .toEqual(["known", "unknown"]);
  });
});
