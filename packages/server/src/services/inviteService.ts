import { and, count, eq, isNull, sql } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { PLAN_CONFIG, formatBillingCapacityLimitMessage, getBillingCapacityLimitState, validateEmailAddress } from "@botiverse/raft-shared";
import { getDb } from "../db/index.js";
import { agents, serverInvites, serverJoinLinks, serverMembers, servers, users } from "../db/schema.js";
import { sendInviteEmail } from "./emailService.js";
import { normalizeEmail } from "./emailNormalization.js";
import * as serverService from "./serverService.js";
import * as serverAgreementService from "./serverAgreementService.js";
import { refreshSubscriptionForServerIfStale } from "./billingService.js";
import {
  assertHumanCapacityAvailable,
  getServerBillingEntitlement,
  getServerBillingUsage,
} from "./planService.js";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function buildJoinLinkToken() {
  return randomBytes(16).toString("base64url");
}

function isExpired(expiresAt: Date | null | undefined) {
  return !!expiresAt && new Date(expiresAt) < new Date();
}

function isExhausted(maxUses: number | null | undefined, useCount: number | null | undefined) {
  return maxUses != null && (useCount ?? 0) >= maxUses;
}

export interface InviteInfo {
  kind: "email" | "join_link";
  serverName: string;
  inviterName: string | null;
  memberCount: number;
  agentCount: number;
  insideCountsHidden: boolean;
  humanSeatLimitReached: boolean;
  humanSeatLimitMessage: string | null;
  agreement: serverAgreementService.PublicAgreement | null;
}

async function getServerMemberAgentCounts(
  serverId: string,
  options: { hideInsideCounts?: boolean } = {},
): Promise<{ memberCount: number; agentCount: number; insideCountsHidden: boolean }> {
  if (options.hideInsideCounts) {
    return { memberCount: 0, agentCount: 0, insideCountsHidden: true };
  }
  const db = getDb();
  const [memberRow, agentRow] = await Promise.all([
    db.select({ n: count() }).from(serverMembers).where(eq(serverMembers.serverId, serverId)),
    db
      .select({ n: count() })
      .from(agents)
      .where(and(eq(agents.serverId, serverId), isNull(agents.deletedAt))),
  ]);
  return {
    memberCount: memberRow[0]?.n ?? 0,
    agentCount: agentRow[0]?.n ?? 0,
    insideCountsHidden: false,
  };
}

export interface InviteAcceptResult {
  serverId: string;
  serverName: string;
}

async function assertServerCanInviteHuman(serverId: string): Promise<void> {
  const db = getDb();
  await refreshSubscriptionForServerIfStale(serverId);
  const entitlement = await getServerBillingEntitlement(db, serverId);
  const usage = await getServerBillingUsage(db, serverId);
  assertHumanCapacityAvailable(entitlement, usage);
}

async function getHumanSeatLimitState(serverId: string): Promise<{
  humanSeatLimitReached: boolean;
  humanSeatLimitMessage: string | null;
}> {
  const db = getDb();
  await refreshSubscriptionForServerIfStale(serverId);
  const entitlement = await getServerBillingEntitlement(db, serverId);
  const usage = await getServerBillingUsage(db, serverId);
  const limitState = getBillingCapacityLimitState(entitlement.capacity, usage, "human");
  if (limitState.reached) {
    return {
      humanSeatLimitReached: true,
      humanSeatLimitMessage: formatBillingCapacityLimitMessage("human", limitState, PLAN_CONFIG[entitlement.plan].displayName),
    };
  }
  return {
    humanSeatLimitReached: false,
    humanSeatLimitMessage: null,
  };
}

/**
 * Canonical self-serve community slugs. Anyone logged in can join these
 * servers without an invite token via `joinCommunityServer()`; the sidebar
 * shows community join entries while the current user isn't a member.
 */
export const COMMUNITY_SERVER_SLUG = "community";
export const CHINESE_COMMUNITY_SERVER_SLUG = "community-cn";
export type CommunityServerSlug = typeof COMMUNITY_SERVER_SLUG | typeof CHINESE_COMMUNITY_SERVER_SLUG;

const COMMUNITY_SERVER_SLUGS = new Set<CommunityServerSlug>([
  COMMUNITY_SERVER_SLUG,
  CHINESE_COMMUNITY_SERVER_SLUG,
]);

export function isCommunityServerSlug(value: unknown): value is CommunityServerSlug {
  return typeof value === "string" && COMMUNITY_SERVER_SLUGS.has(value as CommunityServerSlug);
}

/**
 * Join the community server as `userId`. Reuses the same join path as
 * `acceptInvite` (serverService.addMember + auto-add to #all), but without
 * requiring an invite token — any authenticated user may call this.
 *
 * Throws:
 *   - "Community server is not available" — requested community slug
 *     does not exist (not seeded on this deployment)
 *   - "You are already a member of this server" — caller already joined
 */
export async function joinCommunityServer(
  userId: string,
  agreementInput?: serverAgreementService.SelfServeAgreementInput & { slug?: CommunityServerSlug },
): Promise<InviteAcceptResult> {
  const slug = agreementInput?.slug ?? COMMUNITY_SERVER_SLUG;
  const server = await serverService.getServerBySlug(slug);
  if (!server) {
    throw new Error("Community server is not available");
  }

  const already = await serverService.isMember(server.id, userId);
  if (already) {
    throw new Error("You are already a member of this server");
  }

  await getDb().transaction(async (tx) => {
    const agreement = await serverAgreementService.requireSelfServeAgreement(tx, server.id, agreementInput);
    await serverService.addMember(server.id, userId, "member", {
      executor: tx,
      agreementAudit: {
        actorUserId: userId,
        source: "join",
        agreementId: agreement?.id ?? null,
        ipAddress: agreementInput?.ipAddress,
        userAgent: agreementInput?.userAgent,
      },
    });
  });

  return {
    serverId: server.id,
    serverName: server.name,
  };
}

export interface ServerJoinLinkRecord {
  id: string;
  token: string;
  createdAt: Date;
  expiresAt: Date | null;
  maxUses: number | null;
  useCount: number;
  revokedAt: Date | null;
}

export type InvitableServerRole = "member" | "guest";

export async function createInvite(
  serverId: string,
  invitedEmail: string,
  invitedByUserId: string,
  role: InvitableServerRole = "member",
): Promise<{ id: string; invitedEmail: string; expiresAt: Date; role: InvitableServerRole }> {
  const db = getDb();
  const emailError = validateEmailAddress(invitedEmail);
  if (emailError) {
    throw new Error(emailError);
  }
  const normalizedInvitedEmail = normalizeEmail(invitedEmail);

  const existingUser = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, normalizedInvitedEmail));

  if (existingUser.length > 0) {
    const isMember = await serverService.isMember(serverId, existingUser[0].id);
    if (isMember) {
      throw new Error("This user is already a member of this server");
    }
  }

  const [existing] = await db
    .select({ id: serverInvites.id, expiresAt: serverInvites.expiresAt })
    .from(serverInvites)
    .where(and(
      eq(serverInvites.serverId, serverId),
      eq(serverInvites.invitedEmail, normalizedInvitedEmail),
      eq(serverInvites.status, "pending"),
    ));

  if (existing && new Date(existing.expiresAt) > new Date()) {
    throw new Error("An invite has already been sent to this email");
  }

  await assertServerCanInviteHuman(serverId);

  if (existing) {
    await db.delete(serverInvites).where(eq(serverInvites.id, existing.id));
  }

  const [inviter] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, invitedByUserId));

  const [server] = await db
    .select({ name: servers.name })
    .from(servers)
    .where(eq(servers.id, serverId));

  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const [invite] = await db.insert(serverInvites).values({
    serverId,
    invitedEmail: normalizedInvitedEmail,
    invitedByUserId,
    role,
    tokenHash: hashToken(token),
    expiresAt,
  }).returning();

  await sendInviteEmail(
    normalizedInvitedEmail,
    inviter?.name || "Someone",
    server?.name || "a server",
    token,
  );

  return { id: invite.id, invitedEmail: invite.invitedEmail, expiresAt, role: invite.role };
}

export async function createJoinLink(
  serverId: string,
  createdByUserId: string,
  options: {
    expiresAt?: Date | null;
    maxUses?: number | null;
  } = {},
): Promise<{ token: string; link: ServerJoinLinkRecord }> {
  const db = getDb();
  const { expiresAt = null, maxUses = null } = options;

  if (maxUses != null && (!Number.isInteger(maxUses) || maxUses < 1)) {
    throw new Error("Max uses must be a positive integer");
  }

  if (expiresAt && Number.isNaN(expiresAt.getTime())) {
    throw new Error("Expires at must be a valid date");
  }

  const token = buildJoinLinkToken();

  const [created] = await db.insert(serverJoinLinks).values({
    serverId,
    createdByUserId,
    token,
    expiresAt,
    maxUses,
  }).returning();

  return {
    token,
    link: {
      id: created.id,
      token: created.token,
      createdAt: created.createdAt,
      expiresAt: created.expiresAt,
      maxUses: created.maxUses,
      useCount: created.useCount,
      revokedAt: created.revokedAt,
    },
  };
}

export async function listJoinLinks(serverId: string): Promise<ServerJoinLinkRecord[]> {
  const db = getDb();

  const links = await db
    .select({
      id: serverJoinLinks.id,
      token: serverJoinLinks.token,
      createdAt: serverJoinLinks.createdAt,
      expiresAt: serverJoinLinks.expiresAt,
      maxUses: serverJoinLinks.maxUses,
      useCount: serverJoinLinks.useCount,
      revokedAt: serverJoinLinks.revokedAt,
    })
    .from(serverJoinLinks)
    .where(and(
      eq(serverJoinLinks.serverId, serverId),
      isNull(serverJoinLinks.revokedAt),
    ))
    .orderBy(sql`${serverJoinLinks.createdAt} desc`);

  return links.filter((link) => !isExpired(link.expiresAt) && !isExhausted(link.maxUses, link.useCount));
}

export async function revokeJoinLink(linkId: string, serverId: string): Promise<void> {
  const db = getDb();
  await db
    .update(serverJoinLinks)
    .set({ revokedAt: new Date() })
    .where(and(
      eq(serverJoinLinks.id, linkId),
      eq(serverJoinLinks.serverId, serverId),
      isNull(serverJoinLinks.revokedAt),
    ));
}

export async function getInviteInfo(token: string): Promise<InviteInfo | null> {
  const db = getDb();
  const tokenHash = hashToken(token);

  // Check email invites first so the shared accept page keeps existing email-invite semantics.
  // Join links now use short raw codes, so checking email invites first keeps the old email flow unchanged.
  const [emailInvite] = await db
    .select({
      status: serverInvites.status,
      expiresAt: serverInvites.expiresAt,
      serverId: serverInvites.serverId,
      invitedByUserId: serverInvites.invitedByUserId,
    })
    .from(serverInvites)
    .where(eq(serverInvites.tokenHash, tokenHash));

  if (emailInvite) {
    if (emailInvite.status !== "pending" || isExpired(emailInvite.expiresAt)) return null;

    const [server] = await db
      .select({ name: servers.name, deletedAt: servers.deletedAt, hideHumansFromMembers: servers.hideHumansFromMembers })
      .from(servers)
      .where(eq(servers.id, emailInvite.serverId));

    if (!server || server.deletedAt) return null;

    const [inviter] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, emailInvite.invitedByUserId));

    const counts = await getServerMemberAgentCounts(emailInvite.serverId, {
      hideInsideCounts: server.hideHumansFromMembers,
    });
    const humanSeatLimit = await getHumanSeatLimitState(emailInvite.serverId);
    return {
      kind: "email",
      serverName: server.name,
      inviterName: inviter?.name || "Someone",
      agreement: await serverAgreementService.getActiveAgreement(emailInvite.serverId),
      ...humanSeatLimit,
      ...counts,
    };
  }

  const [joinLink] = await db
    .select({
      id: serverJoinLinks.id,
      serverId: serverJoinLinks.serverId,
      createdByUserId: serverJoinLinks.createdByUserId,
      expiresAt: serverJoinLinks.expiresAt,
      maxUses: serverJoinLinks.maxUses,
      useCount: serverJoinLinks.useCount,
      revokedAt: serverJoinLinks.revokedAt,
    })
    .from(serverJoinLinks)
    .where(eq(serverJoinLinks.token, token));

  if (!joinLink) return null;
  if (joinLink.revokedAt || isExpired(joinLink.expiresAt) || isExhausted(joinLink.maxUses, joinLink.useCount)) {
    return null;
  }

  const [server] = await db
    .select({ name: servers.name, deletedAt: servers.deletedAt, hideHumansFromMembers: servers.hideHumansFromMembers })
    .from(servers)
    .where(eq(servers.id, joinLink.serverId));

  if (!server || server.deletedAt) return null;

  const [inviter] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, joinLink.createdByUserId));

  const counts = await getServerMemberAgentCounts(joinLink.serverId, {
    hideInsideCounts: server.hideHumansFromMembers,
  });
  const humanSeatLimit = await getHumanSeatLimitState(joinLink.serverId);
  return {
    kind: "join_link",
    serverName: server.name,
    inviterName: inviter?.name || null,
    agreement: await serverAgreementService.getActiveAgreement(joinLink.serverId),
    ...humanSeatLimit,
    ...counts,
  };
}

export async function acceptInvite(
  token: string,
  userId: string,
  agreementInput?: serverAgreementService.SelfServeAgreementInput,
): Promise<InviteAcceptResult> {
  const db = getDb();
  const tokenHash = hashToken(token);

  const [emailInvite] = await db.select().from(serverInvites).where(eq(serverInvites.tokenHash, tokenHash));

  if (emailInvite) {
    if (emailInvite.status !== "pending") throw new Error("This invite has already been used");
    if (isExpired(emailInvite.expiresAt)) {
      await db.update(serverInvites).set({ status: "expired" }).where(eq(serverInvites.id, emailInvite.id));
      throw new Error("This invite has expired");
    }

    const [user] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId));

    if (!user || normalizeEmail(user.email) !== normalizeEmail(emailInvite.invitedEmail)) {
      throw new Error("This invite was sent to a different email address");
    }

    const server = await serverService.getServer(emailInvite.serverId);
    if (!server) throw new Error("This server no longer exists");

    const isMember = await serverService.isMember(emailInvite.serverId, userId);
    if (isMember) {
      throw new Error("You are already a member of this server");
    }

    await db.transaction(async (tx) => {
      const agreement = await serverAgreementService.requireSelfServeAgreement(tx, emailInvite.serverId, agreementInput);
      // The role the inviter chose, not a hardcoded default. A guest invite that
      // silently produced a member would hand out more access than was offered.
      await serverService.addMember(emailInvite.serverId, userId, emailInvite.role, {
        executor: tx,
        agreementAudit: {
          actorUserId: userId,
          source: "invite",
          agreementId: agreement?.id ?? null,
          ipAddress: agreementInput?.ipAddress,
          userAgent: agreementInput?.userAgent,
        },
      });
      await tx.update(serverInvites).set({ status: "accepted" }).where(eq(serverInvites.id, emailInvite.id));
    });

    return {
      serverId: emailInvite.serverId,
      serverName: server.name,
    };
  }

  const [joinLink] = await db.select().from(serverJoinLinks).where(eq(serverJoinLinks.token, token));
  if (!joinLink) throw new Error("Invalid invite token");
  if (joinLink.revokedAt) throw new Error("This invite has been revoked");
  if (isExpired(joinLink.expiresAt)) throw new Error("This invite has expired");
  if (isExhausted(joinLink.maxUses, joinLink.useCount)) throw new Error("This invite has already reached its usage limit");

  const server = await serverService.getServer(joinLink.serverId);
  if (!server) throw new Error("This server no longer exists");

  await db.transaction(async (tx) => {
    const agreement = await serverAgreementService.requireSelfServeAgreement(tx, joinLink.serverId, agreementInput);
    const joinedThisServer = await serverService.addMember(joinLink.serverId, userId, "member", {
      executor: tx,
      agreementAudit: {
        actorUserId: userId,
        source: "invite",
        agreementId: agreement?.id ?? null,
        ipAddress: agreementInput?.ipAddress,
        userAgent: agreementInput?.userAgent,
      },
    });

    if (joinedThisServer) {
      const [consumed] = await tx
        .update(serverJoinLinks)
        .set({ useCount: sql`${serverJoinLinks.useCount} + 1` })
        .where(and(
          eq(serverJoinLinks.id, joinLink.id),
          isNull(serverJoinLinks.revokedAt),
          sql`(${serverJoinLinks.expiresAt} is null or ${serverJoinLinks.expiresAt} > now())`,
          sql`(${serverJoinLinks.maxUses} is null or ${serverJoinLinks.useCount} < ${serverJoinLinks.maxUses})`,
        ))
        .returning({ id: serverJoinLinks.id });

      if (!consumed) {
        const [current] = await tx
          .select({
            revokedAt: serverJoinLinks.revokedAt,
            expiresAt: serverJoinLinks.expiresAt,
            maxUses: serverJoinLinks.maxUses,
            useCount: serverJoinLinks.useCount,
          })
          .from(serverJoinLinks)
          .where(eq(serverJoinLinks.id, joinLink.id));

        if (!current || current.revokedAt) {
          throw new Error("This invite has been revoked");
        }
        if (isExpired(current.expiresAt)) {
          throw new Error("This invite has expired");
        }
        if (isExhausted(current.maxUses, current.useCount)) {
          throw new Error("This invite has already reached its usage limit");
        }
        throw new Error("This invite is no longer valid");
      }
    }
  });

  return {
    serverId: joinLink.serverId,
    serverName: server.name,
  };
}

export async function listPendingInvites(serverId: string) {
  const db = getDb();
  const invites = await db
    .select({
      id: serverInvites.id,
      invitedEmail: serverInvites.invitedEmail,
      invitedByUserId: serverInvites.invitedByUserId,
      role: serverInvites.role,
      status: serverInvites.status,
      expiresAt: serverInvites.expiresAt,
      createdAt: serverInvites.createdAt,
    })
    .from(serverInvites)
    .where(and(
      eq(serverInvites.serverId, serverId),
      eq(serverInvites.status, "pending"),
    ));

  const now = new Date();
  return invites.filter((inv) => new Date(inv.expiresAt) > now);
}

export async function revokeInvite(inviteId: string, serverId: string): Promise<void> {
  const db = getDb();
  await db.delete(serverInvites).where(
    and(
      eq(serverInvites.id, inviteId),
      eq(serverInvites.serverId, serverId),
    ),
  );
}
