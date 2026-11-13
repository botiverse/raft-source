// The User Limit of Part I §2 of the Raft License (LICENSE): a Deployment of
// the source-available edition has at most HUMAN_USER_LIMIT (edition.ts) Human
// User Accounts. The cloud edition has no such limit: every function here
// returns before any query or lock there (humanUserLimit() is null).
//
// Who counts: a `users` row (a person; agents are a separate table) not
// retired (`retired_at` null; an account waiting to be deleted still counts)
// with at least one owner, admin or member seat in some server, or with Guest
// seats in at least two servers. Only seats in servers not deleted
// (`servers.deleted_at` null) count, for both rules: a soft-deleted server
// keeps its member rows, but nobody uses them, so deleting a server frees the
// places of people who held seats only there. A Guest of one channel in one
// server does not count, nor does an account in no server: signing up is
// never refused (Tenny, option B), only the change that makes one more person
// count.
//
// Where it is refused: the three ways a person starts to count, each in its
// own transaction, after its writes (assertHumanAccountRoom):
// - serverService.addMember (an invite or join link, the community join, SSO
//   auto-join, an external invite accepted as a Guest: a second Guest seat);
// - serverService.transitionMemberRoleInTransaction, a Guest made a member,
//   admin or owner (by hand, or by a server invite);
// - serverService.createServer, the creator becoming its owner.
// Nothing else inserts server_members or turns a Guest into anything else
// (accountDeletion/cleanup.ts's hand-over promotes an admin or member).
//
// Concurrency: one transaction-scoped advisory lock for the whole deployment
// (DEPLOYMENT_USER_LIMIT_LOCK), taken last in each of those transactions,
// after its own writes and every row lock it takes. The person's seats and
// the count are read under it, so two changes that would each add the last
// person (or one person's two Guest seats) serialize: the second sees the
// first's commit. It is the last lock its transaction's service step takes;
// what a caller does after (using the invite, the channel membership, the
// free plan's freeze rows) is serialized per server before it reaches here
// (the admission lock and the server row), so no two holders wait on each
// other across it.
import { DEPLOYMENT_USER_LIMIT_REACHED_CODE, RAFT_LICENSE_CONTACT_EMAIL, type ServerRole } from "@botiverse/raft-shared";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index";
import { serverMembers, servers, users } from "../db/schema";
import { humanUserLimit } from "../edition";
import { RefusalError } from "../lib/refusal";

/**
 * The deployment-wide advisory lock: pg_advisory_xact_lock(namespace, 0), the
 * two-int form. The namespace is "HULM" in ASCII; no server lock uses 0 as its
 * second key (planService's namespaces start at 1), and the other fixed
 * namespaces (featureFlagService "FFLG"/"FFCV", wechatBridgeService "WXAT")
 * differ.
 */
export const DEPLOYMENT_USER_LIMIT_LOCK_NAMESPACE = 0x48554c4d; // "HULM"
const DEPLOYMENT_USER_LIMIT_LOCK_KEY = 0;

export function deploymentUserLimitSentence(limit: number): string {
  return `This Raft Community Edition deployment already has ${limit} people, the Raft License limit. To go above it, email ${RAFT_LICENSE_CONTACT_EMAIL} for a separate license.`;
}

/** The change would make one more person count, and the deployment already has `limit`. 403 everywhere. */
export class DeploymentUserLimitError extends RefusalError {
  readonly code = DEPLOYMENT_USER_LIMIT_REACHED_CODE;

  constructor(readonly limit: number) {
    super(403, { code: DEPLOYMENT_USER_LIMIT_REACHED_CODE, error: deploymentUserLimitSentence(limit) });
    this.name = "DeploymentUserLimitError";
  }
}

/** Whether a person with these server roles (one per server) counts toward the limit. */
export function countsAsHumanUser(roles: readonly ServerRole[]): boolean {
  return roles.some((role) => role !== "guest") || roles.length >= 2;
}

/** How many people count toward the limit now (as `executor` sees it: in a transaction, its own writes too). */
export async function countHumanUserAccounts(executor: DatabaseExecutor = getDb()): Promise<number> {
  const result = await executor.execute(sql`
    SELECT count(*)::int AS n FROM (
      SELECT sm.user_id
      FROM server_members sm
      JOIN users u ON u.id = sm.user_id AND u.retired_at IS NULL
      JOIN servers s ON s.id = sm.server_id AND s.deleted_at IS NULL
      GROUP BY sm.user_id
      HAVING bool_or(sm.role <> 'guest') OR count(*) >= 2
    ) counted`);
  return Number((result.rows[0] as { n?: unknown } | undefined)?.n ?? 0);
}

/**
 * Whether the deployment is at (or over) its limit: no one more person may
 * start to count. Always false in the cloud edition, without a query. A hint
 * for pages (invite-info, the sign-up page); the refusal is decided in the
 * change's transaction (assertHumanAccountRoom).
 */
export async function deploymentUserLimitReached(executor: DatabaseExecutor = getDb()): Promise<boolean> {
  const limit = humanUserLimit();
  if (limit === null) return false;
  return (await countHumanUserAccounts(executor)) >= limit;
}

/** What the caller's transaction just did to `userId`'s seat in `serverId`: their role there before (null: no seat). */
export interface HumanAccountChange {
  serverId: string;
  previousRole: ServerRole | null;
}

/**
 * In the transaction that just gave `userId` a seat in a server or changed
 * their role there (`change`), after those writes and every lock it takes:
 * refuses (DeploymentUserLimitError, the transaction rolls back) when the
 * change made a person who did not count before count, and the deployment
 * now has more people than the limit. A person who already counted, or still
 * does not, is never refused, nor is anyone in the cloud edition (no lock, no
 * query).
 */
export async function assertHumanAccountRoom(tx: DatabaseExecutor, userId: string, change: HumanAccountChange): Promise<void> {
  const limit = humanUserLimit();
  if (limit === null) return;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${DEPLOYMENT_USER_LIMIT_LOCK_NAMESPACE}, ${DEPLOYMENT_USER_LIMIT_LOCK_KEY})`);
  const seats = await tx
    .select({ serverId: serverMembers.serverId, role: serverMembers.role })
    .from(serverMembers)
    .innerJoin(users, eq(users.id, serverMembers.userId))
    .innerJoin(servers, eq(servers.id, serverMembers.serverId))
    .where(and(eq(serverMembers.userId, userId), isNull(users.retiredAt), isNull(servers.deletedAt)));
  if (!countsAsHumanUser(seats.map((seat) => seat.role))) return;
  const before = seats.filter((seat) => seat.serverId !== change.serverId).map((seat) => seat.role);
  if (change.previousRole) before.push(change.previousRole);
  if (countsAsHumanUser(before)) return;
  if ((await countHumanUserAccounts(tx)) > limit) throw new DeploymentUserLimitError(limit);
}
