import { agentApiManagedMcpCallBodySchema, type AgentMessage } from "@botiverse/raft-shared";
import { runtimeProfileNotificationFromMessage } from "./agentRuntimeInput";
import type { RuntimeTurnOrigin } from "./runtimeTurnOrigin";

// Manager-side half of the turn origin (see runtimeTurnOrigin.ts). Kept apart so the runtime
// sessions and call surfaces that import the holder do not pull in runtime-input formatting.

// The server validates `origin` with this exact schema, and an invalid value rejects the WHOLE call
// with 400 -- the tool call itself would fail, not just the card. Reusing the schema object keeps the
// daemon from ever sending an id the server would refuse.
const originSchema = agentApiManagedMcpCallBodySchema.shape.origin.unwrap();

function messageUuid(message: AgentMessage): string | null {
  const id = message.message_id;
  if (typeof id !== "string") return null;
  return originSchema.safeParse({ sourceMessageId: id }).success ? id : null;
}

/**
 * Origin for a foreground turn whose runtime input carries exactly `envelopes`.
 *
 * ⭐ Authority condition (@peng msg 4b57d30e): a SINGLE CONCRETE MESSAGE ENVELOPE. `envelopes` are the
 * Raft message envelopes the manager actually hands to the runtime for this turn -- never the prompt
 * text. An ordinary channel/DM/thread message is usually rendered as a content-free
 * `[Raft inbox notice]`; the envelope underneath is unchanged, so it still names its origin. Nothing
 * here reads notice text, unread counts, the delivery ledger, or a "most recent" message.
 *
 * Returns null for anything that is not exactly one envelope with a server-valid UUID, including a
 * runtime-profile control message (its id is a daemon-local key, not a Raft message). Inputs that
 * have no envelope at all -- app-inbox notices, transient system notices, unread summaries, resume
 * and control prompts, background work -- never reach this function; the caller passes null.
 */
export function deriveForegroundTurnOrigin(envelopes: readonly AgentMessage[]): RuntimeTurnOrigin | null {
  if (envelopes.length !== 1) return null;
  const [message] = envelopes;
  if (runtimeProfileNotificationFromMessage(message)) return null;
  const sourceMessageId = messageUuid(message);
  return sourceMessageId ? { sourceMessageId } : null;
}
