// Byte pins for the freshness-hold reply. The hold text is an agent-facing
// contract (send, task claim / update / amend share it); a snapshot change
// here is an output change and needs its reason in the PR description.
import { expect, test } from "vitest";

import { formatFreshnessHoldOutput } from "./_format";

const LONG_LATIN = "The rollout is paused because the canary error rate doubled after the config push; "
  + "please hold any deploys to the API tier until we confirm the fix, then re-run the smoke suite and report back here.";
const LONG_CJK = "这次发布先暂停：配置推送之后金丝雀的错误率翻了一倍。".repeat(10);

const DRAFT = "To update the draft, send revised content normally:\n  raft message send --target \"#ops:1a2b3c4d\" <<'RAFTMSG'\n  revised message\n  RAFTMSG\n";

test("thread hold: start anchor, skipped line, truncated previews, mention note, continue-anyway", () => {
  expect(formatFreshnessHoldOutput(
    "#ops:1a2b3c4d",
    {
      decision: "local_hold",
      newMessageCount: 7,
      shownMessageCount: 3,
      omittedMessageCount: 4,
      firstShownSeq: 1205,
      mentionAnnotation: { formalMentionCount: 2 },
      continueAnywaySuggested: true,
      threadParentMessage: {
        seq: 1100,
        senderName: "richard",
        createdAt: "2026-10-15T08:00:00.000Z",
        content: "Deploy plan for\n\n  the API tier",
      },
      heldMessages: [
        { seq: 1205, sender_name: "scout", timestamp: "2026-10-15T09:01:00.000Z", content: LONG_LATIN },
        { seq: 1206, senderName: "李雷", createdAt: "2026-10-15T09:02:00.000Z", content: LONG_CJK },
        { seq: 1207, content: "no sender, no time" },
      ],
    },
    {
      heldAction: "Your message has been saved as a draft (kept for 10 minutes).",
      draftInstructions: DRAFT,
      continueAnywayInstruction: "This thread is busy: to send without reviewing again, add --anyway.\n",
    },
  )).toMatchSnapshot();
});

test("channel hold: skipped line anchors on the lowest held seq when firstShownSeq is absent", () => {
  expect(formatFreshnessHoldOutput(
    "#general",
    {
      decision: "syncing_hold",
      newMessageCount: 3,
      omittedMessageCount: 1,
      heldMessages: [
        { seq: 52, sender_name: "scout", timestamp: "2026-10-15T09:01:00.000Z", content: "second" },
        { seq: 51, sender_name: "richard", timestamp: "2026-10-15T09:00:00.000Z", content: "first" },
      ],
    },
    { heldAction: "Your task claim was not applied." },
  )).toMatchSnapshot();
});

test("server window counts and anchors are passed through: shown count, first shown seq, string seqs", () => {
  expect(formatFreshnessHoldOutput(
    "#general",
    {
      newMessageCount: 9,
      shownMessageCount: 3,
      omittedMessageCount: 6,
      firstShownSeq: 40,
      heldMessages: [
        { seq: "44", sender_name: "scout", timestamp: "2026-10-15T09:01:00.000Z", content: "string seq" },
        { sender_name: "richard", content: "no seq" },
      ],
    },
    { heldAction: "Your message has been saved as a draft." },
  )).toMatchSnapshot();
});

test("thread hold: no start anchor when the thread start is inside the shown window", () => {
  expect(formatFreshnessHoldOutput(
    "dm:@richard:1a2b3c4d",
    {
      newMessageCount: 1,
      threadParentMessage: { seq: 10, senderName: "richard", content: "root" },
      heldMessages: [{ seq: 10, sender_name: "richard", content: "root" }],
    },
    { heldAction: "Your message has been saved as a draft." },
  )).toMatchSnapshot();
});

test("hold with no previews: pointer line only, singular noun", () => {
  expect(formatFreshnessHoldOutput(
    "#general",
    { newMessageCount: 1, heldMessages: [] },
    { heldAction: "Your message has been saved as a draft.", continueAnywayInstruction: "unused without the suggestion\n" },
  )).toMatchSnapshot();
});

test("withheld context renders the count-only notice", () => {
  expect(formatFreshnessHoldOutput(
    "#general",
    { freshnessContextMode: "withheld", withheldMessageCount: 1 },
    { heldAction: "Your message has been saved as a draft." },
  )).toMatchSnapshot();
});

const opsCard = { id: "c-ops", name: "ops", type: "channel", description: "Release coordination. Post go/no-go here." };

test("held for the channel card alone: the card, then the paths", () => {
  expect(formatFreshnessHoldOutput(
    "#ops:1a2b3c4d",
    { newMessageCount: 0, heldMessages: [], holdReasons: ["channel_card"], channelCard: opsCard },
    { heldAction: "Your message has been saved as a draft (kept for 10 minutes).", draftInstructions: DRAFT },
  )).toMatchSnapshot();
});

test("unread messages and a changed channel card in one hold: the card before the window", () => {
  expect(formatFreshnessHoldOutput(
    "#ops",
    {
      newMessageCount: 1,
      shownMessageCount: 1,
      holdReasons: ["unread_messages", "channel_card"],
      channelCard: opsCard,
      channelCardChanged: true,
      heldMessages: [{ seq: 41, sender_name: "richard", timestamp: "2026-10-15T09:00:00.000Z", content: "deploy at 5?" }],
    },
    { heldAction: "Your message has been saved as a draft." },
  )).toMatchSnapshot();
});

test("held for the DM peer's card alone", () => {
  expect(formatFreshnessHoldOutput(
    "dm:@richard",
    {
      newMessageCount: 0,
      heldMessages: [],
      holdReasons: ["peer_card"],
      peerCard: { kind: "human", name: "richard", description: "Founder. Prefers short updates.", timezone: "Asia/Shanghai" },
    },
    {
      heldAction: "Your message has been saved as a draft (kept for 10 minutes).",
      draftInstructions: "To send the current draft unchanged:\n  raft message send --send-draft --target \"dm:@richard\"\nIf what you just read already says what you meant to say, or makes your message unnecessary, send nothing.\n",
    },
  )).toMatchSnapshot();
});

test("the push budget: worst-case holds stay within 2000 code points before the paths, latest messages intact", () => {
  const long = "字".repeat(5000);
  const hold = (senderLength: number) => formatFreshnessHoldOutput(
    `#${"n".repeat(80)}:1a2b3c4d`,
    {
      newMessageCount: 99, shownMessageCount: 3, omittedMessageCount: 96, firstShownSeq: 100,
      mentionAnnotation: { formalMentionCount: 99 },
      holdReasons: ["unread_messages", "channel_card"],
      channelCard: { id: "c", name: "n".repeat(80), type: "channel", description: long },
      threadParentMessage: { seq: 1, senderName: "s".repeat(senderLength), createdAt: "2026-10-15T09:00:00.000Z", content: long },
      heldMessages: [100, 101, 102].map((seq) => ({ seq, sender_name: "s".repeat(senderLength), timestamp: "2026-10-15T09:00:00.000Z", content: long })),
    },
    { heldAction: "Your message has been saved as a draft (kept for 10 minutes)." },
  );
  const pushed = (out: string) => out.slice(0, out.indexOf("\n\nAfter reviewing"));
  for (const senderLength of [40, 120]) {
    const out = hold(senderLength);
    expect(Array.from(pushed(out)).length).toBeLessThanOrEqual(2000);
    expect(out.match(/\n  │ @s+ 09:00  字/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(out).toContain(`Equivalent: raft channel info "#${"n".repeat(80)}"`);
  }
  // Shrinking the card was enough here: the thread start stays.
  expect(hold(40)).toContain("┌ Thread start");
  // With longer handles it was not: the thread start gave way, the latest three did not.
  expect(hold(120)).not.toContain("┌ Thread start");
  expect(hold(120).match(/\n  │ @s+ 09:00  字/g)?.length).toBe(3);
});

test("the push budget for a DM thread hold with a long peer card", () => {
  const long = "字".repeat(5000);
  const out = formatFreshnessHoldOutput(
    `dm:@${"p".repeat(32)}:1a2b3c4d`,
    {
      newMessageCount: 99, shownMessageCount: 3, omittedMessageCount: 96, firstShownSeq: 100,
      holdReasons: ["unread_messages", "peer_card"],
      peerCard: { kind: "human", name: "p".repeat(32), description: long, timezone: "America/Argentina/ComodRivadavia" },
      threadParentMessage: { seq: 1, senderName: "s".repeat(32), createdAt: "2026-10-15T09:00:00.000Z", content: long },
      heldMessages: [100, 101, 102].map((seq) => ({ seq, sender_name: "s".repeat(32), timestamp: "2026-10-15T09:00:00.000Z", content: long })),
    },
    { heldAction: "Your message was not delivered, and no draft was kept: this agent's local record cannot be written." },
  );
  expect(Array.from(out.slice(0, out.indexOf("\n\nAfter reviewing"))).length).toBeLessThanOrEqual(2000);
  expect(out).toContain(`Equivalent: raft user info @${"p".repeat(32)}`);
  expect(out.match(/\n  │ @s+ 09:00  字/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
});
