/**
 * When an assistant's owner leaves the server (removed, or left), the assistant
 * goes with them: archived in the same transaction as the membership removal,
 * its hosted runtime deleted and every credential revoked, and their WeChat
 * bridge in the server removed. Afterwards a server
 * owner/admin may clean the archive up (`decideAgentResourceAuthority`: an
 * assistant whose owner is no longer a member).
 */
import { and, eq, isNull } from "drizzle-orm";
import type { DatabaseExecutor } from "../db/index";
import { agents } from "../db/schema";
import { recordAgentArchive } from "./agentArchiveService";
import { deleteAgent } from "./agentService";
import { beginProvisionedAgentDeletion } from "./agentRuntimeProvisionService";
import type { ServerAuditContext } from "./integrationAuditService";
import { removeWeChatBridgeOfDepartingMember } from "./wechatBridgeCleanup";

export interface DepartedOwnerAssistants {
  agentIds: string[];
  hostedDeletion: boolean;
}

/** Inside the removal transaction (member row already locked): archive the user's assistants in this server. */
export async function archiveAssistantsOfDepartingOwner(
  tx: DatabaseExecutor,
  input: { serverId: string; ownerUserId: string; actorUserId: string; audit?: ServerAuditContext },
): Promise<DepartedOwnerAssistants> {
  // Locked first: a binding being made holds the Ottie before its attempt
  // (wechatBridgeService lockWeChatParents), and so does this removal.
  const owned = await tx.select({ id: agents.id }).from(agents).where(and(
    eq(agents.serverId, input.serverId),
    eq(agents.assistantOwnerUserId, input.ownerUserId),
    isNull(agents.deletedAt),
  )).for("update");
  // Nothing of theirs in this server mirrors to WeChat any more.
  await removeWeChatBridgeOfDepartingMember(tx, { serverId: input.serverId, userId: input.ownerUserId, actorUserId: input.actorUserId });
  let hostedDeletion = false;
  for (const { id } of owned) {
    // A hosted assistant keeps no workspace on a Computer.
    await recordAgentArchive(tx, { agentId: id, userId: input.actorUserId, choice: "keep", audit: input.audit });
    await deleteAgent(id, { executor: tx });
    // recordAgentArchive revoked every credential of the agent (and audited it).
    if (await beginProvisionedAgentDeletion(tx, id, input.actorUserId, input.audit)) hostedDeletion = true;
  }
  return { agentIds: owned.map((row) => row.id), hostedDeletion };
}
