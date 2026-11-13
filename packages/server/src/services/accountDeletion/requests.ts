/**
 * Account deletion requests (design "删除账号：服务端设计 v1" §2, §3, §5, §6):
 * a person asks to delete their account; it waits `pending` for the grace
 * period and the cleanup (a later change) retires it. The web, the app and
 * the ops entry all go through requestAccountDeletionInTransaction, so the
 * rules and the record are the same whoever asks.
 *
 * Requesting, in one transaction under the person's `users` row lock:
 *   1. already pending: answer that request (idempotent), change nothing;
 *   2. sole owner of a server that has other members: answer the servers
 *      (409 `sole_owner_servers`), change nothing;
 *   3. someone else's agent still on one of their live Computers, not named
 *      in `forceAgentIds`: answer those agents (409
 *      `others_agents_on_computers`, the full fresh list), change nothing
 *      (artin/Tenny 2026-11-04, #triage:d10ace06). When the person names
 *      every one of them (force), the request goes ahead and unbinds and
 *      stops them in this transaction (not deleted; one audit record
 *      `account.deletion_unbound_others_agents` per server they are in,
 *      written to that server's audit), and each owner gets a
 *      `computer_detached` system notice after commit. The request revokes the
 *      person's Computer keys (step 5), so such an agent would go offline and
 *      could no longer be moved (a move copies its workspace from the source
 *      Computer). The person cannot move it: they ask its owner to
 *      (POST /notify-agent-owners, ownerNotices.ts), and the owner moves or
 *      deletes it. A server owner or admin acts only with the permissions
 *      they already have: a personal assistant whose person is still a
 *      member they can only stop, and moving an agent needs the Pro plan
 *      (Warden). Otherwise the person forces the request. The person's own
 *      agents and personal assistants do not block, nor do their Computers
 *      as such (Tenny 2026-11-02): the cleanup removes them when the grace
 *      period ends. The person's machine rows are locked FOR UPDATE before
 *      this check (lockOwnMachines), and their keys are revoked in this same
 *      transaction, so no agent is bound to one of them between the check
 *      and the revoke: binding an agent to a machine (create, a move's
 *      flip) writes `agents.daemon_id`, whose foreign key check takes
 *      FOR KEY SHARE on the machine row and so waits for this lock; and
 *      create then refuses a machine whose key is revoked
 *      (computerAgents.ts lockMachineTakingAgents). Revoking one Computer's
 *      key from the web is gated the same way (routes/servers.ts), so
 *      detaching it first does not get around this step;
 *   4. insert the pending request;
 *   5. revoke every session family `revoke_all` and delete every session
 *      (revokeAllUserSessionsInTransaction), the requesting sign-in's own
 *      family included: the response is the last thing that sign-in gets.
 *      Signing in again during the grace period gives a session that can only
 *      read or cancel the request (middleware/auth.ts), so nothing has to be
 *      kept alive here, and a stolen session that asked cannot stay signed in.
 *      The person's WeChat bridges go too (bindings with their bot tokens,
 *      QR attempts; wechatBridgeCleanup), so nothing mirrors to WeChat;
 *      and every key of the person, their Computers' included, is revoked
 *      (revokeAllKeysOfPerson), committing with the request: every Computer
 *      they attached, on any server and on anyone's machine (as leaving the
 *      server does), and every Computer on their own machines;
 *   6. read what to do after commit: the agents the person created and their
 *      personal assistants (to stop), and the servers only they are a member
 *      of with a live Stripe subscription (to cancel at period end).
 * After commit, each step best effort and logged (the request stands either
 * way; hourly maintenance repairs the security revoke from state, since the
 * families are revoked `revoke_all`): close sockets, revoke the keys device
 * logins' sessions handed out, run the security-revoke cascade (keys and
 * Computers the sessions issued or approved; no generic notice email for this
 * trigger), stop the agents (a manual stop persists `stopped`, which no
 * message wakes), tell the owners of the agents on a Computer revoked on
 * someone else's machine (as leaving a server tells them), schedule the subscriptions' cancellation (a separate, Server-fenced
 * mutation transaction after the deletion request committed), and send the "scheduled for deletion" email.
 *
 * Cancelling marks the request `cancelled` and sends a confirmation email.
 * Nothing that was revoked or stopped comes back: the person starts their
 * agents and reattaches their Computers themselves. The "scheduled for
 * deletion" email also carries a one-time link that cancels that request
 * without signing in (cancelAccountDeletionByLink): it only cancels, never
 * signs in, and works until the request's `scheduled_for`. Only its HMAC
 * lookup hash is stored (`cancel_token_hash`); the raw token goes into that
 * email once.
 *
 * A person with no request is never touched by any of this: auth reads the
 * pending row (none) in the query it already makes.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { currentDate } from "@botiverse/raft-shared";

import { getDb, type DatabaseExecutor } from "../../db/index";
import { failAgentMigrationsForDeletedComputerOwner } from "../agentMigrationService";
import { accountDeletionRequests, agentCredentials, agentRuntimeProvisions, agents, computers, machines, servers, serverMembers, subscriptions, users, type AccountDeletionSubscriptionSnapshot, type SubscriptionRestorationResult } from "../../db/schema";
import { revokeSocketAccess } from "../../socket/accessRevocation";
import { serializeErrorForLog } from "../../tracing/safeErrorLog";
import { computeTokenLookupHash } from "../agentCredentialService";
import { cancelSubscriptionForAccountDeletion, resumeSubscriptionAfterCancelledDeletion } from "../billingService";
import { closeDeviceSessionKeys, revokeKeysOfRevokedDeviceSessions, type DeviceSessionKeyReach } from "../deviceSessionKeys";
import { revokeComputerKeyInTransaction, type DetachedComputer } from "../computerKeyRevocation";
import { sendAccountDeletionEmail, type AccountDeletionEmailEvent } from "../emailService";
import { runSecurityRevokeCascade } from "../securityRevokeCascade";
import { revokeAllUserSessionsInTransaction } from "../sessionService";
import { removeWeChatBridgeOfDeletedAccount } from "../wechatBridgeCleanup";
import { newAuditOperationId, recordIntegrationAuditEvent } from "../integrationAuditService";
import { findAgentsBoundToMachines, unbindAndStopAgents, type AgentOwner } from "../computerAgents";
import { ownerNotifyTimes, readOwnerNotifiedAt, withOwnerNotifyTimes } from "./ownerNotices";

/** How long a request waits before the account is deleted, unless ACCOUNT_DELETION_GRACE_DAYS says otherwise. */
export const ACCOUNT_DELETION_GRACE_DAYS = 7;

/** The grace period in days: ACCOUNT_DELETION_GRACE_DAYS from the environment when it is a positive integer, else the default. */
export function accountDeletionGraceDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ACCOUNT_DELETION_GRACE_DAYS?.trim();
  if (raw && /^[1-9][0-9]{0,3}$/.test(raw)) return Number(raw);
  return ACCOUNT_DELETION_GRACE_DAYS;
}

export type AccountDeletionRequestRow = typeof accountDeletionRequests.$inferSelect;

export type AccountDeletionStatus = (
  | { status: "none"; requestId?: string; subscriptionRestoration?: SubscriptionRestorationResult }
  | { status: "scheduled"; requestId: string; requestedAt: string; scheduledFor: string; subscriptionCancellationUnconfirmed?: true }
) & { cancellationReceipt?: { requestId: string; subscriptionRestoration: SubscriptionRestorationResult } };

/** A server the person must hand over (or delete) before their account can be deleted. */
export type SoleOwnerServer = { id: string; name: string; slug: string; memberCount: number };

/** A server the person owns and is the only live member of: it is closed when the account is deleted. */
export type SoleMemberServer = { id: string; name: string; slug: string };

/**
 * A server that lives on after the deletion whose subscription the person
 * pays for (`subscriptions.created_by_user_id`: they checked out, so the
 * Stripe payment method is theirs): set to cancel at the end of the period
 * when the deletion is asked, so renewal is scheduled to stop.
 */
export type PaidServerEndingAtPeriodEnd = { id: string; name: string; slug: string; periodEnd: string | null };

/**
 * One of the person's own Computers (`daemons.user_id`) still attached, with
 * the live agents bound to it. The cleanup detaches it when the grace period
 * ends; detaching it earlier is optional. `ownedByMe` marks the agents they
 * created or that are their personal assistants (they may move or archive
 * those first). Someone else's agent on it blocks the request (409
 * `others_agents_on_computers`) until it is moved, or until the person
 * forces the request (`forceAgentIds`: it is unbound). It carries its
 * `owner` (computerAgents.ts agentOwnerSql: null when there is nobody to ask),
 * `personalAssistant`, `ownerNotifiedAt` (when this person last asked that
 * owner to move it) and `ownerNextNotifyAt` (when they may ask again; null:
 * now) (ownerNotices.ts).
 */
export type AttachedComputer = {
  id: string;
  name: string;
  server: { id: string; name: string; slug: string };
  agents: AttachedComputerAgent[];
};

export type AttachedComputerAgent =
  | { id: string; name: string; ownedByMe: true }
  | ({ id: string; name: string; ownedByMe: false } & OthersAgentOwnership);

/** Who is asked to move someone else's agent (agentOwnerSql), and when this person last asked. */
export type OthersAgentOwnership = {
  owner: AgentOwner | null;
  personalAssistant: boolean;
  ownerNotifiedAt: string | null;
  ownerNextNotifyAt: string | null;
};

export type { AgentOwner } from "../computerAgents";

/**
 * Someone else's agent bound to one of the person's live Computers: it blocks
 * the request (409 `others_agents_on_computers`). Only what the person needs
 * to ask its owner to move it.
 */
export type OthersAgentOnComputer = {
  id: string;
  name: string;
  server: { id: string; name: string; slug: string };
  computer: { id: string; name: string };
} & OthersAgentOwnership;

/**
 * What the cleanup will do with one of the person's agents (cleanup.ts
 * disposeAgentsOfDeletedUser), as known now: handed to the server's owner
 * (`toUser` null while the person still owns that server: whoever they hand
 * it to), archived (a personal assistant), or closed with a server only they
 * are in.
 */
export type AgentDeletionPreview = {
  id: string;
  name: string;
  server: { id: string; name: string; slug: string };
  outcome: "transfer_to_owner" | "archive_personal_assistant" | "closes_with_server";
  toUser: { id: string; name: string } | null;
};

function hasUnconfirmedSubscriptionCancellation(row: Pick<AccountDeletionRequestRow, "cancelledSubscriptionSnapshots" | "cancelledSubscriptionServerIds">): boolean {
  if (row.cancelledSubscriptionSnapshots === null) return (row.cancelledSubscriptionServerIds?.length ?? 0) > 0;
  return Object.values(row.cancelledSubscriptionSnapshots).some(proof => proof.canceledAt === null || !Number.isSafeInteger(proof.canceledAt) || proof.canceledAt < 0);
}

export function scheduledStatus(row: Pick<AccountDeletionRequestRow, "id" | "requestedAt" | "scheduledFor" | "cancelledSubscriptionSnapshots" | "cancelledSubscriptionServerIds">): AccountDeletionStatus {
  return { status: "scheduled", requestId: row.id, requestedAt: row.requestedAt.toISOString(), scheduledFor: row.scheduledFor.toISOString(),
    ...(hasUnconfirmedSubscriptionCancellation(row) ? { subscriptionCancellationUnconfirmed: true as const } : {}),
  };
}

export async function findPendingAccountDeletion(executor: DatabaseExecutor, userId: string): Promise<AccountDeletionRequestRow | null> {
  const [row] = await executor.select().from(accountDeletionRequests)
    .where(and(eq(accountDeletionRequests.userId, userId), eq(accountDeletionRequests.state, "pending")))
    .limit(1);
  return row ?? null;
}

export function subscriptionRestorationResult(results: Record<string, SubscriptionRestorationResult> | null): SubscriptionRestorationResult {
  if (results === null || Object.values(results).some((value) => value === "unknown")) return "unknown";
  return Object.values(results).some((value) => value === "not_restored") ? "not_restored" : "restored";
}

export async function getAccountDeletionStatus(userId: string, executor: DatabaseExecutor = getDb(), requestId?: string): Promise<AccountDeletionStatus> {
  let receipt: { requestId: string; subscriptionRestoration: SubscriptionRestorationResult } | undefined;
  if (requestId) {
    const [record] = await executor.select().from(accountDeletionRequests)
      .where(and(eq(accountDeletionRequests.id, requestId), eq(accountDeletionRequests.userId, userId))).limit(1);
    if (record?.state === "cancelled") receipt = { requestId: record.id, subscriptionRestoration: subscriptionRestorationResult(record.subscriptionRestorationResults) };
  }
  // A receipt for A is not a claim that the account has no newer request B.
  const pending = await findPendingAccountDeletion(executor, userId);
  if (pending) return { ...scheduledStatus(pending), ...(receipt ? { cancellationReceipt: receipt } : {}) };
  return { status: "none", ...(receipt ?? (requestId ? { subscriptionRestoration: "unknown" as const } : {})) };
}

/**
 * GET /api/me/account/deletion: the status plus what the "before you delete"
 * page lists: `soleOwnerServers` (must be handed over first, as the 409 on
 * POST), `soleMemberServers` (closed with the account) and
 * `paidServersEndingAtPeriodEnd` (shared servers whose subscription the
 * person pays for: it stops at the end of the period), and `computers`
 * (their Computers still attached: the cleanup detaches them).
 */
export async function getAccountDeletionOverview(userId: string, executor: DatabaseExecutor = getDb(), requestId?: string): Promise<AccountDeletionStatus & {
  soleOwnerServers: SoleOwnerServer[];
  soleMemberServers: SoleMemberServer[];
  paidServersEndingAtPeriodEnd: PaidServerEndingAtPeriodEnd[];
  agents: AgentDeletionPreview[];
  computers: AttachedComputer[];
  /** Days a request made now would wait (Kirby's confirm button shows the date). */
  graceDays: number;
}> {
  const [status, soleOwnerServers, soleMemberServers, paid, liveComputers] = await Promise.all([
    getAccountDeletionStatus(userId, executor, requestId),
    findSoleOwnerServers(executor, userId),
    findSoleMemberServers(executor, userId),
    findPaidSharedServers(executor, userId),
    findAttachedComputers(executor, userId),
  ]);
  const attachedComputers = await withOwnerNotifiedAt(userId, liveComputers);
  const agentPreview = await previewAgentsOfDeletedUser(executor, userId, new Set(soleMemberServers.map((server) => server.id)));
  return {
    ...status,
    soleOwnerServers,
    soleMemberServers,
    agents: agentPreview,
    computers: attachedComputers,
    graceDays: accountDeletionGraceDays(),
    paidServersEndingAtPeriodEnd: paid.map(({ id, name, slug, periodEnd }) => ({ id, name, slug, periodEnd: periodEnd?.toISOString() ?? null })),
  };
}

async function previewAgentsOfDeletedUser(executor: DatabaseExecutor, userId: string, closingServerIds: Set<string>): Promise<AgentDeletionPreview[]> {
  const rows = await executor.select({
    id: agents.id,
    name: agents.name,
    displayName: agents.displayName,
    assistantOwnerUserId: agents.assistantOwnerUserId,
    serverId: servers.id,
    serverName: servers.name,
    serverSlug: servers.slug,
    ownerId: servers.ownerId,
    ownerName: sql<string | null>`(select coalesce(${users.displayName}, ${users.name}) from ${users} where ${users.id} = ${servers.ownerId})`,
  }).from(agents)
    .innerJoin(servers, eq(servers.id, agents.serverId))
    .where(and(
      isNull(agents.deletedAt),
      isNull(servers.deletedAt),
      isNull(agents.managedByAppInstallId),
      sql`((${agents.creatorType} = 'user' and ${agents.creatorId} = ${userId}) or ${agents.assistantOwnerUserId} = ${userId})`,
    ))
    .orderBy(servers.name, agents.name, agents.id);
  return rows.map((row) => {
    const outcome = row.assistantOwnerUserId === userId ? "archive_personal_assistant" as const
      : closingServerIds.has(row.serverId) ? "closes_with_server" as const
      : "transfer_to_owner" as const;
    const toUser = outcome === "transfer_to_owner" && row.ownerId && row.ownerId !== userId && row.ownerName
      ? { id: row.ownerId, name: row.ownerName } : null;
    return { id: row.id, name: row.displayName || row.name, server: { id: row.serverId, name: row.serverName, slug: row.serverSlug }, outcome, toUser };
  });
}

/**
 * Servers with other live members whose live subscription the person pays
 * for (PaidServerEndingAtPeriodEnd), whether or not it is already set to cancel.
 */
export async function findPaidSharedServers(executor: DatabaseExecutor, userId: string) {
  return executor.select({
    id: servers.id,
    name: servers.name,
    slug: servers.slug,
    periodEnd: subscriptions.currentPeriodEnd,
    stripeSubscriptionId: subscriptions.stripeSubscriptionId,
    cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
  }).from(subscriptions)
    .innerJoin(servers, eq(servers.id, subscriptions.serverId))
    .where(and(
      eq(subscriptions.createdByUserId, userId),
      inArray(subscriptions.status, ["active", "past_due"]),
      isNull(servers.deletedAt),
      sql`${liveMemberCount(outerServerId)} > 1`,
    ))
    .orderBy(servers.name, servers.id);
}

/** Live (not retired) members of the server named by `serverId` (an outer column), the person themself included. */
function liveMemberCount(serverId: SQL) {
  return sql<number>`(
    select count(*)::int from ${serverMembers}
    join ${users} on ${users.id} = ${serverMembers.userId}
    where ${serverMembers.serverId} = ${serverId} and ${users.retiredAt} is null
  )`;
}

/** `servers.id`, table-qualified even where drizzle would print a bare column (a single-table select list). */
const outerServerId = sql`${sql.identifier("servers")}.${sql.identifier("id")}`;

/**
 * The servers the person is the sole owner of while others are members: they
 * own it (`servers.owner_id`), it is not deleted, no other live member has the
 * owner role, and some other live member exists. A server only they are in is
 * not one (it goes with the account).
 */
export async function findSoleOwnerServers(executor: DatabaseExecutor, userId: string): Promise<SoleOwnerServer[]> {
  const otherLiveMember = (roleOwner: boolean) => sql`exists (
    select 1 from ${serverMembers}
    join ${users} on ${users.id} = ${serverMembers.userId}
    where ${serverMembers.serverId} = ${outerServerId}
      and ${serverMembers.userId} <> ${userId}
      and ${users.retiredAt} is null
      ${roleOwner ? sql`and ${serverMembers.role} = 'owner'` : sql``}
  )`;
  const rows = await executor.select({
    id: servers.id,
    name: servers.name,
    slug: servers.slug,
    memberCount: liveMemberCount(outerServerId),
  }).from(servers)
    .where(and(
      eq(servers.ownerId, userId),
      isNull(servers.deletedAt),
      sql`not ${otherLiveMember(true)}`,
      otherLiveMember(false),
    ))
    .orderBy(servers.name, servers.id);
  return rows.map((row) => ({ ...row, memberCount: Number(row.memberCount) }));
}

/**
 * Servers the person owns (`servers.owner_id`, not deleted) and is the only
 * live member of: the cleanup deletes them (cleanup.ts handOverOwnedServers).
 */
export async function findSoleMemberServers(executor: DatabaseExecutor, userId: string): Promise<SoleMemberServer[]> {
  return executor.select({ id: servers.id, name: servers.name, slug: servers.slug }).from(servers)
    .where(and(
      eq(servers.ownerId, userId),
      isNull(servers.deletedAt),
      ne(servers.kind, "joint_storage"),
      sql`${liveMemberCount(outerServerId)} <= 1`,
    ))
    .orderBy(servers.name, servers.id);
}

/**
 * The person's own Computers (`daemons.user_id`) still attached, in servers
 * not deleted. Removing a Computer deletes its `daemons` row; revoking its key
 * soft-revokes its `computers` rows (`revoked_at`) and keeps the machine. So a
 * machine is attached while its row exists, the cleanup has not revoked it
 * (`api_key_hash` 'revoked:...'), and it has a live `computers` row or none at
 * all (a legacy `sk_machine_*` machine, attached by its own key). Each with the
 * live agents bound to it (`agents.daemon_id`).
 */
export async function findAttachedComputers(executor: DatabaseExecutor, userId: string): Promise<AttachedComputer[]> {
  const machineId = sql`${sql.identifier("daemons")}.${sql.identifier("id")}`;
  const rows = await executor.select({
    id: machines.id,
    name: machines.name,
    serverId: servers.id,
    serverName: servers.name,
    serverSlug: servers.slug,
  }).from(machines)
    .innerJoin(servers, eq(servers.id, machines.serverId))
    .where(and(
      eq(machines.userId, userId),
      isNull(servers.deletedAt),
      sql`${machines.apiKeyHash} not like 'revoked:%'`,
      sql`(
        not exists (select 1 from ${computers} where ${computers.machineId} = ${machineId})
        or exists (select 1 from ${computers} where ${computers.machineId} = ${machineId} and ${computers.revokedAt} is null)
      )`,
    ))
    .orderBy(servers.name, machines.name, machines.id);
  if (rows.length === 0) return [];
  const bound = await findAgentsBoundToMachines(executor, rows.map((row) => row.id), userId);
  const byMachine = new Map<string, AttachedComputerAgent[]>();
  for (const agent of bound) {
    const list = byMachine.get(agent.machineId) ?? [];
    list.push(agent.ownedByActor
      ? { id: agent.id, name: agent.name, ownedByMe: true }
      : {
        id: agent.id,
        name: agent.name,
        ownedByMe: false,
        owner: agent.owner,
        personalAssistant: agent.personalAssistant,
        ownerNotifiedAt: null,
        ownerNextNotifyAt: null,
      });
    byMachine.set(agent.machineId, list);
  }
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    server: { id: row.serverId, name: row.serverName, slug: row.serverSlug },
    agents: byMachine.get(row.id) ?? [],
  }));
}

/**
 * Someone else's agents on the person's live Computers (findAttachedComputers,
 * `ownedByMe` false), each with its Computer and server. `ownerNotifiedAt` is
 * null here: it lives outside the database (ownerNotices.ts) and is read
 * outside any transaction (withOwnerNotifiedAt / othersAgentsWithOwnerNotifiedAt).
 */
export async function findOthersAgentsOnComputers(executor: DatabaseExecutor, userId: string): Promise<OthersAgentOnComputer[]> {
  const result: OthersAgentOnComputer[] = [];
  for (const computer of await findAttachedComputers(executor, userId)) {
    for (const agent of computer.agents) {
      if (agent.ownedByMe) continue;
      result.push({
        id: agent.id,
        name: agent.name,
        server: computer.server,
        computer: { id: computer.id, name: computer.name },
        owner: agent.owner,
        personalAssistant: agent.personalAssistant,
        ownerNotifiedAt: null,
        ownerNextNotifyAt: null,
      });
    }
  }
  return result;
}

/** The attached Computers with the notice times filled in for someone else's agents. */
async function withOwnerNotifiedAt(userId: string, attached: AttachedComputer[]): Promise<AttachedComputer[]> {
  const ids = attached.flatMap((computer) => computer.agents.filter((agent) => !agent.ownedByMe).map((agent) => agent.id));
  if (ids.length === 0) return attached;
  const nowMs = currentDate().getTime();
  const notified = await readOwnerNotifiedAt(userId, ids, nowMs);
  return attached.map((computer) => ({
    ...computer,
    agents: computer.agents.map((agent) => agent.ownedByMe ? agent : { ...agent, ...ownerNotifyTimes(notified.get(agent.id), nowMs) }),
  }));
}

/** The blocking agents with the notice times filled in (outside any transaction: it reads Redis). */
export async function othersAgentsWithOwnerNotifiedAt(userId: string, list: OthersAgentOnComputer[]): Promise<OthersAgentOnComputer[]> {
  if (list.length === 0) return list;
  return withOwnerNotifyTimes(userId, list, currentDate().getTime());
}

/**
 * Locks every machine row of the person (`daemons.user_id`) FOR UPDATE, in id
 * order, before the request checks what is bound to them: a concurrent bind
 * of an agent to one of them (its `agents.daemon_id` foreign key check takes
 * FOR KEY SHARE on the machine row) either committed before this lock, so the
 * check sees it, or waits until the request has committed and the machine's
 * key is revoked.
 */
async function lockOwnMachines(tx: DatabaseExecutor, userId: string): Promise<void> {
  await tx.select({ id: machines.id }).from(machines)
    .where(eq(machines.userId, userId))
    .orderBy(machines.id)
    .for("update");
}

/**
 * Every key of the person, revoked with the request (Tenny 2026-11-02,
 * #triage:d10ace06; v7 "keys stop working at once"), whoever issued it: each
 * Computer they attached and each on their machines
 * (revokeComputersOfDeletedAccount, with what those minted), their legacy
 * machine keys, and the agent keys of their agents and
 * those they created. Not a provider-held key (a hosted runtime's: no person
 * ever saw it, and the agent is handed over working). Cancelling does not
 * restore them: the person reattaches. Connections close after commit.
 */
async function revokeAllKeysOfPerson(tx: DatabaseExecutor, input: { userId: string; actorUserId: string | null; now: Date }): Promise<{ reach: DeviceSessionKeyReach; detachedComputers: DetachedComputer[] }> {
  const { userId, now } = input;
  const revoked = await revokeComputersOfDeletedAccount(tx, input);
  const reach = { agentIds: new Set(revoked.reach.agentIds), machineIds: new Set(revoked.reach.machineIds) };
  const legacy = await tx.update(machines).set({ apiKeyHash: `revoked:${ACCOUNT_DELETION_KEY_REVOKE_REASON}` })
    .where(and(eq(machines.userId, userId), sql`${machines.apiKeyHash} not like 'revoked:%'`))
    .returning({ id: machines.id });
  for (const row of legacy) reach.machineIds.add(row.id);
  // Two UPDATEs, not one with `agent_id IN (...) OR created_by_user_id = $1`:
  // the OR could use neither index and scanned all of agent_credentials
  // (~5M rows; 15 s and a rolled-back request on production, 2026-11-05).
  // Each one below reads through its own index; a key both cover is revoked
  // by the first and skipped by the second (revoked_at is set).
  const theirAgentIds = (await tx.select({ id: agents.id }).from(agents).where(or(
    and(eq(agents.creatorType, "user"), eq(agents.creatorId, userId)),
    eq(agents.assistantOwnerUserId, userId),
  ))).map((row) => row.id);
  const notProviderHeld = sql`not exists (
    select 1 from ${agentRuntimeProvisions} where ${agentRuntimeProvisions.credentialId} = ${agentCredentials.id}
  )`;
  const revokedKeys = [
    ...(theirAgentIds.length === 0 ? [] : await tx.update(agentCredentials)
      .set({ revokedAt: now, revokedReason: ACCOUNT_DELETION_KEY_REVOKE_REASON })
      .where(and(isNull(agentCredentials.revokedAt), inArray(agentCredentials.agentId, theirAgentIds), notProviderHeld))
      .returning({ agentId: agentCredentials.agentId })),
    ...await tx.update(agentCredentials)
      .set({ revokedAt: now, revokedReason: ACCOUNT_DELETION_KEY_REVOKE_REASON })
      .where(and(isNull(agentCredentials.revokedAt), eq(agentCredentials.createdByUserId, userId), notProviderHeld))
      .returning({ agentId: agentCredentials.agentId }),
  ];
  for (const row of revokedKeys) reach.agentIds.add(row.agentId);
  return { reach: { agentIds: [...reach.agentIds], machineIds: [...reach.machineIds] }, detachedComputers: revoked.detachedComputers };
}

/**
 * Live Computers the person attached on a machine someone else owns: the
 * request revokes them and tells their agents' owners after commit
 * (`detachedComputers`). Read-only; the operator script refuses on these.
 */
export async function findAttachedComputersOnOthersMachines(executor: DatabaseExecutor, userId: string): Promise<Array<{ computerId: string; machineId: string }>> {
  const rows = await executor.select({ computerId: computers.id, machineId: computers.machineId }).from(computers)
    .innerJoin(machines, eq(machines.id, computers.machineId))
    .where(and(eq(computers.attachedByUserId, userId), isNull(computers.revokedAt), ne(machines.userId, userId)))
    .orderBy(computers.id);
  return rows.flatMap((row) => (row.machineId ? [{ computerId: row.computerId, machineId: row.machineId }] : []));
}

/**
 * The Computers revoked with an account's deletion, as their "Revoke Computer
 * key" does (computerKeyRevocation.ts): the key and what its machine minted,
 * each audited. Two selections, either one enough:
 *   - every live Computer the person attached (`attached_by_user_id`), on any
 *     server and whoever's machine it is: an account being deleted leaves
 *     every server, so this is what leaving or being removed does
 *     (serverService.ts removeMemberInTransaction), audited the same way
 *     (`via: "member_removed"`, `departureReason: "account_deleted"`, the
 *     request's actor);
 *   - every live Computer on the person's own machines (`daemons.user_id`),
 *     whoever attached it: those machines are deleted when the grace period
 *     ends (cleanup.ts deleteComputersOfDeletedUser), so nothing may keep
 *     running on them; audited as before (`via: "web_session_revoked"`).
 * A Computer in both is revoked once, under the first. `detachedComputers`:
 * the revoked Computers on someone else's machine, whose agents' owners are
 * told after commit (the person's own machines go through the
 * others-agents gate instead). Run when the deletion is asked, and again by
 * the cleanup (repairs anything still live; already revoked ones are no-ops).
 */
export async function revokeComputersOfDeletedAccount(
  tx: DatabaseExecutor,
  input: { userId: string; actorUserId: string | null; now: Date },
): Promise<{ reach: DeviceSessionKeyReach; detachedComputers: DetachedComputer[] }> {
  const { userId, now } = input;
  const reach = { agentIds: new Set<string>(), machineIds: new Set<string>() };
  const detachedComputers: DetachedComputer[] = [];
  const operationId = newAuditOperationId();
  const attached = await tx.select({ id: computers.id, machineUserId: machines.userId }).from(computers)
    .leftJoin(machines, eq(machines.id, computers.machineId))
    .where(and(eq(computers.attachedByUserId, userId), isNull(computers.revokedAt)))
    .orderBy(computers.id);
  for (const computer of attached) {
    const result = await revokeComputerKeyInTransaction(tx, {
      computerId: computer.id,
      by: { via: "member_removed", actorUserId: input.actorUserId, actorRole: null, departureReason: "account_deleted" },
      now,
      operationId,
    });
    for (const agentId of result?.reach.agentIds ?? []) reach.agentIds.add(agentId);
    for (const machineId of result?.reach.machineIds ?? []) reach.machineIds.add(machineId);
    if (result?.detached && computer.machineUserId !== userId) detachedComputers.push(result.detached);
  }
  const onTheirMachines = await tx.select({ id: computers.id }).from(computers)
    .innerJoin(machines, eq(machines.id, computers.machineId))
    .where(and(eq(machines.userId, userId), isNull(computers.revokedAt)))
    .orderBy(computers.id);
  for (const computer of onTheirMachines) {
    const result = await revokeComputerKeyInTransaction(tx, { computerId: computer.id, by: { via: "web_session_revoked", trigger: "account_deletion_requested" }, now });
    for (const agentId of result?.reach.agentIds ?? []) reach.agentIds.add(agentId);
    for (const machineId of result?.reach.machineIds ?? []) reach.machineIds.add(machineId);
  }
  return { reach: { agentIds: [...reach.agentIds], machineIds: [...reach.machineIds] }, detachedComputers };
}

/** `revoked_reason` of the keys revoked when a deletion is requested. */
export const ACCOUNT_DELETION_KEY_REVOKE_REASON = "account_deletion_requested";

/** Servers the person owns and is the only live member of, with a live Stripe subscription. Provider state decides whether it needs cancellation. */
async function findSoleMemberSubscribedServers(executor: DatabaseExecutor, userId: string) {
  return executor.select({ serverId: servers.id, stripeSubscriptionId: subscriptions.stripeSubscriptionId }).from(servers)
    .innerJoin(subscriptions, eq(subscriptions.serverId, servers.id))
    .where(and(
      eq(servers.ownerId, userId),
      isNull(servers.deletedAt),
      sql`${liveMemberCount(outerServerId)} <= 1`,
      inArray(subscriptions.status, ["active", "past_due"]),
    ));
}

/** The agents to stop: the ones the person created and their personal assistants, not deleted and not already stopped. */
/** The person's agents the request stops (not deleted, not already stopped). */
export async function findAgentsToStop(executor: DatabaseExecutor, userId: string): Promise<string[]> {
  const rows = await executor.select({ id: agents.id }).from(agents)
    .where(and(
      isNull(agents.deletedAt),
      ne(agents.status, "stopped"),
      sql`((${agents.creatorType} = 'user' and ${agents.creatorId} = ${userId}) or ${agents.assistantOwnerUserId} = ${userId})`,
    ));
  return rows.map((row) => row.id);
}

export type RequestAccountDeletionInput = {
  userId: string;
  source: "self" | "ops";
  /** Who acted: the person themself for `self`, the operator for `ops`. */
  actorUserId: string | null;
  /** The support ticket, required for `ops`. */
  ticketRef?: string | null;
  /**
   * Someone else's agents on the person's Computers to unbind rather than be
   * refused for: every blocking agent must be named; ids no longer blocking
   * are ignored.
   */
  forceAgentIds?: readonly string[];
  now?: Date;
};

/** Someone else's agent unbound by a forced request: its owner (if any) is told after commit. */
export type UnboundOthersAgent = { agentId: string; ownerUserId: string | null; computerName: string };

/** What runs once the request has committed (runAccountDeletionRequestedEffects). */
export type AccountDeletionRequestedEffects = {
  requestId: string;
  subscriptionSnapshots: Record<string, AccountDeletionSubscriptionSnapshot>;
  userId: string;
  email: string;
  name: string;
  scheduledFor: Date;
  agentIds: string[];
  /** Subscriptions to set to cancel at period end: servers closed with the account, and shared servers the person pays for. */
  subscriptionServerIds: string[];
  /** For the "requested" email: the shared servers the person pays for. */
  paidServersEnding: { name: string; periodEnd: Date | null }[];
  /** The Computer and agent keys revoked with the request: their connections close after commit. */
  keyReach?: DeviceSessionKeyReach;
  /** For the "requested" email only: the raw one-time cancel token (issueAccountDeletionCancelToken); null when none could be issued. */
  cancelToken: string | null;
  /** Someone else's agents the request unbound (forceAgentIds): their owners are told. */
  unboundAgents?: UnboundOthersAgent[];
  /** Computers the person attached on someone else's machine, revoked with the request: their agents' owners are told. */
  detachedComputers?: DetachedComputer[];
};

export type RequestAccountDeletionOutcome =
  | { kind: "conflict"; code: "sole_owner_servers"; servers: SoleOwnerServer[] }
  | { kind: "conflict"; code: "others_agents_on_computers"; agents: OthersAgentOnComputer[] }
  | { kind: "scheduled"; request: AccountDeletionRequestRow; effects: AccountDeletionRequestedEffects | null };

export class AccountDeletionUnavailableError extends Error {
  constructor() {
    super("The account is not active");
    this.name = "AccountDeletionUnavailableError";
  }
}

// FOR UPDATE, not FOR NO KEY UPDATE: the request has to conflict with the
// FOR KEY SHARE that a joint self_connect (lockJointUsersFirst) and a
// retirement's successor lock (lockRetirementUsers) take on this row, so either
// one waits for the request and then sees it (refused / settled), as the
// accountRetirementLockOrder and jointMemberConnectLockOrder real-PG tests
// prove. FOR NO KEY UPDATE does not conflict with FOR KEY SHARE, so both went
// ahead of a pending request. It still waits on the deletion restoration's
// FOR NO KEY UPDATE (accountDeletionBilling.realPg.test.ts).
async function lockActivePerson(tx: DatabaseExecutor, userId: string): Promise<{ email: string; name: string }> {
  const [user] = await tx.select({ email: users.email, displayName: users.displayName, name: users.name, retiredAt: users.retiredAt })
    .from(users).where(eq(users.id, userId)).for("update");
  if (!user || user.retiredAt) throw new AccountDeletionUnavailableError();
  return { email: user.email, name: user.displayName || user.name };
}

/**
 * Steps 1-6 above, in the caller's transaction (re-authentication may have
 * opened it: withSecondFactorAnswer runs this as its action, so a right
 * code and the request commit together). Never throws for a conflict: the
 * caller's transaction still commits what it owns (a used code), and the
 * request changes nothing. `effects` is null when the request already
 * existed (nothing new to revoke, stop or mail).
 */
export async function requestAccountDeletionInTransaction(tx: DatabaseExecutor, input: RequestAccountDeletionInput): Promise<RequestAccountDeletionOutcome> {
  const now = input.now ?? currentDate();
  const { userId } = input;
  if (input.source === "ops" && !input.ticketRef) throw new Error("requestAccountDeletion: an ops request needs its ticket");
  const person = await lockActivePerson(tx, userId);

  const existing = await findPendingAccountDeletion(tx, userId);
  if (existing) return { kind: "scheduled", request: existing, effects: null };

  const soleOwner = await findSoleOwnerServers(tx, userId);
  if (soleOwner.length > 0) return { kind: "conflict", code: "sole_owner_servers", servers: soleOwner };

  await lockOwnMachines(tx, userId);
  const othersAgents = await findOthersAgentsOnComputers(tx, userId);
  const forced = new Set(input.forceAgentIds ?? []);
  if (othersAgents.some((agent) => !forced.has(agent.id))) return { kind: "conflict", code: "others_agents_on_computers", agents: othersAgents };

  const scheduledFor = new Date(now.getTime() + accountDeletionGraceDays() * 24 * 60 * 60_000);
  const paidShared = await findPaidSharedServers(tx, userId);
  // Recheck every candidate at the provider: a failed previous projection may
  // still say cancelled after Stripe restored renewal. Already-cancelled live
  // subscriptions return no proof and never become this request's to resume.
  // Capture each ID in the same read that selects its Server. A concurrent
  // Server deletion can remove the local subscription before effects run;
  // keep that selected intent unconfirmed instead of forgetting it.
  const selectedSubscriptions = [
    ...paidShared.map((row) => ({ serverId: row.id, stripeSubscriptionId: row.stripeSubscriptionId })),
    ...await findSoleMemberSubscribedServers(tx, userId),
  ];
  const subscriptionSnapshots = Object.fromEntries(selectedSubscriptions.map((row) => [row.serverId, {
    stripeSubscriptionId: row.stripeSubscriptionId, canceledAt: null,
  }]));
  const subscriptionServerIds = Object.keys(subscriptionSnapshots);
  const cancelLink = issueAccountDeletionCancelToken(userId);
  const [request] = await tx.insert(accountDeletionRequests).values({
    userId,
    source: input.source,
    actorUserId: input.actorUserId,
    ticketRef: input.ticketRef ?? null,
    requestedAt: now,
    scheduledFor,
    state: "pending",
    // Older backends must not blindly resume a new request by Server id.
    cancelledSubscriptionServerIds: [],
    cancelledSubscriptionSnapshots: subscriptionSnapshots,
    cancelTokenHash: cancelLink?.lookupHash ?? null,
  }).returning();

  await revokeAllUserSessionsInTransaction(tx, userId);
  await removeWeChatBridgeOfDeletedAccount(tx, { userId, actorUserId: input.actorUserId });
  // Their Computers' keys go with those sessions, so a move to or from one can
  // never finish: fail it now, with its own reason (Tenny, #triage:d10ace06),
  // rather than leave it blocking the Computer's deletion at expiry.
  const ownMachines = await tx.select({ id: machines.id }).from(machines).where(eq(machines.userId, userId));
  await failAgentMigrationsForDeletedComputerOwner(tx, ownMachines.map((row) => row.id), now);
  const unboundAgents = await unbindForcedAgents(tx, { userId, actorUserId: input.actorUserId, source: input.source, agents: othersAgents, now });
  const { reach: keyReach, detachedComputers } = await revokeAllKeysOfPerson(tx, { userId, actorUserId: input.actorUserId, now });

  return {
    kind: "scheduled",
    request: request!,
    effects: {
      requestId: request!.id,
      subscriptionSnapshots,
      userId,
      email: person.email,
      name: person.name,
      scheduledFor,
      agentIds: await findAgentsToStop(tx, userId),
      subscriptionServerIds,
      paidServersEnding: paidShared.map((row) => ({ name: row.name, periodEnd: row.periodEnd })),
      keyReach,
      cancelToken: cancelLink?.token ?? null,
      unboundAgents,
      detachedComputers,
    },
  };
}

/**
 * The forced request's step (artin/Tenny, #triage:d10ace06): someone else's
 * agents still on the person's live Computers (all of them named in
 * `forceAgentIds`, checked under the machine lock) are unbound and stopped,
 * not deleted. One audit record per server they are in, written to that
 * server (its owners and admins see it on its audit page; Tenny, Warden),
 * naming only that server's agents and machines. Their owners are told after
 * commit.
 */
async function unbindForcedAgents(
  tx: DatabaseExecutor,
  input: { userId: string; actorUserId: string | null; source: "self" | "ops"; agents: OthersAgentOnComputer[]; now: Date },
): Promise<UnboundOthersAgent[]> {
  if (input.agents.length === 0) return [];
  const machineIds = [...new Set(input.agents.map((agent) => agent.computer.id))];
  const unbound = new Set(await unbindAndStopAgents(tx, { machineIds, agentIds: input.agents.map((agent) => agent.id), now: input.now, release: "forced_by_computer_owner" }));
  const agentsUnbound = input.agents.filter((agent) => unbound.has(agent.id));
  const byServer = new Map<string, OthersAgentOnComputer[]>();
  for (const agent of agentsUnbound) byServer.set(agent.server.id, [...byServer.get(agent.server.id) ?? [], agent]);
  for (const [serverId, serverAgents] of byServer) {
    await recordIntegrationAuditEvent({
      serverId,
      eventType: "account.deletion_unbound_others_agents",
      outcome: "success",
      source: input.source === "ops" ? "system" : "web",
      actor: input.actorUserId ? { type: "human", id: input.actorUserId } : { type: "system" },
      requester: { type: "human", id: input.userId },
      target: { type: "user", id: input.userId },
      metadata: {
        agentIds: serverAgents.map((agent) => agent.id),
        machineIds: [...new Set(serverAgents.map((agent) => agent.computer.id))],
      },
    }, tx);
  }
  return agentsUnbound.map((agent) => ({ agentId: agent.id, ownerUserId: agent.owner?.id ?? null, computerName: agent.computer.name }));
}

export type AccountDeletionEffectDeps = {
  resumeSubscription?: (serverId: string, userId: string, snapshot?: AccountDeletionSubscriptionSnapshot) => Promise<SubscriptionRestorationResult>;
  /** Stops one agent (the orchestrator's manual stop); absent where there is no orchestrator. */
  stopAgent?: (agentId: string) => Promise<unknown>;
  /** Overridable for tests; production schedules the Stripe cancellation. */
  cancelSubscriptionAtPeriodEnd?: (serverId: string, userId: string, stripeSubscriptionId: string, requestId: string) => Promise<AccountDeletionSubscriptionSnapshot | null>;
  /** Tells the owner of someone else's agent the request unbound (a system notice); absent where there is no socket server. */
  noticeUnboundAgent?: (agent: UnboundOthersAgent & { ownerUserId: string }) => Promise<unknown>;
  /** Tells the owners of the agents on a Computer the request revoked on someone else's machine (computerDetachedNotices.ts); absent where there is no socket server. */
  noticeDetachedComputers?: (computers: readonly DetachedComputer[], departedUserId: string) => Promise<unknown>;
};

async function bestEffort(what: string, userId: string, run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (err) {
    console.error(`[account-deletion] ${what} for ${userId} failed:`, serializeErrorForLog(err));
    return false;
  }
}

/** The after-commit half of a new request; never throws (the request has committed). */
export async function runAccountDeletionRequestedEffects(effects: AccountDeletionRequestedEffects, deps: AccountDeletionEffectDeps = {}): Promise<void> {
  const { userId } = effects;
  await bestEffort("closing sockets", userId, () => revokeSocketAccess({ userId }));
  await bestEffort("revoking device sessions' keys", userId, () => revokeKeysOfRevokedDeviceSessions({ userId }));
  await bestEffort("security-revoke cascade", userId, () => runSecurityRevokeCascade({ userId }, "account_deletion_requested"));
  if (effects.keyReach) await bestEffort("closing revoked keys' connections", userId, () => closeDeviceSessionKeys(effects.keyReach!));
  const stopAgent = deps.stopAgent;
  if (stopAgent) {
    for (const agentId of effects.agentIds) {
      await bestEffort(`stopping agent ${agentId}`, userId, () => stopAgent(agentId));
    }
  } else if (effects.agentIds.length > 0) {
    console.error(`[account-deletion] no orchestrator to stop ${effects.agentIds.length} agent(s) of ${userId}`);
  }
  for (const agent of effects.unboundAgents ?? []) {
    if (!agent.ownerUserId) continue;
    const { ownerUserId } = agent;
    if (deps.noticeUnboundAgent) await bestEffort(`telling the owner of agent ${agent.agentId} it was unbound`, userId, () => deps.noticeUnboundAgent!({ ...agent, ownerUserId }));
    else console.error(`[account-deletion] no notifier to tell the owner of agent ${agent.agentId} it was unbound`);
  }
  const detached = effects.detachedComputers ?? [];
  if (detached.length > 0) {
    if (deps.noticeDetachedComputers) await bestEffort("telling the owners of agents on the revoked Computers", userId, () => deps.noticeDetachedComputers!(detached, userId));
    else console.error(`[account-deletion] no notifier to tell the owners of agents on ${detached.length} revoked Computer(s) of ${userId}`);
  }
  const cancel = deps.cancelSubscriptionAtPeriodEnd ?? cancelSubscriptionForAccountDeletion;
  for (const [serverId, selected] of Object.entries(effects.subscriptionSnapshots)) {
    await bestEffort(`scheduling the subscription cancellation of server ${serverId}`, userId, async () => {
      const [before] = await getDb().select({ state: accountDeletionRequests.state, snapshots: accountDeletionRequests.cancelledSubscriptionSnapshots })
        .from(accountDeletionRequests).where(and(eq(accountDeletionRequests.id, effects.requestId), eq(accountDeletionRequests.userId, userId))).limit(1);
      if (before?.state !== "pending" || before.snapshots?.[serverId]?.canceledAt !== null) return;
      const proof = await cancel(serverId, userId, selected.stripeSubscriptionId, effects.requestId);
      if (!proof || proof.stripeSubscriptionId !== selected.stripeSubscriptionId || proof.canceledAt === null || !Number.isSafeInteger(proof.canceledAt)) return;
      // Store the actual response, not a local timestamp. Never overwrite a
      // proof another invocation already recorded. The capture transaction has released its locks before this proof is recorded.
      const snapshots = accountDeletionRequests.cancelledSubscriptionSnapshots;
      const [saved] = await getDb().update(accountDeletionRequests).set({
        cancelledSubscriptionSnapshots: sql`jsonb_set(${snapshots}, ARRAY[${serverId}], ${JSON.stringify(proof)}::jsonb, false)`,
      }).where(and(
        eq(accountDeletionRequests.id, effects.requestId), eq(accountDeletionRequests.userId, userId),
        sql`${snapshots}->${serverId}->>'stripeSubscriptionId' = ${selected.stripeSubscriptionId}`,
        sql`${snapshots}->${serverId}->'canceledAt' = 'null'::jsonb`,
      )).returning({ state: accountDeletionRequests.state });
      // The user may undo deletion while Stripe is answering. Once the proof
      // lands, compensate only that same cancellation with the normal guards.
      if (saved?.state === "cancelled") {
        const outcome = await (deps.resumeSubscription ?? resumeSubscriptionAfterCancelledDeletion)(serverId, userId, proof);
        await recordSubscriptionRestoration(effects.requestId, serverId, outcome, proof);
      }
    });
  }
  const stillPending = await findPendingAccountDeletion(getDb(), userId);
  if (stillPending?.id === effects.requestId) await notify(effects.email, effects.name, userId, {
    kind: "requested", scheduledFor: effects.scheduledFor, paidServersEnding: effects.paidServersEnding,
    subscriptionCancellationUnconfirmed: hasUnconfirmedSubscriptionCancellation(stillPending), cancelToken: effects.cancelToken ?? undefined,
  });
}

async function notify(email: string, name: string, userId: string, event: AccountDeletionEmailEvent): Promise<void> {
  if (!email) return;
  await bestEffort(`${event.kind} email`, userId, () => sendAccountDeletionEmail(email, name, event));
}

/**
 * Request in a transaction of its own, then run the after-commit half. For
 * callers that re-authenticated beforehand (a recent sign-in or password
 * re-authentication) and for the ops entry.
 */
export async function requestAccountDeletion(
  input: RequestAccountDeletionInput,
  deps: AccountDeletionEffectDeps & { inTransaction?: (tx: DatabaseExecutor) => Promise<void> } = {},
): Promise<RequestAccountDeletionOutcome> {
  const outcome = await getDb().transaction(async (tx) => {
    await deps.inTransaction?.(tx);
    return requestAccountDeletionInTransaction(tx, input);
  });
  if (outcome.kind === "scheduled" && outcome.effects) await runAccountDeletionRequestedEffects(outcome.effects, deps);
  return outcome;
}

async function recordSubscriptionRestoration(requestId: string, serverId: string, result: SubscriptionRestorationResult, snapshot: AccountDeletionSubscriptionSnapshot | undefined): Promise<void> {
  const snapshots = accountDeletionRequests.cancelledSubscriptionSnapshots;
  const results = accountDeletionRequests.subscriptionRestorationResults;
  await getDb().update(accountDeletionRequests).set({
    subscriptionRestorationResults: sql`jsonb_set(COALESCE(${results}, '{}'::jsonb), ARRAY[${serverId}], ${JSON.stringify(result)}::jsonb, true)`,
  }).where(and(
    eq(accountDeletionRequests.id, requestId), eq(accountDeletionRequests.state, "cancelled"),
    // An incomplete-proof result may finish after the late provider response
    // has arrived. It must not overwrite the outcome for that newer proof.
    snapshot === undefined ? isNull(snapshots) : and(
      sql`${snapshots}->${serverId}->>'stripeSubscriptionId' = ${snapshot.stripeSubscriptionId}`,
      sql`${snapshots}->${serverId}->'canceledAt' = ${JSON.stringify(snapshot.canceledAt)}::jsonb`,
    ),
  ));
}

/**
 * Cancel the person's pending request (DELETE /api/me/account/deletion, and
 * the emailed link through cancelAccountDeletionByLink): `cancelled` with its
 * time, its cancel link voided, then a confirmation email. No request: nothing
 * happens. The account route separately re-reads the current state: a newer
 * pending request must never be reported as none. With `byLink`, only
 * the request that link belongs to, and only before its `scheduled_for`.
 */
export async function cancelAccountDeletion(
  input: { userId: string; requestId?: string; now?: Date; byLink?: { cancelTokenHash: Buffer } },
  deps: { resumeSubscription?: (serverId: string, userId: string, snapshot?: AccountDeletionSubscriptionSnapshot) => Promise<SubscriptionRestorationResult> } = {},
): Promise<{ cancelled: boolean; requestId?: string; subscriptionNotResumed?: true; subscriptionRestoration?: SubscriptionRestorationResult }> {
  const now = input.now ?? currentDate();
  const { userId } = input;
  const result = await getDb().transaction(async (tx) => {
    const person = await lockActivePerson(tx, userId);
    const pending = await findPendingAccountDeletion(tx, userId);
    const targetIds = pending?.cancelledSubscriptionSnapshots === null
      ? pending.cancelledSubscriptionServerIds ?? [] : Object.keys(pending?.cancelledSubscriptionSnapshots ?? {});
    const initialResults: Record<string, SubscriptionRestorationResult> = Object.fromEntries(targetIds.map((id) => [id, "unknown"]));
    const cancelled = await tx.update(accountDeletionRequests)
      .set({ state: "cancelled", cancelledAt: now, cancelTokenHash: null, subscriptionRestorationResults: initialResults })
      .where(and(
        eq(accountDeletionRequests.userId, userId),
        eq(accountDeletionRequests.state, "pending"),
        input.requestId ? eq(accountDeletionRequests.id, input.requestId) : undefined,
        input.byLink ? eq(accountDeletionRequests.cancelTokenHash, input.byLink.cancelTokenHash) : undefined,
        input.byLink ? gt(accountDeletionRequests.scheduledFor, now) : undefined,
      ))
      .returning({ id: accountDeletionRequests.id, subscriptionServerIds: accountDeletionRequests.cancelledSubscriptionServerIds, snapshots: accountDeletionRequests.cancelledSubscriptionSnapshots });
    return { person, cancelled: cancelled[0] ?? null };
  });
  if (!result.cancelled) return { cancelled: false };
  // Set the subscriptions this request set to cancel renewing again (Tenny,
  // #triage:d10ace06); one that fails is named in the email to turn back on.
  const resume = deps.resumeSubscription ?? resumeSubscriptionAfterCancelledDeletion;
  const notResumed: string[] = [];
  const targets = result.cancelled.snapshots === null
    ? (result.cancelled.subscriptionServerIds ?? []).map((serverId) => ({ serverId, snapshot: undefined }))
    : Object.entries(result.cancelled.snapshots).map(([serverId, snapshot]) => ({ serverId, snapshot: snapshot ?? { stripeSubscriptionId: "", canceledAt: null } }));
  for (const { serverId, snapshot } of targets) {
    const outcome: SubscriptionRestorationResult = await resume(serverId, userId, snapshot).catch(() => {
      console.error("[account-deletion] subscription restoration outcome unknown", { serverId, userId });
      return "unknown" as const;
    });
    await bestEffort(`recording the subscription restoration of server ${serverId}`, userId, () => recordSubscriptionRestoration(result.cancelled!.id, serverId, outcome, snapshot));
    if (outcome === "not_restored") notResumed.push(serverId);
  }
  // A former owner must not learn a Server's current name through this email.
  const notResumedNames = notResumed.length === 0 ? [] : (await getDb().select({ name: servers.name }).from(servers)
    .innerJoin(serverMembers, and(eq(serverMembers.serverId, servers.id), eq(serverMembers.userId, userId), eq(serverMembers.role, "owner")))
    .where(inArray(servers.id, notResumed))).map((row) => row.name);
  const [record] = await getDb().select({ results: accountDeletionRequests.subscriptionRestorationResults }).from(accountDeletionRequests)
    .where(eq(accountDeletionRequests.id, result.cancelled.id)).limit(1);
  const outcome = subscriptionRestorationResult(record?.results ?? null);
  const anotherDeletionPending = Boolean(await findPendingAccountDeletion(getDb(), userId));
  await notify(result.person.email, result.person.name, userId, { kind: "cancelled", subscriptionsToTurnBackOn: notResumedNames, subscriptionNotResumed: outcome === "not_restored", subscriptionRestorationUnknown: outcome === "unknown", anotherDeletionPending });
  return { cancelled: true, requestId: result.cancelled.id, subscriptionRestoration: outcome, ...(outcome === "not_restored" ? { subscriptionNotResumed: true as const } : {}) };
}

const CANCEL_TOKEN_PREFIX = "adcl_";
const MAX_CANCEL_TOKEN_LENGTH = 100;

/**
 * A new raw cancel token (`adcl_*`) and its HMAC lookup hash: the hash is
 * stored with the request, the token goes into the "requested" email once.
 * Null when the hash can't be computed (no token pepper configured): the
 * request goes ahead and the email only says to sign in to cancel.
 */
function issueAccountDeletionCancelToken(userId: string): { token: string; lookupHash: Buffer } | null {
  const token = `${CANCEL_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  try {
    return { token, lookupHash: computeTokenLookupHash(token) };
  } catch (err) {
    console.error(`[account-deletion] no cancel link for ${userId}:`, serializeErrorForLog(err));
    return null;
  }
}

/**
 * The emailed cancel link, used (POST /api/auth/account-deletion/cancel, no
 * sign-in): cancels the request it was issued with, through
 * cancelAccountDeletion like the signed-in cancel (subscriptions resume, the
 * "cancelled" email goes), acting for the person it was mailed to. `invalid`
 * for every refusal alike, so the answer tells nothing about the token: not a
 * cancel token, unknown, already used, the request no longer pending or past
 * its `scheduled_for`, or the account retired.
 */
export async function cancelAccountDeletionByLink(
  rawToken: unknown,
  deps: {
    resumeSubscription?: (serverId: string, userId: string, snapshot?: AccountDeletionSubscriptionSnapshot) => Promise<SubscriptionRestorationResult>;
    now?: Date;
  },
): Promise<{ ok: true; subscriptionNotResumed?: true; subscriptionRestoration?: SubscriptionRestorationResult } | { ok: false; error: "invalid" }> {
  const invalid = { ok: false as const, error: "invalid" as const };
  if (typeof rawToken !== "string" || !rawToken.startsWith(CANCEL_TOKEN_PREFIX) || rawToken.length > MAX_CANCEL_TOKEN_LENGTH) return invalid;
  const now = deps.now ?? currentDate();
  const lookupHash = computeTokenLookupHash(rawToken);
  const [request] = await getDb().select({
    userId: accountDeletionRequests.userId,
    cancelTokenHash: accountDeletionRequests.cancelTokenHash,
    state: accountDeletionRequests.state,
    scheduledFor: accountDeletionRequests.scheduledFor,
  }).from(accountDeletionRequests)
    .where(eq(accountDeletionRequests.cancelTokenHash, lookupHash))
    .limit(1);
  if (!request?.cancelTokenHash || request.cancelTokenHash.length !== lookupHash.length || !timingSafeEqual(request.cancelTokenHash, lookupHash)) return invalid;
  if (request.state !== "pending" || request.scheduledFor.getTime() <= now.getTime()) return invalid;
  try {
    // The update checks the token, `pending` and the time again under the
    // person's lock, so of two clicks at once only one cancels.
    const { cancelled, subscriptionNotResumed, subscriptionRestoration } = await cancelAccountDeletion(
      { userId: request.userId, now, byLink: { cancelTokenHash: lookupHash } },
      { resumeSubscription: deps.resumeSubscription },
    );
    return cancelled ? { ok: true, subscriptionRestoration, ...(subscriptionNotResumed ? { subscriptionNotResumed } : {}) } : invalid;
  } catch (err) {
    if (err instanceof AccountDeletionUnavailableError) return invalid;
    throw err;
  }
}
