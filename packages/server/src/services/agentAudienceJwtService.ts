import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { currentDate } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agents, oauthClients, oauthClientInstalls, oauthGrants, oauthAgentAutoGrantBlocks, serverAgentMembers, servers } from "../db/schema";
import { oidcIssuer, signAgentAccessJwt } from "./oidcService";
import { recordIntegrationAuditEvent } from "./integrationAuditService";
import { agentJwtIssuanceCounter } from "../metrics";

import { oauthClientIsUserManagedPredicate } from "./oauthClientManagementPolicy";
import { oauthClientHasKey } from "./oauthClientKeys";

export type AgentJwtDenialReason = "agent_unavailable" | "membership_missing" | "app_unavailable" | "installation_unavailable" | "scope_not_approved" | "grant_revoked";
export class AgentAudienceJwtError extends Error {
  readonly code = "AGENT_JWT_NOT_AUTHORIZED" as const;
  constructor(readonly reason: AgentJwtDenialReason = "app_unavailable") {
    super("AGENT_JWT_NOT_AUTHORIZED");
  }
}

const scopes = ["openid", "profile"];

export async function issueAgentAudienceJwt(input: { serverId: string; agentId: string; service: string }) {
  let metricClient = "unknown";
  try {
    const issued = await getDb().transaction(async (tx) => {
      const [server] = await tx.select({ id: servers.id, slug: servers.slug }).from(servers).where(and(
        eq(servers.id, input.serverId), isNull(servers.deletedAt),
      )).for("share");
      const [agent] = await tx.select({ id: agents.id, name: agents.name, displayName: agents.displayName, status: agents.status }).from(agents).where(and(
        eq(agents.id, input.agentId), eq(agents.serverId, input.serverId), isNull(agents.deletedAt),
      )).for("share");
      const [membership] = await tx.select({ role: serverAgentMembers.role }).from(serverAgentMembers).where(and(
        eq(serverAgentMembers.serverId, input.serverId), eq(serverAgentMembers.agentId, input.agentId),
      )).for("share");
      if (!server || !agent || agent.status === "stopped" || !membership) {
        throw new AgentAudienceJwtError(!membership ? "membership_missing" : "agent_unavailable");
      }
      // Serialize first-use grant creation and client disable/scope contraction.
      // App and installation changes take the same row locks before commit.
      const [client] = await tx.select({ id: oauthClients.id, serverId: oauthClients.serverId, appType: oauthClients.appType, clientId: oauthClients.clientId, allowedScopes: oauthClients.allowedScopes, createdByUserId: oauthClients.createdByUserId }).from(oauthClients).where(and(
        oauthClientHasKey(input.service), oauthClientIsUserManagedPredicate(), eq(oauthClients.enabled, true),
      )).for("update");
      if (!client || !scopes.every((scope) => client.allowedScopes?.includes(scope))) {
        throw new AgentAudienceJwtError();
      }
      const source = client.serverId === server.id;
      const [installation] = await tx.select({
        id: oauthClientInstalls.id, status: oauthClientInstalls.status, approvedScopes: oauthClientInstalls.approvedScopes,
      }).from(oauthClientInstalls).where(and(
        eq(oauthClientInstalls.clientId, client.id), eq(oauthClientInstalls.serverId, server.id),
      )).for("share");
      if ((client.appType === "server_local" && !source)
        || (client.appType === "third_party_global" && (!installation || installation.status !== "active"))
        || (installation && installation.status !== "active")) {
        throw new AgentAudienceJwtError("installation_unavailable");
      }
      // A third-party app's login scopes count only once its installer
      // approved them; ones the developer added later wait (task #2, #proj-apps).
      if (client.appType === "third_party_global" && !scopes.every((scope) => installation?.approvedScopes.includes(scope))) {
        throw new AgentAudienceJwtError("scope_not_approved");
      }
      // Unavailable private Apps share the unknown-App refusal. JWT is a
      // built-in Agent Login credential: no per-App or per-installation switch.
      metricClient = client.clientId;
      const grants = await tx.select({ id: oauthGrants.id, scopes: oauthGrants.scopes, revokedAt: oauthGrants.revokedAt }).from(oauthGrants).where(and(
        eq(oauthGrants.serverId, server.id), eq(oauthGrants.agentId, agent.id), eq(oauthGrants.clientId, client.id),
      )).for("update");
      let grant = grants.find((candidate) => candidate.revokedAt === null && scopes.every((scope) => candidate.scopes.includes(scope)));
      if (!grant) {
        // Never silently resurrect explicitly revoked authority. A
        // person must explicitly regrant access before a later retry.
        const [blocked] = await tx.select({ agentId: oauthAgentAutoGrantBlocks.agentId })
          .from(oauthAgentAutoGrantBlocks).where(and(
            eq(oauthAgentAutoGrantBlocks.agentId, agent.id),
            eq(oauthAgentAutoGrantBlocks.clientId, client.id),
            eq(oauthAgentAutoGrantBlocks.serverId, server.id),
          )).limit(1).for("share");
        if (blocked || grants.some((candidate) => candidate.revokedAt !== null)) {
          throw new AgentAudienceJwtError("grant_revoked");
        }
        // The Agent explicitly requested this App, which its Server owns or
        // installed. Same boundary as Agent Login, without an unused OAuth code.
        [grant] = await tx.insert(oauthGrants).values({
          serverId: server.id, agentId: agent.id, clientId: client.id,
          scopes, grantedByUserId: client.createdByUserId, grantSource: "agent_login",
        }).returning();
      }
      const now = currentDate();
      const jti = randomUUID();
      const token = signAgentAccessJwt({
        issuer: oidcIssuer(undefined, server.slug),
        // RFC 084 §4: the id the agent asked for (the lookup above made it one of this App's).
        agentId: agent.id, clientId: input.service, serverId: server.id,
        serverSlug: server.slug, serverRole: membership.role,
        agentName: agent.name, displayName: agent.displayName ?? agent.name,
        jti, now,
      });
      const expiresAt = new Date((Math.floor(now.getTime() / 1000) + 300) * 1000).toISOString();
      // The ambient transaction keeps the audit and first-use grant atomic.
      // Fail closed if the audit cannot be persisted; never store the JWT itself.
      await recordIntegrationAuditEvent({
        serverId: server.id, clientId: client.id,
        eventType: "agent.jwt_issued", outcome: "success", source: "cli",
        actor: { type: "agent", id: agent.id },
        subject: { type: "agent", id: agent.id },
        target: { type: "oauth_grant", id: grant.id },
        metadata: { clientKey: client.clientId, grantId: grant.id, jti, expiresAt },
      });
      return { access_token: token, token_type: "Bearer" as const, audience: input.service, expires_in: 300 as const, expires_at: expiresAt };
    });
    agentJwtIssuanceCounter.inc({ client_id: metricClient, outcome: "issued", reason: "none" });
    return issued;
  } catch (error) {
    agentJwtIssuanceCounter.inc({
      client_id: metricClient,
      outcome: error instanceof AgentAudienceJwtError ? "denied" : "error",
      reason: error instanceof AgentAudienceJwtError ? error.reason : "internal_error",
    });
    throw error;
  }
}
