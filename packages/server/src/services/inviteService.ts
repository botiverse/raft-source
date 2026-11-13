import { HumanSeatLimitError } from "./planService";
import { and, count, eq, isNull, sql } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { PLAN_CONFIG, PRO_SEAT_ADD_FEATURE_FLAG_KEY, formatBillingCapacityLimitMessage, getBillingCapacityLimitState, validateEmailAddress, type ServerRole } from "@botiverse/raft-shared";
import { getDb, type DatabaseTransaction } from "../db/index";
import { agents, serverInvites, serverJoinLinks, serverMembers, serverMembershipDepartures, servers, users } from "../db/schema";
import { sendInviteEmail } from "./emailService";
import { normalizeEmail } from "./emailNormalization";
import * as serverService from "./serverService";
import { lockJointUsersFirst, withJointUsersGuessed } from "./jointHumanMembershipMirror";
import { missingAllChannelHumanUserIds } from "./allChannelMembership";
import { getActorServerRoleInServer } from "../lib/actorPermissions";
import { listedServerAgent } from "./agentMemberListPolicy";
import * as serverAgreementService from "./serverAgreementService";
import { refreshSubscriptionForServerIfStale } from "./billingService";
import { evaluateFeatureFlag } from "./featureFlagService";
import { enforceServerInviteEmailRate } from "./serverInviteEmailLimits";
import { deploymentUserLimitReached } from "./deploymentUserLimit";
import {
  acquireServerLock,
  SERVER_MEMBERSHIP_ADMISSION_LOCK_NAMESPACE,
  assertHumanCapacityAvailable,
  getServerBillingEntitlement,
  getServerBillingUsage,
} from "./planService";

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
  /**
   * The seats are full and pro_seat_add is on for this server (task #10): the
   * page offers someone signed out only Sign In / Create Account, and tells
   * someone signed in that the owners were told (POST /api/invites/seat-blocked).
   * The server answers it because a visitor who isn't signed in can't
   * evaluate the flag.
   */
  seatNoticeEnabled: boolean;
  /**
   * The source-available deployment already has as many people as the Raft
   * License allows (deploymentUserLimit.ts): joining works only for someone
   * who already counts. Always false in the cloud edition.
   */
  deploymentUserLimitReached: boolean;
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
      .where(and(eq(agents.serverId, serverId), isNull(agents.deletedAt), listedServerAgent())),
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
  /** Set when the person was a Guest of the server and the invite made them a member. */
  promotedFromGuest?: { previousRole: ServerRole; role: ServerRole };
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
  seatNoticeEnabled: boolean;
}> {
  const db = getDb();
  await refreshSubscriptionForServerIfStale(serverId);
  const entitlement = await getServerBillingEntitlement(db, serverId);
  const usage = await getServerBillingUsage(db, serverId);
  const limitState = getBillingCapacityLimitState(entitlement.capacity, usage, "human");
  if (limitState.reached) {
    // Only Pro seats (not a plan's member cap) are what an owner adds and the notice is about.
    const seatNotice = limitState.limitType === "universal"
      && (await evaluateFeatureFlag({ key: PRO_SEAT_ADD_FEATURE_FLAG_KEY, serverId })).enabled;
    return {
      humanSeatLimitReached: true,
      humanSeatLimitMessage: formatBillingCapacityLimitMessage("human", limitState, PLAN_CONFIG[entitlement.plan].displayName),
      seatNoticeEnabled: seatNotice,
    };
  }
  return {
    humanSeatLimitReached: false,
    humanSeatLimitMessage: null,
    seatNoticeEnabled: false,
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

/** A stored invite's role. "guest" survives only on old rows, which acceptInvite refuses. */
export type InvitableServerRole = "member" | "guest";

/**
 * A server invite always makes a Member: a Guest belongs to one channel and is
 * invited to it by an external invite (#wg-rbac:#15), so a Guest server invite
 * would create a Guest with no channel (#wg-rbac:#47).
 */
export async function createInvite(
  serverId: string,
  invitedEmail: string,
  invitedByUserId: string,
  role: "member" = "member",
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
    // A Guest may be invited: accepting promotes them (promoteGuestByInvite).
    const memberRole = await getActorServerRoleInServer(serverId, "user", existingUser[0].id);
    if (memberRole && memberRole !== "guest") {
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

  // One email per invite: the server's and the inviter's daily budget (serverInviteEmailLimits.ts).
  await enforceServerInviteEmailRate({ serverId, inviterUserId: invitedByUserId });

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

/** An invite or join link that still lets someone in, and the server it is for. */
export interface LiveInvite {
  kind: "email" | "join_link";
  serverId: string;
  serverName: string;
  hideHumansFromMembers: boolean;
  /** Who sent the email invite or made the join link. */
  inviterUserId: string;
  /** What joining grants: the email invite's role; a join link makes members. */
  role: InvitableServerRole;
  /** The email invite's address (only its owner accepts it); null for a join link. */
  invitedEmail: string | null;
}

/**
 * The invite behind `token` while it still lets someone in: a pending,
 * unexpired email invite, or a join link not revoked, expired or used up; on
 * a server that still exists. Null otherwise. invite-info and the seat notice
 * (seatJoinBlockService) read it the same way.
 */
export async function findLiveInvite(token: string): Promise<LiveInvite | null> {
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
      invitedEmail: serverInvites.invitedEmail,
      role: serverInvites.role,
    })
    .from(serverInvites)
    .where(eq(serverInvites.tokenHash, tokenHash));

  let invite: Omit<LiveInvite, "serverName" | "hideHumansFromMembers">;
  if (emailInvite) {
    if (emailInvite.status !== "pending" || isExpired(emailInvite.expiresAt)) return null;
    invite = {
      kind: "email",
      serverId: emailInvite.serverId,
      inviterUserId: emailInvite.invitedByUserId,
      role: emailInvite.role,
      invitedEmail: emailInvite.invitedEmail,
    };
  } else {
    const [joinLink] = await db
      .select({
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
    invite = { kind: "join_link", serverId: joinLink.serverId, inviterUserId: joinLink.createdByUserId, role: "member", invitedEmail: null };
  }

  const [server] = await db
    .select({ name: servers.name, deletedAt: servers.deletedAt, hideHumansFromMembers: servers.hideHumansFromMembers })
    .from(servers)
    .where(eq(servers.id, invite.serverId));

  if (!server || server.deletedAt) return null;
  return { ...invite, serverName: server.name, hideHumansFromMembers: server.hideHumansFromMembers };
}

export async function getInviteInfo(token: string): Promise<InviteInfo | null> {
  const db = getDb();
  const invite = await findLiveInvite(token);
  if (!invite) return null;

  const [inviter] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, invite.inviterUserId));

  const counts = await getServerMemberAgentCounts(invite.serverId, {
    hideInsideCounts: invite.hideHumansFromMembers,
  });
  const humanSeatLimit = invite.role === "guest"
    ? { humanSeatLimitReached: false, humanSeatLimitMessage: null, seatNoticeEnabled: false }
    : await getHumanSeatLimitState(invite.serverId);
  return {
    kind: invite.kind,
    serverName: invite.serverName,
    inviterName: invite.kind === "email" ? inviter?.name || "Someone" : inviter?.name || null,
    agreement: await serverAgreementService.getActiveAgreement(invite.serverId),
    ...humanSeatLimit,
    deploymentUserLimitReached: await deploymentUserLimitReached(),
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
    // A Guest belongs to one channel and is invited to that channel (#wg-rbac:#15).
    // A server invite stored with the Guest role from before can no longer be
    // accepted: it would create a Guest with no channel. Refused, never turned
    // into a Member invite (more access than was offered).
    if (emailInvite.role === "guest") {
      await db.update(serverInvites).set({ status: "expired" }).where(and(eq(serverInvites.id, emailInvite.id), eq(serverInvites.status, "pending")));
      throw new Error("This invite has been revoked");
    }
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

    const admitted = await admitByInvite({
      serverId: emailInvite.serverId,
      userId,
      inviterUserId: emailInvite.invitedByUserId,
      agreementInput,
      consume: async (tx) => {
        const [used] = await tx.update(serverInvites).set({ status: "accepted" })
          .where(and(eq(serverInvites.id, emailInvite.id), eq(serverInvites.status, "pending")))
          .returning({ id: serverInvites.id });
        if (!used) throw new Error("This invite has already been used");
      },
    });
    if (admitted.kind === "already_member") throw new Error("You are already a member of this server");

    return {
      serverId: emailInvite.serverId,
      serverName: server.name,
      ...(admitted.kind === "promoted" ? { promotedFromGuest: admitted.promoted } : {}),
    };
  }

  const [joinLink] = await db.select().from(serverJoinLinks).where(eq(serverJoinLinks.token, token));
  if (!joinLink) throw new Error("Invalid invite token");
  if (joinLink.revokedAt) throw new Error("This invite has been revoked");
  if (isExpired(joinLink.expiresAt)) throw new Error("This invite has expired");
  if (isExhausted(joinLink.maxUses, joinLink.useCount)) throw new Error("This invite has already reached its usage limit");

  const server = await serverService.getServer(joinLink.serverId);
  if (!server) throw new Error("This server no longer exists");

  const admitted = await admitByInvite({
    serverId: joinLink.serverId,
    userId,
    inviterUserId: joinLink.createdByUserId,
    agreementInput,
    consume: (tx) => consumeJoinLinkUse(tx, joinLink.id),
  });

  // A member opening a join link again is let through (it changes and uses nothing), as before.
  return {
    serverId: joinLink.serverId,
    serverName: server.name,
    ...(admitted.kind === "promoted" ? { promotedFromGuest: admitted.promoted } : {}),
  };
}

/** Counts one use of a join link, or refuses when it stopped letting people in since it was read. */
async function consumeJoinLinkUse(tx: DatabaseTransaction, joinLinkId: string): Promise<void> {
  const [consumed] = await tx
    .update(serverJoinLinks)
    .set({ useCount: sql`${serverJoinLinks.useCount} + 1` })
    .where(and(
      eq(serverJoinLinks.id, joinLinkId),
      isNull(serverJoinLinks.revokedAt),
      sql`(${serverJoinLinks.expiresAt} is null or ${serverJoinLinks.expiresAt} > now())`,
      sql`(${serverJoinLinks.maxUses} is null or ${serverJoinLinks.useCount} < ${serverJoinLinks.maxUses})`,
    ))
    .returning({ id: serverJoinLinks.id });
  if (consumed) return;

  const [current] = await tx
    .select({
      revokedAt: serverJoinLinks.revokedAt,
      expiresAt: serverJoinLinks.expiresAt,
      maxUses: serverJoinLinks.maxUses,
      useCount: serverJoinLinks.useCount,
    })
    .from(serverJoinLinks)
    .where(eq(serverJoinLinks.id, joinLinkId));

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

type InviteAdmission =
  | { kind: "joined" }
  | { kind: "promoted"; promoted: { previousRole: ServerRole; role: ServerRole } }
  | { kind: "already_member" };

/**
 * Lets the person behind a server invite or join link in, deciding under the
 * host's SERVER_MEMBERSHIP_ADMISSION lock (the one external invite accepts
 * take) whether they join, are promoted from Guest, or are already a member:
 *
 * - not a member: added as a member (a conflicting insert is refused, never
 *   taken for success);
 * - a Guest (#wg-rbac:#16, Cody): promoted by the transition an owner or
 *   admin makes by hand (transitionMemberRole: a seat is needed, the channel
 *   binding is cleared, channel memberships and read positions stay), made as
 *   the person who sent the invite or made the link, and only while the
 *   locked row is a Guest (expectedRole). If they may no longer promote (left, or no
 *   longer an owner or admin), the invite no longer lets anyone in;
 * - already an owner, admin or member: nothing changes and nothing is used.
 *
 * The invite or link is used (`consume`) in the same transaction. Lock order:
 * the invitee, inviter and missing #all audience's users rows in id order,
 * the admission lock, the server row FOR UPDATE (the strength promotion
 * needs, so it is never upgraded from FOR SHARE), the member, then the invite
 * or link. #all's missing audience is guessed unlocked and checked at its
 * insert; a larger set restarts the transaction before consuming the invite.
 */
async function admitByInvite(input: {
  serverId: string;
  userId: string;
  inviterUserId: string;
  agreementInput: serverAgreementService.SelfServeAgreementInput | undefined;
  consume: (tx: DatabaseTransaction) => Promise<void>;
}): Promise<InviteAdmission> {
  const admission = await withJointUsersGuessed(
    async () => [input.userId, input.inviterUserId, ...await missingAllChannelHumanUserIds(getDb(), input.serverId)],
    (lockedUserIds) => getDb().transaction(async (tx): Promise<{ admission: InviteAdmission; transition: serverService.ServerMemberRoleTransitionResult | null }> => {
      // The person's and the inviter's users rows first (lockJointUsersFirst;
      // only locked, as before): a Guest's promotion below names both (the
      // role audit, the joint mirror), and taking them only there, after the
      // server row FOR UPDATE, closes a cycle with either one's account
      // deletion (users row FOR UPDATE, then the servers they own).
      // A third human can reveal #all for existing people too, including an
      // owner who is neither inviter nor invitee. Their channel_humans FKs
      // must not wait on account deletion after we hold the Server lock.
      await lockJointUsersFirst(tx, { userIds: [...lockedUserIds] });
      await acquireServerLock(tx, input.serverId, SERVER_MEMBERSHIP_ADMISSION_LOCK_NAMESPACE);
      // Under these locks nothing changes whether or how they are in.
      const role = await serverService.lockServerMembershipForAdmission(tx, input.serverId, input.userId);
      if (role && role !== "guest") return { admission: { kind: "already_member" }, transition: null };
      const agreement = await serverAgreementService.requireSelfServeAgreement(tx, input.serverId, input.agreementInput);

      if (role === "guest") {
        let transition: serverService.ServerMemberRoleTransitionResult;
        try {
          // Re-takes the server and member rows already held FOR UPDATE.
          transition = await serverService.transitionMemberRoleInTransaction(tx, {
            serverId: input.serverId,
            actorUserId: input.inviterUserId,
            targetUserId: input.userId,
            // A Guest invite is refused before this (acceptInvite): invites make members.
            nextRole: "member",
            expectedRole: "guest",
          });
        } catch (err) {
          if (err instanceof serverService.ServerMemberRoleTransitionError) {
            // Cannot happen under the member lock; refused (nothing used) rather than trusted.
            if (err.code === "role_changed") return { admission: { kind: "already_member" }, transition: null };
            throw new Error("This invite is no longer valid");
          }
          throw err;
        }
        await serverAgreementService.insertMembershipAgreementAudit(tx, {
          serverId: input.serverId,
          subjectType: "user",
          subjectId: input.userId,
          actorUserId: input.userId,
          source: "invite",
          agreementId: agreement?.id ?? null,
          agreementVersion: agreement?.version ?? null,
          ipAddress: input.agreementInput?.ipAddress,
          userAgent: input.agreementInput?.userAgent,
        });
        await input.consume(tx);
        return {
          admission: { kind: "promoted", promoted: { previousRole: transition.previousRole, role: transition.nextRole } },
          transition,
        };
      }

      const added = await serverService.addMember(input.serverId, input.userId, "member", {
        executor: tx,
        allChannelLockedUserIds: lockedUserIds,
        agreementAudit: {
          actorUserId: input.userId,
          source: "invite",
          agreementId: agreement?.id ?? null,
          ipAddress: input.agreementInput?.ipAddress,
          userAgent: input.agreementInput?.userAgent,
        },
      });
      // Cannot happen with the member row locked absent under the admission
      // lock; a conflict is refused (nothing used), never taken for success.
      if (!added) throw new Error("You are already a member of this server");
      await input.consume(tx);
      return { admission: { kind: "joined" }, transition: null };
  }));
  if (admission.transition) await serverService.finishMemberRoleTransition(input.userId, admission.transition);
  return admission.admission;
}

export type SsoAdmission =
  | { kind: "joined" }
  | { kind: "already_member" }
  | { kind: "seats_full" }
  | { kind: "agreement_required" }
  /** Removed from this Server, or left it as a Guest: only being added again (an invite, a direct add) brings them back. */
  | { kind: "rejoin_needs_invite" };

/**
 * SSO auto-join (rfcs/083-server-sso.md §6.1): the person signed in with the
 * Server's SSO connection and the owner turned auto-join on. The admission
 * lock and agreement check of admitByInvite, but it never changes an
 * existing membership: a guest (perhaps a contractor) stays a guest. A full
 * Server or an agreement the person has not accepted does not fail the
 * sign-in: they are simply not added, and the caller tells them.
 *
 * Nor does it bring back someone an owner or admin removed from this Server
 * (Warden 7cba3414): their departure row for this Server says `removed`
 * (anyone's doing but their own: an owner or admin, a channel admin removing
 * a Guest, a Guest's channel ending), nor someone who left as a Guest (auto-
 * join would make them a full member). A member leaving on their own (`left`)
 * does not count, nor does another Server's removal, and joining again by
 * any route (addMember) clears the row.
 */
export async function admitBySso(input: {
  serverId: string;
  userId: string;
  agreementInput?: serverAgreementService.SelfServeAgreementInput;
}): Promise<SsoAdmission> {
  try {
    return await getDb().transaction(async (tx): Promise<SsoAdmission> => {
      await acquireServerLock(tx, input.serverId, SERVER_MEMBERSHIP_ADMISSION_LOCK_NAMESPACE);
      const role = await serverService.lockServerMembershipForAdmission(tx, input.serverId, input.userId);
      if (role) return { kind: "already_member" };
      const [departure] = await tx.select({ reason: serverMembershipDepartures.reason, role: serverMembershipDepartures.role })
        .from(serverMembershipDepartures)
        .where(and(eq(serverMembershipDepartures.serverId, input.serverId), eq(serverMembershipDepartures.userId, input.userId)));
      // A Guest who left is not made a member either: promotion is an admin's call.
      if (departure?.reason === "removed" || departure?.role === "guest") {
        return { kind: "rejoin_needs_invite" };
      }
      const agreement = await serverAgreementService.requireSelfServeAgreement(tx, input.serverId, input.agreementInput);
      const added = await serverService.addMember(input.serverId, input.userId, "member", {
        executor: tx,
        agreementAudit: {
          actorUserId: input.userId,
          source: "sso",
          agreementId: agreement?.id ?? null,
          ipAddress: input.agreementInput?.ipAddress,
          userAgent: input.agreementInput?.userAgent,
        },
      });
      return added ? { kind: "joined" } : { kind: "already_member" };
    });
  } catch (err) {
    if (err instanceof HumanSeatLimitError) return { kind: "seats_full" };
    if (err instanceof serverAgreementService.AgreementRequiredError) return { kind: "agreement_required" };
    throw err;
  }
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
