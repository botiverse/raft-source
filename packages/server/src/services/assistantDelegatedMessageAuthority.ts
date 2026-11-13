import { and, eq, isNull } from "drizzle-orm";
import type { DatabaseExecutor } from "../db/index";
import { agents, servers } from "../db/schema";
import { lockActorMembershipRow, ServerMembershipRevokedError } from "../lib/actorMembershipFence";

export class AssistantSendAsOwnerError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "AssistantSendAsOwnerError";
  }
}

/**
 * RFC 077: re-authorize the delegated author inside the message's write
 * transaction, after its channel / joint authority and before channel membership
 * or message rows. Server -> member -> Agent agrees with member removal and
 * the assistant settings/archive fence.
 * FOR SHARE conflicts with opt-out/unlink/archive updates, without serializing
 * concurrent sends. Keep this lock out of post-commit delivery and receipts.
 */
export async function lockAssistantDelegatedMessageAuthority(
  tx: DatabaseExecutor,
  input: { serverId: string; ownerUserId: string; agentId: string },
): Promise<void> {
  await tx.select({ id: servers.id }).from(servers).where(eq(servers.id, input.serverId)).for("share");
  try {
    await lockActorMembershipRow(tx, input.serverId, input.ownerUserId);
  } catch (error) {
    if (!(error instanceof ServerMembershipRevokedError)) throw error;
    throw new AssistantSendAsOwnerError(403, "assistant_authority_changed", "Your owner is no longer a member of this server.");
  }
  const [assistant] = await tx.select({ on: agents.assistantSendAsOwner }).from(agents).where(and(
    eq(agents.id, input.agentId),
    eq(agents.serverId, input.serverId),
    eq(agents.assistantOwnerUserId, input.ownerUserId),
    isNull(agents.deletedAt),
  )).limit(1).for("share");
  if (!assistant) {
    throw new AssistantSendAsOwnerError(403, "assistant_authority_changed", "You are no longer this owner's active assistant.");
  }
  if (!assistant.on) {
    throw new AssistantSendAsOwnerError(403, "assistant_send_as_owner_off", "Your owner has turned off sending as them. Summarize for them in your DM instead.");
  }
}
