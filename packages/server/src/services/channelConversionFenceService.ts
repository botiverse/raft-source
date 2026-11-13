import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getDb, isDatabaseInitialized, type DatabaseExecutor, type DatabaseTransaction } from "../db/index";
import {
  channels,
  channelConversionFences,
  channelConversionJobs,
  channelConversionPhaseLedger,
  jointChannels,
  jointChannelServers,
  messages,
} from "../db/schema";
import {
  lockServerResourceInTransaction,
  probeServerResourceLockFree,
  setBeforeServerResourceLockQueryForTest,
  setServerResourceLockProbeForTest,
  tryLockServerResourceInTransaction,
  withServerResourceLock,
} from "./planService";

type LockMode = "exclusive" | "shared";

type ChannelConversionLockProbeForTest = {
  serverId: string;
  sourceChannelId: string;
  onArrival: (mode: LockMode) => Promise<void> | void;
  onRequested: (mode: LockMode) => Promise<void> | void;
  onAcquired: (mode: LockMode) => Promise<void> | void;
  beforeQuery?: () => Promise<void> | void;
};

type ChannelWriterFenceTestAdapter = <T>(
  channelId: string,
  fn: (tx: DatabaseTransaction) => Promise<T>,
) => Promise<T>;
type ChannelWriterFenceTransactionTestAdapter = (
  tx: DatabaseExecutor,
  channelId: string,
) => Promise<void> | void;

let channelWriterFenceTestAdapter: ChannelWriterFenceTestAdapter | null = null;
let channelWriterFenceTransactionTestAdapter: ChannelWriterFenceTransactionTestAdapter | null = null;

/**
 * Explicit seam for dependency-injected message-pipeline tests that do not
 * boot a persistence database. Production code never installs this adapter;
 * fail-closed guards below remain authoritative whenever it is absent.
 */
export function __setChannelWriterFenceTestAdapterForTests(
  adapter: ChannelWriterFenceTestAdapter | null,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("channel writer fence adapters are test-only");
  }
  channelWriterFenceTestAdapter = adapter;
}

/** Explicit seam for transaction doubles that cannot issue SQL. */
export function __setChannelWriterFenceTransactionTestAdapterForTests(
  adapter: ChannelWriterFenceTransactionTestAdapter | null,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("channel writer fence adapters are test-only");
  }
  channelWriterFenceTransactionTestAdapter = adapter;
}

export function setChannelConversionLockProbeForTest(
  probe: ChannelConversionLockProbeForTest | null,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("channel conversion lock hooks are test-only");
  }
  setServerResourceLockProbeForTest(probe ? (event) => {
    if (event.namespace !== CHANNEL_CONVERSION_LOCK_NAMESPACE
      || event.serverId !== probe.serverId
      || event.resourceKey !== probe.sourceChannelId) {
      return;
    }
    if (event.phase === "arrival") return probe.onArrival(event.mode);
    if (event.phase === "requested") return probe.onRequested(event.mode);
    if (event.phase === "acquired") return probe.onAcquired(event.mode);
  } : null);
  setBeforeServerResourceLockQueryForTest(probe?.beforeQuery ? (event) => {
    if (event.namespace !== CHANNEL_CONVERSION_LOCK_NAMESPACE
      || event.serverId !== probe.serverId
      || event.resourceKey !== probe.sourceChannelId) {
      return;
    }
    return probe.beforeQuery?.();
  } : null);
}

/**
 * Advisory-lock namespace for conversion and every guarded source writer.
 * Conversion takes it exclusively; writers take it shared, so writers (and the
 * push drain) never serialize against each other, only against conversion.
 */
export const CHANNEL_CONVERSION_LOCK_NAMESPACE = 136;

/**
 * Action-card paths serialize among themselves per source channel. Taken
 * exclusively, always after the shared conversion lock; see lockActionCardScope.
 */
export const ACTION_CARD_SOURCE_LOCK_NAMESPACE = 138;

export class ChannelConversionInProgressError extends Error {
  readonly code = "channel_conversion_in_progress" as const;
  readonly status = 409 as const;

  constructor(
    public readonly sourceChannelId: string,
    public readonly conversionEpoch: string,
  ) {
    super("Channel conversion is in progress; this write must be retried after conversion completes.");
    this.name = "ChannelConversionInProgressError";
  }
}

export class ChannelConversionFenceConflictError extends Error {
  readonly code = "channel_conversion_fence_conflict" as const;

  constructor(
    public readonly sourceChannelId: string,
    public readonly jobId: string,
    public readonly expectedEpoch: string,
    public readonly retainedEpoch: string,
  ) {
    super("Retained channel conversion fence does not match the requested job authority.");
    this.name = "ChannelConversionFenceConflictError";
  }
}

export class ChannelConversionLedgerConflictError extends Error {
  readonly code = "channel_conversion_ledger_conflict" as const;

  constructor(
    public readonly jobId: string,
    public readonly conversionEpoch: string,
    public readonly idempotencyKey: string,
  ) {
    super("Conversion phase ledger idempotency key was reused with different evidence.");
    this.name = "ChannelConversionLedgerConflictError";
  }
}

export type ConversionFenceState = {
  jobId: string;
  serverId: string;
  sourceChannelId: string;
  conversionEpoch: string;
  status: "active" | "released";
};

export async function resolveChannelConversionLockTarget(
  executor: DatabaseExecutor,
  channelId: string,
): Promise<{ serverId: string; sourceChannelId: string } | null> {
  if (typeof (executor as { execute?: unknown }).execute !== "function") {
    throw new Error("channel conversion writer fence requires executable transaction");
  }
  const result = await executor.execute(sql`
    WITH input_channel AS (
      SELECT id, server_id, type, parent_message_id, parent_channel_id
        FROM channels
       WHERE id = ${channelId}
         AND deleted_at IS NULL
    ), parent_scope AS (
      SELECT parent_message.channel_id
        FROM input_channel
        JOIN messages parent_message ON parent_message.id = input_channel.parent_message_id
       WHERE input_channel.type = 'thread'
    ), thread_projection_scope AS (
      SELECT parent_message.channel_id
        FROM input_channel
        JOIN ${jointChannelServers} thread_projection
          ON thread_projection.local_channel_id = input_channel.id
         AND thread_projection.status = 'active'
        JOIN ${jointChannels} joint_thread
          ON joint_thread.id = thread_projection.joint_channel_id
         AND joint_thread.status = 'active'
        JOIN ${channels} canonical_thread
          ON canonical_thread.id = joint_thread.canonical_channel_id
         AND canonical_thread.type = 'thread'
        JOIN ${messages} parent_message
          ON parent_message.id = canonical_thread.parent_message_id
       WHERE input_channel.type = 'thread'
    ), task_conversation_scope AS (
      -- Task v2: a task conversation (canonical or a joint local projection)
      -- names its parent channel on the row; it is fenced with that channel,
      -- as a thread is with its parent message's channel.
      SELECT input_channel.parent_channel_id AS channel_id
        FROM input_channel
       WHERE input_channel.type = 'task'
         AND input_channel.parent_channel_id IS NOT NULL
    ), active_job AS (
      SELECT job.server_id, job.source_channel_id
        FROM channel_conversion_jobs job
       WHERE job.status IN ('pending', 'running', 'failed')
         AND (
           job.source_channel_id = ${channelId}
           OR job.canonical_channel_id = ${channelId}
           OR job.source_channel_id IN (SELECT channel_id FROM parent_scope)
           OR job.canonical_channel_id IN (SELECT channel_id FROM parent_scope)
           OR job.source_channel_id IN (SELECT channel_id FROM thread_projection_scope)
           OR job.canonical_channel_id IN (SELECT channel_id FROM thread_projection_scope)
           OR job.source_channel_id IN (SELECT channel_id FROM task_conversation_scope)
           OR job.canonical_channel_id IN (SELECT channel_id FROM task_conversation_scope)
         )
       ORDER BY job.created_at DESC
       LIMIT 1
    )
    SELECT
      COALESCE(active_job.server_id, input_channel.server_id)::text AS "serverId",
      COALESCE(
        active_job.source_channel_id,
        (SELECT channel_id FROM parent_scope LIMIT 1),
        (SELECT channel_id FROM task_conversation_scope LIMIT 1),
        input_channel.id
      )::text AS "sourceChannelId"
      FROM input_channel
      LEFT JOIN active_job ON true
     LIMIT 1
  `);
  const row = result.rows[0] as { serverId?: unknown; sourceChannelId?: unknown } | undefined;
  return typeof row?.serverId === "string" && typeof row.sourceChannelId === "string"
    ? { serverId: row.serverId, sourceChannelId: row.sourceChannelId }
    : null;
}

/** Read the durable fence from an existing transaction. */
export async function getActiveChannelConversionFence(
  executor: DatabaseExecutor,
  sourceChannelId: string,
): Promise<ConversionFenceState | null> {
  const [fence] = await executor
    .select({
      jobId: channelConversionFences.jobId,
      serverId: channelConversionFences.serverId,
      sourceChannelId: channelConversionFences.sourceChannelId,
      conversionEpoch: channelConversionFences.conversionEpoch,
      status: channelConversionFences.status,
    })
    .from(channelConversionFences)
    .where(and(
      eq(channelConversionFences.sourceChannelId, sourceChannelId),
      eq(channelConversionFences.status, "active"),
    ))
    .limit(1);
  return fence ?? null;
}

/** Throws the typed writer-fence error when a source is actively converting. */
export async function assertChannelConversionWritable(
  sourceChannelId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<void> {
  const fence = await getActiveChannelConversionFence(executor, sourceChannelId);
  if (fence) throw new ChannelConversionInProgressError(sourceChannelId, fence.conversionEpoch);
  const [activeJob] = await executor
    .select({ conversionEpoch: channelConversionJobs.conversionEpoch, progress: channelConversionJobs.progress })
    .from(channelConversionJobs)
    .where(and(
      eq(channelConversionJobs.sourceChannelId, sourceChannelId),
      sql`${channelConversionJobs.status} IN ('pending', 'running', 'failed')`,
    ))
    .limit(1);
  const progress = activeJob?.progress;
  const rolledBack = progress && typeof progress === "object" && !Array.isArray(progress)
    && (progress as Record<string, unknown>).rollbackState === "restored";
  if (activeJob && !rolledBack) throw new ChannelConversionInProgressError(sourceChannelId, activeJob.conversionEpoch);
}

/**
 * Conversion side of the lock: exclusive. Used by conversion start, retry,
 * cancel, phases, and cleanup. Writers use the shared form instead.
 */
export async function withChannelConversionResourceLock<T>(
  serverId: string,
  sourceChannelId: string,
  fn: (tx: DatabaseTransaction) => Promise<T>,
  transaction?: DatabaseTransaction,
): Promise<T> {
  if (transaction) {
    await lockChannelConversionResourceInTransaction(transaction, serverId, sourceChannelId);
    return fn(transaction);
  }
  return withServerResourceLock(serverId, CHANNEL_CONVERSION_LOCK_NAMESPACE, sourceChannelId, fn);
}

/**
 * The conversion worker's form of the lock: the same exclusive key, without
 * waiting. Not acquired (another replica's phase, or a start, retry or cancel,
 * holds it): `{ acquired: false }`, and `fn` does not run. Every replica runs
 * the worker on the same jobs; a blocking lock here parked one pooled
 * connection per replica behind a phase for its whole length (1.23.0).
 */
export async function withChannelConversionResourceTryLock<T>(
  serverId: string,
  sourceChannelId: string,
  fn: (tx: DatabaseTransaction) => Promise<T>,
  transaction?: DatabaseTransaction,
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const run = async (tx: DatabaseTransaction): Promise<{ acquired: true; value: T } | { acquired: false }> => {
    if (!await tryLockServerResourceInTransaction(tx, serverId, CHANNEL_CONVERSION_LOCK_NAMESPACE, sourceChannelId)) {
      return { acquired: false };
    }
    return { acquired: true, value: await fn(tx) };
  };
  return transaction ? run(transaction) : getDb().transaction(run);
}

/**
 * The conversion worker's check before it opens a phase's transaction: is the
 * conversion lock free right now? Held (a phase is running elsewhere): the
 * pass is busy without reading the channel's people, locking their users rows
 * or opening a transaction. Free: the phase goes on as before (users rows,
 * then withChannelConversionResourceTryLock, which decides). Holds nothing.
 */
export function probeChannelConversionResourceLockFree(serverId: string, sourceChannelId: string): Promise<boolean> {
  return probeServerResourceLockFree(serverId, CHANNEL_CONVERSION_LOCK_NAMESPACE, sourceChannelId);
}

/**
 * How long a request (start, retry, cancel, a connect's reservation) or a
 * phase's failure record waits for the conversion lock. A phase holds it for
 * its whole transaction (seconds, up to tens of seconds on a big channel);
 * past this the caller is told the conversion is busy instead of holding a
 * pooled connection for the rest of the phase.
 */
export const CHANNEL_CONVERSION_LOCK_WAIT_TIMEOUT = "2s";

function isLockNotAvailable(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    if ((current as { code?: unknown }).code === "55P03") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * lockChannelConversionResourceInTransaction, waiting at most
 * CHANNEL_CONVERSION_LOCK_WAIT_TIMEOUT: past it, throws `onTimeout()` (the
 * caller's "conversion in progress" refusal). The transaction's own
 * lock_timeout is put back once the lock is held, so later statements wait as
 * they did. The failed statement aborts the transaction (or the caller's
 * savepoint), which also drops the SET LOCAL.
 */
export async function lockChannelConversionResourceBoundedInTransaction(
  tx: DatabaseExecutor,
  serverId: string,
  sourceChannelId: string,
  onTimeout: (cause: unknown) => Error,
): Promise<void> {
  const previous = await tx.execute(sql`SELECT current_setting('lock_timeout') AS previous`);
  await tx.execute(sql`SELECT set_config('lock_timeout', ${CHANNEL_CONVERSION_LOCK_WAIT_TIMEOUT}, true)`);
  try {
    await lockChannelConversionResourceInTransaction(tx, serverId, sourceChannelId);
  } catch (error) {
    if (isLockNotAvailable(error)) throw onTimeout(error);
    throw error;
  }
  const restore = (previous.rows[0] as { previous?: unknown } | undefined)?.previous;
  await tx.execute(sql`SELECT set_config('lock_timeout', ${typeof restore === "string" ? restore : "0"}, true)`);
}

/** withChannelConversionResourceLock with lockChannelConversionResourceBoundedInTransaction's wait. */
export async function withChannelConversionResourceBoundedLock<T>(
  serverId: string,
  sourceChannelId: string,
  onTimeout: (cause: unknown) => Error,
  fn: (tx: DatabaseTransaction) => Promise<T>,
  transaction?: DatabaseTransaction,
): Promise<T> {
  const run = async (tx: DatabaseTransaction): Promise<T> => {
    await lockChannelConversionResourceBoundedInTransaction(tx, serverId, sourceChannelId, onTimeout);
    return fn(tx);
  };
  return transaction ? run(transaction) : getDb().transaction(run);
}

/**
 * Acquire the canonical conversion resource lock inside a transaction that is
 * already owned by a writer. Keeping this call behind the same helper name
 * makes the lock lineage auditable: no transactional writer may reconstruct
 * the namespace or resource identity at its call site.
 */
export async function lockChannelConversionResourceInTransaction(
  tx: DatabaseExecutor,
  serverId: string,
  sourceChannelId: string,
): Promise<void> {
  await lockServerResourceInTransaction(
    tx,
    serverId,
    CHANNEL_CONVERSION_LOCK_NAMESPACE,
    sourceChannelId,
  );
}

/**
 * Writer side of the conversion lock: the shared form of the same key. Shared
 * holders do not block each other; conversion's exclusive hold blocks them and
 * waits for them. Every writer entry point uses this, never the exclusive form:
 * a transaction that took the key shared and later asked for it exclusively
 * would deadlock against a second such transaction.
 */
export async function lockChannelConversionResourceSharedInTransaction(
  tx: DatabaseExecutor,
  serverId: string,
  sourceChannelId: string,
): Promise<void> {
  await lockServerResourceInTransaction(
    tx,
    serverId,
    CHANNEL_CONVERSION_LOCK_NAMESPACE,
    sourceChannelId,
    "shared",
  );
}

/**
 * The one entry point for action-card source locking. Takes the shared
 * conversion lock first, then the exclusive action-card lock on the same
 * source, so card paths still serialize with each other and with conversion
 * while ordinary writers pass freely. Callers must not take either lock
 * themselves: the fixed order is what keeps these two locks cycle-free.
 */
export async function lockActionCardScope(
  tx: DatabaseExecutor,
  serverId: string,
  sourceChannelId: string,
): Promise<void> {
  await lockChannelConversionResourceSharedInTransaction(tx, serverId, sourceChannelId);
  await lockServerResourceInTransaction(
    tx,
    serverId,
    ACTION_CARD_SOURCE_LOCK_NAMESPACE,
    sourceChannelId,
  );
}

export async function withChannelWriterFence<T>(
  channelId: string,
  fn: (tx: DatabaseTransaction) => Promise<T>,
): Promise<T> {
  // Dependency-injected tests may install the explicit adapter above. The
  // production writer path is always initialized before it can reach this
  // helper; without the adapter this branch fails closed.
  if (!isDatabaseInitialized()) {
    if (channelWriterFenceTestAdapter) return channelWriterFenceTestAdapter(channelId, fn);
    throw new Error("channel conversion writer fence requires initialized database");
  }
  // Channel identifiers are UUIDs in the persisted schema. Symbolic IDs are
  // accepted only through the explicit test adapter and never reach SQL.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(channelId)) {
    if (channelWriterFenceTestAdapter) return channelWriterFenceTestAdapter(channelId, fn);
    throw new Error("channel conversion writer fence requires persisted channel id");
  }
  const target = await resolveChannelConversionLockTarget(getDb(), channelId);
  if (!target) return getDb().transaction(fn);
  // An already-published fence rejects immediately, without waiting behind
  // a copy batch or a provider call that owns the source lock.
  await assertChannelConversionWritable(target.sourceChannelId);
  return getDb().transaction(async (tx) => {
    await lockChannelConversionResourceSharedInTransaction(tx, target.serverId, target.sourceChannelId);
    const fresh = await resolveChannelConversionLockTarget(tx, channelId);
    if (!fresh || fresh.serverId !== target.serverId || fresh.sourceChannelId !== target.sourceChannelId) {
      throw new Error("channel conversion lock target changed while acquiring writer lock");
    }
    await assertChannelConversionWritable(target.sourceChannelId, tx);
    return fn(tx);
  });
}

/** Guard a writer that already owns its broader transaction. */
export async function assertChannelWritableInTransaction(
  tx: DatabaseExecutor,
  channelId: string,
): Promise<void> {
  if (channelWriterFenceTransactionTestAdapter) {
    await channelWriterFenceTransactionTestAdapter(tx, channelId);
    return;
  }
  const target = await resolveChannelConversionLockTarget(tx, channelId);
  if (!target) return;
  await assertChannelConversionWritable(target.sourceChannelId, tx);
  await lockChannelConversionResourceSharedInTransaction(tx, target.serverId, target.sourceChannelId);
  const fresh = await resolveChannelConversionLockTarget(tx, channelId);
  if (!fresh || fresh.serverId !== target.serverId || fresh.sourceChannelId !== target.sourceChannelId) {
    throw new Error("channel conversion lock target changed while acquiring writer lock");
  }
  await assertChannelConversionWritable(target.sourceChannelId, tx);
}

/**
 * Terminal upload cleanup is the one writer allowed to run after prepare has
 * failed closed on an in-flight upload. It must still carry the exact retained
 * job/epoch and resource identity; every ordinary publish/create/link writer
 * remains blocked by the normal fence assertion.
 */
export async function assertChannelWritableOrConversionDrainInTransaction(
  tx: DatabaseExecutor,
  channelId: string,
  resource: Readonly<{
    kind: "session" | "transfer_intent" | "reservation";
    id: string;
  }>,
): Promise<void> {
  const target = await resolveChannelConversionLockTarget(tx, channelId);
  if (!target) return;
  await lockChannelConversionResourceSharedInTransaction(tx, target.serverId, target.sourceChannelId);
  const fresh = await resolveChannelConversionLockTarget(tx, channelId);
  if (!fresh || fresh.serverId !== target.serverId || fresh.sourceChannelId !== target.sourceChannelId) {
    throw new Error("channel conversion lock target changed while acquiring writer lock");
  }
  const fence = await getActiveChannelConversionFence(tx, target.sourceChannelId);
  if (!fence) {
    await assertChannelConversionWritable(target.sourceChannelId, tx);
    return;
  }
  if (fence.serverId !== target.serverId) {
    throw new ChannelConversionInProgressError(target.sourceChannelId, fence.conversionEpoch);
  }

  const [job] = await tx
    .select({ id: channelConversionJobs.id, serverId: channelConversionJobs.serverId, conversionEpoch: channelConversionJobs.conversionEpoch, status: channelConversionJobs.status, progress: channelConversionJobs.progress })
    .from(channelConversionJobs)
    .where(and(
      eq(channelConversionJobs.id, fence.jobId),
      eq(channelConversionJobs.serverId, target.serverId),
      eq(channelConversionJobs.sourceChannelId, target.sourceChannelId),
      eq(channelConversionJobs.status, "failed"),
    ))
    .limit(1);
  const progress = job?.progress && typeof job.progress === "object" && !Array.isArray(job.progress)
    ? job.progress as Record<string, unknown>
    : null;
  const scope = progress?.uploadScope && typeof progress.uploadScope === "object" && !Array.isArray(progress.uploadScope)
    ? progress.uploadScope as Record<string, unknown>
    : null;
  const scopeKey = resource.kind === "session"
    ? "sessionIds"
    : resource.kind === "transfer_intent"
      ? "transferIntentIds"
      : "reservationIds";
  const resourceIds = Array.isArray(scope?.[scopeKey]) ? scope[scopeKey].map(String) : [];
  if (
    job
    && job.serverId === fence.serverId
    && job.conversionEpoch === fence.conversionEpoch
    && progress?.errorCode === "channel_conversion_uploads_in_flight"
    && resourceIds.includes(resource.id)
  ) return;

  throw new ChannelConversionInProgressError(target.sourceChannelId, fence.conversionEpoch);
}

/** Acquire the durable fence after the job row has been inserted. */
export async function acquireChannelConversionFence(
  tx: DatabaseExecutor,
  input: {
    jobId: string;
    serverId: string;
    sourceChannelId: string;
    conversionEpoch: string;
  },
): Promise<ConversionFenceState> {
  const existing = await getActiveChannelConversionFence(tx, input.sourceChannelId);
  if (existing) {
    assertRetainedFenceMatches(input, existing);
    return existing;
  }

  const [fence] = await tx
    .insert(channelConversionFences)
    .values({
      jobId: input.jobId,
      serverId: input.serverId,
      sourceChannelId: input.sourceChannelId,
      conversionEpoch: input.conversionEpoch,
      status: "active",
    })
    .returning({
      jobId: channelConversionFences.jobId,
      serverId: channelConversionFences.serverId,
      sourceChannelId: channelConversionFences.sourceChannelId,
      conversionEpoch: channelConversionFences.conversionEpoch,
      status: channelConversionFences.status,
    });
  if (fence) {
    assertRetainedFenceMatches(input, fence);
    return fence;
  }
  throw new Error("conversion fence insert did not produce a retained fence under the source lock");
}

function assertRetainedFenceMatches(
  input: {
    jobId: string;
    serverId: string;
    sourceChannelId: string;
    conversionEpoch: string;
  },
  retained: ConversionFenceState,
): void {
  if (
    retained.jobId === input.jobId
    && retained.serverId === input.serverId
    && retained.sourceChannelId === input.sourceChannelId
    && retained.conversionEpoch === input.conversionEpoch
    && retained.status === "active"
  ) return;
  if (retained.jobId !== input.jobId) {
    throw new ChannelConversionInProgressError(input.sourceChannelId, retained.conversionEpoch);
  }
  throw new ChannelConversionFenceConflictError(
    input.sourceChannelId,
    input.jobId,
    input.conversionEpoch,
    retained.conversionEpoch,
  );
}

export async function releaseChannelConversionFence(
  tx: DatabaseExecutor,
  jobId: string,
  reason: string,
): Promise<void> {
  await tx
    .update(channelConversionFences)
    .set({ status: "released", reason, releasedAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(channelConversionFences.jobId, jobId),
      eq(channelConversionFences.status, "active"),
    ));
}

export async function recordConversionPhaseCommit(
  tx: DatabaseExecutor,
  input: {
    jobId: string;
    conversionEpoch: string;
    phase: string;
    batchKey?: string;
    sourceCount?: number;
    targetCount?: number;
    checksumInput?: string;
  },
): Promise<void> {
  const batchKey = input.batchKey ?? "all";
  const idempotencyKey = `${input.conversionEpoch}:${input.phase}:${batchKey}`;
  const checksum = createHash("sha256")
    .update(input.checksumInput ?? `${input.phase}:${batchKey}:${input.sourceCount ?? 0}:${input.targetCount ?? 0}`)
    .digest("hex");
  const [inserted] = await tx
    .insert(channelConversionPhaseLedger)
    .values({
      jobId: input.jobId,
      conversionEpoch: input.conversionEpoch,
      phase: input.phase,
      batchKey,
      idempotencyKey,
      status: "committed",
      sourceCount: input.sourceCount ?? 0,
      targetCount: input.targetCount ?? 0,
      checksum,
    })
    .onConflictDoNothing({
      target: [
        channelConversionPhaseLedger.jobId,
        channelConversionPhaseLedger.conversionEpoch,
        channelConversionPhaseLedger.idempotencyKey,
      ],
    })
    .returning({ id: channelConversionPhaseLedger.id });
  if (inserted) return;

  const [retained] = await tx
    .select({
      phase: channelConversionPhaseLedger.phase,
      batchKey: channelConversionPhaseLedger.batchKey,
      status: channelConversionPhaseLedger.status,
      sourceCount: channelConversionPhaseLedger.sourceCount,
      targetCount: channelConversionPhaseLedger.targetCount,
      checksum: channelConversionPhaseLedger.checksum,
    })
    .from(channelConversionPhaseLedger)
    .where(and(
      eq(channelConversionPhaseLedger.jobId, input.jobId),
      eq(channelConversionPhaseLedger.conversionEpoch, input.conversionEpoch),
      eq(channelConversionPhaseLedger.idempotencyKey, idempotencyKey),
    ))
    .limit(1);
  if (
    !retained
    || retained.phase !== input.phase
    || retained.batchKey !== batchKey
    || retained.status !== "committed"
    || retained.sourceCount !== (input.sourceCount ?? 0)
    || retained.targetCount !== (input.targetCount ?? 0)
    || retained.checksum !== checksum
  ) {
    throw new ChannelConversionLedgerConflictError(input.jobId, input.conversionEpoch, idempotencyKey);
  }
}

/** Ensure stale compatibility archive state cannot bypass a live fence. */
export async function assertChannelConversionSourceFence(
  executor: DatabaseExecutor,
  sourceChannelId: string,
): Promise<void> {
  await assertChannelConversionWritable(sourceChannelId, executor);
  const [source] = await executor
    .select({ id: channels.id })
    .from(channels)
    .where(eq(channels.id, sourceChannelId))
    .limit(1);
  if (!source) throw new Error("source channel missing");
}
