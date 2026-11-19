import assert from "node:assert/strict";

import { vi } from "vitest";

import api from "../src/api/client";
import { useInboxStore } from "../src/store/inboxStore";
import { useServerStore } from "../src/store/serverStore";
import { useThreadStore } from "../src/store/threadStore";

/** X-Raft-Fetch-Reason on whole-list reads (AndyLok, Activity multi-device spec §6). */

const SERIAL = {};

function captureGets() {
  const seen: Array<{ url: string; reason: unknown }> = [];
  const get = vi.spyOn(api, "get").mockImplementation(async (url: string, config?: { headers?: Record<string, string> }) => {
    seen.push({ url, reason: config?.headers?.["X-Raft-Fetch-Reason"] });
    if (url === "/channels/threads/followed") return { data: { threads: [] }, headers: {} } as never;
    return { data: { items: [], totalCount: 0, totalUnreadCount: 0, activeUnreadCount: 0, hasMore: false }, headers: {} } as never;
  });
  const savedServer = useServerStore.getState().current;
  useServerStore.setState({ current: { id: "srv-reason", slug: "s", name: "S", role: "member", plan: "free" } } as never);
  return {
    seen,
    restore() {
      get.mockRestore();
      useServerStore.setState({ current: savedServer } as never);
    },
  };
}

test("a whole Activity list read carries its reason; refreshInbox defaults to manual", SERIAL, async () => {
  const t = captureGets();
  try {
    await useInboxStore.getState().loadInbox({ reset: true, reason: "reconnect" });
    await useInboxStore.getState().refreshInbox();
    await useInboxStore.getState().loadInbox({ reset: true });
    const inbox = t.seen.filter((call) => call.url === "/channels/inbox").map((call) => call.reason);
    assert.deepEqual(inbox, ["reconnect", "manual", undefined]);
  } finally {
    t.restore();
  }
});

test("the followed-thread list read carries its reason", SERIAL, async () => {
  const t = captureGets();
  try {
    await useThreadStore.getState().loadFollowedThreads("sync_unpatchable");
    assert.deepEqual(t.seen.filter((call) => call.url === "/channels/threads/followed").map((call) => call.reason), ["sync_unpatchable"]);
  } finally {
    t.restore();
  }
});

test("a background reset folded into one already in flight keeps its reason on the trailing read", SERIAL, async () => {
  const t = captureGets();
  const get = vi.mocked(api.get);
  let release: () => void = () => undefined;
  const reasons: unknown[] = [];
  get.mockImplementation(async (url: string, config?: { headers?: Record<string, string> }) => {
    if (url !== "/channels/inbox") throw new Error(`unexpected GET ${url}`);
    reasons.push(config?.headers?.["X-Raft-Fetch-Reason"]);
    if (reasons.length === 1) await new Promise<void>((resolve) => { release = resolve; });
    return { data: { items: [], totalCount: 0, totalUnreadCount: 0, activeUnreadCount: 0, hasMore: false }, headers: {} } as never;
  });
  try {
    const first = useInboxStore.getState().loadInbox({ reset: true, background: true, reason: "reconnect" });
    await Promise.resolve();
    const trailing = useInboxStore.getState().loadInbox({ reset: true, background: true, reason: "sync_reset" });
    release();
    await first;
    await trailing;
    assert.deepEqual(reasons, ["reconnect", "sync_reset"]);
  } finally {
    t.restore();
  }
});

test("a realtime_fallback reload of the followed-thread list carries its trigger and how many asks it folded", SERIAL, async () => {
  const headers: Array<Record<string, string> | undefined> = [];
  const get = vi.spyOn(api, "get").mockImplementation(async (url: string, config?: { headers?: Record<string, string> }) => {
    if (url === "/channels/threads/followed") headers.push(config?.headers);
    return { data: { threads: [] }, headers: {} } as never;
  });
  const savedServer = useServerStore.getState().current;
  useServerStore.setState({ current: { id: "srv-reason", slug: "s", name: "S", role: "member", plan: "free" } } as never);
  try {
    await useThreadStore.getState().loadFollowedThreads("realtime_fallback", { trigger: "followed_not_listed", coalesced: 3 });
    // A reason other than realtime_fallback carries no trigger.
    await useThreadStore.getState().loadFollowedThreads("manual", { trigger: "followed_not_listed", coalesced: 1 });
    assert.deepEqual(headers, [
      { "X-Raft-Fetch-Reason": "realtime_fallback", "X-Raft-Fetch-Trigger": "followed_not_listed", "X-Raft-Fetch-Coalesced": "3" },
      { "X-Raft-Fetch-Reason": "manual" },
    ]);
  } finally {
    get.mockRestore();
    useServerStore.setState({ current: savedServer } as never);
  }
});

test("replies into a followed conversation the list does not hold reload it once, with trigger followed_not_listed", SERIAL, async () => {
  const { applyTaskConversationReply, __cancelFollowedThreadsRefreshForTests } = await import("../src/store/socketBridge");
  const headers: Array<Record<string, string> | undefined> = [];
  const get = vi.spyOn(api, "get").mockImplementation(async (url: string, config?: { headers?: Record<string, string> }) => {
    if (url === "/channels/threads/followed") headers.push(config?.headers);
    return { data: { threads: [] }, headers: {} } as never;
  });
  const savedServer = useServerStore.getState().current;
  useServerStore.setState({ current: { id: "srv-reason", slug: "s", name: "S", role: "member", plan: "free" } } as never);
  useThreadStore.setState({ followedThreads: [] });
  vi.useFakeTimers();
  try {
    for (const id of ["m1", "m2"]) {
      applyTaskConversationReply({
        id, channelId: "task-conv-1", seq: 1, content: "x", senderType: "user", senderId: "u2", senderName: "b",
        createdAt: "2026-11-15T05:00:00.000Z", conversationContext: { channelType: "task" },
      } as never);
    }
    await vi.advanceTimersByTimeAsync(1_500);
    assert.deepEqual(headers, [
      { "X-Raft-Fetch-Reason": "realtime_fallback", "X-Raft-Fetch-Trigger": "followed_not_listed", "X-Raft-Fetch-Coalesced": "2" },
    ]);
  } finally {
    __cancelFollowedThreadsRefreshForTests();
    vi.useRealTimers();
    get.mockRestore();
    useServerStore.setState({ current: savedServer } as never);
  }
});
