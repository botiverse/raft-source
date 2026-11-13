import { afterEach, describe, expect, it, vi } from "vitest";
import type * as channelService from "./channelService";
import { conversationActivityKey, EARLIEST_ACTIVITY_KEY } from "./objectActivityInbox";

const channelRow = (lastMessageAt: string) => ({ kind: "channel", channelId: "c-1", lastMessageAt }) as unknown as channelService.InboxItem;
const threadRow = (lastActivityAt: string) => ({ kind: "thread", threadChannelId: "t-1", lastActivityAt }) as unknown as channelService.InboxItem;

describe("conversationActivityKey", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is the row's time to the microsecond", () => {
    expect(conversationActivityKey(channelRow("2026-11-02 08:10:00.123+00"))).toBe("2026-11-02T08:10:00.123000Z");
  });

  it("sorts a row with a missing or unparseable time as the oldest, and names it once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const empty = threadRow("");
    expect(conversationActivityKey(empty)).toBe(EARLIEST_ACTIVITY_KEY);
    expect(conversationActivityKey(empty)).toBe(EARLIEST_ACTIVITY_KEY);
    expect(conversationActivityKey(channelRow("not a time"))).toBe(EARLIEST_ACTIVITY_KEY);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]?.[1]).toEqual({ row: "thread:t-1", value: "(empty)" });
    expect(EARLIEST_ACTIVITY_KEY < conversationActivityKey(channelRow("2000-01-01T00:00:00.000Z"))).toBe(true);
  });
});
