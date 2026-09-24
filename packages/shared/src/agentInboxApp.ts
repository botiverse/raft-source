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

import { currentTimeMs } from "./clock.js";

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
};

/** Preview (title/summary) bounds — OS mint fail-closed; prevents multi-line action forgery. */
export const AGENT_INBOX_PREVIEW_MAX_CHARS = 120;

/** Message-target envelope for the unified items list (row format stays legacy). */
export type AgentInboxMessageTargetItem = {
  source: "message_target";
  /** Legacy content-free target row — byte-compatible with existing renderers. */
  row: import("./agentInbox.js").AgentInboxTargetRow;
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

export function formatAgentInboxAppItem(item: AgentInboxAppItem): string {
  const parts = [
    `app=${item.appId}`,
    `class=${item.notificationClass}`,
    `item=${shortId(item.itemId)}`,
    `retention=${item.retention}`,
    `sourceRef=${formatAgentInboxSourceRef(item.sourceRef)}`,
    `action=${item.actionCli}`,
  ];
  if (item.title) parts.push(`title=${item.title}`);
  if (item.summary) parts.push(`summary=${item.summary}`);
  return parts.join(" · ");
}

export function formatAgentInboxAppItems(items: readonly AgentInboxAppItem[]): string {
  if (items.length === 0) return "";
  return [
    `App items: ${items.length}`,
    "",
    ...items.flatMap((item) => [formatAgentInboxAppItem(item), ""]),
  ]
    .join("\n")
    .trimEnd();
}

/**
 * Compose a full snapshot. Message-only input MUST match formatAgentInboxSnapshot(rows)
 * byte-for-byte (no app section, no header drift).
 */
export function formatAgentInboxFullSnapshot(input: {
  messageRows: readonly import("./agentInbox.js").AgentInboxTargetRow[];
  appItems?: readonly AgentInboxAppItem[];
  formatMessageRows: (rows: readonly import("./agentInbox.js").AgentInboxTargetRow[]) => string;
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

function shortId(value: string): string {
  return value.slice(0, 8);
}

/** Re-export clock for daemon mint defaults without ambient Date.now in daemon files. */
export { currentTimeMs };
