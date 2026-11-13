// Passive AX resource registry (RFC 072).
//
// A passive resource is something an agent could look at with an active
// command, and whose staleness the CLI can notice for it: the agent's local
// ledger records the version (`rev`) it last actually saw, and each command
// that touches the resource compares that against the current version. The
// registry is the only place a new resource type is declared; the CLI's
// engine dispatches on these fields and never on the type name.
//
// Admission rule: a thing is a resource only if a bounded, agent-specific
// version can be given for it. An unbounded, query-driven listing (for
// example the integration marketplace) is not one.
//
// "Seen" is bounded twice (RFC 072 §7), and both bounds are part of the
// contract:
// - it lasts one model context. The daemon issues a new opaque contextId at
//   every runtime spawn and every compaction start; anything recorded under
//   another contextId counts as not seen;
// - it means the CLI delivered the content into the context (stdout flushed),
//   NOT that the model read or learned it: runtimes truncate long tool output.
//   A hold guarantees the content landed in context before the action ran,
//   nothing more; it is not proof the agent has learned a rule.
//
// Policy, by the consequence of missing a change:
// - hold: the action waits until the current version has been delivered.
// - once: nothing waits; the full form is delivered the first time in a
//   context (or after the version moved) and a short form, or nothing,
//   after that.

import { foldAgentOneLineText } from "../agentMessageText";
import { agentChannelRef, channelVisibility } from "../agentText/server";
import { formatHint, RAFT_HINTS, type RaftHintStyle } from "./hint";

export type PassiveResourcePolicy = "hold" | "once";

export interface PassiveResourceSpec {
  /** Where the current version comes from. */
  revSource: "server-seq" | "content-hash";
  /** Consequence tier of acting without having seen the current version. */
  policy: PassiveResourcePolicy;
  /** The active command that shows the resource, in the caller's hint style; every renderer that points to it uses this. */
  activeCommand: (id: string, style?: RaftHintStyle) => string;
  /** What touches the resource. */
  touchedBy: readonly string[];
}

export const PASSIVE_RESOURCES = {
  // A conversation's messages. Version: the highest message seq the agent
  // has read in full. Enforced by the send freshness hold (server decides),
  // which shows the conversation in its window form, `renderThreadWindow`.
  thread: {
    revSource: "server-seq",
    policy: "hold",
    activeCommand: (id, style) => formatHint(RAFT_HINTS.messageRead({ target: id }), style),
    touchedBy: ["message send"],
  },
  // A consequential command's usage guidance (RFC 072 §7). Version: hash of
  // the text. The first run in a context delivers it instead of executing;
  // `--help` always prints it in full and also counts as delivery.
  "command.guidance": {
    revSource: "content-hash",
    policy: "hold",
    activeCommand: (id) => `raft ${id} --help`,
    touchedBy: ["the command itself", "--help"],
  },
  // A channel's card: its name, visibility, archived state and description.
  // Version: `channelCardRev`. The first read of the channel, or of a thread
  // in it, in a context carries the card, and so does the first read after
  // the card changed. A send names the version its context has: never seen
  // and nothing unread sends it with the card in the reply (#wg-ax:#25); never
  // seen with unread messages holds it once with them; an older version
  // comes back with the reply.
  // Id: the channel ref (`#name`), the base of every target in the channel.
  channel: {
    revSource: "content-hash",
    policy: "once",
    activeCommand: (id, style) => formatHint(RAFT_HINTS.channelInfo(id), style),
    touchedBy: ["message read", "message send"],
  },
  // What a top-level channel or DM read leaves out: its "Coverage:" sentence
  // (thread replies are read from their thread targets). Version: hash of the
  // sentence. The first top-level read of the conversation in a context
  // prints it; later ones do not. A thread read or a send does not count:
  // neither prints it. Id: the conversation's target (`#name`, `dm:@peer`).
  "read.coverage": {
    revSource: "content-hash",
    policy: "once",
    activeCommand: (id, style) => formatHint(RAFT_HINTS.messageRead({ target: id }), style),
    touchedBy: ["message read"],
  },
  // Who sent a message: the sender's profile description and, for a human web
  // sender, the time zone the message was sent from, shown next to the name in
  // agent-facing message text. Version: hash of both.
  // The first message from a sender in a context carries it; later ones show
  // only `@name`. Id: `senderObservationId`.
  sender: {
    revSource: "content-hash",
    policy: "once",
    activeCommand: (id, style) => formatHint(RAFT_HINTS.userInfo({ name: id.slice(id.indexOf(":") + 1) }), style),
    touchedBy: ["daemon message delivery", "message read", "message check", "message resolve", "message send (missed messages)"],
  },
} as const satisfies Record<string, PassiveResourceSpec>;

export type PassiveResourceType = keyof typeof PASSIVE_RESOURCES;

// ---- sender (policy "once") ----

/**
 * Ledger id of a sender. Humans and agents may share a name, so the kind is
 * part of it. A rename is a new id, which only shows the description once more.
 */
export function senderObservationId(senderType: string | null | undefined, senderName: string): string {
  return `${senderType ?? "unknown"}:${senderName}`;
}

/** FNV-1a, 32-bit, over UTF-16 code units. */
function fnv1a32(text: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Version of what a sender's handle shows. Pure TS (no node:crypto: the SDK
 * and daemon share this). Two independent 32-bit hashes keep an accidental
 * collision, which would hide a changed description for one context, remote.
 */
export function senderRev(description: string | null | undefined, timezone?: string | null): string {
  // Without a zone the input is the description alone, so revs recorded
  // before zones existed stay valid.
  const text = timezone ? `${description ?? ""}\u0000tz=${timezone}` : (description ?? "");
  const a = fnv1a32(text, 0x811c9dc5).toString(16).padStart(8, "0");
  const b = fnv1a32(text, 0x050c5d1f).toString(16).padStart(8, "0");
  return `${a}${b}`;
}

/**
 * Claims the first full showing of `(sender, rev)` in the current context.
 * `true`: show it in full (and it is now recorded); `false`: already shown in
 * this context, show `@name` only. Any doubt (no ledger, an error) must answer
 * `true`: showing a description once too often is the safe direction.
 */
export type SenderClaim = (id: string, rev: string) => boolean;

export interface SenderElision<T> {
  messages: T[];
  /** What this call recorded, so a caller whose output then fails can release it. */
  claimed: Array<{ id: string; rev: string }>;
}

/**
 * Drops the sender details (description and time zone) from every message
 * whose sender was already shown in full in this context, oldest first, so
 * the first message from each sender in a batch keeps them. Messages are not
 * mutated.
 */
export function elideSeenSenderDescriptions<T>(
  messages: readonly T[],
  access: {
    get: (m: T) => {
      type: string | null | undefined;
      name: string | null | undefined;
      description: string | null | undefined;
      timezone?: string | null | undefined;
    };
    /** The same message with neither description nor time zone. */
    withoutDescription: (m: T) => T;
  },
  claim: SenderClaim,
): SenderElision<T> {
  const seen = new Set<string>();
  const claimed: Array<{ id: string; rev: string }> = [];
  const out = messages.map((m) => {
    const { type, name, description, timezone } = access.get(m);
    if (!name || (!description && !timezone)) return m;
    const id = senderObservationId(type, name);
    const rev = senderRev(description, timezone);
    const key = `${id}\u0000${rev}`;
    // Within one batch only the first message from a sender can be the first.
    if (seen.has(key)) return access.withoutDescription(m);
    seen.add(key);
    if (!claim(id, rev)) return access.withoutDescription(m);
    claimed.push({ id, rev });
    return m;
  });
  return { messages: out, claimed };
}

// ---- thread (policy "hold") ----

/** One message as the window form shows it. */
export interface ThreadWindowMessage {
  seq?: number;
  sender?: string | null;
  /** ISO time, shown as UTC `HH:MM`. */
  timestamp?: string | null;
  content?: string | null;
  /** Files attached to it: the preview names how many, and the window then points to the read. */
  attachmentCount?: number;
}

/** The attachment count a message as the Server sends it carries (`attachments` array), for a window preview. */
export function windowAttachmentCount(message: { attachments?: unknown }): number {
  return Array.isArray(message.attachments) ? message.attachments.length : 0;
}

export interface ThreadWindow {
  target: string;
  /** A thread's first message; shown only when it is older than the window. */
  start?: ThreadWindowMessage & { seq: number };
  /** Messages between the start and the window that are not shown. */
  omittedCount: number;
  /** Lowest seq in the window, the `--before` anchor for older messages; derived from `messages` when absent. */
  firstShownSeq?: number;
  /** The count the "Latest N" rule names; defaults to the number of messages. */
  shownCount?: number;
  /** The latest messages, in the order given. */
  messages: readonly ThreadWindowMessage[];
}

/**
 * Preview cap per message, counted in code points so CJK and Latin text
 * truncate comparably. A display budget, not a secret: every truncated
 * preview says how much it hides.
 */
export const THREAD_WINDOW_PREVIEW_CHARS = 160;

function threadWindowPreviewPoints(message: ThreadWindowMessage): string[] {
  return Array.from(foldAgentOneLineText(message.content ?? ""));
}

function threadWindowPreview(message: ThreadWindowMessage): string {
  const points = threadWindowPreviewPoints(message);
  const shown = points.slice(0, THREAD_WINDOW_PREVIEW_CHARS).join("");
  const hidden = points.length - Math.min(points.length, THREAD_WINDOW_PREVIEW_CHARS);
  const date = message.timestamp ? new Date(message.timestamp) : null;
  const time = date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(11, 16) : "";
  const head = [message.sender ? `@${message.sender}` : "", time].filter(Boolean).join(" ");
  const marker = hidden > 0 ? `…⟨${hidden} more chars⟩` : "";
  const files = message.attachmentCount ?? 0;
  const attached = files > 0 ? `${shown || marker ? " " : ""}⟨${files} attachment${files === 1 ? "" : "s"}⟩` : "";
  return `  │ ${head ? `${head}  ` : ""}${shown}${marker}${attached}`;
}

/**
 * The window form of a conversation: the thread start when it is older than
 * the window, how many earlier messages were skipped and the command for
 * them, the latest messages as bounded previews, and, when the window leaves
 * something out, the command to read it. It is a map to decide from, not the
 * conversation: whether and how deep to read is the agent's call. Lines,
 * without a trailing newline.
 */
export function renderThreadWindow(form: ThreadWindow, style: RaftHintStyle = "cli"): string[] {
  const { target, start, messages } = form;
  const seqs = messages.map((m) => Number(m.seq)).filter((s) => Number.isFinite(s) && s > 0);
  const firstShownSeq = form.firstShownSeq ?? (seqs.length > 0 ? Math.min(...seqs) : undefined);
  const lines: string[] = [];
  const shownStart = start && (firstShownSeq === undefined || start.seq < firstShownSeq) ? start : undefined;
  if (shownStart) {
    lines.push(`  ┌ Thread start ${"─".repeat(28)}`);
    lines.push(threadWindowPreview(shownStart));
  }
  if (form.omittedCount > 0 && firstShownSeq !== undefined) {
    const older = formatHint(RAFT_HINTS.messageRead({ target, before: firstShownSeq }), style);
    lines.push(
      `  ├ ⋯ ${form.omittedCount} earlier message${form.omittedCount === 1 ? "" : "s"} skipped in this notice. `
      + `Older: ${older} ⋯`,
    );
  }
  if (messages.length > 0) {
    lines.push(`  ├ Latest ${form.shownCount ?? messages.length} ${"─".repeat(28)}`);
    for (const message of messages) lines.push(threadWindowPreview(message));
  }
  const read = PASSIVE_RESOURCES.thread.activeCommand(target, style);
  const gap = threadWindowGap(form);
  lines.push(gap === "none_shown"
    ? `  └ Not shown here. Read them: ${read}`
    : gap === "cut"
    ? `  └ Previews are truncated. Full text: ${read}`
    : gap === "left_out"
    ? `  └ Not all of it is shown here. Read it: ${read}`
    : `  └ ${"─".repeat(40)}`);
  return lines;
}

/**
 * What the window leaves out, if anything: no message shown, a preview cut,
 * or something else left out (an attachment, skipped messages with no "Older
 * exist" line, fewer lines than the count it names). `null` when what is
 * shown is the whole of it, and reading again would print it twice. The
 * window's last line and an SDK hold's `next` both follow this.
 */
export function threadWindowGap(form: ThreadWindow): "none_shown" | "cut" | "left_out" | null {
  const { start, messages } = form;
  const seqs = messages.map((m) => Number(m.seq)).filter((s) => Number.isFinite(s) && s > 0);
  const firstShownSeq = form.firstShownSeq ?? (seqs.length > 0 ? Math.min(...seqs) : undefined);
  const shownStart = start && (firstShownSeq === undefined || start.seq < firstShownSeq) ? start : undefined;
  if (messages.length === 0) return "none_shown";
  const shown = [...(shownStart ? [shownStart] : []), ...messages];
  if (shown.some((m) => threadWindowPreviewPoints(m).length > THREAD_WINDOW_PREVIEW_CHARS)) return "cut";
  const leftOut = shown.some((m) => (m.attachmentCount ?? 0) > 0)
    || (form.omittedCount > 0 && firstShownSeq === undefined)
    || (form.shownCount ?? messages.length) > messages.length;
  return leftOut ? "left_out" : null;
}

// ---- channel (policy "once") ----

/** A channel's card, as the Server returns it with a read of the channel or of a thread in it. */
export interface ChannelCard {
  id: string;
  name: string;
  /** `channel` (public), `private` or `joint`. */
  type?: string | null;
  description?: string | null;
  archived?: boolean | null;
}

/** Description cap in the card, in code points; the equivalent command shows it in full. */
export const CHANNEL_CARD_DESCRIPTION_CHARS = 300;

function displayedDescription(card: ChannelCard): string {
  return foldAgentOneLineText(card.description ?? "");
}

/**
 * Version of a channel card: `v1:` and two independent 32-bit FNV-1a hashes
 * over a fixed-order serialization of what the card shows (the description
 * as displayed, whitespace collapsed). Pure TS, so every side that versions
 * a card calls this one function. A card that gains a field gets a new
 * prefix (`v2:`): every agent then sees the card once more, and the prefix
 * says the algorithm moved, not the channel.
 */
export function channelCardRev(card: ChannelCard): string {
  const text = JSON.stringify([
    card.name,
    channelVisibility(card),
    card.archived === true,
    displayedDescription(card),
  ]);
  const a = fnv1a32(text, 0x811c9dc5).toString(16).padStart(8, "0");
  const b = fnv1a32(text, 0x050c5d1f).toString(16).padStart(8, "0");
  return `v1:${a}${b}`;
}

/**
 * The card as the agent sees it: one line with the channel, its visibility,
 * archived state and description (whitespace collapsed), then the equivalent
 * command, which shows a capped description in full. An archived channel's
 * card carries the whole description and no pointer.
 * `changed`: the agent saw an older version of this card in this context.
 */
export function renderChannelCard(card: ChannelCard, options: { changed?: boolean; descriptionChars?: number; style?: RaftHintStyle } = {}): string[] {
  const ref = agentChannelRef(card.name, card.type);
  const archived = card.archived === true;
  // Archived: say it is read-only here, where the agent reads before it replies.
  const status = [channelVisibility(card), ...(archived ? ["archived", "read-only"] : [])].join(", ");
  const points = Array.from(displayedDescription(card));
  const cap = archived ? points.length : (options.descriptionChars ?? CHANNEL_CARD_DESCRIPTION_CHARS);
  const hidden = points.length - Math.min(points.length, cap);
  const description = points.length > 0
    ? `${points.slice(0, cap).join("")}${hidden > 0 ? `…⟨${hidden} more chars⟩` : ""}`
    : "no description.";
  const lead = options.changed ? `Channel ${ref} (${status}), changed since you last saw it:` : `Channel ${ref} (${status}):`;
  const line = `${lead} ${description}`;
  return archived ? [line] : [line, `Equivalent: ${PASSIVE_RESOURCES.channel.activeCommand(ref, options.style)}`];
}

// ---- DM peer card (the `sender` resource, read and send) ----

/**
 * The other side of a DM as a card: the same facts, and the same ledger row
 * (`sender`, `senderObservationId`), as the `@name (zone) — description`
 * a message from them carries, so a peer seen on a message is not shown
 * again as a card, and the other way round. The zone is the one their latest
 * message in the DM carried (a human's zone travels with each message).
 */
export interface PeerCard {
  kind: "human" | "agent";
  name: string;
  description?: string | null;
  timezone?: string | null;
}

/** The ledger id of a DM peer: the sender id their messages use. */
export function peerCardId(card: Pick<PeerCard, "kind" | "name">): string {
  return senderObservationId(card.kind, card.name);
}

/** The version of a DM peer card: the sender version (description and zone). */
export function peerCardRev(card: PeerCard): string {
  return senderRev(card.description, card.timezone);
}

/** Whether a peer card has anything to show (a peer with neither is never held for). */
export function peerCardHasContent(card: PeerCard): boolean {
  return Boolean(card.description?.trim() || card.timezone);
}

/**
 * The card as the agent sees it: the peer, their kind and zone, their
 * description (whitespace collapsed, capped like a channel card's), then the
 * equivalent command, which shows it in full. A peer card is shown when this
 * context has seen nothing of the peer; it has no "changed" form, because
 * the zone travels with each message (a message from them shows the change).
 */
export function renderPeerCard(card: PeerCard, options: { descriptionChars?: number; style?: RaftHintStyle } = {}): string[] {
  const status = [card.kind, ...(card.timezone ? [card.timezone] : [])].join(", ");
  const cap = options.descriptionChars ?? CHANNEL_CARD_DESCRIPTION_CHARS;
  const points = Array.from(foldAgentOneLineText(card.description ?? ""));
  const hidden = points.length - Math.min(points.length, cap);
  const description = points.length > 0
    ? `${points.slice(0, cap).join("")}${hidden > 0 ? `…⟨${hidden} more chars⟩` : ""}`
    : "no description.";
  return [`DM peer @${card.name} (${status}): ${description}`, `Equivalent: ${PASSIVE_RESOURCES.sender.activeCommand(peerCardId(card), options.style)}`];
}

// ---- the push budget (glimpse §1.3, acceptance G1-11) ----

/**
 * Most a push (a hold's context, a send's attachment) puts into the agent's
 * context, in code points, not counting the agent's own draft or the paths
 * offered after it. The latest messages always stay; related resources give
 * way first: card descriptions shrink (still ending in their equivalent
 * command, so a shrunk card counts as seen), then a thread's start goes.
 * Best effort: with handles as validated (at most 32 characters) it holds;
 * only unvalidated bridged names far longer than that can push past it.
 */
export const GLIMPSE_PUSH_BUDGET_CHARS = 2000;

/** Shortest a card description shrinks to under the budget. */
const MIN_BUDGET_DESCRIPTION_CHARS = 40;

export function codePointLength(text: string): number {
  return Array.from(text).length;
}

/**
 * The cards (channel, peer) shrunk until `fits` holds for their lines, never
 * below MIN_BUDGET_DESCRIPTION_CHARS per description. Returns the lines of
 * the last attempt, fitting or not.
 */
export function fitCards(
  cards: { channelCard?: ChannelCard | null; channelCardChanged?: boolean; peerCard?: PeerCard | null },
  fits: (cardLines: string[]) => boolean,
  style: RaftHintStyle = "cli",
): string[] {
  if (!cards.channelCard && !cards.peerCard) return [];
  const render = (descriptionChars: number) => [
    ...(cards.channelCard ? renderChannelCard(cards.channelCard, { changed: cards.channelCardChanged === true, descriptionChars, style }) : []),
    ...(cards.peerCard ? renderPeerCard(cards.peerCard, { descriptionChars, style }) : []),
  ];
  let descriptionChars = CHANNEL_CARD_DESCRIPTION_CHARS;
  let lines = render(descriptionChars);
  while (!fits(lines) && descriptionChars > MIN_BUDGET_DESCRIPTION_CHARS) {
    descriptionChars = Math.max(MIN_BUDGET_DESCRIPTION_CHARS, descriptionChars - 20);
    lines = render(descriptionChars);
  }
  return lines;
}

// ---- attached on every send (runtimes that do not report compaction) ----

export interface SendAttachment {
  target: string;
  channelCard?: ChannelCard | null;
  peerCard?: PeerCard | null;
  /** The latest messages before the one just sent, oldest first. */
  messages: readonly ThreadWindowMessage[];
}

/**
 * What a send carries for a runtime that does not report compaction: a line
 * saying what this is (not part of the sent message) and why, the cards,
 * then the latest messages before the sent one in window form. The whole
 * stays within `budget` code points: card descriptions shrink first, then the
 * oldest messages go (the window says how many it skipped). Empty when there
 * is nothing to show.
 */
export function renderSendAttachment(attachment: SendAttachment, budget = GLIMPSE_PUSH_BUDGET_CHARS, style: RaftHintStyle = "cli"): string[] {
  const cards = {
    channelCard: attachment.channelCard && attachment.channelCard.archived !== true ? attachment.channelCard : null,
    peerCard: attachment.peerCard && peerCardHasContent(attachment.peerCard) ? attachment.peerCard : null,
  };
  if (!cards.channelCard && !cards.peerCard && attachment.messages.length === 0) return [];
  const header = `Not part of your message: the latest in ${attachment.target} before it (shown after every send because this runtime does not report context compaction):`;
  const all = attachment.messages;
  const assemble = (cardLines: string[], dropped: number) => {
    const messages = all.slice(dropped);
    return [
      header,
      ...cardLines,
      ...(messages.length > 0 ? renderThreadWindow({ target: attachment.target, omittedCount: dropped, messages }, style) : []),
    ];
  };
  const fits = (lines: string[]) => codePointLength(lines.join("\n")) <= budget;
  for (let dropped = 0; ; dropped += 1) {
    const cardLines = fitCards(cards, (candidate) => fits(assemble(candidate, dropped)), style);
    const lines = assemble(cardLines, dropped);
    if (fits(lines) || dropped >= all.length) return lines;
  }
}
