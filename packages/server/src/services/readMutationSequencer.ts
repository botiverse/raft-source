import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { and, asc, eq, gt, inArray, isNotNull, lt, lte, or, sql } from "drizzle-orm";
import { currentDate, currentTimeMs, setClockInterval, setClockTimeout } from "@botiverse/raft-shared";

import { getDb, type DatabaseTransaction } from "../db/index.js";
import {
  readMutationWorkerDrainDuration,
  readMutationWorkerDrainsTotal,
} from "../metrics.js";
import {
  agentChannelReadCursors,
  readMutationAuthorities,
  readMutations,
  readMutationTombstones,
  threadFollows,
  userChannelInboxStates,
  userChannelReadCursors,
} from "../db/schema.js";
import { rebuildInboxServingRowsForReceiverTargets } from "./inboxNotificationService.js";
import {
  assertChannelDoneFrontier,
  assertThreadDoneFrontier,
  DoneFrontierBeyondLatestError,
  writeChannelInboxSuppression,
  writeThreadDoneSuppression,
} from "./inboxSuppressionWriters.js";

export const READ_MUTATION_RECOVERY_HORIZON_MS = 90 * 24 * 60 * 60 * 1_000;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_WORKER_INTERVAL_MS = 1_000;
const DEFAULT_WORKER_BATCH_SIZE = 50;
const DEFAULT_COMPACTION_INTERVAL_MS = 60 * 60 * 1_000;
const DEFAULT_COMPACTION_BATCH_SIZE = 100;
export const READ_MUTATION_COMPATIBILITY_WAIT_MS_ENV = "READ_MUTATION_COMPATIBILITY_WAIT_MS";
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ReadMutationKind = "row_read" | "row_unread" | "channel_read_all" | "global_read_all" | "done";
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
  | { kind: "global_read_all" }
  | { kind: "done"; targetKind: DoneTargetKind; scopeId: string; throughSeq: string };

export type ReadMutationAdmissionInput = {
  serverId: string;
  principalKind?: ReadMutationPrincipalKind;
  principalId: string;
  mutationId: string;
  mutation: ReadMutationPayload;
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

type AuthorizedReadMutationScope = {
  scopeId: string;
  storageScopeId: string;
  channelType: "channel" | "private" | "joint" | "dm" | "thread";
  deletedInboxResidue: boolean;
  /**
   * Admitted with no current membership, purely to retire residue they own
   * (task #48). Never a content-access authority -- see the branch that sets it.
   */
  lostAccessResidue?: boolean;
  /**
   * Active thread whose parent authority is unavailable, admitted only to retire
   * receiver-owned residue. Boundary capture must use receiver-owned rows, not
   * the thread source max, or it becomes an activity monitor after deletion.
   */
  unavailableThreadParentResidue?: boolean;
};

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
      SELECT 1 FROM inbox_serving_rows r
      WHERE r.receiver_type = ${receiverType}
        AND r.receiver_id = ${input.principalId}::uuid
        AND r.server_id = ${input.serverId}::uuid
        AND r.source_channel_id = ${accessChannelId}::uuid
    )
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
              FROM inbox_serving_rows stale_row
              WHERE stale_row.receiver_type = ${receiverType}
                AND stale_row.receiver_id = ${input.principalId}::uuid
                AND stale_row.server_id = ${input.serverId}::uuid
                AND stale_row.source_channel_id = c.id
            )
            OR EXISTS (
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
      storageScopeId: local.scopeId,
      channelType: local.channelType,
      deletedInboxResidue: true,
    };
  }

  let storageScopeId = local.scopeId;
  if (local.channelType === "joint" || local.channelType === "thread") {
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
  if (local.channelType === "thread") {
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
            storageScopeId,
            channelType: local.channelType,
            deletedInboxResidue: false,
            unavailableThreadParentResidue: true,
          };
        }
      }
      return null;
    }
    accessChannelId = parentChannel.scopeId;
    accessChannelType = parentChannel.channelType;
  }

  if (accessChannelType !== "channel") {
    const participant = input.principalKind === "human"
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
        `);
    if (participant.rows.length !== 1) {
      // Task #48, usability half. Losing access must not strand the Activity
      // entry a receiver already owns: a removed member, or a participant of a
      // soft-deleted DM, still has rows of their own and no way to retire them.
      //
      // Same relaxation as the deleted-channel branch above, under the same
      // rule: this is NEVER a content-access authority. It is admitted only for
      // channel_read_all, and only on evidence the RECEIVER owns -- rows a
      // stranger cannot manufacture, so nobody can move themselves in here.
      if (input.allowLostAccessResidue !== true) return null;
      const residue = await tx.execute(sql`
        SELECT 1
        WHERE ${lostAccessResidueEvidence(input, accessChannelId)}
      `);
      if (residue.rows.length !== 1) return null;
      return {
        scopeId: local.scopeId,
        storageScopeId,
        channelType: local.channelType,
        deletedInboxResidue: false,
        lostAccessResidue: true,
      };
    }
  }

  return {
    scopeId: local.scopeId,
    storageScopeId,
    channelType: local.channelType,
    deletedInboxResidue: false,
  };
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
  const resolved: AuthorizedReadMutationScope[] = [];
  for (const scopeId of input.scopeIds) {
    const scope = await resolveAuthorizedReadMutationScope(tx, { ...input, scopeId });
    if (scope) resolved.push(scope);
  }
  return resolved;
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
  return getDb().transaction(async (tx) => {
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
      return admissionReceiptFromLive(
        live,
        live.state === "applied" || live.state === "retired_no_effect" ? "ALREADY_TERMINAL" : "ALREADY_ADMITTED",
      );
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
    if (mutation.kind === "done") {
      const actualTargetKind: DoneTargetKind = resolvedScope!.channelType === "thread" ? "thread" : "channel";
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
  return getDb().transaction(async (tx) => {
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
  return getDb().transaction(async (tx) => {
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

async function captureChannelBoundary(
  tx: DatabaseTransaction,
  serverId: string,
  principalKind: ReadMutationPrincipalKind,
  principalId: string,
  scopeId: string,
): Promise<ReadMutationBoundary[] | null> {
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
  if (resolved.deletedInboxResidue || resolved.unavailableThreadParentResidue) {
    const receiverType = principalKind === "human" ? "user" : "agent";
    const deletedCursorBoundary = principalKind === "human"
      ? sql`COALESCE((
          SELECT MAX(stale_cursor.last_read_seq)
          FROM user_channel_read_cursors stale_cursor
          WHERE stale_cursor.user_id = ${principalId}::uuid
            AND stale_cursor.channel_id = ${resolved.scopeId}::uuid
        ), 0)`
      : sql`COALESCE((
          SELECT MAX(stale_cursor.last_read_seq)
          FROM agent_channel_read_cursors stale_cursor
          WHERE stale_cursor.agent_id = ${principalId}::uuid
            AND stale_cursor.channel_id = ${resolved.scopeId}::uuid
        ), 0)`;
    const result = await tx.execute(sql`
      SELECT GREATEST(
        COALESCE((
          SELECT MAX(stale_row.latest_notified_seq)
          FROM inbox_serving_rows stale_row
          WHERE stale_row.receiver_type = ${receiverType}
            AND stale_row.receiver_id = ${principalId}::uuid
            AND stale_row.server_id = ${serverId}::uuid
            AND stale_row.source_channel_id = ${resolved.scopeId}::uuid
        ), 0),
        COALESCE((
          SELECT MAX(stale_fact.message_seq)
          FROM inbox_notification_facts stale_fact
          WHERE stale_fact.receiver_type = ${receiverType}
            AND stale_fact.receiver_id = ${principalId}::uuid
            AND stale_fact.server_id = ${serverId}::uuid
            AND stale_fact.source_channel_id = ${resolved.scopeId}::uuid
        ), 0),
        ${deletedCursorBoundary}
      )::int AS "throughSeq"
    `);
    const [row] = result.rows as Array<{ throughSeq: unknown }>;
    return [{ scopeId: resolved.scopeId, throughSeq: asNumber(row?.throughSeq ?? 0) }];
  }
  const result = await tx.execute(sql`
    SELECT COALESCE(MAX(m.seq), 0)::int AS "throughSeq"
    FROM messages m
    WHERE m.channel_id = ${resolved.storageScopeId}::uuid
  `);
  const [row] = result.rows as Array<{ throughSeq: unknown }>;
  return [{ scopeId: resolved.scopeId, throughSeq: asNumber(row?.throughSeq ?? 0) }];
}

/**
 * Capture a bounded composite Done under the frozen lock order:
 * principal authority -> canonical content row -> Done-state row -> cursor ->
 * suppression. Message admission takes an FK KEY SHARE lock on the canonical
 * channel row, so this FOR UPDATE is the serialization seam for local and
 * joint channel/thread projections alike.
 */
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
  if (!resolved) return { boundary: null, applyBroadDoneMarker: false };

  const actualTargetKind: DoneTargetKind = resolved.channelType === "thread" ? "thread" : "channel";
  if (actualTargetKind !== mutation.doneTargetKind) {
    return { boundary: null, applyBroadDoneMarker: false };
  }

  const lockedContent = await tx.execute(sql`
    SELECT id
    FROM channels
    WHERE id = ${resolved.storageScopeId}::uuid
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
  if (verified.target.sourceChannelId !== resolved.storageScopeId) {
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
  const candidates = principalKind === "human"
    ? await tx.execute(sql`
        SELECT c.id::text AS "scopeId"
        FROM channels c
        LEFT JOIN user_channel_inbox_states inbox
          ON inbox.channel_id = c.id AND inbox.user_id = ${principalId}::uuid
        WHERE c.server_id = ${serverId}::uuid
          AND c.type IN ('channel', 'private', 'joint', 'dm')
          AND c.deleted_at IS NULL
          AND c.archived_at IS NULL
          AND inbox.done_at IS NULL
          AND EXISTS (
            SELECT 1
            FROM channel_humans ch
            WHERE ch.channel_id = c.id
              AND ch.user_id = ${principalId}::uuid
          )
        UNION
        SELECT c.id::text AS "scopeId"
        FROM thread_follows tf
        INNER JOIN channels c
          ON c.id = tf.thread_channel_id
         AND c.server_id = ${serverId}::uuid
         AND c.type = 'thread'
         AND c.deleted_at IS NULL
        WHERE tf.follower_type = 'user'
          AND tf.follower_id = ${principalId}::uuid
          AND tf.done_at IS NULL
          AND tf.unfollowed_at IS NULL
        ORDER BY "scopeId"
      `)
    : await tx.execute(sql`
        SELECT c.id::text AS "scopeId"
        FROM channels c
        INNER JOIN channel_agents ca
          ON ca.channel_id = c.id
         AND ca.agent_id = ${principalId}::uuid
        WHERE c.server_id = ${serverId}::uuid
          AND c.type IN ('channel', 'private', 'joint', 'dm')
          AND c.deleted_at IS NULL
          AND c.archived_at IS NULL
        UNION
        SELECT c.id::text AS "scopeId"
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
  const candidateIds = (candidates.rows as Array<{ scopeId: string }>).map((row) => row.scopeId);
  const resolved = await resolveAuthorizedReadMutationScopes(tx, {
    serverId,
    principalKind,
    principalId,
    scopeIds: candidateIds,
  });
  const boundary: ReadMutationBoundary[] = [];
  for (const scope of resolved) {
    const latest = await tx.execute(sql`
      SELECT COALESCE(MAX(m.seq), 0)::int AS "throughSeq"
      FROM messages m
      WHERE m.channel_id = ${scope.storageScopeId}::uuid
    `);
    const [row] = latest.rows as Array<{ throughSeq: unknown }>;
    const throughSeq = asNumber(row?.throughSeq ?? 0);
    if (throughSeq > 0) boundary.push({ scopeId: scope.scopeId, throughSeq });
  }
  return boundary;
}

async function captureBoundary(
  tx: DatabaseTransaction,
  mutation: typeof readMutations.$inferSelect,
): Promise<ReadMutationBoundary[] | null> {
  if (mutation.kind === "global_read_all") {
    return captureGlobalBoundary(tx, mutation.serverId, mutation.principalType, mutation.principalId);
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
    return (await captureDoneBoundary(tx, mutation)).boundary;
  }
  if (!await resolveAuthorizedReadMutationScope(tx, {
    serverId: mutation.serverId,
    principalKind: mutation.principalType,
    principalId: mutation.principalId,
    scopeId: mutation.scopeId!,
  })) return null;
  return [{ scopeId: mutation.scopeId!, throughSeq: mutation.requestedThroughSeq! }];
}

async function applyScopeBoundary(input: {
  tx: DatabaseTransaction;
  principalKind: ReadMutationPrincipalKind;
  principalId: string;
  authoritySeq: number;
  scopeId: string;
  throughSeq: number | string;
  direction: "forward" | "backward";
  afterCursorLocked?: () => Promise<void>;
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
  // The conflict predicate deliberately derives from the row visible at the
  // write itself, not only from the preceding FOR UPDATE read. That closes the
  // absent-row race with legacy compatibility writers that do not share the
  // sequencer authority lock, while ensuring unchanged scopes perform no
  // UPDATE and therefore cannot advance version/authority metadata.
  const humanUpsert = input.principalKind === "human" && input.direction === "forward"
    ? sql`
        INSERT INTO user_channel_read_cursors (
          user_id, channel_id, last_read_seq, read_state_version, last_applied_authority_seq, updated_at
        ) VALUES (
          ${input.principalId}::uuid, ${input.scopeId}::uuid, ${input.throughSeq}, 1, ${input.authoritySeq}, now()
        )
        ON CONFLICT (user_id, channel_id) DO UPDATE SET
          last_read_seq = EXCLUDED.last_read_seq,
          read_state_version = user_channel_read_cursors.read_state_version + 1,
          last_applied_authority_seq = EXCLUDED.last_applied_authority_seq,
          updated_at = now()
        WHERE EXCLUDED.last_read_seq > user_channel_read_cursors.last_read_seq
        RETURNING last_read_seq AS "lastReadSeq",
                  read_state_version AS "readStateVersion",
                  last_applied_authority_seq AS "lastAppliedAuthoritySeq"
      `
    : input.principalKind === "human"
      ? sql`
        INSERT INTO user_channel_read_cursors (
          user_id, channel_id, last_read_seq, read_state_version, last_applied_authority_seq, updated_at
        ) VALUES (
          ${input.principalId}::uuid, ${input.scopeId}::uuid, ${input.throughSeq}, 1, ${input.authoritySeq}, now()
        )
        ON CONFLICT (user_id, channel_id) DO UPDATE SET
          last_read_seq = EXCLUDED.last_read_seq,
          read_state_version = user_channel_read_cursors.read_state_version + 1,
          last_applied_authority_seq = EXCLUDED.last_applied_authority_seq,
          updated_at = now()
        WHERE EXCLUDED.last_read_seq < user_channel_read_cursors.last_read_seq
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
                  last_applied_authority_seq AS "lastAppliedAuthoritySeq"
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
  }>;
  const changed = Boolean(finalRow);
  if (!finalRow) {
    const current = input.principalKind === "human"
      ? await input.tx.execute(sql`
          SELECT last_read_seq AS "lastReadSeq",
                 read_state_version AS "readStateVersion",
                 last_applied_authority_seq AS "lastAppliedAuthoritySeq"
          FROM user_channel_read_cursors
          WHERE user_id = ${input.principalId}::uuid AND channel_id = ${input.scopeId}::uuid
        `)
      : await input.tx.execute(sql`
          SELECT last_read_seq AS "lastReadSeq",
                 read_state_version AS "readStateVersion",
                 last_applied_authority_seq AS "lastAppliedAuthoritySeq"
          FROM agent_channel_read_cursors
          WHERE agent_id = ${input.principalId}::uuid AND channel_id = ${input.scopeId}::uuid
        `);
    [finalRow] = current.rows as Array<{
      lastReadSeq: unknown;
      readStateVersion: unknown;
      lastAppliedAuthoritySeq: unknown;
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
  };
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

  const ack = await getDb().transaction(async (tx) => {
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
    let applyBroadDoneMarker = false;
    let doneFrontierBeyondLatest = false;
    try {
      if (minimum.kind === "done") {
        const capturedDone = await captureDoneBoundary(tx, minimum);
        captured = capturedDone.boundary;
        applyBroadDoneMarker = capturedDone.applyBroadDoneMarker;
      } else {
        captured = await captureBoundary(tx, minimum);
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
    const scopes: ReadMutationAck["scopes"] = [];
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
      const appliedScope = await applyScopeBoundary({
        tx,
        principalKind: minimum.principalType,
        principalId: minimum.principalId,
        authoritySeq: minimum.authoritySeq,
        scopeId: capturedScope.scopeId,
        throughSeq: capturedScope.throughSeq,
        direction: minimum.kind === "row_unread" ? "backward" : "forward",
        afterCursorLocked: input.afterScopeCursorLocked
          ? () => input.afterScopeCursorLocked!({ scopeId: capturedScope.scopeId, index })
          : undefined,
      });
      scopes.push(appliedScope);
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

    const rebuildScopes = minimum.kind === "done"
      ? scopes
      : scopes.filter((scope) => scope.changed);
    await rebuildInboxServingRowsForReceiverTargets(rebuildScopes.map((scope) => ({
      receiverType: minimum.principalType === "human" ? "user" as const : "agent" as const,
      receiverId: minimum.principalId,
      sourceChannelId: scope.scopeId,
    })), tx);

    if (input.failpoint === "after_sql_before_commit") {
      throw new ReadMutationFailpointError(input.failpoint);
    }

    const anyCursorChanged = scopes.some((scope) => scope.changed);
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
    const [terminalized] = await tx.update(readMutations).set({
      state: terminalState,
      capturedBoundary: boundary,
      ack: completeAck,
      terminalReason,
      terminalDigest,
      leaseExpiresAt: null,
      terminalAt: now,
      updatedAt: now,
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
  return getDb().transaction(async (tx) => {
    const resolved = await resolveAuthorizedReadMutationScope(tx, { ...input, principalKind });
    if (!resolved) throw new ReadMutationError("SCOPE_NOT_FOUND", "read mutation scope does not exist in this server");
    const result = await tx.execute(sql`
      SELECT COALESCE(MAX(m.seq), 0)::int AS "latestUnreadEligibleSeq"
      FROM messages m
      WHERE m.channel_id = ${resolved.storageScopeId}::uuid
        AND NOT (
          m.sender_type = ${principalKind === "human" ? "user" : "agent"}
          AND m.sender_id = ${input.principalId}
        )
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
}): Promise<ReadMutationAck> {
  const principalKind = input.principalKind ?? "human";
  const mutationId = randomUUID();
  const admission = await admitReadMutation({
    serverId: input.serverId,
    principalKind,
    principalId: input.principalId,
    mutationId,
    mutation: input.mutation,
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
        return row.ack as unknown as ReadMutationAck;
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
        errorClass: error instanceof Error ? error.name : typeof error,
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

export async function compactTerminalReadMutations(input: {
  before?: Date;
  limit?: number;
} = {}): Promise<{ compacted: number }> {
  const limit = Math.max(1, Math.min(input.limit ?? 100, 1_000));
  const retentionPredicate = input.before
    ? lt(readMutations.terminalAt, input.before)
    : sql`${readMutations.terminalAt} < now() - interval '90 days'`;
  const candidates = await getDb().select({
    serverId: readMutations.serverId,
    principalKind: readMutations.principalType,
    principalId: readMutations.principalId,
    mutationId: readMutations.mutationId,
  }).from(readMutations).where(and(
    inArray(readMutations.state, ["applied", "retired_no_effect"]),
    isNotNull(readMutations.terminalAt),
    retentionPredicate,
  )).orderBy(asc(readMutations.terminalAt)).limit(limit);

  let compacted = 0;
  for (const candidate of candidates) {
    const moved = await getDb().transaction(async (tx) => {
      await lockAuthority(tx, candidate.serverId, candidate.principalKind, candidate.principalId);
      const [live] = await tx.select().from(readMutations).where(and(
        eq(readMutations.serverId, candidate.serverId),
        eq(readMutations.principalType, candidate.principalKind),
        eq(readMutations.principalId, candidate.principalId),
        eq(readMutations.mutationId, candidate.mutationId),
        inArray(readMutations.state, ["applied", "retired_no_effect"]),
        isNotNull(readMutations.terminalDigest),
      )).limit(1);
      if (!live || !live.terminalDigest || !live.terminalReason || !live.terminalAt) return false;
      if (input.before && live.terminalAt >= input.before) return false;
      if (!input.before) {
        const eligible = await tx.execute(sql`SELECT ${live.terminalAt}::timestamptz < now() - interval '90 days' AS eligible`);
        if (!(eligible.rows[0] as { eligible?: boolean } | undefined)?.eligible) return false;
      }

      await tx.insert(readMutationTombstones).values({
        serverId: live.serverId,
        principalType: live.principalType,
        principalId: live.principalId,
        mutationId: live.mutationId,
        payloadHash: live.payloadHash,
        originalAuthoritySeq: live.authoritySeq,
        terminalState: live.state as ReadMutationTerminalState,
        terminalReason: live.terminalReason as ReadMutationTerminalReason,
        terminalDigest: live.terminalDigest,
      }).onConflictDoNothing({
        target: [
          readMutationTombstones.serverId,
          readMutationTombstones.principalType,
          readMutationTombstones.principalId,
          readMutationTombstones.mutationId,
        ],
      });
      const [tombstone] = await tx.select().from(readMutationTombstones).where(and(
        eq(readMutationTombstones.serverId, live.serverId),
        eq(readMutationTombstones.principalType, live.principalType),
        eq(readMutationTombstones.principalId, live.principalId),
        eq(readMutationTombstones.mutationId, live.mutationId),
      )).limit(1);
      if (
        !tombstone
        || tombstone.payloadHash !== live.payloadHash
        || tombstone.originalAuthoritySeq !== live.authoritySeq
        || tombstone.terminalState !== live.state
        || tombstone.terminalReason !== live.terminalReason
        || tombstone.terminalDigest !== live.terminalDigest
      ) {
        throw new Error("read mutation tombstone conflict does not match the live terminal identity");
      }
      const deleted = await tx.delete(readMutations).where(and(
        eq(readMutations.serverId, live.serverId),
        eq(readMutations.principalType, live.principalType),
        eq(readMutations.principalId, live.principalId),
        eq(readMutations.mutationId, live.mutationId),
        eq(readMutations.authoritySeq, live.authoritySeq),
        eq(readMutations.state, live.state),
        eq(readMutations.terminalDigest, live.terminalDigest),
      )).returning({ mutationId: readMutations.mutationId });
      return deleted.length === 1;
    });
    if (moved) compacted += 1;
  }
  return { compacted };
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
  return getDb().transaction(async (tx) => {
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
    try {
      await executeReadMutationClaim({ claim });
      processed += 1;
    } catch (error) {
      failed += 1;
      console.error("[ReadMutationSequencer] failed to process mutation", {
        serverId: claim.serverId,
        principalId: claim.principalId,
        mutationId: claim.mutationId,
        error,
      });
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
  leaseOwner?: string;
  clock?: ReadMutationWorkerClock;
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
    drainReadMutationOutbox(input)
      .then((result) => {
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
    compactTerminalReadMutations({ limit: input.compactionBatchSize ?? DEFAULT_COMPACTION_BATCH_SIZE })
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
  runDrain();
  runCompaction();
  const drainTimer = clock.scheduleEvery(runDrain, intervalMs);
  const compactionTimer = clock.scheduleEvery(runCompaction, compactionIntervalMs);
  for (const timer of [drainTimer, compactionTimer]) {
    if (typeof timer === "object" && timer && "unref" in timer && typeof timer.unref === "function") timer.unref();
  }
  return {
    stop: () => {
      clock.clearInterval(drainTimer);
      clock.clearInterval(compactionTimer);
    },
  };
}
