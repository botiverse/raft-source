export const MIN_KNOWLEDGE_CONTEXT_LENGTH = 12;
export const MAX_KNOWLEDGE_CONTEXT_LENGTH = 500;
export const RAFT_CLIENT_CAPABILITIES_HEADER = "X-Raft-Client-Capabilities";
export const MANUAL_CONTEXT_CAPABILITY = "manual-context-v1";
const PLAN_UPGRADE_CARD_CAPABILITY_VERSION = 1;
/**
 * A client's declaration, in its `X-Raft-Client-Capabilities` request header,
 * that it can post `plan:upgrade` action cards. CLIs before Computer 1.0.53
 * refused the type locally (they checked a card against the types they were
 * built with); a CLI that declares this sends any card to the Server, which
 * checks it. `@<version>` as in the guide-app tokens; 1 is the
 * card with the gates the Server's upgrade-card hints name (history_30d,
 * upload_monthly_quota, upload_file_size), and a hint that needs a newer form
 * would ask for a higher one. The Server offers the hint only to a client
 * that can post the card (agentUpgradeCardService).
 */
export const PLAN_UPGRADE_CARD_CAPABILITY = `action-card:plan:upgrade@${PLAN_UPGRADE_CARD_CAPABILITY_VERSION}`;
/**
 * A client's declaration that it has `raft inbox read` (RFC 081). The Server
 * teaches inbox items in an external agent's guide (`GET /context`) only to a
 * client that declares it: that agent's CLI is whatever it installed, so a
 * guide naming a command the CLI lacks would answer `unknown command` on the
 * first read. Managed agents need no token: the daemon builds their prompt
 * with the CLI it ships. Versioned like the other tokens.
 */
const INBOX_ITEMS_CAPABILITY_VERSION = 1;
export const INBOX_ITEMS_CAPABILITY = `inbox-items@${INBOX_ITEMS_CAPABILITY_VERSION}`;

/** Whether a request's `X-Raft-Client-Capabilities` value declares INBOX_ITEMS_CAPABILITY, at its version or later. */
export function hasInboxItemsCapability(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  return raw.split(",").some((value) => {
    const match = /^inbox-items@([1-9][0-9]*)$/u.exec(value.trim());
    return match !== null && Number(match[1]) >= INBOX_ITEMS_CAPABILITY_VERSION;
  });
}

/**
 * A runner's declaration that it acks reminder due items through the Server
 * (`POST /app-sources/ack`, which writes `reminder_source_acknowledgements`),
 * never only in its local reminder cache (RFC 081 D17). The Server lists
 * reminder items (`reminder:<id>`) in `inbox check`, and answers `inbox read`
 * / `inbox dismiss` of one, only for a request that declares it: an ack the
 * Server never saw would leave the item listed for good. The daemon's
 * credential proxy appends it to the agent-API requests it forwards; the CLI
 * never declares it itself. Without it the daemon's own due-item path
 * delivers the reminder. Versioned like the other tokens.
 */
const REMINDER_SERVER_ACK_CAPABILITY_VERSION = 1;
export const REMINDER_SERVER_ACK_CAPABILITY = `reminder-server-ack@${REMINDER_SERVER_ACK_CAPABILITY_VERSION}`;

/** Whether a request's `X-Raft-Client-Capabilities` value declares REMINDER_SERVER_ACK_CAPABILITY, at its version or later. */
export function hasReminderServerAckCapability(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  return raw.split(",").some((value) => {
    const match = /^reminder-server-ack@([1-9][0-9]*)$/u.exec(value.trim());
    return match !== null && Number(match[1]) >= REMINDER_SERVER_ACK_CAPABILITY_VERSION;
  });
}

export const MANUAL_INDEX_COMMAND = "raft manual get index --intent \"Learn available Raft workflows\" --reason \"Browse the topic catalog after a missing topic\"";

export type KnowledgeContextField = "intent" | "reason";

export function hasManualContextCapability(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  return raw
    .split(",")
    .some((value) => value.trim().toLowerCase() === MANUAL_CONTEXT_CAPABILITY);
}

/**
 * Whether a request's `X-Raft-Client-Capabilities` value declares
 * PLAN_UPGRADE_CARD_CAPABILITY, at its version or later. A token without a
 * whole version from 1 declares nothing; other tokens are ignored.
 */
export function hasPlanUpgradeCardCapability(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  return raw.split(",").some((value) => {
    const match = /^action-card:plan:upgrade@([1-9][0-9]*)$/u.exec(value.trim());
    return match !== null && Number(match[1]) >= PLAN_UPGRADE_CARD_CAPABILITY_VERSION;
  });
}

export type KnowledgeContextValidationResult =
  | { ok: true; value: string }
  | { ok: false; value: null; error: string };

export function validateKnowledgeContext(
  raw: unknown,
  field: KnowledgeContextField,
): KnowledgeContextValidationResult {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: false, value: null, error: `${field} is required` };
  }
  if (typeof raw !== "string") {
    return { ok: false, value: null, error: `${field} must be a string` };
  }

  const value = raw.trim();
  if (value.length < MIN_KNOWLEDGE_CONTEXT_LENGTH) {
    return {
      ok: false,
      value: null,
      error: `${field} must be at least ${MIN_KNOWLEDGE_CONTEXT_LENGTH} characters`,
    };
  }
  if (value.length > MAX_KNOWLEDGE_CONTEXT_LENGTH) {
    return {
      ok: false,
      value: null,
      error: `${field} must be at most ${MAX_KNOWLEDGE_CONTEXT_LENGTH} characters`,
    };
  }

  const unsafeError = classifyUnsafeKnowledgeContext(value, field);
  if (unsafeError) return { ok: false, value: null, error: unsafeError };
  return { ok: true, value };
}

function classifyUnsafeKnowledgeContext(value: string, field: KnowledgeContextField): string | null {
  if (/\[target=.*\bmsg=/.test(value)) return `${field} must not contain raw Slock message headers`;
  if (/```[\s\S]*```/.test(value)) return `${field} must not contain raw prompts or code blocks`;
  if (/https?:\/\//i.test(value)) return `${field} must not contain URLs`;
  if (/\bsk_(?:agent|machine|computer)_[a-z0-9_-]+\b/i.test(value)) {
    return `${field} must not contain credentials`;
  }
  if (/\bBearer\s+\S+/i.test(value) || /\b(?:api[_ -]?key|token|password|secret)\s*[:=]\s*\S+/i.test(value)) {
    return `${field} must not contain credentials`;
  }
  if (value.split(/\r?\n/).length > 4) return `${field} must be a concise natural-language summary`;
  return null;
}
