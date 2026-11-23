/**
 * Notices about members' own MCP accounts (RFC 087 §6, §7.3; Tenny's guard on O6 option B).
 *
 * - A member gives their personal Connection to an Agent that is not their own (not created by
 *   them, not their personal assistant): the Agent's owner (its creator, or a personal assistant's
 *   owner) and the Server's owners and admins are told, naming the member, the App and the Agent.
 *   It takes effect at once; nobody confirms it (R7).
 * - The grant replaced another member's (a move): that member is told too.
 * - An admin deletes someone else's personal Connection (revoke, D5): its owner is told.
 *
 * Same delivery as managedMcpSignInNotice.ts / managedMcpSignedInBy.ts: `system_notice` outbox rows,
 * plain English with no copy key, after the write committed, best effort (never throws). The person
 * who acted is never told about their own act. A grant notice's event key is stable per Connection and
 * Agent (a move's per previous Connection, Agent and new Connection), so the outbox's
 * (receiver_id, event_key) uniqueness sends it once: giving, taking back and giving again the same
 * Agent does not tell the admins again.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../db/index";
import { agents, managedMcpServers, serverMembers, servers, users } from "../db/schema";
import { serverRolesWithCapability } from "../lib/actorPermissions";
import { addTraceEvent } from "../tracing/semanticTrace";
import { serializeErrorForLog } from "../tracing/safeErrorLog";
import { mcpAgentOwnerUserId, type McpAgentOwnerFacts } from "./managedMcpConnectionOwnership";
import { oneLine } from "./managedMcpSignInNotice";
import { enqueueNotificationRows } from "./notifications/enqueue";
import type { NotificationNoticePayload } from "./notifications/envelope";

/** One Agent a personal grant was written on, as the write saw it. */
export interface PersonalGrantNoticeItem {
  agentId: string;
  /** The member whose personal Connection the Agent used before, when this grant replaced it (a move). */
  previousOwnerUserId: string | null;
  /** That Connection, for a move. */
  previousConnectionId: string | null;
}

export interface PersonalGrantNotice {
  serverId: string;
  appId: string;
  /** The member who gave their account (the Connection's owner). */
  granterUserId: string;
  /** The personal Connection given. */
  connectionId: string;
  items: PersonalGrantNoticeItem[];
}

type Notice = { receiverId: string; eventKey: string; title: string; body: string };

async function enqueueNotices(serverId: string, notices: Notice[]): Promise<number> {
  if (notices.length === 0) return 0;
  const now = new Date();
  const inserted = await enqueueNotificationRows(notices.map((notice) => {
    const payload: NotificationNoticePayload = {
      title: notice.title,
      body: notice.body,
      kind: "mention",
      event: "system_notice",
      route: { type: "channel", serverId, channelId: "", messageId: null },
      opensActivity: true,
    };
    return {
      receiverId: notice.receiverId,
      serverId,
      kind: null,
      sourceChannelId: null,
      messageId: null,
      messageSeq: null,
      activityAt: now,
      personalMention: true,
      // (receiver_id, event_key) is unique: a repeat of the same operation inserts nothing.
      eventKey: notice.eventKey,
      category: "system_notice" as const,
      payload: payload as unknown as Record<string, unknown>,
    };
  }));
  return inserted.length;
}

/** The Server's owners and admins: who manages its shared accounts (`manageExternalAuth`). */
async function serverAdmins(serverId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ userId: serverMembers.userId })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), inArray(serverMembers.role, serverRolesWithCapability("manageExternalAuth"))));
  return rows.map((row) => row.userId);
}

async function names(serverId: string, appId: string, userIds: string[]) {
  const [app] = await getDb()
    .select({ name: managedMcpServers.name, serverName: servers.name })
    .from(managedMcpServers)
    .innerJoin(servers, eq(servers.id, managedMcpServers.serverId))
    .where(and(eq(managedMcpServers.id, appId), eq(managedMcpServers.serverId, serverId)))
    .limit(1);
  const people = userIds.length === 0 ? [] : await getDb()
    .select({ id: users.id, name: users.name, displayName: users.displayName })
    .from(users)
    .where(inArray(users.id, userIds));
  const personName = new Map(people.map((person) => [person.id, oneLine(person.displayName || person.name, 60)]));
  return {
    appName: app ? oneLine(app.name, 80) : null,
    serverName: app ? oneLine(app.serverName, 80) : null,
    person: (userId: string) => personName.get(userId) ?? "Someone",
  };
}

/** Whether the Agent is the member's own: created by them, or their personal assistant. */
export function isMembersOwnAgent(
  agent: McpAgentOwnerFacts,
  userId: string,
): boolean {
  return mcpAgentOwnerUserId(agent) === userId;
}

/** The notices for one personal-grant write. After commit; never throws. */
export async function notifyPersonalGrants(input: PersonalGrantNotice): Promise<void> {
  const trace = (outcome: "none" | "sent" | "failed", recipients: number) =>
    addTraceEvent("server.managed_mcp.personal_grant_notice", { outcome, recipient_count: recipients, agent_count: input.items.length });
  try {
    if (input.items.length === 0) {
      trace("none", 0);
      return;
    }
    const agentRows = await getDb()
      .select({
        id: agents.id,
        name: agents.name,
        displayName: agents.displayName,
        creatorType: agents.creatorType,
        creatorId: agents.creatorId,
        assistantOwnerUserId: agents.assistantOwnerUserId,
      })
      .from(agents)
      .where(and(eq(agents.serverId, input.serverId), inArray(agents.id, input.items.map((item) => item.agentId))));
    const agentById = new Map(agentRows.map((agent) => [agent.id, agent]));
    const admins = await serverAdmins(input.serverId);
    const people = new Set<string>([input.granterUserId]);
    for (const item of input.items) if (item.previousOwnerUserId) people.add(item.previousOwnerUserId);
    const named = await names(input.serverId, input.appId, [...people]);
    if (!named.appName) {
      trace("none", 0);
      return;
    }
    const member = named.person(input.granterUserId);
    const notices: Notice[] = [];
    for (const item of input.items) {
      const agent = agentById.get(item.agentId);
      if (!agent) continue;
      const agentName = oneLine(agent.displayName || agent.name, 60);
      const key = `mcp_personal_grant:${input.connectionId}:${item.agentId}`;
      const told = new Set<string>([input.granterUserId]);
      if (!isMembersOwnAgent(agent, input.granterUserId)) {
        const agentOwner = mcpAgentOwnerUserId(agent);
        const receivers = [...(agentOwner ? [agentOwner] : []), ...admins];
        for (const receiverId of receivers) {
          if (told.has(receiverId)) continue;
          told.add(receiverId);
          notices.push({
            receiverId,
            eventKey: key,
            title: `${member} gave ${agentName} their own ${named.appName} account`,
            body: `On ${named.serverName}, ${agentName} now uses ${member}'s own ${named.appName} account: it acts as ${member} in ${named.appName} for everyone who talks to it. Settings › Apps › ${named.appName}.`,
          });
        }
      }
      if (item.previousOwnerUserId && !told.has(item.previousOwnerUserId)) {
        notices.push({
          receiverId: item.previousOwnerUserId,
          eventKey: `mcp_personal_grant_moved:${item.previousConnectionId ?? "none"}:${item.agentId}:${input.connectionId}`,
          title: `${agentName} no longer uses your ${named.appName} account`,
          body: `On ${named.serverName}, ${member} gave ${agentName} their own ${named.appName} account in place of yours. Settings › Apps › ${named.appName}.`,
        });
      }
    }
    trace(notices.length > 0 ? "sent" : "none", await enqueueNotices(input.serverId, notices));
  } catch (error) {
    trace("failed", 0);
    console.error("[managed-mcp] personal grant notice failed:", serializeErrorForLog(error));
  }
}

/**
 * An admin deleted (`removed`) or signed out (`signed_out`) a member's personal Connection: the owner
 * is told. After commit; never throws.
 */
export async function notifyPersonalConnectionRevoked(input: {
  serverId: string;
  appId: string;
  connectionId: string;
  ownerUserId: string;
  revokerUserId: string;
  agentCount: number;
  action?: "removed" | "signed_out";
}): Promise<void> {
  try {
    if (input.ownerUserId === input.revokerUserId) return;
    const named = await names(input.serverId, input.appId, [input.revokerUserId]);
    if (!named.appName) return;
    const admin = named.person(input.revokerUserId);
    const agentsLine = input.agentCount > 0
      ? ` The ${input.agentCount === 1 ? "agent" : `${input.agentCount} agents`} you gave it to now use${input.agentCount === 1 ? "s" : ""} the shared account, if they have one.`
      : "";
    const signedOut = input.action === "signed_out";
    const inserted = await enqueueNotices(input.serverId, [signedOut
      ? {
        receiverId: input.ownerUserId,
        // A Connection can be signed out again after its owner signs it back in: one key per sign-out.
        eventKey: `mcp_personal_signed_out:${input.connectionId}:${randomUUID()}`,
        title: `${admin} signed out your ${named.appName} account`,
        body: `${admin} signed out the ${named.appName} account you connected on ${named.serverName}. Sign in again to use it.${agentsLine}`,
      }
      : {
        receiverId: input.ownerUserId,
        eventKey: `mcp_personal_revoked:${input.connectionId}`,
        title: `${admin} removed your ${named.appName} account`,
        body: `${admin} removed the ${named.appName} account you connected on ${named.serverName}.${agentsLine}`,
      }]);
    addTraceEvent("server.managed_mcp.personal_revoked_notice", { outcome: inserted > 0 ? "sent" : "duplicate" });
  } catch (error) {
    addTraceEvent("server.managed_mcp.personal_revoked_notice", { outcome: "failed" });
    console.error("[managed-mcp] personal revoke notice failed:", serializeErrorForLog(error));
  }
}
