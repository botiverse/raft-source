import { createHash, randomBytes } from "node:crypto";
import { currentDate } from "@botiverse/raft-shared";
import { and, eq, gt, isNull } from "drizzle-orm";
import { getDb } from "../db/index.js";
import {
  oauthAppInstallationTokens,
  oauthClientInstalls,
  oauthClients,
} from "../db/schema.js";
import * as integrationAuditService from "./integrationAuditService.js";
import {
  computeEffectiveAppOutboundAuthority,
  normalizeAppOutboundGroups,
  type AppOutboundGroup,
  AppOutboundPermissionError,
} from "./appOutboundPermissionService.js";

export const APP_INSTALLATION_TOKEN_AUDIENCE = "raft:app-installation-api";
export const APP_INSTALLATION_TOKEN_TTL_MS = 10 * 60 * 1000;
const TOKEN_PREFIX = "raft_installation_";

function hashInstallationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function generateInstallationToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

function difference(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value));
}

export type VerifiedAppInstallationCredential = {
  tokenId: string;
  installationId: string;
  clientId: string;
  serverId: string;
  grantRevision: number;
  groups: AppOutboundGroup[];
  audience: string;
  expiresAt: Date;
};

export async function mintAppInstallationCredential(input: {
  clientId: string;
  installationId: string;
  requestedGroups?: unknown;
  audience?: string;
}, dbOrTx: ReturnType<typeof getDb> = getDb()) {
  const audience = input.audience ?? APP_INSTALLATION_TOKEN_AUDIENCE;
  if (audience !== APP_INSTALLATION_TOKEN_AUDIENCE) {
    throw new AppOutboundPermissionError("Unsupported installation credential audience");
  }

  return dbOrTx.transaction(async (tx) => {
    const [row] = await tx.select({
      installation: oauthClientInstalls,
      clientKey: oauthClients.clientId,
      clientEnabled: oauthClients.enabled,
      currentGroups: oauthClients.outboundCurrentGroups,
      currentEvents: oauthClients.outboundCurrentEvents,
    }).from(oauthClientInstalls)
      .innerJoin(oauthClients, eq(oauthClients.id, oauthClientInstalls.clientId))
      .where(and(
        eq(oauthClientInstalls.id, input.installationId),
        eq(oauthClientInstalls.clientId, input.clientId),
      ))
      .limit(1)
      .for("update");
    if (!row || row.installation.status !== "active" || !row.clientEnabled) return null;

    const effective = computeEffectiveAppOutboundAuthority({
      currentGroups: row.currentGroups,
      currentEvents: row.currentEvents,
      approvedGroups: row.installation.approvedGroups,
      subscribedEvents: row.installation.subscribedEvents,
    });
    const groups = input.requestedGroups === undefined
      ? effective.groups
      : normalizeAppOutboundGroups(input.requestedGroups);
    if (difference(groups, effective.groups).length > 0) {
      throw new AppOutboundPermissionError("Requested credential groups exceed effective installation authority");
    }
    if (groups.length === 0) {
      throw new AppOutboundPermissionError("Installation has no effective read groups");
    }

    const token = generateInstallationToken();
    const expiresAt = new Date(currentDate().getTime() + APP_INSTALLATION_TOKEN_TTL_MS);
    const [created] = await tx.insert(oauthAppInstallationTokens).values({
      installationId: row.installation.id,
      clientId: row.installation.clientId,
      serverId: row.installation.serverId,
      tokenHash: hashInstallationToken(token),
      grantRevision: row.installation.grantRevision,
      effectiveGroups: groups,
      audience,
      expiresAt,
    }).returning({ id: oauthAppInstallationTokens.id });

    await integrationAuditService.recordIntegrationAuditEvent({
      serverId: row.installation.serverId,
      clientId: row.installation.clientId,
      eventType: "installation.token_issued",
      outcome: "success",
      source: "api",
      actor: { type: "system" },
      requester: { type: "app", id: row.installation.clientId },
      subject: { type: "app", id: row.installation.clientId },
      target: { type: "installation", id: row.installation.id },
      metadata: {
        clientKey: row.clientKey,
        installationId: row.installation.id,
        grantRevision: row.installation.grantRevision,
        audience,
        expiresAt: expiresAt.toISOString(),
      },
    }, tx);

    return {
      token,
      tokenType: "Bearer" as const,
      expiresIn: Math.floor(APP_INSTALLATION_TOKEN_TTL_MS / 1000),
      expiresAt,
      installationId: row.installation.id,
      serverId: row.installation.serverId,
      grantRevision: row.installation.grantRevision,
      groups,
      audience,
      tokenId: created.id,
    };
  });
}

export async function verifyAppInstallationCredential(
  token: string,
  audience = APP_INSTALLATION_TOKEN_AUDIENCE,
  dbOrTx: ReturnType<typeof getDb> = getDb(),
): Promise<VerifiedAppInstallationCredential | null> {
  if (!token.startsWith(TOKEN_PREFIX) || token.length <= TOKEN_PREFIX.length) return null;
  const now = currentDate();
  const [row] = await dbOrTx.select({
    tokenId: oauthAppInstallationTokens.id,
    installationId: oauthAppInstallationTokens.installationId,
    tokenClientId: oauthAppInstallationTokens.clientId,
    tokenServerId: oauthAppInstallationTokens.serverId,
    tokenGrantRevision: oauthAppInstallationTokens.grantRevision,
    tokenGroups: oauthAppInstallationTokens.effectiveGroups,
    tokenAudience: oauthAppInstallationTokens.audience,
    expiresAt: oauthAppInstallationTokens.expiresAt,
    installClientId: oauthClientInstalls.clientId,
    installServerId: oauthClientInstalls.serverId,
    installStatus: oauthClientInstalls.status,
    installGrantRevision: oauthClientInstalls.grantRevision,
    approvedGroups: oauthClientInstalls.approvedGroups,
    subscribedEvents: oauthClientInstalls.subscribedEvents,
    clientEnabled: oauthClients.enabled,
    currentGroups: oauthClients.outboundCurrentGroups,
    currentEvents: oauthClients.outboundCurrentEvents,
  }).from(oauthAppInstallationTokens)
    .innerJoin(oauthClientInstalls, eq(oauthClientInstalls.id, oauthAppInstallationTokens.installationId))
    .innerJoin(oauthClients, eq(oauthClients.id, oauthClientInstalls.clientId))
    .where(and(
      eq(oauthAppInstallationTokens.tokenHash, hashInstallationToken(token)),
      eq(oauthAppInstallationTokens.audience, audience),
      isNull(oauthAppInstallationTokens.revokedAt),
      gt(oauthAppInstallationTokens.expiresAt, now),
    ))
    .limit(1);
  if (!row || !row.clientEnabled || row.installStatus !== "active") return null;
  if (row.tokenClientId !== row.installClientId || row.tokenServerId !== row.installServerId) return null;
  if (row.tokenGrantRevision !== row.installGrantRevision) return null;

  const current = computeEffectiveAppOutboundAuthority({
    currentGroups: row.currentGroups,
    currentEvents: row.currentEvents,
    approvedGroups: row.approvedGroups,
    subscribedEvents: row.subscribedEvents,
  });
  if (difference(row.tokenGroups, current.groups).length > 0) return null;
  return {
    tokenId: row.tokenId,
    installationId: row.installationId,
    clientId: row.tokenClientId,
    serverId: row.tokenServerId,
    grantRevision: row.tokenGrantRevision,
    groups: row.tokenGroups as AppOutboundGroup[],
    audience: row.tokenAudience,
    expiresAt: row.expiresAt,
  };
}
