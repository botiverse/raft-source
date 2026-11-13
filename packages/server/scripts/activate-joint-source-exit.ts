#!/usr/bin/env -S node --import=@oxc-node/core/register
// Offline operator tool: the only supported way to turn on joint_source_exit_v1.
// dry-run reads one REPEATABLE READ / READ ONLY snapshot (production: a read
// replica) and writes nothing. apply calls activateJointSourceExit exactly once,
// on the primary, inside one guarded transaction; it never retries a write and
// never creates the flag row. Conventions follow joint-human-membership-ops.ts
// (docs/development/reports/joint-membership-ops.md#activating-source-exit).
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { closeDatabase, getDb, initDatabase, type Database, type DatabaseExecutor } from "../src/db";
import * as schema from "../src/db/schema";
import {
  FeatureFlagConfigVersionConflictError,
  FeatureFlagRuleValidationError,
  FeatureFlagServerRuleAlreadyExistsError,
  evaluateFeatureFlag,
  getFeatureFlagConfigVersion,
  type FeatureFlagOperatorActor,
} from "../src/services/featureFlagService";
import { JOINT_SOURCE_EXIT_FEATURE_FLAG_KEY } from "../src/services/jointHumanMembershipAccess";
import {
  activateJointSourceExit,
  countJointMembersWithoutLiveSource,
  JointSourceExitActivationRefusedError,
} from "../src/services/jointSourceExitActivation";
import {
  JointMembershipOpsError,
  assertProductionWriteWindow,
  attachJointOpsConnectionErrorHandlers,
  retryTransient,
  sqlStateOf,
  transientKindOf,
  type JointOpsPhase,
} from "./joint-human-membership-ops";

const FLAG = JOINT_SOURCE_EXIT_FEATURE_FLAG_KEY;
export const MAX_ACTIVATION_HOSTS = 1000;
const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
function fail(message: string, category = "terminal", phase: JointOpsPhase | null = null): never {
  throw new JointMembershipOpsError(message, category, { phase });
}
async function inPhase<T>(phase: JointOpsPhase, work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof JointMembershipOpsError && error.phase) throw error;
    throw new JointMembershipOpsError(error instanceof JointMembershipOpsError ? error.message : "Database operation failed",
      error instanceof JointMembershipOpsError ? error.category : "database_error", { cause: error, phase });
  }
}

/** Lower-cased, de-duplicated, sorted, validated host ids. */
export function normalizeHostIds(ids: readonly string[]): string[] {
  for (const id of ids) if (!UUID.test(id)) fail("Invalid host server UUID");
  const hosts = [...new Set(ids.map((id) => id.toLowerCase()))].sort();
  if (hosts.length === 0) fail("At least one host is required");
  if (hosts.length > MAX_ACTIVATION_HOSTS) fail(`At most ${MAX_ACTIVATION_HOSTS} hosts per activation`);
  return hosts;
}

/** SHA-256 of the normalized host list: apply binds to exactly the reviewed list, in any input order. */
export function activationHostsDigest(ids: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(normalizeHostIds(ids))).digest("hex");
}

/**
 * --hosts-file's text: it must parse as JSON before parseActivationHostsFile
 * checks its shape. A file that isn't JSON (a JSON-lines dump, a dry-run end
 * record pasted with other output) gets a message saying what to give instead
 * of the generic operation_failed (Tenny, #wg-rbac 19b7a189).
 */
export function parseActivationHostsFileText(text: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail("hosts file is not valid JSON: give a JSON array of host server UUIDs, e.g. the dry-run end record's hostIds (jq -c 'select(.event==\"end\") | .hostIds')");
  }
  return parseActivationHostsFile(value);
}

/** --hosts-file: a JSON array of host server UUIDs (dry-run's end.hostIds). */
export function parseActivationHostsFile(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) fail("hosts file must be a JSON array of host server UUID strings (the dry-run end record's hostIds), not an object or other JSON");
  return normalizeHostIds(value as string[]);
}

/** Deterministic: the config-version row's last_audit_event_id names the run and approval that wrote it. */
export function activationAuditEventId(input: { runId: string; approvalRef: string; hostsDigest: string }): string {
  const h = createHash("sha256").update(`activate-joint-source-exit\n${input.runId}\n${input.approvalRef}\n${input.hostsDigest}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function parseActivationActor(value: string | undefined): FeatureFlagOperatorActor {
  const match = /^(human|agent):(.+)$/.exec(value ?? "");
  if (!match || !TOKEN.test(match[2]!)) return fail("--actor must be human:<id> or agent:<id> (letters, digits, ._:@/-)");
  return { type: match[1] as "human" | "agent", id: match[2]! };
}

/** An ACTIVE top-level joint: a joint record whose canonical channel is not a
 * sub-conversation (thread or task v2 conversation; isSubRecordType /
 * resolveParentJointId in jointChannelLimitState.ts). Sub-records carry their
 * own created_by_server_id (whoever first opened the thread or started the
 * task, possibly a participant), so they never name a host here. */
const ACTIVE_TOP_LEVEL_JOINT = sql`j.status='active' AND EXISTS (SELECT 1 FROM channels canon
  WHERE canon.id=j.canonical_channel_id AND canon.type NOT IN ('thread','task'))`;

/** Every non-deleted server that CREATED at least one active top-level joint.
 * joint_channels.created_by_server_id is what the flag is evaluated against
 * (resolveJointSourceExitJointIds, resolveJointHumanMembershipScopes) and what
 * countJointMembersWithoutLiveSource counts by: the host for this flag. No
 * live local projection is required. */
async function activeTopLevelJointHosts(tx: DatabaseExecutor) {
  return (await tx.execute<{ id: string }>(sql`
    SELECT DISTINCT j.created_by_server_id AS id
    FROM joint_channels j JOIN servers s ON s.id=j.created_by_server_id AND s.deleted_at IS NULL
    WHERE ${ACTIVE_TOP_LEVEL_JOINT}
    ORDER BY 1`)).rows.map((row) => row.id);
}

export const MAX_HOST_MISMATCH_ROWS = 1000;
/** Active top-level joints whose creator is not exactly their role='host'
 * projection server (no host projection, another server's, or several), for
 * the operator to see; selection itself follows the creator. */
async function creatorRoleHostMismatches(tx: DatabaseExecutor) {
  const rows = (await tx.execute<{ jointId: string; creatorServerId: string; roleHostServerIds: string[] | null }>(sql`
    SELECT j.id AS "jointId", j.created_by_server_id AS "creatorServerId",
      (SELECT array_agg(jcs.server_id::text ORDER BY jcs.server_id) FROM joint_channel_servers jcs
        WHERE jcs.joint_channel_id=j.id AND jcs.role='host') AS "roleHostServerIds"
    FROM joint_channels j
    WHERE ${ACTIVE_TOP_LEVEL_JOINT}
      AND (SELECT array_agg(jcs.server_id ORDER BY jcs.server_id) FROM joint_channel_servers jcs
        WHERE jcs.joint_channel_id=j.id AND jcs.role='host') IS DISTINCT FROM ARRAY[j.created_by_server_id]
    ORDER BY j.id LIMIT ${MAX_HOST_MISMATCH_ROWS + 1}`)).rows;
  const joints = rows.slice(0, MAX_HOST_MISMATCH_ROWS).map((row) => ({ ...row, roleHostServerIds: row.roleHostServerIds ?? [] }));
  // Server-level difference over all active top-level joints.
  const servers = (await tx.execute<{ serverId: string; creator: boolean; roleHost: boolean }>(sql`
    WITH c AS (SELECT DISTINCT j.created_by_server_id AS server_id FROM joint_channels j WHERE ${ACTIVE_TOP_LEVEL_JOINT}),
      r AS (SELECT DISTINCT jcs.server_id FROM joint_channel_servers jcs JOIN joint_channels j ON j.id=jcs.joint_channel_id
        WHERE jcs.role='host' AND ${ACTIVE_TOP_LEVEL_JOINT})
    SELECT coalesce(c.server_id, r.server_id) AS "serverId", c.server_id IS NOT NULL AS creator, r.server_id IS NOT NULL AS "roleHost"
    FROM c FULL JOIN r ON r.server_id=c.server_id
    WHERE c.server_id IS NULL OR r.server_id IS NULL ORDER BY 1`)).rows;
  return { joints, truncated: rows.length > MAX_HOST_MISMATCH_ROWS,
    creatorNotRoleHost: servers.filter((row) => row.creator).map((row) => row.serverId),
    roleHostNotCreator: servers.filter((row) => row.roleHost).map((row) => row.serverId) };
}

export type ActivationHost = { id: string; exists: boolean; deleted: boolean; slug: string | null; name: string | null; activeTopLevelJoints: number };
async function describeHosts(tx: DatabaseExecutor, hosts: readonly string[]): Promise<ActivationHost[]> {
  const rows = (await tx.execute<{ id: string; deleted: boolean; slug: string; name: string; joints: number }>(sql`
    SELECT s.id, s.deleted_at IS NOT NULL AS deleted, s.slug, s.name,
      (SELECT count(*)::int FROM joint_channels j WHERE j.created_by_server_id=s.id AND ${ACTIVE_TOP_LEVEL_JOINT}) AS joints
    FROM servers s WHERE s.id IN (${sql.join(hosts.map((id) => sql`${id}::uuid`), sql`, `)})`)).rows;
  const byId = new Map(rows.map((row) => [row.id, row]));
  return hosts.map((id) => {
    const row = byId.get(id);
    return row ? { id, exists: true, deleted: row.deleted, slug: row.slug, name: row.name, activeTopLevelJoints: Number(row.joints) }
      : { id, exists: false, deleted: false, slug: null, name: null, activeTopLevelJoints: 0 };
  });
}

async function readFlagState(tx: DatabaseExecutor) {
  const flag = (await tx.execute<{ enabled: boolean; killSwitch: boolean; defaultEnabled: boolean; randomizationUnit: string }>(sql`
    SELECT enabled, kill_switch AS "killSwitch", default_enabled AS "defaultEnabled", randomization_unit AS "randomizationUnit"
    FROM feature_flags WHERE key=${FLAG}`)).rows[0] ?? null;
  const rules = (await tx.execute<{ id: string; stage: string; priority: number; decision: string; values: string[];
    percentageBasisPoints: number | null; variant: string | null }>(sql`
    SELECT id, stage, priority, decision, "values", percentage_basis_points AS "percentageBasisPoints", variant
    FROM feature_flag_rules WHERE flag_key=${FLAG} ORDER BY stage, priority, created_at, id`)).rows;
  const version = (await tx.execute<{ version: number; updatedBy: string | null; lastAuditEventId: string | null }>(sql`
    SELECT version, updated_by AS "updatedBy", last_audit_event_id AS "lastAuditEventId"
    FROM feature_flag_config_versions WHERE scope='global'`)).rows[0];
  return { key: FLAG, exists: flag !== null, enabled: flag?.enabled ?? null, killSwitch: flag?.killSwitch ?? null,
    defaultEnabled: flag?.defaultEnabled ?? null, randomizationUnit: flag?.randomizationUnit ?? null, rules,
    configVersion: Number(version?.version ?? 0), configUpdatedBy: version?.updatedBy ?? null, configLastAuditEventId: version?.lastAuditEventId ?? null };
}

async function setupTransaction(tx: DatabaseExecutor, access: "read" | "write") {
  await inPhase("transaction_setup", async () => {
    await tx.execute(access === "write" ? sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`
      : sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    // apply holds the flag's exclusive lock while it counts, which pauses every
    // joint membership writer: keep that bounded.
    await tx.execute(sql`SET LOCAL lock_timeout='5s'`);
    await tx.execute(access === "write" ? sql`SET LOCAL statement_timeout='15s'` : sql`SET LOCAL statement_timeout='60s'`);
    await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='30s'`);
  });
  const state = (await inPhase(access === "write" ? "primary_guard" : "snapshot_guard", () => tx.execute<{ replica: boolean; readOnly: string; isolation: string }>(sql`
    SELECT pg_is_in_recovery() replica, current_setting('transaction_read_only') AS "readOnly", current_setting('transaction_isolation') isolation`))).rows[0];
  return { replica: state?.replica === true, readOnly: state?.readOnly === "on", isolation: state?.isolation ?? null };
}

export type ActivationDryRunOptions = { hostIds?: readonly string[]; allActiveHosts?: boolean; requireReplica?: boolean };

/** Read-only: which hosts, their no-live-source counts, the flag's current
 * state and the digest apply must quote. Writes nothing. */
export async function runActivationDryRun(db: Database, options: ActivationDryRunOptions) {
  if (options.allActiveHosts === (options.hostIds !== undefined)) fail("dry-run takes either explicit hosts or --all-active-hosts");
  const explicit = options.hostIds ? normalizeHostIds(options.hostIds) : null;
  const execution = await retryTransient(() => inPhase("transaction", () => db.transaction(async (tx) => {
    const state = await setupTransaction(tx, "read");
    if (state.isolation !== "repeatable read" || !state.readOnly)
      fail("dry-run requires a REPEATABLE READ, READ ONLY snapshot", "terminal", "snapshot_guard");
    if (options.requireReplica && !state.replica)
      fail("Production dry-run requires a read replica, including after reconnect or promotion", "terminal", "replica_guard");
    return inPhase("activation_preview", async () => {
      const hostIds = explicit ?? await activeTopLevelJointHosts(tx);
      const hosts = hostIds.length ? await describeHosts(tx, hostIds) : [];
      const withoutLiveSource = await countJointMembersWithoutLiveSource(tx, hostIds);
      const flag = await readFlagState(tx);
      const hostMismatch = await creatorRoleHostMismatches(tx);
      return { hostIds, hosts, withoutLiveSource, flag, hostMismatch, replica: state.replica };
    });
  })), { readOnly: true });
  const { hostIds, hosts, withoutLiveSource, flag, hostMismatch, replica } = execution.value;
  const total = withoutLiveSource.reduce((sum, row) => sum + row.members, 0);
  const blockers = [
    ...hostIds.length ? [] : ["no_hosts"],
    ...hosts.some((host) => !host.exists || host.deleted) ? ["unknown_or_deleted_hosts"] : [],
    ...flag.exists ? [] : ["flag_row_missing"],
    ...flag.rules.some((rule) => rule.stage === "server") ? ["server_rule_exists"] : [],
    ...total > 0 ? ["members_without_live_source"] : [],
  ];
  const warnings = [
    ...flag.enabled === false ? ["flag_disabled: the rule would be written but evaluate off"] : [],
    ...flag.killSwitch ? ["kill_switch_on: the rule would be written but evaluate off"] : [],
    ...flag.defaultEnabled ? ["default_enabled_on: source exit is already on for every server, without this check"] : [],
    ...flag.rules.length && !flag.rules.some((rule) => rule.stage === "server") ? ["other_rules_exist: review them; they can decide before or after the server rule"] : [],
    ...hosts.some((host) => host.exists && host.activeTopLevelJoints === 0) ? ["host_without_active_top_level_joint"] : [],
    ...hostMismatch.joints.length ? ["creator_role_host_mismatch: some joints' creator (the flag's host) is not their role=host projection; see host_mismatch"] : [],
  ];
  return { hostIds, hostsDigest: hostIds.length ? activationHostsDigest(hostIds) : null, hosts, withoutLiveSource,
    withoutLiveSourceTotal: total, wouldActivate: blockers.length === 0, blockers, warnings, flag, hostMismatch,
    expectedConfigVersion: flag.configVersion, replica, attempts: execution.attempts };
}

export type ActivationApplyOptions = {
  hostIds: readonly string[]; hostsDigest: string | undefined; expectedConfigVersion: number;
  runId: string | undefined; approvalRef: string | undefined; actor: FeatureFlagOperatorActor;
  checkWindow?: () => void;
};

export type ActivationApplyResult =
  | { status: "activated"; auditEventId: string; ruleId: string; values: string[]; configVersion: number;
    readBack: Awaited<ReturnType<typeof readBackActivation>> | { error: string; sqlState: string | null } }
  | { status: "refused_members_without_live_source"; withoutLiveSource: Array<{ hostServerId: string; jointId: string; members: number }>; total: number }
  | { status: "flag_row_missing" }
  | { status: "config_version_conflict"; currentVersion: number }
  | { status: "server_rule_exists" }
  | { status: "rule_validation_failed"; error: string }
  | { status: "unknown_or_deleted_hosts"; hosts: ActivationHost[] };

export function assertActivationApplyInputs(options: Pick<ActivationApplyOptions, "hostIds" | "hostsDigest" | "runId" | "approvalRef" | "expectedConfigVersion">) {
  if (!options.runId?.trim() || !options.approvalRef?.trim()) fail("apply requires --run-id and --approval-reference");
  if (!TOKEN.test(options.runId!)) fail("--run-id must be letters, digits, ._:@/- (at most 128)");
  if (!Number.isSafeInteger(options.expectedConfigVersion) || options.expectedConfigVersion < 0)
    fail("apply requires --expected-config-version N (dry-run's expectedConfigVersion)");
  const hosts = normalizeHostIds(options.hostIds);
  if (!/^[a-f0-9]{64}$/.test(options.hostsDigest ?? "") || activationHostsDigest(hosts) !== options.hostsDigest)
    fail("--hosts-digest does not match the host list; apply only the reviewed list");
  return hosts;
}

async function readBackActivation(db: Database, ruleId: string, hosts: readonly string[]) {
  const rule = (await db.execute<{ id: string; stage: string; decision: string; values: string[] }>(sql`
    SELECT id, stage, decision, "values" FROM feature_flag_rules WHERE id=${ruleId}::uuid AND flag_key=${FLAG}`)).rows[0] ?? null;
  const flag = await readFlagState(db);
  const evaluations: Array<{ hostServerId: string; enabled: boolean; reason: string }> = [];
  for (const hostServerId of hosts) {
    const result = await evaluateFeatureFlag({ key: FLAG, serverId: hostServerId }, db);
    evaluations.push({ hostServerId, enabled: result.enabled, reason: result.reason });
  }
  return { rule, configVersion: flag.configVersion, configUpdatedBy: flag.configUpdatedBy,
    configLastAuditEventId: flag.configLastAuditEventId, evaluations };
}

/**
 * One primary transaction: READ COMMITTED, writable-primary guard, window,
 * known non-deleted hosts, then activateJointSourceExit (its own transaction
 * joins this one as a savepoint, so the guards and the write commit together).
 * Never retried. `db` must be the process database (getDb()), which
 * activateJointSourceExit uses.
 */
export async function runActivationApply(db: Database, options: ActivationApplyOptions): Promise<ActivationApplyResult> {
  const hosts = assertActivationApplyInputs(options);
  if (db !== getDb()) fail("apply must run on the process database so the activation joins its guarded transaction");
  const runId = options.runId!.trim(), approvalRef = options.approvalRef!.trim();
  const auditEventId = activationAuditEventId({ runId, approvalRef, hostsDigest: options.hostsDigest! });
  const checkWindow = () => {
    try { options.checkWindow?.(); }
    catch (error) { throw new JointMembershipOpsError("Approved write window check failed", "terminal", { cause: error, phase: "write_window" }); }
  };
  let outcome: Exclude<ActivationApplyResult, { status: "activated" }> | { status: "written"; ruleId: string; values: string[]; configVersion: number };
  try {
    outcome = await inPhase("transaction", () => db.transaction(async (tx) => {
      const state = await setupTransaction(tx, "write");
      if (state.replica || state.readOnly)
        fail("apply requires a writable primary; refusing a replica or read-only connection", "terminal", "primary_guard");
      checkWindow();
      const described = await inPhase("activation_hosts", () => describeHosts(tx, hosts));
      if (described.some((host) => !host.exists || host.deleted)) return { status: "unknown_or_deleted_hosts" as const, hosts: described };
      const created = await inPhase("activation_apply", () => activateJointSourceExit({ hostServerIds: hosts,
        expectedConfigVersion: options.expectedConfigVersion,
        actor: { type: options.actor.type, id: `${options.actor.id}#run=${runId}` }, auditEventId }));
      if (!created) return { status: "flag_row_missing" as const };
      checkWindow();
      return { status: "written" as const, ruleId: created.rule.id, values: created.rule.values, configVersion: created.configVersion };
    }));
  } catch (error) {
    const cause = error instanceof JointMembershipOpsError && error.phase === "activation_apply" ? error.cause : null;
    if (cause instanceof JointSourceExitActivationRefusedError)
      return { status: "refused_members_without_live_source", withoutLiveSource: cause.withoutLiveSource,
        total: cause.withoutLiveSource.reduce((sum, row) => sum + row.members, 0) };
    if (cause instanceof FeatureFlagConfigVersionConflictError) return { status: "config_version_conflict", currentVersion: cause.currentVersion };
    if (cause instanceof FeatureFlagServerRuleAlreadyExistsError) return { status: "server_rule_exists" };
    if (cause instanceof FeatureFlagRuleValidationError) return { status: "rule_validation_failed", error: cause.message };
    throw error;
  }
  if (outcome.status !== "written") return outcome;
  // Committed. A failed read-back is reported, never turned into a write failure.
  let readBack: Extract<ActivationApplyResult, { status: "activated" }>["readBack"];
  try { readBack = await inPhase("activation_readback", () => readBackActivation(db, outcome.ruleId, hosts)); }
  catch (error) { readBack = { error: "read_back_failed", sqlState: sqlStateOf(error) }; }
  return { status: "activated", auditEventId, ruleId: outcome.ruleId, values: outcome.values, configVersion: outcome.configVersion, readBack };
}

const HELP = `activate-joint-source-exit.ts --environment staging|production --mode dry-run|apply
  dry-run (read-only; JOINT_MEMBERSHIP_READ_DATABASE_URL; production requires a read replica):
    --all-active-hosts | --host UUID ... | --hosts-file PATH
    (--all-active-hosts: every non-deleted server that created an active top-level joint,
     joint_channels.created_by_server_id, the server the flag is evaluated for)
    Prints each host, members without a live source per host/joint, the flag row and its rules,
    the config version and hostsDigest (end record). Writes nothing.
  apply (JOINT_MEMBERSHIP_WRITE_DATABASE_URL; the primary):
    --host UUID ... | --hosts-file PATH   (never --all-active-hosts: apply the reviewed list)
    --hosts-digest SHA256 --expected-config-version N --run-id ID --approval-reference REF
    --actor human:ID|agent:ID   [production: --window-start ISO-Z --window-end ISO-Z]
    Calls activateJointSourceExit once: it writes joint_source_exit_v1's FIRST server allow rule
    only if no listed host's active joint has a member without a live source. Never retried.
    Exit 1 on refusal, flag row missing, config version conflict or an existing server rule.
  Only the first server rule can be written; hosts cannot be added later by this tool, and
  servers that start hosting joints after activation are not covered.
  See docs/development/reports/joint-membership-ops.md. DATABASE_URL is never used.`;

async function main() {
  const parse = () => parseArgs({ options: {
    help: { type: "boolean" }, mode: { type: "string" }, environment: { type: "string" },
    host: { type: "string", multiple: true }, "hosts-file": { type: "string" }, "all-active-hosts": { type: "boolean" },
    "hosts-digest": { type: "string" }, "expected-config-version": { type: "string" }, "run-id": { type: "string" },
    "approval-reference": { type: "string" }, "window-start": { type: "string" }, "window-end": { type: "string" },
    actor: { type: "string" },
  } });
  let values: ReturnType<typeof parse>["values"];
  // parseArgs messages quote only operator input, never database data.
  try { ({ values } = parse()); }
  catch (error) { return fail(`Invalid arguments: ${error instanceof Error ? error.message : "unparseable"}`); }
  if (values.help) { console.log(HELP); return; }
  const mode = values.mode;
  if (mode !== "dry-run" && mode !== "apply") fail("--mode dry-run or --mode apply is required");
  if (values.environment !== "staging" && values.environment !== "production") fail("Explicit --environment staging or production required");
  const production = values.environment === "production";
  const sources = [values.host?.length ? 1 : 0, values["hosts-file"] !== undefined ? 1 : 0, values["all-active-hosts"] ? 1 : 0].reduce((a, b) => a + b, 0);
  if (sources !== 1) fail("Give exactly one of --host, --hosts-file or --all-active-hosts");
  const hostIds = values["hosts-file"] !== undefined
    ? parseActivationHostsFileText(await readFile(values["hosts-file"], "utf8").catch((): never => fail(`hosts file ${values["hosts-file"]} could not be read`)))
    : values.host ? normalizeHostIds(values.host) : undefined;
  const window = { approval: values["approval-reference"], start: values["window-start"], end: values["window-end"] };
  if (mode === "dry-run") {
    if (values["hosts-digest"] || values["expected-config-version"] || values["run-id"] || values["approval-reference"]
      || values["window-start"] || values["window-end"] || values.actor)
      fail("dry-run is read-only and takes no digest, config version, run id, approval, window or actor");
  } else {
    if (values["all-active-hosts"]) fail("apply takes the reviewed list (--host or --hosts-file), never --all-active-hosts");
    assertActivationApplyInputs({ hostIds: hostIds!, hostsDigest: values["hosts-digest"], runId: values["run-id"],
      approvalRef: values["approval-reference"], expectedConfigVersion: /^\d+$/.test(values["expected-config-version"] ?? "") ? Number(values["expected-config-version"]) : -1 });
    parseActivationActor(values.actor);
    if (production) assertProductionWriteWindow(window);
  }
  const databaseUrl = mode === "apply" ? process.env.JOINT_MEMBERSHIP_WRITE_DATABASE_URL : process.env.JOINT_MEMBERSHIP_READ_DATABASE_URL;
  if (!databaseUrl) fail(`Explicit ${mode === "apply" ? "JOINT_MEMBERSHIP_WRITE_DATABASE_URL" : "JOINT_MEMBERSHIP_READ_DATABASE_URL"} required; no DATABASE_URL fallback`);
  const start = { event: "start", mode, environment: values.environment, flagKey: FLAG, startedAt: new Date().toISOString(),
    runId: values["run-id"] ?? null, approval: values["approval-reference"] ?? null, actor: values.actor ?? null,
    hostsDigest: values["hosts-digest"] ?? null, expectedConfigVersion: values["expected-config-version"] ?? null };

  if (mode === "dry-run") {
    // Raw adapter: does not initialize the serving app, migrations or background jobs.
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000,
      statement_timeout: 60_000, idle_in_transaction_session_timeout: 30_000 });
    attachJointOpsConnectionErrorHandlers(pool);
    try {
      const endpoint = (await retryTransient(() => pool.query<{ replica: boolean; replayAt: Date | null }>(
        "SELECT pg_is_in_recovery() replica,pg_last_xact_replay_timestamp() AS \"replayAt\""), { readOnly: true })).value.rows[0];
      if (!endpoint || (production && !endpoint.replica)) fail("Production dry-run requires a read replica", "terminal", "replica_guard");
      console.log(JSON.stringify({ ...start, replica: endpoint!.replica, replayAt: endpoint!.replayAt }));
      const result = await runActivationDryRun(drizzle(pool, { schema }), hostIds ? { hostIds, requireReplica: production }
        : { allActiveHosts: true, requireReplica: production });
      const byHost = new Map<string, typeof result.withoutLiveSource>();
      for (const row of result.withoutLiveSource) byHost.set(row.hostServerId, [...byHost.get(row.hostServerId) ?? [], row]);
      for (const host of result.hosts) {
        const joints = byHost.get(host.id) ?? [];
        console.log(JSON.stringify({ event: "host", ...host, withoutLiveSource: joints.reduce((sum, row) => sum + row.members, 0),
          joints: joints.map(({ jointId, members }) => ({ jointId, members })) }));
      }
      if (result.hostMismatch.joints.length) console.log(JSON.stringify({ event: "host_mismatch", ...result.hostMismatch }));
      console.log(JSON.stringify({ event: "flag", ...result.flag }));
      console.log(JSON.stringify({ event: "end", mode, hosts: result.hostIds.length, hostIds: result.hostIds, hostsDigest: result.hostsDigest,
        withoutLiveSourceTotal: result.withoutLiveSourceTotal, wouldActivate: result.wouldActivate, blockers: result.blockers,
        warnings: result.warnings, expectedConfigVersion: result.expectedConfigVersion, attempts: result.attempts }));
    } finally { await pool.end(); }
    return;
  }

  // activateJointSourceExit resolves the process database (getDb()), so apply
  // opens the db module's pool on the write URL. This starts no server,
  // migrations or background jobs.
  await initDatabase(databaseUrl, undefined, { log: () => {} });
  try {
    const db = getDb();
    const endpoint = (await db.execute<{ replica: boolean }>(sql`SELECT pg_is_in_recovery() replica`)).rows[0];
    if (!endpoint || endpoint.replica) fail("apply requires the primary", "terminal", "primary_guard");
    const auditEventId = activationAuditEventId({ runId: values["run-id"]!.trim(), approvalRef: values["approval-reference"]!.trim(),
      hostsDigest: values["hosts-digest"]! });
    console.log(JSON.stringify({ ...start, replica: false, hostIds, auditEventId }));
    const result = await runActivationApply(db, { hostIds: hostIds!, hostsDigest: values["hosts-digest"],
      expectedConfigVersion: Number(values["expected-config-version"]), runId: values["run-id"], approvalRef: values["approval-reference"],
      actor: parseActivationActor(values.actor), checkWindow: production ? () => assertProductionWriteWindow(window) : undefined });
    const explain = result.status === "flag_row_missing"
      ? `The ${FLAG} flag row does not exist; nothing was written. Create it (default off, randomization unit server) through the feature flag admin first, then dry-run again.`
      : result.status === "config_version_conflict" ? "The config version moved since the dry-run; dry-run again and re-approve."
      : result.status === "server_rule_exists" ? "A server rule already exists; this tool only writes the first one. Nothing was written."
      : result.status === "refused_members_without_live_source" ? "Members without a live source exist; nothing was written. Recover or remove them, then dry-run again."
      : undefined;
    console.log(JSON.stringify({ event: "end", mode, ...result, ...explain ? { explain } : {} }));
    if (result.status !== "activated") process.exitCode = 1;
  } finally { await closeDatabase(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch((error) => {
    // Driver errors may carry query or connection data: only our own messages are printed.
    console.error(JSON.stringify({ event: "error", sqlState: sqlStateOf(error), kind: transientKindOf(error),
      phase: error instanceof JointMembershipOpsError ? error.phase : null,
      error: error instanceof JointMembershipOpsError ? error.message : "operation_failed" }));
    process.exitCode = 1;
  });
}
