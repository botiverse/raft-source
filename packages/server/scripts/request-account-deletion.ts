#!/usr/bin/env -S node --import=@oxc-node/core/register
/**
 * Ops entry: ask to delete a person's account on their behalf, from a support
 * ticket, exactly as their own "Delete account" button does.
 *
 * Dry-run (the default) prints what the app's "before you delete" page shows
 * that person (getAccountDeletionOverview, the same read GET
 * /api/me/account/deletion answers): the masked email, whether a request is
 * already pending, the servers to hand over (sole owner with other members:
 * the request is refused until they are) and the ones closed with the account
 * (only they are in it), the shared servers whose subscription they pay for
 * (it stops at period end), what happens to each of their agents, their
 * Computers still attached and other people's agents on them (the 409
 * `others_agents_on_computers` gate), and the date the account would be
 * deleted (now + the grace period). It writes nothing. It also says whether
 * `--apply` would be refused, and why (exit 2).
 *
 * --apply calls requestAccountDeletion (services/accountDeletion/requests.ts),
 * the path the in-app button takes, with `source: "ops"`, `ticketRef` and the
 * accountable human (--accountable-user-id) as `actorUserId`: the same checks under the person's row lock, the
 * same `account_deletion_requests` row (source, actor_user_id, ticket_ref),
 * the same grace period, every sign-in, Computer and agent key revoked in that
 * transaction (`computer.key_revoked`: the accountable human is the actor
 * on each Computer the person attached; a Computer someone else attached on
 * the person's machine is revoked with the system as actor), then after commit the same effects (security-revoke cascade, the
 * revoked keys' connections closed over Redis, subscriptions set to cancel at
 * period end, and the "scheduled for deletion" email with the one-time undo
 * link). Refused, writing nothing, with exit 2, when:
 *   - a request is already pending (the request answers it unchanged);
 *   - the person is the sole owner of a server with other members (409
 *     `sole_owner_servers`) or someone else's agent is on one of their live
 *     Computers (409 `others_agents_on_computers`): the gate's list is printed.
 *     There is no force here: those agents' owners move them first.
 *
 * The request row has no column for the approval or the run id; as the other
 * gated ops scripts do, they are recorded in this script's stdout receipt
 * (_START and _DONE, with the request id that row has), which the runbook
 * keeps in the approval thread. The ticket and the accountable human are on
 * the row.
 *
 * --accountable-user-id is the human accountable for the approved decision
 * (the person who approved it in the approval thread), never an agent and not
 * whoever runs the command: the request row records them as its actor. The
 * executor (the agent or person running the script) is recorded by --run-id
 * and in the approval thread. --actor-user-id is accepted as an alias.
 *
 * What the in-app request also does and a script cannot (it needs the running
 * server's agent orchestrator and socket.io): stop the person's agents (their
 * keys and Computers are revoked all the same; _REQUESTED lists them as
 * `not_stopped_agents`), close the person's open browser connections (their
 * sessions are already gone; the next request is refused), and tell the owners
 * of the agents on a Computer the person attached on someone else's machine
 * (listed as `detached_computer_machines`).
 *
 * Usage (defaults to dry-run):
 *   DATABASE_URL=<replica url> pnpm --filter @botiverse/raft-server ops:request-account-deletion -- \
 *     --environment production --user-id <uuid> --ticket-ref <ticket>
 *   DATABASE_URL=<primary url> REDIS_URL=<redis url> RESEND_API_KEY=... AGENT_BOOTSTRAP_TOKEN_PEPPER=... \
 *     pnpm --filter @botiverse/raft-server ops:request-account-deletion -- \
 *     --environment production --user-id <uuid> --ticket-ref <ticket> \
 *     --apply --approval-reference <Raft message link> --run-id <id> --accountable-user-id <approver's user id>
 * In production a dry-run refuses a primary (pg_is_in_recovery() must be
 * true) and --apply refuses a replica, and --apply needs the server's own
 * REDIS_URL, RESEND_API_KEY (without it the email, undo link included, is
 * printed instead of sent) and token pepper (AGENT_BOOTSTRAP_TOKEN_PEPPER or
 * JWT_SECRET, as the server has it: the undo link is checked against it).
 * Flags never grant production authority; the runbook
 * (docs/operations/ops-account-deletion.md) says who approves.
 *
 * Output: [OPS_ACCOUNT_DELETION_START]; the preview (_PERSON, _STATUS, one
 * line per server, agent, Computer and other person's agent, _EFFECTIVE);
 * _BLOCKED when --apply would be refused; with --apply _REFUSED (and the
 * gate's lines) or _REQUESTED; then _DONE (JSON).
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { currentDate } from "@botiverse/raft-shared";
import { closeDatabase, getDb, initDatabase } from "../src/db/index";
import { agents, users } from "../src/db/schema";
import { getBoundedRedis, getRedis, initRedis, shutdownRedis } from "../src/redis";
import {
  AccountDeletionUnavailableError,
  findAgentsToStop,
  findAttachedComputersOnOthersMachines,
  getAccountDeletionOverview,
  othersAgentsWithOwnerNotifiedAt,
  requestAccountDeletion,
  type AccountDeletionEffectDeps,
  type OthersAgentOnComputer,
  type SoleOwnerServer,
} from "../src/services/accountDeletion/requests";
import { getBootstrapTokenPepper } from "../src/services/agentCredentialService";
import { cancelSubscriptionForAccountDeletion } from "../src/services/billingService";
import { maskEmail } from "../src/services/secondFactor/signIn";

const TAG = "OPS_ACCOUNT_DELETION";
const DAY_MS = 24 * 60 * 60_000;

/**
 * `agents_left_running` and `computers_on_others_machines` are this script's
 * own (Tenny, dm:@Tenny:#1): a script cannot stop the person's agents or tell
 * the owners of agents on a Computer the person attached on someone else's
 * machine, both of which the in-app path does from the running server. Such a
 * person goes through the app, or is handled by hand.
 */
export type BlockReason =
  | "already_pending"
  | "sole_owner_servers"
  | "others_agents_on_computers"
  | "agents_left_running"
  | "computers_on_others_machines";

export interface RunOptions {
  userId: string;
  ticketRef: string;
  apply: boolean;
  /** The human accountable for the approved decision (--accountable-user-id): required with --apply. */
  actorUserId: string | null;
  log: (line: string) => void;
  /** The after-commit effects' dependencies; the script has no orchestrator or socket server. */
  deps?: AccountDeletionEffectDeps;
}

export type RunResult =
  | { outcome: "dry_run"; blocked: BlockReason[] }
  | { outcome: "blocked"; blocked: BlockReason[] }
  | { outcome: "refused"; code: "already_pending" | "sole_owner_servers" | "others_agents_on_computers" }
  | { outcome: "requested"; requestId: string; scheduledFor: string; notStoppedAgentIds: string[]; subscriptionServerIds: string[] };

const json = (value: unknown) => JSON.stringify(value);

function logSoleOwner(log: (line: string) => void, servers: SoleOwnerServer[]) {
  for (const server of servers) {
    log(`[${TAG}_SOLE_OWNER_SERVER] server=${server.id} slug=${server.slug} members=${server.memberCount} name=${json(server.name)} (hand over or delete first)`);
  }
}

function logOthersAgents(log: (line: string) => void, list: OthersAgentOnComputer[]) {
  for (const agent of list) {
    log(`[${TAG}_OTHERS_AGENT] agent=${agent.id} computer=${agent.computer.id} server=${agent.server.id} owner=${agent.owner?.id ?? "-"} `
      + `personal_assistant=${agent.personalAssistant} owner_notified_at=${agent.ownerNotifiedAt ?? "-"} name=${json(agent.name)} computer_name=${json(agent.computer.name)} owner_name=${json(agent.owner?.name ?? null)}`);
  }
}

/** The person, the app's preview of the deletion, and what would refuse --apply. Read-only. */
export async function preview(userId: string, log: (line: string) => void): Promise<{ blocked: BlockReason[]; retired: boolean } | null> {
  const [person] = await getDb().select({ email: users.email, retiredAt: users.retiredAt }).from(users).where(eq(users.id, userId));
  if (!person) return null;
  log(`[${TAG}_PERSON] user=${userId} email=${maskEmail(person.email)} retired=${person.retiredAt ? person.retiredAt.toISOString() : "no"}`);
  if (person.retiredAt) return { blocked: [], retired: true };

  const overview = await getAccountDeletionOverview(userId);
  const blocked: BlockReason[] = [];
  if (overview.status === "scheduled") {
    blocked.push("already_pending");
    log(`[${TAG}_STATUS] pending=yes requested_at=${overview.requestedAt} scheduled_for=${overview.scheduledFor}`);
  } else {
    log(`[${TAG}_STATUS] pending=no`);
  }
  logSoleOwner(log, overview.soleOwnerServers);
  if (overview.soleOwnerServers.length > 0) blocked.push("sole_owner_servers");
  for (const server of overview.soleMemberServers) {
    log(`[${TAG}_SOLE_MEMBER_SERVER] server=${server.id} slug=${server.slug} name=${json(server.name)} (deleted with the account)`);
  }
  for (const server of overview.paidServersEndingAtPeriodEnd) {
    log(`[${TAG}_PAID_SERVER] server=${server.id} slug=${server.slug} period_end=${server.periodEnd ?? "-"} name=${json(server.name)} (subscription stops at period end)`);
  }
  for (const agent of overview.agents) {
    log(`[${TAG}_AGENT] agent=${agent.id} server=${agent.server.id} outcome=${agent.outcome} to_user=${agent.toUser?.id ?? "-"} name=${json(agent.name)}`);
  }
  const others: OthersAgentOnComputer[] = [];
  for (const computer of overview.computers) {
    const theirs = computer.agents.filter((agent) => agent.ownedByMe).length;
    log(`[${TAG}_COMPUTER] computer=${computer.id} server=${computer.server.id} agents=${computer.agents.length} others_agents=${computer.agents.length - theirs} name=${json(computer.name)} (key revoked)`);
    for (const agent of computer.agents) {
      if (agent.ownedByMe) continue;
      others.push({
        id: agent.id, name: agent.name, server: computer.server, computer: { id: computer.id, name: computer.name },
        owner: agent.owner, personalAssistant: agent.personalAssistant, ownerNotifiedAt: agent.ownerNotifiedAt, ownerNextNotifyAt: agent.ownerNextNotifyAt,
      });
    }
  }
  logOthersAgents(log, others);
  if (others.length > 0) blocked.push("others_agents_on_computers");
  const effectiveAt = overview.status === "scheduled" ? overview.scheduledFor : new Date(currentDate().getTime() + overview.graceDays * DAY_MS).toISOString();
  log(`[${TAG}_EFFECTIVE] grace_days=${overview.graceDays} scheduled_for=${effectiveAt}${overview.status === "scheduled" ? " (the pending request's)" : " (if requested now)"}`);
  log(`[${TAG}_TOTAL] sole_owner_servers=${overview.soleOwnerServers.length} sole_member_servers=${overview.soleMemberServers.length} `
    + `paid_servers=${overview.paidServersEndingAtPeriodEnd.length} agents=${overview.agents.length} computers=${overview.computers.length} others_agents=${others.length}`);

  // Only agents that can be running somewhere: on a Computer, or in Raft's cloud.
  // An agent on no Computer and not cloud has no process to stop.
  const toStop = await findAgentsToStop(getDb(), userId);
  const running = toStop.length === 0 ? [] : (await getDb().select({ id: agents.id }).from(agents)
    .where(and(inArray(agents.id, toStop), or(isNotNull(agents.machineId), eq(agents.executionMode, "cloud"))))
    .orderBy(agents.id)).map((row) => row.id);
  for (const agentId of running) log(`[${TAG}_RUNNING_AGENT] agent=${agentId} (a script cannot stop it: use the in-app path, or stop it first)`);
  if (running.length > 0) blocked.push("agents_left_running");
  const onOthersMachines = await findAttachedComputersOnOthersMachines(getDb(), userId);
  for (const computer of onOthersMachines) {
    log(`[${TAG}_OTHERS_MACHINE_COMPUTER] computer=${computer.computerId} machine=${computer.machineId} (a script cannot tell its agents' owners: use the in-app path or handle by hand)`);
  }
  if (onOthersMachines.length > 0) blocked.push("computers_on_others_machines");

  if (blocked.length > 0) log(`[${TAG}_BLOCKED] reasons=${blocked.join(",")} (--apply would be refused)`);
  return { blocked, retired: false };
}

export async function run(options: RunOptions): Promise<RunResult> {
  const { log, userId } = options;
  const previewed = await preview(userId, log);
  if (!previewed) throw new Error(`no user ${userId}`);
  if (previewed.retired) throw new Error(`user ${userId} is already retired (deleted)`);
  if (!options.apply) return { outcome: "dry_run", blocked: previewed.blocked };
  // Pending and both 409 gates are the request's own, decided under the person's lock (_REFUSED below).
  const scriptOnly = previewed.blocked.filter((reason) => reason === "agents_left_running" || reason === "computers_on_others_machines");
  if (scriptOnly.length > 0) {
    log(`[${TAG}_REFUSED] reason=${scriptOnly.join(",")} (nothing written)`);
    return { outcome: "blocked", blocked: scriptOnly };
  }

  const actorUserId = options.actorUserId;
  if (!actorUserId) throw new Error("--apply requires --accountable-user-id");
  if (actorUserId === userId) throw new Error("--accountable-user-id is the human who approved this, not the person: a person deletes their own account in the app");
  const [actor] = await getDb().select({ retiredAt: users.retiredAt }).from(users).where(eq(users.id, actorUserId));
  if (!actor || actor.retiredAt) throw new Error(`--accountable-user-id ${actorUserId} is not an active (human) user`);

  let outcome;
  try {
    outcome = await requestAccountDeletion({ userId, source: "ops", actorUserId, ticketRef: options.ticketRef }, options.deps ?? {});
  } catch (err) {
    if (err instanceof AccountDeletionUnavailableError) throw new Error(`user ${userId} is no longer active`);
    throw err;
  }
  if (outcome.kind === "conflict") {
    log(`[${TAG}_REFUSED] reason=${outcome.code} (nothing written)`);
    if (outcome.code === "sole_owner_servers") logSoleOwner(log, outcome.servers);
    else logOthersAgents(log, await othersAgentsWithOwnerNotifiedAt(userId, outcome.agents));
    return { outcome: "refused", code: outcome.code };
  }
  if (!outcome.effects) {
    log(`[${TAG}_REFUSED] reason=already_pending request=${outcome.request.id} source=${outcome.request.source} `
      + `requested_at=${outcome.request.requestedAt.toISOString()} scheduled_for=${outcome.request.scheduledFor.toISOString()} (nothing written)`);
    return { outcome: "refused", code: "already_pending" };
  }
  const { request, effects } = outcome;
  log(`[${TAG}_REQUESTED] request=${request.id} user=${userId} source=${request.source} actor=${request.actorUserId} ticket_ref=${json(request.ticketRef)} `
    + `requested_at=${request.requestedAt.toISOString()} scheduled_for=${request.scheduledFor.toISOString()} `
    + `email=${maskEmail(effects.email)} undo_link=${effects.cancelToken ? "yes" : "no"} `
    + `revoked_key_agents=${effects.keyReach?.agentIds.length ?? 0} closed_machines=${effects.keyReach?.machineIds.join(",") || "-"} `
    + `subscription_servers=${effects.subscriptionServerIds.join(",") || "-"} `
    + `not_stopped_agents=${options.deps?.stopAgent ? "-" : effects.agentIds.join(",") || "-"} `
    + `detached_computer_machines=${(effects.detachedComputers ?? []).map((computer) => computer.machineId).join(",") || "-"}`);
  return {
    outcome: "requested",
    requestId: request.id,
    scheduledFor: request.scheduledFor.toISOString(),
    notStoppedAgentIds: options.deps?.stopAgent ? [] : effects.agentIds,
    subscriptionServerIds: effects.subscriptionServerIds,
  };
}

// CLI ------------------------------------------------------------------------

export type Environment = "local" | "staging" | "production";

export interface CliOptions {
  environment: Environment;
  userId: string;
  ticketRef: string;
  apply: boolean;
  approvalReference: string | null;
  runId: string | null;
  actorUserId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseArgs(argv: readonly string[]): CliOptions {
  let environment: string | null = null;
  let userId: string | null = null;
  let ticketRef: string | null = null;
  const options = { apply: false, approvalReference: null as string | null, runId: null as string | null, actorUserId: null as string | null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    else if (arg === "--environment") environment = argv[++i] ?? "";
    else if (arg === "--user-id") userId = argv[++i] ?? "";
    else if (arg === "--ticket-ref") ticketRef = argv[++i] ?? "";
    else if (arg === "--dry-run") options.apply = false;
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--approval-reference") options.approvalReference = argv[++i] ?? "";
    else if (arg === "--run-id") options.runId = argv[++i] ?? "";
    // --actor-user-id: the earlier name, kept as an alias.
    else if (arg === "--accountable-user-id" || arg === "--actor-user-id") options.actorUserId = argv[++i] ?? "";
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (environment !== "local" && environment !== "staging" && environment !== "production") {
    throw new Error("--environment must be local, staging or production");
  }
  if (!userId || !UUID.test(userId)) throw new Error("--user-id <uuid> is required");
  ticketRef = ticketRef?.trim() ?? "";
  if (!ticketRef || ticketRef.length > 200) throw new Error("--ticket-ref <ticket> is required (at most 200 characters)");
  if (options.apply && !options.approvalReference?.trim()) throw new Error("--apply requires --approval-reference <the human approval message>");
  if (options.apply && !/^[A-Za-z0-9._:-]{1,100}$/.test(options.runId ?? "")) throw new Error("--apply requires --run-id <id> ([A-Za-z0-9._:-], at most 100)");
  if (options.apply && !UUID.test(options.actorUserId ?? "")) {
    throw new Error("--apply requires --accountable-user-id <the user id of the human who approved it> (never an agent, not whoever runs the command)");
  }
  if (!options.apply && (options.approvalReference !== null || options.runId !== null || options.actorUserId !== null)) {
    throw new Error("--approval-reference, --run-id and --accountable-user-id are only for --apply");
  }
  return { environment, userId: userId.toLowerCase(), ticketRef, ...options, actorUserId: options.actorUserId?.toLowerCase() ?? null };
}

/**
 * Production dry-runs read a replica; production writes go to the primary,
 * with what the after-commit half needs to do what the server does: Redis
 * (close the revoked keys' connections), Resend (send the email rather than
 * print it, undo link and all) and the token pepper (issue the undo link).
 */
export function checkEndpoint(
  environment: Environment,
  apply: boolean,
  inRecovery: boolean,
  has: { redis: boolean; email: boolean; pepper: boolean },
): string | null {
  if (environment !== "production") return null;
  if (!apply && !inRecovery) return "a production dry-run reads a replica: DATABASE_URL is a primary";
  if (apply && inRecovery) return "--apply writes to the primary: DATABASE_URL is a replica";
  if (apply && !has.redis) return "a production --apply needs REDIS_URL to close the revoked keys' connections";
  if (apply && !has.email) return "a production --apply needs RESEND_API_KEY: without it the email (and its undo link) is printed, not sent";
  if (apply && !has.pepper) return "a production --apply needs the server's AGENT_BOOTSTRAP_TOKEN_PEPPER (or JWT_SECRET) to issue the undo link";
  return null;
}

function hasPepper(): boolean {
  try {
    getBootstrapTokenPepper();
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const redisUrl = options.apply ? process.env.REDIS_URL : undefined;
  await initDatabase(databaseUrl, undefined, { log: () => {} });
  try {
    const { rows: [endpoint] } = await getDb().execute<{ replica: boolean }>(sql`SELECT pg_is_in_recovery() AS replica`);
    const refusal = checkEndpoint(options.environment, options.apply, endpoint?.replica === true, {
      redis: Boolean(redisUrl), email: Boolean(process.env.RESEND_API_KEY), pepper: hasPepper(),
    });
    if (refusal) throw new Error(refusal);
    if (redisUrl) {
      initRedis(redisUrl);
      await getRedis().ping();
      // The bounded client the connection drop publishes on refuses commands until connected.
      const bounded = getBoundedRedis(2_000);
      if (bounded && bounded.status !== "ready") await new Promise((resolve) => bounded.once("ready", resolve));
    } else if (options.apply) {
      console.log(`[${TAG}_WARNING] no REDIS_URL: the revoked keys' open connections stay up until they reconnect (their keys are then refused)`);
    }
    console.log(`[${TAG}_START] ${json({
      mode: options.apply ? "apply" : "dry-run", environment: options.environment, replica: endpoint?.replica ?? null,
      userId: options.userId, ticketRef: options.ticketRef, actorUserId: options.actorUserId,
      approvalReference: options.approvalReference, runId: options.runId, redis: Boolean(redisUrl), startedAt: new Date().toISOString(),
    })}`);
    const subscriptionCancelFailed: string[] = [];
    const result = await run({
      userId: options.userId,
      ticketRef: options.ticketRef,
      apply: options.apply,
      actorUserId: options.actorUserId,
      log: (line) => console.log(line),
      deps: {
        cancelSubscriptionAtPeriodEnd: async (serverId, userId, stripeSubscriptionId, requestId) => {
          try {
            return await cancelSubscriptionForAccountDeletion(serverId, userId, stripeSubscriptionId, requestId);
          } catch (err) {
            subscriptionCancelFailed.push(serverId);
            throw err;
          }
        },
      },
    });
    console.log(`[${TAG}_DONE] ${json({
      mode: options.apply ? "apply" : "dry-run", runId: options.runId, approvalReference: options.approvalReference,
      userId: options.userId, ticketRef: options.ticketRef, actorUserId: options.actorUserId, ...result,
      ...(result.outcome === "requested" ? { subscriptionCancelFailed } : {}),
    })}`);
    if (!options.apply) console.log("dry-run; pass --apply --approval-reference <message> --run-id <id> --accountable-user-id <approver> to write");
    return result.outcome === "requested" || (result.outcome === "dry_run" && result.blocked.length === 0) ? 0 : 2;
  } finally {
    if (redisUrl) await shutdownRedis();
    await closeDatabase();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
  }, (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
