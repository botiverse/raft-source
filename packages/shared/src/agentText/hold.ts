// Canonical held text: what an agent sees when a send or a task call is held
// (unread messages in the conversation, a card it has not seen). Moved from
// the CLI's commands/freshness/_format.ts so the SDK prints the same text (the
// CLI wraps it in its axSurface registrations and pins the bytes with its
// snapshot tests). The text is an AX contract, not an implementation detail.

import type { RaftHintStyle } from "../agentOps/hint";
import { agentChannelRef } from "./server";
import {
  codePointLength,
  fitCards,
  GLIMPSE_PUSH_BUDGET_CHARS,
  renderChannelCard,
  renderPeerCard,
  renderThreadWindow,
  threadWindowGap,
  type ChannelCard,
  type PeerCard,
  type ThreadWindow,
  type ThreadWindowMessage,
  windowAttachmentCount,
} from "../agentOps/passiveResources";


/** The Server's held response fields the text reads. */
export interface AgentHoldData {
  producerFactId?: string;
  decision?: "local_hold" | "syncing_hold";
  heldMessages?: unknown[];
  newMessageCount?: number;
  shownMessageCount?: number;
  omittedMessageCount?: number;
  withheldMessageCount?: number;
  freshnessContextMode?: "inline" | "withheld";
  mentionAnnotation?: { formalMentionCount: number };
  continueAnywaySuggested?: boolean;
  /** Lowest seq inside the displayed window; --before anchor for browsing older. */
  firstShownSeq?: number;
  /** Why the call was held (`unread_messages`, `channel_card`, `peer_card`); absent means unread messages. */
  holdReasons?: string[];
  /** The target's channel card, when this context has not seen its current version. */
  channelCard?: ChannelCard;
  /** This context saw an older version of `channelCard`. */
  channelCardChanged?: boolean;
  /** A DM target's peer card, when this context has seen nothing of the peer. */
  peerCard?: PeerCard;
  /** Thread-start anchor for thread targets (digest topic anchor). */
  threadParentMessage?: {
    seq: number;
    messageId?: string;
    senderName?: string | null;
    createdAt?: string | null;
    content?: string;
  };
}

export interface AgentHoldOptions {
  /** What happened to the call, e.g. "Your message has been saved as a draft." */
  heldAction: string;
  /** The ways forward, printed after "choose one path." */
  draftInstructions?: string;
  /** Offered when the Server suggests it (a busy thread). */
  continueAnywayInstruction?: string;
  withholdContext?: boolean;
  /**
   * Printed after the count under reviewer isolation. The CLI keeps that
   * text count-only (no target, no action, no resend flags: its isolation
   * invariant) and gives the next step through its error; the SDK passes what
   * happened and its key-based resend, since its text is all a model sees.
   */
  isolationInstructions?: string;
}

function heldWindowMessage(message: Record<string, unknown>): ThreadWindowMessage {
  return {
    seq: Number(message.seq),
    sender: (message.sender_name ?? message.senderName ?? null) as string | null,
    timestamp: (message.timestamp ?? message.createdAt ?? null) as string | null,
    content: (message.content ?? "") as string,
    attachmentCount: windowAttachmentCount(message),
  };
}

function normalizeWithheldMessageCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

/** Reviewer isolation: the count only, no context bytes. */
export function redactAgentHoldForReviewerIsolation(data: AgentHoldData): {
  state: "held";
  freshnessContextMode: "withheld";
  withheldMessageCount: number;
} {
  return {
    state: "held",
    freshnessContextMode: "withheld",
    withheldMessageCount: normalizeWithheldMessageCount(data.withheldMessageCount ?? data.newMessageCount),
  };
}

export function formatAgentReviewerIsolationHold(data: AgentHoldData): string {
  const projected = redactAgentHoldForReviewerIsolation(data);
  const messageNoun = projected.withheldMessageCount === 1 ? "message" : "messages";
  return `Reviewer-isolation freshness hold: ${projected.withheldMessageCount} newer ${messageNoun} withheld.\n`;
}

function holdPushedText(opening: string, cardLines: string[], window: string[]): string {
  return `${opening}\n\n` + (cardLines.length > 0 ? `${cardLines.join("\n")}\n\n` : "") + window.join("\n");
}

/**
 * The window a hold with unread messages shows, and the cards that fit with
 * it. Chat semantics (task #41 final review): opening a conversation shows the
 * latest window and silently reads through, like a human opening a chat; the
 * window says how many were skipped this time and how to browse older. The
 * push budget (G1-11): the latest messages stay; card descriptions shrink
 * first, then the thread start goes. The draft and the paths after it are the
 * agent's own and do not count.
 */
function fitHoldWindow(
  target: string,
  data: AgentHoldData,
  opening: string,
  style: RaftHintStyle,
): { window: ThreadWindow; cardLines: string[] } {
  const parent = data.threadParentMessage;
  const windowForm = (withStart: boolean): ThreadWindow => ({
    target,
    ...(parent && withStart ? { start: { seq: parent.seq, sender: parent.senderName, timestamp: parent.createdAt ?? null, content: parent.content } } : {}),
    omittedCount: data.omittedMessageCount ?? 0,
    ...(data.firstShownSeq !== undefined ? { firstShownSeq: data.firstShownSeq } : {}),
    shownCount: data.shownMessageCount ?? data.heldMessages?.length ?? 0,
    messages: ((data.heldMessages ?? []) as Array<Record<string, unknown>>).map(heldWindowMessage),
  });
  const fitsBudget = (cardLines: string[], window: ThreadWindow) =>
    codePointLength(holdPushedText(opening, cardLines, renderThreadWindow(window, style))) <= GLIMPSE_PUSH_BUDGET_CHARS;
  const cards = { channelCard: data.channelCard, channelCardChanged: data.channelCardChanged, peerCard: data.peerCard };
  const fit = (window: ThreadWindow) => ({ window, cardLines: fitCards(cards, (cardLines) => fitsBudget(cardLines, window), style) });
  const withStart = fit(windowForm(true));
  return fitsBudget(withStart.cardLines, withStart.window) || !parent ? withStart : fit(windowForm(false));
}

/** The mention note under a hold's opening line, with its line break, or "". */
function holdMentionNote(data: AgentHoldData): string {
  return (data.mentionAnnotation?.formalMentionCount ?? 0) > 0
    ? `\nNote: ${data.mentionAnnotation!.formalMentionCount} of these messages formally @mention you.`
    : "";
}

/** What a hold for a card alone is about ("the description of #ops"), or undefined when it holds for unread messages. */
function holdCardOnlyLead(data: AgentHoldData): string | undefined {
  const holdReasons = data.holdReasons ?? [];
  if (holdReasons.includes("unread_messages")) return undefined;
  if (data.channelCard && holdReasons.includes("channel_card")) return `the description of ${agentChannelRef(data.channelCard.name, data.channelCard.type)}`;
  if (data.peerCard && holdReasons.includes("peer_card")) return `@${data.peerCard.name}'s profile`;
  return undefined;
}

function holdCardLines(data: AgentHoldData, style: RaftHintStyle): string[] {
  return [
    ...(data.channelCard ? renderChannelCard(data.channelCard, { changed: data.channelCardChanged === true, style }) : []),
    ...(data.peerCard ? renderPeerCard(data.peerCard, { style }) : []),
  ];
}

/**
 * A hold's context without the ways forward (no draft, no paths): what a
 * command that asks the agent instead of saving a draft shows under its
 * question (the `raft message send` continuation pilot). `cardOnlyLead` says
 * what a hold for a card alone is about; otherwise the hold is for unread
 * messages, and the preview is today's count, mention note, cards and window,
 * the window at the indent a preview adds.
 */
export function renderAgentHoldPreview(
  target: string,
  data: AgentHoldData,
  style: RaftHintStyle = "cli",
): { cardOnlyLead: string | null; preview: string } {
  if (data.freshnessContextMode === "withheld") {
    return { cardOnlyLead: null, preview: formatAgentReviewerIsolationHold(data).trimEnd() };
  }
  const cardOnlyLead = holdCardOnlyLead(data);
  if (cardOnlyLead) return { cardOnlyLead, preview: holdCardLines(data, style).join("\n") };
  const newMessageCount = data.newMessageCount ?? 0;
  const opening = `${newMessageCount} unread ${newMessageCount === 1 ? "message" : "messages"}.${holdMentionNote(data)}`;
  const { window, cardLines } = fitHoldWindow(target, data, opening, style);
  // The window is drawn two spaces in; a preview is indented by the paused text itself.
  const windowLines = renderThreadWindow(window, style).map((line) => line.replace(/^ {2}/, ""));
  return { cardOnlyLead: null, preview: [opening, ...cardLines, ...windowLines].join("\n") };
}

/**
 * The first path after a held send, for both the CLI and tool-style text: a
 * hold over new messages exists because someone may have said it already
 * (#wg-ax:#6). A hold for a card alone has no answer to point at.
 */
export function heldSendNothing(overNewMessages: boolean): string {
  const example = overNewMessages ? " (for example, someone already answered)" : "";
  return `If what you just read already says what you meant to say${example}, or makes your message unnecessary, send nothing.`;
}

/**
 * The held text: the opening line (unread messages, or the card that is new
 * to this context), the cards, the conversation's window form within the push
 * budget, then "choose one path" and the caller's ways forward.
 */
export function formatAgentHold(
  target: string,
  data: AgentHoldData,
  opts: AgentHoldOptions,
  style: RaftHintStyle = "cli",
): string {
  return renderAgentHold(target, data, opts, style).text;
}

/**
 * The held text, and whether it points to a read: the bodies were withheld,
 * or its window leaves something out (`threadWindowGap`). A hold that shows
 * all of it, or only a card, does not: reading again would print the same
 * messages. An SDK hold's `next` follows `pointsToRead`, so it agrees with
 * the text.
 */
export function renderAgentHold(
  target: string,
  data: AgentHoldData,
  opts: AgentHoldOptions,
  style: RaftHintStyle = "cli",
): { text: string; pointsToRead: boolean } {
  const text = (body: string, pointsToRead: boolean) => ({ text: body, pointsToRead });
  const withholdContext = opts.withholdContext === true || data.freshnessContextMode === "withheld";
  if (withholdContext) {
    // Counts only, no context bytes.
    return text(formatAgentReviewerIsolationHold(data) + (opts.isolationInstructions ? `\n${opts.isolationInstructions}` : ""), true);
  }
  const newMessageCount = data.newMessageCount ?? 0;
  const mentionNote = holdMentionNote(data);
  const continueAnyway = data.continueAnywaySuggested && opts.continueAnywayInstruction
    ? opts.continueAnywayInstruction
    : "";
  const newMessageNoun = newMessageCount === 1 ? "message" : "messages";

  // Held for a card alone: no unread messages, so no window.
  const cardOnlyLead = holdCardOnlyLead(data);
  if (cardOnlyLead) {
    const card = holdCardLines(data, style);
    return text(
      `Held — ${cardOnlyLead} is not in your current context yet. ${opts.heldAction}\n\n` +
      `${card.join("\n")}\n\n` +
      `After reading it, choose one path.\n` +
      (opts.draftInstructions ?? ""),
      false,
    );
  }

  const opening = `Held — ${newMessageCount} unread ${newMessageNoun} in ${target}. ${opts.heldAction}${mentionNote}`;
  const { window, cardLines } = fitHoldWindow(target, data, opening, style);
  const pushedText = holdPushedText(opening, cardLines, renderThreadWindow(window, style));

  return text(
    pushedText +
    `\n\nAfter reviewing the current state of this conversation, choose one path.\n` +
    (opts.draftInstructions ?? "") +
    continueAnyway,
    threadWindowGap(window) !== null,
  );
}

/**
 * A task write that was applied while the conversation it lands in had
 * messages the model had not seen (agentWriteLanding.ts `attach`): those
 * messages, in the hold's window form, after the write's own result. Empty
 * when nothing was attached.
 */
export function formatAgentTaskWriteUnseen(
  unseen: { target: string; messages: unknown[]; newMessageCount: number; omittedMessageCount: number } | undefined,
  style: RaftHintStyle = "cli",
): string {
  if (!unseen || unseen.newMessageCount <= 0) return "";
  const { preview } = renderAgentHoldPreview(unseen.target, {
    heldMessages: unseen.messages,
    newMessageCount: unseen.newMessageCount,
    shownMessageCount: unseen.messages.length,
    omittedMessageCount: unseen.omittedMessageCount,
  }, style);
  return [
    `Applied. Meanwhile ${unseen.target} has messages you had not seen; if they change what you just did, change it again:`,
    preview,
  ].join("\n");
}
