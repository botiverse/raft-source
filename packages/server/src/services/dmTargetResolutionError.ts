import { formatDmPeerRef } from "@botiverse/raft-shared";

import { sentenceQuoting, type RefusalInput } from "../lib/refusal";
import { AGENT_REMINDERS_NOT_SENDABLE_MESSAGE } from "./agentPrivateSurfaces";

export type DmTargetResolutionErrorCode =
  | "DM_TARGET_AMBIGUOUS"
  | "DM_TARGET_INVALID_PEER_KIND"
  | "DM_TARGET_NOT_SENDABLE"
  | "MIGRATION_RECEIPT_READ_ONLY";

/**
 * A DM target that cannot be resolved to one conversation for a reason the
 * caller can fix, as opposed to "no such DM". Thrown by
 * channelService.resolveChannelByName so every agent-facing entry reports it
 * instead of collapsing it to not-found; every writer (respondToDmTargetResolutionError,
 * the global handler) refuses it with its 4xx status (toRefusal).
 */
export class DmTargetResolutionError extends Error {
  readonly status: 400 | 403 | 409;

  constructor(
    readonly code: DmTargetResolutionErrorCode,
    message: string,
    /** One-line, caller-actionable fix, stable across releases. */
    readonly suggestedNextAction: string,
  ) {
    super(message);
    this.name = "DmTargetResolutionError";
    this.status = code === "DM_TARGET_AMBIGUOUS" || code === "MIGRATION_RECEIPT_READ_ONLY" ? 409 : code === "DM_TARGET_NOT_SENDABLE" ? 403 : 400;
  }

  /** The refusal every route answers with (refuse(res, err.status, err.toRefusal())). */
  toRefusal(): RefusalInput {
    return { code: this.code, error: this.message, suggestedNextAction: this.suggestedNextAction };
  }

  static ambiguous(peerName: string): DmTargetResolutionError {
    const agentRef = `dm:@${formatDmPeerRef(peerName, "agent")}`;
    const humanRef = `dm:@${formatDmPeerRef(peerName, "human")}`;
    return new DmTargetResolutionError(
      "DM_TARGET_AMBIGUOUS",
      // A human and an agent both hold the name, so it is a real member name, not raw request text.
      `dm:@${peerName} matches both a human and an agent named ${peerName}. `
        + `Name the one you mean: ${agentRef} for the agent, or ${humanRef} for the human.`,
      `retry with ${agentRef} for the agent or ${humanRef} for the human`,
    );
  }

  /** dm:@reminders is read-only for its agent: reminders are acted on at their anchor. */
  static privateReminderSurface(): DmTargetResolutionError {
    return new DmTargetResolutionError(
      "DM_TARGET_NOT_SENDABLE",
      AGENT_REMINDERS_NOT_SENDABLE_MESSAGE,
      "send to the reminder's anchor target instead of dm:@reminders",
    );
  }

  /** A migration receipt is a one-way notice: read it, but there is no one there to reply to. */
  static migrationReceiptReadOnly(target: string): DmTargetResolutionError {
    // `target` already resolved to the receipt DM (an existing peer name or the conversation's id), not raw request text.
    return new DmTargetResolutionError(
      "MIGRATION_RECEIPT_READ_ONLY",
      `${target} is a migration receipt: a one-way notice from Raft about your move, with no one on the other side. `
        + "No reply is needed. To tell your owner something, send it to their DM.",
      "send to your owner's DM (dm:@<owner>) instead of the migration receipt",
    );
  }

  static invalidPeerKind(rawPeer: string, suffix: string | undefined): DmTargetResolutionError {
    return new DmTargetResolutionError(
      "DM_TARGET_INVALID_PEER_KIND",
      sentenceQuoting(
        [rawPeer],
        `dm:@${rawPeer} has an unknown peer kind${suffix !== undefined ? ` "${suffix}"` : ""}. Use dm:@<name>, dm:@<name>~agent or dm:@<name>~human.`,
        "That DM target has an unknown peer kind. Use dm:@<name>, dm:@<name>~agent or dm:@<name>~human.",
      ),
      "retry with dm:@<name>, dm:@<name>~agent or dm:@<name>~human",
    );
  }
}
