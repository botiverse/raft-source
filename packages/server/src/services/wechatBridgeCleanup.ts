/**
 * Removing a person's WeChat bridge (wechatBridgeService.ts): their Disconnect,
 * and the cleanup inside account deletion, a member leaving a server, an
 * assistant being archived and a server being deleted. Kept apart from the
 * binding flow so those transactions import only the tables and the audit
 * writer.
 */
import { and, eq, inArray, type SQL } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index";
import { agents, wechatBridgeAttempts, wechatBridgeBindings, wechatBridgeInboundMessages } from "../db/schema";
import { recordIntegrationAuditEvent, type IntegrationAuditSource } from "./integrationAuditService";

/** Why a binding went (audit metadata `reason`). `flag_off`: the poll worker (PR 2) finds the flag off. */
export type WeChatDisconnectReason =
  | "user"
  | "owner_departed"
  | "account_deletion"
  | "assistant_archived"
  | "server_deleted"
  | "flag_off";

type CleanupActor = { type: "human" | "system"; id: string | null };

function actorOf(actorUserId: string | null): CleanupActor {
  return actorUserId ? { type: "human", id: actorUserId } : { type: "system", id: null };
}

/**
 * Delete the bindings (their tokens with them) and attempts the scopes select,
 * auditing each binding as disconnected for `reason`. The bindings' inbound
 * tags stay (a turn they triggered stays a WeChat turn) but lose their reply
 * context tokens: nothing can answer through them any more. Raft can only
 * forget the token: iLink has no revoke call (the owner turns ClawBot off in
 * WeChat).
 */
async function removeWeChatBridge(
  tx: DatabaseExecutor,
  scope: { bindings: SQL | undefined; attempts: SQL | undefined },
  audit: { reason: WeChatDisconnectReason; source: IntegrationAuditSource; actor: CleanupActor },
): Promise<number> {
  if (scope.attempts) await tx.delete(wechatBridgeAttempts).where(scope.attempts);
  if (!scope.bindings) return 0;
  const doomed = await tx.select({ id: wechatBridgeBindings.id }).from(wechatBridgeBindings).where(scope.bindings).for("update");
  if (doomed.length === 0) return 0;
  const ids = doomed.map((row) => row.id);
  // Before the delete: it sets the tags' binding_id to null.
  await tx.update(wechatBridgeInboundMessages).set({ contextToken: null }).where(inArray(wechatBridgeInboundMessages.bindingId, ids));
  const removed = await tx.delete(wechatBridgeBindings)
    .where(inArray(wechatBridgeBindings.id, ids))
    .returning({ id: wechatBridgeBindings.id, serverId: wechatBridgeBindings.serverId, userId: wechatBridgeBindings.userId, agentId: wechatBridgeBindings.agentId });
  // At most one binding per person per server (a server's: one per member).
  for (const binding of removed) {
    await recordIntegrationAuditEvent({
      serverId: binding.serverId,
      eventType: "assistant.wechat_disconnected",
      outcome: "success",
      source: audit.source,
      actor: audit.actor,
      subject: { type: "human", id: binding.userId },
      target: { type: "wechat_bridge_binding", id: binding.id },
      metadata: { agentId: binding.agentId, reason: audit.reason },
    }, tx);
  }
  return removed.length;
}

/**
 * The owner's Disconnect: their binding and attempts in this server. With
 * `bindingId` (a connected notice's, or the one Settings showed), only that
 * binding: a newer one is left alone ("changed"), so an earlier notice never
 * removes the connection made after it (Tenny, #12750).
 */
export async function disconnectWeChat(input: { serverId: string; userId: string; bindingId?: string }): Promise<"removed" | "not_connected" | "changed"> {
  return getDb().transaction(async (tx) => {
    if (input.bindingId !== undefined) {
      const [current] = await tx.select({ id: wechatBridgeBindings.id }).from(wechatBridgeBindings)
        .where(and(eq(wechatBridgeBindings.serverId, input.serverId), eq(wechatBridgeBindings.userId, input.userId)))
        .for("update").limit(1);
      if (!current) return "not_connected";
      if (current.id !== input.bindingId) return "changed";
    }
    const removed = await removeWeChatBridge(tx, {
      bindings: and(eq(wechatBridgeBindings.serverId, input.serverId), eq(wechatBridgeBindings.userId, input.userId)),
      attempts: and(eq(wechatBridgeAttempts.serverId, input.serverId), eq(wechatBridgeAttempts.userId, input.userId)),
    }, { reason: "user", source: "web", actor: { type: "human", id: input.userId } });
    return removed > 0 ? "removed" : "not_connected";
  });
}

/** Inside the membership removal: the departing person's binding and attempts in this server. */
export async function removeWeChatBridgeOfDepartingMember(
  tx: DatabaseExecutor,
  input: { serverId: string; userId: string; actorUserId: string | null },
): Promise<number> {
  return removeWeChatBridge(tx, {
    bindings: and(eq(wechatBridgeBindings.serverId, input.serverId), eq(wechatBridgeBindings.userId, input.userId)),
    attempts: and(eq(wechatBridgeAttempts.serverId, input.serverId), eq(wechatBridgeAttempts.userId, input.userId)),
  }, { reason: "owner_departed", source: "system", actor: actorOf(input.actorUserId) });
}

/** Inside the account deletion request: every binding and attempt of the person, in every server. */
export async function removeWeChatBridgeOfDeletedAccount(
  tx: DatabaseExecutor,
  input: { userId: string; actorUserId: string | null },
): Promise<number> {
  return removeWeChatBridge(tx, {
    bindings: eq(wechatBridgeBindings.userId, input.userId),
    attempts: eq(wechatBridgeAttempts.userId, input.userId),
  }, { reason: "account_deletion", source: "system", actor: actorOf(input.actorUserId) });
}

/**
 * Inside an agent's archive: the bindings to that assistant (its DM goes quiet
 * with it) and its owner's attempts in its server (a QR code scanned after
 * this would bind to no assistant).
 */
export async function removeWeChatBridgeOfArchivedAssistant(
  tx: DatabaseExecutor,
  input: { agentId: string; actorUserId: string },
): Promise<number> {
  const [agent] = await tx.select({ serverId: agents.serverId, ownerUserId: agents.assistantOwnerUserId })
    .from(agents).where(eq(agents.id, input.agentId)).limit(1);
  return removeWeChatBridge(tx, {
    bindings: eq(wechatBridgeBindings.agentId, input.agentId),
    attempts: agent?.ownerUserId
      ? and(eq(wechatBridgeAttempts.serverId, agent.serverId), eq(wechatBridgeAttempts.userId, agent.ownerUserId))
      : undefined,
  }, { reason: "assistant_archived", source: "system", actor: { type: "human", id: input.actorUserId } });
}

/**
 * Inside a server's soft delete: every binding and attempt in it. Its members
 * can no longer reach the server's routes (Disconnect included), so nothing
 * of theirs may keep mirroring.
 */
export async function removeWeChatBridgeOfDeletedServer(tx: DatabaseExecutor, input: { serverId: string }): Promise<number> {
  return removeWeChatBridge(tx, {
    bindings: eq(wechatBridgeBindings.serverId, input.serverId),
    attempts: eq(wechatBridgeAttempts.serverId, input.serverId),
  }, { reason: "server_deleted", source: "system", actor: { type: "system", id: null } });
}
