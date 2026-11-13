#!/usr/bin/env -S node --import=@oxc-node/core/register
// Offline, bounded operations. Never imported by the serving path. Only bounded
// retries (lock/statement timeouts; replica conflicts and connection loss for
// read-only work only); no flag changes, provenance repair, deletion or migrations.
// The one-time CH -> J fill (inventory/compare/apply) is retired with
// joint_human_membership_v1: computed membership is the only mode. What is
// left are the source tools (source-preview, source-verify, source recovery).
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql, type SQL } from "drizzle-orm";
import { asServerId, type Brand, type ServerId } from "@botiverse/raft-shared";
import type { Database, DatabaseExecutor } from "../src/db";
import * as schema from "../src/db/schema";
import {
  acquireJointSourceExitFlagReadLock,
  jointMembershipRemovalPendingSql,
  jointHumanCurrentSourceSql,
} from "../src/services/jointHumanMembershipAccess";
import { lockJointHumanAdmissionSource } from "../src/services/jointHumanMembershipMirror";

/** The retired rollout flag of computed joint membership. Read here only as
 * history (when a host's CH rows predate its computed mode: computed_pre_flag_ch);
 * it authorizes nothing and nothing serves from it. */
const RETIRED_JOINT_HUMAN_MEMBERSHIP_FLAG_KEY = "joint_human_membership_v1";

export type JointOpsPhase = "transaction" | "transaction_setup" | "replica_guard" | "flag_lock" | "joint_lock"
  | "write_window" | "snapshot_guard" | "source_preview" | "source_verify"
  | "recovery_prefilter" | "recovery_plan" | "recovery_evaluate" | "primary_guard" | "source_lock" | "recovery_insert" | "recovery_verify"
  | "activation_preview" | "activation_hosts" | "activation_apply" | "activation_readback";
export class JointMembershipOpsError extends Error {
  readonly attempts: number;
  readonly phase: JointOpsPhase | null;
  constructor(message: string, readonly category = "terminal",
    options?: ErrorOptions & { attempts?: number; phase?: JointOpsPhase | null }) {
    super(message, options); this.attempts = options?.attempts ?? 1; this.phase = options?.phase ?? null;
  }
}

// Annotate the failing operation, never driver query text or connection data.
async function withPhase<T>(phase: JointOpsPhase, work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof JointMembershipOpsError && error.phase) throw error;
    throw new JointMembershipOpsError(error instanceof JointMembershipOpsError ? error.message : "Database operation failed",
      error instanceof JointMembershipOpsError ? error.category : "database_error", { cause: error, phase });
  }
}
export type JointPreviewDigest = Brand<string, "JointPreviewDigest">;
export type JointOpsHumanId = Brand<string, "JointOpsHumanId">;
export type JointOpsJointId = Brand<string, "JointOpsJointId">;

const MAX_MEMBERS = 1000;
const SNAPSHOT_BUDGET_MS = 10_000;
const digest = (value: object) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function assertProductionWriteWindow(input: {
  approval: string | undefined; start: string | undefined; end: string | undefined;
}, now = new Date()) {
  const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
  if (!utc.test(input.start ?? "") || !utc.test(input.end ?? ""))
    throw new JointMembershipOpsError("Approved window timestamps must be explicit ISO UTC (Z)");
  const start = Date.parse(input.start ?? ""), end = Date.parse(input.end ?? "");
  if (!input.approval?.trim() || !Number.isFinite(start) || !Number.isFinite(end)
    || start >= end || now.getTime() < start || now.getTime() >= end)
    throw new JointMembershipOpsError("An explicit human approval reference and current approved UTC window are required");
  const migrationStart = Date.parse("2026-10-29T12:00:00Z"), migrationEnd = Date.parse("2026-10-29T16:00:00Z");
  if (start < migrationEnd && end > migrationStart)
    throw new JointMembershipOpsError("Production write window overlaps the prohibited RisingWave migration window");
}

export function sqlStateOf(error: unknown): string | null {
  for (let depth = 0; depth < 5 && error instanceof Error; depth++) {
    if ("code" in error && typeof error.code === "string") return error.code;
    error = error.cause;
  }
  return null;
}

/** lock_timeout: lock/statement timeouts, retried in every mode (3 attempts).
 * replica_or_connection: hot-standby recovery conflicts (40001 "canceling
 * statement due to conflict with recovery", 40P01), connection loss and admin
 * shutdown (08xxx, 57P01-57P03), and node-postgres connection errors that carry
 * no SQLSTATE. Retried only for READ ONLY work (5 attempts, backoff): a write
 * whose COMMIT acknowledgement was lost may have committed, so write modes
 * never re-run on connection loss. */
export type JointOpsTransientKind = "lock_timeout" | "replica_or_connection";
const LOCK_TIMEOUT_SQLSTATES = new Set(["55P03", "57014"]);
const REPLICA_OR_CONNECTION_CODES = new Set(["40001", "40P01", "08000", "08003", "08006", "57P01", "57P02", "57P03",
  "ECONNRESET", "ETIMEDOUT", "EPIPE", "ECONNREFUSED"]);
// node-postgres / pg-pool raise these as plain Errors without a code. Matched
// exactly, never logged: the message text is not interpolated anywhere.
const CONNECTION_LOST_MESSAGES = new Set(["Connection terminated unexpectedly", "Connection terminated due to connection timeout",
  "Client has encountered a connection error and is not queryable", "timeout exceeded when trying to connect"]);
export function transientKindOf(error: unknown): JointOpsTransientKind | null {
  for (let depth = 0; depth < 6 && error instanceof Error; depth++, error = error.cause) {
    // Our own errors carry no driver code; look through to their cause.
    if (error instanceof JointMembershipOpsError) continue;
    const code = "code" in error && typeof error.code === "string" ? error.code : null;
    if (code !== null) {
      if (LOCK_TIMEOUT_SQLSTATES.has(code)) return "lock_timeout";
      if (REPLICA_OR_CONNECTION_CODES.has(code)) return "replica_or_connection";
      return null;
    }
    if (CONNECTION_LOST_MESSAGES.has(error.message)) return "replica_or_connection";
  }
  return null;
}

const REPLICA_RETRY_ATTEMPTS = 5, REPLICA_RETRY_BASE_MS = 1000, REPLICA_RETRY_MAX_MS = 10_000;
export async function retryTransient<T>(work: () => Promise<T>, options: { readOnly?: boolean; sleep?: (ms: number) => Promise<void> } = {}) {
  const sleep = options.sleep ?? (ms => new Promise<void>(done => setTimeout(done, ms)));
  for (let attempt = 1; ; attempt++) {
    try { return { value: await work(), attempts: attempt }; }
    catch (error) {
      const phase = error instanceof JointMembershipOpsError ? error.phase : null;
      const found = transientKindOf(error);
      const kind = found === "replica_or_connection" && !options.readOnly ? null : found;
      if (!kind) throw new JointMembershipOpsError(error instanceof JointMembershipOpsError ? error.message : "Database operation failed",
        error instanceof JointMembershipOpsError ? error.category : "database_error", { cause: error, attempts: attempt, phase });
      const max = kind === "lock_timeout" ? 3 : REPLICA_RETRY_ATTEMPTS;
      if (attempt >= max) throw new JointMembershipOpsError(kind === "lock_timeout" ? "Lock/statement timeout after 3 attempts"
        : `Replica conflict or connection loss after ${max} attempts`, "retry_exhausted", { cause: error, attempts: attempt, phase });
      const delay = kind === "lock_timeout" ? attempt * 100
        : Math.round(Math.min(REPLICA_RETRY_MAX_MS, REPLICA_RETRY_BASE_MS * 2 ** (attempt - 1)) * (0.5 + Math.random() / 2));
      // Sanitized: SQLSTATE/node code and phase only, never the driver message.
      console.error(JSON.stringify({ event: "retry", kind, attempt, delayMs: delay, sqlState: sqlStateOf(error), phase }));
      await sleep(delay);
    }
  }
}

/** An idle pooled client whose connection drops (replica restart, recovery
 * conflict, network) makes pg-pool emit 'error'; a checked-out client emits
 * 'error' itself. Unhandled, either crashes the process. The in-flight query
 * still rejects and is retried or recorded per J; this only logs. */
export function attachJointOpsConnectionErrorHandlers(pool: pg.Pool, log: (line: string) => void = line => console.error(line)) {
  const handler = (source: "pool" | "client") => (error: unknown) =>
    log(JSON.stringify({ event: "connection_error", source, sqlState: sqlStateOf(error), kind: transientKindOf(error) }));
  pool.on("error", handler("pool"));
  pool.on("connect", client => { client.on("error", handler("client")); });
}

async function setupOpsTransaction(tx: DatabaseExecutor, access: "read" | "write") {
  await withPhase("transaction_setup", async () => {
    await tx.execute(access === "write" ? sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`
      : sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
    await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
    await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='10s'`);
  });
}

/** Checked inside every per-J snapshot, so reconnection/promotion cannot bypass it. */
async function requireReplicaSnapshot(tx: DatabaseExecutor) {
  const state = await withPhase("replica_guard", () => tx.execute<{ replica: boolean }>(sql`SELECT pg_is_in_recovery() replica`));
  if (state.rows[0]?.replica !== true) throw new JointMembershipOpsError("Production scan requires a read replica, including after reconnect or promotion", "terminal", { phase: "replica_guard" });
}

// ---------------------------------------------------------------------------
// Source preview / verify: READ ONLY (Cody 8493b6c3, Tenny 4d2d2a91). There is
// no source apply here; a later apply re-checks tuples with verifyJointSourceTuples.

/** One primary category per (J, user, current generation, server) tuple.
 * Precedence is the order of the checks in classifyJointSourceTuple. */
export const JOINT_SOURCE_CATEGORIES = ["live", "stale_source", "ended", "removal_pending",
  "invite_evidence", "computed_pre_flag_ch", "computed_ch", "other_generation_admission"] as const;
export type JointSourceCategory = typeof JOINT_SOURCE_CATEGORIES[number];

export type JointSourceFacts = {
  pending: boolean;
  /** The admission with exactly this tuple's generation; other generations never count. */
  admission: { endedAt: string | null; live: boolean } | null;
  ch: { joinedAt: string } | null;
  /** ch.joinedAt is before the host's known computed-membership start. */
  preFlag: boolean;
  inviteEvidence: number;
};

export function classifyJointSourceTuple(facts: JointSourceFacts): JointSourceCategory {
  if (facts.pending) return "removal_pending";
  if (facts.admission) return facts.admission.endedAt !== null ? "ended" : facts.admission.live ? "live" : "stale_source";
  if (facts.inviteEvidence > 0) return "invite_evidence";
  if (facts.ch) return facts.preFlag ? "computed_pre_flag_ch" : "computed_ch";
  return "other_generation_admission";
}

const utc = (column: SQL) => sql`to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
export const MAX_SOURCE_EVIDENCE_ROWS = 20_000;
/** Every per-J evidence query fetches at most cap+1 rows; more than cap fails the
 * whole J as oversized (a failure receipt), never a truncated "complete" preview. */
function boundedRows<T>(rows: T[], what: string, cap: number): T[] {
  if (rows.length > cap)
    throw new JointMembershipOpsError(`Oversized ${what}: more than ${cap} rows (fetched ${rows.length}); requires separate investigation`, "oversized", { phase: "source_preview" });
  return rows;
}

type HostFlagEvidence = {
  key: string; hostServerId: string; ffcv: number | null;
  flag: { enabled: boolean; killSwitch: boolean; defaultEnabled: boolean; updatedAt: string } | null;
  hostRules: Array<{ id: string; decision: string; createdAt: string; updatedAt: string }>;
  otherAllowRuleIds: string[];
  /** Lower bound of the host's computed-mode start; null when the rules cannot bound it. */
  flagOnAt: string | null;
};

async function readHostFlagEvidence(tx: DatabaseExecutor, hostServerId: string): Promise<HostFlagEvidence> {
  const key = RETIRED_JOINT_HUMAN_MEMBERSHIP_FLAG_KEY;
  const flag = (await tx.execute<{ enabled: boolean; killSwitch: boolean; defaultEnabled: boolean; updatedAt: string }>(sql`
    SELECT enabled,kill_switch AS "killSwitch",default_enabled AS "defaultEnabled",${utc(sql`updated_at`)} AS "updatedAt"
    FROM feature_flags WHERE key=${key}`)).rows[0] ?? null;
  const ffcv = (await tx.execute<{ version: number | string }>(sql`
    SELECT version FROM feature_flag_config_versions WHERE scope='global'`)).rows[0]?.version;
  const rules = (await tx.execute<{ id: string; stage: string; decision: string; createdAt: string; updatedAt: string; host: boolean }>(sql`
    SELECT id,stage,decision,${utc(sql`created_at`)} AS "createdAt",${utc(sql`updated_at`)} AS "updatedAt",
      (stage='server' AND jsonb_typeof("values")='array' AND "values" @> jsonb_build_array(${hostServerId}::text)) AS host
    FROM feature_flag_rules WHERE flag_key=${key} ORDER BY created_at,id`)).rows;
  const hostRules = rules.filter(rule => rule.host).map(({ id, decision, createdAt, updatedAt }) => ({ id, decision, createdAt, updatedAt }));
  const otherAllowRuleIds = rules.filter(rule => rule.stage !== "server" && rule.decision === "allow").map(rule => rule.id);
  const allow = hostRules.filter(rule => rule.decision === "allow");
  // created_at <= the true flag-on time only when this one rule is the sole way
  // the host can be on: no default, no deny, no other-stage allow rule.
  const flagOnAt = flag && !flag.defaultEnabled && allow.length === 1
    && allow.length === hostRules.length && otherAllowRuleIds.length === 0 ? allow[0]!.createdAt : null;
  return { key, hostServerId, ffcv: ffcv === undefined ? null : Number(ffcv), flag, hostRules, otherAllowRuleIds, flagOnAt };
}

type ExternalInviteEvidence = { inviteId: string; status: string; outcome: string | null; decidedAt: string | null;
  position: number; acceptedServerId: string | null; sourceState: string | null; sourceGeneration: number | null };
type JointInviteEvidence = { inviteId: string; acceptedAt: string | null; acceptedVia: string | null; fromServerId: string };
/** An accepted joint invite whose joiner is not provable from the row: an
 * external connect stores its AUTHORIZER as accepter and invitee (channelService
 * createExternalConnectJointInvite / acceptJointChannelInviteInCallerTransaction)
 * while the joiner is passed separately and not stored. */
export type ConnectAuthorizerEvidence = JointInviteEvidence & { serverId: string; authorizerUserId: string | null };
export type JointSourceTuple = {
  userId: JointOpsHumanId; generation: number; serverId: ServerId;
  evidence: {
    admission: { admittedAt: string; endedAt: string | null } | null;
    otherGenerationAdmissions: Array<{ generation: number; endedAt: string | null }>;
    ch: { channelId: string; joinedAt: string } | null;
    entry: { projection: string | null; entryLive: boolean; serverDeleted: boolean | null; role: string | null };
    externalInvites: ExternalInviteEvidence[];
    jointInvites: JointInviteEvidence[];
    /** Ids of joiner-unknown accepts to this server (connectAuthorizerEvidence); never counted as this person's evidence. */
    connectAuthorizerInviteIds: string[];
  };
};

/** Read-only classification of every current member's candidate sources in J.
 * The caller owns a REPEATABLE READ, READ ONLY snapshot (runJointSourcePreview). */
export async function previewJointSources(tx: DatabaseExecutor, jointId: string, options: { evidenceRowCap?: number } = {}) {
  const cap = options.evidenceRowCap ?? MAX_SOURCE_EVIDENCE_ROWS;
  if (!Number.isInteger(cap) || cap < 1 || cap > MAX_SOURCE_EVIDENCE_ROWS)
    throw new JointMembershipOpsError(`evidence-row-cap must be 1..${MAX_SOURCE_EVIDENCE_ROWS}`);
  const limit = sql`LIMIT ${cap + 1}`;
  const started = performance.now();
  const budget = () => {
    if (performance.now() - started > SNAPSHOT_BUDGET_MS) throw new JointMembershipOpsError("Snapshot budget exceeded; incomplete, not a pass", "terminal", { phase: "source_preview" });
  };
  const joint = (await tx.execute<{ status: string; hostServerId: string }>(sql`
    SELECT status,created_by_server_id AS "hostServerId" FROM joint_channels WHERE id=${jointId}::uuid`)).rows[0];
  if (!joint) throw new JointMembershipOpsError("Joint not found");
  const flag = await readHostFlagEvidence(tx, joint.hostServerId);
  const tuples = Object.fromEntries(JOINT_SOURCE_CATEGORIES.map(category => [category, [] as JointSourceTuple[]])) as Record<JointSourceCategory, JointSourceTuple[]>;
  const result = (members: number, noLiveSource: Array<{ userId: JointOpsHumanId; generation: number; categories: JointSourceCategory[] }>,
    connectAuthorizerEvidence: ConnectAuthorizerEvidence[]) => {
    const counts = Object.fromEntries(JOINT_SOURCE_CATEGORIES.map(category => [category, tuples[category].length])) as Record<JointSourceCategory, number>;
    // Live tuples are reported and counted but not bound: the digest covers what
    // a later apply would act on or must leave alone (candidates + exceptions).
    const { live: _live, ...bound } = tuples;
    const sourceDigest = digest({ jointId, hostServerId: joint.hostServerId, status: joint.status, flag, tuples: bound, noLiveSource, connectAuthorizerEvidence }) as JointPreviewDigest;
    return { jointId, hostServerId: joint.hostServerId, status: joint.status, flag, members,
      counts, noLiveSourceCount: noLiveSource.length, tuples, noLiveSource, connectAuthorizerEvidence, digest: sourceDigest };
  };
  if (joint.status !== "active") return result(0, [], []);
  const J = sql`${jointId}::uuid`;
  const members = (await tx.execute<{ userId: string; generation: number; pending: boolean }>(sql`
    SELECT m.user_id AS "userId",m.generation,
      ${jointMembershipRemovalPendingSql(sql`m.joint_channel_id`, "user", sql`m.user_id`)} AS pending
    FROM joint_channel_members m WHERE m.joint_channel_id=${J} ORDER BY m.user_id LIMIT ${Math.min(MAX_MEMBERS, cap) + 1}`)).rows;
  boundedRows(members, "members", Math.min(MAX_MEMBERS, cap));
  const member = new Map(members.map(row => [row.userId, { generation: Number(row.generation), pending: row.pending === true }]));
  const entries = new Map(boundedRows((await tx.execute<{ serverId: string; projection: string; entryLive: boolean; serverDeleted: boolean }>(sql`
    SELECT p.server_id AS "serverId",p.status AS projection,
      (p.status='active' AND c.type='joint' AND c.server_id=p.server_id AND c.deleted_at IS NULL) AS "entryLive",
      s.deleted_at IS NOT NULL AS "serverDeleted"
    FROM joint_channel_servers p JOIN channels c ON c.id=p.local_channel_id JOIN servers s ON s.id=p.server_id
    WHERE p.joint_channel_id=${J} ${limit}`)).rows, "projections", cap).map(row => [row.serverId, row]));
  const roles = new Map(boundedRows((await tx.execute<{ serverId: string; userId: string; role: string }>(sql`
    SELECT sm.server_id AS "serverId",sm.user_id AS "userId",sm.role FROM server_members sm
    JOIN joint_channel_members m ON m.joint_channel_id=${J} AND m.user_id=sm.user_id
    WHERE sm.server_id IN (SELECT server_id FROM joint_channel_servers WHERE joint_channel_id=${J}) ${limit}`)).rows, "role evidence", cap)
    .map(row => [`${row.userId}/${row.serverId}`, row.role]));
  const chRows = boundedRows((await tx.execute<{ serverId: string; userId: string; channelId: string; joinedAt: string }>(sql`
    SELECT p.server_id AS "serverId",ch.user_id AS "userId",ch.channel_id AS "channelId",${utc(sql`ch.joined_at`)} AS "joinedAt"
    FROM joint_channel_servers p JOIN channel_humans ch ON ch.channel_id=p.local_channel_id
    JOIN joint_channel_members m ON m.joint_channel_id=p.joint_channel_id AND m.user_id=ch.user_id
    WHERE p.joint_channel_id=${J} ${limit}`)).rows, "CH evidence", cap);
  const admissions = boundedRows((await tx.execute<{ serverId: string; userId: string; generation: number; admittedAt: string; endedAt: string | null; live: boolean }>(sql`
    SELECT a.server_id AS "serverId",a.user_id AS "userId",a.generation,${utc(sql`a.admitted_at`)} AS "admittedAt",
      ${utc(sql`a.ended_at`)} AS "endedAt",
      ${jointHumanCurrentSourceSql(sql`a.joint_channel_id`, sql`a.user_id`, sql`a.server_id`)} AS live
    FROM joint_channel_admissions a JOIN joint_channel_members m ON m.joint_channel_id=a.joint_channel_id AND m.user_id=a.user_id
    WHERE a.joint_channel_id=${J} ${limit}`)).rows, "admission evidence", cap);
  // The joiner of an external connect is accepted_user_id; servers it connected
  // are connected_server_ids in order (empty before that column: accepted_server_id).
  const externalInvites = boundedRows((await tx.execute<ExternalInviteEvidence & { userId: string; serverId: string }>(sql`
    SELECT i.id AS "inviteId",i.accepted_user_id AS "userId",x.server_id AS "serverId",x.position::int AS position,
      i.status,i.outcome,${utc(sql`i.decided_at`)} AS "decidedAt",i.accepted_server_id AS "acceptedServerId",
      i.source_state AS "sourceState",i.source_generation AS "sourceGeneration"
    FROM channel_external_invites i
    JOIN joint_channel_servers hp ON hp.joint_channel_id=${J} AND hp.local_channel_id=i.channel_id AND hp.server_id=i.host_server_id
    JOIN joint_channel_members m ON m.joint_channel_id=${J} AND m.user_id=i.accepted_user_id
    CROSS JOIN LATERAL unnest(CASE WHEN cardinality(i.connected_server_ids)=0 AND i.accepted_server_id IS NOT NULL
      THEN ARRAY[i.accepted_server_id] ELSE i.connected_server_ids END) WITH ORDINALITY AS x(server_id,position)
    ORDER BY i.id,x.position ${limit}`)).rows, "external invite evidence", cap);
  // The joiner is provable from the row only where accepter == joiner by
  // construction: same_admin (createJointChannel's direct accept passes no
  // joiner) and invitee accepts (route/batch pass none, joiner defaults to the
  // accepter) of a server no external invite of this J ever connected. An
  // external connect also stores accepted_via='invitee' (the default) with its
  // authorizer as accepter, so those, and NULL accepted_via, are joiner-unknown.
  const jointInvites = boundedRows((await tx.execute<JointInviteEvidence & { userId: string | null; serverId: string; joinerProvable: boolean; member: boolean }>(sql`
    SELECT i.id AS "inviteId",i.accepted_by_user_id AS "userId",i.to_server_id AS "serverId",i.from_server_id AS "fromServerId",
      ${utc(sql`i.accepted_at`)} AS "acceptedAt",i.accepted_via AS "acceptedVia",
      (i.accepted_via='same_admin' OR (i.accepted_via='invitee' AND NOT EXISTS (
        SELECT 1 FROM channel_external_invites ei
        JOIN joint_channel_servers hp ON hp.joint_channel_id=${J} AND hp.local_channel_id=ei.channel_id AND hp.server_id=ei.host_server_id
        WHERE i.to_server_id=ANY(ei.connected_server_ids) OR i.to_server_id=ANY(ei.connect_queued_server_ids)
          OR ei.accepted_server_id=i.to_server_id OR ei.connect_server_id=i.to_server_id))) AS "joinerProvable",
      EXISTS (SELECT 1 FROM joint_channel_members m WHERE m.joint_channel_id=i.joint_channel_id AND m.user_id=i.accepted_by_user_id) AS member
    FROM joint_channel_invites i
    WHERE i.joint_channel_id=${J} AND i.status='accepted' ORDER BY i.id ${limit}`)).rows, "joint invite evidence", cap);
  budget();

  type Draft = JointSourceTuple & { live: boolean };
  const drafts = new Map<string, Draft>();
  const draft = (userId: string, serverId: string): Draft | null => {
    const current = member.get(userId);
    if (!current) return null;
    const key = `${userId}/${serverId}`;
    let row = drafts.get(key);
    if (!row) {
      const entry = entries.get(serverId);
      row = { userId: userId as JointOpsHumanId, generation: current.generation, serverId: asServerId(serverId), live: false,
        evidence: { admission: null, otherGenerationAdmissions: [], ch: null,
          entry: { projection: entry?.projection ?? null, entryLive: entry?.entryLive === true,
            serverDeleted: entry ? entry.serverDeleted === true : null, role: roles.get(key) ?? null },
          externalInvites: [], jointInvites: [], connectAuthorizerInviteIds: [] } };
      drafts.set(key, row);
    }
    return row;
  };
  for (const row of chRows) {
    const tuple = draft(row.userId, row.serverId);
    if (tuple) tuple.evidence.ch = { channelId: row.channelId, joinedAt: row.joinedAt };
  }
  for (const row of admissions) {
    const tuple = draft(row.userId, row.serverId);
    if (!tuple) continue;
    // Generation match: only (J,u,g=m.generation,S) is this episode's source.
    if (Number(row.generation) === tuple.generation) {
      tuple.evidence.admission = { admittedAt: row.admittedAt, endedAt: row.endedAt };
      tuple.live = row.live === true;
    } else tuple.evidence.otherGenerationAdmissions.push({ generation: Number(row.generation), endedAt: row.endedAt });
  }
  for (const { userId, serverId, ...evidence } of externalInvites) {
    draft(userId, serverId)?.evidence.externalInvites.push({ ...evidence, position: Number(evidence.position),
      sourceGeneration: evidence.sourceGeneration === null ? null : Number(evidence.sourceGeneration) });
  }
  const connectAuthorizerEvidence: ConnectAuthorizerEvidence[] = [];
  for (const { userId, serverId, joinerProvable, member: isMember, ...evidence } of jointInvites) {
    if (joinerProvable === true) { if (userId && isMember === true) draft(userId, serverId)?.evidence.jointInvites.push(evidence); }
    else connectAuthorizerEvidence.push({ ...evidence, serverId, authorizerUserId: userId });
  }
  // Shown on tuples that already exist on that server (e.g. the joiner's, from
  // its external invite), never creating or counting as anyone's evidence.
  for (const row of connectAuthorizerEvidence)
    for (const tuple of drafts.values()) if (tuple.serverId === row.serverId) tuple.evidence.connectAuthorizerInviteIds.push(row.inviteId);

  const byMember = new Map<string, Set<JointSourceCategory>>();
  for (const key of [...drafts.keys()].sort()) {
    const { live, ...tuple } = drafts.get(key)!;
    tuple.evidence.otherGenerationAdmissions.sort((a, b) => a.generation - b.generation);
    const { admission, ch, externalInvites: ext, jointInvites: inv } = tuple.evidence;
    const category = classifyJointSourceTuple({ pending: member.get(tuple.userId)!.pending,
      admission: admission ? { endedAt: admission.endedAt, live } : null,
      ch, preFlag: !!ch && flag.flagOnAt !== null && ch.joinedAt < flag.flagOnAt,
      inviteEvidence: ext.length + inv.length });
    tuples[category].push(tuple);
    byMember.set(tuple.userId, (byMember.get(tuple.userId) ?? new Set()).add(category));
  }
  // E: a current member with no live source.
  const noLiveSource = members.flatMap(row => {
    const categories = byMember.get(row.userId) ?? new Set<JointSourceCategory>();
    return categories.has("live") ? []
      : [{ userId: row.userId as JointOpsHumanId, generation: Number(row.generation), categories: JOINT_SOURCE_CATEGORIES.filter(c => categories.has(c)) }];
  });
  budget();
  return result(members.length, noLiveSource, connectAuthorizerEvidence);
}

export type JointSourceTupleKey = { jointId: JointOpsJointId; userId: JointOpsHumanId; generation: number; serverId: ServerId };
export type JointSourceVerifyResult = "ok" | "member_missing" | "generation_changed" | "admission_missing" | "admission_ended" | "source_not_live";
const MAX_VERIFY_TUPLES = 1000;

/** Read-only, per tuple: is (J,u,g,S) a live current source now? The live
 * predicate is the serving one (jointHumanCurrentSourceSql) plus g = m.generation. */
export async function verifyJointSourceTuples(tx: DatabaseExecutor, tuples: readonly JointSourceTupleKey[]) {
  if (tuples.length > MAX_VERIFY_TUPLES) throw new JointMembershipOpsError(`At most ${MAX_VERIFY_TUPLES} tuples per verification`);
  if (!tuples.length) return { checked: 0, ok: 0, results: [] as Array<JointSourceTupleKey & { result: JointSourceVerifyResult }> };
  const rows = (await tx.execute<{ i: number; current: number | null; admission: boolean; endedAt: string | null; live: boolean }>(sql`
    SELECT t.i,m.generation AS current,a.user_id IS NOT NULL AS admission,${utc(sql`a.ended_at`)} AS "endedAt",
      ${jointHumanCurrentSourceSql(sql`t.joint_id`, sql`t.user_id`, sql`t.server_id`)} AS live
    FROM (VALUES ${sql.join(tuples.map((t, i) => sql`(${i}::int,${t.jointId}::uuid,${t.userId}::uuid,${t.generation}::int,${t.serverId}::uuid)`), sql`, `)})
      AS t(i,joint_id,user_id,generation,server_id)
    LEFT JOIN joint_channel_members m ON m.joint_channel_id=t.joint_id AND m.user_id=t.user_id
    LEFT JOIN joint_channel_admissions a ON a.joint_channel_id=t.joint_id AND a.user_id=t.user_id
      AND a.server_id=t.server_id AND a.generation=t.generation
    ORDER BY t.i`)).rows;
  const results = tuples.map((tuple, i) => {
    const row = rows.find(candidate => Number(candidate.i) === i);
    const result: JointSourceVerifyResult = !row || row.current === null ? "member_missing"
      : Number(row.current) !== tuple.generation ? "generation_changed"
        : !row.admission ? "admission_missing" : row.endedAt !== null ? "admission_ended"
          : row.live === true ? "ok" : "source_not_live";
    return { ...tuple, result };
  });
  return { checked: results.length, ok: results.filter(row => row.result === "ok").length, results };
}

/** Defense in depth: the source modes refuse any snapshot that is not RR + READ ONLY. */
async function assertReadOnlySnapshot(tx: DatabaseExecutor) {
  const state = (await tx.execute<{ isolation: string; readOnly: string }>(sql`
    SELECT current_setting('transaction_isolation') isolation,current_setting('transaction_read_only') AS "readOnly"`)).rows[0];
  if (state?.isolation !== "repeatable read" || state.readOnly !== "on")
    throw new JointMembershipOpsError("Source modes require a REPEATABLE READ, READ ONLY snapshot", "terminal", { phase: "snapshot_guard" });
  return { isolation: state.isolation, readOnly: true };
}

async function readOnlySourceSnapshot<T extends object>(db: Database, requireReplica: boolean, phase: JointOpsPhase,
  work: (tx: DatabaseExecutor) => Promise<T>) {
  const execution = await retryTransient(() => withPhase("transaction", () => db.transaction(async tx => {
    await setupOpsTransaction(tx, "read");
    if (requireReplica) await requireReplicaSnapshot(tx);
    const snapshot = await withPhase("snapshot_guard", () => assertReadOnlySnapshot(tx));
    return { ...await withPhase(phase, () => work(tx)), snapshot };
  })), { readOnly: true });
  return { ...execution.value, attempts: execution.attempts };
}

export function runJointSourcePreview(db: Database, jointId: string, options: { requireReplica?: boolean; evidenceRowCap?: number } = {}) {
  return readOnlySourceSnapshot(db, options.requireReplica === true, "source_preview", tx => previewJointSources(tx, jointId, { evidenceRowCap: options.evidenceRowCap }));
}
export function runJointSourceVerify(db: Database, tuples: readonly JointSourceTupleKey[], options: { requireReplica?: boolean } = {}) {
  return readOnlySourceSnapshot(db, options.requireReplica === true, "source_verify", tx => verifyJointSourceTuples(tx, tuples));
}

/** Run-level receipt: binds the scan bounds and every joint digest/failure in
 * order. A prefiltered recovery scan also binds the sorted ids it skipped, so
 * scanned + skipped + failed covers the cursor range; without `skipped` (every
 * other mode, and --no-prefilter) the digest is byte-for-byte the old one. */
export function jointSourceRunReceipt(input: { mode: string; after: string | null; through: string | null;
  joints: ReadonlyArray<{ jointId: string; digest: string }>; failures: ReadonlyArray<{ jointId: string; category: string }>;
  skipped?: readonly string[] }) {
  const { skipped, ...rest } = input;
  return digest(skipped === undefined ? rest : { ...rest, skipped: [...skipped].sort() });
}

export function parseJointSourceTuples(value: unknown): JointSourceTupleKey[] {
  const list = Array.isArray(value) ? value : typeof value === "object" && value !== null && "tuples" in value ? value.tuples : null;
  if (!Array.isArray(list)) throw new JointMembershipOpsError("Tuples file must be a JSON array or {\"tuples\": [...]}");
  const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
  const seen = new Set<string>();
  return list.map(item => {
    const t = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    const ids = [t.jointId, t.userId, t.serverId];
    if (!ids.every(id => typeof id === "string" && uuid.test(id)) || !Number.isInteger(t.generation) || (t.generation as number) < 1)
      throw new JointMembershipOpsError("Invalid tuple: jointId/userId/serverId UUIDs and a positive integer generation are required");
    const tuple = { jointId: (t.jointId as string).toLowerCase() as JointOpsJointId, userId: (t.userId as string).toLowerCase() as JointOpsHumanId,
      generation: t.generation as number, serverId: asServerId((t.serverId as string).toLowerCase()) };
    const key = `${tuple.jointId}/${tuple.userId}/${tuple.generation}/${tuple.serverId}`;
    if (seen.has(key)) throw new JointMembershipOpsError("Duplicate tuple");
    seen.add(key);
    return tuple;
  });
}

// ---------------------------------------------------------------------------
// Source recovery (#wg-rbac:#23; policy v3.1, cindyz 7de9b092; schema #13330).
// source-recovery-preview: read-only, plans from a fresh scan or re-evaluates a
// frozen plan. source-recovery-apply: writes 'recovery' rows for exactly the
// frozen tuples that still pass every check under the admission source locks
// and J. Both modes share evaluateJointSourceRecovery, so the preview is what
// apply would do against the state it reads.

export const JOINT_RECOVERY_FORMAT = "joint-source-recovery/v2";
export const MAX_RECOVERY_JOINTS = 100;
export const MAX_RECOVERY_TUPLES_PER_JOINT = 1000;
/** R3: only C (computed CH) and D (invite) evidence names a target server. */
export const JOINT_RECOVERY_TRACE_CATEGORIES = ["computed_ch", "invite_evidence"] as const;
type JointRecoveryTraceCategory = typeof JOINT_RECOVERY_TRACE_CATEGORIES[number];
export const JOINT_RECOVERY_TUPLE_OUTCOMES = ["written", "skipped_conflict", "skipped_invalid_target",
  "changed_since_scan", "held_for_host_admin", "not_member"] as const;
export type JointRecoveryTupleOutcome = typeof JOINT_RECOVERY_TUPLE_OUTCOMES[number];

export type JointRecoveryTrace = {
  /** The trace tuple's TARGET server (R3), never an invite's from_server_id. */
  serverId: ServerId;
  category: JointRecoveryTraceCategory;
  /** Lifecycle identity at scan time (R6); null when absent at scan time. */
  projection: { localChannelId: string; joinedAt: string } | null;
  serverMemberJoinedAt: string | null;
};
/** R5 frozen at scan time: the ended tuple(s) that held this occurrence. Bound
 * by the file digest the approval cites; apply never lifts it (Cody, #13357). */
export type JointRecoveryHold = { reason: "ended_source"; endedServerIds: string[]; endedAt: string[] };
export type JointRecoveryOccurrence = { userId: JointOpsHumanId; generation: number; hold: JointRecoveryHold | null; traces: JointRecoveryTrace[] };
export type JointRecoveryPlan = { jointId: JointOpsJointId; sourcePreviewDigest: JointPreviewDigest; occurrences: JointRecoveryOccurrence[] };
export type JointRecoveryTupleResult = { userId: JointOpsHumanId; generation: number; serverId: ServerId;
  outcome: JointRecoveryTupleOutcome | "would_write"; reason: string };
/** A host-side decision to lift one frozen R5 hold for ONE trace server T
 * (cindyz 95c80f55: keep the 2 held memberships). The ended S source is never
 * revived; every other trace of that occurrence stays held. */
export const JOINT_RECOVERY_RELEASE_FORMAT = "joint-source-recovery-release/v1";
export const MAX_RECOVERY_RELEASES = 20;
export type JointRecoveryRelease = { jointId: JointOpsJointId; userId: JointOpsHumanId; generation: number; serverId: ServerId };
/** Per joint: the released `${userId}/${generation}/${serverId}` keys. */
export type JointRecoveryReleaseKeys = ReadonlyMap<string, ReadonlySet<string>>;
const releaseKey = (userId: string, generation: number, serverId: string) => `${userId}/${generation}/${serverId}`;

const sortPlan = (plan: JointRecoveryPlan): JointRecoveryPlan => ({ ...plan,
  occurrences: [...plan.occurrences].sort((a, b) => a.userId.localeCompare(b.userId))
    .map(occurrence => ({ ...occurrence, traces: [...occurrence.traces].sort((a, b) => a.serverId.localeCompare(b.serverId)) })) });
export const jointRecoveryPlanDigest = (plan: JointRecoveryPlan) => digest(sortPlan(plan)) as JointPreviewDigest;

/** Scan step, inside a READ ONLY snapshot: the source preview plus, in the same
 * snapshot, each trace's lifecycle identity. Every current member with no live
 * source is an occurrence (R1), and so is every member with a C/D trace (R4).
 * A joint that is not active is not planned. */
export async function planJointSourceRecovery(tx: DatabaseExecutor, jointId: string, options: { evidenceRowCap?: number } = {}) {
  const preview = await previewJointSources(tx, jointId, options);
  const occurrences = new Map<string, JointRecoveryOccurrence>();
  const occurrence = (userId: JointOpsHumanId, generation: number) => {
    let row = occurrences.get(userId);
    if (!row) occurrences.set(userId, row = { userId, generation, hold: null, traces: [] });
    return row;
  };
  const plan = { jointId: jointId.toLowerCase() as JointOpsJointId, sourcePreviewDigest: preview.digest, occurrences: [] as JointRecoveryOccurrence[] };
  if (preview.status !== "active")
    return { plan, status: preview.status, planned: false as const, sourcePreview: preview };
  for (const row of preview.noLiveSource) occurrence(row.userId, row.generation);
  const traces = JOINT_RECOVERY_TRACE_CATEGORIES.flatMap(category => preview.tuples[category].map(tuple => ({ tuple, category })));
  const J = sql`${jointId}::uuid`;
  const projections = new Map((await tx.execute<{ serverId: string; localChannelId: string; joinedAt: string }>(sql`
    SELECT server_id AS "serverId",local_channel_id AS "localChannelId",${utc(sql`joined_at`)} AS "joinedAt"
    FROM joint_channel_servers WHERE joint_channel_id=${J}`)).rows.map(row => [row.serverId, row]));
  const identities = new Map(traces.length ? (await tx.execute<{ key: string; joinedAt: string }>(sql`
    SELECT t.user_id::text||'/'||t.server_id::text AS key,${utc(sql`sm.joined_at`)} AS "joinedAt"
    FROM (VALUES ${sql.join(traces.map(({ tuple }) => sql`(${tuple.userId}::uuid,${tuple.serverId}::uuid)`), sql`, `)}) t(user_id,server_id)
    JOIN server_members sm ON sm.server_id=t.server_id AND sm.user_id=t.user_id`)).rows.map(row => [row.key, row.joinedAt]) : []);
  for (const { tuple, category } of traces) {
    const projection = projections.get(tuple.serverId);
    occurrence(tuple.userId, tuple.generation).traces.push({ serverId: tuple.serverId, category,
      projection: projection ? { localChannelId: projection.localChannelId, joinedAt: projection.joinedAt } : null,
      serverMemberJoinedAt: identities.get(`${tuple.userId}/${tuple.serverId}`) ?? null });
  }
  // R5 at scan time: an ended source on S plus a trace on another server T.
  for (const occ of occurrences.values()) {
    const ended = preview.tuples.ended.filter(tuple => tuple.userId === occ.userId && tuple.generation === occ.generation)
      .sort((a, b) => a.serverId.localeCompare(b.serverId));
    if (ended.some(e => occ.traces.some(t => t.serverId !== e.serverId)))
      occ.hold = { reason: "ended_source", endedServerIds: ended.map(e => e.serverId), endedAt: ended.map(e => e.evidence.admission!.endedAt!) };
  }
  plan.occurrences = [...occurrences.values()];
  return { plan: sortPlan(plan), status: preview.status, planned: true as const, sourcePreview: preview };
}

/** The per-tuple decision table (R1-R6). Reads only; the caller decides the
 * snapshot (preview: READ ONLY; apply: READ COMMITTED under source locks and J). */
export async function evaluateJointSourceRecovery(tx: DatabaseExecutor, plan: JointRecoveryPlan,
  released: ReadonlySet<string> = new Set()) {
  const J = sql`${plan.jointId}::uuid`;
  const users = plan.occurrences.map(row => row.userId);
  const traces = plan.occurrences.flatMap(row => row.traces.map(trace => ({ userId: row.userId, trace })));
  const joint = (await tx.execute<{ status: string }>(sql`SELECT status FROM joint_channels WHERE id=${J}`)).rows[0];
  const present = joint !== undefined;
  const inList = (ids: readonly string[]) => sql.join(ids.map(id => sql`${id}::uuid`), sql`, `);
  const members = new Map(users.length ? (await tx.execute<{ userId: string; generation: number; pending: boolean }>(sql`
    SELECT m.user_id AS "userId",m.generation,
      ${jointMembershipRemovalPendingSql(sql`m.joint_channel_id`, "user", sql`m.user_id`)} AS pending
    FROM joint_channel_members m WHERE m.joint_channel_id=${J} AND m.user_id IN (${inList(users)})`)).rows
    .map(row => [row.userId, { generation: Number(row.generation), pending: row.pending === true }]) : []);
  const admissions = users.length ? (await tx.execute<{ userId: string; serverId: string; generation: number; ended: boolean; kind: string; live: boolean }>(sql`
    SELECT a.user_id AS "userId",a.server_id AS "serverId",a.generation,a.ended_at IS NOT NULL AS ended,a.kind,
      ${jointHumanCurrentSourceSql(sql`a.joint_channel_id`, sql`a.user_id`, sql`a.server_id`)} AS live
    FROM joint_channel_admissions a WHERE a.joint_channel_id=${J} AND a.user_id IN (${inList(users)})`)).rows : [];
  const targets = new Map(traces.length ? (await tx.execute<{ key: string; projection: string | null; localChannelId: string | null;
    projectionJoinedAt: string | null; channelLive: boolean; serverDeleted: boolean | null; role: string | null; memberJoinedAt: string | null }>(sql`
    SELECT t.user_id::text||'/'||t.server_id::text AS key,p.status AS projection,p.local_channel_id AS "localChannelId",
      ${utc(sql`p.joined_at`)} AS "projectionJoinedAt",
      (c.type='joint' AND c.server_id=p.server_id AND c.deleted_at IS NULL) IS TRUE AS "channelLive",
      s.deleted_at IS NOT NULL AS "serverDeleted",sm.role,${utc(sql`sm.joined_at`)} AS "memberJoinedAt"
    FROM (VALUES ${sql.join(traces.map(({ userId, trace }) => sql`(${userId}::uuid,${trace.serverId}::uuid)`), sql`, `)}) t(user_id,server_id)
    LEFT JOIN joint_channel_servers p ON p.joint_channel_id=${J} AND p.server_id=t.server_id
    LEFT JOIN channels c ON c.id=p.local_channel_id
    LEFT JOIN servers s ON s.id=t.server_id
    LEFT JOIN server_members sm ON sm.server_id=t.server_id AND sm.user_id=t.user_id`)).rows.map(row => [row.key, row]) : []);

  const tuples: Array<Omit<JointRecoveryTupleResult, "outcome"> & { outcome: JointRecoveryTupleOutcome | "write" }> = [];
  const needsHostAdmin: Array<{ userId: JointOpsHumanId; generation: number; reasons: string[] }> = [];
  const heldForHostAdmin: Array<{ userId: JointOpsHumanId; generation: number; frozenAtScan: boolean; endedServerIds: string[];
    traceServerIds: string[]; releasedServerIds: string[] }> = [];
  for (const occ of plan.occurrences) {
    const member = members.get(occ.userId);
    const current = admissions.filter(row => row.userId === occ.userId && Number(row.generation) === occ.generation);
    const endedOn = [...new Set(current.filter(row => row.ended).map(row => row.serverId))].sort();
    const traceServers = occ.traces.map(trace => trace.serverId as string);
    // R5: an ended source on S plus a trace on another server T holds the whole occurrence.
    // A hold frozen at scan stays, whatever the state now; a new ended source can add one.
    const frozenHold = occ.hold !== null;
    const held = frozenHold || endedOn.some(s => traceServers.some(t => t !== s));
    const memberReason = !member ? "member_missing" : member.pending ? "removal_pending"
      : member.generation !== occ.generation ? "generation_changed" : null;
    // A release lifts the frozen hold for its trace server only, and only while
    // no source has ended since the scan beyond the ones the decision was about.
    const releasedServers = frozenHold ? traceServers.filter(t => released.has(releaseKey(occ.userId, occ.generation, t))) : [];
    const endedSinceScan = endedOn.filter(s => !occ.hold?.endedServerIds.includes(s));
    if (frozenHold || (present && !memberReason && held))
      heldForHostAdmin.push({ userId: occ.userId, generation: occ.generation, frozenAtScan: frozenHold,
        endedServerIds: [...new Set([...occ.hold?.endedServerIds ?? [], ...endedOn])].sort(), traceServerIds: traceServers,
        releasedServerIds: releasedServers });
    const results = occ.traces.map(trace => {
      const result = (outcome: JointRecoveryTupleOutcome | "write", reason: string) =>
        ({ userId: occ.userId, generation: occ.generation, serverId: trace.serverId, outcome, reason });
      const releasedTrace = releasedServers.includes(trace.serverId);
      if (frozenHold && !releasedTrace) return result("held_for_host_admin", "held_at_scan");
      if (releasedTrace && endedSinceScan.length) return result("held_for_host_admin", "ended_source_changed_since_decision");
      // A joint gone at write time was not what was scanned and approved.
      if (!present) return result("changed_since_scan", "joint_missing");
      if (memberReason) return result("not_member", memberReason);
      if (held && !releasedTrace) return result("held_for_host_admin", "ended_source_with_trace_elsewhere");
      // R2: never over or beside an existing row for this exact tuple, any kind or state.
      const existing = current.find(row => row.serverId === trace.serverId);
      if (existing) return result("skipped_conflict", `existing_${existing.kind}${existing.ended ? "_ended" : ""}`);
      // R3a: the target must still be a place this person can have a live source.
      const target = targets.get(`${occ.userId}/${trace.serverId}`);
      if (joint?.status !== "active") return result("skipped_invalid_target", "joint_not_active");
      if (!target || target.projection !== "active" || !target.channelLive) return result("skipped_invalid_target", "projection_not_active");
      if (target.serverDeleted !== false) return result("skipped_invalid_target", "server_deleted");
      if (!target.role || target.role === "guest") return result("skipped_invalid_target", target.role ? "guest" : "not_server_member");
      // R6: same connection and same server membership as at scan time, or nothing.
      if (!trace.projection || trace.projection.localChannelId !== target.localChannelId || trace.projection.joinedAt !== target.projectionJoinedAt)
        return result("changed_since_scan", "projection_changed");
      if (trace.serverMemberJoinedAt !== target.memberJoinedAt) return result("changed_since_scan", "server_membership_changed");
      return result("write", releasedTrace ? "released_by_decision" : "recoverable");
    });
    tuples.push(...results);
    const liveAnywhere = current.some(row => row.live === true);
    if (present && !memberReason && !held && !liveAnywhere && !results.some(row => row.outcome === "write" || row.outcome === "changed_since_scan"))
      needsHostAdmin.push({ userId: occ.userId, generation: occ.generation, reasons: results.map(row => `${row.serverId}:${row.reason}`) });
  }
  return { jointId: plan.jointId, tuples, needsHostAdmin, heldForHostAdmin };
}

type JointRecoveryEvaluation = Awaited<ReturnType<typeof evaluateJointSourceRecovery>>;
function recoveryReceipt(plan: JointRecoveryPlan, evaluation: JointRecoveryEvaluation, writeOutcome: "would_write" | "written",
  inserted?: ReadonlySet<string>, decisionRef?: string) {
  const tuples: JointRecoveryTupleResult[] = evaluation.tuples.map(row => row.outcome !== "write" ? row as JointRecoveryTupleResult
    : !inserted ? { ...row, outcome: writeOutcome }
      : inserted.has(`${row.userId}/${row.serverId}`) ? { ...row, outcome: "written" } : { ...row, outcome: "skipped_conflict", reason: "existing_row_at_insert" });
  const counts: Record<string, number> = Object.fromEntries([writeOutcome, ...JOINT_RECOVERY_TUPLE_OUTCOMES.filter(o => o !== "written")]
    .map(outcome => [outcome, tuples.filter(row => row.outcome === outcome).length]));
  counts.needs_host_admin = evaluation.needsHostAdmin.length;
  counts.held_occurrences = evaluation.heldForHostAdmin.length;
  return { jointId: plan.jointId, planDigest: jointRecoveryPlanDigest(plan), sourcePreviewDigest: plan.sourcePreviewDigest,
    counts, tuples, needsHostAdmin: evaluation.needsHostAdmin, heldForHostAdmin: evaluation.heldForHostAdmin,
    ...decisionRef ? { decisionRef } : {} };
}

/** run-id and approval reference are stored in joint_admission_recoveries; both are required. */
export function assertRecoveryApplyAuthority(input: { runId?: string | null; approvalRef?: string | null }) {
  if (!input.runId?.trim() || !input.approvalRef?.trim())
    throw new JointMembershipOpsError("source-recovery-apply requires --run-id and --approval-reference");
}

/** In every write transaction: never a replica or a read-only session. */
async function requireWritablePrimary(tx: DatabaseExecutor) {
  const state = (await withPhase("primary_guard", () => tx.execute<{ replica: boolean; readOnly: string }>(sql`
    SELECT pg_is_in_recovery() replica,current_setting('transaction_read_only') AS "readOnly"`))).rows[0];
  if (state?.replica !== false || state.readOnly !== "off")
    throw new JointMembershipOpsError("source-recovery-apply requires a writable primary; refusing a replica or read-only connection", "terminal", { phase: "primary_guard" });
}

/** Caller owns one READ COMMITTED write transaction. Lock order is the
 * ordinary admission paths': admission source locks (server FOR SHARE, its
 * members FOR KEY SHARE, per target server in id order), the joint membership
 * flag read lock, then J. Everything is re-read after J; nothing is locked after it. */
export async function applyJointSourceRecovery(tx: DatabaseExecutor, plan: JointRecoveryPlan,
  options: { runId: string; approvalRef: string; checkWindow?: () => void; releases?: JointRecoveryReleases }) {
  assertRecoveryApplyAuthority(options);
  const checkWindow = () => {
    try { options.checkWindow?.(); }
    catch (error) { throw new JointMembershipOpsError("Approved write window check failed", "terminal", { cause: error, phase: "write_window" }); }
  };
  await requireWritablePrimary(tx);
  checkWindow();
  const byServer = new Map<string, string[]>();
  for (const occ of plan.occurrences) for (const trace of occ.traces)
    byServer.set(trace.serverId, [...byServer.get(trace.serverId) ?? [], occ.userId]);
  for (const serverId of [...byServer.keys()].sort())
    await withPhase("source_lock", () => lockJointHumanAdmissionSource(tx, serverId, byServer.get(serverId)!));
  await withPhase("flag_lock", () => acquireJointSourceExitFlagReadLock(tx));
  await withPhase("joint_lock", () => tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`joint-human-membership:${plan.jointId}`},0))`));
  const evaluation = await withPhase("recovery_evaluate", () => evaluateJointSourceRecovery(tx, plan, options.releases?.keys.get(plan.jointId)));
  checkWindow();
  const toWrite = evaluation.tuples.filter(row => row.outcome === "write");
  const J = sql`${plan.jointId}::uuid`;
  type Key = { userId: string; serverId: string; generation: number };
  const values = (rows: readonly Key[]) => sql.join(rows.map(row => sql`(${row.userId}::uuid,${row.serverId}::uuid,${row.generation}::integer)`), sql`, `);
  const admissions = toWrite.length ? (await withPhase("recovery_insert", () => tx.execute<Key & { kind: string; admittedBy: string | null; admittedAt: string }>(sql`
    INSERT INTO joint_channel_admissions (joint_channel_id,user_id,server_id,generation,admitted_by,admitted_at,kind)
    SELECT ${J},v.user_id,v.server_id,v.generation,NULL::uuid,now(),'recovery'
    FROM (VALUES ${values(toWrite)}) v(user_id,server_id,generation)
    ON CONFLICT (joint_channel_id,user_id,generation,server_id) DO NOTHING
    RETURNING user_id AS "userId",server_id AS "serverId",generation,kind,admitted_by AS "admittedBy",${utc(sql`admitted_at`)} AS "admittedAt"`))).rows : [];
  // R2: the provenance row in the same transaction; any failure rolls back both.
  const recoveries = admissions.length ? (await withPhase("recovery_insert", () => tx.execute<Key & { runId: string; approvalRef: string; recordedAt: string }>(sql`
    INSERT INTO joint_admission_recoveries (joint_channel_id,user_id,generation,server_id,run_id,approval_ref)
    SELECT ${J},v.user_id,v.generation,v.server_id,${options.runId},${options.approvalRef}
    FROM (VALUES ${values(admissions)}) v(user_id,server_id,generation)
    RETURNING user_id AS "userId",server_id AS "serverId",generation,run_id AS "runId",approval_ref AS "approvalRef",${utc(sql`recorded_at`)} AS "recordedAt"`))).rows : [];
  const keyOf = (row: Key) => `${row.userId}/${row.serverId}`;
  const inserted = new Set(admissions.map(keyOf));
  if (recoveries.length !== admissions.length || recoveries.some(row => !inserted.has(keyOf(row))))
    throw new JointMembershipOpsError("Recovery provenance does not match the written sources; rolling back joint", "integrity_changed", { phase: "recovery_verify" });
  if (admissions.length) {
    const live = (await withPhase("recovery_verify", () => tx.execute<{ live: boolean }>(sql`
      SELECT ${jointHumanCurrentSourceSql(J, sql`v.user_id`, sql`v.server_id`)} AS live
      FROM (VALUES ${values(admissions)}) v(user_id,server_id,generation)`))).rows;
    if (live.length !== admissions.length || live.some(row => row.live !== true))
      throw new JointMembershipOpsError("A written recovery source is not live; rolling back joint", "integrity_changed", { phase: "recovery_verify" });
  }
  checkWindow();
  const normalize = <T extends Key>(rows: T[]) => rows.map(row => ({ ...row, generation: Number(row.generation) }))
    .sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  return { ...recoveryReceipt(plan, evaluation, "written", inserted, options.releases?.decisionRef), runId: options.runId, approvalRef: options.approvalRef,
    receipts: { admissions: normalize(admissions), recoveries: normalize(recoveries) } };
}

export function runJointSourceRecoveryPlan(db: Database, jointId: string, options: { requireReplica?: boolean; evidenceRowCap?: number } = {}) {
  return readOnlySourceSnapshot(db, options.requireReplica === true, "recovery_plan", async tx => {
    const planned = await planJointSourceRecovery(tx, jointId, { evidenceRowCap: options.evidenceRowCap });
    const evaluation = await evaluateJointSourceRecovery(tx, planned.plan);
    return { status: planned.status, planned: planned.planned, plan: planned.plan,
      noLiveSourceCount: planned.sourcePreview.noLiveSourceCount, ...recoveryReceipt(planned.plan, evaluation, "would_write") };
  });
}
/** Joints per prefilter query; a scan page (--limit, up to 2,000) runs one query per batch. */
export const RECOVERY_PREFILTER_BATCH = 200;
export const MAX_RECOVERY_PREFILTER_SCAN_LIMIT = 2000;

/** Scan prefilter, inside a READ ONLY snapshot: the subset of jointIds that can
 * have a recovery occurrence. A SUPERSET of the joints for which
 * planJointSourceRecovery returns planned=true with at least one occurrence:
 *
 * planned requires an active joint; joint status is not checked here (wider).
 *
 * Occurrences come only from previewJointSources over joint_channel_members m:
 * R1, noLiveSource: m has no tuple classified "live". "live" needs the admission of exactly (J, m.user, S,
 *   m.generation) with jointHumanCurrentSourceSql(J, m.user, S) true (which is
 *   also false while a removal is pending). So R1 implies (a): no admission
 *   row a of (J, m.user, generation = m.generation) has
 *   jointHumanCurrentSourceSql(J, m.user, a.server_id). Same predicate, negated.
 * R4, a computed_ch or invite_evidence tuple (m.user, S): classify reaches those
 *   only with no admission of (J, m.user, S, m.generation) (any state, so not
 *   live/stale/ended), and with CH evidence on S or invite evidence on S. (b)
 *   takes exactly the preview's evidence rows (same joins: CH via any projection
 *   of J; channel_external_invites via the host projection with
 *   connected_server_ids / accepted_server_id fallback; accepted
 *   joint_channel_invites by accepted_by_user_id to to_server_id) joined to m,
 *   with that NOT EXISTS. It ignores removal-pending, pre-flag CH and
 *   joinerProvable, each of which only removes tuples from R4 (wider).
 * A joint with neither (a) nor (b) for any member has zero occurrences. Its
 * evidence caps and 10 s snapshot budget are not checked here: a clean joint
 * that would have failed as oversized is skipped instead (it has nothing to plan).
 *
 * Every join is index-driven from joint_channel_id = ANY(batch): the
 * joint_channel_members / joint_channel_admissions / joint_channel_servers
 * primary keys, channel_humans (channel_id, user_id) and
 * idx_channel_external_invites_channel. joint_channel_invites has no
 * joint_channel_id index (the per-J preview scans it too): one scan per batch. */
export async function prefilterJointSourceRecoveryCandidates(tx: DatabaseExecutor, jointIds: readonly string[]) {
  const ids = [...new Set(jointIds.map(id => id.toLowerCase()))].sort();
  if (!ids.length) return { candidates: [] as string[] };
  if (ids.length > RECOVERY_PREFILTER_BATCH) throw new JointMembershipOpsError(`At most ${RECOVERY_PREFILTER_BATCH} joints per prefilter batch`);
  const page = sql`ANY(${sql.param(ids)}::uuid[])`;
  const rows = (await tx.execute<{ jointId: string }>(sql`
    WITH member AS MATERIALIZED (
      SELECT m.joint_channel_id,m.user_id,m.generation FROM joint_channel_members m WHERE m.joint_channel_id=${page}
    ), evidence AS (
      SELECT p.joint_channel_id,ch.user_id,p.server_id
      FROM joint_channel_servers p JOIN channel_humans ch ON ch.channel_id=p.local_channel_id
      WHERE p.joint_channel_id=${page}
      UNION ALL
      SELECT hp.joint_channel_id,i.accepted_user_id,x.server_id
      FROM joint_channel_servers hp
      JOIN channel_external_invites i ON i.channel_id=hp.local_channel_id AND i.host_server_id=hp.server_id
      CROSS JOIN LATERAL unnest(CASE WHEN cardinality(i.connected_server_ids)=0 AND i.accepted_server_id IS NOT NULL
        THEN ARRAY[i.accepted_server_id] ELSE i.connected_server_ids END) AS x(server_id)
      WHERE hp.joint_channel_id=${page}
      UNION ALL
      SELECT i.joint_channel_id,i.accepted_by_user_id,i.to_server_id FROM joint_channel_invites i
      WHERE i.joint_channel_id=${page} AND i.status='accepted'
    )
    SELECT m.joint_channel_id AS "jointId" FROM member m
    WHERE NOT EXISTS (SELECT 1 FROM joint_channel_admissions a
      WHERE a.joint_channel_id=m.joint_channel_id AND a.user_id=m.user_id AND a.generation=m.generation
        AND ${jointHumanCurrentSourceSql(sql`m.joint_channel_id`, sql`m.user_id`, sql`a.server_id`)})
    UNION
    SELECT e.joint_channel_id FROM evidence e
    JOIN member m ON m.joint_channel_id=e.joint_channel_id AND m.user_id=e.user_id
    WHERE NOT EXISTS (SELECT 1 FROM joint_channel_admissions a
      WHERE a.joint_channel_id=e.joint_channel_id AND a.user_id=e.user_id AND a.generation=m.generation AND a.server_id=e.server_id)`)).rows;
  const evidence = new Set(rows.map(row => row.jointId));
  return { candidates: ids.filter(id => evidence.has(id)) };
}
export function runJointSourceRecoveryPrefilter(db: Database, jointIds: readonly string[], options: { requireReplica?: boolean } = {}) {
  return readOnlySourceSnapshot(db, options.requireReplica === true, "recovery_prefilter", tx => prefilterJointSourceRecoveryCandidates(tx, jointIds));
}

export function runJointSourceRecoveryPreview(db: Database, plan: JointRecoveryPlan,
  options: { requireReplica?: boolean; releases?: JointRecoveryReleases } = {}) {
  return readOnlySourceSnapshot(db, options.requireReplica === true, "recovery_evaluate",
    async tx => recoveryReceipt(plan, await evaluateJointSourceRecovery(tx, plan, options.releases?.keys.get(plan.jointId)),
      "would_write", undefined, options.releases?.decisionRef));
}
export async function runJointSourceRecoveryApply(db: Database, plan: JointRecoveryPlan,
  options: { runId: string; approvalRef: string; checkWindow?: () => void; releases?: JointRecoveryReleases }) {
  assertRecoveryApplyAuthority(options);
  const execution = await retryTransient(() => withPhase("transaction", () => db.transaction(async tx => {
    await setupOpsTransaction(tx, "write");
    return applyJointSourceRecovery(tx, plan, options);
  })));
  return { ...execution.value, attempts: execution.attempts };
}

/** The --tuples-file of both recovery modes: {format, joints: [plan, ...]},
 * each plan exactly as source-recovery-preview's scan emits it (receipt.plan). */
export function parseJointRecoveryPlans(value: unknown): JointRecoveryPlan[] {
  const fail = (what: string): never => { throw new JointMembershipOpsError(`Invalid recovery tuples file: ${what}`); };
  const file = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  if (file.format !== JOINT_RECOVERY_FORMAT) fail(`format must be "${JOINT_RECOVERY_FORMAT}"`);
  if (!Array.isArray(file.joints)) fail("joints must be an array");
  const joints = file.joints as unknown[];
  if (joints.length > MAX_RECOVERY_JOINTS) fail(`at most ${MAX_RECOVERY_JOINTS} joints per invocation; split the batch`);
  const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
  const stamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
  const id = (v: unknown, what: string) => typeof v === "string" && uuid.test(v) ? v.toLowerCase() : fail(`${what} must be a UUID`);
  const at = (v: unknown, what: string) => v === null ? null : typeof v === "string" && stamp.test(v) ? v : fail(`${what} must be a scan timestamp or null`);
  const seenJoints = new Set<string>();
  return joints.map(raw => {
    const j = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const jointId = id(j.jointId, "jointId");
    if (seenJoints.has(jointId)) fail("duplicate joint");
    seenJoints.add(jointId);
    if (typeof j.sourcePreviewDigest !== "string" || !/^[a-f0-9]{64}$/.test(j.sourcePreviewDigest)) fail("sourcePreviewDigest must be a SHA-256");
    if (!Array.isArray(j.occurrences)) fail("occurrences must be an array");
    const seenUsers = new Set<string>();
    let count = 0;
    const occurrences = (j.occurrences as unknown[]).map(rawOcc => {
      const o = (typeof rawOcc === "object" && rawOcc !== null ? rawOcc : {}) as Record<string, unknown>;
      const userId = id(o.userId, "userId");
      if (seenUsers.has(userId)) fail("duplicate occurrence");
      seenUsers.add(userId);
      if (!Number.isInteger(o.generation) || (o.generation as number) < 1) fail("generation must be a positive integer");
      if (!Array.isArray(o.traces)) fail("traces must be an array");
      const h = o.hold as Record<string, unknown> | null | undefined;
      if (h === undefined) fail("hold is required (null or the scan-time hold)");
      const hold = h === null || h === undefined ? null : (() => {
        if (typeof h !== "object" || h.reason !== "ended_source" || !Array.isArray(h.endedServerIds) || !Array.isArray(h.endedAt)
          || h.endedServerIds.length === 0 || h.endedServerIds.length !== h.endedAt.length) fail("hold must be null or {reason:\"ended_source\",endedServerIds,endedAt}");
        return { reason: "ended_source" as const, endedServerIds: (h.endedServerIds as unknown[]).map(v => id(v, "hold.endedServerIds")),
          endedAt: (h.endedAt as unknown[]).map(v => at(v, "hold.endedAt") ?? fail("hold.endedAt is required")) };
      })();
      const seenServers = new Set<string>();
      const traces = (o.traces as unknown[]).map(rawTrace => {
        const t = (typeof rawTrace === "object" && rawTrace !== null ? rawTrace : {}) as Record<string, unknown>;
        const serverId = id(t.serverId, "serverId");
        if (seenServers.has(serverId)) fail("duplicate trace");
        seenServers.add(serverId);
        if (!JOINT_RECOVERY_TRACE_CATEGORIES.includes(t.category as JointRecoveryTraceCategory)) fail("category must be computed_ch or invite_evidence");
        const p = t.projection as Record<string, unknown> | null | undefined;
        if (p !== null && (typeof p !== "object" || p === undefined)) fail("projection must be an object or null");
        return { serverId: asServerId(serverId), category: t.category as JointRecoveryTraceCategory,
          projection: p ? { localChannelId: id(p.localChannelId, "projection.localChannelId"), joinedAt: at(p.joinedAt, "projection.joinedAt") ?? fail("projection.joinedAt is required") } : null,
          serverMemberJoinedAt: at(t.serverMemberJoinedAt, "serverMemberJoinedAt") };
      });
      count += traces.length;
      return { userId: userId as JointOpsHumanId, generation: o.generation as number, hold, traces };
    });
    if (count > MAX_RECOVERY_TUPLES_PER_JOINT) fail(`at most ${MAX_RECOVERY_TUPLES_PER_JOINT} tuples per joint`);
    return sortPlan({ jointId: jointId as JointOpsJointId, sourcePreviewDigest: j.sourcePreviewDigest as JointPreviewDigest, occurrences });
  });
}

export type JointRecoveryReleases = { decisionRef: string; keys: JointRecoveryReleaseKeys };

/** The --release-file: {format, releases: [{jointId,userId,generation,serverId}]}.
 * Every release must name a frozen hold in the recovery file and one of that
 * occurrence's trace servers, never a server whose source ended. Anything else
 * refuses the whole run before a connection is opened. */
export function bindJointRecoveryReleases(value: unknown, plans: readonly JointRecoveryPlan[], decisionRef: string | undefined): JointRecoveryReleases {
  const fail = (what: string): never => { throw new JointMembershipOpsError(`Invalid recovery release file: ${what}`); };
  if (!decisionRef?.trim()) throw new JointMembershipOpsError("a release file requires --decision-reference");
  const file = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  if (file.format !== JOINT_RECOVERY_RELEASE_FORMAT) fail(`format must be "${JOINT_RECOVERY_RELEASE_FORMAT}"`);
  if (!Array.isArray(file.releases) || file.releases.length === 0) fail("releases must be a non-empty array");
  const raw = file.releases as unknown[];
  if (raw.length > MAX_RECOVERY_RELEASES) fail(`at most ${MAX_RECOVERY_RELEASES} releases`);
  const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
  const id = (v: unknown, what: string) => typeof v === "string" && uuid.test(v) ? v.toLowerCase() : fail(`${what} must be a UUID`);
  const byJoint = new Map(plans.map(plan => [plan.jointId as string, plan]));
  const keys = new Map<string, Set<string>>();
  for (const entry of raw) {
    const r = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
    const jointId = id(r.jointId, "jointId"), userId = id(r.userId, "userId"), serverId = id(r.serverId, "serverId");
    if (!Number.isInteger(r.generation) || (r.generation as number) < 1) fail("generation must be a positive integer");
    const generation = r.generation as number;
    const occ = byJoint.get(jointId)?.occurrences.find(o => o.userId === userId && o.generation === generation);
    if (!occ) fail("release names no occurrence of the recovery file");
    if (!occ!.hold) fail("release names an occurrence that is not held; nothing to release");
    if (occ!.hold!.endedServerIds.includes(serverId)) fail("an ended source is never revived; release a trace server, not S");
    if (!occ!.traces.some(t => t.serverId === serverId)) fail("release names a server with no trace for this occurrence");
    const set = keys.get(jointId) ?? new Set<string>();
    const key = releaseKey(userId, generation, serverId);
    if (set.has(key)) fail("duplicate release");
    keys.set(jointId, set.add(key));
  }
  return { decisionRef: decisionRef!.trim(), keys };
}

async function main() {
  const { values } = parseArgs({ options: {
    help: { type: "boolean" }, mode: { type: "string" }, environment: { type: "string" },
    "joint-id": { type: "string", multiple: true }, after: { type: "string" }, through: { type: "string" },
    limit: { type: "string", default: "10" }, "run-id": { type: "string" },
    "approval-reference": { type: "string" }, "window-start": { type: "string" }, "window-end": { type: "string" },
    "tuples-file": { type: "string" }, "tuples-file-digest": { type: "string" }, "evidence-row-cap": { type: "string" },
    "no-prefilter": { type: "boolean" }, "release-file": { type: "string" }, "release-file-digest": { type: "string" },
    "decision-reference": { type: "string" },
  } });
  if (values.help) {
    console.log("joint-human-membership-ops.ts --environment staging|production --mode source-preview|source-verify|source-recovery-preview|source-recovery-apply [--after UUID --through UUID --limit 10] [--run-id ID] [--approval-reference MESSAGE --window-start ISO --window-end ISO] [--tuples-file PATH (source-verify, source-recovery-*)] [--tuples-file-digest SHA256 (source-recovery-apply)] [--evidence-row-cap 1..20000 (source-preview and the source-recovery-preview scan; lower only)] [--no-prefilter (source-recovery-preview scan only)] [--release-file PATH --decision-reference MESSAGE (with a recovery --tuples-file) --release-file-digest SHA256 (source-recovery-apply)]\nsource-preview and the source-recovery-preview scan read active joints by cursor only (no --joint-id); source-preview, source-verify and source-recovery-preview are read-only. The source-recovery-preview scan prefilters candidate joints (--limit up to 2000; --no-prefilter plans every joint, --limit up to 100). source-recovery-apply writes only the tuples of a recovery file (at most 100 joints) and requires --run-id, --approval-reference and the file's SHA-256. A release file lifts frozen R5 holds for the named trace servers only, after a host-side decision.\nRead: JOINT_MEMBERSHIP_READ_DATABASE_URL; source-recovery-apply: JOINT_MEMBERSHIP_WRITE_DATABASE_URL. See docs/development/reports/joint-membership-ops.md. Flags never grant production authority.");
    return;
  }
  const mode = values.mode;
  if (mode !== "source-preview" && mode !== "source-verify" && mode !== "source-recovery-preview" && mode !== "source-recovery-apply")
    throw new JointMembershipOpsError("mode must be source-preview, source-verify, source-recovery-preview or source-recovery-apply");
  const recoveryApply = mode === "source-recovery-apply";
  const recoveryFile = (mode === "source-recovery-preview" || recoveryApply) && values["tuples-file"] !== undefined;
  const recoveryScan = mode === "source-recovery-preview" && !recoveryFile;
  const readOnlySourceMode = mode === "source-preview" || mode === "source-verify" || mode === "source-recovery-preview";
  const writeMode = recoveryApply;
  if (values["no-prefilter"] && !recoveryScan) throw new JointMembershipOpsError("no-prefilter is only valid for the source-recovery-preview scan");
  const prefilter = recoveryScan && !values["no-prefilter"];
  if (readOnlySourceMode && (values["run-id"] || values["approval-reference"] || values["window-start"] || values["window-end"]))
    throw new JointMembershipOpsError("source modes are read-only and take no run-id or write window");
  if ((mode === "source-preview" || recoveryScan) && (values["joint-id"]?.length || values["tuples-file"]))
    throw new JointMembershipOpsError(`${mode} is a fresh scan: use --after/--through/--limit, not --joint-id`);
  if (mode === "source-verify" && (!values["tuples-file"] || values["joint-id"]?.length || values.after || values.through))
    throw new JointMembershipOpsError("source-verify requires --tuples-file and no joint selection or cursor");
  if (recoveryFile && (values["joint-id"]?.length || values.after || values.through))
    throw new JointMembershipOpsError("a recovery tuples file is the whole scope: no joint selection or cursor");
  if (recoveryApply) {
    if (!recoveryFile || !/^[a-f0-9]{64}$/.test(values["tuples-file-digest"] ?? ""))
      throw new JointMembershipOpsError("source-recovery-apply requires --tuples-file and its --tuples-file-digest SHA256");
    assertRecoveryApplyAuthority({ runId: values["run-id"], approvalRef: values["approval-reference"] });
  } else if (values["tuples-file-digest"] !== undefined) throw new JointMembershipOpsError("tuples-file-digest is only valid for source-recovery-apply");
  if ((values["release-file"] !== undefined || values["decision-reference"] !== undefined) && !recoveryFile)
    throw new JointMembershipOpsError("release-file and decision-reference are only valid with a recovery --tuples-file");
  if (values["release-file"] === undefined && (values["decision-reference"] !== undefined || values["release-file-digest"] !== undefined))
    throw new JointMembershipOpsError("decision-reference and release-file-digest require --release-file");
  if (values["release-file"] !== undefined && recoveryApply && !/^[a-f0-9]{64}$/.test(values["release-file-digest"] ?? ""))
    throw new JointMembershipOpsError("source-recovery-apply with a release file requires its --release-file-digest SHA256");
  if (values["release-file-digest"] !== undefined && !recoveryApply) throw new JointMembershipOpsError("release-file-digest is only valid for source-recovery-apply");
  if (values["tuples-file"] && mode !== "source-verify" && !recoveryFile) throw new JointMembershipOpsError("tuples-file is only valid for source-verify and the source-recovery modes");
  if (values["evidence-row-cap"] !== undefined && mode !== "source-preview" && !recoveryScan)
    throw new JointMembershipOpsError("evidence-row-cap is only valid for source-preview and the source-recovery-preview scan");
  const evidenceRowCap = Number(values["evidence-row-cap"] ?? MAX_SOURCE_EVIDENCE_ROWS);
  if (!Number.isInteger(evidenceRowCap) || evidenceRowCap < 1 || evidenceRowCap > MAX_SOURCE_EVIDENCE_ROWS)
    throw new JointMembershipOpsError(`evidence-row-cap must be 1..${MAX_SOURCE_EVIDENCE_ROWS}`);
  if (values.environment !== "staging" && values.environment !== "production") throw new JointMembershipOpsError("Explicit environment staging or production required");
  const production = values.environment === "production";
  const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
  for (const id of [...(values["joint-id"] ?? []), ...(values.after ? [values.after] : []), ...(values.through ? [values.through] : [])])
    if (!uuid.test(id)) throw new JointMembershipOpsError("Invalid joint UUID");
  const limit = Number(values.limit);
  const maxLimit = prefilter ? MAX_RECOVERY_PREFILTER_SCAN_LIMIT : 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) throw new JointMembershipOpsError(`limit must be 1..${maxLimit}`);
  if (values["joint-id"]?.length) throw new JointMembershipOpsError("--joint-id is not taken by the source modes");
  const window = { approval: values["approval-reference"], start: values["window-start"], end: values["window-end"] };
  if (production && writeMode) assertProductionWriteWindow(window);
  const recoveryBytes = recoveryFile ? await readFile(values["tuples-file"]!) : null;
  const recoveryFileDigest = recoveryBytes ? createHash("sha256").update(recoveryBytes).digest("hex") : null;
  if (recoveryApply && recoveryFileDigest !== values["tuples-file-digest"])
    throw new JointMembershipOpsError("tuples-file-digest does not match the file; apply only the reviewed file");
  const recoveryPlans = new Map(recoveryBytes
    ? parseJointRecoveryPlans(JSON.parse(recoveryBytes.toString("utf8")) as unknown).map(plan => [plan.jointId as string, plan]) : []);
  const releaseBytes = values["release-file"] !== undefined ? await readFile(values["release-file"]) : null;
  const releaseFileDigest = releaseBytes ? createHash("sha256").update(releaseBytes).digest("hex") : null;
  if (recoveryApply && releaseBytes && releaseFileDigest !== values["release-file-digest"])
    throw new JointMembershipOpsError("release-file-digest does not match the file; apply only the reviewed release");
  const releases = releaseBytes ? bindJointRecoveryReleases(JSON.parse(releaseBytes.toString("utf8")) as unknown,
    [...recoveryPlans.values()], values["decision-reference"]) : undefined;
  const verifyTuples = mode === "source-verify"
    ? parseJointSourceTuples(JSON.parse(await readFile(values["tuples-file"]!, "utf8")) as unknown) : [];
  const verifyByJoint = new Map<string, JointSourceTupleKey[]>();
  for (const tuple of verifyTuples) verifyByJoint.set(tuple.jointId, [...verifyByJoint.get(tuple.jointId) ?? [], tuple]);
  if (verifyByJoint.size > 100 || [...verifyByJoint.values()].some(list => list.length > MAX_VERIFY_TUPLES))
    throw new JointMembershipOpsError(`source-verify takes at most 100 joints and ${MAX_VERIFY_TUPLES} tuples per joint`);
  const databaseUrl = writeMode ? process.env.JOINT_MEMBERSHIP_WRITE_DATABASE_URL : process.env.JOINT_MEMBERSHIP_READ_DATABASE_URL;
  if (!databaseUrl) throw new JointMembershipOpsError("Explicit JOINT_MEMBERSHIP_READ_DATABASE_URL or JOINT_MEMBERSHIP_WRITE_DATABASE_URL required; no DATABASE_URL fallback");
  // Raw adapter: does not initialize the serving app, migrations or background jobs.
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000,
    statement_timeout: 5000, idle_in_transaction_session_timeout: 10_000 });
  attachJointOpsConnectionErrorHandlers(pool);
  const db = drizzle(pool, { schema });
  // Standalone SELECTs outside any write transaction: safe to re-run in every mode.
  const read = async <T>(work: () => Promise<T>) => (await retryTransient(work, { readOnly: true })).value;
  try {
    const state = await read(() => pool.query<{ replica: boolean; replayAt: Date | null }>("SELECT pg_is_in_recovery() replica,pg_last_xact_replay_timestamp() AS \"replayAt\""));
    const endpoint = state.rows[0];
    if (!endpoint || (production && (writeMode ? endpoint.replica : !endpoint.replica)))
      throw new JointMembershipOpsError("A production read requires a read replica; source-recovery-apply requires the primary");
    const through = values.through ?? (await read(() => pool.query<{ id: string | null }>("SELECT id FROM joint_channels ORDER BY id DESC LIMIT 1"))).rows[0]?.id;
    const selected = mode === "source-verify" ? [...verifyByJoint.keys()].sort() : recoveryFile ? [...recoveryPlans.keys()].sort() : through ? (await read(() => db.execute<{ id: string }>(sql`
      SELECT id FROM joint_channels WHERE id<=${through}::uuid
        AND ${values.after ? sql`id>${values.after}::uuid` : sql`true`}
        AND ${mode === "source-preview" || recoveryScan ? sql`status='active'` : sql`true`}
      ORDER BY id LIMIT ${limit}`))).rows.map(row => row.id) : [];
    const sourceDigests: Array<{ jointId: string; digest: string }> = [];
    console.log(JSON.stringify({ event: "start", mode, environment: values.environment,
      runId: values["run-id"] ?? null, startedAt: new Date().toISOString(), through, tuplesFileDigest: recoveryFileDigest ?? undefined,
      releaseFileDigest: releaseFileDigest ?? undefined, decisionRef: releases?.decisionRef,
      prefilter: recoveryScan ? prefilter : undefined,
      replica: endpoint.replica, replayAt: endpoint.replayAt, approval: window.approval ?? null }));
    const recoveryTotals: Record<string, number> = {};
    const addTotals = (counts: Record<string, number>) => { for (const [key, n] of Object.entries(counts)) recoveryTotals[key] = (recoveryTotals[key] ?? 0) + n; };
    const failures: Array<{ jointId: string; category: string; attempts: number; sqlState: string | null; phase: JointOpsPhase | null; error: string }> = [];
    // Prefiltered scan: one candidate query per batch, in cursor order; null
    // means "plan every joint" (--no-prefilter, other modes, or a failed batch).
    const skipped: string[] = [];
    let prefilterFallbacks = 0, batchCandidates: Set<string> | null = null;
    for (const [index, jointId] of selected.entries()) {
      if (prefilter && index % RECOVERY_PREFILTER_BATCH === 0) {
        const batch = selected.slice(index, index + RECOVERY_PREFILTER_BATCH), started = performance.now();
        try {
          const result = await runJointSourceRecoveryPrefilter(db, batch, { requireReplica: production });
          batchCandidates = new Set(result.candidates);
          console.log(JSON.stringify({ event: "prefilter", first: batch[0], last: batch.at(-1), joints: batch.length,
            candidates: result.candidates.length, attempts: result.attempts, ms: Math.round(performance.now() - started) }));
        } catch (error) {
          // Never skip on a failed prefilter: plan the whole batch as --no-prefilter would.
          batchCandidates = null; prefilterFallbacks++;
          console.log(JSON.stringify({ event: "prefilter", status: "failed_planning_all", first: batch[0], last: batch.at(-1), joints: batch.length,
            category: error instanceof JointMembershipOpsError ? error.category : "database_error",
            attempts: error instanceof JointMembershipOpsError ? error.attempts : 1, sqlState: sqlStateOf(error),
            phase: error instanceof JointMembershipOpsError ? error.phase : null,
            error: error instanceof JointMembershipOpsError ? error.message : "database_operation_failed" }));
        }
      }
      if (prefilter && batchCandidates && !batchCandidates.has(jointId)) {
        skipped.push(jointId);
        console.log(JSON.stringify({ event: "joint", jointId, status: "skipped_no_candidate" }));
        continue;
      }
      try {
        if (production && writeMode) assertProductionWriteWindow(window);
        if (recoveryScan) {
          const receipt = await runJointSourceRecoveryPlan(db, jointId, { requireReplica: production, evidenceRowCap });
          sourceDigests.push({ jointId, digest: receipt.planDigest });
          addTotals(receipt.counts);
          console.log(JSON.stringify({ event: "joint", jointId, status: receipt.planned ? "planned" : `not_planned_${receipt.status}`, receipt }));
        } else if (recoveryFile) {
          const plan = recoveryPlans.get(jointId)!;
          const receipt = recoveryApply
            ? await runJointSourceRecoveryApply(db, plan, { runId: values["run-id"]!, approvalRef: values["approval-reference"]!,
              checkWindow: production ? () => assertProductionWriteWindow(window) : undefined, releases })
            : await runJointSourceRecoveryPreview(db, plan, { requireReplica: production, releases });
          const receiptDigest = digest(receipt.tuples);
          sourceDigests.push({ jointId, digest: receiptDigest });
          addTotals(receipt.counts);
          console.log(JSON.stringify({ event: "joint", jointId, status: recoveryApply ? "committed" : "evaluated", receipt: { ...receipt, digest: receiptDigest } }));
        } else if (mode === "source-preview") {
          const receipt = await runJointSourcePreview(db, jointId, { requireReplica: production, evidenceRowCap });
          sourceDigests.push({ jointId, digest: receipt.digest });
          console.log(JSON.stringify({ event: "joint", jointId, status: "previewed", receipt }));
        } else if (mode === "source-verify") {
          const receipt = await runJointSourceVerify(db, verifyByJoint.get(jointId) ?? [], { requireReplica: production });
          const verifyDigest = digest(receipt.results);
          sourceDigests.push({ jointId, digest: verifyDigest });
          console.log(JSON.stringify({ event: "joint", jointId, status: receipt.ok === receipt.checked ? "verified" : "mismatch", receipt: { ...receipt, digest: verifyDigest } }));
          if (receipt.ok !== receipt.checked) failures.push({ jointId, category: "source_verify_mismatch", attempts: receipt.attempts,
            sqlState: null, phase: "source_verify", error: "Tuples not live" });
        } else throw new JointMembershipOpsError("Unhandled mode");
      } catch (error) {
        // Driver errors may contain query/connection data. Only explicit operator
        // differences emit human IDs, never an interpolated driver error.
        const failure = { jointId, category: error instanceof JointMembershipOpsError ? error.category : "database_error",
          attempts: error instanceof JointMembershipOpsError ? error.attempts : 1,
          sqlState: sqlStateOf(error), phase: error instanceof JointMembershipOpsError ? error.phase : null,
          error: error instanceof JointMembershipOpsError ? error.message : "database_operation_failed" };
        failures.push(failure);
        console.log(JSON.stringify({ event: "joint", status: "failed", ...failure }));
        // A terminal J is retained in end.failures, not silently declared done;
        // unrelated joints continue. Re-run failed IDs explicitly after repair.
      }
    }
    const runReceipt = jointSourceRunReceipt({ mode, after: values.after ?? null, through: through ?? null,
      joints: sourceDigests, failures: failures.map(({ jointId, category }) => ({ jointId, category })),
      skipped: prefilter ? skipped : undefined });
    console.log(JSON.stringify({ event: "end", complete: failures.length === 0, selected: selected.length, failures,
      ...prefilter ? { scanned: selected.length - skipped.length, skipped: skipped.length, prefilterFallbacks } : {},
      nextAfter: recoveryFile ? null : selected.at(-1) ?? values.after ?? null, through, runReceipt,
      summary: mode === "source-recovery-preview" || recoveryApply ? recoveryTotals : undefined }));
    if (failures.length) process.exitCode = 1;
  } finally { await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch(error => {
    console.error(JSON.stringify({ event: "error", sqlState: sqlStateOf(error),
      phase: error instanceof JointMembershipOpsError ? error.phase : null,
      error: error instanceof JointMembershipOpsError ? error.message : "operation_failed" }));
    process.exitCode = 1;
  });
}
