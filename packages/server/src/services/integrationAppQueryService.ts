import { and, asc, eq, gte, isNull, lt, or } from "drizzle-orm";
import {
  actionCardActionSchema,
  canonicalizeOAuthClientCategory,
  type AgentApiOwnedIntegrationApp,
} from "@botiverse/raft-shared";

import { getDb } from "../db/index.js";
import { actionCards, oauthClientMaintainers, oauthClients, serverAgentMembers } from "../db/schema.js";
import { isMessageShortId, UUID_RE, uuidShortIdRange } from "../lib/messageId.js";
import { oauthClientIsUserManagedPredicate } from "./oauthClientManagementPolicy.js";

const REGISTER_APP_ACTION = "integration:register_app";

function recoveryCommand(clientKey: string): string {
  return `raft integration app rotate-secret --client ${clientKey} --output <new-private-path>`;
}

function committedProjection(row: {
  id: string;
  name: string;
  description: string | null;
  clientKey: string;
  createdAt: Date;
  updatedAt: Date;
  homepageUrl: string | null;
  callbackUrl: string | null;
  agentManifestUrl: string | null;
  scopes: string[] | null;
  category: string;
  dataAccessSummary: string | null;
  logoUrl: string | null;
  appType: "server_local" | "slock_builtin" | "third_party_global";
  publishStatus: string;
  enabled: boolean;
  authority: "owner" | "admin";
}): AgentApiOwnedIntegrationApp {
  return {
    state: "committed",
    card: null,
    name: row.name,
    clientKey: row.clientKey,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    description: row.description,
    homepageUrl: row.homepageUrl,
    callbackUrl: row.callbackUrl,
    agentManifestUrl: row.agentManifestUrl,
    scopes: row.scopes ?? [],
    category: canonicalizeOAuthClientCategory(row.category) ?? "Other",
    dataAccessSummary: row.dataAccessSummary,
    logoUrl: row.logoUrl,
    appType: row.appType,
    publishStatus: row.publishStatus,
    enabled: row.enabled,
    authority: row.authority,
    recoveryCommand: recoveryCommand(row.clientKey),
  };
}

function pendingProjection(row: {
  messageId: string;
  payload: unknown;
  createdAt: Date;
}): AgentApiOwnedIntegrationApp | null {
  const parsed = actionCardActionSchema.safeParse(row.payload);
  if (!parsed.success || parsed.data.type !== REGISTER_APP_ACTION) return null;
  return {
    state: "card_pending",
    card: row.messageId,
    name: parsed.data.name,
    clientKey: parsed.data.clientKey ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: null,
    description: parsed.data.description ?? null,
    homepageUrl: parsed.data.homepageUrl ?? null,
    callbackUrl: parsed.data.returnUrl ?? null,
    agentManifestUrl: parsed.data.agentManifestUrl ?? null,
    scopes: parsed.data.scopes ?? [],
    category: parsed.data.category ?? null,
    dataAccessSummary: null,
    logoUrl: null,
    appType: null,
    publishStatus: null,
    enabled: null,
    authority: null,
    recoveryCommand: null,
  };
}

async function isAgentServerAdmin(serverId: string, agentId: string): Promise<boolean> {
  const [membership] = await getDb()
    .select({ role: serverAgentMembers.role })
    .from(serverAgentMembers)
    .where(and(
      eq(serverAgentMembers.serverId, serverId),
      eq(serverAgentMembers.agentId, agentId),
    ))
    .limit(1);
  return membership?.role === "admin";
}

const MANAGEABLE_APP_COLUMNS = {
  id: oauthClients.id,
  name: oauthClients.name,
  description: oauthClients.description,
  clientKey: oauthClients.clientId,
  createdAt: oauthClients.createdAt,
  updatedAt: oauthClients.updatedAt,
  homepageUrl: oauthClients.homepageUrl,
  callbackUrl: oauthClients.returnUrl,
  agentManifestUrl: oauthClients.agentManifestUrl,
  scopes: oauthClients.allowedScopes,
  category: oauthClients.category,
  dataAccessSummary: oauthClients.dataAccessSummary,
  logoUrl: oauthClients.logoUrl,
  appType: oauthClients.appType,
  publishStatus: oauthClients.publishStatus,
  enabled: oauthClients.enabled,
};

async function findOwnedCommittedApp(opts: {
  serverId: string;
  agentId: string;
  clientKey?: string;
  internalClientId?: string;
}): Promise<AgentApiOwnedIntegrationApp | null> {
  const admin = await isAgentServerAdmin(opts.serverId, opts.agentId);
  const conditions = [
    eq(oauthClients.serverId, opts.serverId),
    oauthClientIsUserManagedPredicate(),
    or(
      eq(oauthClients.appType, "server_local"),
      eq(oauthClients.appType, "third_party_global"),
    ),
  ];
  if (opts.clientKey) conditions.push(eq(oauthClients.clientId, opts.clientKey));
  if (opts.internalClientId) conditions.push(eq(oauthClients.id, opts.internalClientId));
  if (admin) {
    const [row] = await getDb()
      .select(MANAGEABLE_APP_COLUMNS)
      .from(oauthClients)
      .where(and(...conditions))
      .limit(1);
    return row ? committedProjection({ ...row, authority: "admin" }) : null;
  }
  const [row] = await getDb()
    .select(MANAGEABLE_APP_COLUMNS)
    .from(oauthClients)
    .innerJoin(oauthClientMaintainers, eq(oauthClientMaintainers.clientId, oauthClients.id))
    .where(and(
      ...conditions,
      eq(oauthClientMaintainers.principalType, "agent"),
      eq(oauthClientMaintainers.agentId, opts.agentId),
      eq(oauthClientMaintainers.role, "owner"),
      isNull(oauthClientMaintainers.revokedAt),
    ))
    .limit(1);
  return row ? committedProjection({ ...row, authority: "owner" }) : null;
}

export async function listAgentIntegrationApps(opts: {
  serverId: string;
  agentId: string;
}): Promise<AgentApiOwnedIntegrationApp[]> {
  const db = getDb();
  const admin = await isAgentServerAdmin(opts.serverId, opts.agentId);
  const pendingRows = await db
    .select({
      messageId: actionCards.messageId,
      payload: actionCards.payload,
      createdAt: actionCards.createdAt,
    })
    .from(actionCards)
    .where(and(
      eq(actionCards.serverId, opts.serverId),
      eq(actionCards.requesterAgentId, opts.agentId),
      eq(actionCards.actionType, REGISTER_APP_ACTION),
      eq(actionCards.state, "prepared"),
    ))
    .orderBy(asc(actionCards.createdAt));
  const committedRows = admin
    ? await db
      .select(MANAGEABLE_APP_COLUMNS)
      .from(oauthClients)
      .where(and(
        eq(oauthClients.serverId, opts.serverId),
        oauthClientIsUserManagedPredicate(),
        or(
          eq(oauthClients.appType, "server_local"),
          eq(oauthClients.appType, "third_party_global"),
        ),
      ))
      .orderBy(asc(oauthClients.createdAt))
    : await db
      .select(MANAGEABLE_APP_COLUMNS)
      .from(oauthClients)
      .innerJoin(oauthClientMaintainers, eq(oauthClientMaintainers.clientId, oauthClients.id))
      .where(and(
        eq(oauthClients.serverId, opts.serverId),
        oauthClientIsUserManagedPredicate(),
        or(
          eq(oauthClients.appType, "server_local"),
          eq(oauthClients.appType, "third_party_global"),
        ),
        eq(oauthClientMaintainers.principalType, "agent"),
        eq(oauthClientMaintainers.agentId, opts.agentId),
        eq(oauthClientMaintainers.role, "owner"),
        isNull(oauthClientMaintainers.revokedAt),
      ))
      .orderBy(asc(oauthClients.createdAt));

  return [
    ...pendingRows.map(pendingProjection).filter((item): item is AgentApiOwnedIntegrationApp => item !== null),
    ...committedRows.map((row) => committedProjection({ ...row, authority: admin ? "admin" : "owner" })),
  ];
}

export async function getAgentIntegrationAppByClient(opts: {
  serverId: string;
  agentId: string;
  clientKey: string;
}): Promise<AgentApiOwnedIntegrationApp | null> {
  return findOwnedCommittedApp(opts);
}

export async function getAgentIntegrationAppByCard(opts: {
  serverId: string;
  agentId: string;
  cardRef: string;
}): Promise<AgentApiOwnedIntegrationApp | null> {
  const cardRef = opts.cardRef.trim();
  if (!UUID_RE.test(cardRef) && !isMessageShortId(cardRef)) return null;
  const idConditions = UUID_RE.test(cardRef)
    ? [eq(actionCards.messageId, cardRef)]
    : (() => {
        const bounds = uuidShortIdRange(cardRef);
        return [
          gte(actionCards.messageId, bounds.lower),
          ...(bounds.upper ? [lt(actionCards.messageId, bounds.upper)] : []),
        ];
      })();
  const rows = await getDb()
    .select({
      messageId: actionCards.messageId,
      payload: actionCards.payload,
      state: actionCards.state,
      result: actionCards.result,
      createdAt: actionCards.createdAt,
    })
    .from(actionCards)
    .where(and(
      eq(actionCards.serverId, opts.serverId),
      eq(actionCards.requesterAgentId, opts.agentId),
      eq(actionCards.actionType, REGISTER_APP_ACTION),
      or(eq(actionCards.state, "prepared"), eq(actionCards.state, "executed")),
      ...idConditions,
    ))
    .limit(2);
  if (rows.length !== 1) return null;
  const row = rows[0];
  if (row.state === "prepared") return pendingProjection(row);

  const result = row.result;
  if (!result || typeof result !== "object") return null;
  const record = result as Record<string, unknown>;
  if (record.kind !== "integration-app-registration" || record.mode !== "register") return null;
  const internalClientId = typeof record.clientId === "string" ? record.clientId : null;
  if (!internalClientId) return null;
  const owned = await findOwnedCommittedApp({
    serverId: opts.serverId,
    agentId: opts.agentId,
    internalClientId,
  });
  if (owned) return { ...owned, card: row.messageId };

  const clientKey = typeof record.clientKey === "string" ? record.clientKey : null;
  const name = typeof record.clientName === "string" ? record.clientName : null;
  if (!clientKey || !name) return null;
  return {
    state: "committed",
    card: row.messageId,
    name,
    clientKey,
    createdAt: row.createdAt.toISOString(),
    callbackUrl: typeof record.returnUrl === "string" ? record.returnUrl : null,
    scopes: Array.isArray(record.scopes) ? record.scopes.filter((scope): scope is string => typeof scope === "string") : [],
    category: null,
    recoveryCommand: null,
  };
}
