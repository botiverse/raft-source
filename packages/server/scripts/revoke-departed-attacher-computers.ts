#!/usr/bin/env -S node --import=@oxc-node/core/register
/**
 * One-time cleanup: revoke the live Computers whose attacher is no longer a
 * member of the Computer's server.
 *
 * Since serverService.ts removeMemberInTransaction revokes every live Computer
 * a person attached to a server when their membership ends (removed, or left),
 * no new such Computer appears. Those whose attacher left or was removed
 * before that kept a working key: 14 in production (2026-11), on 9 servers,
 * carrying 14 agents.
 *
 * A candidate is a Computer with `revoked_at IS NULL`, an
 * `attached_by_user_id`, and no `server_members` row for that person on
 * `computers.server_id`. Each one is revoked as the removal revokes it
 * (computerKeyRevocation.ts revokeComputerKeyInTransaction): the key, and
 * every live credential its machine minted, each audited
 * (`computer.key_revoked`, `agent_credential.revoked`) with
 * `via: "member_removed"`, `departureReason: "removed"` and no actor (a
 * system actor, `revoked_by_user_id` NULL), under one operation id per run.
 * The machine and its agents stay bound; the agents go offline until someone
 * attaches that Computer again or moves them.
 *
 * --apply revokes in batches of --batch Computers (default 5, --sleep-ms
 * between batches), each Computer in its own transaction (lock_timeout 2s):
 * the server row FOR SHARE (the removal's lock order: servers, then member
 * rows, then resource rows), then the attacher's membership is re-read and the
 * Computer row locked FOR UPDATE. A person who rejoined since, or a Computer
 * revoked meanwhile, is skipped. Idempotent: a re-run finds nothing.
 *
 * After each commit, as the removal does (finishRemovedMember), it closes the
 * revoked Computer's connection and its agents' credential streams on every
 * replica (deviceSessionKeys.ts closeDeviceSessionKeys, over Redis; REDIS_URL,
 * required for a production --apply). What the removal also does from a
 * request and a script cannot (it needs the server's socket.io and agent
 * orchestrator): the DM notice to each bound agent's owner and the server's
 * live Computers-list refresh. Each REVOKED line lists the agents whose owner
 * the removal would have told (`notify_agents`). Without the Redis close an
 * open connection stays up until the Computer reconnects, when its key is
 * refused; its agents' API calls are refused at once (every request reads the
 * credential).
 *
 * Usage (defaults to dry-run: lists the candidates, writes nothing):
 *   DATABASE_URL=<replica url> pnpm --filter @botiverse/raft-server ops:revoke-departed-attacher-computers -- \
 *     --environment production [--dry-run]
 *   DATABASE_URL=<primary url> REDIS_URL=<redis url> pnpm --filter @botiverse/raft-server ops:revoke-departed-attacher-computers -- \
 *     --environment production --apply --approval-reference <Raft message link> --run-id <id> [--batch 5] [--sleep-ms 500]
 * In production a dry-run refuses a primary (pg_is_in_recovery() must be
 * true) and --apply refuses a replica. Flags never grant production
 * authority; the runbook (docs/operations/departed-attacher-computers.md) says
 * who approves.
 *
 * Narrowing a run: --exclude-computer <id> (repeatable) leaves a Computer
 * out; --only-computer <id> (repeatable) keeps only those. A Computer both
 * names is excluded. Left-out candidates are listed as _EXCLUDED (dry-run and
 * --apply alike) and never revoked; an id that matches no candidate is listed
 * as _UNMATCHED, so a mistyped id is seen. Both lists are in _START and the
 * excluded ids in _DONE (the run's receipt).
 *
 * Output: [DEPARTED_ATTACHER_COMPUTERS_START]; one _CANDIDATE line per
 * Computer, one _EXCLUDED line per left-out one, _UNMATCHED lines, and a
 * _TOTAL line; with --apply one _REVOKED or _SKIPPED line per selected
 * Computer; then _DONE (JSON).
 */
import "dotenv/config";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { closeDatabase, getDb, initDatabase } from "../src/db/index";
import { agents, computers, machines, serverMembers } from "../src/db/schema";
import { getBoundedRedis, getRedis, initRedis, shutdownRedis } from "../src/redis";
import { revokeComputerKeyInTransaction } from "../src/services/computerKeyRevocation";
import { closeDeviceSessionKeys, type DeviceSessionKeyReach } from "../src/services/deviceSessionKeys";
import { newAuditOperationId } from "../src/services/integrationAuditService";

const TAG = "DEPARTED_ATTACHER_COMPUTERS";

export interface Candidate {
  computerId: string;
  computerName: string;
  serverId: string;
  machineId: string | null;
  attachedByUserId: string;
  /** Live agents bound to its machine on its server. */
  agents: number;
  /** Of those, created by someone other than the attacher. */
  othersAgents: number;
  lastUsedAt: Date | null;
  lastHeartbeat: Date | null;
}

/** Live Computers whose attacher has no member row on the Computer's server. */
export async function findCandidates(): Promise<Candidate[]> {
  const rows = await getDb()
    .select({
      computerId: computers.id,
      computerName: computers.name,
      serverId: computers.serverId,
      machineId: computers.machineId,
      attachedByUserId: computers.attachedByUserId,
      lastUsedAt: computers.lastUsedAt,
      lastHeartbeat: machines.lastHeartbeat,
    })
    .from(computers)
    .leftJoin(machines, eq(machines.id, computers.machineId))
    .where(and(
      isNull(computers.revokedAt),
      isNotNull(computers.attachedByUserId),
      sql`NOT EXISTS (SELECT 1 FROM ${serverMembers} WHERE ${serverMembers.serverId} = ${computers.serverId} AND ${serverMembers.userId} = ${computers.attachedByUserId})`,
    ))
    .orderBy(asc(computers.id));
  const candidates: Candidate[] = [];
  for (const row of rows) {
    const bound = row.machineId
      ? await getDb()
        .select({ creatorType: agents.creatorType, creatorId: agents.creatorId })
        .from(agents)
        .where(and(eq(agents.machineId, row.machineId), eq(agents.serverId, row.serverId), isNull(agents.deletedAt)))
      : [];
    candidates.push({
      ...row,
      attachedByUserId: row.attachedByUserId!,
      agents: bound.length,
      othersAgents: bound.filter((agent) => agent.creatorId !== row.attachedByUserId).length,
    });
  }
  return candidates;
}

export type RevokeOutcome =
  | { outcome: "revoked"; reach: DeviceSessionKeyReach; notifyAgentIds: string[] }
  | { outcome: "skipped"; reason: "rejoined" | "already_revoked" | "gone" };

/** One Computer, in its own transaction, re-checking the rule under lock. */
export async function revokeDepartedAttacherComputer(candidate: Pick<Candidate, "computerId" | "serverId" | "attachedByUserId">, operationId: string): Promise<RevokeOutcome> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
    await tx.execute(sql`SELECT id FROM servers WHERE id = ${candidate.serverId} FOR SHARE`);
    const [member] = await tx
      .select({ userId: serverMembers.userId })
      .from(serverMembers)
      .where(and(eq(serverMembers.serverId, candidate.serverId), eq(serverMembers.userId, candidate.attachedByUserId)))
      .for("share");
    if (member) return { outcome: "skipped", reason: "rejoined" } as const;
    const [computer] = await tx
      .select({ revokedAt: computers.revokedAt, serverId: computers.serverId, attachedByUserId: computers.attachedByUserId, machineId: computers.machineId })
      .from(computers)
      .where(eq(computers.id, candidate.computerId))
      .for("update");
    if (!computer || computer.serverId !== candidate.serverId || computer.attachedByUserId !== candidate.attachedByUserId) {
      return { outcome: "skipped", reason: "gone" } as const;
    }
    if (computer.revokedAt) return { outcome: "skipped", reason: "already_revoked" } as const;
    const notify = computer.machineId
      ? await tx
        .select({ id: agents.id, creatorType: agents.creatorType, creatorId: agents.creatorId })
        .from(agents)
        .where(and(eq(agents.machineId, computer.machineId), eq(agents.serverId, candidate.serverId), isNull(agents.deletedAt)))
        .orderBy(asc(agents.id))
      : [];
    const result = await revokeComputerKeyInTransaction(tx, {
      computerId: candidate.computerId,
      by: { via: "member_removed", actorUserId: null, actorRole: null, departureReason: "removed" },
      operationId,
    });
    if (!result?.revoked) return { outcome: "skipped", reason: "already_revoked" } as const;
    return {
      outcome: "revoked",
      reach: result.reach,
      // As noticeOwnersOfDetachedComputer picks them (no actor to leave out).
      notifyAgentIds: notify.filter((agent) => agent.creatorType === "user" && agent.creatorId).map((agent) => agent.id),
    } as const;
  });
}

export interface RunOptions {
  apply: boolean;
  batchSize: number;
  sleepMs: number;
  operationId?: string;
  log: (line: string) => void;
  /** Never revoked (listed as _EXCLUDED). */
  excludeComputerIds?: ReadonlySet<string>;
  /** When set, only these are revoked; every other candidate is _EXCLUDED. */
  onlyComputerIds?: ReadonlySet<string>;
  /** After each commit: the removal's close (closeDeviceSessionKeys). */
  close: (reach: DeviceSessionKeyReach) => Promise<void>;
}

export interface RunResult {
  operationId: string | null;
  candidates: Candidate[];
  revoked: string[];
  skipped: Array<{ computerId: string; reason: string }>;
  excluded: Array<{ computerId: string; reason: "excluded" | "not_only" }>;
}

const iso = (value: Date | null) => (value ? value.toISOString() : "-");

export async function run(options: RunOptions): Promise<RunResult> {
  const candidates = await findCandidates();
  for (const c of candidates) {
    options.log(`[${TAG}_CANDIDATE] computer=${c.computerId} server=${c.serverId} machine=${c.machineId ?? "-"} attached_by=${c.attachedByUserId} `
      + `agents=${c.agents} others_agents=${c.othersAgents} last_used_at=${iso(c.lastUsedAt)} last_heartbeat=${iso(c.lastHeartbeat)} name=${JSON.stringify(c.computerName)}`);
  }
  const exclude = options.excludeComputerIds ?? new Set<string>();
  const only = options.onlyComputerIds;
  const excluded: RunResult["excluded"] = [];
  const selected: Candidate[] = [];
  for (const c of candidates) {
    const reason = exclude.has(c.computerId) ? "excluded" as const : only && !only.has(c.computerId) ? "not_only" as const : null;
    if (reason) {
      excluded.push({ computerId: c.computerId, reason });
      options.log(`[${TAG}_EXCLUDED] computer=${c.computerId} server=${c.serverId} reason=${reason}`);
    } else {
      selected.push(c);
    }
  }
  const candidateIds = new Set(candidates.map((c) => c.computerId));
  for (const id of new Set([...exclude, ...(only ?? [])])) {
    if (!candidateIds.has(id)) options.log(`[${TAG}_UNMATCHED] computer=${id} (named by a flag, not a candidate)`);
  }
  options.log(`[${TAG}_TOTAL] computers=${candidates.length} servers=${new Set(candidates.map((c) => c.serverId)).size} `
    + `agents=${candidates.reduce((sum, c) => sum + c.agents, 0)} others_agents=${candidates.reduce((sum, c) => sum + c.othersAgents, 0)} `
    + `selected=${selected.length} excluded=${excluded.length}`);
  const result: RunResult = { operationId: null, candidates, revoked: [], skipped: [], excluded };
  if (!options.apply) return result;

  const operationId = options.operationId ?? newAuditOperationId();
  result.operationId = operationId;
  for (let start = 0; start < selected.length; start += options.batchSize) {
    if (start > 0 && options.sleepMs > 0) await sleep(options.sleepMs);
    for (const candidate of selected.slice(start, start + options.batchSize)) {
      const outcome = await revokeDepartedAttacherComputer(candidate, operationId);
      if (outcome.outcome === "skipped") {
        result.skipped.push({ computerId: candidate.computerId, reason: outcome.reason });
        options.log(`[${TAG}_SKIPPED] computer=${candidate.computerId} reason=${outcome.reason}`);
        continue;
      }
      result.revoked.push(candidate.computerId);
      await options.close(outcome.reach);
      options.log(`[${TAG}_REVOKED] computer=${candidate.computerId} server=${candidate.serverId} operation_id=${operationId} `
        + `credential_agents=${outcome.reach.agentIds.length} closed_machines=${outcome.reach.machineIds.join(",") || "-"} `
        + `notify_agents=${outcome.notifyAgentIds.join(",") || "-"}`);
    }
  }
  return result;
}

// CLI ------------------------------------------------------------------------

export type Environment = "local" | "staging" | "production";

export interface CliOptions {
  environment: Environment;
  apply: boolean;
  approvalReference: string | null;
  runId: string | null;
  batchSize: number;
  sleepMs: number;
  excludeComputerIds: string[];
  onlyComputerIds: string[];
}

const COMPUTER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function computerIdArg(flag: string, value: string | undefined): string {
  if (!value || !COMPUTER_ID_RE.test(value)) throw new Error(`${flag} needs a Computer id (a UUID)`);
  return value.toLowerCase();
}

export function parseArgs(argv: readonly string[]): CliOptions {
  let environment: string | null = null;
  const options = {
    apply: false, approvalReference: null as string | null, runId: null as string | null, batchSize: 5, sleepMs: 500,
    excludeComputerIds: [] as string[], onlyComputerIds: [] as string[],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    else if (arg === "--environment") environment = argv[++i] ?? "";
    else if (arg === "--dry-run") options.apply = false;
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--approval-reference") options.approvalReference = argv[++i] ?? "";
    else if (arg === "--run-id") options.runId = argv[++i] ?? "";
    else if (arg === "--batch") options.batchSize = Number(argv[++i]);
    else if (arg === "--sleep-ms") options.sleepMs = Number(argv[++i]);
    else if (arg === "--exclude-computer") options.excludeComputerIds.push(computerIdArg(arg, argv[++i]));
    else if (arg === "--only-computer") options.onlyComputerIds.push(computerIdArg(arg, argv[++i]));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (environment !== "local" && environment !== "staging" && environment !== "production") {
    throw new Error("--environment must be local, staging or production");
  }
  if (options.apply && !options.approvalReference?.trim()) throw new Error("--apply requires --approval-reference <the human approval message>");
  if (options.apply && !/^[A-Za-z0-9._:-]{1,100}$/.test(options.runId ?? "")) throw new Error("--apply requires --run-id <id> ([A-Za-z0-9._:-], at most 100)");
  if (!options.apply && (options.approvalReference !== null || options.runId !== null)) {
    throw new Error("--approval-reference and --run-id are only for --apply");
  }
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 50) throw new Error("--batch must be 1..50");
  if (!Number.isInteger(options.sleepMs) || options.sleepMs < 0 || options.sleepMs > 60_000) throw new Error("--sleep-ms must be 0..60000");
  return { environment, ...options };
}

/** Production dry-runs read a replica; production writes go to the primary, with Redis to close connections. */
export function checkEndpoint(environment: Environment, apply: boolean, inRecovery: boolean, hasRedis: boolean): string | null {
  if (environment !== "production") return null;
  if (!apply && !inRecovery) return "a production dry-run reads a replica: DATABASE_URL is a primary";
  if (apply && inRecovery) return "--apply writes to the primary: DATABASE_URL is a replica";
  if (apply && !hasRedis) return "a production --apply needs REDIS_URL to close the revoked Computers' connections";
  return null;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const redisUrl = options.apply ? process.env.REDIS_URL : undefined;
  await initDatabase(databaseUrl, undefined, { log: () => {} });
  try {
    const { rows: [endpoint] } = await getDb().execute<{ replica: boolean }>(sql`SELECT pg_is_in_recovery() AS replica`);
    const refusal = checkEndpoint(options.environment, options.apply, endpoint?.replica === true, Boolean(redisUrl));
    if (refusal) throw new Error(refusal);
    if (redisUrl) {
      initRedis(redisUrl);
      await getRedis().ping();
      // The bounded client the connection drop publishes on refuses commands until connected.
      const bounded = getBoundedRedis(2_000);
      if (bounded && bounded.status !== "ready") await new Promise((resolve) => bounded.once("ready", resolve));
    } else if (options.apply) {
      console.log(`[${TAG}_WARNING] no REDIS_URL: open connections stay up until each Computer reconnects (its key is then refused)`);
    }
    console.log(`[${TAG}_START] ${JSON.stringify({
      mode: options.apply ? "apply" : "dry-run", environment: options.environment, replica: endpoint?.replica ?? null,
      approvalReference: options.approvalReference, runId: options.runId, batch: options.batchSize, sleepMs: options.sleepMs,
      redis: Boolean(redisUrl), excludeComputerIds: options.excludeComputerIds, onlyComputerIds: options.onlyComputerIds,
      startedAt: new Date().toISOString(),
    })}`);
    const result = await run({
      apply: options.apply,
      batchSize: options.batchSize,
      sleepMs: options.sleepMs,
      log: (line) => console.log(line),
      excludeComputerIds: new Set(options.excludeComputerIds),
      ...(options.onlyComputerIds.length > 0 ? { onlyComputerIds: new Set(options.onlyComputerIds) } : {}),
      close: (reach) => (redisUrl ? closeDeviceSessionKeys(reach) : Promise.resolve()),
    });
    console.log(`[${TAG}_DONE] ${JSON.stringify({
      mode: options.apply ? "apply" : "dry-run", runId: options.runId, operationId: result.operationId,
      candidates: result.candidates.length, revoked: result.revoked.length, skipped: result.skipped, excluded: result.excluded,
    })}`);
    if (!options.apply) console.log("dry-run; pass --apply --approval-reference <message> --run-id <id> to write");
  } finally {
    if (redisUrl) await shutdownRedis();
    await closeDatabase();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
