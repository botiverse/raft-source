import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { and, asc, eq, gt, inArray, isNotNull, lt, lte, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { currentDate, currentTimeMs, noopTracer, setClockInterval, setClockTimeout, type MarkUnreadOutcome, type Tracer } from "@botiverse/raft-shared";

import { getBoundedAuthDb, getDb, type DatabaseExecutor, type DatabaseTransaction } from "../db/index";
import { FencedAuthorizationDeniedError, lockActorMembershipRow, ServerMembershipRevokedError } from "../lib/actorMembershipFence";
import { decideReadStateDelegation } from "../lib/actorPermissions";
import { errorClassOf, getCurrentTraceContext, runWithTraceSpan, safeAddTraceEvent } from "../tracing/semanticTrace";
import { withStatementStats } from "../db/statementStats";
import { asServerId } from "@botiverse/raft-shared";
import { prepareJointReadFanout, planJointReadFanout, applyJointReadFanout } from "./jointHumanReadFanout";
import { announceJointHumanReadUpdates } from "./jointHumanReadRealtime";
import {
  filterJointHumanMemberEntries,
  resolveJointHumanEntrySql,
  resolveJointHumanMembershipScopes,
} from "./jointHumanMembershipAccess";
import {
  readMutationWorkerDrainDuration,
  readMutationWorkerDrainsTotal,
} from "../metrics";
import {
  agentChannelReadCursors,
  readMutationAuthorities,
  readMutations,
  readMutationTombstones,
  threadFollows,
  userChannelInboxStates,
  userChannelReadCursors,
} from "../db/schema";
import {
  assertChannelDoneFrontier,
  assertThreadDoneFrontier,
  DoneFrontierBeyondLatestError,
  writeChannelInboxSuppression,
  writeThreadDoneSuppression,
} from "./inboxSuppressionWriters";

export const READ_MUTATION_RECOVERY_HORIZON_MS = 90 * 24 * 60 * 60 * 1_000;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_WORKER_INTERVAL_MS = 1_000;
const DEFAULT_WORKER_BATCH_SIZE = 50;
// Each task compacts every 10 minutes, for up to the time budget below. Each
// row is its own short transaction: production (v1.21.45) measured 24-57 rows
// a second, so one 30 s cycle moves ~700-1,700 rows. Hourly cycles across 12
// tasks gave ~340k rows a day, barely above the ~270k rows a day that become
// terminal, which left a 1.85M-row expired backlog for weeks; every 10 minutes
// is about 2M rows a day. On average less than one task is compacting at once.
const DEFAULT_COMPACTION_INTERVAL_MS = 10 * 60 * 1_000;
// Candidates read per batch. Grouped by principal (see compactTerminalReadMutations),
// a larger batch puts more of one principal's rows into one transaction.
const DEFAULT_COMPACTION_BATCH_SIZE = 500;
// One compaction cycle keeps taking batches while they come back full, for up
// to this long.
const DEFAULT_COMPACTION_TIME_BUDGET_MS = 30_000;
export const READ_MUTATION_COMPATIBILITY_WAIT_MS_ENV = "READ_MUTATION_COMPATIBILITY_WAIT_MS";
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ReadMutationKind = "row_read" | "row_unread" | "channel_read_all" | "conversation_read_all" | "global_read_all" | "done";
export type ReadMutationPrincipalKind = "human" | "agent";
export type ReadMutationState = "admitted" | "executing" | "applied" | "retired_no_effect";
export type ReadMutationTerminalState = Extract<ReadMutationState, "applied" | "retired_no_effect">;
export type ReadMutationTerminalReason =
  | "effect_applied"
  | "already_satisfied"
  | "authorization_revoked"
  | "done_frontier_beyond_latest";

export type DoneTargetKind = "channel" | "thread";

export type ReadMutationPayload =
  | { kind: "row_read"; scopeId: string; throughSeq: number }
  | { kind: "row_unread"; scopeId: string; throughSeq: number }
  | { kind: "channel_read_all"; scopeId: string }
  | { kind: "conversation_read_all"; scopeId: string }
  | { kind: "global_read_all" }
  | { kind: "done"; targetKind: DoneTargetKind; scopeId: string; throughSeq: string };

/**
 * The human acting for an agent receiver (human -> agent read-state delegation). Human principals act for themselves,
 * and an agent principal without an actor is the agent reading for itself.
 */
export type ReadMutationActor = { kind: "human"; userId: string };

/** The typed refusal the task #93 line B admission fence throws; callers map it, side-effect callers swallow only it. */
export function isReadMutationFenceRefusal(error: unknown): error is ServerMembershipRevokedError | FencedAuthorizationDeniedError {
  return error instanceof ServerMembershipRevokedError || error instanceof FencedAuthorizationDeniedError;
}

export type ReadMutationAdmissionInput = {
  serverId: string;
  principalKind?: ReadMutationPrincipalKind;
  principalId: string;
  mutationId: string;
  mutation: ReadMutationPayload;
  actor?: ReadMutationActor;
};

export type ReadMutationAdmissionReceipt = {
  outcome: "ADMITTED" | "ALREADY_ADMITTED" | "ALREADY_TERMINAL";
  serverId: string;
  principalId: string;
  mutationId: string;
  payloadHash: string;
  authoritySeq: number;
  state: ReadMutationState;
  terminalReason: ReadMutationTerminalReason | null;
  terminalDigest: string | null;
  ack: Record<string, unknown> | null;
};

export type ReadMutationClaim = {
  serverId: string;
  principalKind: ReadMutationPrincipalKind;
  principalId: string;
  mutationId: string;
  payloadHash: string;
  authoritySeq: number;
  kind: ReadMutationKind;
  scopeId: string | null;
  requestedThroughSeq: number | null;
  doneTargetKind: DoneTargetKind | null;
  doneThroughSeq: string | null;
  leaseOwner: string;
  leaseGeneration: number;
  leaseExpiresAt: Date;
  attemptCount: number;
};

export type ReadMutationBoundary = { scopeId: string; throughSeq: number | string };

type CapturedMutationBoundary = {
  boundary: ReadMutationBoundary[] | null;
  /** Internal execution fact only; never persisted or exposed in the ACK. */
  applyBroadDoneMarker: boolean;
};

export type ReadMutationAck = {
  serverId: string;
  principalId: string;
  mutationId: string;
  payloadHash: string;
  authoritySeq: number;
  kind: ReadMutationKind;
  terminalState: ReadMutationTerminalState;
  terminalReason: ReadMutationTerminalReason;
  capturedBoundary: ReadMutationBoundary[];
  scopes: Array<{
    scopeId: string;
    maxReadSeq: number;
    readStateVersion: number;
    lastAppliedAuthoritySeq: number;
    changed: boolean;
    /**
     * Unread messages left in the scope after this write (others' messages
     * past maxReadSeq), so clients can update a count they cannot project
     * locally. 0 for the read-all kinds; set for row_read on a live scope;
     * absent otherwise and on acks minted before the field existed.
     * For a human's row_unread on a live scope it is the Mark as Unread
     * answer's count, decided with `unreadOutcome` from the same written
     * state: the latest countable message's seq minus maxReadSeq (0 when none),
     * the measure that answer has always used.
     */
    unreadCount?: number;
    /**
     * The scope is marked unread with nothing countable past the cursor
     * (user_channel_read_cursors.marked_unread): set by a row_unread that found
     * no message of others to rewind over, cleared by every read write. Present
     * only when true; absent on acks minted before the field existed.
     */
    markedUnread?: true;
    /**
     * What a human's row_unread on a live scope left (counted / marked /
     * nothing), decided in this transaction from the state it wrote. Set only
     * there; absent on other kinds and on acks minted before the field existed.
     */
    unreadOutcome?: MarkUnreadOutcome;
  }>;
  terminalDigest: string;
};

export type ReadMutationFailpoint =
  | "before_effect"
  | "after_sql_before_commit"
  | "mid_global"
  | "after_commit_before_response";

export class ReadMutationError extends Error {
  constructor(
    readonly code:
      | "INVALID_MUTATION_ID"
      | "INVALID_MUTATION_PAYLOAD"
      | "MUTATION_ID_PAYLOAD_MISMATCH"
      | "CLAIM_LOST"
      | "SCOPE_NOT_FOUND"
      | "DONE_FRONTIER_BEYOND_LATEST",
    message: string,
  ) {
    super(message);
    this.name = "ReadMutationError";
  }
}

export class ReadMutationFailpointError extends Error {
  constructor(readonly failpoint: ReadMutationFailpoint) {
    super(`read mutation failpoint: ${failpoint}`);
    this.name = "ReadMutationFailpointError";
  }
}

export class CompatibilityReadMutationPendingError extends Error {
  readonly code = "READ_MUTATION_PENDING";

  constructor(
    readonly serverId: string,
    readonly principalId: string,
    readonly mutationId: string,
    readonly authoritySeq: number,
  ) {
    super(`compatibility read mutation ${mutationId} (authoritySeq=${authoritySeq}) is still pending`);
    this.name = "CompatibilityReadMutationPendingError";
  }
}

function assertSafeBoundary(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 2_147_483_647) {
    throw new ReadMutationError("INVALID_MUTATION_PAYLOAD", `${field} must be a non-negative 32-bit integer`);
  }
}

function assertPositiveCanonicalDecimal(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw new ReadMutationError(
      "INVALID_MUTATION_PAYLOAD",
      `${field} must be a positive canonical-decimal string`,
    );
  }
}

function canonicalPayload(payload: ReadMutationPayload): ReadMutationPayload {
  if (!payload || typeof payload !== "object") {
    throw new ReadMutationError("INVALID_MUTATION_PAYLOAD", "mutation payload is required");
  }
  switch (payload.kind) {
    case "row_read":
    case "row_unread": {
      if (typeof payload.scopeId !== "string" || !UUID_V4_RE.test(payload.scopeId)) {
        throw new ReadMutationError("INVALID_MUTATION_PAYLOAD", "scopeId must be a UUID");
      }
      assertSafeBoundary(payload.throughSeq, "throughSeq");
      return { kind: payload.kind, scopeId: payload.scopeId.toLowerCase(), throughSeq: payload.throughSeq };
    }
    case "conversation_read_all":
    case "channel_read_all": {
      if (typeof payload.scopeId !== "string" || !UUID_V4_RE.test(payload.scopeId)) {
        throw new ReadMutationError("INVALID_MUTATION_PAYLOAD", "scopeId must be a UUID");
      }
      return { kind: payload.kind, scopeId: payload.scopeId.toLowerCase() };
    }
    case "done": {
      if (typeof payload.scopeId !== "string" || !UUID_V4_RE.test(payload.scopeId)) {
        throw new ReadMutationError("INVALID_MUTATION_PAYLOAD", "scopeId must be a UUID");
      }
      if (payload.targetKind !== "channel" && payload.targetKind !== "thread") {
        throw new ReadMutationError("INVALID_MUTATION_PAYLOAD", "targetKind must be 'channel' or 'thread'");
      }
      assertPositiveCanonicalDecimal(payload.throughSeq, "throughSeq");
      return {
        kind: payload.kind,
        targetKind: payload.targetKind,
        scopeId: payload.scopeId.toLowerCase(),
        throughSeq: payload.throughSeq,
      };
    }
    case "global_read_all":
      return { kind: payload.kind };
    default:
      throw new ReadMutationError("INVALID_MUTATION_PAYLOAD", "unsupported read mutation kind");
  }
}

export function computeReadMutationPayloadHash(payload: ReadMutationPayload): string {
  const canonical = canonicalPayload(payload);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function digestJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function asNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`unsafe database integer: ${String(value)}`);
  return parsed;
}

/**
 * Task #93 line B: the `servers` row FOR SHARE, taken first by every sequencer transaction that later holds a member
 * row and writes a row whose foreign key references `servers` (read_mutations, the authority row).
 * transitionMemberRole holds `servers` FOR UPDATE and then waits on member rows; taking `servers` first makes the two
 * serialize instead of deadlocking.
 */
async function lockReadMutationServerRow(tx: DatabaseTransaction, serverId: string): Promise<void> {
  await tx.execute(sql`
    SELECT id
    FROM servers
    WHERE id = ${serverId}::uuid
    FOR SHARE
  `);
}

/**
 * Task #93 line B admission fence, taken before the authority row. Order: `servers` FOR SHARE, then the acting
 * principal's membership row FOR SHARE, then (for delegation) the re-check on the locked role. A refusal throws before
 * any write, so a removal or demotion that commits first leaves zero command rows.
 * - Human principal: the human's server_members row (ServerMembershipRevokedError when gone).
 * - Agent principal with a human actor: the human's server_members row, then the agent's server_agent_members row, then
 *   decideReadStateDelegation on the locked role and the agent's creator.
 * - Agent principal without an actor (the agent reading for itself): the agent's server_agent_members row.
 */
async function lockReadMutationAdmissionFence(
  tx: DatabaseTransaction,
  input: { serverId: string; principalKind: ReadMutationPrincipalKind; principalId: string; actor?: ReadMutationActor },
): Promise<void> {
  await lockReadMutationServerRow(tx, input.serverId);
  if (input.principalKind === "human") {
    await lockActorMembershipRow(tx, input.serverId, input.principalId, "share");
    return;
  }
  const actorRole = input.actor
    ? await lockActorMembershipRow(tx, input.serverId, input.actor.userId, "share")
    : null;
  const agentMembership = await tx.execute(sql`
    SELECT sam.agent_id
    FROM server_agent_members sam
    WHERE sam.server_id = ${input.serverId}::uuid
      AND sam.agent_id = ${input.principalId}::uuid
    FOR SHARE
  `);
  if (agentMembership.rows.length !== 1) throw new FencedAuthorizationDeniedError("not_found");
  if (!input.actor) return;
  const agentRows = await tx.execute(sql`
    SELECT a.creator_type AS "creatorType", a.creator_id AS "creatorId", a.assistant_owner_user_id AS "assistantOwnerUserId"
    FROM agents a
    WHERE a.id = ${input.principalId}::uuid
      AND a.server_id = ${input.serverId}::uuid
  `);
  const agent = agentRows.rows[0] as { creatorType: string | null; creatorId: string | null; assistantOwnerUserId: string | null } | undefined;
  if (!agent) throw new FencedAuthorizationDeniedError("not_found");
  const decision = decideReadStateDelegation({ callerServerRole: actorRole, userId: input.actor.userId, agent });
  if (!decision.allowed) throw new FencedAuthorizationDeniedError("forbidden");
}

/**
 * Every sequencer transaction waits at most this long for a row lock (the
 * authority row, read_mutations, cursors), then fails with 55P03 instead of
 * holding a pool connection until the 15 s statement timeout. A stray holder
 * (10-27 09:20Z: an idle-in-transaction session on read_mutation_authorities)
 * then costs one fast failure: a worker claim stays leased and is retried after
 * the lease, an admission or inline wait fails the request as the timeout did,
 * only sooner. SET LOCAL ends with the transaction.
 */
export const SEQUENCER_LOCK_TIMEOUT = "3s";

function sequencerTransaction<T>(fn: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${SEQUENCER_LOCK_TIMEOUT}'`));
    return fn(tx);
  }).catch(async (error: unknown) => {
    if (isLockNotAvailable(error)) await logSequencerLockHolders();
    throw error;
  });
}

function isLockNotAvailable(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 5; depth += 1) {
    if ((current as { code?: unknown }).code === "55P03") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * After a sequencer lock_timeout, trace the lock chain back to its front: for
 * every session waiting on a lock right now, who blocks it (pg_blocking_pids).
 * The blockers that are not themselves waiting on a lock are the front of the
 * chain (e.g. a membership change holding a channel row or advisory lock while
 * idle in transaction), which locks on the read tables alone would miss.
 * Runs only on that failure, at most once per 30 s per process, on the bounded
 * side pool (never the content pool, which is full during a burst) with a 1 s
 * statement timeout. Logs pid, state, user, wait event, transaction age and a
 * hash of the query; never the query text or its parameters. Never throws.
 */
const LOCK_HOLDER_SAMPLE_INTERVAL_MS = 30_000;
let lastLockHolderSampleAtMs = 0;

async function logSequencerLockHolders(): Promise<void> {
  const nowMs = Date.now();
  if (nowMs - lastLockHolderSampleAtMs < LOCK_HOLDER_SAMPLE_INTERVAL_MS) return;
  lastLockHolderSampleAtMs = nowMs;
  try {
    const side = getBoundedAuthDb(1_000);
    if (!side) return;
    const result = await side.execute(sql`
      SELECT w.pid AS "waiterPid", b.pid AS "blockerPid", b.state, b.usename AS "user",
             b.wait_event_type AS "waitEventType", b.wait_event AS "waitEvent",
             round(extract(epoch FROM now() - b.xact_start))::int AS "transactionAgeSeconds",
             left(md5(coalesce(b.query, '')), 16) AS "queryHash"
      FROM pg_stat_activity w
      CROSS JOIN LATERAL unnest(pg_blocking_pids(w.pid)) AS bp(pid)
      JOIN pg_stat_activity b ON b.pid = bp.pid
      WHERE w.wait_event_type = 'Lock' AND w.pid <> pg_backend_pid()
      ORDER BY "transactionAgeSeconds" DESC NULLS LAST
      LIMIT 10
    `);
    const edges = result.rows as Array<Record<string, unknown>>;
    // The front of the chain: blockers not themselves waiting on a lock.
    const roots = [...new Map(edges
      .filter((edge) => edge.waitEventType !== "Lock")
      .map((edge) => [edge.blockerPid, edge])).values()];
    console.warn("[ReadMutationSequencer] lock_timeout; lock chain", { roots, waits: edges.length });
    const root = roots[0];
    safeAddTraceEvent("server.read_mutation_sequencer.lock_timeout", () => ({
      waiting_edge_count: edges.length,
      root_count: roots.length,
      ...(root ? {
        root_pid: Number(root.blockerPid ?? 0),
        root_state: String(root.state ?? ""),
        root_user: String(root.user ?? ""),
        root_wait_event: String(root.waitEvent ?? ""),
        root_transaction_age_s: Number(root.transactionAgeSeconds ?? 0),
        root_query_hash: String(root.queryHash ?? ""),
      } : {}),
    }));
  } catch (error) {
    console.warn("[ReadMutationSequencer] lock_timeout; lock chain lookup failed", { error: (error as Error)?.message });
  }
}

let beforeCompactionDeleteForTests: ((tx: DatabaseTransaction) => Promise<void>) | null = null;

/** Test hook: run inside a compaction chunk after its identity check, before its delete. */
export function setBeforeCompactionDeleteForTests(hook: ((tx: DatabaseTransaction) => Promise<void>) | null): void {
  beforeCompactionDeleteForTests = hook;
}

/** Test hook: let the next lock_timeout sample regardless of the 30 s limit. */
export function resetLockHolderSampleLimitForTests(): void {
  lastLockHolderSampleAtMs = 0;
}

/**
 * Compaction's lock: the authority row if it is free, else null. Compaction
 * never waits on a principal another worker (or the drain) holds; it skips it
 * and a later cycle compacts it.
 */
async function tryLockAuthority(
  tx: DatabaseTransaction,
  serverId: string,
  principalKind: ReadMutationPrincipalKind,
  principalId: string,
): Promise<boolean> {
  const locked = await tx.execute(sql`
    SELECT 1 FROM read_mutation_authorities
    WHERE server_id = ${serverId}::uuid
      AND principal_type = ${principalKind}
      AND principal_id = ${principalId}::uuid
    FOR UPDATE SKIP LOCKED
  `);
  return locked.rows.length > 0;
}

async function lockAuthority(
  tx: DatabaseTransaction,
  serverId: string,
  principalKind: ReadMutationPrincipalKind,
  principalId: string,
): Promise<{ nextAuthoritySeq: number; lastTerminalAuthoritySeq: number }> {
  await tx.insert(readMutationAuthorities).values({
    serverId,
    principalType: principalKind,
    principalId,
  }).onConflictDoNothing({
    target: [readMutationAuthorities.serverId, readMutationAuthorities.principalType, readMutationAuthorities.principalId],
  });
  const locked = await tx.execute(sql`
    SELECT next_authority_seq AS "nextAuthoritySeq",
           last_terminal_authority_seq AS "lastTerminalAuthoritySeq"
    FROM read_mutation_authorities
    WHERE server_id = ${serverId}::uuid
      AND principal_type = ${principalKind}
      AND principal_id = ${principalId}::uuid
    FOR UPDATE
  `);
  const [row] = locked.rows as Array<{ nextAuthoritySeq: unknown; lastTerminalAuthoritySeq: unknown }>;
  if (!row) throw new Error("failed to establish read mutation authority row");
  return {
    nextAuthoritySeq: asNumber(row.nextAuthoritySeq),
    lastTerminalAuthoritySeq: asNumber(row.lastTerminalAuthoritySeq),
  };
}

/**
 * Why a caller without content access was admitted, purely to retire residue
 * they own. Closed list: the residue boundary tests enumerate it, so a reason
 * added here without a test cell fails the suite.
 *
 * - deleted_inbox: the target channel (not a DM) is soft-deleted.
 * - lost_access: no current membership of a private, DM, or joint channel, or
 *   of the parent of a thread (task #48). Never a content-access authority.
 * - unavailable_thread_parent: an active thread whose parent authority is gone.
 */
export const READ_SCOPE_RESIDUE_REASONS = ["deleted_inbox", "lost_access", "unavailable_thread_parent"] as const;
export type ReadScopeResidueReason = (typeof READ_SCOPE_RESIDUE_REASONS)[number];

declare const liveReadScopeBrand: unique symbol;
/**
 * Proof that the resolver granted live content authority over one message
 * storage scope. Only the resolver's live branch mints it (task #64). Every
 * query that reads a channel's live frontier takes this value, so a residue
 * scope, including one added later, cannot reach the live frontier without a
 * type error. That is the fail-closed default: residue never defaults to live.
 */
export type LiveReadScope = { readonly storageScopeId: string; readonly [liveReadScopeBrand]: true };

function mintLiveReadScope(storageScopeId: string): LiveReadScope {
  return { storageScopeId } as LiveReadScope;
}

type ReadScopeAuthority =
  | { kind: "live"; scope: LiveReadScope }
  | { kind: "residue"; reason: ReadScopeResidueReason };

type AuthorizedReadMutationScope = {
  scopeId: string;
  // `task`: a task conversation (task v2) — authorized like a thread, through
  // its parent channel (parent_channel_id on every face).
  channelType: "channel" | "private" | "joint" | "dm" | "thread" | "task";
  authority: ReadScopeAuthority;
  /** Proven and locked by the computed root membership check, never by CH. */
  computedJointMember?: true;
};

function liveReadScopeOf(resolved: AuthorizedReadMutationScope | null): LiveReadScope | null {
  return resolved?.authority.kind === "live" ? resolved.authority.scope : null;
}

/**
 * Receiver-owned evidence that this principal once had a relationship with this
 * scope, used ONLY to let them retire their own residue after losing access.
 *
 * ⚠️ Deliberately NOT the same predicate as
 * `channelService.hasPriorChannelRelationship`, and the divergence is a ruling
 * (@Tenny, #proj-activity:b3ffd225), not an oversight. They answer different
 * questions:
 *
 *   hasPriorChannelRelationship  "are you a STRANGER?"   -> may we tell you the
 *                                                          truth about this channel
 *   this predicate               "do you own rows HERE?" -> may you retire them
 *
 * One definition serving two questions is how a symbol acquires two referents.
 * Do not "tidy" these into one: unifying them would also have to change the
 * live deleted-channel branch, and would buy nothing -- the exposure either way
 * is zero.
 */
function lostAccessResidueEvidence(
  input: { principalKind: ReadMutationPrincipalKind; principalId: string; serverId: string },
  accessChannelId: string,
) {
  const receiverType = input.principalKind === "human" ? "user" : "agent";
  const cursorEvidence = input.principalKind === "human"
    ? sql`EXISTS (
        SELECT 1 FROM user_channel_read_cursors c
        WHERE c.user_id = ${input.principalId}::uuid AND c.channel_id = ${accessChannelId}::uuid
      )`
    : sql`EXISTS (
        SELECT 1 FROM agent_channel_read_cursors c
        WHERE c.agent_id = ${input.principalId}::uuid AND c.channel_id = ${accessChannelId}::uuid
      )`;
  return sql`(
    ${cursorEvidence}
    OR EXISTS (
      SELECT 1 FROM inbox_notification_facts f
      WHERE f.receiver_type = ${receiverType}
        AND f.receiver_id = ${input.principalId}::uuid
        AND f.server_id = ${input.serverId}::uuid
        AND f.source_channel_id = ${accessChannelId}::uuid
    )
  )`;
}

async function lockActiveReadMutationPrincipal(
  tx: DatabaseTransaction,
  serverId: string,
  principalKind: ReadMutationPrincipalKind,
  principalId: string,
): Promise<boolean> {
  const membership = principalKind === "human"
    ? await tx.execute(sql`
        SELECT sm.user_id
        FROM server_members sm
        WHERE sm.server_id = ${serverId}::uuid
          AND sm.user_id = ${principalId}::uuid
        FOR KEY SHARE
      `)
    : await tx.execute(sql`
        SELECT sam.agent_id
        FROM server_agent_members sam
        WHERE sam.server_id = ${serverId}::uuid
          AND sam.agent_id = ${principalId}::uuid
        FOR KEY SHARE
      `);
  return membership.rows.length === 1;
}

/** Joint roots replace local CH authority, including a sub-conversation's
 * parent. Absence from the map means not a joint projection (local CH
 * authority applies), not denial. Keep the current J member locked through the
 * cursor write, just as the CH path locks CH; admissions/source labels never
 * grant read authority. */
async function lockComputedJointReadMembership(
  tx: DatabaseTransaction,
  localChannelIds: string[],
  userId: string,
): Promise<Map<string, boolean>> {
  if (localChannelIds.length === 0) return new Map();
  const scopes = [...(await resolveJointHumanMembershipScopes({ localChannelIds }, tx)).values()];
  if (scopes.length === 0) return new Map();
  await tx.execute(sql`
    SELECT joint_channel_id FROM joint_channel_members
    WHERE user_id = ${userId}::uuid
      AND joint_channel_id = ANY(${sql.param([...new Set(scopes.map((scope) => scope.jointId))])}::uuid[])
    ORDER BY joint_channel_id
    FOR KEY SHARE
  `);
  const allowed = await filterJointHumanMemberEntries(scopes, userId, tx);
  return new Map(scopes.map((scope) => [scope.localChannelId, allowed.has(scope.localChannelId)]));
}

/**
 * Resolve one caller-visible local scope to message storage while holding the
 * authorization rows in the caller's transaction. Canonical joint storage is
 * never accepted as an input authority: every joint channel/thread starts at
 * the active local projection in the authenticated server.
 */
async function resolveAuthorizedReadMutationScope(
  tx: DatabaseTransaction,
  input: {
    serverId: string;
    principalKind: ReadMutationPrincipalKind;
    principalId: string;
    scopeId: string;
    allowDeletedInboxResidue?: boolean;
    allowLostAccessResidue?: boolean;
  },
): Promise<AuthorizedReadMutationScope | null> {
  if (!await lockActiveReadMutationPrincipal(tx, input.serverId, input.principalKind, input.principalId)) return null;

  const receiverType = input.principalKind === "human" ? "user" : "agent";
  const deletedCursorEvidence = input.principalKind === "human"
    ? sql`EXISTS (
        SELECT 1
        FROM user_channel_read_cursors stale_cursor
        WHERE stale_cursor.user_id = ${input.principalId}::uuid
          AND stale_cursor.channel_id = c.id
      )`
    : sql`EXISTS (
        SELECT 1
        FROM agent_channel_read_cursors stale_cursor
        WHERE stale_cursor.agent_id = ${input.principalId}::uuid
          AND stale_cursor.channel_id = c.id
      )`;
  const localResult = await tx.execute(sql`
    SELECT c.id::text AS "scopeId",
           c.type::text AS "channelType",
           c.parent_message_id::text AS "parentMessageId",
           c.deleted_at AS "deletedAt"
    FROM channels c
    WHERE c.id = ${input.scopeId}::uuid
      AND c.server_id = ${input.serverId}::uuid
      AND (
        c.deleted_at IS NULL
        OR c.type = 'dm'
        OR (
          ${input.allowDeletedInboxResidue === true}
          AND c.deleted_at IS NOT NULL
          AND (
            EXISTS (
              SELECT 1
              FROM inbox_notification_facts stale_fact
              WHERE stale_fact.receiver_type = ${receiverType}
                AND stale_fact.receiver_id = ${input.principalId}::uuid
                AND stale_fact.server_id = ${input.serverId}::uuid
                AND stale_fact.source_channel_id = c.id
            )
            OR ${deletedCursorEvidence}
          )
        )
      )
    FOR KEY SHARE
  `);
  const [local] = localResult.rows as Array<{
    scopeId: string;
    channelType: AuthorizedReadMutationScope["channelType"];
    parentMessageId: string | null;
    deletedAt: Date | null;
  }>;
  if (!local) return null;

  // A deleted target is never a content-access authority. The only relaxed
  // path is a receiver-owned Activity/read residue proven by the predicates
  // above, and it exists solely so channel_read_all can retire that residue.
  // Do not traverse current membership/joint/thread authority from a deleted
  // row: those relationships may already have been removed during cleanup.
  if (local.deletedAt && local.channelType !== "dm") {
    return {
      scopeId: local.scopeId,
      channelType: local.channelType,
      authority: { kind: "residue", reason: "deleted_inbox" },
    };
  }

  let storageScopeId = local.scopeId;
  if (local.channelType === "joint" || local.channelType === "thread" || local.channelType === "task") {
    const projectionResult = await tx.execute(sql`
      SELECT projection.local_channel_id::text AS "localScopeId",
             joint_storage.canonical_channel_id::text AS "canonicalScopeId"
      FROM joint_channel_servers projection
      INNER JOIN joint_channels joint_storage
        ON joint_storage.id = projection.joint_channel_id
       AND joint_storage.status = 'active'
      WHERE projection.local_channel_id = ${local.scopeId}::uuid
        AND projection.server_id = ${input.serverId}::uuid
        AND projection.status = 'active'
      FOR KEY SHARE OF projection, joint_storage
    `);
    const [projection] = projectionResult.rows as Array<{ localScopeId: string; canonicalScopeId: string }>;
    if (local.channelType === "joint") {
      if (!projection || projection.localScopeId !== local.scopeId) return null;
      storageScopeId = projection.canonicalScopeId;
    } else if (projection) {
      storageScopeId = projection.canonicalScopeId;
    }
  }

  let accessChannelId = local.scopeId;
  let accessChannelType = local.channelType;
  if (local.channelType === "task") {
    // Task conversation (task v2): every face carries its local parent channel.
    const parentAccess = await tx.execute(sql`
      SELECT parent.id::text AS "scopeId", parent.type::text AS "channelType"
      FROM channels conversation
      INNER JOIN channels parent ON parent.id = conversation.parent_channel_id
      WHERE conversation.id = ${local.scopeId}::uuid
        AND conversation.type = 'task'
        AND parent.server_id = ${input.serverId}::uuid
        AND parent.deleted_at IS NULL
      FOR KEY SHARE OF conversation, parent
    `);
    const [parentChannel] = parentAccess.rows as Array<{
      scopeId: string;
      channelType: AuthorizedReadMutationScope["channelType"];
    }>;
    if (!parentChannel || parentChannel.channelType === "thread" || parentChannel.channelType === "task") {
      if (input.allowLostAccessResidue === true) {
        const residue = await tx.execute(sql`
          SELECT 1
          WHERE ${lostAccessResidueEvidence(input, local.scopeId)}
        `);
        if (residue.rows.length === 1) {
          return {
            scopeId: local.scopeId,
            channelType: local.channelType,
            authority: { kind: "residue", reason: "unavailable_thread_parent" },
          };
        }
      }
      return null;
    }
    accessChannelId = parentChannel.scopeId;
    accessChannelType = parentChannel.channelType;
  } else if (local.channelType === "thread") {
    const parentResult = await tx.execute(sql`
      SELECT parent_message.channel_id::text AS "canonicalParentScopeId"
      FROM channels storage_thread
      INNER JOIN messages parent_message ON parent_message.id = storage_thread.parent_message_id
      WHERE storage_thread.id = ${storageScopeId}::uuid
        AND storage_thread.type = 'thread'
        AND storage_thread.deleted_at IS NULL
      FOR KEY SHARE OF storage_thread, parent_message
    `);
    const [parent] = parentResult.rows as Array<{ canonicalParentScopeId: string }>;
    if (!parent) return null;

    const localParentProjection = await tx.execute(sql`
      SELECT parent_projection.local_channel_id::text AS "localParentScopeId"
      FROM joint_channels parent_joint
      INNER JOIN joint_channel_servers parent_projection
        ON parent_projection.joint_channel_id = parent_joint.id
       AND parent_projection.server_id = ${input.serverId}::uuid
       AND parent_projection.status = 'active'
      WHERE parent_joint.canonical_channel_id = ${parent.canonicalParentScopeId}::uuid
        AND parent_joint.status = 'active'
      FOR KEY SHARE OF parent_joint, parent_projection
    `);
    const [parentProjection] = localParentProjection.rows as Array<{ localParentScopeId: string }>;
    const parentScopeId = parentProjection?.localParentScopeId ?? parent.canonicalParentScopeId;
    const parentAccess = await tx.execute(sql`
      SELECT c.id::text AS "scopeId", c.type::text AS "channelType"
      FROM channels c
      WHERE c.id = ${parentScopeId}::uuid
        AND c.server_id = ${input.serverId}::uuid
        AND c.deleted_at IS NULL
      FOR KEY SHARE
    `);
    const [parentChannel] = parentAccess.rows as Array<{
      scopeId: string;
      channelType: AuthorizedReadMutationScope["channelType"];
    }>;
    if (!parentChannel || parentChannel.channelType === "thread") {
      if (input.allowLostAccessResidue === true) {
        const residue = await tx.execute(sql`
          SELECT 1
          WHERE ${lostAccessResidueEvidence(input, local.scopeId)}
        `);
        if (residue.rows.length === 1) {
          return {
            scopeId: local.scopeId,
            channelType: local.channelType,
            authority: { kind: "residue", reason: "unavailable_thread_parent" },
          };
        }
      }
      return null;
    }
    accessChannelId = parentChannel.scopeId;
    accessChannelType = parentChannel.channelType;
  }

  let computedJointMember = false;
  if (accessChannelType !== "channel") {
    const computed = input.principalKind === "human" && accessChannelType === "joint"
      ? await lockComputedJointReadMembership(tx, [accessChannelId], input.principalId)
      : new Map<string, boolean>();
    computedJointMember = computed.get(accessChannelId) === true;
    const participates = computed.has(accessChannelId)
      ? computed.get(accessChannelId) === true
      : (input.principalKind === "human"
      ? await tx.execute(sql`
          SELECT ch.user_id
          FROM channel_humans ch
          WHERE ch.channel_id = ${accessChannelId}::uuid
            AND ch.user_id = ${input.principalId}::uuid
          FOR KEY SHARE
        `)
      : await tx.execute(sql`
          SELECT ca.agent_id
          FROM channel_agents ca
          WHERE ca.channel_id = ${accessChannelId}::uuid
            AND ca.agent_id = ${input.principalId}::uuid
          FOR KEY SHARE
        `)).rows.length === 1;
    if (!participates) {
      // Task #48, usability half. Losing access must not strand the Activity
      // entry a receiver already owns: a removed member, or a participant of a
      // soft-deleted DM, still has rows of their own and no way to retire them.
      //
      // Same relaxation as the deleted-channel branch above, under the same
      // rule: this is NEVER a content-access authority. It is admitted only for
      // channel_read_all, and only on evidence the RECEIVER owns -- rows a
      // stranger cannot manufacture, so nobody can move themselves in here.
      if (input.allowLostAccessResidue !== true) return null;
      // Task #66. For a thread, ask about the thread's OWN rows as well as the
      // parent's. Admission used to consult only the parent while
      // captureResidueBoundary has always read the thread's own rows, so a
      // receiver whose residue sits only on the thread got 404 and could never
      // retire it. Both sides are rows the RECEIVER owns and a stranger cannot
      // manufacture, so this widens WHO is admitted, never WHAT they may read:
      // the boundary is unchanged, and a residue reason still cannot mint a
      // LiveReadScope, so the live frontier stays unreachable by construction.
      //
      // `lost_access` deliberately covers two populations: a receiver who lost
      // access to the parent, and one who NEVER had parent access but owns
      // residue on the thread (being @-mentioned in it produces those rows).
      // The name is kept for both, and the distinction is not needed: neither
      // population is a probe -- both are residue authority bounded by
      // receiver-owned rows.
      const residueScopeIds = (local.channelType === "thread" || local.channelType === "task") && local.scopeId !== accessChannelId
        ? [accessChannelId, local.scopeId]
        : [accessChannelId];
      const residue = await tx.execute(sql`
        SELECT 1
        WHERE ${sql.join(residueScopeIds.map((scopeId) => lostAccessResidueEvidence(input, scopeId)), sql` OR `)}
      `);
      if (residue.rows.length !== 1) return null;
      return {
        scopeId: local.scopeId,
        channelType: local.channelType,
        authority: { kind: "residue", reason: "lost_access" },
      };
    }
  }

  return {
    scopeId: local.scopeId,
    channelType: local.channelType,
    authority: { kind: "live", scope: mintLiveReadScope(storageScopeId) },
    ...(computedJointMember ? { computedJointMember: true as const } : {}),
  };
}

/**
 * Test-only (task #64): the authority branch `channel_read_all` resolves to for
 * one scope, with the same residue relaxations admission and boundary capture
 * use. Boundary tests assert this first, so a green result means the intended
 * branch actually ran instead of some other branch that happens to be bounded.
 */
export async function inspectChannelReadAllScopeAuthorityForTests(input: {
  serverId: string;
  principalKind: ReadMutationPrincipalKind;
  principalId: string;
  scopeId: string;
}): Promise<"live" | ReadScopeResidueReason | null> {
  return sequencerTransaction(async (tx) => {
    const resolved = await resolveAuthorizedReadMutationScope(tx, {
      ...input,
      allowDeletedInboxResidue: true,
      allowLostAccessResidue: true,
    });
    if (!resolved) return null;
    return resolved.authority.kind === "live" ? "live" : resolved.authority.reason;
  });
}

async function resolveAuthorizedReadMutationScopes(
  tx: DatabaseTransaction,
  input: {
    serverId: string;
    principalKind: ReadMutationPrincipalKind;
    principalId: string;
    scopeIds: string[];
  },
): Promise<AuthorizedReadMutationScope[]> {
  // Resolve in key order (uuid order == lowercase hex order) so the KEY SHARE
  // locks of several scopes are taken in the same order as the batch path and
  // conversion rollback; caller order would let two scopes lock in reverse.
  const ordered = [...input.scopeIds].sort((a, b) => {
    const left = a.toLowerCase();
    const right = b.toLowerCase();
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const resolved: AuthorizedReadMutationScope[] = [];
  for (const scopeId of ordered) {
    const scope = await resolveAuthorizedReadMutationScope(tx, { ...input, scopeId });
    if (scope) resolved.push(scope);
  }
  return resolved;
}

/**
 * Batched live-scope resolution for global_read_all.
 *
 * The per-scope resolver (resolveAuthorizedReadMutationScope) runs 2–6
 * statements per scope; this version resolves every candidate in TWO
 * statements for the structural lookup regardless of count: one for non-thread scopes (local row +
 * joint projection + participant check) and one for thread scopes (parent
 * chain + parent projection + parent access + participant check). Output is
 * re-sorted into candidate order afterward because the boundary and ack feed
 * the terminal digest.
 * Joint human roots additionally lock/recheck J membership in a batch,
 * instead of depending on local CH.
 *
 * Lock order (uniform hierarchy — the refinement of Task #101's
 * "servers → member rows → resource rows" for this resolution; every
 * statement below orders by primary key so acquiring hundreds of KEY SHARE
 * rows is deterministic). Retained locks: the local channels row (every
 * scope), plus the storage-thread and parent-message rows for threads —
 * all inner-join sides. The per-scope path additionally took KEY SHARE on
 * projection / participant / parent-channel rows; those are LEFT-join
 * sides, which Postgres refuses to lock in one statement ("FOR KEY SHARE
 * cannot be applied to the nullable side of an outer join"), and the
 * protection was defensive against the channel-conversion-rollback path —
 * the documented known exception below — so the batch path deliberately
 * relaxes them. The local row lock anchors every resolved scope.
 * Channel-conversion rollback (rollbackConversionToSource) is the only path
 * that hard-deletes or re-keys rows locked here. It locks them all up front
 * in this same order — per thread in local-id order, then the parent joint
 * level — before changing any, so it cannot close a cycle with this path or
 * the per-scope resolver (pinned by
 * channelConversionRollbackLockOrder.realPg.test.ts). Keep the two in step:
 * a new KEY SHARE target here must be locked there in the same position.
 * The one message -> thread write is 0297's parent_channel_id trigger: it
 * only takes FOR NO KEY UPDATE on the thread row, which never conflicts with
 * the KEY SHARE here (pinned by channelParentChannelIdLockOrder.realPg.test.ts).
 *
 * Scope contract (pinned by tests, do not widen silently): the global path
 * resolves ONLY live authority. The residue branches
 * (deleted_inbox / unavailable_thread_parent / lost_access) exist for
 * channel_read_all, whose caller passes the allow*Residue flags; this
 * function takes no such flags, and any scope the live predicates reject is
 * dropped — matching what the plural resolver produced for global_read_all.
 */
async function resolveGlobalLiveReadScopes(
  tx: DatabaseTransaction,
  input: {
    serverId: string;
    principalKind: ReadMutationPrincipalKind;
    principalId: string;
    candidates: ReadonlyArray<{ scopeId: string; channelType: string }>;
  },
): Promise<AuthorizedReadMutationScope[]> {
  const serverId = input.serverId;
  const principalKind = input.principalKind;
  const principalId = input.principalId;
  const candidates = input.candidates;
  if (candidates.length === 0) return [];
  const seen = new Set<string>();
  const positions = new Map<string, number>();
  candidates.forEach((candidate, index) => {
    if (seen.has(candidate.scopeId)) throw new Error("global scope resolution received a duplicate scope id");
    seen.add(candidate.scopeId);
    positions.set(candidate.scopeId, index);
  });
  const nonThreadIds = candidates.filter((c) => c.channelType !== "thread" && c.channelType !== "task").map((c) => c.scopeId);
  const threadIds = candidates.filter((c) => c.channelType === "thread").map((c) => c.scopeId);
  // Task conversations (task v2): authorized through their parent channel.
  const taskConversationIds = candidates.filter((c) => c.channelType === "task").map((c) => c.scopeId);
  if (nonThreadIds.length === 0 && threadIds.length === 0 && taskConversationIds.length === 0) return [];
  const membershipTable = principalKind === "human" ? "channel_humans" : "channel_agents";
  const membershipPrincipalColumn = principalKind === "human" ? "user_id" : "agent_id";

  const resolvedByScopeId = new Map<string, AuthorizedReadMutationScope>();
  // Authorization via membership is enforced by the dedicated lock statement
  // below (statement 3), not by these queries: the per-scope path's
  // participant check was an authorization lock, not a data lookup — Task
  // #101's serverService relies on these rows staying locked (Ray's review).
  // Maps record which membership rows each surviving scope depends on.
  const localMembershipScopeIds: string[] = [];
  const threadParentMembership = new Map<string, string>();
  const jointRootIds = new Set<string>();

  // Statement 1 — non-thread locals: local channel row and joint projection.
  if (nonThreadIds.length > 0) {
    const locals = await tx.execute(sql`
      SELECT s.scope_id::text AS "scopeId",
             c.type::text AS "channelType",
             j.canonical_channel_id::text AS "canonicalScopeId"
      FROM unnest(${sql.param(nonThreadIds)}::uuid[]) WITH ORDINALITY AS s(scope_id, ord)
      JOIN channels c
        ON c.id = s.scope_id
       AND c.server_id = ${serverId}::uuid
       AND (c.deleted_at IS NULL OR c.type = 'dm')
      LEFT JOIN joint_channel_servers jps
        ON jps.local_channel_id = c.id
       AND jps.server_id = ${serverId}::uuid
       AND jps.status = 'active'
       AND c.type = 'joint'
      LEFT JOIN joint_channels j
        ON j.id = jps.joint_channel_id
       AND j.status = 'active'
      WHERE c.type NOT IN ('thread', 'task')
      ORDER BY s.scope_id
      FOR KEY SHARE OF c
    `);
    for (const row of locals.rows as Array<{
      scopeId: string;
      channelType: string;
      canonicalScopeId: string | null;
    }>) {
      const channelType = row.channelType as AuthorizedReadMutationScope["channelType"];
      if (channelType === "joint" && !row.canonicalScopeId) continue;
      if (channelType === "joint") jointRootIds.add(row.scopeId);
      // All non-thread scopes lock membership: for private/joint/dm it is the
      // authorization check; for plain channels the row exists by construction
      // of the candidate listing, so the lock is a fixed-cost no-op that keeps
      // the statement count and the drop rule uniform (Ray's review).
      localMembershipScopeIds.push(row.scopeId);
      resolvedByScopeId.set(row.scopeId, {
        scopeId: row.scopeId,
        channelType,
        authority: { kind: "live", scope: mintLiveReadScope(channelType === "joint" ? row.canonicalScopeId! : row.scopeId) },
      });
    }
  }

  // Statement 2 — threads: local row, canonical projection, storage thread,
  // parent message, parent projection, parent access channel. INNER joins
  // reproduce the per-scope "parent must exist" gate. Skipped entirely when
  // there are no thread candidates — that skip is what the sweep-B
  // statement-count assertion pins as the thread branch's fixed cost.
  if (threadIds.length > 0) {
    const threads = await tx.execute(sql`
      SELECT s.scope_id::text AS "scopeId",
             c.type::text AS "channelType",
             j.canonical_channel_id::text AS "canonicalScopeId",
             pc.id::text AS "parentAccessScopeId",
             pc.type::text AS "parentAccessChannelType"
      FROM unnest(${sql.param(threadIds)}::uuid[]) WITH ORDINALITY AS s(scope_id, ord)
      JOIN channels c
        ON c.id = s.scope_id
       AND c.server_id = ${serverId}::uuid
       AND (c.deleted_at IS NULL OR c.type = 'dm')
      LEFT JOIN joint_channel_servers jps
        ON jps.local_channel_id = c.id
       AND jps.server_id = ${serverId}::uuid
       AND jps.status = 'active'
      LEFT JOIN joint_channels j
        ON j.id = jps.joint_channel_id
       AND j.status = 'active'
      JOIN channels st
        ON st.id = COALESCE(j.canonical_channel_id, c.id)
       AND st.type = 'thread'
       AND st.deleted_at IS NULL
      JOIN messages pm
        ON pm.id = st.parent_message_id
      LEFT JOIN joint_channels pj
        ON pj.canonical_channel_id = pm.channel_id
       AND pj.status = 'active'
      LEFT JOIN joint_channel_servers pps
        ON pps.joint_channel_id = pj.id
       AND pps.server_id = ${serverId}::uuid
       AND pps.status = 'active'
      LEFT JOIN channels pc
        ON pc.id = COALESCE(pps.local_channel_id, pm.channel_id)
       AND pc.server_id = ${serverId}::uuid
       AND pc.deleted_at IS NULL
      WHERE c.type = 'thread'
      ORDER BY s.scope_id
      FOR KEY SHARE OF c, st, pm
    `);
    for (const row of threads.rows as Array<{
      scopeId: string;
      channelType: string;
      canonicalScopeId: string | null;
      parentAccessScopeId: string | null;
      parentAccessChannelType: string | null;
    }>) {
      if (!row.parentAccessScopeId) continue;
      if (row.parentAccessChannelType === "thread") continue;
      if (row.parentAccessChannelType !== "channel") {
        threadParentMembership.set(row.scopeId, row.parentAccessScopeId);
      }
      if (row.parentAccessChannelType === "joint") jointRootIds.add(row.parentAccessScopeId);
      resolvedByScopeId.set(row.scopeId, {
        scopeId: row.scopeId,
        channelType: "thread",
        authority: { kind: "live", scope: mintLiveReadScope(row.canonicalScopeId ?? row.scopeId) },
      });
    }
  }

  // Statement 2b — task conversations (task v2): local face, its canonical
  // projection, and its parent access channel (parent_channel_id). Skipped
  // when there are none, so thread-only resolutions keep their statement count.
  if (taskConversationIds.length > 0) {
    const conversations = await tx.execute(sql`
      SELECT s.scope_id::text AS "scopeId",
             j.canonical_channel_id::text AS "canonicalScopeId",
             pc.id::text AS "parentAccessScopeId",
             pc.type::text AS "parentAccessChannelType"
      FROM unnest(${sql.param(taskConversationIds)}::uuid[]) WITH ORDINALITY AS s(scope_id, ord)
      JOIN channels c
        ON c.id = s.scope_id
       AND c.server_id = ${serverId}::uuid
       AND c.deleted_at IS NULL
       AND c.type = 'task'
      LEFT JOIN joint_channel_servers jps
        ON jps.local_channel_id = c.id
       AND jps.server_id = ${serverId}::uuid
       AND jps.status = 'active'
      LEFT JOIN joint_channels j
        ON j.id = jps.joint_channel_id
       AND j.status = 'active'
      JOIN channels pc
        ON pc.id = c.parent_channel_id
       AND pc.server_id = ${serverId}::uuid
       AND pc.deleted_at IS NULL
      ORDER BY s.scope_id
      FOR KEY SHARE OF c, pc
    `);
    for (const row of conversations.rows as Array<{
      scopeId: string;
      canonicalScopeId: string | null;
      parentAccessScopeId: string;
      parentAccessChannelType: string;
    }>) {
      if (row.parentAccessChannelType === "thread" || row.parentAccessChannelType === "task") continue;
      if (row.parentAccessChannelType !== "channel") {
        threadParentMembership.set(row.scopeId, row.parentAccessScopeId);
      }
      if (row.parentAccessChannelType === "joint") jointRootIds.add(row.parentAccessScopeId);
      resolvedByScopeId.set(row.scopeId, {
        scopeId: row.scopeId,
        channelType: "task",
        authority: { kind: "live", scope: mintLiveReadScope(row.canonicalScopeId ?? row.scopeId) },
      });
    }
  }

  // Statement 3 — the authorization lock: one KEY SHARE over every membership
  // row this resolution relies on, in primary-key order. The per-scope path
  // held these locks through its participant check; dropping them was the
  // review's must-fix. Ids absent from the result lack membership and their
  // scopes are dropped below — exactly the per-scope resolver returning null.
  // Plain-channel access never required membership (the per-scope path skipped
  // the participant check for it) so those ids are not locked.
  const computed = principalKind === "human"
    ? await lockComputedJointReadMembership(tx, [...jointRootIds], principalId)
    : new Map<string, boolean>();
  const lockIdSet = new Set<string>([
    ...localMembershipScopeIds,
    ...threadParentMembership.values(),
  ]);
  // Only legacy roots depend on CH. A computed member can have no CH at this
  // entry; a stale CH must not override a revoked J membership either.
  for (const scopeId of computed.keys()) lockIdSet.delete(scopeId);
  const locked = new Set([...computed].filter(([, allowed]) => allowed).map(([scopeId]) => scopeId));
  if (lockIdSet.size > 0) {
    const lockIds = [...lockIdSet].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const membership = await tx.execute(sql`
      SELECT channel_id::text AS "channelId"
      FROM ${sql.raw(membershipTable)}
      WHERE ${sql.raw(membershipPrincipalColumn)} = ${principalId}::uuid
        AND channel_id = ANY(${sql.param(lockIds)}::uuid[])
      ORDER BY channel_id
      FOR KEY SHARE
    `);
    for (const row of membership.rows as Array<{ channelId: string }>) locked.add(row.channelId);
  }
  for (const scopeId of localMembershipScopeIds) {
    if (!locked.has(scopeId)) resolvedByScopeId.delete(scopeId);
  }
  for (const [scopeId, parentAccessScopeId] of threadParentMembership) {
    if (!locked.has(parentAccessScopeId)) resolvedByScopeId.delete(scopeId);
  }
  // Re-assemble in candidate order: the boundary and ack feed the terminal
  // digest, so ordering is load-bearing (asserted in tests).
  const ordered: AuthorizedReadMutationScope[] = [];
  for (const candidate of candidates) {
    const scope = resolvedByScopeId.get(candidate.scopeId);
    if (scope) ordered.push(scope);
  }
  return ordered;
}

function admissionReceiptFromLive(
  row: typeof readMutations.$inferSelect,
  outcome: ReadMutationAdmissionReceipt["outcome"],
): ReadMutationAdmissionReceipt {
  return {
    outcome,
    serverId: row.serverId,
    principalId: row.principalId,
    mutationId: row.mutationId,
    payloadHash: row.payloadHash,
    authoritySeq: row.authoritySeq,
    state: row.state,
    terminalReason: row.terminalReason as ReadMutationTerminalReason | null,
    terminalDigest: row.terminalDigest,
    ack: row.ack,
  };
}

/**
 * Stored acks are served again on exact replay and by the compatibility bridge
 * (task #64, decision Q3). An ack stored before the fix, or while the caller
 * still had access, may hold the channel's live frontier. When the caller lacks
 * live authority over the scope now, every returned position is bounded by the
 * receiver-owned residue boundary. Filtering at return time rather than
 * rewriting rows keeps the stored acks intact: they are the evidence an audit
 * of past exposure needs. The stored terminalDigest describes the ack AS MINTED,
 * so a filtered ack no longer matches it.
 *
 * That pairing is now verified, in readMutationResidueBoundary.test.ts ("replaying an ack stored
 * with the live frontier..."): a bounded replay must hand back the ORIGINAL digest, and must leave
 * the stored one alone.
 *
 * ⚠️ It is verified by equality against the digest minted at terminalization -- NOT by recomputing
 * it from the row. `readMutations.ack` is jsonb and PostgreSQL normalises jsonb key order, so the
 * byte sequence this digest was taken over does not survive the round trip and cannot be rebuilt
 * from the stored value. ⛔ Do not add a `digest(storedAck) === terminalDigest` assertion; it is
 * unsatisfiable for reasons unrelated to the property.
 */
async function boundStoredChannelReadAllAck(
  tx: DatabaseTransaction,
  input: {
    serverId: string;
    principalKind: ReadMutationPrincipalKind;
    principalId: string;
    kind: ReadMutationKind;
    scopeId: string | null;
    ack: Record<string, unknown> | null;
  },
): Promise<Record<string, unknown> | null> {
  if (!input.ack || input.kind !== "channel_read_all" || !input.scopeId) return input.ack;
  const resolved = await resolveAuthorizedReadMutationScope(tx, {
    serverId: input.serverId,
    principalKind: input.principalKind,
    principalId: input.principalId,
    scopeId: input.scopeId,
    allowDeletedInboxResidue: true,
    allowLostAccessResidue: true,
  });
  if (liveReadScopeOf(resolved)) return input.ack;
  const ceiling = await captureResidueBoundary(tx, {
    serverId: input.serverId,
    principalKind: input.principalKind,
    principalId: input.principalId,
    scopeId: input.scopeId,
  });
  const stored = input.ack as unknown as ReadMutationAck;
  const bounded: ReadMutationAck = {
    ...stored,
    capturedBoundary: (stored.capturedBoundary ?? []).map((entry) => ({
      scopeId: entry.scopeId,
      throughSeq: Math.min(asNumber(entry.throughSeq), ceiling),
    })),
    scopes: (stored.scopes ?? []).map((scope) => residueScopeAck(scope, ceiling)),
  };
  return bounded as unknown as Record<string, unknown>;
}

export async function admitReadMutation(input: ReadMutationAdmissionInput): Promise<ReadMutationAdmissionReceipt> {
  if (!UUID_V4_RE.test(input.mutationId)) {
    throw new ReadMutationError("INVALID_MUTATION_ID", "mutationId must be UUIDv4");
  }
  const mutation = canonicalPayload(input.mutation);
  const payloadHash = computeReadMutationPayloadHash(mutation);
  const principalKind = input.principalKind ?? "human";
  if (mutation.kind === "done" && principalKind !== "human") {
    throw new ReadMutationError("INVALID_MUTATION_PAYLOAD", "Done mutations are human-only");
  }
  return sequencerTransaction(async (tx) => {
    await lockReadMutationAdmissionFence(tx, {
      serverId: input.serverId,
      principalKind,
      principalId: input.principalId,
      actor: input.actor,
    });
    const authority = await lockAuthority(tx, input.serverId, principalKind, input.principalId);
    const [live] = await tx.select().from(readMutations).where(and(
      eq(readMutations.serverId, input.serverId),
      eq(readMutations.principalType, principalKind),
      eq(readMutations.principalId, input.principalId),
      eq(readMutations.mutationId, input.mutationId),
    )).limit(1);
    if (live) {
      if (live.payloadHash !== payloadHash) {
        throw new ReadMutationError(
          "MUTATION_ID_PAYLOAD_MISMATCH",
          "mutationId was already used with a different payload",
        );
      }
      const receipt = admissionReceiptFromLive(
        live,
        live.state === "applied" || live.state === "retired_no_effect" ? "ALREADY_TERMINAL" : "ALREADY_ADMITTED",
      );
      return {
        ...receipt,
        ack: await boundStoredChannelReadAllAck(tx, {
          serverId: live.serverId,
          principalKind,
          principalId: live.principalId,
          kind: live.kind,
          scopeId: live.scopeId,
          ack: receipt.ack,
        }),
      };
    }

    const [tombstone] = await tx.select().from(readMutationTombstones).where(and(
      eq(readMutationTombstones.serverId, input.serverId),
      eq(readMutationTombstones.principalType, principalKind),
      eq(readMutationTombstones.principalId, input.principalId),
      eq(readMutationTombstones.mutationId, input.mutationId),
    )).limit(1);
    if (tombstone) {
      if (tombstone.payloadHash !== payloadHash) {
        throw new ReadMutationError(
          "MUTATION_ID_PAYLOAD_MISMATCH",
          "mutationId was already used with a different payload",
        );
      }
      return {
        outcome: "ALREADY_TERMINAL",
        serverId: tombstone.serverId,
        principalId: tombstone.principalId,
        mutationId: tombstone.mutationId,
        payloadHash: tombstone.payloadHash,
        authoritySeq: tombstone.originalAuthoritySeq,
        state: tombstone.terminalState,
        terminalReason: tombstone.terminalReason as ReadMutationTerminalReason,
        terminalDigest: tombstone.terminalDigest,
        ack: null,
      };
    }

    const resolvedScope = mutation.kind === "global_read_all"
      ? null
      : await resolveAuthorizedReadMutationScope(tx, {
          serverId: input.serverId,
          principalKind,
          principalId: input.principalId,
          scopeId: mutation.scopeId,
          allowDeletedInboxResidue: mutation.kind === "channel_read_all",
          allowLostAccessResidue: mutation.kind === "channel_read_all",
        });
    const authorized = mutation.kind === "global_read_all"
      ? await lockActiveReadMutationPrincipal(tx, input.serverId, principalKind, input.principalId)
      : Boolean(resolvedScope);
    if (!authorized) {
      throw new ReadMutationError("SCOPE_NOT_FOUND", "read mutation scope was not found");
    }
    if (mutation.kind === "conversation_read_all"
      && (principalKind !== "human" || resolvedScope?.channelType === "thread" || resolvedScope?.channelType === "task")) {
      throw new ReadMutationError("SCOPE_NOT_FOUND", "conversation read scope was not found");
    }
    if (mutation.kind === "done") {
      // Done on a task conversation (task v2) is sub-conversation Done (`thread`).
      const actualTargetKind: DoneTargetKind = resolvedScope!.channelType === "thread" || resolvedScope!.channelType === "task" ? "thread" : "channel";
      if (actualTargetKind !== mutation.targetKind) {
        throw new ReadMutationError("SCOPE_NOT_FOUND", "Done target kind does not match the authorized scope");
      }
      if (mutation.targetKind === "thread") {
        await assertThreadDoneFrontier({
          threadChannelId: mutation.scopeId,
          throughActivitySeq: mutation.throughSeq,
          executor: tx,
        });
      } else {
        await assertChannelDoneFrontier({
          channelId: mutation.scopeId,
          throughActivitySeq: mutation.throughSeq,
          executor: tx,
        });
      }
    }

    const authoritySeq = authority.nextAuthoritySeq;
    const [inserted] = await tx.insert(readMutations).values({
      serverId: input.serverId,
      principalType: principalKind,
      principalId: input.principalId,
      mutationId: input.mutationId,
      payloadHash,
      authoritySeq,
      kind: mutation.kind,
      scopeId: "scopeId" in mutation ? mutation.scopeId : null,
      requestedThroughSeq: mutation.kind === "row_read" || mutation.kind === "row_unread"
        ? mutation.throughSeq
        : null,
      doneTargetKind: mutation.kind === "done" ? mutation.targetKind : null,
      doneThroughSeq: mutation.kind === "done" ? BigInt(mutation.throughSeq) : null,
      state: "admitted",
    }).returning();
    await tx.update(readMutationAuthorities).set({
      nextAuthoritySeq: authoritySeq + 1,
      updatedAt: currentDate(),
    }).where(and(
      eq(readMutationAuthorities.serverId, input.serverId),
      eq(readMutationAuthorities.principalType, principalKind),
      eq(readMutationAuthorities.principalId, input.principalId),
    ));
    return admissionReceiptFromLive(inserted, "ADMITTED");
  });
}

export async function claimNextReadMutation(input: {
  serverId: string;
  principalKind?: ReadMutationPrincipalKind;
  principalId: string;
  leaseOwner: string;
  leaseMs?: number;
  now?: Date;
}): Promise<ReadMutationClaim | null> {
  const now = input.now ?? currentDate();
  const principalKind = input.principalKind ?? "human";
  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("leaseMs must be positive");
  return sequencerTransaction(async (tx) => {
    await lockAuthority(tx, input.serverId, principalKind, input.principalId);
    const [minimum] = await tx.select().from(readMutations).where(and(
      eq(readMutations.serverId, input.serverId),
      eq(readMutations.principalType, principalKind),
      eq(readMutations.principalId, input.principalId),
      inArray(readMutations.state, ["admitted", "executing"]),
    )).orderBy(asc(readMutations.authoritySeq)).limit(1);
    if (!minimum) return null;
    if (minimum.state === "executing" && minimum.leaseExpiresAt && minimum.leaseExpiresAt > now) return null;

    const leaseGeneration = minimum.leaseGeneration + 1;
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    const [claimed] = await tx.update(readMutations).set({
      state: "executing",
      leaseOwner: input.leaseOwner,
      leaseGeneration,
      leaseExpiresAt,
      attemptCount: minimum.attemptCount + 1,
      executingAt: now,
      updatedAt: now,
    }).where(and(
      eq(readMutations.serverId, minimum.serverId),
      eq(readMutations.principalType, minimum.principalType),
      eq(readMutations.principalId, minimum.principalId),
      eq(readMutations.mutationId, minimum.mutationId),
      eq(readMutations.leaseGeneration, minimum.leaseGeneration),
      or(
        eq(readMutations.state, "admitted"),
        and(eq(readMutations.state, "executing"), lte(readMutations.leaseExpiresAt, now)),
      ),
    )).returning();
    if (!claimed) return null;
    return {
      serverId: claimed.serverId,
      principalKind: claimed.principalType,
      principalId: claimed.principalId,
      mutationId: claimed.mutationId,
      payloadHash: claimed.payloadHash,
      authoritySeq: claimed.authoritySeq,
      kind: claimed.kind,
      scopeId: claimed.scopeId,
      requestedThroughSeq: claimed.requestedThroughSeq,
      doneTargetKind: claimed.doneTargetKind,
      doneThroughSeq: claimed.doneThroughSeq == null ? null : claimed.doneThroughSeq.toString(),
      leaseOwner: claimed.leaseOwner!,
      leaseGeneration: claimed.leaseGeneration,
      leaseExpiresAt: claimed.leaseExpiresAt!,
      attemptCount: claimed.attemptCount,
    };
  });
}

export async function claimNextFairReadMutation(input: {
  leaseOwner: string;
  leaseMs?: number;
  now?: Date;
}): Promise<ReadMutationClaim | "contended" | null> {
  const now = input.now ?? currentDate();
  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("leaseMs must be positive");
  return sequencerTransaction(async (tx) => {
    const candidateResult = await tx.execute(sql`
      -- The materialized pending set is the load-bearing stop condition for
      -- idle polls: an empty read_mutations partial index must prevent any
      -- visit to read_mutation_authorities. DISTINCT ON preserves the rule
      -- that a live executing predecessor blocks later admitted work.
      WITH minimum_mutations AS MATERIALIZED (
        SELECT DISTINCT ON (
                 mutation.server_id,
                 mutation.principal_type,
                 mutation.principal_id
               )
               mutation.server_id,
               mutation.principal_type,
               mutation.principal_id,
               mutation.state,
               mutation.lease_expires_at
        FROM read_mutations mutation
        WHERE mutation.state IN ('admitted', 'executing')
        ORDER BY mutation.server_id,
                 mutation.principal_type,
                 mutation.principal_id,
                 mutation.authority_seq
      )
      SELECT authority_row.server_id::text AS "serverId",
             authority_row.principal_type::text AS "principalKind",
             authority_row.principal_id::text AS "principalId"
      FROM minimum_mutations minimum
      INNER JOIN read_mutation_authorities authority_row
        ON authority_row.server_id = minimum.server_id
       AND authority_row.principal_type = minimum.principal_type
       AND authority_row.principal_id = minimum.principal_id
      WHERE minimum.state = 'admitted'
         OR minimum.lease_expires_at <= ${now}
      ORDER BY authority_row.worker_last_scheduled_at ASC NULLS FIRST,
               authority_row.server_id,
               authority_row.principal_type,
               authority_row.principal_id
      LIMIT 1
      FOR UPDATE OF authority_row SKIP LOCKED
    `);
    const [candidate] = candidateResult.rows as Array<{
      serverId: string;
      principalKind: ReadMutationPrincipalKind;
      principalId: string;
    }>;
    if (!candidate) return null;

    const [minimum] = await tx.select().from(readMutations).where(and(
      eq(readMutations.serverId, candidate.serverId),
      eq(readMutations.principalType, candidate.principalKind),
      eq(readMutations.principalId, candidate.principalId),
      inArray(readMutations.state, ["admitted", "executing"]),
    )).orderBy(asc(readMutations.authoritySeq)).limit(1);
    // "contended" = another worker got between the candidate snapshot and this
    // claim; work may remain for other principals, so the drain must not stop.
    if (!minimum) return "contended";
    if (minimum.state === "executing" && minimum.leaseExpiresAt && minimum.leaseExpiresAt > now) return "contended";

    const leaseGeneration = minimum.leaseGeneration + 1;
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    const [claimed] = await tx.update(readMutations).set({
      state: "executing",
      leaseOwner: input.leaseOwner,
      leaseGeneration,
      leaseExpiresAt,
      attemptCount: minimum.attemptCount + 1,
      executingAt: now,
      updatedAt: now,
    }).where(and(
      eq(readMutations.serverId, minimum.serverId),
      eq(readMutations.principalType, minimum.principalType),
      eq(readMutations.principalId, minimum.principalId),
      eq(readMutations.mutationId, minimum.mutationId),
      eq(readMutations.leaseGeneration, minimum.leaseGeneration),
      or(
        eq(readMutations.state, "admitted"),
        and(eq(readMutations.state, "executing"), lte(readMutations.leaseExpiresAt, now)),
      ),
    )).returning();
    if (!claimed) return "contended";

    await tx.update(readMutationAuthorities).set({
      workerLastScheduledAt: sql`now()`,
      updatedAt: sql`now()`,
    }).where(and(
      eq(readMutationAuthorities.serverId, candidate.serverId),
      eq(readMutationAuthorities.principalType, candidate.principalKind),
      eq(readMutationAuthorities.principalId, candidate.principalId),
    ));
    return {
      serverId: claimed.serverId,
      principalKind: claimed.principalType,
      principalId: claimed.principalId,
      mutationId: claimed.mutationId,
      payloadHash: claimed.payloadHash,
      authoritySeq: claimed.authoritySeq,
      kind: claimed.kind,
      scopeId: claimed.scopeId,
      requestedThroughSeq: claimed.requestedThroughSeq,
      doneTargetKind: claimed.doneTargetKind,
      doneThroughSeq: claimed.doneThroughSeq == null ? null : claimed.doneThroughSeq.toString(),
      leaseOwner: claimed.leaseOwner!,
      leaseGeneration: claimed.leaseGeneration,
      leaseExpiresAt: claimed.leaseExpiresAt!,
      attemptCount: claimed.attemptCount,
    };
  });
}

/**
 * Receiver-owned residue boundary (task #64): the highest seq the receiver was
 * notified about for this scope, from their own notification facts. The
 * receiver's cursor is deliberately NOT consulted: the pre-fix defect wrote the
 * channel's live frontier into cursors, so reading them back would launder that
 * leak into "receiver-owned" data. Activity entries come from these rows, so this
 * boundary is enough to retire them.
 */
async function captureResidueBoundary(
  tx: DatabaseTransaction,
  input: { serverId: string; principalKind: ReadMutationPrincipalKind; principalId: string; scopeId: string },
): Promise<number> {
  const receiverType = input.principalKind === "human" ? "user" : "agent";
  const result = await tx.execute(sql`
    SELECT COALESCE((
      SELECT MAX(owned_fact.message_seq)
      FROM inbox_notification_facts owned_fact
      WHERE owned_fact.receiver_type = ${receiverType}
        AND owned_fact.receiver_id = ${input.principalId}::uuid
        AND owned_fact.server_id = ${input.serverId}::uuid
        AND owned_fact.source_channel_id = ${input.scopeId}::uuid
    ), 0)::int AS "throughSeq"
  `);
  const [row] = result.rows as Array<{ throughSeq: unknown }>;
  return asNumber(row?.throughSeq ?? 0);
}

/** The live frontier of a storage scope. Callable only with live authority. */
async function captureLiveFrontier(tx: DatabaseTransaction, live: LiveReadScope): Promise<number> {
  const result = await tx.execute(sql`
    SELECT COALESCE(MAX(m.seq), 0)::int AS "throughSeq"
    FROM messages m
    WHERE m.channel_id = ${live.storageScopeId}::uuid
  `);
  const [row] = result.rows as Array<{ throughSeq: unknown }>;
  return asNumber(row?.throughSeq ?? 0);
}

type CapturedChannelBoundary = {
  boundary: ReadMutationBoundary[];
  residueScopeIds: string[];
  /** row_read on a live scope: where its messages are stored, to count what stays unread. */
  unreadStorageScopeId?: string;
  /** row_unread on a live scope: where its messages are stored and what it is, to find what it can mark unread. */
  markUnreadScope?: { storageScopeId: string; conversationType: AuthorizedReadMutationScope["channelType"]; computedJointMember?: true };
};

async function captureChannelBoundary(
  tx: DatabaseTransaction,
  serverId: string,
  principalKind: ReadMutationPrincipalKind,
  principalId: string,
  scopeId: string,
): Promise<CapturedChannelBoundary | null> {
  const resolved = await resolveAuthorizedReadMutationScope(tx, {
    serverId,
    principalKind,
    principalId,
    scopeId,
    allowDeletedInboxResidue: true,
    // Must match the admission resolve above. Passing only the deleted flag here
    // admitted the caller and then computed NO boundary, so read-all answered
    // 200 with {changed:false} and retired nothing -- a fix that looks applied.
    // Same shape as fixing the reported site and not its sibling.
    allowLostAccessResidue: true,
  });
  if (!resolved) return null;
  if (resolved.authority.kind === "residue") {
    const throughSeq = await captureResidueBoundary(tx, { serverId, principalKind, principalId, scopeId: resolved.scopeId });
    return {
      boundary: [{ scopeId: resolved.scopeId, throughSeq }],
      residueScopeIds: [resolved.scopeId],
    };
  }
  const throughSeq = await captureLiveFrontier(tx, resolved.authority.scope);
  return {
    boundary: [{ scopeId: resolved.scopeId, throughSeq }],
    residueScopeIds: [],
  };
}

async function captureDoneBoundary(
  tx: DatabaseTransaction,
  mutation: typeof readMutations.$inferSelect,
): Promise<CapturedMutationBoundary> {
  if (
    mutation.principalType !== "human"
    || mutation.scopeId == null
    || mutation.doneTargetKind == null
    || mutation.doneThroughSeq == null
  ) return { boundary: null, applyBroadDoneMarker: false };

  const resolved = await resolveAuthorizedReadMutationScope(tx, {
    serverId: mutation.serverId,
    principalKind: mutation.principalType,
    principalId: mutation.principalId,
    scopeId: mutation.scopeId,
  });
  const live = liveReadScopeOf(resolved);
  if (!resolved || !live) return { boundary: null, applyBroadDoneMarker: false };

  const actualTargetKind: DoneTargetKind = resolved.channelType === "thread" || resolved.channelType === "task" ? "thread" : "channel";
  if (actualTargetKind !== mutation.doneTargetKind) {
    return { boundary: null, applyBroadDoneMarker: false };
  }

  const lockedContent = await tx.execute(sql`
    SELECT id
    FROM channels
    WHERE id = ${live.storageScopeId}::uuid
      AND deleted_at IS NULL
    FOR UPDATE
  `);
  if (lockedContent.rows.length !== 1) {
    return { boundary: null, applyBroadDoneMarker: false };
  }

  const throughSeq = mutation.doneThroughSeq.toString();
  const verified = mutation.doneTargetKind === "thread"
    ? await assertThreadDoneFrontier({
        threadChannelId: mutation.scopeId,
        throughActivitySeq: throughSeq,
        executor: tx,
      })
    : await assertChannelDoneFrontier({
        channelId: mutation.scopeId,
        throughActivitySeq: throughSeq,
        executor: tx,
      });
  if (verified.target.sourceChannelId !== live.storageScopeId) {
    return { boundary: null, applyBroadDoneMarker: false };
  }
  const applyBroadDoneMarker = verified.target.latestSeqExact === throughSeq;

  if (mutation.doneTargetKind === "channel") {
    await tx.execute(sql`
      INSERT INTO user_channel_inbox_states (user_id, channel_id, updated_at)
      VALUES (${mutation.principalId}::uuid, ${mutation.scopeId}::uuid, now())
      ON CONFLICT (user_id, channel_id) DO NOTHING
    `);
    const lockedDoneState = await tx.execute(sql`
      SELECT user_id
      FROM user_channel_inbox_states
      WHERE user_id = ${mutation.principalId}::uuid
        AND channel_id = ${mutation.scopeId}::uuid
      FOR UPDATE
    `);
    if (lockedDoneState.rows.length !== 1) {
      return { boundary: null, applyBroadDoneMarker: false };
    }
  } else {
    const lockedDoneState = await tx.execute(sql`
      SELECT follower_id
      FROM thread_follows
      WHERE thread_channel_id = ${mutation.scopeId}::uuid
        AND follower_type = 'user'
        AND follower_id = ${mutation.principalId}::uuid
      FOR UPDATE
    `);
    if (lockedDoneState.rows.length !== 1) {
      const mentionResidue = await tx.execute(sql`
        SELECT 1
        FROM message_mentions mm
        INNER JOIN channels thread_channel
          ON thread_channel.id = mm.channel_id
        INNER JOIN messages parent_message
          ON parent_message.id = thread_channel.parent_message_id
        INNER JOIN channels parent_channel
          ON parent_channel.id = parent_message.channel_id
        WHERE mm.channel_id = ${mutation.scopeId}::uuid
          AND mm.target_type = 'user'
          AND mm.target_id = ${mutation.principalId}::uuid
          AND mm.notified_at IS NOT NULL
          AND mm.message_seq <= ${throughSeq}::bigint
          AND thread_channel.server_id = ${mutation.serverId}::uuid
          AND thread_channel.type = 'thread'
          AND thread_channel.deleted_at IS NULL
          AND parent_channel.type = 'channel'
          AND parent_channel.archived_at IS NULL
          AND parent_channel.deleted_at IS NULL
        LIMIT 1
      `);
      if (mentionResidue.rows.length !== 1) {
        return { boundary: null, applyBroadDoneMarker: false };
      }

      return {
        boundary: [{ scopeId: resolved.scopeId, throughSeq }],
        applyBroadDoneMarker: false,
      };
    }
  }

  return {
    boundary: [{ scopeId: resolved.scopeId, throughSeq }],
    applyBroadDoneMarker,
  };
}

async function captureGlobalBoundary(
  tx: DatabaseTransaction,
  serverId: string,
  principalKind: ReadMutationPrincipalKind,
  principalId: string,
): Promise<ReadMutationBoundary[] | null> {
  if (!await lockActiveReadMutationPrincipal(tx, serverId, principalKind, principalId)) return null;
  const jointEntry = principalKind === "human" ? await resolveJointHumanEntrySql({ serverId }, tx) : null;
  const candidates = principalKind === "human"
    ? await tx.execute(sql`
        SELECT c.id::text AS "scopeId", c.type::text AS "channelType"
        FROM channels c
        LEFT JOIN user_channel_inbox_states inbox
          ON inbox.channel_id = c.id AND inbox.user_id = ${principalId}::uuid
        WHERE c.server_id = ${serverId}::uuid
          AND c.type IN ('channel', 'private', 'joint', 'dm')
          AND c.deleted_at IS NULL
          AND c.archived_at IS NULL
          AND inbox.done_at IS NULL
          AND (EXISTS (
            SELECT 1
            FROM channel_humans ch
            WHERE ch.channel_id = c.id
              AND ch.user_id = ${principalId}::uuid
          ) OR (c.type = 'joint' AND ${jointEntry ? jointEntry(sql`c.id`, sql`${principalId}::uuid`) : sql`false`}))
        UNION
        SELECT c.id::text AS "scopeId", c.type::text AS "channelType"
        FROM thread_follows tf
        INNER JOIN channels c
          ON c.id = tf.thread_channel_id
         AND c.server_id = ${serverId}::uuid
         -- Task conversations (task v2) are followed like threads; their
         -- reads (and a marked-unread flag) are part of Mark all read.
         AND c.type IN ('thread', 'task')
         AND c.deleted_at IS NULL
        WHERE tf.follower_type = 'user'
          AND tf.follower_id = ${principalId}::uuid
          AND tf.done_at IS NULL
          AND tf.unfollowed_at IS NULL
        ORDER BY "scopeId"
      `)
    : await tx.execute(sql`
        SELECT c.id::text AS "scopeId", c.type::text AS "channelType"
        FROM channels c
        INNER JOIN channel_agents ca
          ON ca.channel_id = c.id
         AND ca.agent_id = ${principalId}::uuid
        WHERE c.server_id = ${serverId}::uuid
          AND c.type IN ('channel', 'private', 'joint', 'dm')
          AND c.deleted_at IS NULL
          AND c.archived_at IS NULL
        UNION
        SELECT c.id::text AS "scopeId", c.type::text AS "channelType"
        FROM thread_follows tf
        INNER JOIN channels c
          ON c.id = tf.thread_channel_id
         AND c.server_id = ${serverId}::uuid
         AND c.type = 'thread'
         AND c.deleted_at IS NULL
        WHERE tf.follower_type = 'agent'
          AND tf.follower_id = ${principalId}::uuid
          AND tf.done_at IS NULL
          AND tf.unfollowed_at IS NULL
        ORDER BY "scopeId"
      `);
  return captureLiveScopeBoundaries(
    tx, serverId, principalKind, principalId,
    candidates.rows as Array<{ scopeId: string; channelType: string }>,
  );
}

/** Resolve every target before taking cursor locks, using the global read lock order. */
async function captureLiveScopeBoundaries(
  tx: DatabaseTransaction,
  serverId: string,
  principalKind: ReadMutationPrincipalKind,
  principalId: string,
  candidateRows: Array<{ scopeId: string; channelType: string }>,
  requiredParentId?: string,
): Promise<ReadMutationBoundary[] | null> {
  // The active-principal lock is already held from the head of this function;
  // the batched resolver below takes no per-scope locks at all (only row
  // locks inside its statements, in primary-key order).
  const resolved = await resolveGlobalLiveReadScopes(tx, {
    serverId,
    principalKind,
    principalId,
    candidates: candidateRows,
  });
  if (requiredParentId && !resolved.some((scope) => scope.scopeId === requiredParentId && scope.channelType !== "thread" && scope.channelType !== "task")) {
    return null;
  }
  // Batch the per-channel frontier probe into one round trip: unnest + a scalar
  // subquery per row keeps the planner's "Index Only Scan Backward ... Limit 1"
  // shape per channel (a GROUP BY aggregate would scan every index entry of
  // every listed channel — measured by Ray on PGlite with 200 synthetic
  // channels / 390k messages: 795ms → 5.9ms. NULL (empty channel) is filtered
  // below, matching the old throughSeq > 0 gate. Order follows the resolved
  // order; the boundary feeds the terminal digest, so ordering is
  // load-bearing. The storage-exists column separates the benign empty-channel
  // case from the signal (concurrent removal of canonical storage) so the
  // trace event only fires for the signal (Tenny's review: an alarm that
  // always fires carries zero information).
  const liveScopes: Array<{ scopeId: string; storageScopeId: string }> = [];
  for (const scope of resolved) {
    const live = liveReadScopeOf(scope);
    if (live) liveScopes.push({ scopeId: scope.scopeId, storageScopeId: live.storageScopeId });
  }
  if (liveScopes.length === 0) return [];
  const seenScopeIds = new Set<string>();
  for (const { scopeId } of liveScopes) {
    // unnest-driven ON CONFLICT paths and the digest both require uniqueness.
    if (seenScopeIds.has(scopeId)) throw new Error("global_read_all resolved a duplicate scope id");
    seenScopeIds.add(scopeId);
  }
  const frontier = await tx.execute(sql`
    SELECT s.scope_id AS "scopeId",
           (SELECT MAX(m.seq) FROM messages m WHERE m.channel_id = s.storage_id)::int AS "throughSeq",
           EXISTS (SELECT 1 FROM channels stor WHERE stor.id = s.storage_id) AS "storageExists"
    FROM unnest(
      ${sql.param(liveScopes.map((s) => s.scopeId))}::uuid[],
      ${sql.param(liveScopes.map((s) => s.storageScopeId))}::uuid[]
    ) WITH ORDINALITY AS s(scope_id, storage_id, ord)
    ORDER BY s.ord
  `);
  const boundary: ReadMutationBoundary[] = [];
  for (const row of frontier.rows as Array<{ scopeId: string; throughSeq: unknown; storageExists: boolean }>) {
    const throughSeq = asNumber(row.throughSeq ?? 0);
    if (throughSeq > 0) {
      boundary.push({ scopeId: row.scopeId, throughSeq });
    } else if (row.storageExists === false) {
      // Observable skip, signal only: the scope resolved live but its storage
      // vanished mid-resolution (possible under the deliberately relaxed
      // projection locking). Empty channels — the benign case — are filtered
      // silently so this event stays a signal (Tenny's review).
      safeAddTraceEvent("read_mutation.global_read_all.scope_skipped_at_frontier", () => ({
        event_kind: "read_mutation",
        outcome: "skipped",
        reason: "storage_vanished",
        scope_id: row.scopeId,
      }));
    }
  }
  return boundary;
}

/**
 * A sidebar conversation owns its message cursor and active followed-thread
 * cursors. Resolve local thread projections through canonical storage parents;
 * never infer the target set from the browser's paginated followed list.
 */
async function captureConversationBoundary(
  tx: DatabaseTransaction,
  serverId: string,
  principalId: string,
  parentId: string,
): Promise<ReadMutationBoundary[] | null> {
  if (!await lockActiveReadMutationPrincipal(tx, serverId, "human", principalId)) return null;
  const candidates = await tx.execute(sql`
    WITH parent AS (
      SELECT p.id, p.type, sm.role, COALESCE(pj.canonical_channel_id, p.id) AS storage_id
      FROM channels p
      JOIN server_members sm ON sm.server_id = p.server_id AND sm.user_id = ${principalId}::uuid
      LEFT JOIN joint_channel_servers pjs
        ON pjs.local_channel_id = p.id AND pjs.server_id = ${serverId}::uuid AND pjs.status = 'active'
      LEFT JOIN joint_channels pj ON pj.id = pjs.joint_channel_id AND pj.status = 'active'
      WHERE p.id = ${parentId}::uuid AND p.server_id = ${serverId}::uuid
        AND p.type IN ('channel', 'private', 'joint', 'dm')
        AND p.deleted_at IS NULL AND p.archived_at IS NULL
        AND (p.type <> 'joint' OR pj.id IS NOT NULL)
        AND NOT (p.name = 'all' AND p.type = 'private')
        -- Joined roots already require channel membership in the live resolver.
        -- A Guest reads only its one bound channel, as its member
        -- (canGuestReadChannel, #wg-rbac:#15). A bound joint channel (P3) is
        -- a candidate only; the live resolver applies the joint guest rule.
        AND (sm.role <> 'guest' OR (
          p.id = sm.guest_channel_id AND (p.type = 'joint' OR (p.type IN ('channel', 'private')
          AND EXISTS (SELECT 1 FROM channel_humans gch WHERE gch.channel_id = p.id AND gch.user_id = ${principalId}::uuid)))
        ))
    )
    SELECT p.id::text AS "scopeId", p.type::text AS "channelType" FROM parent p
    UNION
    SELECT c.id::text AS "scopeId", c.type::text AS "channelType"
    FROM thread_follows tf
    JOIN channels c ON c.id = tf.thread_channel_id AND c.server_id = ${serverId}::uuid
      AND c.type = 'thread' AND c.deleted_at IS NULL
    LEFT JOIN joint_channel_servers js
      ON js.local_channel_id = c.id AND js.server_id = ${serverId}::uuid AND js.status = 'active'
    LEFT JOIN joint_channels j ON j.id = js.joint_channel_id AND j.status = 'active'
    JOIN channels storage ON storage.id = COALESCE(j.canonical_channel_id, c.id)
      AND storage.type = 'thread' AND storage.deleted_at IS NULL
    JOIN messages pm ON pm.id = storage.parent_message_id
    JOIN parent p ON p.storage_id = pm.channel_id
    WHERE tf.follower_type = 'user' AND tf.follower_id = ${principalId}::uuid
      AND tf.done_at IS NULL AND tf.unfollowed_at IS NULL
      AND (p.role <> 'guest' OR j.id IS NULL OR p.type = 'joint')
    ORDER BY "scopeId"
  `);
  return captureLiveScopeBoundaries(
    tx, serverId, "human", principalId,
    candidates.rows as Array<{ scopeId: string; channelType: string }>, parentId,
  );
}

async function captureBoundary(
  tx: DatabaseTransaction,
  mutation: typeof readMutations.$inferSelect,
): Promise<CapturedChannelBoundary | null> {
  if (mutation.kind === "global_read_all") {
    const boundary = await captureGlobalBoundary(tx, mutation.serverId, mutation.principalType, mutation.principalId);
    return boundary ? { boundary, residueScopeIds: [] } : null;
  }
  if (mutation.kind === "conversation_read_all") {
    const boundary = await captureConversationBoundary(tx, mutation.serverId, mutation.principalId, mutation.scopeId!);
    return boundary ? { boundary, residueScopeIds: [] } : null;
  }
  if (mutation.kind === "channel_read_all") {
    return captureChannelBoundary(
      tx,
      mutation.serverId,
      mutation.principalType,
      mutation.principalId,
      mutation.scopeId!,
    );
  }
  if (mutation.kind === "done") {
    const boundary = (await captureDoneBoundary(tx, mutation)).boundary;
    return boundary ? { boundary, residueScopeIds: [] } : null;
  }
  const resolved = await resolveAuthorizedReadMutationScope(tx, {
    serverId: mutation.serverId,
    principalKind: mutation.principalType,
    principalId: mutation.principalId,
    scopeId: mutation.scopeId!,
  });
  if (!resolved) return null;
  const live = liveReadScopeOf(resolved);
  return {
    boundary: [{ scopeId: mutation.scopeId!, throughSeq: mutation.requestedThroughSeq! }],
    residueScopeIds: [],
    ...(mutation.kind === "row_read" && live ? { unreadStorageScopeId: live.storageScopeId } : {}),
    ...(mutation.kind === "row_unread" && live
      ? { markUnreadScope: { storageScopeId: live.storageScopeId, conversationType: resolved.channelType,
          ...(resolved.computedJointMember ? { computedJointMember: true as const } : {}) } }
      : {}),
  };
}

/**
 * Joining a conversation (channel membership, a started or re-started thread follow)
 * starts the member's read position at `throughSeq`: everything up to it is read.
 *
 * Raise-only, and the row's read_state_version moves with the value (1 on insert, +1 on
 * a raise) so clients, which drop updates whose version does not advance, keep accepting
 * later sequencer writes. A join is not a read mutation: it runs in the membership
 * write's own transaction, takes no authority seq and leaves last_applied_authority_seq
 * as it was. The conflict predicate re-checks the value at write time, like
 * applyScopeBoundary, so a concurrent sequencer write can never be lowered.
 * A human's (re-)join also clears a marked-unread flag left from before, so an
 * old mark does not come back with the conversation.
 */
export async function raiseReadPositionForJoin(
  executor: DatabaseExecutor,
  principalKind: ReadMutationPrincipalKind,
  principalId: string,
  scopeId: string,
  throughSeq: number,
): Promise<void> {
  if (throughSeq <= 0) return;
  await executor.execute(principalKind === "human"
    ? sql`
        INSERT INTO user_channel_read_cursors (user_id, channel_id, last_read_seq, read_state_version, updated_at)
        VALUES (${principalId}::uuid, ${scopeId}::uuid, ${throughSeq}, 1, now())
        ON CONFLICT (user_id, channel_id) DO UPDATE SET
          last_read_seq = GREATEST(EXCLUDED.last_read_seq, user_channel_read_cursors.last_read_seq),
          read_state_version = user_channel_read_cursors.read_state_version + 1,
          marked_unread = false,
          updated_at = now()
        WHERE EXCLUDED.last_read_seq > user_channel_read_cursors.last_read_seq
           OR user_channel_read_cursors.marked_unread
      `
    : sql`
        INSERT INTO agent_channel_read_cursors (agent_id, channel_id, last_read_seq, read_state_version, updated_at)
        VALUES (${principalId}::uuid, ${scopeId}::uuid, ${throughSeq}, 1, now())
        ON CONFLICT (agent_id, channel_id) DO UPDATE SET
          last_read_seq = EXCLUDED.last_read_seq,
          read_state_version = agent_channel_read_cursors.read_state_version + 1,
          updated_at = now()
        WHERE EXCLUDED.last_read_seq > agent_channel_read_cursors.last_read_seq
      `);
}

/** row_read stops counting unread here; at the cap the ack omits the count. */
export const READ_ACK_UNREAD_COUNT_CAP = 1000;

async function applyScopeBoundary(input: {
  tx: DatabaseTransaction;
  principalKind: ReadMutationPrincipalKind;
  principalId: string;
  authoritySeq: number;
  scopeId: string;
  throughSeq: number | string;
  direction: "forward" | "backward";
  afterCursorLocked?: () => Promise<void>;
  /** Count the scope's unread in the same statement as the cursor write. */
  unreadStorageScopeId?: string;
}): Promise<ReadMutationAck["scopes"][number]> {
  const locked = input.principalKind === "human"
    ? await input.tx.execute(sql`
        SELECT last_read_seq AS "lastReadSeq", read_state_version AS "readStateVersion"
        FROM user_channel_read_cursors
        WHERE user_id = ${input.principalId}::uuid AND channel_id = ${input.scopeId}::uuid
        FOR UPDATE
      `)
    : await input.tx.execute(sql`
        SELECT last_read_seq AS "lastReadSeq", read_state_version AS "readStateVersion"
        FROM agent_channel_read_cursors
        WHERE agent_id = ${input.principalId}::uuid AND channel_id = ${input.scopeId}::uuid
        FOR UPDATE
      `);
  const [existing] = locked.rows as Array<{ lastReadSeq: unknown; readStateVersion: unknown }>;
  await input.afterCursorLocked?.();
  if (!existing && (input.throughSeq === 0 || input.throughSeq === "0")) {
    return {
      scopeId: input.scopeId,
      maxReadSeq: 0,
      readStateVersion: 0,
      lastAppliedAuthoritySeq: 0,
      changed: false,
    };
  }
  const ownSenderType = input.principalKind === "human" ? "user" : "agent";
  // Bounded: this runs under the cursor row lock on every row_read. A count
  // that reaches the cap is reported as unknown (omitted) below.
  const unreadAfter = (lastReadSeq: SQL) => input.unreadStorageScopeId
    ? sql`(
        SELECT count(*)::int
        FROM (
          SELECT 1
          FROM messages m
          WHERE m.channel_id = ${input.unreadStorageScopeId}::uuid
            AND m.seq > ${lastReadSeq}
            AND NOT (m.sender_type = ${ownSenderType} AND m.sender_id = ${input.principalId})
          LIMIT ${READ_ACK_UNREAD_COUNT_CAP}
        ) capped
      )`
    : sql`NULL::int`;
  // The conflict predicate deliberately derives from the row visible at the
  // write itself, not only from the preceding FOR UPDATE read. That closes the
  // absent-row race with legacy compatibility writers that do not share the
  // sequencer authority lock, while ensuring unchanged scopes perform no
  // UPDATE and therefore cannot advance version/authority metadata.
  // A read of a scope marked unread clears the mark even when the position
  // does not move (the mark exists because nothing countable lies past it);
  // the position itself stays raise-only.
  const humanUpsert = input.principalKind === "human" && input.direction === "forward"
    ? sql`
        INSERT INTO user_channel_read_cursors (
          user_id, channel_id, last_read_seq, read_state_version, last_applied_authority_seq, updated_at
        ) VALUES (
          ${input.principalId}::uuid, ${input.scopeId}::uuid, ${input.throughSeq}, 1, ${input.authoritySeq}, now()
        )
        ON CONFLICT (user_id, channel_id) DO UPDATE SET
          last_read_seq = GREATEST(EXCLUDED.last_read_seq, user_channel_read_cursors.last_read_seq),
          read_state_version = user_channel_read_cursors.read_state_version + 1,
          last_applied_authority_seq = EXCLUDED.last_applied_authority_seq,
          marked_unread = false,
          updated_at = now()
        WHERE EXCLUDED.last_read_seq > user_channel_read_cursors.last_read_seq
           OR user_channel_read_cursors.marked_unread
        RETURNING last_read_seq AS "lastReadSeq",
                  read_state_version AS "readStateVersion",
                  last_applied_authority_seq AS "lastAppliedAuthoritySeq",
                  ${unreadAfter(sql`user_channel_read_cursors.last_read_seq`)} AS "unreadCount"
      `
    : input.principalKind === "human"
      ? sql`
        INSERT INTO user_channel_read_cursors (
          user_id, channel_id, last_read_seq, read_state_version, last_applied_authority_seq, updated_at
        ) VALUES (
          ${input.principalId}::uuid, ${input.scopeId}::uuid, ${input.throughSeq}, 1, ${input.authoritySeq}, now()
        )
        ON CONFLICT (user_id, channel_id) DO UPDATE SET
          last_read_seq = LEAST(EXCLUDED.last_read_seq, user_channel_read_cursors.last_read_seq),
          read_state_version = user_channel_read_cursors.read_state_version + 1,
          last_applied_authority_seq = EXCLUDED.last_applied_authority_seq,
          -- A rewind counts what it marks unread: an older mark gives way.
          marked_unread = false,
          updated_at = now()
        WHERE EXCLUDED.last_read_seq < user_channel_read_cursors.last_read_seq
           OR user_channel_read_cursors.marked_unread
        RETURNING last_read_seq AS "lastReadSeq",
                  read_state_version AS "readStateVersion",
                  last_applied_authority_seq AS "lastAppliedAuthoritySeq"
      `
      : null;
  const agentUpsert = input.principalKind === "agent" && input.direction === "forward"
    ? sql`
        INSERT INTO agent_channel_read_cursors (
          agent_id, channel_id, last_read_seq, read_state_version, last_applied_authority_seq, updated_at
        ) VALUES (
          ${input.principalId}::uuid, ${input.scopeId}::uuid, ${input.throughSeq}, 1, ${input.authoritySeq}, now()
        )
        ON CONFLICT (agent_id, channel_id) DO UPDATE SET
          last_read_seq = EXCLUDED.last_read_seq,
          read_state_version = agent_channel_read_cursors.read_state_version + 1,
          last_applied_authority_seq = EXCLUDED.last_applied_authority_seq,
          updated_at = now()
        WHERE EXCLUDED.last_read_seq > agent_channel_read_cursors.last_read_seq
        RETURNING last_read_seq AS "lastReadSeq",
                  read_state_version AS "readStateVersion",
                  last_applied_authority_seq AS "lastAppliedAuthoritySeq",
                  ${unreadAfter(sql`agent_channel_read_cursors.last_read_seq`)} AS "unreadCount"
      `
    : input.principalKind === "agent"
      ? sql`
        INSERT INTO agent_channel_read_cursors (
          agent_id, channel_id, last_read_seq, read_state_version, last_applied_authority_seq, updated_at
        ) VALUES (
          ${input.principalId}::uuid, ${input.scopeId}::uuid, ${input.throughSeq}, 1, ${input.authoritySeq}, now()
        )
        ON CONFLICT (agent_id, channel_id) DO UPDATE SET
          last_read_seq = EXCLUDED.last_read_seq,
          read_state_version = agent_channel_read_cursors.read_state_version + 1,
          last_applied_authority_seq = EXCLUDED.last_applied_authority_seq,
          updated_at = now()
        WHERE EXCLUDED.last_read_seq < agent_channel_read_cursors.last_read_seq
        RETURNING last_read_seq AS "lastReadSeq",
                  read_state_version AS "readStateVersion",
                  last_applied_authority_seq AS "lastAppliedAuthoritySeq"
      `
      : null;
  const upserted = await input.tx.execute((humanUpsert ?? agentUpsert)!);
  let [finalRow] = upserted.rows as Array<{
    lastReadSeq: unknown;
    readStateVersion: unknown;
    lastAppliedAuthoritySeq: unknown;
    unreadCount?: unknown;
  }>;
  const changed = Boolean(finalRow);
  if (!finalRow) {
    const current = input.principalKind === "human"
      ? await input.tx.execute(sql`
          SELECT last_read_seq AS "lastReadSeq",
                 read_state_version AS "readStateVersion",
                 last_applied_authority_seq AS "lastAppliedAuthoritySeq",
                 ${unreadAfter(sql`last_read_seq`)} AS "unreadCount"
          FROM user_channel_read_cursors
          WHERE user_id = ${input.principalId}::uuid AND channel_id = ${input.scopeId}::uuid
        `)
      : await input.tx.execute(sql`
          SELECT last_read_seq AS "lastReadSeq",
                 read_state_version AS "readStateVersion",
                 last_applied_authority_seq AS "lastAppliedAuthoritySeq",
                 ${unreadAfter(sql`last_read_seq`)} AS "unreadCount"
          FROM agent_channel_read_cursors
          WHERE agent_id = ${input.principalId}::uuid AND channel_id = ${input.scopeId}::uuid
        `);
    [finalRow] = current.rows as Array<{
      lastReadSeq: unknown;
      readStateVersion: unknown;
      lastAppliedAuthoritySeq: unknown;
      unreadCount?: unknown;
    }>;
  }
  if (!finalRow) throw new Error("read mutation cursor resolution returned no row");
  const nextSeq = asNumber(finalRow.lastReadSeq);
  const readStateVersion = asNumber(finalRow.readStateVersion);

  return {
    scopeId: input.scopeId,
    maxReadSeq: nextSeq,
    readStateVersion,
    lastAppliedAuthoritySeq: asNumber(finalRow.lastAppliedAuthoritySeq),
    changed,
    ...(
      input.unreadStorageScopeId
      && input.direction === "forward"
      && finalRow.unreadCount != null
      && asNumber(finalRow.unreadCount) < READ_ACK_UNREAD_COUNT_CAP
        ? { unreadCount: asNumber(finalRow.unreadCount) }
        : {}
    ),
  };
}

/**
 * A message of `m` that Mark as Unread can count for the principal: not their
 * own, not a system line they caused, not a noise subtype; in a task
 * conversation, a chat message only (its lifecycle lines are not "new": the
 * unread count, rw_task_conversation_unread_v1, counts chat messages). The one
 * predicate of resolveReadMutationUnreadBoundary (where the rewind lands) and
 * of row_unread's mark decision below, so neither disagrees with the count.
 */
function unreadEligibleMessageSql(
  principalKind: ReadMutationPrincipalKind,
  principalId: string,
  conversationType: AuthorizedReadMutationScope["channelType"],
): SQL {
  const senderType = principalKind === "human" ? "user" : "agent";
  const chatOnly = conversationType === "task" ? sql`AND m.message_type = 'chat'` : sql``;
  return sql`NOT (
      m.sender_type = ${senderType}
      AND m.sender_id = ${principalId}
    )
    AND NOT COALESCE(
      m.message_type = 'system'
      AND m.causal_actor_type = ${senderType}
      AND m.causal_actor_id = ${principalId}, FALSE
    )
    AND (m.system_subtype IS NULL OR m.system_subtype NOT IN ('channel.self_unfollow_thread', 'task.deleted_summary'))
    ${chatOnly}`;
}

/**
 * A human's row_unread on a live scope. When a message the person can count
 * lies past the requested position (or past the cursor, if that is lower), the
 * cursor is rewound as before (and an older mark gives way). Otherwise nothing
 * past the cursor is countable (a thread whose only message from someone else
 * is its parent, stored in the parent channel), and rewinding would leave the
 * scope read: the cursor stays and the scope is marked unread instead
 * (marked_unread, one read-state version). Mark as Unread therefore takes
 * effect on every conversation the person is in, and counts never include the
 * mark. Refused (unchanged, not marked): a conversation with no messages at all
 * (nothing to come back to), and one the person is not in (a channel they are
 * not a member of, a thread or task conversation they do not follow), where
 * neither the sidebar nor Activity would show the mark.
 */
async function applyRowUnread(input: {
  tx: DatabaseTransaction;
  principalId: string;
  authoritySeq: number;
  scopeId: string;
  storageScopeId: string;
  conversationType: AuthorizedReadMutationScope["channelType"];
  computedJointMember?: true;
  throughSeq: number;
  afterCursorLocked?: () => Promise<void>;
}): Promise<ReadMutationAck["scopes"][number]> {
  const locked = await input.tx.execute(sql`
    SELECT last_read_seq AS "lastReadSeq"
    FROM user_channel_read_cursors
    WHERE user_id = ${input.principalId}::uuid AND channel_id = ${input.scopeId}::uuid
    FOR UPDATE
  `);
  const [cursor] = locked.rows as Array<{ lastReadSeq: unknown }>;
  const rewindTo = Math.min(input.throughSeq, cursor ? asNumber(cursor.lastReadSeq) : 0);
  const subConversation = input.conversationType === "thread" || input.conversationType === "task";
  const decided = await input.tx.execute(sql`
    SELECT EXISTS (
             SELECT 1 FROM messages m
             WHERE m.channel_id = ${input.storageScopeId}::uuid
               AND m.seq > ${rewindTo}
               AND ${unreadEligibleMessageSql("human", input.principalId, input.conversationType)}
           ) AS "rewinds",
           EXISTS (SELECT 1 FROM messages m WHERE m.channel_id = ${input.storageScopeId}::uuid) AS "hasMessages",
           ${subConversation
             ? sql`EXISTS (
                 SELECT 1 FROM thread_follows tf
                 WHERE tf.thread_channel_id = ${input.scopeId}::uuid
                   AND tf.follower_type = 'user'
                   AND tf.follower_id = ${input.principalId}::uuid
                   AND tf.unfollowed_at IS NULL
               )`
             : input.computedJointMember ? sql`true` : sql`EXISTS (
                 SELECT 1 FROM channel_humans ch
                 WHERE ch.channel_id = ${input.scopeId}::uuid AND ch.user_id = ${input.principalId}::uuid
               )`} AS "inConversation"
  `);
  const [decision] = decided.rows as Array<{ rewinds: unknown; hasMessages: unknown; inConversation: unknown }>;
  if (decision?.rewinds === true) {
    const rewound = await applyScopeBoundary({
      tx: input.tx,
      principalKind: "human",
      principalId: input.principalId,
      authoritySeq: input.authoritySeq,
      scopeId: input.scopeId,
      throughSeq: input.throughSeq,
      direction: "backward",
      afterCursorLocked: input.afterCursorLocked,
    });
    // Count and outcome come from one read of the written state: the latest
    // countable message past the cursor as written (still under its row lock),
    // not past rewindTo; a cursorless scope is written at throughSeq, which can
    // be above rewindTo. The count is the seq distance to it, the measure the
    // /unread answer has always used. Read by the (channel_id, seq) index.
    const latest = await input.tx.execute(sql`
      SELECT m.seq AS "seq"
      FROM messages m
      WHERE m.channel_id = ${input.storageScopeId}::uuid
        AND m.seq > ${rewound.maxReadSeq}
        AND ${unreadEligibleMessageSql("human", input.principalId, input.conversationType)}
      ORDER BY m.seq DESC
      LIMIT 1
    `);
    const [latestRow] = latest.rows as Array<{ seq: unknown }>;
    const unreadCount = latestRow ? Math.max(asNumber(latestRow.seq) - rewound.maxReadSeq, 0) : 0;
    // A rewind clears any older mark, so this scope is never left marked.
    return { ...rewound, unreadCount, unreadOutcome: unreadCount > 0 ? "counted" : "nothing" };
  }
  await input.afterCursorLocked?.();
  type CursorRow = { lastReadSeq: unknown; readStateVersion: unknown; lastAppliedAuthoritySeq: unknown };
  const currentRow = async () => {
    const current = await input.tx.execute(sql`
      SELECT last_read_seq AS "lastReadSeq",
             read_state_version AS "readStateVersion",
             last_applied_authority_seq AS "lastAppliedAuthoritySeq",
             marked_unread AS "markedUnread"
      FROM user_channel_read_cursors
      WHERE user_id = ${input.principalId}::uuid AND channel_id = ${input.scopeId}::uuid
    `);
    return (current.rows as Array<CursorRow & { markedUnread: unknown }>)[0];
  };
  if (decision?.hasMessages !== true || decision?.inConversation !== true) {
    const row = await currentRow();
    return {
      scopeId: input.scopeId,
      maxReadSeq: row ? asNumber(row.lastReadSeq) : 0,
      readStateVersion: row ? asNumber(row.readStateVersion) : 0,
      lastAppliedAuthoritySeq: row ? asNumber(row.lastAppliedAuthoritySeq) : 0,
      changed: false,
      // Refused: nothing countable lies past the cursor (else it would have
      // rewound). A mark left from before (normally cleared by the unfollow's
      // read or the re-join) is still the written state, reported as such.
      // Nothing countable past the cursor: no count.
      unreadCount: 0,
      ...(row?.markedUnread === true
        ? { markedUnread: true as const, unreadOutcome: "marked" as const }
        : { unreadOutcome: "nothing" as const }),
    };
  }
  const marked = await input.tx.execute(sql`
    INSERT INTO user_channel_read_cursors (
      user_id, channel_id, last_read_seq, read_state_version, last_applied_authority_seq, marked_unread, updated_at
    ) VALUES (
      ${input.principalId}::uuid, ${input.scopeId}::uuid, 0, 1, ${input.authoritySeq}, true, now()
    )
    ON CONFLICT (user_id, channel_id) DO UPDATE SET
      marked_unread = true,
      read_state_version = user_channel_read_cursors.read_state_version + 1,
      last_applied_authority_seq = EXCLUDED.last_applied_authority_seq,
      updated_at = now()
    WHERE NOT user_channel_read_cursors.marked_unread
    RETURNING last_read_seq AS "lastReadSeq",
              read_state_version AS "readStateVersion",
              last_applied_authority_seq AS "lastAppliedAuthoritySeq"
  `);
  let [row] = marked.rows as CursorRow[];
  const changed = Boolean(row);
  // Already marked: an unchanged scope, like a repeated rewind.
  if (!row) row = await currentRow();
  if (!row) throw new Error("read mutation cursor resolution returned no row");
  return {
    scopeId: input.scopeId,
    maxReadSeq: asNumber(row.lastReadSeq),
    readStateVersion: asNumber(row.readStateVersion),
    lastAppliedAuthoritySeq: asNumber(row.lastAppliedAuthoritySeq),
    changed,
    unreadCount: 0,
    markedUnread: true,
    unreadOutcome: "marked",
  };
}

/**
 * Batched apply for global_read_all. The per-scope loop (one FOR UPDATE + one
 * upsert per channel) becomes three statements total: a sorted batch lock, one
 * unnest-driven upsert, and a supplementary read for channels the upsert did
 * not return (unchanged rows and predicate-rejected rows).
 *
 * Row-level equivalence with the per-scope path was verified by Ray on a
 * 200-channel PGlite fixture: ON CONFLICT WHERE is evaluated per row, so
 * unchanged rows do not bump read_state_version / authority / updated_at, and
 * the ack arrays and final table contents match byte-for-byte. The
 * supplementary read stays a separate statement: under READ COMMITTED a
 * same-statement CTE would see the statement snapshot and could miss legacy
 * inserts committed between the lock and the upsert (the old code's
 * supplementary read was also a new statement).
 */
async function applyGlobalScopeBoundaries(input: {
  tx: DatabaseTransaction;
  principalKind: ReadMutationPrincipalKind;
  principalId: string;
  authoritySeq: number;
  boundary: ReadMutationBoundary[];
  afterScopeCursorLocked?: (context: { scopeId: string; index: number }) => Promise<void>;
}): Promise<ReadMutationAck["scopes"]> {
  const cursorTable = input.principalKind === "human" ? "user_channel_read_cursors" : "agent_channel_read_cursors";
  const principalColumn = input.principalKind === "human" ? "user_id" : "agent_id";
  const boundary = input.boundary;
  const ids = boundary.map((entry) => entry.scopeId);
  const seenIds = new Set<string>();
  for (const id of ids) {
    // The unnest-driven upsert requires unique input ids (ON CONFLICT cannot
    // affect a row twice); candidates come from a UNION so they are unique,
    // but the boundary is a load-bearing contract — assert it.
    if (seenIds.has(id)) throw new Error("global_read_all boundary contains a duplicate scope id");
    seenIds.add(id);
  }

  // (a) Lock every cursor row up front in ascending channel order — the same
  // order the per-scope loop locked them in — so lock-order behavior is
  // unchanged.
  await input.tx.execute(sql`
    SELECT channel_id FROM ${sql.raw(cursorTable)}
    WHERE ${sql.raw(principalColumn)} = ${input.principalId}::uuid
      AND channel_id = ANY(${sql.param(ids)}::uuid[])
    ORDER BY channel_id FOR UPDATE
  `);

  for (const [index, capturedScope] of boundary.entries()) {
    await input.afterScopeCursorLocked?.({ scopeId: capturedScope.scopeId, index });
  }

  const throughSeqOf = new Map(boundary.map((entry) => [entry.scopeId, entry.throughSeq]));
  // A human's read also clears a scope's marked-unread flag where the position
  // does not move (applyScopeBoundary's forward branch); agents have no flag.
  const clearsMark = input.principalKind === "human";
  // (b) One upsert for every boundary channel. Forward semantics only:
  // global_read_all always moves the cursor forward, matching the per-scope
  // forward branch of applyScopeBoundary.
  const upserted = await input.tx.execute(sql`
    INSERT INTO ${sql.raw(cursorTable)} (
      ${sql.raw(principalColumn)}, channel_id, last_read_seq, read_state_version, last_applied_authority_seq, updated_at
    )
    SELECT ${input.principalId}::uuid, b.channel_id, b.through_seq, 1, ${input.authoritySeq}, now()
    FROM unnest(
      ${sql.param(ids)}::uuid[],
      ${sql.param(ids.map((id) => throughSeqOf.get(id)!))}::int[]
    ) AS b(channel_id, through_seq)
    ORDER BY b.channel_id
    ON CONFLICT (${sql.raw(principalColumn)}, channel_id) DO UPDATE SET
      last_read_seq = GREATEST(EXCLUDED.last_read_seq, ${sql.raw(cursorTable)}.last_read_seq),
      read_state_version = ${sql.raw(cursorTable)}.read_state_version + 1,
      last_applied_authority_seq = EXCLUDED.last_applied_authority_seq,
      ${clearsMark ? sql`marked_unread = false,` : sql``}
      updated_at = now()
    WHERE EXCLUDED.last_read_seq > ${sql.raw(cursorTable)}.last_read_seq
      ${clearsMark ? sql`OR ${sql.raw(cursorTable)}.marked_unread` : sql``}
    RETURNING channel_id,
              last_read_seq AS "lastReadSeq",
              read_state_version AS "readStateVersion",
              last_applied_authority_seq AS "lastAppliedAuthoritySeq"
  `);
  const updatedByScope = new Map<string, { lastReadSeq: unknown; readStateVersion: unknown; lastAppliedAuthoritySeq: unknown }>(
    (upserted.rows as Array<{ channel_id: string; lastReadSeq: unknown; readStateVersion: unknown; lastAppliedAuthoritySeq: unknown }>)
      .map((row) => [row.channel_id, row]),
  );

  // (c) Channels the upsert did not return: unchanged or predicate-rejected
  // rows. Fresh statement (new snapshot), exactly like the per-scope path.
  const missedIds = ids.filter((id) => !updatedByScope.has(id));
  const currentByScope = new Map<string, { lastReadSeq: unknown; readStateVersion: unknown; lastAppliedAuthoritySeq: unknown }>();
  if (missedIds.length > 0) {
    const current = await input.tx.execute(sql`
      SELECT channel_id,
             last_read_seq AS "lastReadSeq",
             read_state_version AS "readStateVersion",
             last_applied_authority_seq AS "lastAppliedAuthoritySeq"
      FROM ${sql.raw(cursorTable)}
      WHERE ${sql.raw(principalColumn)} = ${input.principalId}::uuid
        AND channel_id = ANY(${sql.param(missedIds)}::uuid[])
    `);
    for (const row of current.rows as Array<{ channel_id: string; lastReadSeq: unknown; readStateVersion: unknown; lastAppliedAuthoritySeq: unknown }>) {
      currentByScope.set(row.channel_id, row);
    }
  }

  const scopes: ReadMutationAck["scopes"] = [];
  for (const entry of boundary) {
    const updated = updatedByScope.get(entry.scopeId);
    if (updated) {
      scopes.push({
        scopeId: entry.scopeId,
        maxReadSeq: asNumber(updated.lastReadSeq),
        readStateVersion: asNumber(updated.readStateVersion),
        lastAppliedAuthoritySeq: asNumber(updated.lastAppliedAuthoritySeq),
        changed: true,
      });
      continue;
    }
    const current = currentByScope.get(entry.scopeId);
    if (!current) throw new Error("read mutation cursor resolution returned no row");
    scopes.push({
      scopeId: entry.scopeId,
      maxReadSeq: asNumber(current.lastReadSeq),
      readStateVersion: asNumber(current.readStateVersion),
      lastAppliedAuthoritySeq: asNumber(current.lastAppliedAuthoritySeq),
      changed: false,
    });
  }
  return scopes;
}

function assertActiveClaim(row: typeof readMutations.$inferSelect, claim: ReadMutationClaim, now: Date): void {
  if (
    row.mutationId !== claim.mutationId
    || row.authoritySeq !== claim.authoritySeq
    || row.state !== "executing"
    || row.leaseOwner !== claim.leaseOwner
    || row.leaseGeneration !== claim.leaseGeneration
    || !row.leaseExpiresAt
    || row.leaseExpiresAt <= now
  ) {
    throw new ReadMutationError("CLAIM_LOST", "read mutation lease is stale or no longer owns the minimum sequence");
  }
}

async function applyCompositeDoneMarker(input: {
  tx: DatabaseTransaction;
  principalId: string;
  targetKind: DoneTargetKind;
  scopeId: string;
  now: Date;
}): Promise<void> {
  if (input.targetKind === "channel") {
    const updated = await input.tx
      .update(userChannelInboxStates)
      .set({ doneAt: input.now, updatedAt: input.now })
      .where(and(
        eq(userChannelInboxStates.userId, input.principalId),
        eq(userChannelInboxStates.channelId, input.scopeId),
      ))
      .returning({ channelId: userChannelInboxStates.channelId });
    if (updated.length !== 1) throw new Error("locked channel Done-state row disappeared");
    return;
  }

  const updated = await input.tx
    .update(threadFollows)
    .set({ doneAt: input.now })
    .where(and(
      eq(threadFollows.threadChannelId, input.scopeId),
      eq(threadFollows.followerType, "user"),
      eq(threadFollows.followerId, input.principalId),
    ))
    .returning({ threadChannelId: threadFollows.threadChannelId });
  if (updated.length !== 1) throw new Error("locked thread Done-state row disappeared");
}

async function applyCompositeDoneSuppression(input: {
  tx: DatabaseTransaction;
  principalId: string;
  targetKind: DoneTargetKind;
  scopeId: string;
  throughSeq: string;
}): Promise<void> {
  if (input.targetKind === "channel") {
    await writeChannelInboxSuppression({
      userId: input.principalId,
      channelId: input.scopeId,
      throughActivitySeq: input.throughSeq,
      executor: input.tx,
    });
    return;
  }
  await writeThreadDoneSuppression({
    userId: input.principalId,
    threadChannelId: input.scopeId,
    throughActivitySeq: input.throughSeq,
    executor: input.tx,
  });
}

/**
 * The ack entry for a residue scope, built by naming each field (task #64). A
 * caller without content access must never be handed a read position above the
 * receiver-owned boundary: an existing cursor may hold a value the pre-fix
 * defect wrote from the channel's live frontier, and echoing it would reopen the
 * leak through the ack even with a correct boundary.
 */
function residueScopeAck(
  applied: ReadMutationAck["scopes"][number],
  residueThroughSeq: number | string,
): ReadMutationAck["scopes"][number] {
  return {
    scopeId: applied.scopeId,
    maxReadSeq: Math.min(applied.maxReadSeq, asNumber(residueThroughSeq)),
    readStateVersion: applied.readStateVersion,
    lastAppliedAuthoritySeq: applied.lastAppliedAuthoritySeq,
    changed: applied.changed,
  };
}

export async function executeReadMutationClaim(input: {
  claim: ReadMutationClaim;
  now?: Date;
  failpoint?: ReadMutationFailpoint;
  afterBoundaryCaptured?: (context: {
    tx: DatabaseTransaction;
    boundary: ReadMutationAck["capturedBoundary"];
  }) => Promise<void>;
  afterScopeCursorLocked?: (context: {
    scopeId: string;
    index: number;
  }) => Promise<void>;
}): Promise<ReadMutationAck> {
  const now = input.now ?? currentDate();
  if (input.failpoint === "before_effect") throw new ReadMutationFailpointError(input.failpoint);

  const ack = await sequencerTransaction(async (tx) => {
    const jointPreparation = await prepareJointReadFanout(tx, input.claim);
    // Task #93 line B: servers first, so holding the member row and then inserting a servers-FK row (read_mutations/authority)
    // cannot deadlock with transitionMemberRole. The authority decision below is unchanged.
    await lockReadMutationServerRow(tx, input.claim.serverId);
    await lockAuthority(tx, input.claim.serverId, input.claim.principalKind, input.claim.principalId);
    const [minimum] = await tx.select().from(readMutations).where(and(
      eq(readMutations.serverId, input.claim.serverId),
      eq(readMutations.principalType, input.claim.principalKind),
      eq(readMutations.principalId, input.claim.principalId),
      inArray(readMutations.state, ["admitted", "executing"]),
    )).orderBy(asc(readMutations.authoritySeq)).limit(1);
    if (!minimum) throw new ReadMutationError("CLAIM_LOST", "no nonterminal read mutation remains");
    assertActiveClaim(minimum, input.claim, now);

    let captured: ReadMutationBoundary[] | null;
    let residueScopeIds: ReadonlySet<string> = new Set();
    let unreadStorageScopeId: string | undefined;
    let markUnreadScope: CapturedChannelBoundary["markUnreadScope"];
    let applyBroadDoneMarker = false;
    let doneFrontierBeyondLatest = false;
    try {
      if (minimum.kind === "done") {
        const capturedDone = await captureDoneBoundary(tx, minimum);
        captured = capturedDone.boundary;
        applyBroadDoneMarker = capturedDone.applyBroadDoneMarker;
      } else {
        const capturedScopes = await captureBoundary(tx, minimum);
        captured = capturedScopes?.boundary ?? null;
        residueScopeIds = new Set(capturedScopes?.residueScopeIds ?? []);
        unreadStorageScopeId = capturedScopes?.unreadStorageScopeId;
        markUnreadScope = capturedScopes?.markUnreadScope;
      }
    } catch (error) {
      if (
        minimum.kind === "done"
        && (
          error instanceof DoneFrontierBeyondLatestError
          || (error instanceof ReadMutationError && error.code === "DONE_FRONTIER_BEYOND_LATEST")
        )
      ) {
        captured = [];
        doneFrontierBeyondLatest = true;
      } else {
        throw error;
      }
    }
    const authorizationRevoked = captured === null;
    const boundary = captured ?? [];
    await input.afterBoundaryCaptured?.({ tx, boundary });
    const jointPlan = await planJointReadFanout(tx, input.claim, jointPreparation, boundary, residueScopeIds);
    const effectiveThrough = new Map(jointPlan.effectiveBoundary.map((row) => [row.scopeId, row.throughSeq]));
    const scopes: ReadMutationAck["scopes"] = [];
    if ((minimum.kind === "global_read_all" || minimum.kind === "conversation_read_all") && boundary.length > 0) {
      // Batched apply: one lock, one upsert, one supplementary read for the
      // whole boundary instead of a per-scope loop. mid_global fires after the
      // batch apply, before terminalize — the transaction still rolls back
      // wholesale, so existing assertions hold.
      // Read-all leaves nothing unread at the captured frontier: no count query.
      scopes.push(...(await applyGlobalScopeBoundaries({
        tx,
        principalKind: minimum.principalType,
        principalId: minimum.principalId,
        authoritySeq: minimum.authoritySeq,
        boundary: jointPlan.effectiveBoundary,
        afterScopeCursorLocked: input.afterScopeCursorLocked
          ? ({ scopeId, index }) => input.afterScopeCursorLocked!({ scopeId, index })
          : undefined,
      })).map((scope) => ({ ...scope, unreadCount: 0 })));
      if (input.failpoint === "mid_global") {
        throw new ReadMutationFailpointError(input.failpoint);
      }
    } else {
    for (const [index, capturedScope] of boundary.entries()) {
      if (minimum.kind === "done") {
        if (minimum.doneTargetKind == null || typeof capturedScope.throughSeq !== "string") {
          throw new Error("composite Done boundary lost its exact persisted identity");
        }
        // The Done-state row was already locked while capturing the boundary.
        // A broad marker is valid only when S was still the canonical latest
        // frontier under that lock. When newer activity already exists, keep
        // the row active while still applying the bounded cursor/suppression.
        if (applyBroadDoneMarker) {
          await applyCompositeDoneMarker({
            tx,
            principalId: minimum.principalId,
            targetKind: minimum.doneTargetKind,
            scopeId: capturedScope.scopeId,
            now,
          });
        }
      }
      const afterCursorLocked = input.afterScopeCursorLocked
        ? () => input.afterScopeCursorLocked!({ scopeId: capturedScope.scopeId, index })
        : undefined;
      const appliedScope = minimum.kind === "row_unread" && minimum.principalType === "human" && markUnreadScope
        ? await applyRowUnread({
          tx,
          principalId: minimum.principalId,
          authoritySeq: minimum.authoritySeq,
          scopeId: capturedScope.scopeId,
          storageScopeId: markUnreadScope.storageScopeId,
          conversationType: markUnreadScope.conversationType,
          computedJointMember: markUnreadScope.computedJointMember,
          throughSeq: asNumber(effectiveThrough.get(capturedScope.scopeId) ?? capturedScope.throughSeq),
          afterCursorLocked,
        })
        : await applyScopeBoundary({
          tx,
          principalKind: minimum.principalType,
          principalId: minimum.principalId,
          authoritySeq: minimum.authoritySeq,
          scopeId: capturedScope.scopeId,
          throughSeq: effectiveThrough.get(capturedScope.scopeId) ?? capturedScope.throughSeq,
          direction: minimum.kind === "row_unread" ? "backward" : "forward",
          afterCursorLocked,
          unreadStorageScopeId: unreadStorageScopeId ?? jointPlan.groups.get(capturedScope.scopeId)?.[0]?.storageScopeId,
        });
      const ackScope = minimum.kind === "channel_read_all" ? { ...appliedScope, unreadCount: 0 } : appliedScope;
      scopes.push(residueScopeIds.has(capturedScope.scopeId)
        ? residueScopeAck(ackScope, capturedScope.throughSeq)
        : ackScope);
      if (minimum.kind === "done") {
        await applyCompositeDoneSuppression({
          tx,
          principalId: minimum.principalId,
          targetKind: minimum.doneTargetKind!,
          scopeId: capturedScope.scopeId,
          throughSeq: capturedScope.throughSeq as string,
        });
      }
      if (input.failpoint === "mid_global" && minimum.kind === "global_read_all" && index === 0) {
        throw new ReadMutationFailpointError(input.failpoint);
      }
    }
    }

    const jointUpdates = await applyJointReadFanout(tx, input.claim, jointPlan, scopes);
    // Include the source deliberately: a durable worker can finish after the
    // request went away, or without an HTTP route at all. HTTP may repeat the
    // source push, which clients deduplicate by read-state version; notification
    // retraction already coalesces the same user/server/scope to its max frontier.
    announceJointHumanReadUpdates({
      userId: minimum.principalId, mutationId: minimum.mutationId, forward: minimum.kind !== "row_unread",
      updates: [...scopes.filter((row) => jointPlan.groups.has(row.scopeId)).map((row) => ({
        ...row, serverId: asServerId(minimum.serverId),
      })), ...jointUpdates],
    });

    // serving_rows maintenance retired (2026-09-21 teardown): read-state is
    // authoritative in cursors; Activity surfaces derive from them in RW.

    if (input.failpoint === "after_sql_before_commit") {
      throw new ReadMutationFailpointError(input.failpoint);
    }

    const anyCursorChanged = scopes.some((scope) => scope.changed) || jointUpdates.length > 0;
    const doneEffectApplied = minimum.kind === "done"
      && !doneFrontierBeyondLatest
      && !authorizationRevoked
      && boundary.length === 1;
    const anyEffectApplied = anyCursorChanged || doneEffectApplied;
    const terminalState: ReadMutationTerminalState = anyEffectApplied
      ? "applied"
      : "retired_no_effect";
    const terminalReason: ReadMutationTerminalReason = doneFrontierBeyondLatest
      ? "done_frontier_beyond_latest"
      : authorizationRevoked
        ? "authorization_revoked"
        : anyEffectApplied
          ? "effect_applied"
          : "already_satisfied";
    const ackWithoutDigest = {
      serverId: minimum.serverId,
      principalId: minimum.principalId,
      mutationId: minimum.mutationId,
      payloadHash: minimum.payloadHash,
      authoritySeq: minimum.authoritySeq,
      kind: minimum.kind,
      terminalState,
      terminalReason,
      capturedBoundary: boundary,
      scopes,
    };
    const terminalDigest = digestJson(ackWithoutDigest);
    const completeAck: ReadMutationAck = { ...ackWithoutDigest, terminalDigest };
    // terminal_at records when execution FINISHED. `now` was captured before
    // the transaction, so writing it here left terminal_at - executing_at at
    // ~0 (just the claim-to-execute gap) and hid the execution time entirely:
    // only the admission queue wait was measurable. A caller-pinned clock
    // (input.now) is kept as-is so deterministic tests stay deterministic.
    const terminalAt = input.now ?? currentDate();
    const [terminalized] = await tx.update(readMutations).set({
      state: terminalState,
      capturedBoundary: boundary,
      ack: completeAck,
      terminalReason,
      terminalDigest,
      leaseExpiresAt: null,
      terminalAt,
      updatedAt: terminalAt,
    }).where(and(
      eq(readMutations.serverId, minimum.serverId),
      eq(readMutations.principalType, minimum.principalType),
      eq(readMutations.principalId, minimum.principalId),
      eq(readMutations.mutationId, minimum.mutationId),
      eq(readMutations.state, "executing"),
      eq(readMutations.leaseOwner, input.claim.leaseOwner),
      eq(readMutations.leaseGeneration, input.claim.leaseGeneration),
    )).returning({ mutationId: readMutations.mutationId });
    if (!terminalized) {
      throw new ReadMutationError("CLAIM_LOST", "lease generation CAS lost before terminal commit");
    }
    await tx.update(readMutationAuthorities).set({
      lastTerminalAuthoritySeq: minimum.authoritySeq,
      updatedAt: now,
    }).where(and(
      eq(readMutationAuthorities.serverId, minimum.serverId),
      eq(readMutationAuthorities.principalType, minimum.principalType),
      eq(readMutationAuthorities.principalId, minimum.principalId),
    ));
    return completeAck;
  });

  if (input.failpoint === "after_commit_before_response") {
    throw new ReadMutationFailpointError(input.failpoint);
  }
  return ack;
}

export async function processNextReadMutation(input: {
  serverId: string;
  principalKind?: ReadMutationPrincipalKind;
  principalId: string;
  leaseOwner: string;
  leaseMs?: number;
  now?: Date;
  failpoint?: ReadMutationFailpoint;
}): Promise<ReadMutationAck | null> {
  const claim = await claimNextReadMutation(input);
  if (!claim) return null;
  return executeReadMutationClaim({ claim, now: input.now, failpoint: input.failpoint });
}

export async function resolveReadMutationUnreadBoundary(input: {
  serverId: string;
  principalKind?: ReadMutationPrincipalKind;
  principalId: string;
  scopeId: string;
}): Promise<{ latestUnreadEligibleSeq: number; throughSeq: number }> {
  const principalKind = input.principalKind ?? "human";
  return sequencerTransaction(async (tx) => {
    // Task #93 line B: this boundary read is a read-state entry point reached straight from the unread route, ahead of
    // any admission. Fence Server membership first, in the global order, so a principal removed or demoted after the
    // request-level checks is refused with the typed error the routes map to 403 — instead of falling through to the
    // scope read, which reports the now-invisible scope as SCOPE_NOT_FOUND and surfaces as a 500.
    await lockReadMutationAdmissionFence(tx, {
      serverId: input.serverId,
      principalKind,
      principalId: input.principalId,
    });
    const resolved = await resolveAuthorizedReadMutationScope(tx, { ...input, principalKind });
    const live = liveReadScopeOf(resolved);
    if (!live) throw new ReadMutationError("SCOPE_NOT_FOUND", "read mutation scope does not exist in this server");
    const result = await tx.execute(sql`
      SELECT COALESCE(MAX(m.seq), 0)::int AS "latestUnreadEligibleSeq"
      FROM messages m
      WHERE m.channel_id = ${live.storageScopeId}::uuid
        AND ${unreadEligibleMessageSql(principalKind, input.principalId, resolved!.channelType)}
    `);
    const [row] = result.rows as Array<{ latestUnreadEligibleSeq: unknown }>;
    const latestUnreadEligibleSeq = asNumber(row?.latestUnreadEligibleSeq ?? 0);
    return {
      latestUnreadEligibleSeq,
      throughSeq: Math.max(latestUnreadEligibleSeq - 1, 0),
    };
  });
}

/**
 * Bridge for pre-Phase-2 callers that expect a read write to be complete when
 * their existing service call returns. It creates a normal server mutation and
 * helps drain the same durable queue in order; it never writes the cursor
 * directly. The durable worker remains the recovery owner if the request dies.
 */
export async function executeCompatibilityReadMutation(input: {
  serverId: string;
  principalKind?: ReadMutationPrincipalKind;
  principalId: string;
  mutation: ReadMutationPayload;
  timeoutMs?: number;
  actor?: ReadMutationActor;
}): Promise<ReadMutationAck> {
  const principalKind = input.principalKind ?? "human";
  const mutationId = randomUUID();
  const admission = await admitReadMutation({
    serverId: input.serverId,
    principalKind,
    principalId: input.principalId,
    mutationId,
    mutation: input.mutation,
    actor: input.actor,
  });
  const leaseOwner = `compat:${hostname()}:${process.pid}:${mutationId}`;
  const configuredTimeout = Number(process.env[READ_MUTATION_COMPATIBILITY_WAIT_MS_ENV] ?? 10_000);
  const timeoutMs = input.timeoutMs ?? (
    Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? Math.min(Math.floor(configuredTimeout), 60_000)
      : 10_000
  );
  const deadline = currentTimeMs() + timeoutMs;
  while (currentTimeMs() < deadline) {
    try {
      const [row] = await getDb().select({
        state: readMutations.state,
        ack: readMutations.ack,
      }).from(readMutations).where(and(
        eq(readMutations.serverId, input.serverId),
        eq(readMutations.principalType, principalKind),
        eq(readMutations.principalId, input.principalId),
        eq(readMutations.mutationId, mutationId),
      )).limit(1);
      if (row && (row.state === "applied" || row.state === "retired_no_effect") && row.ack) {
        const storedAck = row.ack;
        const bounded = await sequencerTransaction((tx) => boundStoredChannelReadAllAck(tx, {
          serverId: input.serverId,
          principalKind,
          principalId: input.principalId,
          kind: input.mutation.kind,
          scopeId: "scopeId" in input.mutation ? input.mutation.scopeId ?? null : null,
          ack: storedAck,
        }));
        return bounded as unknown as ReadMutationAck;
      }

      const processed = await processNextReadMutation({
        serverId: input.serverId,
        principalKind,
        principalId: input.principalId,
        leaseOwner,
      });
      if (processed?.mutationId === mutationId) return processed;
      if (!processed) await new Promise<void>((resolve) => setClockTimeout(resolve, 10));
    } catch (error) {
      // Admission is already durable. A predecessor/executor/database failure
      // cannot turn that accepted intent into a definite HTTP failure: leave
      // recovery to the worker/frontier and return the typed pending receipt
      // immediately. Request-local retries here would amplify a real database
      // failure and leave teardown work/timers behind.
      console.warn("[ReadMutationSequencer] compatibility drain attempt failed after durable admission", {
        serverId: input.serverId,
        principalId: input.principalId,
        mutationId,
        authoritySeq: admission.authoritySeq,
        errorClass: errorClassOf(error),
      });
      throw new CompatibilityReadMutationPendingError(
        input.serverId,
        input.principalId,
        mutationId,
        admission.authoritySeq,
      );
    }
  }
  console.warn("[ReadMutationSequencer] compatibility mutation remains pending after bounded wait", {
    serverId: input.serverId,
    principalId: input.principalId,
    mutationId,
    authoritySeq: admission.authoritySeq,
  });
  throw new CompatibilityReadMutationPendingError(
    input.serverId,
    input.principalId,
    mutationId,
    admission.authoritySeq,
  );
}

/** One `uuid[]` parameter (a JS array would expand into one parameter per id). */
function uuidArrayParam(ids: readonly string[]) {
  return sql`${`{${ids.join(",")}}`}::uuid[]`;
}

/** At most this many of one principal's candidates move in one transaction. */
const COMPACTION_PRINCIPAL_CHUNK = 100;

/** A chunk row changed between the read and the delete: the chunk rolls back. */
class CompactionChunkChangedError extends Error {
  constructor() {
    super("read mutation compaction chunk changed while it was being moved");
  }
}

export async function compactTerminalReadMutations(input: {
  before?: Date;
  limit?: number;
} = {}): Promise<{ compacted: number; candidates: number }> {
  const limit = Math.max(1, Math.min(input.limit ?? 100, 1_000));
  const retentionPredicate = input.before
    ? lt(readMutations.terminalAt, input.before)
    : sql`${readMutations.terminalAt} < now() - interval '90 days'`;
  // One ordered read per terminal state, merged here. With both states in one
  // `state IN (...) ORDER BY terminal_at`, the (state, terminal_at) index
  // cannot return rows in terminal_at order, so the planner bitmap-scanned and
  // sorted every expired row (about 1.8M in production) and the query hit the
  // statement timeout on every run. Each per-state read is an ordered index
  // range scan that stops after `limit` rows.
  const candidatesForState = (state: "applied" | "retired_no_effect") => getDb().select({
    serverId: readMutations.serverId,
    principalKind: readMutations.principalType,
    principalId: readMutations.principalId,
    mutationId: readMutations.mutationId,
    terminalAt: readMutations.terminalAt,
  }).from(readMutations).where(and(
    eq(readMutations.state, state),
    isNotNull(readMutations.terminalAt),
    retentionPredicate,
  )).orderBy(asc(readMutations.terminalAt)).limit(limit);
  const candidates = [
    ...await candidatesForState("applied"),
    ...await candidatesForState("retired_no_effect"),
  ]
    .sort((left, right) => left.terminalAt!.getTime() - right.terminalAt!.getTime())
    .slice(0, limit);

  // One transaction per principal (per chunk of up to COMPACTION_PRINCIPAL_CHUNK
  // of its candidates), not per row. Each row was its own transaction and
  // touched cold heap and index pages: production measured 18-40 ms a row.
  // Under the principal's authority lock (skipped, never waited for) the chunk
  // is written as tombstones and deleted together: either every live row of
  // the chunk moves, or none does.
  const groups = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    const key = `${candidate.serverId}\u0000${candidate.principalKind}\u0000${candidate.principalId}`;
    const group = groups.get(key);
    if (group) group.push(candidate); else groups.set(key, [candidate]);
  }
  const chunks: Array<typeof candidates> = [];
  for (const group of groups.values()) {
    for (let start = 0; start < group.length; start += COMPACTION_PRINCIPAL_CHUNK) {
      chunks.push(group.slice(start, start + COMPACTION_PRINCIPAL_CHUNK));
    }
  }

  let compacted = 0;
  for (const chunk of chunks) {
    const { serverId, principalKind, principalId } = chunk[0]!;
    const mutationIds = chunk.map((candidate) => candidate.mutationId);
    const eligible = input.before
      ? sql`m.terminal_at < ${input.before.toISOString()}::timestamptz`
      : sql`m.terminal_at < now() - interval '90 days'`;
    const moved = await sequencerTransaction(async (tx) => {
      if (!await tryLockAuthority(tx, serverId, principalKind, principalId)) return 0;
      const live = await tx.execute<{ mutation_id: string }>(sql`
        SELECT m.mutation_id::text AS mutation_id FROM read_mutations m
        WHERE m.server_id = ${serverId}::uuid
          AND m.principal_type = ${principalKind}
          AND m.principal_id = ${principalId}::uuid
          AND m.mutation_id = ANY(${uuidArrayParam(mutationIds)})
          AND m.state IN ('applied', 'retired_no_effect')
          AND m.terminal_digest IS NOT NULL
          AND m.terminal_reason IS NOT NULL
          AND m.terminal_at IS NOT NULL
          AND ${eligible}
      `);
      const liveIds = live.rows.map((row) => row.mutation_id);
      if (liveIds.length === 0) return 0;
      await tx.execute(sql`
        INSERT INTO read_mutation_tombstones (
          server_id, principal_type, principal_id, mutation_id, payload_hash,
          original_authority_seq, terminal_state, terminal_reason, terminal_digest
        )
        SELECT m.server_id, m.principal_type, m.principal_id, m.mutation_id, m.payload_hash,
          m.authority_seq, m.state, m.terminal_reason, m.terminal_digest
        FROM read_mutations m
        WHERE m.server_id = ${serverId}::uuid
          AND m.principal_type = ${principalKind}
          AND m.principal_id = ${principalId}::uuid
          AND m.mutation_id = ANY(${uuidArrayParam(liveIds)})
        ON CONFLICT (server_id, principal_type, principal_id, mutation_id) DO NOTHING
      `);
      // A tombstone that already existed must match the live terminal identity.
      const mismatched = await tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM read_mutations m
        LEFT JOIN read_mutation_tombstones t
          ON t.server_id = m.server_id AND t.principal_type = m.principal_type
         AND t.principal_id = m.principal_id AND t.mutation_id = m.mutation_id
        WHERE m.server_id = ${serverId}::uuid
          AND m.principal_type = ${principalKind}
          AND m.principal_id = ${principalId}::uuid
          AND m.mutation_id = ANY(${uuidArrayParam(liveIds)})
          AND (t.mutation_id IS NULL
            OR t.payload_hash IS DISTINCT FROM m.payload_hash
            OR t.original_authority_seq IS DISTINCT FROM m.authority_seq
            OR t.terminal_state IS DISTINCT FROM m.state
            OR t.terminal_reason IS DISTINCT FROM m.terminal_reason
            OR t.terminal_digest IS DISTINCT FROM m.terminal_digest)
      `);
      if ((mismatched.rows[0]?.n ?? 0) > 0) {
        throw new Error("read mutation tombstone conflict does not match the live terminal identity");
      }
      if (beforeCompactionDeleteForTests) await beforeCompactionDeleteForTests(tx);
      // Delete exactly the identity each tombstone recorded: a row whose
      // authority seq, state, reason or digest no longer matches its tombstone stays,
      // and the count check below rolls the chunk back.
      const deleted = await tx.execute<{ mutation_id: string }>(sql`
        DELETE FROM read_mutations m
        USING read_mutation_tombstones t
        WHERE m.server_id = ${serverId}::uuid
          AND m.principal_type = ${principalKind}
          AND m.principal_id = ${principalId}::uuid
          AND m.mutation_id = ANY(${uuidArrayParam(liveIds)})
          AND t.server_id = m.server_id AND t.principal_type = m.principal_type
          AND t.principal_id = m.principal_id AND t.mutation_id = m.mutation_id
          AND t.payload_hash = m.payload_hash
          AND t.original_authority_seq = m.authority_seq
          AND t.terminal_state = m.state
          AND t.terminal_reason IS NOT DISTINCT FROM m.terminal_reason
          AND t.terminal_digest = m.terminal_digest
        RETURNING m.mutation_id
      `);
      // All or nothing: a row that changed between the read and the delete
      // rolls back the whole chunk, tombstones included.
      if (deleted.rows.length !== liveIds.length) {
        throw new CompactionChunkChangedError();
      }
      return deleted.rows.length;
    }).catch((error: unknown) => {
      if (error instanceof CompactionChunkChangedError) return 0;
      throw error;
    });
    compacted += moved;
  }
  return { compacted, candidates: candidates.length };
}

export async function getReadMutationFrontier(input: {
  serverId: string;
  principalKind?: ReadMutationPrincipalKind;
  principalId: string;
  mutationId?: string;
  limit?: number;
  afterAuthoritySeq?: number;
  snapshotUpperAuthoritySeq?: number;
  scopeIds?: string[];
}): Promise<{
  serverId: string;
  principalId: string;
  nextAuthoritySeq: number;
  lastTerminalAuthoritySeq: number;
  snapshotUpperAuthoritySeq: number;
  items: Array<{
    mutationId: string;
    payloadHash: string;
    authoritySeq: number;
    state: ReadMutationState;
    terminalReason: ReadMutationTerminalReason | null;
    terminalDigest: string | null;
    admittedAt: string | null;
    terminalAt: string | null;
    compactedAt: string | null;
  }>;
  nextAfterAuthoritySeq: number | null;
  scopes: Array<{
    scopeId: string;
    maxReadSeq: number;
    readStateVersion: number;
    lastAppliedAuthoritySeq: number;
  }>;
}> {
  if (input.limit != null && (!Number.isSafeInteger(input.limit) || input.limit < 1)) {
    throw new ReadMutationError("INVALID_MUTATION_PAYLOAD", "limit must be a positive integer");
  }
  const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
  const afterAuthoritySeq = input.afterAuthoritySeq ?? 0;
  if (!Number.isSafeInteger(afterAuthoritySeq) || afterAuthoritySeq < 0) {
    throw new ReadMutationError("INVALID_MUTATION_PAYLOAD", "afterAuthoritySeq must be a non-negative integer");
  }
  if (input.mutationId && !UUID_V4_RE.test(input.mutationId)) {
    throw new ReadMutationError("INVALID_MUTATION_ID", "mutationId must be UUIDv4");
  }
  const scopeIds = [...new Set(input.scopeIds ?? [])];
  if (scopeIds.length > 100 || scopeIds.some((scopeId) => !UUID_V4_RE.test(scopeId))) {
    throw new ReadMutationError("INVALID_MUTATION_PAYLOAD", "scopeIds must contain at most 100 UUIDs");
  }
  const principalKind = input.principalKind ?? "human";
  return sequencerTransaction(async (tx) => {
    // Task #93 line B: servers first; lockAuthority below may insert the authority row (FK servers) after the member row.
    await lockReadMutationServerRow(tx, input.serverId);
    if (!await lockActiveReadMutationPrincipal(tx, input.serverId, principalKind, input.principalId)) {
      throw new ReadMutationError("SCOPE_NOT_FOUND", "read mutation authority was not found");
    }
    const authority = await lockAuthority(tx, input.serverId, principalKind, input.principalId);
    const currentUpper = authority.nextAuthoritySeq - 1;
    const snapshotUpperAuthoritySeq = input.snapshotUpperAuthoritySeq ?? currentUpper;
    if (
      !Number.isSafeInteger(snapshotUpperAuthoritySeq)
      || snapshotUpperAuthoritySeq < 0
      || snapshotUpperAuthoritySeq > currentUpper
    ) {
      throw new ReadMutationError("INVALID_MUTATION_PAYLOAD", "snapshotUpperAuthoritySeq is outside the authority frontier");
    }

    type FrontierItem = {
      mutationId: string;
      payloadHash: string;
      authoritySeq: number;
      state: ReadMutationState;
      terminalReason: ReadMutationTerminalReason | null;
      terminalDigest: string | null;
      admittedAt: string | null;
      terminalAt: string | null;
      compactedAt: string | null;
    };
    let items: FrontierItem[] = [];
    if (input.mutationId) {
      const [live] = await tx.select().from(readMutations).where(and(
        eq(readMutations.serverId, input.serverId),
        eq(readMutations.principalType, principalKind),
        eq(readMutations.principalId, input.principalId),
        eq(readMutations.mutationId, input.mutationId),
      )).limit(1);
      if (live) {
        items = [{
          mutationId: live.mutationId,
          payloadHash: live.payloadHash,
          authoritySeq: live.authoritySeq,
          state: live.state,
          terminalReason: live.terminalReason as ReadMutationTerminalReason | null,
          terminalDigest: live.terminalDigest,
          admittedAt: live.admittedAt.toISOString(),
          terminalAt: live.terminalAt?.toISOString() ?? null,
          compactedAt: null,
        }];
      } else {
        const [tombstone] = await tx.select().from(readMutationTombstones).where(and(
          eq(readMutationTombstones.serverId, input.serverId),
          eq(readMutationTombstones.principalType, principalKind),
          eq(readMutationTombstones.principalId, input.principalId),
          eq(readMutationTombstones.mutationId, input.mutationId),
        )).limit(1);
        if (tombstone) {
          items = [{
            mutationId: tombstone.mutationId,
            payloadHash: tombstone.payloadHash,
            authoritySeq: tombstone.originalAuthoritySeq,
            state: tombstone.terminalState,
            terminalReason: tombstone.terminalReason as ReadMutationTerminalReason,
            terminalDigest: tombstone.terminalDigest,
            admittedAt: null,
            terminalAt: null,
            compactedAt: tombstone.compactedAt.toISOString(),
          }];
        }
      }
    } else {
      const liveRows = await tx.select().from(readMutations).where(and(
        eq(readMutations.serverId, input.serverId),
        eq(readMutations.principalType, principalKind),
        eq(readMutations.principalId, input.principalId),
        gt(readMutations.authoritySeq, afterAuthoritySeq),
        lte(readMutations.authoritySeq, snapshotUpperAuthoritySeq),
      )).orderBy(asc(readMutations.authoritySeq)).limit(limit + 1);
      const tombstones = await tx.select().from(readMutationTombstones).where(and(
        eq(readMutationTombstones.serverId, input.serverId),
        eq(readMutationTombstones.principalType, principalKind),
        eq(readMutationTombstones.principalId, input.principalId),
        gt(readMutationTombstones.originalAuthoritySeq, afterAuthoritySeq),
        lte(readMutationTombstones.originalAuthoritySeq, snapshotUpperAuthoritySeq),
      )).orderBy(asc(readMutationTombstones.originalAuthoritySeq)).limit(limit + 1);
      items = [
        ...liveRows.map((row): FrontierItem => ({
          mutationId: row.mutationId,
          payloadHash: row.payloadHash,
          authoritySeq: row.authoritySeq,
          state: row.state,
          terminalReason: row.terminalReason as ReadMutationTerminalReason | null,
          terminalDigest: row.terminalDigest,
          admittedAt: row.admittedAt.toISOString(),
          terminalAt: row.terminalAt?.toISOString() ?? null,
          compactedAt: null,
        })),
        ...tombstones.map((row): FrontierItem => ({
          mutationId: row.mutationId,
          payloadHash: row.payloadHash,
          authoritySeq: row.originalAuthoritySeq,
          state: row.terminalState,
          terminalReason: row.terminalReason as ReadMutationTerminalReason,
          terminalDigest: row.terminalDigest,
          admittedAt: null,
          terminalAt: null,
          compactedAt: row.compactedAt.toISOString(),
        })),
      ].sort((a, b) => a.authoritySeq - b.authoritySeq);
    }
    const hasNext = !input.mutationId && items.length > limit;
    if (hasNext) items = items.slice(0, limit);

    const authorizedScopes = await resolveAuthorizedReadMutationScopes(tx, {
      serverId: input.serverId,
      principalKind,
      principalId: input.principalId,
      scopeIds,
    });
    const authorizedScopeIds = authorizedScopes.map((scope) => scope.scopeId);
    const scopeRows = authorizedScopeIds.length === 0
      ? []
      : principalKind === "human"
        ? await tx.select({
            scopeId: userChannelReadCursors.channelId,
            maxReadSeq: userChannelReadCursors.lastReadSeq,
            readStateVersion: userChannelReadCursors.readStateVersion,
            lastAppliedAuthoritySeq: userChannelReadCursors.lastAppliedAuthoritySeq,
          }).from(userChannelReadCursors).where(and(
            eq(userChannelReadCursors.userId, input.principalId),
            inArray(userChannelReadCursors.channelId, authorizedScopeIds),
          )).orderBy(asc(userChannelReadCursors.channelId))
        : await tx.select({
            scopeId: agentChannelReadCursors.channelId,
            maxReadSeq: agentChannelReadCursors.lastReadSeq,
            readStateVersion: agentChannelReadCursors.readStateVersion,
            lastAppliedAuthoritySeq: agentChannelReadCursors.lastAppliedAuthoritySeq,
          }).from(agentChannelReadCursors).where(and(
            eq(agentChannelReadCursors.agentId, input.principalId),
            inArray(agentChannelReadCursors.channelId, authorizedScopeIds),
          )).orderBy(asc(agentChannelReadCursors.channelId));

    return {
      serverId: input.serverId,
      principalId: input.principalId,
      nextAuthoritySeq: authority.nextAuthoritySeq,
      lastTerminalAuthoritySeq: authority.lastTerminalAuthoritySeq,
      snapshotUpperAuthoritySeq,
      items,
      nextAfterAuthoritySeq: hasNext ? items.at(-1)!.authoritySeq : null,
      scopes: scopeRows,
    };
  });
}

export async function drainReadMutationOutbox(input: {
  leaseOwner?: string;
  leaseMs?: number;
  batchSize?: number;
  /**
   * Process owned tracer for the per claim spans and failure events. Claim
   * spans nest under the active span (the worker drain root) when there is
   * one. Untraced (default noop) keeps the console only behavior.
   */
  tracer?: Tracer;
  /**
   * Test seam: a deterministic claim source. A real collision needs two
   * transactions racing and cannot be scheduled reliably, so proving the
   * contended branch is reachable -- and that old/new behavior actually
   * differ at batchSize=1 -- requires injecting the sequence. Production
   * callers must not set this. (Reinstated at review: without it the core
   * branch had no demonstrable behavior difference in the minimal case.)
   */
  claimNext?: typeof claimNextFairReadMutation;
} = {}): Promise<{ processed: number; failed: number }> {
  const leaseOwner = input.leaseOwner ?? `${hostname()}:${process.pid}:${randomUUID()}`;
  const batchSize = Math.max(1, Math.min(input.batchSize ?? DEFAULT_WORKER_BATCH_SIZE, 500));
  const tracer = input.tracer ?? noopTracer;
  let processed = 0;
  let failed = 0;
  // Two separate budgets, deliberately. `claims` counts real work (a
  // successful claim, whether it then processes or fails) and is what
  // batchSize has always meant. `contentionSkips` bounds collision retries
  // WITHOUT spending a work slot: at batchSize=1 -- exactly the shape of the
  // fairness red in CI run 31096794334/attempt 1 -- a collision that consumed
  // the only slot would end the round with zero "look again", leaving this fix
  // behaviorally identical to the old conflation (croxx's review finding).
  // Each retry's candidate query runs on a fresh snapshot, so the stolen
  // principal excludes itself; the skip cap keeps the loop finite even if that
  // assumption ever breaks.
  let claims = 0;
  let contentionSkips = 0;
  while (claims < batchSize) {
    const claim = await (input.claimNext ?? claimNextFairReadMutation)({
      leaseOwner,
      leaseMs: input.leaseMs,
    });
    if (claim === "contended") {
      // Cap = batchSize * 2, and the reason it is not `batchSize` is a bug this
      // PR already shipped once: at batchSize=1 a cap of 1 breaks on the FIRST
      // collision -- zero retries, behaviorally the old conflation again (the
      // deterministic pair test caught it before review did). Doubling
      // guarantees at least two looks even in the smallest round while keeping
      // total iterations <= batchSize * 3.
      contentionSkips += 1;
      if (contentionSkips >= batchSize * 2) break;
      continue;
    }
    if (!claim) break;
    claims += 1;
    const claimSpan = tracer.startSpan("server.read_mutation_sequencer.claim", {
      surface: "server",
      kind: "internal",
      parent: getCurrentTraceContext(),
      attrs: {
        server_id: claim.serverId,
        principal_id: claim.principalId,
        mutation_id: claim.mutationId,
      },
    });
    try {
      await runWithTraceSpan(
        claimSpan,
        () => withStatementStats(`read_mutation.claim.${claim.kind}`, () => executeReadMutationClaim({ claim })),
        tracer,
      );
      claimSpan.end("ok");
      processed += 1;
    } catch (error) {
      failed += 1;
      console.error("[ReadMutationSequencer] failed to process mutation", {
        serverId: claim.serverId,
        principalId: claim.principalId,
        mutationId: claim.mutationId,
        error,
      });
      // Same cardinality as the console line above: one bounded event per
      // failed claim, tied to the claim span.
      const errorClass = errorClassOf(error);
      tracer.emitEvent("server.read_mutation_sequencer.error", {
        surface: "server",
        parent: claimSpan.context,
        attrs: {
          outcome: "error",
          reason: "mutation_processing_threw",
          error_class: errorClass,
          server_id: claim.serverId,
          principal_id: claim.principalId,
          mutation_id: claim.mutationId,
        },
      });
      claimSpan.end("error", { attrs: { error_class: errorClass } });
    }
  }
  return { processed, failed };
}

interface ReadMutationWorkerClock {
  scheduleEvery(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const defaultWorkerClock: ReadMutationWorkerClock = {
  scheduleEvery: setClockInterval,
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export function startReadMutationWorker(input: {
  intervalMs?: number;
  leaseMs?: number;
  batchSize?: number;
  compactionIntervalMs?: number;
  compactionBatchSize?: number;
  compactionTimeBudgetMs?: number;
  leaseOwner?: string;
  clock?: ReadMutationWorkerClock;
  /** Used for the drain root span and forwarded to drainReadMutationOutbox. */
  tracer?: Tracer;
} = {}): { stop(): void } {
  const intervalMs = input.intervalMs ?? DEFAULT_WORKER_INTERVAL_MS;
  const compactionIntervalMs = input.compactionIntervalMs ?? DEFAULT_COMPACTION_INTERVAL_MS;
  const clock = input.clock ?? defaultWorkerClock;
  let running = false;
  let compacting = false;
  const runDrain = () => {
    if (running) return;
    running = true;
    const startedAtMs = currentTimeMs();
    const tracer = input.tracer ?? noopTracer;
    const drainSpan = tracer.startSpan("server.read_mutation_sequencer.drain", {
      surface: "server",
      kind: "internal",
    });
    runWithTraceSpan(drainSpan, () => drainReadMutationOutbox(input), tracer)
      .then((result) => {
        drainSpan.end(result.failed > 0 ? "error" : "ok", {
          attrs: { processed_count: result.processed, failed_count: result.failed },
        });
        const outcome = result.failed > 0
          ? "failed"
          : result.processed > 0
            ? "processed"
            : "empty";
        readMutationWorkerDrainsTotal.inc({ outcome });
        readMutationWorkerDrainDuration.observe(
          { outcome },
          Math.max(0, currentTimeMs() - startedAtMs) / 1_000,
        );
      })
      .catch((error) => {
        drainSpan.end("error", { attrs: { error_class: errorClassOf(error) } });
        readMutationWorkerDrainsTotal.inc({ outcome: "error" });
        readMutationWorkerDrainDuration.observe(
          { outcome: "error" },
          Math.max(0, currentTimeMs() - startedAtMs) / 1_000,
        );
        console.error("[ReadMutationSequencer] worker drain failed", error);
      })
      .finally(() => {
        running = false;
      });
  };
  const runCompaction = () => {
    if (compacting) return;
    compacting = true;
    const startedAtMs = currentTimeMs();
    const batchSize = input.compactionBatchSize ?? DEFAULT_COMPACTION_BATCH_SIZE;
    const budgetMs = input.compactionTimeBudgetMs ?? DEFAULT_COMPACTION_TIME_BUDGET_MS;
    const compactUntilShortOrBudget = async (): Promise<{ compacted: number }> => {
      let compacted = 0;
      for (;;) {
        const batch = await withStatementStats(
          "read_mutation.compaction_batch",
          () => compactTerminalReadMutations({ limit: batchSize }),
          ({ compacted: batchCompacted, candidates }) => ({ compacted: batchCompacted, candidates }),
        );
        compacted += batch.compacted;
        // Stop when the expired rows are used up (fewer candidates than a
        // batch) or nothing in the batch could move (all locked by the drain or
        // already taken by another task). A batch that moved some rows but not
        // all (a few principals locked, rows another task compacted first) is
        // no reason to stop: production cycles stopped after 10 s that way.
        if (batch.candidates < batchSize || batch.compacted === 0 || currentTimeMs() - startedAtMs >= budgetMs || stopped) return { compacted };
      }
    };
    compactUntilShortOrBudget()
      .then((result) => {
        if (result.compacted > 0) {
          console.info("[ReadMutationSequencer] compaction cycle", {
            compacted: result.compacted,
            durationMs: currentTimeMs() - startedAtMs,
          });
        }
      })
      .catch((error) => {
        console.error("[ReadMutationSequencer] compaction cycle failed", {
          durationMs: currentTimeMs() - startedAtMs,
          error,
        });
      })
      .finally(() => {
        compacting = false;
      });
  };
  const unrefTimer = (timer: unknown) => {
    if (typeof timer === "object" && timer && "unref" in timer && typeof timer.unref === "function") timer.unref();
  };
  runDrain();
  const drainTimer = clock.scheduleEvery(runDrain, intervalMs);
  unrefTimer(drainTimer);
  let compactionTimer: unknown = null;
  let stopped = false;
  const startCompaction = () => {
    if (stopped) return;
    runCompaction();
    compactionTimer = clock.scheduleEvery(runCompaction, compactionIntervalMs);
    unrefTimer(compactionTimer);
  };
  // Every task starts at deploy time, so without jitter all of them compact in
  // the same minute and queue on the same authority rows as the drain (10-27
  // 18:22 / 23:22). In production each task starts at a random point within the
  // interval; an injected clock (tests) starts at once, as before.
  const compactionJitter = input.clock ? null : setTimeout(startCompaction, Math.floor(Math.random() * compactionIntervalMs));
  if (compactionJitter) unrefTimer(compactionJitter); else startCompaction();
  return {
    stop: () => {
      stopped = true;
      if (compactionJitter) clearTimeout(compactionJitter);
      clock.clearInterval(drainTimer);
      if (compactionTimer !== null) clock.clearInterval(compactionTimer);
    },
  };
}
