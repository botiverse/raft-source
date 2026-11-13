import { describe, expect, test } from "vitest";

import {
  AGENT_INBOX_OBJECT_REF_MAX_CHARS,
  AGENT_INBOX_OBJECT_REF_PATTERN,
  REACTION_NOTICE_EXCERPT_MAX_CHARS,
  agentApiMessageEnvelopeSchema,
  formatReactionNoticeSummary,
  messageIdOfReactionNoticeObjectRef,
  reactionAgentNoticeSchema,
  reactionNoticeExcerpt,
  reactionNoticeInboxTarget,
  reactionNoticeObjectRef,
  type ReactionAgentNotice,
} from "./index";

const MESSAGE_ID = "3f2a1c9e-1111-4222-8333-444444444444";

const notice = (over: Partial<ReactionAgentNotice> = {}, message: Partial<ReactionAgentNotice["message"]> = {}): ReactionAgentNotice => ({
  message: {
    id: MESSAGE_ID,
    channelId: "0d0d0d0d-1111-4222-8333-444444444444",
    conversation: "#proj-x",
    replyTarget: "#proj-x:3f2a1c9e",
    excerpt: "Deploy plan for v1.21.63 is ready for review: the migration runs first.",
    excerptTruncated: false,
    ...message,
  },
  reactor: { id: "9a9a9a9a-1111-4222-8333-444444444444", kind: "human", name: "tygg" },
  emoji: "✅",
  reactedAt: "2026-11-11T10:02:00.000Z",
  ...over,
});

describe("reaction notices", () => {
  test("the item of a message: app:system.reaction-notices/msg/<id>, an inbox object ref", () => {
    const ref = reactionNoticeObjectRef(MESSAGE_ID);
    expect(ref).toBe(`msg/${MESSAGE_ID}`);
    expect(AGENT_INBOX_OBJECT_REF_PATTERN.test(ref)).toBe(true);
    expect(ref.length).toBeLessThanOrEqual(AGENT_INBOX_OBJECT_REF_MAX_CHARS);
    expect(reactionNoticeInboxTarget(MESSAGE_ID)).toBe(`app:system.reaction-notices/msg/${MESSAGE_ID}`);
    expect(messageIdOfReactionNoticeObjectRef(ref)).toBe(MESSAGE_ID);
    for (const other of ["pt_abc", "msg/", "msg/3f2a1c9e", `message/${MESSAGE_ID}`]) expect(messageIdOfReactionNoticeObjectRef(other)).toBeNull();
  });

  test("the summary: one line, the reactor without @, the conversation, the message's start", () => {
    expect(formatReactionNoticeSummary(notice())).toBe('tygg reacted ✅ to your message in #proj-x: "Deploy plan for v1.21.63 is ready for…"');
    // A short message is quoted whole; one cut for the payload already still ends with the ellipsis.
    expect(formatReactionNoticeSummary(notice({}, { excerpt: "On it" }))).toBe('tygg reacted ✅ to your message in #proj-x: "On it"');
    expect(formatReactionNoticeSummary(notice({}, { excerpt: "On it", excerptTruncated: true }))).toBe('tygg reacted ✅ to your message in #proj-x: "On it…"');
    // A message without text (an attachment only), and a conversation that could not be named.
    expect(formatReactionNoticeSummary(notice({}, { excerpt: "" }))).toBe("tygg reacted ✅ to your message in #proj-x");
    expect(formatReactionNoticeSummary(notice({ reactor: { id: "x", kind: "agent", name: "Remy" }, emoji: "👍" }, { conversation: null, replyTarget: null, excerpt: "ok" })))
      .toBe('Remy reacted 👍 to your message: "ok"');
    expect(formatReactionNoticeSummary(notice())).not.toMatch(/[\r\n@]/);
  });

  test("the excerpt: one line, cut at a word near the limit, never inside a character", () => {
    expect(reactionNoticeExcerpt("line one\nline two\r\n  three", 100)).toEqual({ excerpt: "line one line two three", truncated: false });
    expect(reactionNoticeExcerpt("Deploy plan for v1.21.63 is ready for review", 40)).toEqual({ excerpt: "Deploy plan for v1.21.63 is ready for", truncated: true });
    // No word end near the limit: cut at the limit.
    expect(reactionNoticeExcerpt("a".repeat(50), 40)).toEqual({ excerpt: "a".repeat(40), truncated: true });
    // Counted in characters, so an emoji is never split.
    const cut = reactionNoticeExcerpt("🎉".repeat(REACTION_NOTICE_EXCERPT_MAX_CHARS + 5), REACTION_NOTICE_EXCERPT_MAX_CHARS);
    expect(Array.from(cut.excerpt)).toHaveLength(REACTION_NOTICE_EXCERPT_MAX_CHARS);
    expect(cut.excerpt).toBe("🎉".repeat(REACTION_NOTICE_EXCERPT_MAX_CHARS));
  });

  test("the schema: a notice passes, keeps fields added later inside its parts, and refuses another reactor kind or a missing field", () => {
    expect(reactionAgentNoticeSchema.safeParse(notice()).success).toBe(true);
    const parsed = reactionAgentNoticeSchema.parse({ ...notice(), message: { ...notice().message, seq: 7 } });
    expect((parsed.message as { seq?: number }).seq).toBe(7);
    expect(reactionAgentNoticeSchema.safeParse(notice({ reactor: { id: "x", kind: "external" as "human", name: "y" } })).success).toBe(false);
    const { emoji: _emoji, ...withoutEmoji } = notice();
    expect(reactionAgentNoticeSchema.safeParse(withoutEmoji).success).toBe(false);
  });
});

describe("message envelope reactions", () => {
  test("typed per emoji: count and the reactors named; an older Server's entry without reactors, and none at all, still pass", () => {
    const envelope = (reactions: unknown) => agentApiMessageEnvelopeSchema.safeParse({ id: MESSAGE_ID, content: "x", ...(reactions === undefined ? {} : { reactions }) });
    expect(envelope([{ emoji: "✅", count: 2, reactors: [{ name: "tygg", kind: "human" }, { name: "Remy", kind: "agent" }] }]).success).toBe(true);
    expect(envelope([{ emoji: "👍", count: 3, reactorIds: ["a"], reactorNames: ["Alice"] }]).success).toBe(true);
    expect(envelope([]).success).toBe(true);
    expect(envelope(undefined).success).toBe(true);
    // A kind added later is read, not refused.
    expect(envelope([{ emoji: "✅", count: 1, reactors: [{ name: "x", kind: "something-new" }] }]).success).toBe(true);
    expect(envelope([{ emoji: "✅" }]).success).toBe(false);
    expect(envelope([{ emoji: "✅", count: 1, reactors: [{ kind: "human" }] }]).success).toBe(false);
  });
});
