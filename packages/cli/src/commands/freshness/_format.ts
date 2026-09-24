// Canonical freshness-hold reply formatting for agent-facing output (moved
// from commands/freshnessHold.ts in the error/hold-face AX coverage pass).
// This is an AX contract, not an implementation detail.
import { axSurface } from "../../core/renderer.js";
import { historyCursorText } from "../message/_format.js";

export interface FreshnessHoldOutputData {
  producerFactId?: string;
  decision?: "local_hold" | "syncing_hold";
  heldMessages?: any[];
  newMessageCount?: number;
  shownMessageCount?: number;
  omittedMessageCount?: number;
  withheldMessageCount?: number;
  freshnessContextMode?: "inline" | "withheld";
  mentionAnnotation?: { formalMentionCount: number };
  continueAnywaySuggested?: boolean;
  /** Lowest seq inside the displayed window; --before anchor for browsing older. */
  firstShownSeq?: number;
  /** Thread-start anchor for thread targets (digest topic anchor). */
  threadParentMessage?: {
    seq: number;
    messageId?: string;
    senderName?: string | null;
    createdAt?: string | null;
    content?: string;
  };
}

// Preview truncation cap for digest lines, counted in code points so CJK and
// Latin text truncate comparably. The cap is a display budget, not a secret:
// every truncated line says how much it is hiding.
const HOLD_PREVIEW_CHARS = 160;

function previewLine(sender: string | null | undefined, timestamp: string | null | undefined, content: string | undefined): string {
  const raw = (content ?? "").replace(/\s+/g, " ").trim();
  const points = Array.from(raw);
  const shown = points.slice(0, HOLD_PREVIEW_CHARS).join("");
  const hidden = points.length - Math.min(points.length, HOLD_PREVIEW_CHARS);
  const time = timestamp ? new Date(timestamp).toISOString().slice(11, 16) : "";
  const head = [sender ? `@${sender}` : "", time].filter(Boolean).join(" ");
  const marker = hidden > 0 ? `…⟨${hidden} more chars⟩` : "";
  return `  │ ${head ? `${head}  ` : ""}${shown}${marker}`;
}

function heldMessagePreview(message: Record<string, unknown>): string {
  const sender = (message.sender_name ?? message.senderName ?? null) as string | null;
  const timestamp = (message.timestamp ?? message.createdAt ?? null) as string | null;
  const content = (message.content ?? "") as string;
  return previewLine(sender, timestamp, content);
}

export function isFreshnessHeldResponse(data: unknown): data is FreshnessHoldOutputData & { state: "held" } {
  return Boolean(data && typeof data === "object" && (data as { state?: unknown }).state === "held");
}

export function redactFreshnessHoldForReviewerIsolation<T extends FreshnessHoldOutputData>(
  data: T,
): {
  state: "held";
  freshnessContextMode: "withheld";
  withheldMessageCount: number;
} {
  const newMessageCount = normalizeWithheldMessageCount(
    data.withheldMessageCount ?? data.newMessageCount,
  );
  return {
    state: "held",
    freshnessContextMode: "withheld",
    withheldMessageCount: newMessageCount,
  };
}

export const formatReviewerIsolationFreshnessHold = axSurface(
  "Reviewer-isolation freshness hold: withheld-count-only notice, no context bytes.",
  (data: FreshnessHoldOutputData): string => {
    const projected = redactFreshnessHoldForReviewerIsolation(data);
    const messageNoun = projected.withheldMessageCount === 1 ? "message" : "messages";
    return `Reviewer-isolation freshness hold: ${projected.withheldMessageCount} newer ${messageNoun} withheld.\n`;
  },
  {
    examples: [{ args: [{ withheldMessageCount: 3 }] }],
  },
);

export const formatFreshnessHoldOutput = axSurface(
  "Freshness/syncing hold body: opening count line, omitted note, guidance, mention note, bounded held-message window, and the recovery-path instructions.",
  (
  target: string,
  data: FreshnessHoldOutputData,
  opts: {
    heldAction: string;
    draftInstructions?: string;
    continueAnywayInstruction?: string;
    withholdContext?: boolean;
  },
): string => {
  const withholdContext = opts.withholdContext === true || data.freshnessContextMode === "withheld";
  if (withholdContext) {
    return formatReviewerIsolationFreshnessHold(data);
  }
  const newMessageCount = data.newMessageCount ?? 0;
  const shownMessageCount = data.shownMessageCount ?? data.heldMessages?.length ?? 0;
  const heldMessages = data.heldMessages ?? [];
  const mentionNote = (data.mentionAnnotation?.formalMentionCount ?? 0) > 0
    ? `\nNote: ${data.mentionAnnotation!.formalMentionCount} of these messages formally @mention you.`
    : "";
  const continueAnyway = data.continueAnywaySuggested && opts.continueAnywayInstruction
    ? opts.continueAnywayInstruction
    : "";
  const newMessageNoun = newMessageCount === 1 ? "message" : "messages";

  // ── Digest: the state map the agent decides from (task #41 redesign).
  // Structure: thread-start anchor (threads) → never-shown debt line →
  // latest-window truncated previews → full-text pointer. The map is shown;
  // whether and how deep to read is the agent's decision.
  const lines: string[] = [];
  const parent = data.threadParentMessage;
  const firstShownSeq = data.firstShownSeq
    ?? (heldMessages.length > 0
      ? Math.min(...heldMessages.map((m) => Number(m?.seq)).filter((s) => Number.isFinite(s) && s > 0))
      : undefined);
  if (parent && (firstShownSeq === undefined || parent.seq < firstShownSeq)) {
    lines.push(`  ┌ Thread start ${"─".repeat(28)}`);
    lines.push(previewLine(parent.senderName, parent.createdAt ?? null, parent.content));
  }
  // Chat semantics (task #41 final review): opening a conversation shows the
  // latest window and silently reads through — like a human opening a chat.
  // The honest sentence is the whole obligation: say how many were skipped
  // this time and how to browse older. No persistent read-debt bookkeeping.
  const omittedMessageCount = data.omittedMessageCount ?? 0;
  if (omittedMessageCount > 0 && firstShownSeq !== undefined) {
    lines.push(
      `  ├ ⋯ ${omittedMessageCount} earlier message${omittedMessageCount === 1 ? "" : "s"} skipped in this notice. `
      + `${historyCursorText("Older", true, "before", firstShownSeq, target)} ⋯`,
    );
  }
  if (heldMessages.length > 0) {
    lines.push(`  ├ Latest ${shownMessageCount} ${"─".repeat(28)}`);
    for (const message of heldMessages) lines.push(heldMessagePreview(message));
  }
  lines.push(`  └ Previews are truncated. Full text: raft message read --target "${target}"`);

  const openingLine = `Held — ${newMessageCount} unread ${newMessageNoun} in ${target}. ${opts.heldAction}`;

  return (
    `${openingLine}${mentionNote}\n\n` +
    lines.join("\n") +
    `\n\nAfter reviewing the current state of this conversation, choose one path.\n` +
    (opts.draftInstructions ?? "") +
    continueAnyway
  );
},
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
            draftInstructions: "To update the draft, send revised content normally:\n  raft message send --target \"#general\" <<'RAFTMSG'\n  revised message\n  RAFTMSG\nTo send the current draft unchanged:\n  raft message send --send-draft --target \"#general\"\nYou can also choose not to send anything.\n",
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

function normalizeWithheldMessageCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}
