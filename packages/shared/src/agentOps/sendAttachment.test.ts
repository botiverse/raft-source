import { describe, expect, it } from "vitest";

import { GLIMPSE_PUSH_BUDGET_CHARS, renderSendAttachment, renderThreadWindow } from "./passiveResources";

const card = { id: "c-ops", name: "ops", type: "channel", description: "Release coordination." };
const msg = (seq: number, content: string) => ({ seq, sender: "richard", timestamp: "2026-10-15T09:00:00.000Z", content });
const HEADER = "Not part of your message: the latest in #ops before it (shown after every send because this runtime does not report context compaction):";

describe("renderSendAttachment", () => {
  it("says what it is, then the cards, then the latest messages in window form", () => {
    expect(renderSendAttachment({ target: "#ops", channelCard: card, messages: [msg(1, "a"), msg(2, "b")] })).toEqual([
      HEADER,
      "Channel #ops (public): Release coordination.",
      "Equivalent: raft channel info \"#ops\"",
      `  ├ Latest 2 ${"─".repeat(28)}`,
      "  │ @richard 09:00  a",
      "  │ @richard 09:00  b",
      `  └ ${"─".repeat(40)}`,
    ]);
  });

  it("drops the oldest messages first, says so, and stays within the budget header included", () => {
    const lines = renderSendAttachment({ target: "#ops", channelCard: card, messages: [msg(1, "x".repeat(150)), msg(2, "y".repeat(150)), msg(3, "z")] }, 600);
    const text = lines.join("\n");
    expect(Array.from(text).length).toBeLessThanOrEqual(600);
    expect(text).not.toContain("xxx");
    expect(text).toContain("@richard 09:00  z");
    expect(text).toMatch(/earlier messages? skipped in this notice/);
  });

  it("keeps the cards' equivalent commands even with long descriptions, within the default budget", () => {
    const long = { ...card, description: "d".repeat(5000) };
    const peer = { kind: "human" as const, name: "richard", description: "字".repeat(3000), timezone: "UTC" };
    const lines = renderSendAttachment({ target: "dm:@richard", channelCard: long, peerCard: peer, messages: [msg(1, "hi")] });
    expect(Array.from(lines.join("\n")).length).toBeLessThanOrEqual(GLIMPSE_PUSH_BUDGET_CHARS);
    expect(lines).toContain("Equivalent: raft user info @richard");
    expect(lines.join("\n")).toContain("@richard 09:00  hi");
  });

  it("shrinks a long card description before it drops any message", () => {
    const longCard = { ...card, description: "d".repeat(300) };
    const messages = [msg(1, "a".repeat(160)), msg(2, "b".repeat(160)), msg(3, "c".repeat(160))];
    const full = renderSendAttachment({ target: "#ops", channelCard: longCard, messages });
    const budget = Array.from(full.join("\n")).length - 100;
    const lines = renderSendAttachment({ target: "#ops", channelCard: longCard, messages }, budget);
    const text = lines.join("\n");
    expect(Array.from(text).length).toBeLessThanOrEqual(budget);
    expect(text).toContain("more chars⟩");
    expect(text).toContain("Equivalent: raft channel info \"#ops\"");
    expect(text).toContain("aaaa");
    expect(text).not.toContain("skipped in this notice");
  });

  it("is empty when there is nothing to show", () => {
    expect(renderSendAttachment({ target: "dm:@x", peerCard: { kind: "agent", name: "x" }, messages: [] })).toEqual([]);
  });
});

describe("window previews", () => {
  it("leave out a time they cannot parse instead of throwing", () => {
    expect(renderThreadWindow({ target: "#ops", omittedCount: 0, messages: [{ seq: 1, sender: "x", timestamp: "not a time", content: "c" }] })[1]).toBe("  │ @x  c");
  });
});
