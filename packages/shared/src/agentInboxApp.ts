/**
 * Typed Agent Inbox app items (Phase 1 substrate).
 *
 * Message targets keep the existing AgentInboxTargetRow shape and formatters.
 * App items are a second source kind: OS-minted, no Raft message id/seq/sender.
 *
 * Real app names (and their action builders / source-ref schemas) are NOT
 * defined here. Production registry is empty; app-owned packages inject class
 * definitions + normalizers + builders.
 */

import { formatHint, RAFT_HINTS } from "./agentOps/hint";
import { currentTimeMs } from "./clock";
import { foldAgentOneLineText } from "./agentMessageText";
import { renderThirdPartyInertText } from "./thirdPartyInertRenderer";

/** Closed set of primary action kinds. App payloads cannot invent shell commands. */
export type AgentInboxPrimaryActionKind = "open_target" | "run_command" | "none";

/**
 * OS-minted primary action. `commandId` is a registry id from the injected
 * definition, never an arbitrary shell string from untrusted payload.
 */
export type AgentInboxPrimaryAction = {
  kind: AgentInboxPrimaryActionKind;
  /** When kind=open_target */
  target?: string;
  /** When kind=run_command — closed registry id only */
  commandId?: string;
};

/**
 * until_source_read: legacy durable item retired by a source-read side effect.
 * until_explicit_ack: durable item retired only by the closed explicit ack action.
 * transient: process-local item that may drop on daemon restart.
 */
export type AgentInboxRetention = "until_source_read" | "until_explicit_ack" | "transient";

/**
 * Typed source identity/revision (not an opaque freeform string).
 * App-owned normalizers produce this closed shape before mint identity/action.
 */
export type AgentInboxSourceRef = {
  kind: string;
  id: string;
  revision?: string;
};

/** Local, owner-labelled hold on one exact app source identity. */
export type AgentInboxItemSeal = {
  owner: string;
  until: string;
  sealedAtMs: number;
};

export type AgentInboxSourceSeal = AgentInboxItemSeal & {
  appId: string;
  notificationClass: string;
  sourceRef: AgentInboxSourceRef;
};

export type AgentInboxAppItem = {
  source: "app";
  itemId: string;
  appId: string;
  notificationClass: string;
  /** Structured typed source — never an opaque freeform string on the wire. */
  sourceRef: AgentInboxSourceRef;
  primaryAction: AgentInboxPrimaryAction;
  /**
   * Exact closed CLI string from the injected registry action-builder at mint.
   * Never freeform shell from title/summary/payload.
   */
  actionCli: string;
  retention: AgentInboxRetention;
  /** Optional short display fields (no message body content stream). */
  title?: string;
  summary?: string;
  createdAtMs?: number;
  /** Read projection only; the daemon persists seals separately from app items. */
  seal?: AgentInboxItemSeal;
};

/** Preview (title/summary) bounds — OS mint fail-closed; prevents multi-line action forgery. */
export const AGENT_INBOX_PREVIEW_MAX_CHARS = 120;

/**
 * The preview of a message or item text: its first non-blank line, folded to
 * one line, at most AGENT_INBOX_PREVIEW_MAX_CHARS, never splitting a surrogate
 * pair; `previewTruncated` when anything was left out (later lines or the
 * cut). `inert` renders third-party text inert first. One rule for every
 * place that shows a shortened message: inbox rows, and a quote of a whole
 * message.
 */
export function agentInboxPreview(text: string | null | undefined, inert = false): { preview: string | null; previewTruncated: boolean } {
  if (!text) return { preview: null, previewTruncated: false };
  const firstLine = text.split(/\r\n|[\r\n\u0085\u2028\u2029]/).find((line) => line.trim()) ?? "";
  const folded = foldAgentOneLineText(inert ? renderThirdPartyInertText({ field: "tool_result", value: firstLine }) : firstLine);
  if (!folded) return { preview: null, previewTruncated: false };
  const cutForLines = firstLine.length < text.trim().length;
  if (folded.length <= AGENT_INBOX_PREVIEW_MAX_CHARS) return { preview: folded, previewTruncated: cutForLines };
  let cut = AGENT_INBOX_PREVIEW_MAX_CHARS;
  const last = folded.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1; // never split a surrogate pair
  return { preview: folded.slice(0, cut), previewTruncated: true };
}

/** Message-target envelope for the unified items list (row format stays legacy). */
export type AgentInboxMessageTargetItem = {
  source: "message_target";
  /** Legacy content-free target row — byte-compatible with existing renderers. */
  row: import("./agentInbox").AgentInboxTargetRow;
};

export type AgentInboxItem = AgentInboxMessageTargetItem | AgentInboxAppItem;

export function isAgentInboxAppItem(item: AgentInboxItem): item is AgentInboxAppItem {
  return item.source === "app";
}

export function isAgentInboxMessageTargetItem(
  item: AgentInboxItem,
): item is AgentInboxMessageTargetItem {
  return item.source === "message_target";
}

/** Canonical display / log form: `kind:id` or `kind:id:revision`. */
export function formatAgentInboxSourceRef(ref: AgentInboxSourceRef): string {
  if (ref.revision !== undefined && ref.revision !== "") {
    return `${ref.kind}:${ref.id}:${ref.revision}`;
  }
  return `${ref.kind}:${ref.id}`;
}

/** Stable identity fragment for (appId, class, sourceRef) maps/hashes. */
export function sourceRefIdentityKey(ref: AgentInboxSourceRef): string {
  return `${ref.kind}\0${ref.id}\0${ref.revision ?? ""}`;
}

/** Short id for CLI builders: first 8 of structured `id`. */
export function shortIdFromSourceRef(ref: AgentInboxSourceRef): string {
  return ref.id.slice(0, 8);
}

/**
 * The item's address, as the other app rows start: `app:<appId>/<item>`,
 * `<item>` being the first 8 characters of its id. An item the agent may
 * dismiss is dismissed by this address (agentInboxAppItemDismissTarget).
 */
function agentInboxAppItemAddress(item: AgentInboxAppItem): string {
  return `app:${foldAgentOneLineText(item.appId)}/${foldAgentOneLineText(shortId(item.itemId))}`;
}

/**
 * The item's first line: its address, then its title in quotes (free text
 * between ` · ` separators could pass for another part):
 * `app:system.cleaner/714fbfc6 · "Review .raftbackupignore"`. A sealed item
 * adds who sealed it and its source (`source=reminder:<id>:<revision>`): it
 * prints no action, so the source is all that tells two sealed items of one
 * app apart and matches the item to its `seal …` line in the seal registry.
 */
function agentInboxAppItemRowText(item: AgentInboxAppItem): string {
  return foldAgentOneLineText(item.title ?? "") || foldAgentOneLineText(item.summary ?? "");
}

export function formatAgentInboxAppItem(item: AgentInboxAppItem): string {
  const parts = [agentInboxAppItemAddress(item)];
  // An item without a title is named by its summary, so every row has a
  // quoted part after its address (and no preview line repeats it).
  const title = agentInboxAppItemRowText(item);
  if (title) parts.push(JSON.stringify(title));
  if (item.seal) parts.push(`sealed owner=${item.seal.owner}`, `unseal_when=${item.seal.until}`, `source=${formatAgentInboxSourceRef(item.sourceRef)}`);
  return parts.join(" · ");
}

/** An app id or a printed item id that can stand in a dismiss target as it is (no quote, space or line break). */
const DISMISS_TARGET_PART = /^[A-Za-z0-9](?:[A-Za-z0-9_.:-]*[A-Za-z0-9])?$/;

/**
 * The one rule for which Computer-local app items an agent may dismiss
 * (`raft inbox dismiss`), and the target that does it: `app:<appId>/<item>`,
 * the address the row starts with. The row prints its dismiss
 * command from it, and the daemon dismisses the calling agent's one item
 * whose target this is. Null for an item that is not dismissed: one that asks
 * for an explicit ack (a fired reminder leaves the Inbox by its ack only), a
 * sealed one, or one whose ids cannot stand in a target.
 */
export function agentInboxAppItemDismissTarget(item: AgentInboxAppItem): string | null {
  if (item.retention === "until_explicit_ack" || item.seal) return null;
  const printedId = shortId(item.itemId);
  if (!DISMISS_TARGET_PART.test(item.appId) || !DISMISS_TARGET_PART.test(printedId)) return null;
  return `app:${item.appId}/${printedId}`;
}

/**
 * One item as list lines, laid out as the other inbox rows are
 * (formatAgentInboxItemRow):
 *
 *   app:system.cleaner/714fbfc6 · "Review .raftbackupignore"
 *     "Over half the move size limit (60%)." (preview)
 *     do: raft manual get agent --intent "Keep your workspace migratable"
 *     dismiss: raft inbox dismiss --target "app:system.cleaner/714fbfc6"
 *
 * `do:` is the item's action (left out while it is sealed); `dismiss:` only
 * for an item the agent may dismiss (agentInboxAppItemDismissTarget). The
 * class and retention are not printed, nor the source ref of an unsealed
 * item: its action already carries the ids it needs (a reminder's `ack` its
 * id and revision).
 */
export function formatAgentInboxAppItemLines(item: AgentInboxAppItem): string[] {
  const lines = [formatAgentInboxAppItem(item)];
  const summary = item.summary ? foldAgentOneLineText(item.summary) : "";
  if (summary && summary !== agentInboxAppItemRowText(item)) lines.push(`  ${JSON.stringify(summary)} (preview)`);
  if (!item.seal) lines.push(`  do: ${foldAgentOneLineText(item.actionCli)}`);
  const target = agentInboxAppItemDismissTarget(item);
  if (target !== null) lines.push(`  dismiss: ${formatHint(RAFT_HINTS.inboxDismiss({ target }))}`);
  return lines;
}

export function formatAgentInboxAppItems(items: readonly AgentInboxAppItem[]): string {
  if (items.length === 0) return "";
  return [
    `App items: ${items.length}`,
    "",
    ...items.flatMap((item) => [...formatAgentInboxAppItemLines(item), ""]),
  ]
    .join("\n")
    .trimEnd();
}

/**
 * Compose a full snapshot. Message-only input MUST match formatAgentInboxSnapshot(rows)
 * byte-for-byte (no app section, no header drift).
 */
export function formatAgentInboxFullSnapshot(input: {
  messageRows: readonly import("./agentInbox").AgentInboxTargetRow[];
  appItems?: readonly AgentInboxAppItem[];
  formatMessageRows: (rows: readonly import("./agentInbox").AgentInboxTargetRow[]) => string;
}): string {
  const messagePart = input.formatMessageRows(input.messageRows);
  const apps = input.appItems ?? [];
  if (apps.length === 0) return messagePart;
  const appPart = formatAgentInboxAppItems(apps);
  if (messagePart === "Inbox: empty") {
    return appPart;
  }
  return `${messagePart}\n\n${appPart}`;
}

/**
 * The 8 characters an item is printed by. An id that starts with its kind
 * (`reminder:<id>:<revision>`) is cut after the kind, so two reminders do not
 * both print as `reminder`.
 */
function shortId(value: string): string {
  const afterKind = /^[a-z][a-z_]*:(.+)$/.exec(value)?.[1] ?? value;
  return afterKind.slice(0, 8);
}

/** Re-export clock for daemon mint defaults without ambient Date.now in daemon files. */
export { currentTimeMs };
