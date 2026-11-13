// Canonical freshness-hold reply formatting for agent-facing output. The
// text lives in shared (`formatAgentHold`, agentText/hold.ts) so the SDK
// prints the same bytes; this file keeps the axSurface registrations. This is
// an AX contract, not an implementation detail.
import type {
  AgentHoldData,
  AgentHoldOptions,
} from "@botiverse/raft-shared";
import {
  formatAgentHold,
  formatAgentReviewerIsolationHold,
  redactAgentHoldForReviewerIsolation,
} from "@botiverse/raft-shared/src/agentCliSurface";
import { axSurface } from "../../core/renderer";

export type FreshnessHoldOutputData = AgentHoldData;

export function isFreshnessHeldResponse(data: unknown): data is FreshnessHoldOutputData & { state: "held" } {
  return Boolean(data && typeof data === "object" && (data as { state?: unknown }).state === "held");
}

export function redactFreshnessHoldForReviewerIsolation<T extends FreshnessHoldOutputData>(data: T): {
  state: "held";
  freshnessContextMode: "withheld";
  withheldMessageCount: number;
} {
  return redactAgentHoldForReviewerIsolation(data);
}

export const formatReviewerIsolationFreshnessHold = axSurface(
  "Reviewer-isolation freshness hold: withheld-count-only notice, no context bytes.",
  (data: FreshnessHoldOutputData): string => formatAgentReviewerIsolationHold(data),
  {
    examples: [{ args: [{ withheldMessageCount: 3 }] }],
  },
);

export const formatFreshnessHoldOutput = axSurface(
  "Freshness/syncing hold body: opening count line, omitted note, guidance, mention note, bounded held-message window, and the recovery-path instructions.",
  (target: string, data: FreshnessHoldOutputData, opts: AgentHoldOptions): string => formatAgentHold(target, data, opts, "cli"),
  {
    examples: [
      {
        title: "syncing hold with mention note and draft paths",
        args: [
          "#general",
          {
            decision: "syncing_hold",
            newMessageCount: 2,
            shownMessageCount: 2,
            heldMessages: [
              { channel_type: "channel", channel_name: "general", message_id: "00000000-1111-2222-3333-444444444444", timestamp: "2026-08-31T08:00:00.000Z", sender_type: "human", sender_name: "richard", content: "new context you have not seen", seq: 1200 },
            ],
            mentionAnnotation: { formalMentionCount: 1 },
          },
          {
            heldAction: "Your message has been saved as a draft.",
            draftInstructions: "If what you just read already says what you meant to say (for example, someone already answered), or makes your message unnecessary, send nothing. Delete the draft:\n  raft message send --discard-draft --target \"#general\"\nOtherwise, to update the draft, send revised content normally:\n  raft message send --target \"#general\" <<'RAFTMSG'\n  revised message\n  RAFTMSG\nTo send the current draft unchanged:\n  raft message send --send-draft --target \"#general\"\n",
          },
        ],
      },
      {
        title: "freshness hold with omitted earlier messages",
        args: [
          "#general",
          { decision: "local_hold", newMessageCount: 5, shownMessageCount: 2, omittedMessageCount: 3, heldMessages: [] },
          { heldAction: "Your message has been saved as a draft." },
        ],
      },
      {
        title: "held for the channel card alone (first message to the channel in this context)",
        args: [
          "#ops",
          { newMessageCount: 0, heldMessages: [], holdReasons: ["channel_card"], channelCard: { id: "c-ops", name: "ops", type: "channel", description: "Release coordination. Post go/no-go here." } },
          { heldAction: "Your message has been saved as a draft (kept for 10 minutes).", draftInstructions: "If what you just read already says what you meant to say, or makes your message unnecessary, send nothing. Delete the draft:\n  raft message send --discard-draft --target \"#ops\"\nOtherwise, to send the current draft unchanged:\n  raft message send --send-draft --target \"#ops\"\n" },
        ],
      },
      {
        title: "held for the DM peer's card alone (first message to them in this context)",
        args: [
          "dm:@richard",
          { newMessageCount: 0, heldMessages: [], holdReasons: ["peer_card"], peerCard: { kind: "human", name: "richard", description: "Founder. Prefers short updates.", timezone: "Asia/Shanghai" } },
          { heldAction: "Your message has been saved as a draft (kept for 10 minutes).", draftInstructions: "If what you just read already says what you meant to say, or makes your message unnecessary, send nothing. Delete the draft:\n  raft message send --discard-draft --target \"dm:@richard\"\nOtherwise, to send the current draft unchanged:\n  raft message send --send-draft --target \"dm:@richard\"\n" },
        ],
      },
      {
        title: "unread messages and an unseen channel card, in one hold",
        args: [
          "#ops",
          {
            newMessageCount: 1,
            shownMessageCount: 1,
            holdReasons: ["unread_messages", "channel_card"],
            channelCard: { id: "c-ops", name: "ops", type: "channel", description: "Release coordination. Post go/no-go here." },
            heldMessages: [{ seq: 41, sender_name: "richard", timestamp: "2026-10-15T09:00:00.000Z", content: "deploy at 5?" }],
          },
          { heldAction: "Your message has been saved as a draft." },
        ],
      },
      {
        title: "withheld context (reviewer isolation路径)",
        args: [
          "#general",
          { freshnessContextMode: "withheld", withheldMessageCount: 2 },
          { heldAction: "Your message has been saved as a draft.", withholdContext: true },
        ],
      },
    ],
  },
);
