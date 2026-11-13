import { createHmac } from "node:crypto";
import { projectCoarseServerPlan } from "./serverPlanProjection";
import { currentTimeMs } from "@botiverse/raft-shared";
import { and, eq, exists, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { getDb } from "../db/index";
import {
  agents,
  channels,
  computers,
  machines,
  oauthAccessTokens,
  oauthUserConsents,
  serverAgentMembers,
  serverMembers,
  servers,
  users,
} from "../db/schema";
import type { VerifiedAppInstallationCredential } from "./appInstallationCredentialService";
import type { AppOutboundGroup } from "./appOutboundPermissionService";
import { agentFindableBy, listedServerAgent } from "./agentMemberListPolicy";
import { userCanActOnAgentResource } from "../lib/actorPermissions";

const MEMBER_REF_KEY_ENV = "RAFT_APP_MEMBER_REF_KEY";
const MEMBER_REF_KEY_VERSION_ENV = "RAFT_APP_MEMBER_REF_KEY_VERSION";

let testMemberRefKey: Buffer | null = null;

export class AppOutboundProjectionError extends Error {}

export function __setAppMemberRefKeyForTests(key: Buffer | null) {
  testMemberRefKey = key;
}

function memberRefKey(): Buffer {
  if (testMemberRefKey) return testMemberRefKey;
  const raw = process.env[MEMBER_REF_KEY_ENV]?.trim();
  if (!raw) throw new AppOutboundProjectionError(`${MEMBER_REF_KEY_ENV} is required`);
  const key = /^[0-9a-f]{64,}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length < 32) throw new AppOutboundProjectionError(`${MEMBER_REF_KEY_ENV} must decode to at least 32 bytes`);
  return key;
}

function memberRefKeyVersion(): number {
  const version = Number(process.env[MEMBER_REF_KEY_VERSION_ENV] ?? "1");
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new AppOutboundProjectionError(`${MEMBER_REF_KEY_VERSION_ENV} must be a positive integer`);
  }
  return version;
}

function lengthPrefixed(parts: readonly string[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const value = Buffer.from(part, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(value.length);
    chunks.push(length, value);
  }
  return Buffer.concat(chunks);
}

export function deriveAppMemberRef(input: {
  clientId: string;
  installationId: string;
  principalId: string;
}): { member_ref: string; key_version: number } {
  const keyVersion = memberRefKeyVersion();
  const memberRef = createHmac("sha256", memberRefKey())
    .update(lengthPrefixed([String(keyVersion), input.clientId, input.installationId, input.principalId]))
    .digest("base64url");
  return { member_ref: memberRef, key_version: keyVersion };
}

function requireGroup(credential: VerifiedAppInstallationCredential, group: AppOutboundGroup) {
  if (!credential.groups.includes(group)) {
    throw new AppOutboundProjectionError(`Installation credential lacks ${group} read authority`);
  }
}

const planProjection = projectCoarseServerPlan;

export async function getAppServerProjection(
  credential: VerifiedAppInstallationCredential,
  dbOrTx: ReturnType<typeof getDb> = getDb(),
) {
  requireGroup(credential, "server");
  const [server] = await dbOrTx.select({
    id: servers.id,
    name: servers.name,
    slug: servers.slug,
    avatarUrl: servers.avatarUrl,
    createdAt: servers.createdAt,
    plan: servers.plan,
    translationEnabled: servers.translationEnabled,
    agentAllChannelGreetingEnabled: servers.agentAllChannelGreetingEnabled,
  }).from(servers).where(and(
    eq(servers.id, credential.serverId),
    isNull(servers.deletedAt),
  )).limit(1);
  if (!server) return null;

  const [humanMembers, agentMembers] = await Promise.all([
    // A retired (deleted) account keeps its membership row for history; to an
    // app it is gone, as the server.member_removed it was sent says.
    dbOrTx.select({ principalId: serverMembers.userId, role: serverMembers.role })
      .from(serverMembers)
      .innerJoin(users, eq(users.id, serverMembers.userId))
      .where(and(eq(serverMembers.serverId, credential.serverId), isNull(users.retiredAt))),
    // Not a personal assistant: an App never finds one (agentFindableBy with no
    // finder), as the server.member_* events never name one.
    dbOrTx.select({ principalId: serverAgentMembers.agentId, role: serverAgentMembers.role })
      .from(serverAgentMembers)
      .innerJoin(agents, eq(agents.id, serverAgentMembers.agentId))
      .where(and(eq(serverAgentMembers.serverId, credential.serverId), agentFindableBy({}))),
  ]);
  const members = [
    ...humanMembers.map((member) => ({ principal_type: "human" as const, ...member })),
    ...agentMembers.map((member) => ({ principal_type: "agent" as const, ...member })),
  ].map((member) => ({
    ...deriveAppMemberRef({
      clientId: credential.clientId,
      installationId: credential.installationId,
      principalId: member.principalId,
    }),
    principal_type: member.principal_type,
    role: member.role,
    membership_state: "active" as const,
  }));
  return {
    id: server.id,
    name: server.name,
    slug: server.slug,
    avatar_url: server.avatarUrl,
    created_at: server.createdAt,
    config: {
      translation_enabled: server.translationEnabled,
      agent_all_channel_greeting_enabled: server.agentAllChannelGreetingEnabled,
    },
    ...planProjection(server.plan),
    members,
  };
}

// A human's role for an installation, only after a real Login with Raft to
// this App. A preview-only consent is not a login. Expired login tokens still
// witness that login; explicit revocation marks every token revoked and also
// revokes consent. Account-mode login has no Server, but only reaches a live
// non-guest member on this installation's Server. The transaction passed by the
// route also checked the installation and its effective server group.
export async function getAppHumanMemberRole(
  credential: VerifiedAppInstallationCredential,
  sub: string,
  dbOrTx: ReturnType<typeof getDb> = getDb(),
): Promise<{ role: "owner" | "admin" | "member" | "guest" } | null> {
  requireGroup(credential, "server");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sub)) return null;
  const login = dbOrTx.select({ one: sql`1` }).from(oauthAccessTokens).where(and(
    eq(oauthAccessTokens.clientId, credential.clientId),
    eq(oauthAccessTokens.userId, serverMembers.userId),
    eq(oauthAccessTokens.principalType, "human"),
    isNull(oauthAccessTokens.revokedAt),
    or(
      and(eq(oauthUserConsents.serverId, credential.serverId), eq(oauthAccessTokens.serverId, credential.serverId)),
      and(isNull(oauthUserConsents.serverId), isNull(oauthAccessTokens.serverId), ne(serverMembers.role, "guest")),
    ),
  ));
  const [member] = await dbOrTx.select({ role: serverMembers.role }).from(serverMembers)
    .innerJoin(users, eq(users.id, serverMembers.userId))
    .innerJoin(servers, eq(servers.id, serverMembers.serverId))
    .innerJoin(oauthUserConsents, and(
      eq(oauthUserConsents.userId, serverMembers.userId),
      eq(oauthUserConsents.clientId, credential.clientId),
      isNull(oauthUserConsents.revokedAt),
    ))
    .where(and(
      eq(serverMembers.serverId, credential.serverId),
      eq(serverMembers.userId, sub),
      isNull(users.retiredAt),
      isNull(servers.deletedAt),
      ne(servers.kind, "joint_storage"),
      exists(login),
    )).limit(1);
  return member ?? null;
}

// This exposes only a yes/no decision for directory-visible Agents, not their
// creator or assistant owner. Use the same editAgents decision as Raft's agent
// settings routes, and the same snapshot as the human's role/consent lookup.
export async function canAppHumanManageAgent(
  credential: VerifiedAppInstallationCredential,
  sub: string,
  agentId: string,
  dbOrTx: ReturnType<typeof getDb> = getDb(),
): Promise<boolean> {
  requireGroup(credential, "agent");
  const member = await getAppHumanMemberRole(credential, sub, dbOrTx);
  if (!member || member.role === "guest") return false;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agentId)) return false;
  const [agent] = await dbOrTx.select({
    creatorType: agents.creatorType,
    creatorId: agents.creatorId,
    assistantOwnerUserId: agents.assistantOwnerUserId,
  }).from(agents).where(and(
    eq(agents.id, agentId),
    eq(agents.serverId, credential.serverId),
    isNull(agents.deletedAt),
    listedServerAgent(),
  )).limit(1);
  return !!agent && userCanActOnAgentResource(member.role, sub.toLowerCase(), agent, "editAgents");
}

export async function listAppAgentProjections(
  credential: VerifiedAppInstallationCredential,
  dbOrTx: ReturnType<typeof getDb> = getDb(),
) {
  requireGroup(credential, "agent");
  return dbOrTx.select({
    id: agents.id,
    handle: agents.name,
    display_name: agents.displayName,
    avatar_url: agents.avatarUrl,
    description: agents.description,
    status: agents.status,
    runtime: agents.runtime,
    model: agents.model,
    execution_mode: agents.executionMode,
    // Coarse classification only: never expose the managing installation id.
    is_app_bot: sql<boolean>`${agents.managedByAppInstallId} IS NOT NULL`,
    created_at: agents.createdAt,
    updated_at: agents.updatedAt,
  }).from(agents).where(and(
    eq(agents.serverId, credential.serverId),
    isNull(agents.deletedAt),
    // The agents a member list shows: an App never finds a personal assistant.
    listedServerAgent(),
  ));
}

export async function listAppPublicChannelProjections(
  credential: VerifiedAppInstallationCredential,
  dbOrTx: ReturnType<typeof getDb> = getDb(),
) {
  requireGroup(credential, "channel");
  return dbOrTx.select({
    id: channels.id,
    name: channels.name,
    type: channels.type,
    description: channels.description,
    archived_at: channels.archivedAt,
    created_at: channels.createdAt,
  }).from(channels).where(and(
    eq(channels.serverId, credential.serverId),
    eq(channels.type, "channel"),
    isNull(channels.deletedAt),
  ));
}

export async function listAppComputerProjections(
  credential: VerifiedAppInstallationCredential,
  dbOrTx: ReturnType<typeof getDb> = getDb(),
) {
  requireGroup(credential, "computer");
  const rows = await dbOrTx.select({
    id: computers.id,
    name: computers.name,
    machineId: computers.machineId,
    os: machines.os,
    daemonVersion: machines.daemonVersion,
    lastHeartbeat: machines.lastHeartbeat,
  }).from(computers)
    .leftJoin(machines, eq(machines.id, computers.machineId))
    .where(and(
      eq(computers.serverId, credential.serverId),
      isNull(computers.revokedAt),
    ));
  const machineIds = rows.flatMap((row) => row.machineId ? [row.machineId] : []);
  const hostedAgents = machineIds.length === 0
    ? []
    : await dbOrTx.select({ id: agents.id, machineId: agents.machineId })
      .from(agents).where(and(
        eq(agents.serverId, credential.serverId),
        inArray(agents.machineId, machineIds),
        isNull(agents.deletedAt),
        // Not a personal assistant, in the ids or the count: an App never finds
        // one (agentFindableBy with no finder, as countActiveAgentsByMachine).
        agentFindableBy({}),
      ));
  const includeAgentIdentities = credential.groups.includes("agent");
  const onlineAfter = currentTimeMs() - 90_000;
  return rows.map((row) => {
    const hosted = hostedAgents.filter((agent) => agent.machineId === row.machineId);
    return {
      id: row.id,
      name: row.name,
      os: row.os,
      status: row.lastHeartbeat && row.lastHeartbeat.getTime() >= onlineAfter ? "online" : "offline",
      daemon_version: row.daemonVersion,
      hosted_agent_count: hosted.length,
      ...(includeAgentIdentities ? { hosted_agent_ids: hosted.map((agent) => agent.id) } : {}),
    };
  });
}
