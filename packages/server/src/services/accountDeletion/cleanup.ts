/**
 * Account deletion cleanup (design "删除账号：服务端设计 v2" §7): once a
 * request's grace period is over, hourly maintenance deletes the account.
 * The `users` row stays (dozens of foreign keys and every message point at
 * it): it is retired and scrubbed, and the person's data is deleted per
 * tableClassification.ts.
 *
 * Phase A, one short transaction per person (retireDueAccounts): take a due
 * `pending` request (`FOR UPDATE SKIP LOCKED`, so concurrent runs never take
 * the same one), then
 *   1. hand over every live server the person owns (`servers.owner_id`):
 *      another owner (earliest joined) takes it; else the earliest-joined
 *      admin, else the earliest-joined member, is made owner (a role
 *      transition the person makes, audited as such) and is emailed after
 *      commit; agents and guests never count; with nobody left the server is
 *      soft deleted as DELETE /api/servers/:id does (its Stripe
 *      subscription, already set to cancel at period end when the deletion
 *      was asked, is cancelled after commit);
 *   2. dispose of the person's agents and personal assistants
 *      (disposeAgentsOfDeletedUser);
 *   3. sign out any sign-in made during the grace period, retire the account
 *      (`account_deleted`, trace id rotated) and scrub it: email
 *      `deleted+<id>@invalid`, handle `deleted_<id hex>`, display name
 *      "Deleted user", profile, sign-in secrets and preferences cleared;
 *   4. write the retirement receipt (with what became of each server) and
 *      mark the request's account retired.
 * After commit: the "your account has been deleted" email to the address
 * read before the scrub, the new owners' emails, Stripe, sockets, agents'
 * caches. Each best effort.
 *
 * Phase B, re-runnable (cleanUpRetiredAccounts): under a lease, delete the
 * person's rows table by table (one transaction per table; the big
 * user-keyed tables in batches of ACCOUNT_DELETION_BATCH_SIZE rows, each its
 * own transaction, at most `batchesPerRequest` batches per request per run),
 * end what kept rows still hold open (KEEP_ACTIONS), and remove the person
 * from Resend and cancel their scheduled onboarding email first (outside any
 * transaction; a failure leaves those rows for the next run). When every
 * step is done the request is `completed`; otherwise the next run resumes.
 *
 * A person with no due request is never touched.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import { and, asc, eq, inArray, isNotNull, isNull, lte, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { Server as SocketServer } from "socket.io";
import { currentDate, errorCodeOf } from "@botiverse/raft-shared";

import { getDb, type DatabaseExecutor, type DatabaseTransaction } from "../../db/index";
import {
  accountDeletionRequests,
  agentRuntimeProvisions,
  agentRuntimeProfiles,
  agents,
  machines,
  oauthAccessRequests,
  oauthAccessTokens,
  oauthUserConsents,
  newsletterAudienceContacts,
  onboardingEmailJourneys,
  paidLifecycleJourneys,
  servers,
  serverMembers,
  sessions,
  subscriptions,
  userRetirementReceipts,
  users,
  type AccountDeletionAgentDisposition,
  type AccountDeletionServerHandoff,
} from "../../db/schema";
import { broadcastAgentCredentialRevocation } from "../../replicaRouter";
import { revokeSocketAccess } from "../../socket/accessRevocation";
import { forgetTraceUserId } from "../../tracing/traceUserId";
import { serializeErrorForLog } from "../../tracing/safeErrorLog";
import { errorClassOf, safeAddTraceEvent } from "../../tracing/semanticTrace";
import { recordAgentArchive } from "../agentArchiveService";
import { getActiveAgentMigration } from "../agentMigrationService";
import { beginProvisionedAgentDeletion, kickAgentRuntimeProvisionWorker } from "../agentRuntimeProvisionService";
import { deleteAgent } from "../agentService";
import { emitAppFacingMemberEvents, kickAppNotificationDelivery } from "../appNotificationDeliveryService";
import { announceSeatJoinBlocksForSeatChange } from "../listChangedRealtime";
import { openAccessRequestPredicate } from "../oauthService";
import { cancelStripeSubscriptionOfDeletedServer, cancelSubscriptionAtPeriodEnd } from "../billingService";
import { deleteStoredUserAvatarIfUnused, isUserAvatarHashStillShown } from "../avatarService";
import type { DetachedComputer } from "../computerKeyRevocation";
import { revokeComputersOfDeletedAccount } from "./requests";
import { noticeOwnersOfDetachedComputer } from "../computerDetachedNotices";
import { deleteMachine, MachineDeleteConflictError } from "../machineService";
import { postAgentActionRequiredNotice } from "../agentActionRequiredNoticeService";
import type { AgentOrchestrator } from "../agentOrchestrator";
import { closeDeviceSessionKeys } from "../deviceSessionKeys";
import { clearComputerOwnershipOf } from "../computerOwnerService";
import {
  cancelScheduledEmail,
  deleteResendContact,
  sendAccountDeletionEmail,
  sendAgentsHandedOverEmail,
  sendServerOwnershipHandedOverEmail,
  sendSubscriptionEndingAfterDeletionEmail,
} from "../emailService";
import {
  finishMemberRoleTransition,
  softDeleteServerInTransaction,
  transitionMemberRoleInTransaction,
  type ServerMemberRoleTransitionResult,
} from "../serverService";
import { revokeAllUserSessionsInTransaction } from "../sessionService";
import { unbindAndStopAgents } from "../computerAgents";
import { revokeRunnerCredentialsOffMachine } from "../agentCredentialService";
import {
  USER_FOREIGN_KEY_CLASSIFICATION,
  USER_NO_FOREIGN_KEY_PERSONAL_TABLES,
  type AccountDeletionKeepAction,
  type UserForeignKey,
} from "./tableClassification";

/** Rows per batch on the big user-keyed tables; each batch is its own transaction. */
export const ACCOUNT_DELETION_BATCH_SIZE = 5000;
/** Batches per request per maintenance run (1M rows), so one person cannot hold up a run. */
export const ACCOUNT_DELETION_BATCHES_PER_REQUEST = 200;
/** Accounts retired (phase A) per run. */
export const ACCOUNT_DELETION_RETIREMENTS_PER_RUN = 10;
/** Retired accounts cleaned up (phase B) per run. */
export const ACCOUNT_DELETION_CLEANUPS_PER_RUN = 5;
/** How long one replica holds a request's phase B. */
const CLEANUP_LEASE_MS = 30 * 60_000;

export const DELETED_USER_DISPLAY_NAME = "Deleted user";
export const ACCOUNT_DELETED_RETIRED_REASON = "account_deleted";
const REVOKED_REASON = "account_deleted";

/** The scrubbed email: unroutable (`.invalid`), unique per account, so the old address can sign up again. */
export function deletedUserEmail(userId: string): string {
  return `deleted+${userId}@invalid`;
}

/**
 * The scrubbed handle. `users.name` is the unique @handle, so "Deleted user"
 * cannot be everyone's: `deleted_` and the id's 32 hex digits. Unique because
 * the id is, and no one can claim it: at 40 characters it is past the
 * handle's 32-character limit (validateName), so sign-up and profile setup
 * refuse it.
 */
export function deletedUserHandle(userId: string): string {
  return `deleted_${userId.replaceAll("-", "").toLowerCase()}`;
}

/** The environment a retirement receipt records: staging on the staging release branch, else production. */
export function retirementEnvironment(env: NodeJS.ProcessEnv = process.env): "staging" | "production" {
  const branch = (env.RAFT_RELEASE_BRANCH ?? env.SLOCK_RELEASE_BRANCH)?.trim();
  return branch === "staging" ? "staging" : "production";
}

export type AccountDeletionCleanupDeps = {
  /** The orchestrator's in-memory caches of the disposed agents (absent where there is none). */
  orchestrator?: { evictCache(agentId: string): void; forgetAgentActivity?(agentId: string): void } | null;
  io?: SocketServer | null;
  /** Overridable for tests; production calls Resend. */
  deleteResendContact?: (contact: { id: string } | { email: string }) => Promise<void>;
  /** Overridable for tests; production calls Resend. */
  cancelScheduledEmail?: (emailId: string) => Promise<void>;
  /** Overridable for tests; production deletes the stored image unless someone else still shows it (avatarService.ts). */
  deleteStoredUserAvatar?: (avatarUrl: string | null) => Promise<unknown>;
  /** Overridable for tests; production posts the "offline, move it" notice to each agent owner (computerDetachedNotices.ts). */
  noticeDetachedComputer?: (computer: DetachedComputer, agentIds: readonly string[]) => Promise<unknown>;
  /** Overridable for tests; production posts the handover notice in the new owner's DM with the agent (agentActionRequiredNoticeService.ts). */
  noticeAgentHandedOver?: (notice: AgentTransferNotice, deletedName: string) => Promise<unknown>;
  /** Overridable for tests; production calls Stripe (best effort). */
  cancelStripeSubscription?: (serverId: string, stripeSubscriptionId: string) => Promise<void>;
  /** Overridable for tests; production sets the Stripe subscription to cancel at period end (best effort). */
  cancelSubscriptionAtPeriodEnd?: (serverId: string, userId: string) => Promise<unknown>;
};

export type AccountDeletionCleanupOptions = {
  now?: Date;
  retirementsPerRun?: number;
  cleanupsPerRun?: number;
  batchSize?: number;
  batchesPerRequest?: number;
  deps?: AccountDeletionCleanupDeps;
};

export type AccountDeletionCleanupReport = {
  /** People whose account phase A retired in this run. */
  retired: string[];
  /** People whose request this run completed. */
  completed: string[];
  /** People whose phase B is left for a later run. */
  resumeLater: string[];
};

/**
 * The failures of one cleanup run, for its trace (the maintenance span of
 * server.ts): by phase, step and error class only, never the person, the
 * request or the error's text. Without this a failed deletion was only a
 * `console.error`, which no reading sees.
 */
export type CleanupFailureTally = Map<string, { phase: "retire" | "after_retire" | "cleanup"; step: string; error_class: string; error_code: string | null; count: number }>;

const runTally = new AsyncLocalStorage<CleanupFailureTally>();
/** The phase a best-effort failure counts under: set around phase A's after-commit effects and each phase B step. */
const currentPhase = new AsyncLocalStorage<"after_retire" | "cleanup">();

function tallyFailure(phase: "retire" | "after_retire" | "cleanup", step: string, err: unknown): void {
  const tally = runTally.getStore();
  if (!tally) return;
  const errorClass = errorClassOf(err);
  const errorCode = errorCodeOf(err);
  const key = `${phase}:${step}:${errorClass}:${errorCode ?? ""}`;
  const entry = tally.get(key);
  if (entry) entry.count += 1;
  else tally.set(key, { phase, step, error_class: errorClass, error_code: errorCode, count: 1 });
}

/**
 * The hourly maintenance entry: phase A for due requests, then phase B for
 * retired ones. Records `account_deletion.cleanup.finished` (how many it
 * processed, how many failed) and one `account_deletion.cleanup.step_failed`
 * per distinct failure on the current span.
 */
export async function runAccountDeletionCleanup(options: AccountDeletionCleanupOptions = {}): Promise<AccountDeletionCleanupReport> {
  const tally: CleanupFailureTally = new Map();
  const report: AccountDeletionCleanupReport = { retired: [], completed: [], resumeLater: [] };
  try {
    await runTally.run(tally, async () => {
      report.retired = await retireDueAccounts(options);
      const { completed, resumeLater } = await cleanUpRetiredAccounts(options);
      report.completed = completed;
      report.resumeLater = resumeLater;
    });
    return report;
  } finally {
    // Also when the run throws (server.background.error on the span): what failed before it is still counted.
    recordCleanupRun(report, tally);
  }
}

function recordCleanupRun(report: AccountDeletionCleanupReport, tally: CleanupFailureTally): void {
  const failures = [...tally.values()];
  const failedIn = (phase: string) => failures.filter((f) => f.phase === phase).reduce((sum, f) => sum + f.count, 0);
  safeAddTraceEvent("account_deletion.cleanup.finished", () => ({
    retired_count: report.retired.length,
    completed_count: report.completed.length,
    resume_later_count: report.resumeLater.length,
    retire_failed_count: failedIn("retire"),
    after_retire_failed_count: failedIn("after_retire"),
    cleanup_failed_count: failedIn("cleanup"),
  }));
  for (const failure of failures) {
    safeAddTraceEvent("account_deletion.cleanup.step_failed", () => ({
      phase: failure.phase,
      step: failure.step,
      error_class: failure.error_class,
      ...(failure.error_code ? { error_code: failure.error_code } : {}),
      count: failure.count,
    }));
  }
}

/** `effect` is the stable name the trace counts it under; `what` (which may name ids) only goes to the log. */
async function bestEffort(effect: string, what: string, userId: string, run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (err) {
    console.error(`[account-deletion] ${what} for ${userId} failed:`, serializeErrorForLog(err));
    tallyFailure(currentPhase.getStore() ?? "cleanup", effect, err);
    return false;
  }
}

// ─── Phase A ───────────────────────────────────────────────────────────────

type NewOwnerNotice = { email: string; name: string; server: { name: string; slug: string } };
/** A shared Server the person paid for: its owner is prompted to check billing after hand-over. */
type BillingEndingNotice = { serverId: string; ownerUserId: string; server: { name: string; slug: string }; cancelScheduled: boolean };
type DeletedServer = { serverId: string; stripeSubscriptionId: string | null; announced: boolean };
type RoleTransition = { targetUserId: string; result: ServerMemberRoleTransitionResult };

type RetiredAccount = {
  userId: string;
  /** Read before the scrub, for the last email. */
  oldEmail: string;
  oldName: string;
  /** Read before the scrub: the image is deleted after commit when nobody else shows it. */
  oldAvatarUrl: string | null;
  newOwners: NewOwnerNotice[];
  roleTransitions: RoleTransition[];
  deletedServers: DeletedServer[];
  /** Some app was told `server.member_removed` (announceDepartureToApps): kick delivery after commit. */
  membershipsAnnounced: boolean;
  disposedAgents: DisposedAgents;
  billingEnding: BillingEndingNotice[];
};

/** Phase A for up to `retirementsPerRun` due requests, each in its own transaction. Returns the people retired. */
export async function retireDueAccounts(options: AccountDeletionCleanupOptions = {}): Promise<string[]> {
  const limit = options.retirementsPerRun ?? ACCOUNT_DELETION_RETIREMENTS_PER_RUN;
  const retired: string[] = [];
  // A request whose phase A failed in this run: logged, retried next run, not again now.
  const failed: string[] = [];
  for (let i = 0; i < limit; i += 1) {
    const now = options.now ?? currentDate();
    // Hashed outside the transaction: argon2 is slow on purpose.
    const placeholderPasswordHash = await argon2.hash(randomBytes(32).toString("hex"));
    const attempt: { requestId?: string } = {};
    let outcome: Awaited<ReturnType<typeof retireOneDueAccount>>;
    try {
      outcome = await retireRestartingOnNewPeople(() => getDb().transaction((tx) => retireOneDueAccount(tx, now, placeholderPasswordHash, failed, attempt)));
    } catch (err) {
      if (!attempt.requestId) throw err;
      console.error(`[account-deletion] retiring the account of request ${attempt.requestId} failed:`, serializeErrorForLog(err));
      tallyFailure("retire", "retire_account", err);
      failed.push(attempt.requestId);
      continue;
    }
    if (!outcome) break;
    const account = outcome.retired;
    if (account) {
      retired.push(account.userId);
      await currentPhase.run("after_retire", () => runRetiredEffects(account, options.deps ?? {}));
    }
  }
  return retired;
}

async function retireOneDueAccount(
  tx: DatabaseTransaction,
  now: Date,
  placeholderPasswordHash: string,
  skip: string[],
  attempt: { requestId?: string },
): Promise<{ retired: RetiredAccount | null } | null> {
  const [request] = await tx.select().from(accountDeletionRequests)
    .where(and(
      eq(accountDeletionRequests.state, "pending"),
      lte(accountDeletionRequests.scheduledFor, now),
      isNull(accountDeletionRequests.accountRetiredAt),
      skip.length > 0 ? notInArray(accountDeletionRequests.id, skip) : undefined,
    ))
    .orderBy(asc(accountDeletionRequests.scheduledFor), asc(accountDeletionRequests.id))
    .limit(1)
    .for("update", { skipLocked: true });
  if (!request) return null;
  attempt.requestId = request.id;
  const userId = request.userId;

  // Every users row this retirement names, before any server row: the
  // person's FOR UPDATE, the others (their servers' successors, the owners
  // their agents go to, an ops actor) FOR KEY SHARE, each taken once at that
  // strength in users-id order (lockRetirementUsers). Taken only through the
  // FK checks of the hand-over (servers.owner_id, the role audit's
  // target_user_id) and the agents' new creator_id, after the person's
  // servers FOR UPDATE, a successor's row closed a cycle with that
  // successor's own retirement (two co-owners retiring, each the other's
  // successor). A deletion request locks no server and a joint writer's KEY
  // SHARE is compatible with this one, so neither closes it.
  const named = await peopleRetirementNames(tx, userId, request.source === "ops" ? request.actorUserId : null);
  await lockRetirementUsers(tx, userId, named);
  const lockedUserIds = new Set([userId, ...named]);

  const [person] = await tx.select({
    email: users.email,
    name: users.name,
    displayName: users.displayName,
    avatarUrl: users.avatarUrl,
    retiredAt: users.retiredAt,
  }).from(users).where(eq(users.id, userId)).for("update");
  if (!person || person.retiredAt) {
    // Retired some other way meanwhile: nothing to hand over or scrub here;
    // phase B still deletes the person's data.
    await tx.update(accountDeletionRequests).set({ accountRetiredAt: now }).where(eq(accountDeletionRequests.id, request.id));
    return { retired: null };
  }

  const handover = await handOverOwnedServers(tx, userId, lockedUserIds);
  const membershipsAnnounced = await announceDepartureToApps(tx, userId, now);
  const disposedAgents = await disposeAgentsOfDeletedUser(tx, userId, now, lockedUserIds);
  const billingEnding = await findBillingEnding(tx, userId);

  // A sign-in made during the grace period (it could only read or cancel the request).
  const [{ live }] = await tx.select({ live: sql<number>`count(*)::int` }).from(sessions).where(eq(sessions.userId, userId)) as [{ live: number }];
  await revokeAllUserSessionsInTransaction(tx, userId);
  // Their Login with Raft at every app, in the per-app revoke's order
  // (oauthAccountLogin, #12542: requests, tokens, consents) so no live token
  // outlives its consent. Identity endpoints re-check retired_at, but a route
  // trusting only the token would accept it until the rows go in phase B
  // (Tenny, #triage:d10ace06). The agent grants they approved stay: those are
  // the agents', which phase A hands over.
  await tx.update(oauthAccessRequests).set({ status: "denied", remember: false, resolvedByUserId: userId, resolvedAt: now, updatedAt: now })
    // Pending, or approved with its code not yet exchanged: server-mode exchange
    // does not re-check retirement, so such a code would mint a new token.
    .where(and(eq(oauthAccessRequests.userId, userId), openAccessRequestPredicate()));
  await tx.update(oauthAccessTokens).set({ revokedAt: now })
    .where(and(eq(oauthAccessTokens.userId, userId), isNull(oauthAccessTokens.revokedAt)));
  await tx.update(oauthUserConsents).set({ revokedAt: now, updatedAt: now })
    .where(and(eq(oauthUserConsents.userId, userId), isNull(oauthUserConsents.revokedAt)));

  await tx.update(users).set({
    retiredAt: now,
    retiredReason: ACCOUNT_DELETED_RETIRED_REASON,
    // Rotating trace_user_id unlinks the account from its traces (kept indefinitely).
    traceUserId: sql`gen_random_uuid()`,
    email: deletedUserEmail(userId),
    emailVerified: false,
    name: deletedUserHandle(userId),
    displayName: DELETED_USER_DISPLAY_NAME,
    description: null,
    avatarUrl: null,
    preferredLanguage: null,
    displayLanguage: null,
    preferredTimezone: null,
    firstObservedTimezone: null,
    firstObservedTimezoneAt: null,
    lastObservedTimezone: null,
    lastObservedTimezoneAt: null,
    lastDesktopAppSeenAt: null,
    preferredTimeFormat: null,
    preferredMessageBodyFontSize: null,
    referralSource: null,
    referralSourceOther: null,
    referralSourceSkippedAt: null,
    serverSwitcherOrder: null,
    railTabOrder: null,
    assistantOtterVisible: true,
    assistantOtterShortcut: null,
    composerSendKey: null,
    shortcutOverrides: null,
    // `password_hash` is NOT NULL: an unknowable random hash, as for a social-only signup.
    passwordHash: placeholderPasswordHash,
    passwordCredentialEstablishedAt: null,
    stagingSelfAccountCapabilityHash: null,
    profileSetupSuggestedHandle: null,
    signupRole: null,
    signupSurveyCompletedAt: null,
    firstOnboardingCompletedSessionFamilyId: null,
    // The analytics id is deleted in phase B; nothing may mint a new one.
    analyticsOptedOutAt: now,
    shareUsageData: false,
    secondFactorRequiredAt: null,
    webauthnUserHandle: null,
    updatedAt: now,
  }).where(eq(users.id, userId));

  await tx.insert(userRetirementReceipts).values({
    userId,
    // The person for their own request; the operator for an ops request (the person if that account is gone).
    actorUserId: request.source === "ops" ? (request.actorUserId ?? userId) : userId,
    environment: retirementEnvironment(),
    terminalState: "retired",
    sessionsRevoked: live,
    serverHandoffs: handover.handoffs,
    agentDispositions: disposedAgents.dispositions,
    createdAt: now,
  }).onConflictDoNothing();

  await tx.update(accountDeletionRequests).set({ accountRetiredAt: now }).where(eq(accountDeletionRequests.id, request.id));

  return {
    retired: {
      userId,
      oldEmail: person.email,
      oldName: person.displayName || person.name,
      oldAvatarUrl: person.avatarUrl,
      newOwners: handover.newOwners,
      roleTransitions: handover.roleTransitions,
      deletedServers: handover.deletedServers,
      membershipsAnnounced,
      disposedAgents,
      billingEnding,
    },
  };
}

/**
 * Tells the apps installed in each live server the person belonged to that
 * they are gone (`server.member_removed`, reason `account_deleted`): the
 * membership row stays (history, DMs), so the removal path in serverService
 * never runs, and this is the only signal an app (Raft Deck: deleting the
 * person's agents there) gets (Tenny, #triage:d10ace06). Servers closed with
 * the account were announced by their deletion (`server_deleted`). In the
 * retirement's transaction (the event rows are the outbox); true when any app
 * will be told, so delivery is kicked after commit.
 */
async function announceDepartureToApps(tx: DatabaseTransaction, userId: string, now: Date): Promise<boolean> {
  const memberships = await tx.select({ serverId: serverMembers.serverId, role: serverMembers.role })
    .from(serverMembers)
    .innerJoin(servers, eq(servers.id, serverMembers.serverId))
    .where(and(eq(serverMembers.userId, userId), isNull(servers.deletedAt)));
  let announced = false;
  for (const membership of memberships) {
    const { recipientCount } = await emitAppFacingMemberEvents({
      serverId: membership.serverId,
      eventType: "server.member_removed",
      members: [{ principalType: "human", principalId: userId, role: membership.role }],
      occurredAt: now,
      provenance: { source: "account_deletion", actor_type: "system", reason: "account_deleted" },
    }, tx);
    if (recipientCount > 0) announced = true;
  }
  return announced;
}

/**
 * Who takes over a server from the person: a live human member other than
 * them, never a Guest (agents are not server_members). Another owner first,
 * then an admin, then a member, each the earliest joined; anyone with a
 * pending deletion of their own only when there is no one else.
 */
async function findNewOwner(tx: DatabaseExecutor, serverId: string, userId: string) {
  const [candidate] = await tx.select({
    userId: serverMembers.userId,
    role: serverMembers.role,
    email: users.email,
    name: sql<string>`coalesce(${users.displayName}, ${users.name})`,
  }).from(serverMembers)
    .innerJoin(users, eq(users.id, serverMembers.userId))
    .where(and(
      eq(serverMembers.serverId, serverId),
      ne(serverMembers.userId, userId),
      isNull(users.retiredAt),
      inArray(serverMembers.role, ["owner", "admin", "member"]),
    ))
    .orderBy(
      sql`exists (select 1 from ${accountDeletionRequests} where ${accountDeletionRequests.userId} = ${serverMembers.userId} and ${accountDeletionRequests.state} = 'pending')`,
      sql`case ${serverMembers.role} when 'owner' then 0 when 'admin' then 1 else 2 end`,
      asc(serverMembers.joinedAt),
      asc(serverMembers.userId),
    )
    .limit(1);
  return candidate ?? null;
}

/**
 * Live servers whose live subscription the person paid for
 * (`subscriptions.created_by_user_id`), read after the hand-over so the owner
 * is the one who keeps the server. The request already set them to cancel at
 * period end (requests.ts); one still renewing is set to cancel after commit.
 */
async function findBillingEnding(tx: DatabaseTransaction, userId: string): Promise<BillingEndingNotice[]> {
  const rows = await tx.select({
    serverId: servers.id,
    ownerUserId: servers.ownerId,
    name: servers.name,
    slug: servers.slug,
    cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
  }).from(subscriptions)
    .innerJoin(servers, eq(servers.id, subscriptions.serverId))
    .where(and(
      eq(subscriptions.createdByUserId, userId),
      inArray(subscriptions.status, ["active", "past_due"]),
      isNull(servers.deletedAt),
      ne(servers.ownerId, userId),
    ))
    .orderBy(asc(servers.id));
  return rows.map((row) => ({
    serverId: row.serverId,
    ownerUserId: row.ownerUserId!,
    server: { name: row.name, slug: row.slug },
    cancelScheduled: row.cancelAtPeriodEnd,
  }));
}

/** The people a retirement names, read under its locks, include someone its users lock did not take: restart its transaction. */
class RetirementPeopleChanged extends Error {}

/** A retirement whose people changed between its unlocked read and its locks runs again (twice at most), then fails as any other. */
async function retireRestartingOnNewPeople<T>(retire: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await retire();
    } catch (err) {
      if (!(err instanceof RetirementPeopleChanged) || attempt >= 2) throw err;
    }
  }
}

function ownedServersToHandOver(tx: DatabaseExecutor, userId: string) {
  return tx.select({ id: servers.id, name: servers.name, slug: servers.slug }).from(servers)
    .where(and(eq(servers.ownerId, userId), isNull(servers.deletedAt), ne(servers.kind, "joint_storage")))
    .orderBy(asc(servers.id));
}

/**
 * Everyone other than the person a retirement names, read without a lock:
 * each owned server's successor (findNewOwner), the owners of the other
 * servers the person's agents are handed to (disposeAgentsOfDeletedUser),
 * and an ops request's actor (the retirement receipt). Read again under the
 * locks; one not here restarts the transaction (RetirementPeopleChanged).
 */
async function peopleRetirementNames(tx: DatabaseExecutor, userId: string, opsActorUserId: string | null): Promise<string[]> {
  const ids = new Set<string>();
  for (const server of await ownedServersToHandOver(tx, userId)) {
    const candidate = await findNewOwner(tx, server.id, userId);
    if (candidate) ids.add(candidate.userId);
  }
  const owners = await tx.selectDistinct({ ownerId: servers.ownerId }).from(agents)
    .innerJoin(servers, eq(servers.id, agents.serverId))
    .where(and(
      isNull(agents.deletedAt),
      isNull(servers.deletedAt),
      ne(servers.ownerId, userId),
      eq(agents.creatorType, "user"),
      eq(agents.creatorId, userId),
    ));
  for (const owner of owners) ids.add(owner.ownerId);
  if (opsActorUserId) ids.add(opsActorUserId);
  ids.delete(userId);
  return [...ids];
}

/**
 * The retirement's users rows, each once at its final strength, in users-id
 * order (one statement per row: one statement cannot mix strengths): the
 * person's FOR UPDATE, everyone else's FOR KEY SHARE. Never KEY SHARE first
 * and an upgrade later: two retirements naming each other would each hold
 * the other's KEY SHARE and wait to upgrade. In id order with every other
 * users-first transaction (lockJointUsersFirst), the person's own row taken
 * only at its place in that order.
 */
async function lockRetirementUsers(tx: DatabaseTransaction, userId: string, others: readonly string[]): Promise<void> {
  for (const id of [...new Set([userId, ...others])].sort()) {
    await tx.execute(id === userId
      ? sql`SELECT id FROM users WHERE id = ${id}::uuid FOR UPDATE`
      : sql`SELECT id FROM users WHERE id = ${id}::uuid FOR KEY SHARE`);
  }
}

async function handOverOwnedServers(tx: DatabaseTransaction, userId: string, lockedUserIds: ReadonlySet<string>) {
  const owned = await ownedServersToHandOver(tx, userId).for("update");
  const handoffs: AccountDeletionServerHandoff[] = [];
  const newOwners: NewOwnerNotice[] = [];
  const roleTransitions: RoleTransition[] = [];
  const deletedServers: DeletedServer[] = [];
  for (const server of owned) {
    const candidate = await findNewOwner(tx, server.id, userId);
    // A successor its users lock did not take (chosen differently under the server's lock): restart.
    if (candidate && !lockedUserIds.has(candidate.userId)) throw new RetirementPeopleChanged();
    if (candidate?.role === "owner") {
      await tx.update(servers).set({ ownerId: candidate.userId }).where(eq(servers.id, server.id));
      handoffs.push({ serverId: server.id, outcome: "owner_reassigned", newOwnerUserId: candidate.userId });
    } else if (candidate) {
      const previousRole = candidate.role as "admin" | "member";
      const result = await promoteToOwner(tx, server.id, userId, candidate.userId, previousRole);
      if (result) roleTransitions.push({ targetUserId: candidate.userId, result });
      await tx.update(servers).set({ ownerId: candidate.userId }).where(eq(servers.id, server.id));
      handoffs.push({ serverId: server.id, outcome: "owner_promoted", newOwnerUserId: candidate.userId, previousRole });
      newOwners.push({ email: candidate.email, name: candidate.name, server: { name: server.name, slug: server.slug } });
    } else {
      // Read before the tombstone's commit removes the local billing row.
      const [subscription] = await tx.select({ id: subscriptions.stripeSubscriptionId }).from(subscriptions).where(eq(subscriptions.serverId, server.id));
      const deleted = await softDeleteServerInTransaction(tx, server.id);
      handoffs.push({ serverId: server.id, outcome: "server_deleted" });
      deletedServers.push({ serverId: server.id, stripeSubscriptionId: subscription?.id ?? null, announced: Boolean(deleted?.announced) });
    }
  }
  return { handoffs, newOwners, roleTransitions, deletedServers };
}

/**
 * Makes the chosen member owner as a role transition the departing owner
 * makes (audited and announced to apps like any other). If the departing
 * person's own membership cannot make that transition (no owner role on the
 * server they own: legacy data), the role is set directly with the same
 * audit row, so the hand-over never blocks the deletion.
 */
async function promoteToOwner(
  tx: DatabaseTransaction,
  serverId: string,
  departingUserId: string,
  targetUserId: string,
  previousRole: "admin" | "member",
): Promise<ServerMemberRoleTransitionResult | null> {
  const [departing] = await tx.select({ role: serverMembers.role }).from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, departingUserId)));
  if (departing?.role === "owner") {
    return transitionMemberRoleInTransaction(tx, { serverId, actorUserId: departingUserId, targetUserId, nextRole: "owner", expectedRole: previousRole });
  }
  await tx.update(serverMembers).set({ role: "owner", guestChannelId: null })
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, targetUserId)));
  // As transitionMemberRoleInTransaction: an owner is shown every seat notice.
  await announceSeatJoinBlocksForSeatChange(tx, serverId);
  await tx.execute(sql`
    insert into server_member_role_audit_events (id, server_id, actor_user_id, target_user_id, previous_role, next_role)
    values (gen_random_uuid(), ${serverId}, ${departingUserId}, ${targetUserId}, ${previousRole}, 'owner')
  `);
  return null;
}

type AgentTransferNotice = { toUserId: string; agentId: string; agentName: string; serverId: string; machineCleared: boolean; hosted: boolean };
type DisposedAgents = {
  archived: string[];
  hostedDeletion: boolean;
  transferred: AgentTransferNotice[];
  dispositions: AccountDeletionAgentDisposition[];
};

/**
 * What becomes of the agents a deleted person created and their personal
 * assistants (design §10, artin 2026-11-02, #triage:d10ace06):
 *   - an agent the person created in a server that lives on is handed to that
 *     server's owner (after handOverOwnedServers, so never the person): it
 *     becomes theirs (`creator_id`), stays `stopped` (the new owner decides
 *     whether to start it), keeps its memory and workspace on the server and,
 *     if hosted, its hosted runtime; bound to the person's own Computer (revoked
 *     when the deletion was asked) it is unbound (`daemon_id` null), so the new
 *     owner picks a Computer of their own, and the local workspace on the
 *     person's Computer does not follow;
 *   - a personal assistant is archived: it holds the person's private context;
 *   - an agent whose server was deleted with the account goes with it
 *     (archived, as is one whose server somehow has no owner);
 *   - an agent being migrated or managed by an App installation is left as it
 *     is (stopped when the deletion was asked).
 * Archiving is DELETE /api/agents/:id with the workspace kept: credentials and
 * unused bootstrap tokens revoked, reminders cancelled, hosted runtimes deleted.
 */
export async function disposeAgentsOfDeletedUser(tx: DatabaseTransaction, userId: string, now: Date, lockedUserIds?: ReadonlySet<string>): Promise<DisposedAgents> {
  const rows = await tx.select({
    id: agents.id,
    name: agents.name,
    serverId: agents.serverId,
    machineId: agents.machineId,
    managedBy: agents.managedByAppInstallId,
    assistantOwnerUserId: agents.assistantOwnerUserId,
    serverOwnerId: servers.ownerId,
    serverDeletedAt: servers.deletedAt,
    machineUserId: machines.userId,
    hostedState: agentRuntimeProvisions.state,
  }).from(agents)
    .innerJoin(servers, eq(servers.id, agents.serverId))
    .leftJoin(machines, eq(machines.id, agents.machineId))
    .leftJoin(agentRuntimeProvisions, eq(agentRuntimeProvisions.agentId, agents.id))
    .where(and(
      isNull(agents.deletedAt),
      sql`((${agents.creatorType} = 'user' and ${agents.creatorId} = ${userId}) or ${agents.assistantOwnerUserId} = ${userId})`,
    ))
    .orderBy(asc(agents.id));
  const disposed: DisposedAgents = { archived: [], hostedDeletion: false, transferred: [], dispositions: [] };
  for (const agent of rows) {
    const base = { agentId: agent.id, serverId: agent.serverId };
    if (agent.managedBy) {
      disposed.dispositions.push({ ...base, outcome: "skipped", reason: "app_managed" });
      continue;
    }
    if (await getActiveAgentMigration(agent.id, tx, now)) {
      disposed.dispositions.push({ ...base, outcome: "skipped", reason: "migrating" });
      continue;
    }
    const archiveReason = agent.assistantOwnerUserId === userId ? "personal_assistant"
      : agent.serverDeletedAt ? "server_deleted"
      : !agent.serverOwnerId || agent.serverOwnerId === userId ? "no_owner"
      : null;
    if (archiveReason) {
      await recordAgentArchive(tx, { agentId: agent.id, userId, choice: "keep", now });
      await deleteAgent(agent.id, { executor: tx });
      if (await beginProvisionedAgentDeletion(tx, agent.id, userId)) disposed.hostedDeletion = true;
      disposed.archived.push(agent.id);
      disposed.dispositions.push({ ...base, outcome: "archived", reason: archiveReason });
      continue;
    }
    const toUserId = agent.serverOwnerId!;
    // An owner the retirement's users lock did not take: restart (retireOneDueAccount).
    if (lockedUserIds && !lockedUserIds.has(toUserId)) throw new RetirementPeopleChanged();
    const machineCleared = agent.machineId !== null && agent.machineUserId === userId;
    const hosted = agent.hostedState !== null && agent.hostedState !== "deleting" && agent.hostedState !== "deleted";
    await tx.update(agents).set({
      creatorType: "user",
      creatorId: toUserId,
      status: "stopped",
      updatedAt: now,
      ...(machineCleared ? { machineId: null } : {}),
    }).where(eq(agents.id, agent.id));
    if (machineCleared) await revokeRunnerCredentialsOffMachine(tx, { agentIds: [agent.id], machineId: null, now });
    disposed.transferred.push({ toUserId, agentId: agent.id, agentName: agent.name, serverId: agent.serverId, machineCleared, hosted });
    disposed.dispositions.push({ ...base, outcome: "transferred", toUserId, machineCleared, hosted });
  }
  return disposed;
}

async function runRetiredEffects(retired: RetiredAccount, deps: AccountDeletionCleanupDeps): Promise<void> {
  const { userId } = retired;
  forgetTraceUserId(userId);
  await bestEffort("close_sockets", "closing sockets", userId, () => revokeSocketAccess({ userId }));
  if (retired.membershipsAnnounced) kickAppNotificationDelivery();
  const deleteAvatar = deps.deleteStoredUserAvatar ?? ((url: string | null) => deleteStoredUserAvatarIfUnused(url, isUserAvatarHashStillShown));
  await bestEffort("delete_avatar", "deleting the avatar image", userId, () => deleteAvatar(retired.oldAvatarUrl));
  for (const transition of retired.roleTransitions) {
    await bestEffort("finish_owner_handover", "finishing the owner hand-over", userId, () => finishMemberRoleTransition(transition.targetUserId, transition.result));
  }
  const cancel = deps.cancelStripeSubscription ?? cancelStripeSubscriptionOfDeletedServer;
  for (const server of retired.deletedServers) {
    if (server.announced) kickAppNotificationDelivery();
    deps.io?.to(`server:${server.serverId}`).emit("server:deleted", { serverId: server.serverId });
    const stripeSubscriptionId = server.stripeSubscriptionId;
    if (stripeSubscriptionId) {
      await bestEffort("cancel_subscription", `cancelling the subscription of server ${server.serverId}`, userId, () => cancel(server.serverId, stripeSubscriptionId));
    }
  }
  const { archived, hostedDeletion, transferred, dispositions } = retired.disposedAgents;
  const skipped = dispositions.filter((d) => d.outcome === "skipped").map((d) => d.agentId);
  if (skipped.length > 0) console.error(`[account-deletion] ${skipped.length} agent(s) of ${userId} left as they are (migrating or app-managed): ${skipped.join(", ")}`);
  if (hostedDeletion) kickAgentRuntimeProvisionWorker();
  if (archived.length > 0) kickAppNotificationDelivery();
  for (const agentId of archived) {
    deps.orchestrator?.evictCache(agentId);
    deps.orchestrator?.forgetAgentActivity?.(agentId);
    await bestEffort("close_agent_streams", `closing agent ${agentId}'s streams`, userId, () => broadcastAgentCredentialRevocation(agentId));
  }
  // A handed-over agent's cached row still names the person as its creator.
  for (const notice of transferred) deps.orchestrator?.evictCache(notice.agentId);
  // The last email, to the address the account had (it is scrubbed now).
  if (retired.oldEmail) {
    await bestEffort("deleted_email", "account deleted email", userId, () => sendAccountDeletionEmail(retired.oldEmail, retired.oldName, { kind: "deleted" }));
  }
  for (const notice of retired.newOwners) {
    await bestEffort("new_owner_email", "new owner email", userId, () => sendServerOwnershipHandedOverEmail(notice.email, notice.name, notice.server));
  }
  await bestEffort("agents_handed_over_email", "agents handed over email", userId, () => notifyAgentRecipients(retired.oldName, transferred));
  // The same in the new owner's DM with each agent: the email is easy to miss.
  const handedOver = deps.noticeAgentHandedOver ?? ((notice: AgentTransferNotice, deletedName: string) => deps.io && deps.orchestrator
    ? postAgentActionRequiredNotice(deps.io, deps.orchestrator as AgentOrchestrator, {
      agentId: notice.agentId,
      notice: { kind: "handed_over", deletedName, machineCleared: notice.machineCleared, hosted: notice.hosted },
    })
    : Promise.resolve(false));
  for (const notice of transferred) {
    await bestEffort("handover_notice", `handover notice for agent ${notice.agentId}`, userId, () => handedOver(notice, retired.oldName));
  }
  const cancelAtPeriodEnd = deps.cancelSubscriptionAtPeriodEnd ?? cancelSubscriptionAtPeriodEnd;
  for (const notice of retired.billingEnding) {
    if (!notice.cancelScheduled) {
      await bestEffort("schedule_subscription_cancel", `scheduling the subscription cancellation of server ${notice.serverId}`, userId, () => cancelAtPeriodEnd(notice.serverId, userId));
    }
    await bestEffort("subscription_ending_email", `subscription ending email for server ${notice.serverId}`, userId, async () => {
      const [owner] = await getDb().select({ email: users.email, name: users.name, displayName: users.displayName })
        .from(users).where(and(eq(users.id, notice.ownerUserId), isNull(users.retiredAt)));
      if (owner) await sendSubscriptionEndingAfterDeletionEmail(owner.email, owner.displayName || owner.name, { deletedName: retired.oldName, server: notice.server });
    });
  }
}

/**
 * One email per new owner: "<name> deleted their account; their agents X, Y
 * in <server> are yours now, stopped". The recipient is read now (after
 * commit), so a later change of address or name is honoured.
 */
async function notifyAgentRecipients(deletedName: string, transferred: AgentTransferNotice[]): Promise<void> {
  if (transferred.length === 0) return;
  const byRecipient = new Map<string, AgentTransferNotice[]>();
  for (const notice of transferred) byRecipient.set(notice.toUserId, [...(byRecipient.get(notice.toUserId) ?? []), notice]);
  const recipientIds = [...byRecipient.keys()];
  const serverIds = [...new Set(transferred.map((n) => n.serverId))];
  const db = getDb();
  const people = await db.select({ id: users.id, email: users.email, name: users.name, displayName: users.displayName })
    .from(users).where(and(inArray(users.id, recipientIds), isNull(users.retiredAt)));
  const serverRows = await db.select({ id: servers.id, name: servers.name, slug: servers.slug }).from(servers).where(inArray(servers.id, serverIds));
  const serverById = new Map(serverRows.map((row) => [row.id, row]));
  for (const person of people) {
    const notices = byRecipient.get(person.id) ?? [];
    await sendAgentsHandedOverEmail(person.email, person.displayName || person.name, {
      deletedName,
      agents: notices.flatMap((n) => {
        const server = serverById.get(n.serverId);
        return server ? [{ name: n.agentName, server: { name: server.name, slug: server.slug }, machineCleared: n.machineCleared, hosted: n.hosted }] : [];
      }),
    });
  }
}

// ─── Phase B ───────────────────────────────────────────────────────────────

type StepOutcome = "done" | "more" | "failed";

type CleanupContext = {
  userId: string;
  now: Date;
  batchSize: number;
  /** Batches this request may still run in this run. */
  budget: { batches: number };
  deps: AccountDeletionCleanupDeps;
};

/** `where` with each `$1` bound to the person's id. */
function personWhere(where: string, userId: string): SQL {
  const parts = where.split("$1");
  return sql.join(parts.map((part) => sql.raw(part)), sql`${userId}`);
}

/**
 * Deletes the rows `where` selects, `batchSize` at a time, each batch its
 * own transaction, while the request's budget lasts. Only a batch that
 * deleted something counts against the budget, so a later run walks past
 * the tables already emptied (one index probe each) to where it stopped.
 * "more" when the budget ran out first.
 */
async function deleteInBatches(ctx: CleanupContext, table: string, where: SQL): Promise<StepOutcome> {
  const target = sql.identifier(table);
  for (;;) {
    if (ctx.budget.batches <= 0) return "more";
    const deleted = await getDb().transaction((tx) => tx.execute(sql`
      delete from ${target}
      where ctid = any(array(select ctid from ${target} where ${where} limit ${ctx.batchSize}))
      returning 1
    `));
    if (deleted.rows.length > 0) ctx.budget.batches -= 1;
    if (deleted.rows.length < ctx.batchSize) return "done";
  }
}

async function deleteAtOnce(table: string, where: SQL): Promise<StepOutcome> {
  await getDb().transaction((tx) => tx.execute(sql`delete from ${sql.identifier(table)} where ${where}`));
  return "done";
}

type DeleteStepOverride = {
  /** Replaces `column = $1`. */
  where?: string;
  /** In bounded batches (a big table with an index that leads with the person). */
  batched?: boolean;
  /** Runs after every other step. */
  last?: boolean;
  /** Replaces the plain delete (an external call first). */
  run?: (ctx: CleanupContext) => Promise<StepOutcome>;
};

/** How a `delete` foreign key's rows go, where a plain `DELETE ... WHERE column = person` is not enough. */
const DELETE_STEP_OVERRIDES: Partial<Record<UserForeignKey, DeleteStepOverride>> = {
  "notification_outbox.receiver_id": { where: "receiver_type = 'user' AND receiver_id = $1", batched: true },
  // A redeemed claim stays as the license's audit.
  "appsumo_redemption_claims.user_id": { where: "user_id = $1 AND state <> 'consumed'" },
  // By the person's families (idx_session_token_predecessors_family): a
  // predecessor always belongs to a family of the same person, and no index
  // leads with user_id (~2.3M rows).
  "session_token_predecessors.user_id": { where: "family_id IN (SELECT id FROM session_families WHERE user_id = $1)" },
  // Last: the revoke cascade read the families when the deletion was asked.
  "session_families.user_id": { last: true },
  "newsletter_audience_contacts.user_id": { run: deleteNewsletterContacts },
  "paid_lifecycle_journeys.user_id": { run: deletePaidLifecycleJourney },
  "onboarding_email_journeys.user_id": { run: deleteOnboardingEmailJourneys },
};

/** Each newsletter contact leaves Resend before its row goes; a failure keeps the row for the next run. */
async function deleteNewsletterContacts(ctx: CleanupContext): Promise<StepOutcome> {
  const remove = ctx.deps.deleteResendContact ?? deleteResendContact;
  const rows = await getDb().select({ id: newsletterAudienceContacts.id, email: newsletterAudienceContacts.email, contactId: newsletterAudienceContacts.resendContactId })
    .from(newsletterAudienceContacts).where(eq(newsletterAudienceContacts.userId, ctx.userId));
  let outcome: StepOutcome = "done";
  for (const row of rows) {
    const removed = await bestEffort("delete_newsletter_contact", "deleting the newsletter contact", ctx.userId, () => remove(row.contactId ? { id: row.contactId } : { email: row.email }));
    if (!removed) {
      outcome = "failed";
      continue;
    }
    await getDb().delete(newsletterAudienceContacts).where(eq(newsletterAudienceContacts.id, row.id));
  }
  return outcome;
}

/** The paid-lifecycle Contact leaves Resend before the journey goes (its payments are kept). */
async function deletePaidLifecycleJourney(ctx: CleanupContext): Promise<StepOutcome> {
  const remove = ctx.deps.deleteResendContact ?? deleteResendContact;
  const [journey] = await getDb().select({ contactId: paidLifecycleJourneys.contactId })
    .from(paidLifecycleJourneys).where(eq(paidLifecycleJourneys.userId, ctx.userId));
  if (!journey) return "done";
  const contactId = journey.contactId;
  if (contactId && !await bestEffort("delete_paid_lifecycle_contact", "deleting the paid lifecycle contact", ctx.userId, () => remove({ id: contactId }))) return "failed";
  await getDb().delete(paidLifecycleJourneys).where(eq(paidLifecycleJourneys.userId, ctx.userId));
  return "done";
}

/** A day-1 onboarding email still scheduled at Resend is cancelled before the journey goes. */
async function deleteOnboardingEmailJourneys(ctx: CleanupContext): Promise<StepOutcome> {
  const cancel = ctx.deps.cancelScheduledEmail ?? cancelScheduledEmail;
  const rows = await getDb().select({ id: onboardingEmailJourneys.id, day1EmailId: onboardingEmailJourneys.day1EmailId, day1Status: onboardingEmailJourneys.day1Status, canceledAt: onboardingEmailJourneys.canceledAt })
    .from(onboardingEmailJourneys).where(eq(onboardingEmailJourneys.userId, ctx.userId));
  let outcome: StepOutcome = "done";
  for (const row of rows) {
    const emailId = row.day1EmailId;
    if (emailId && row.day1Status === "scheduled" && !row.canceledAt
      && !await bestEffort("cancel_onboarding_email", "cancelling the scheduled onboarding email", ctx.userId, () => cancel(emailId))) {
      outcome = "failed";
      continue;
    }
    await getDb().delete(onboardingEmailJourneys).where(eq(onboardingEmailJourneys.id, row.id));
  }
  return outcome;
}

/** A keep action may hand back work for after its transaction commits (closing connections, notices). */
type KeepActionRun = (tx: DatabaseTransaction, ctx: CleanupContext) => Promise<void | { afterCommit: () => Promise<void> }>;

/** What ends on the rows the cleanup keeps (tableClassification.ts `action`). Each runs in its own transaction. */
const KEEP_ACTIONS: Record<AccountDeletionKeepAction, KeepActionRun> = {
  expire_pending_invites: async (tx, { userId }) => {
    await tx.execute(sql`update server_invites set status = 'expired' where invited_by_user_id = ${userId} and status = 'pending'`);
    await tx.execute(sql`update joint_channel_invites set status = 'expired' where invited_user_id = ${userId} and status = 'pending'`);
  },
  revoke_active_links: async (tx, { userId, now }) => {
    await tx.execute(sql`update server_join_links set revoked_at = ${now} where created_by_user_id = ${userId} and revoked_at is null`);
    await tx.execute(sql`update oauth_client_share_links set revoked_at = ${now}, updated_at = ${now} where created_by_user_id = ${userId} and revoked_at is null`);
  },
  cancel_pending_connect_requests: async (tx, { userId, now }) => {
    await tx.execute(sql`update channel_server_connect_requests set status = 'cancelled', cancel_reason = 'requester_left', decided_at = ${now} where requester_user_id = ${userId} and status = 'pending'`);
    await tx.execute(sql`update channel_server_connect_requests set status = 'cancelled', cancel_reason = 'approver_lost_role', decided_at = ${now} where approver_user_id = ${userId} and status = 'pending'`);
  },
  // Ended `expired` (the state a card no one answered ends in), on the card row and its message together.
  void_pending_action_cards: async (tx, { userId, now }) => {
    await tx.execute(sql`
      with ended as (
        update action_cards set state = 'expired', dedupe_key = null, updated_at = ${now}
        where requester_user_id = ${userId} and state in ('prepared', 'frozen', 'reconfirm_required')
        returning message_id
      )
      update messages set action_metadata = jsonb_set(action_metadata::jsonb, '{state}', '"expired"')::json, updated_at = ${now}
      where id in (select message_id from ended) and action_metadata is not null
    `);
  },
  revoke_unused_bootstrap_tokens: async (tx, { userId, now }) => {
    await tx.execute(sql`update agent_bootstrap_tokens set revoked_at = ${now}, revoked_reason = ${REVOKED_REASON} where issued_by_user_id = ${userId} and revoked_at is null and consumed_at is null`);
  },
  revoke_app_maintainer: async (tx, { userId, now }) => {
    await tx.execute(sql`update oauth_client_maintainers set revoked_at = ${now} where user_id = ${userId} and revoked_at is null`);
  },
  // Every key revoked and host details cleared, and after commit the
  // connections close. The Computers themselves are deleted by the last step
  // (deleteComputersOfDeletedUser), which also tells the owners of agents
  // still on them. The same Computers as the request revoked (every one the
  // person attached, every one on their machines; requests.ts
  // revokeComputersOfDeletedAccount): a repair, anything already revoked is
  // left as it is.
  revoke_daemons: async (tx, { userId, now }) => {
    const { reach } = await revokeComputersOfDeletedAccount(tx, { userId, actorUserId: null, now });
    // A hash nothing verifies against: the legacy machine key is dead.
    await tx.execute(sql`
      update daemons set api_key_hash = ${`revoked:${REVOKED_REASON}`}, hostname = null, os = null, os_release = null,
        os_id = null, os_id_like = null, host_provider = null, device_class = null
      where user_id = ${userId}
    `);
    await tx.execute(sql`delete from computer_host_identities where daemon_id in (select id from daemons where user_id = ${userId})`);
    return {
      afterCommit: async () => {
        await bestEffort("close_computer_connections", "closing the Computers' connections", userId, () => closeDeviceSessionKeys(reach));
      },
    };
  },
  // Computer owner v1 (#wg-rbac:#32): Computers the person owns, on any server, become Public; each audited.
  clear_computer_ownership: async (tx, { userId }) => {
    await clearComputerOwnershipOf(tx, { userId, serverId: null, reason: "owner_account_deleted", actorUserId: null });
  },
  // The membership stays (history, DMs); the person's own view settings go.
  reset_member_preferences: async (tx, { userId }) => {
    await tx.update(serverMembers).set({
      theme: null,
      themeDecor: true,
      sidebarChannelOrder: null,
      sidebarAgentOrder: null,
      sidebarDmOrder: null,
      sidebarChannelSortMode: "manual",
      sidebarJointChannelSortMode: "manual",
      sidebarDmSortMode: "manual",
      sidebarPinnedSortMode: "manual",
      pinnedRefs: null,
      pinnedChannelIds: null,
      pinnedAgentIds: null,
      pinnedOrder: null,
      hiddenDmIds: null,
      channelPanelTabOrder: null,
      agentPanelTabOrder: null,
      channelSideLayout: null,
      sidebarCustomSections: null,
      sidebarSectionOrder: null,
      sidebarSectionPlacements: null,
      serverSwitcherOrder: null,
      serverPushMode: "all",
      setupModalReminderOptOut: false,
    }).where(eq(serverMembers.userId, userId));
  },
  revoke_push_registrations: async (tx, { userId, now }) => {
    await tx.execute(sql`update push_registrations set revoked_at = ${now}, revoked_reason = ${REVOKED_REASON}, revoked_user_id = ${userId} where user_id = ${userId} and revoked_at is null`);
  },
};

type CleanupStep = { name: string; run: (ctx: CleanupContext) => Promise<StepOutcome> };

/**
 * The person's Computers are deleted, as the app's "Delete Computer" does
 * (machineService.deleteMachine; artin 2026-11-02, #triage:d10ace06). Their
 * keys were revoked when the deletion was asked and by `revoke_daemons`, and
 * their own agents were unbound and handed over in phase A. Per Computer, in
 * one transaction: other members' agents still on it are unbound and stopped;
 * runtime-profile rows naming it for agents no longer on it are deleted (a
 * snapshot rebuilt at the next start elsewhere, not the agent's settings;
 * Tenny); then deleteMachine. After commit those agents' owners hear that the
 * Computer was deleted. A move still under way to or from it (requests.ts
 * fails transfer-active ones at request time) leaves that Computer for the
 * next run.
 */
async function deleteComputersOfDeletedUser(ctx: CleanupContext): Promise<StepOutcome> {
  const { userId, now, deps } = ctx;
  const owned = await getDb().select({ id: machines.id, name: machines.name, serverId: machines.serverId })
    .from(machines).where(eq(machines.userId, userId));
  let pending = false;
  for (const machine of owned) {
    let unbound: string[] = [];
    try {
      unbound = await getDb().transaction(async (tx) => {
        const bound = await unbindAndStopAgents(tx, { machineIds: [machine.id], now });
        // Only rows naming this Computer, for live agents no longer on it (all of them, after the unbind above).
        // Each profile's agent is probed by primary key (EXISTS), not by
        // listing every live agent elsewhere; the OR below reads the
        // per-column machine indexes.
        await tx.delete(agentRuntimeProfiles).where(and(
          sql`exists (
            select 1 from ${agents}
            where ${agents.id} = ${agentRuntimeProfiles.agentId}
              and ${agents.deletedAt} is null
              and (${agents.machineId} is null or ${agents.machineId} <> ${machine.id})
          )`,
          or(
            eq(agentRuntimeProfiles.machineId, machine.id),
            eq(agentRuntimeProfiles.baselineMachineId, machine.id),
            eq(agentRuntimeProfiles.pendingBeforeMachineId, machine.id),
            eq(agentRuntimeProfiles.pendingAfterMachineId, machine.id),
          ),
        ));
        await deleteMachine(machine.id, { executor: tx });
        return bound;
      });
    } catch (err) {
      if (err instanceof MachineDeleteConflictError && err.code === "MACHINE_HAS_ACTIVE_MIGRATION") {
        pending = true;
        continue;
      }
      console.error(`[account-deletion] deleting Computer ${machine.id} of ${userId} failed:`, err);
      tallyFailure("cleanup", "delete_computers", err);
      return "failed";
    }
    if (unbound.length === 0) continue;
    // The server passes its real orchestrator (server.ts); the deps type is narrowed for tests.
    const notice = deps.noticeDetachedComputer
      ?? ((computer: DetachedComputer, agentIds: readonly string[]) => noticeOwnersOfDetachedComputer(deps.io, deps.orchestrator as AgentOrchestrator | null | undefined, computer, { agentIds, removed: true }));
    await bestEffort("notice_computer_deleted", `telling owners Computer ${machine.id} was deleted`, userId,
      () => notice({ machineId: machine.id, serverId: machine.serverId, computerName: machine.name }, unbound));
  }
  return pending ? "more" : "done";
}

/** Phase B's steps, from the classification: external calls first, then what is kept, then every table to delete from. */
export function accountDeletionCleanupSteps(): CleanupStep[] {
  const external: CleanupStep[] = [];
  const deletes: CleanupStep[] = [];
  const last: CleanupStep[] = [];
  const keepActions = new Set<AccountDeletionKeepAction>();
  for (const [key, classification] of Object.entries(USER_FOREIGN_KEY_CLASSIFICATION) as Array<[UserForeignKey, (typeof USER_FOREIGN_KEY_CLASSIFICATION)[UserForeignKey]]>) {
    if ("action" in classification && classification.action) keepActions.add(classification.action);
    if (classification.cleanup !== "delete") continue;
    const [table, column] = key.split(".") as [string, string];
    const override = DELETE_STEP_OVERRIDES[key] ?? {};
    const custom = override.run;
    if (custom) {
      external.push({ name: key, run: custom });
      continue;
    }
    const where = override.where ?? `${column} = $1`;
    const step: CleanupStep = {
      name: key,
      run: (ctx) => override.batched
        ? deleteInBatches(ctx, table, personWhere(where, ctx.userId))
        : deleteAtOnce(table, personWhere(where, ctx.userId)),
    };
    (override.last ? last : deletes).push(step);
  }
  const keeps: CleanupStep[] = [...keepActions].map((action) => ({
    name: action,
    run: async (ctx) => {
      const after = await getDb().transaction((tx) => KEEP_ACTIONS[action](tx, ctx));
      if (after) await after.afterCommit();
      return "done" as const;
    },
  }));
  const noForeignKey: CleanupStep[] = USER_NO_FOREIGN_KEY_PERSONAL_TABLES.map((entry) => ({
    name: entry.table,
    run: (ctx) => entry.batched
      ? deleteInBatches(ctx, entry.table, personWhere(entry.where, ctx.userId))
      : deleteAtOnce(entry.table, personWhere(entry.where, ctx.userId)),
  }));
  // The Computers go after the keys are revoked (keeps) and the person's rows are gone, and before `last` (session_families stays last).
  return [...external, ...keeps, ...noForeignKey, ...deletes, { name: "delete_computers", run: deleteComputersOfDeletedUser }, ...last];
}

/**
 * Phase B for up to `cleanupsPerRun` retired accounts whose request is still
 * pending, each under a lease. Completes the requests whose every step is
 * done; the rest resume in a later run.
 */
export async function cleanUpRetiredAccounts(options: AccountDeletionCleanupOptions = {}): Promise<{ completed: string[]; resumeLater: string[] }> {
  const now = options.now ?? currentDate();
  const leaseUntil = new Date(now.getTime() + CLEANUP_LEASE_MS);
  const claimed = await getDb().transaction(async (tx) => {
    const due = await tx.select({ id: accountDeletionRequests.id }).from(accountDeletionRequests)
      .where(and(
        eq(accountDeletionRequests.state, "pending"),
        lte(accountDeletionRequests.scheduledFor, now),
        isNotNull(accountDeletionRequests.accountRetiredAt),
        or(isNull(accountDeletionRequests.cleanupLeaseUntil), lte(accountDeletionRequests.cleanupLeaseUntil, now)),
      ))
      .orderBy(asc(accountDeletionRequests.accountRetiredAt), asc(accountDeletionRequests.id))
      .limit(options.cleanupsPerRun ?? ACCOUNT_DELETION_CLEANUPS_PER_RUN)
      .for("update", { skipLocked: true });
    if (due.length === 0) return [];
    return tx.update(accountDeletionRequests).set({ cleanupLeaseUntil: leaseUntil })
      .where(inArray(accountDeletionRequests.id, due.map((row) => row.id)))
      .returning({ id: accountDeletionRequests.id, userId: accountDeletionRequests.userId });
  });

  const steps = accountDeletionCleanupSteps();
  const completed: string[] = [];
  const resumeLater: string[] = [];
  for (const request of claimed) {
    const ctx: CleanupContext = {
      userId: request.userId,
      now,
      batchSize: options.batchSize ?? ACCOUNT_DELETION_BATCH_SIZE,
      budget: { batches: options.batchesPerRequest ?? ACCOUNT_DELETION_BATCHES_PER_REQUEST },
      deps: options.deps ?? {},
    };
    let finished = true;
    for (const step of steps) {
      let outcome: StepOutcome;
      try {
        outcome = await currentPhase.run("cleanup", () => step.run(ctx));
      } catch (err) {
        console.error(`[account-deletion] cleanup step ${step.name} for ${request.userId} failed:`, serializeErrorForLog(err));
        tallyFailure("cleanup", step.name, err);
        outcome = "failed";
      }
      if (outcome !== "done") finished = false;
      // Out of budget: the rest waits for the next run (the steps already done are cheap to repeat).
      if (outcome === "more") break;
    }
    if (finished) {
      await getDb().update(accountDeletionRequests)
        .set({ state: "completed", completedAt: currentDate(), cleanupLeaseUntil: null, cancelTokenHash: null })
        .where(and(eq(accountDeletionRequests.id, request.id), eq(accountDeletionRequests.state, "pending")));
      completed.push(request.userId);
    } else {
      await getDb().update(accountDeletionRequests).set({ cleanupLeaseUntil: null }).where(eq(accountDeletionRequests.id, request.id));
      resumeLater.push(request.userId);
    }
  }
  return { completed, resumeLater };
}
