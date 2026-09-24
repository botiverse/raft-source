import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type {
  AgentRuntimeProfileChange,
  AgentRuntimeProfilePending,
  AgentRuntimeProfilePendingKind,
  AgentRuntimeProfileRef,
  AgentRuntimeProfileReport,
  AgentRuntimeProfileSnapshot,
  AgentRuntimeProfileSummary,
  ReasoningEffort,
} from "@botiverse/raft-shared";
import { getDb, isDatabaseInitialized, type DatabaseExecutor } from "../db/index.js";
import { untracedDbQuery, type DbQueryTracer } from "../tracing/dbQueryTrace.js";
import {
  agentRuntimeProfiles,
  agents,
  machines,
} from "../db/schema.js";
import {
  compareDaemonSemver,
  getAgentDaemonReleaseNotice,
  renderAgentDaemonReleaseNotice,
} from "./agentDaemonReleaseNotes.js";
import { emitDecisionEvent } from "../tracing/decisionTrace.js";

const POLICY_VERSION = "runtime-profile-v0";

const DAEMON_NOTES_DECISION = {
  name: "server.daemon_notes.decision",
  actions: [
    "computed",
    "suppressed_version_gate",
    "suppressed_no_entries",
    "cleared",
    "delivered",
    "baseline_advanced",
  ] as const,
  reasons: [
    "initial_baseline",
    "catalog_entries_found",
    "version_not_newer",
    "no_catalog_entries",
    "runtime_identity_changed",
    "notice_acknowledged",
  ] as const,
  attributeKeys: ["baseline_before", "baseline_after", "entries_n"] as const,
  stringAttributeValidators: {
    baseline_before: isSafeDaemonVersionTraceValue,
    baseline_after: isSafeDaemonVersionTraceValue,
  },
};

type DaemonNotesDecisionAction = (typeof DAEMON_NOTES_DECISION.actions)[number];
type DaemonNotesDecisionReason = (typeof DAEMON_NOTES_DECISION.reasons)[number];

function isSafeDaemonVersionTraceValue(value: string): boolean {
  return value === "unknown"
    || /^v?\d{1,4}(?:\.\d{1,4}){0,3}(?:[-+][0-9A-Za-z.-]{1,24})?$/.test(value);
}

function daemonReleaseNoticeEntryCount(notice: ReturnType<typeof getAgentDaemonReleaseNotice>): number {
  return notice?.notes.reduce((count, note) => count + note.entries.length, 0) ?? 0;
}

function emitDaemonNotesDecision(
  action: DaemonNotesDecisionAction,
  reason: DaemonNotesDecisionReason,
  before: string | null,
  after: string | null,
  entriesN: number,
): void {
  emitDecisionEvent(DAEMON_NOTES_DECISION, {
    action,
    reason,
    attrs: {
      baseline_before: before ?? "unknown",
      baseline_after: after ?? "unknown",
      entries_n: entriesN,
    },
  });
}

type DaemonNotesDecisionArgs = Parameters<typeof emitDaemonNotesDecision>;
type DaemonNotesDecisionRecorder = (...args: DaemonNotesDecisionArgs) => void;

type RuntimeProfileIdentity = {
  machineId: string;
  runtime: string;
  model: string;
  reasoningEffort: ReasoningEffort | null;
  executionMode: string;
};

type RuntimeProfileRow = typeof agentRuntimeProfiles.$inferSelect;

export interface RecordAgentRuntimeProfileInput {
  serverId: string;
  agentId: string;
  machineId: string;
  daemonVersion: string | null;
  facts: AgentRuntimeProfileReport;
}

export interface RecordAgentRuntimeProfileResult {
  profile: RuntimeProfileRow;
  pending: RuntimeProfileRow | null;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}

export function computeRuntimeProfileFingerprint(fields: RuntimeProfileIdentity): string {
  return createHash("sha256").update(stableJson(fields)).digest("hex");
}

function hashKey(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function normalizeRef(value: AgentRuntimeProfileRef | string | null | undefined): AgentRuntimeProfileRef | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return { label: value, path: value };
  return value;
}

function buildIdentity(input: RecordAgentRuntimeProfileInput): RuntimeProfileIdentity {
  return {
    machineId: input.machineId,
    runtime: input.facts.runtime,
    model: input.facts.model,
    reasoningEffort: (input.facts.reasoningEffort ?? null) as ReasoningEffort | null,
    executionMode: input.facts.executionMode || "byoc",
  };
}

function currentValues(input: RecordAgentRuntimeProfileInput) {
  const identity = buildIdentity(input);
  return {
    ...identity,
    runtimeProfileFingerprint: computeRuntimeProfileFingerprint(identity),
    daemonVersion: input.daemonVersion,
    workspaceRef: normalizeRef(input.facts.workspaceRef),
    workspacePathRef: normalizeRef(input.facts.workspacePathRef),
    sessionRef: normalizeRef(input.facts.sessionRef),
  };
}

function refColumns(prefix: "workspaceRef" | "workspacePathRef" | "sessionRef", ref: AgentRuntimeProfileRef | null) {
  return {
    [`${prefix}Label`]: ref?.label ?? null,
    [`${prefix}Path`]: ref?.path ?? null,
    [`${prefix}MachineId`]: ref?.machineId ?? null,
    [`${prefix}Runtime`]: ref?.runtime ?? null,
    [`${prefix}Reachable`]: ref?.reachable ?? null,
    [`${prefix}Reason`]: ref?.reason ?? null,
  } as Record<string, string | boolean | null>;
}

function previousSessionColumns(ref: AgentRuntimeProfileRef | null) {
  return {
    pendingPreviousSessionLabel: ref?.label ?? null,
    pendingPreviousSessionPath: ref?.path ?? null,
    pendingPreviousSessionMachineId: ref?.machineId ?? null,
    pendingPreviousSessionRuntime: ref?.runtime ?? null,
    pendingPreviousSessionReachable: ref?.reachable ?? null,
    pendingPreviousSessionReason: ref?.reason ?? null,
  };
}

function currentUpdateColumns(values: ReturnType<typeof currentValues>) {
  return {
    machineId: values.machineId,
    runtimeProfileFingerprint: values.runtimeProfileFingerprint,
    runtime: values.runtime,
    model: values.model,
    reasoningEffort: values.reasoningEffort,
    executionMode: values.executionMode,
    daemonVersion: values.daemonVersion,
    ...refColumns("workspaceRef", values.workspaceRef),
    ...refColumns("workspacePathRef", values.workspacePathRef),
    ...refColumns("sessionRef", values.sessionRef),
  };
}

function baselineColumns(values: ReturnType<typeof currentValues>) {
  return {
    baselineRuntimeProfileFingerprint: values.runtimeProfileFingerprint,
    baselineMachineId: values.machineId,
    baselineRuntime: values.runtime,
    baselineModel: values.model,
    baselineReasoningEffort: values.reasoningEffort,
    baselineExecutionMode: values.executionMode,
    baselineDaemonVersion: values.daemonVersion,
  };
}

function baselineRuntimeIdentityColumns(values: ReturnType<typeof currentValues>) {
  return {
    baselineRuntimeProfileFingerprint: values.runtimeProfileFingerprint,
    baselineMachineId: values.machineId,
    baselineRuntime: values.runtime,
    baselineModel: values.model,
    baselineReasoningEffort: values.reasoningEffort,
    baselineExecutionMode: values.executionMode,
  };
}

function baselineFromPendingAfterColumns(row: RuntimeProfileRow) {
  return {
    baselineRuntimeProfileFingerprint: row.pendingAfterRuntimeProfileFingerprint || row.runtimeProfileFingerprint,
    baselineMachineId: row.pendingAfterMachineId || row.machineId,
    baselineRuntime: row.pendingAfterRuntime || row.runtime,
    baselineModel: row.pendingAfterModel || row.model,
    baselineReasoningEffort: row.pendingAfterReasoningEffort,
    baselineExecutionMode: row.pendingAfterExecutionMode || row.executionMode,
    baselineDaemonVersion: row.pendingAfterDaemonVersion ?? row.daemonVersion,
  };
}

function pendingKey(kind: AgentRuntimeProfilePendingKind, agentId: string, beforeFingerprint: string, afterFingerprint: string, beforeDaemonVersion: string | null, afterDaemonVersion: string | null): string {
  // Per-kind hash inputs partition cleanly: migration keys consume the
  // before/after fingerprint pair, release-notice keys consume the
  // before/after daemon version pair, and the unused pair is null on
  // each side. Naming the discriminator makes that partition readable
  // without re-comparing strings four times.
  const isMigration = kind === "migration";
  return hashKey({
    agentId,
    kind,
    policyVersion: POLICY_VERSION,
    beforeFingerprint: isMigration ? beforeFingerprint : null,
    afterFingerprint: isMigration ? afterFingerprint : null,
    beforeDaemonVersion: isMigration ? null : beforeDaemonVersion,
    afterDaemonVersion: isMigration ? null : afterDaemonVersion,
  });
}

function baselineIdentity(row: RuntimeProfileRow): RuntimeProfileIdentity {
  return {
    machineId: row.baselineMachineId,
    runtime: row.baselineRuntime,
    model: row.baselineModel,
    reasoningEffort: row.baselineReasoningEffort as ReasoningEffort | null,
    executionMode: row.baselineExecutionMode,
  };
}

function currentIdentity(row: RuntimeProfileRow): RuntimeProfileIdentity {
  return {
    machineId: row.machineId,
    runtime: row.runtime,
    model: row.model,
    reasoningEffort: row.reasoningEffort as ReasoningEffort | null,
    executionMode: row.executionMode,
  };
}

function diffIdentity(before: RuntimeProfileIdentity, after: RuntimeProfileIdentity): AgentRuntimeProfileChange[] {
  const labels: Record<keyof RuntimeProfileIdentity, string> = {
    machineId: "machine.id",
    runtime: "runtime.name",
    model: "runtime.model",
    reasoningEffort: "runtime.reasoningEffort",
    executionMode: "runtime.executionMode",
  };
  return (Object.keys(labels) as Array<keyof RuntimeProfileIdentity>).flatMap((field) => (
    before[field] === after[field]
      ? []
      : [{ field: labels[field], before: before[field], after: after[field] }]
  ));
}

function pendingColumns(kind: AgentRuntimeProfilePendingKind, existing: RuntimeProfileRow, values: ReturnType<typeof currentValues>) {
  const beforeFingerprint = existing.baselineRuntimeProfileFingerprint;
  const afterFingerprint = values.runtimeProfileFingerprint;
  const beforeDaemonVersion = existing.baselineDaemonVersion;
  const afterDaemonVersion = values.daemonVersion;
  const key = pendingKey(kind, existing.agentId, beforeFingerprint, afterFingerprint, beforeDaemonVersion, afterDaemonVersion);
  const previousSession = refFromRow(existing, "sessionRef");
  return {
    migrationStatus: "pending" as const,
    pendingKind: kind,
    pendingKey: key,
    pendingBeforeRuntimeProfileFingerprint: beforeFingerprint,
    pendingAfterRuntimeProfileFingerprint: afterFingerprint,
    pendingBeforeMachineId: existing.baselineMachineId,
    pendingAfterMachineId: values.machineId,
    pendingBeforeRuntime: existing.baselineRuntime,
    pendingAfterRuntime: values.runtime,
    pendingBeforeModel: existing.baselineModel,
    pendingAfterModel: values.model,
    pendingBeforeReasoningEffort: existing.baselineReasoningEffort,
    pendingAfterReasoningEffort: values.reasoningEffort,
    pendingBeforeExecutionMode: existing.baselineExecutionMode,
    pendingAfterExecutionMode: values.executionMode,
    pendingBeforeDaemonVersion: beforeDaemonVersion,
    pendingAfterDaemonVersion: afterDaemonVersion,
    ...previousSessionColumns(previousSession),
    pendingReleaseNotesUrl: null,
    migrationDeliveredAt: null,
    migrationDeliveredLaunchId: null,
    migratingSince: null,
    lastMigrationNudgeAt: null,
    migrationNudgeCount: 0,
    migrationHandledAt: null,
    migrationHandledLaunchId: null,
  };
}

function updatePendingDaemonReleaseNoticeColumns(
  existing: RuntimeProfileRow,
  values: ReturnType<typeof currentValues>,
  recordDecision: DaemonNotesDecisionRecorder = emitDaemonNotesDecision,
) {
  if (existing.pendingKind !== "daemon_release_notice") return {};
  const currentPendingAfter = existing.pendingAfterDaemonVersion ?? existing.daemonVersion;
  if (compareDaemonSemver(values.daemonVersion, currentPendingAfter) <= 0) {
    recordDecision(
      "suppressed_version_gate",
      "version_not_newer",
      existing.baselineDaemonVersion,
      values.daemonVersion,
      0,
    );
    return {};
  }
  const releaseNotice = getAgentDaemonReleaseNotice(existing.baselineDaemonVersion, values.daemonVersion);
  if (!releaseNotice) {
    recordDecision(
      "suppressed_no_entries",
      "no_catalog_entries",
      existing.baselineDaemonVersion,
      values.daemonVersion,
      0,
    );
    return {};
  }
  recordDecision(
    "computed",
    "catalog_entries_found",
    existing.baselineDaemonVersion,
    values.daemonVersion,
    daemonReleaseNoticeEntryCount(releaseNotice),
  );
  return {
    pendingKey: pendingKey(
      "daemon_release_notice",
      existing.agentId,
      existing.baselineRuntimeProfileFingerprint,
      values.runtimeProfileFingerprint,
      existing.baselineDaemonVersion,
      values.daemonVersion,
    ),
    pendingAfterRuntimeProfileFingerprint: values.runtimeProfileFingerprint,
    pendingAfterMachineId: values.machineId,
    pendingAfterRuntime: values.runtime,
    pendingAfterModel: values.model,
    pendingAfterReasoningEffort: values.reasoningEffort,
    pendingAfterExecutionMode: values.executionMode,
    pendingAfterDaemonVersion: values.daemonVersion,
    pendingReleaseNotesUrl: null,
    migrationDeliveredAt: null,
    migrationDeliveredLaunchId: null,
  };
}

function clearPendingColumns() {
  return {
    migrationStatus: "stable" as const,
    pendingKind: null,
    pendingKey: null,
    pendingBeforeRuntimeProfileFingerprint: null,
    pendingAfterRuntimeProfileFingerprint: null,
    pendingBeforeMachineId: null,
    pendingAfterMachineId: null,
    pendingBeforeRuntime: null,
    pendingAfterRuntime: null,
    pendingBeforeModel: null,
    pendingAfterModel: null,
    pendingBeforeReasoningEffort: null,
    pendingAfterReasoningEffort: null,
    pendingBeforeExecutionMode: null,
    pendingAfterExecutionMode: null,
    pendingBeforeDaemonVersion: null,
    pendingAfterDaemonVersion: null,
    pendingPreviousSessionLabel: null,
    pendingPreviousSessionPath: null,
    pendingPreviousSessionMachineId: null,
    pendingPreviousSessionRuntime: null,
    pendingPreviousSessionReachable: null,
    pendingPreviousSessionReason: null,
    pendingReleaseNotesUrl: null,
    migrationDeliveredAt: null,
    migrationDeliveredLaunchId: null,
    migratingSince: null,
    lastMigrationNudgeAt: null,
    migrationNudgeCount: 0,
    migrationHandledAt: null,
    migrationHandledLaunchId: null,
  };
}

function resetSessionUpdateColumns(
  existing: RuntimeProfileRow,
  values: ReturnType<typeof currentValues>,
  recordDecision: DaemonNotesDecisionRecorder = emitDaemonNotesDecision,
) {
  const releaseNotice = getAgentDaemonReleaseNotice(existing.baselineDaemonVersion, values.daemonVersion);
  if (releaseNotice) {
    recordDecision(
      "computed",
      "runtime_identity_changed",
      existing.baselineDaemonVersion,
      values.daemonVersion,
      daemonReleaseNoticeEntryCount(releaseNotice),
    );
    return {
      ...baselineRuntimeIdentityColumns(values),
      ...pendingColumns("daemon_release_notice", existing, values),
    };
  }
  recordDecision(
    "cleared",
    "runtime_identity_changed",
    existing.baselineDaemonVersion,
    values.daemonVersion,
    0,
  );
  return {
    ...baselineColumns(values),
    ...clearPendingColumns(),
  };
}

const PROFILE_RETRY_MAX = 5;
const PROFILE_RETRY_BASE_MS = 50;

// Prevent lock storms during multi-machine startup (e.g. bluegreen deploy):
// skip writes for the same agent within a short window to reduce DB contention.
// Added in #2566. The cooldown is per-agent and lives in a module-level Map,
// so the tests must be able to reset it — otherwise two recordAgentRuntimeProfile
// calls within 5s on the same agentId (common in unit tests) make the second
// one a silent no-op, returning `{profile: null, pending: null}` and tripping
// any downstream assertion that reads from the returned row.
const PROFILE_WRITE_COOLDOWN_MS = 5_000;
const _profileLastWritten = new Map<string, number>();

// Module-level escape hatch — when true, `shouldSkipProfileWrite` always
// returns false. Tests flip this on so within-test sequences (e.g. "first
// report" → "release-notice queued on follow-up") don't silently no-op.
// Production code never touches this.
let _writeCooldownDisabledForTests = false;

function shouldSkipProfileWrite(agentId: string): boolean {
  if (_writeCooldownDisabledForTests) return false;
  const last = _profileLastWritten.get(agentId);
  if (last && Date.now() - last < PROFILE_WRITE_COOLDOWN_MS) return true;
  _profileLastWritten.set(agentId, Date.now());
  return false;
}

/**
 * Test-only escape hatch — disables the write cooldown for the remainder
 * of the process and clears any pending cooldown state. Tests call this
 * in their `beforeEach` so within-test sequences (multiple
 * `recordAgentRuntimeProfile` calls on the same agentId — exercising
 * "first report" → "release-notice queued on follow-up" flows) don't
 * silently no-op the second call.
 *
 * Production code must never call this; the cooldown exists to prevent
 * the lock storms that come from multi-machine startup races.
 */
export function disableRuntimeProfileWriteCooldownForTests(): void {
  _writeCooldownDisabledForTests = true;
  _profileLastWritten.clear();
}

function backoff(attempt: number): number {
  return PROFILE_RETRY_BASE_MS * Math.pow(2, attempt) + Math.random() * 50;
}

/**
 * Records agent runtime profile with optimistic concurrency control.
 * On revision conflict (concurrent write from another machine), retries with
 * exponential backoff to avoid lock contention storms during multi-machine
 * startup (e.g. bluegreen deploys).
 */
export async function recordAgentRuntimeProfile(input: RecordAgentRuntimeProfileInput): Promise<RecordAgentRuntimeProfileResult> {
  // Skip if we recently wrote this agent's profile (prevent lock storms)
  if (shouldSkipProfileWrite(input.agentId)) {
    return { profile: null as unknown as RuntimeProfileRow, pending: null };
  }

  const db = getDb();

  for (let attempt = 0; attempt < PROFILE_RETRY_MAX; attempt++) {
    const result = await tryRecordAgentRuntimeProfile(db, input);
    if (result !== "retry") return result;
    await new Promise((resolve) => setTimeout(resolve, backoff(attempt)));
  }

  // Final attempt — if it still conflicts, return whatever the DB has
  const fallback = await tryRecordAgentRuntimeProfile(db, input);
  if (fallback !== "retry") return fallback;
  throw new Error(`Failed to record runtime profile for ${input.agentId} after ${PROFILE_RETRY_MAX} retries`);
}

async function tryRecordAgentRuntimeProfile(
  db: ReturnType<typeof getDb>,
  input: RecordAgentRuntimeProfileInput,
): Promise<RecordAgentRuntimeProfileResult | "retry"> {
  const now = new Date();
  const values = currentValues(input);
  const decisions: DaemonNotesDecisionArgs[] = [];
  const recordDecision: DaemonNotesDecisionRecorder = (...args) => decisions.push(args);

  const result = await db.transaction(async (tx) => {
    let [existing] = await tx.select()
      .from(agentRuntimeProfiles)
      .where(eq(agentRuntimeProfiles.agentId, input.agentId))
      .limit(1);

    if (!existing) {
      const [inserted] = await tx.insert(agentRuntimeProfiles)
        .values({
          agentId: input.agentId,
          serverId: input.serverId,
          ...currentUpdateColumns(values),
          ...baselineColumns(values),
          migrationStatus: "stable",
          revision: 1,
          observedAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning();
      if (inserted) {
        recordDecision(
          "baseline_advanced",
          "initial_baseline",
          null,
          values.daemonVersion,
          0,
        );
        return { profile: inserted, pending: null };
      }

      [existing] = await tx.select()
        .from(agentRuntimeProfiles)
        .where(eq(agentRuntimeProfiles.agentId, input.agentId))
        .limit(1);
      if (!existing) {
        throw new Error("Failed to record runtime profile after concurrent insert");
      }
    }

    let pendingUpdate: Partial<typeof agentRuntimeProfiles.$inferInsert> = {};
    if (existing.pendingKind === "migration" && existing.migrationStatus !== "stable") {
      pendingUpdate = resetSessionUpdateColumns(existing, values, recordDecision);
    } else if (existing.pendingKind === "daemon_release_notice") {
      if (existing.baselineRuntimeProfileFingerprint !== values.runtimeProfileFingerprint) {
        pendingUpdate = resetSessionUpdateColumns(existing, values, recordDecision);
      } else {
        pendingUpdate = updatePendingDaemonReleaseNoticeColumns(existing, values, recordDecision);
      }
    } else if (existing.baselineRuntimeProfileFingerprint !== values.runtimeProfileFingerprint) {
      pendingUpdate = resetSessionUpdateColumns(existing, values, recordDecision);
    } else {
      const releaseNotice = getAgentDaemonReleaseNotice(existing.baselineDaemonVersion, values.daemonVersion);
      if (releaseNotice) {
        recordDecision(
          "computed",
          "catalog_entries_found",
          existing.baselineDaemonVersion,
          values.daemonVersion,
          daemonReleaseNoticeEntryCount(releaseNotice),
        );
        pendingUpdate = pendingColumns("daemon_release_notice", existing, values);
      } else {
        recordDecision(
          "suppressed_no_entries",
          "no_catalog_entries",
          existing.baselineDaemonVersion,
          values.daemonVersion,
          0,
        );
        pendingUpdate = {
          baselineDaemonVersion: values.daemonVersion,
        };
      }
    }

    const [updated] = await tx.update(agentRuntimeProfiles)
      .set({
        ...currentUpdateColumns(values),
        ...pendingUpdate,
        revision: existing.revision + 1,
        observedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(agentRuntimeProfiles.agentId, input.agentId),
        eq(agentRuntimeProfiles.revision, existing.revision),
      ))
      .returning();

    // Optimistic lock conflict — another machine updated this row first.
    // Signal caller to retry with backoff instead of returning stale data.
    if (!updated) return "retry";

    return {
      profile: updated,
      pending: updated.pendingKind ? updated : null,
    };
  });
  if (result !== "retry") {
    for (const decision of decisions) emitDaemonNotesDecision(...decision);
  }
  return result;
}

export async function queueRuntimeProfileMigrationForAgentSettings(agentId: string): Promise<RuntimeProfileRow | null> {
  const db = getDb();
  const now = new Date();
  const decisions: DaemonNotesDecisionArgs[] = [];
  const recordDecision: DaemonNotesDecisionRecorder = (...args) => decisions.push(args);

  const outcome = await db.transaction(async (tx) => {
    const [row] = await tx.select({
      profile: agentRuntimeProfiles,
      agent: agents,
      machine: machines,
    })
      .from(agentRuntimeProfiles)
      .innerJoin(agents, eq(agentRuntimeProfiles.agentId, agents.id))
      .innerJoin(machines, eq(agents.machineId, machines.id))
      .where(eq(agentRuntimeProfiles.agentId, agentId))
      .limit(1);
    if (!row) return { value: null, emitDecisions: false };

    const values = currentValues({
      serverId: row.agent.serverId,
      agentId,
      machineId: row.agent.machineId!,
      daemonVersion: row.machine.daemonVersion ?? row.profile.daemonVersion,
      facts: {
        runtime: row.agent.runtime,
        model: row.agent.model,
        reasoningEffort: row.agent.reasoningEffort as ReasoningEffort | null,
        executionMode: row.agent.executionMode,
      },
    });
    const existing = row.profile;

    let pendingUpdate: Partial<typeof agentRuntimeProfiles.$inferInsert> = {};
    if (existing.pendingKind === "migration" && existing.migrationStatus !== "stable") {
      pendingUpdate = resetSessionUpdateColumns(existing, values, recordDecision);
    } else if (existing.baselineRuntimeProfileFingerprint !== values.runtimeProfileFingerprint) {
      pendingUpdate = resetSessionUpdateColumns(existing, values, recordDecision);
    }

    if (Object.keys(pendingUpdate).length === 0) {
      return {
        value: existing.pendingKind === "daemon_release_notice" ? existing : null,
        emitDecisions: false,
      };
    }

    const [updated] = await tx.update(agentRuntimeProfiles)
      .set({
        ...currentUpdateColumns(values),
        ...pendingUpdate,
        revision: existing.revision + 1,
        updatedAt: now,
      })
      .where(and(
        eq(agentRuntimeProfiles.agentId, agentId),
        eq(agentRuntimeProfiles.revision, existing.revision),
      ))
      .returning();

    const result = updated || existing;
    return {
      value: result.pendingKind === "daemon_release_notice" ? result : null,
      emitDecisions: Boolean(updated),
    };
  });
  if (outcome.emitDecisions) {
    for (const decision of decisions) emitDaemonNotesDecision(...decision);
  }
  return outcome.value;
}

export async function clearRuntimeProfileMigrationForReset(
  agentId: string,
  launchId: string | null = null,
  migrationKey?: string | null,
): Promise<"cleared" | "none"> {
  if (!isDatabaseInitialized()) return "none";
  const db = getDb();
  const now = new Date();
  const conditions = [
    eq(agentRuntimeProfiles.agentId, agentId),
    eq(agentRuntimeProfiles.pendingKind, "migration"),
  ];
  if (migrationKey) {
    conditions.push(eq(agentRuntimeProfiles.pendingKey, migrationKey));
  }
  const [row] = await db.select()
    .from(agentRuntimeProfiles)
    .where(and(...conditions))
    .limit(1);
  if (!row) return "none";

  const [updated] = await db.update(agentRuntimeProfiles)
    .set({
      ...baselineFromPendingAfterColumns(row),
      ...clearPendingColumns(),
      migrationDeliveredAt: row.migrationDeliveredAt ?? now,
      migrationDeliveredLaunchId: row.migrationDeliveredLaunchId ?? launchId,
      migrationHandledAt: now,
      migrationHandledLaunchId: launchId,
      revision: row.revision + 1,
      updatedAt: now,
    })
    .where(and(
      eq(agentRuntimeProfiles.agentId, agentId),
      eq(agentRuntimeProfiles.revision, row.revision),
    ))
    .returning({ agentId: agentRuntimeProfiles.agentId });
  return updated ? "cleared" : "none";
}

export async function markRuntimeProfileMigrationDelivered(agentId: string, migrationKey: string, launchId: string | null): Promise<boolean> {
  const db = getDb();
  const now = new Date();
  const [row] = await db.select()
    .from(agentRuntimeProfiles)
    .where(and(
      eq(agentRuntimeProfiles.agentId, agentId),
      eq(agentRuntimeProfiles.pendingKey, migrationKey),
    ))
    .limit(1);
  if (!row) return false;

  const update = row.pendingKind === "migration"
    ? {
        ...baselineFromPendingAfterColumns(row),
        ...clearPendingColumns(),
        migrationDeliveredAt: now,
        migrationDeliveredLaunchId: launchId,
        migrationHandledAt: now,
        migrationHandledLaunchId: launchId,
      }
    : {
        baselineDaemonVersion: row.pendingAfterDaemonVersion ?? row.daemonVersion,
        ...clearPendingColumns(),
        migrationDeliveredAt: now,
        migrationDeliveredLaunchId: launchId,
      };

  const [updated] = await db.update(agentRuntimeProfiles)
    .set({
      ...update,
      revision: row.revision + 1,
      updatedAt: now,
    })
    .where(and(
      eq(agentRuntimeProfiles.agentId, agentId),
      eq(agentRuntimeProfiles.pendingKey, migrationKey),
      eq(agentRuntimeProfiles.revision, row.revision),
    ))
    .returning({ agentId: agentRuntimeProfiles.agentId });
  const delivered = Boolean(updated);
  if (delivered && row.pendingKind === "daemon_release_notice") {
    const notice = getAgentDaemonReleaseNotice(row.pendingBeforeDaemonVersion, row.pendingAfterDaemonVersion);
    emitDaemonNotesDecision(
      "delivered",
      "notice_acknowledged",
      row.pendingBeforeDaemonVersion,
      row.pendingAfterDaemonVersion ?? row.daemonVersion,
      daemonReleaseNoticeEntryCount(notice),
    );
  }
  return delivered;
}

export async function markRuntimeProfileMigrationHandled(agentId: string, migrationKey: string, launchId: string | null): Promise<boolean> {
  await clearRuntimeProfileMigrationForReset(agentId, launchId, migrationKey || null);
  return true;
}

export async function getRuntimeProfileMigrationNudgeCandidate(
  agentId: string,
  now: Date,
  nudgeAfterMs: number,
  nudgeIntervalMs: number,
  maxNudgeCount: number,
  executor?: DatabaseExecutor,
): Promise<RuntimeProfileRow | null> {
  void agentId;
  void now;
  void nudgeAfterMs;
  void nudgeIntervalMs;
  void maxNudgeCount;
  void executor;
  return null;
}

export async function markRuntimeProfileMigrationNudged(agentId: string, migrationKey: string): Promise<boolean> {
  const db = getDb();
  const now = new Date();
  const [row] = await db.select({ revision: agentRuntimeProfiles.revision, migrationNudgeCount: agentRuntimeProfiles.migrationNudgeCount })
    .from(agentRuntimeProfiles)
    .where(and(
      eq(agentRuntimeProfiles.agentId, agentId),
      eq(agentRuntimeProfiles.pendingKey, migrationKey),
      eq(agentRuntimeProfiles.pendingKind, "migration"),
      eq(agentRuntimeProfiles.migrationStatus, "migrating"),
    ))
    .limit(1);
  if (!row) return false;
  const [updated] = await db.update(agentRuntimeProfiles)
    .set({
      lastMigrationNudgeAt: now,
      migrationNudgeCount: row.migrationNudgeCount + 1,
      revision: row.revision + 1,
      updatedAt: now,
    })
    .where(and(
      eq(agentRuntimeProfiles.agentId, agentId),
      eq(agentRuntimeProfiles.pendingKey, migrationKey),
      eq(agentRuntimeProfiles.revision, row.revision),
    ))
    .returning({ agentId: agentRuntimeProfiles.agentId });
  return Boolean(updated);
}

export async function getPendingRuntimeProfileMigration(
  agentId: string,
  executor?: DatabaseExecutor,
): Promise<RuntimeProfileRow | null> {
  if (!executor && !isDatabaseInitialized()) return null;
  const db = executor ?? getDb();
  const [row] = await db.select()
    .from(agentRuntimeProfiles)
    .where(and(eq(agentRuntimeProfiles.agentId, agentId), eq(agentRuntimeProfiles.pendingKind, "migration")))
    .limit(1);
  return row || null;
}

export async function getPendingRuntimeProfileNotice(
  agentId: string,
  executor?: DatabaseExecutor,
): Promise<RuntimeProfileRow | null> {
  if (!executor && !isDatabaseInitialized()) return null;
  const db = executor ?? getDb();
  const [row] = await db.select()
    .from(agentRuntimeProfiles)
    .where(and(eq(agentRuntimeProfiles.agentId, agentId), eq(agentRuntimeProfiles.pendingKind, "daemon_release_notice")))
    .limit(1);
  return row || null;
}

export async function getPendingRuntimeProfileControl(
  agentId: string,
): Promise<{ kind: AgentRuntimeProfilePendingKind; key: string; message: string } | null> {
  const notice = await getPendingRuntimeProfileNotice(agentId);
  if (notice?.pendingKey) {
    return {
      kind: "daemon_release_notice",
      key: notice.pendingKey,
      message: renderRuntimeProfileMigrationMessage(notice),
    };
  }

  return null;
}

export async function isRuntimeProfileMigrationGated(agentId: string, executor?: DatabaseExecutor): Promise<boolean> {
  void agentId;
  void executor;
  return false;
}

function refFromRow(row: RuntimeProfileRow, prefix: "workspaceRef" | "workspacePathRef" | "sessionRef"): AgentRuntimeProfileRef | null {
  const ref = {
    label: row[`${prefix}Label`],
    path: row[`${prefix}Path`],
    machineId: row[`${prefix}MachineId`],
    runtime: row[`${prefix}Runtime`],
    reachable: row[`${prefix}Reachable`],
    reason: row[`${prefix}Reason`],
  } as AgentRuntimeProfileRef;
  return Object.values(ref).some((value) => value !== null && value !== undefined) ? ref : null;
}

function previousSessionFromRow(row: RuntimeProfileRow): AgentRuntimeProfileRef | null {
  const ref: AgentRuntimeProfileRef = {
    label: row.pendingPreviousSessionLabel,
    path: row.pendingPreviousSessionPath,
    machineId: row.pendingPreviousSessionMachineId,
    runtime: row.pendingPreviousSessionRuntime,
    reachable: row.pendingPreviousSessionReachable,
    reason: row.pendingPreviousSessionReason,
  };
  return Object.values(ref).some((value) => value !== null && value !== undefined) ? ref : null;
}

function snapshotFromCurrent(row: RuntimeProfileRow, machineName: string | null): AgentRuntimeProfileSnapshot {
  return {
    runtimeProfileFingerprint: row.runtimeProfileFingerprint,
    daemonVersion: row.daemonVersion,
    machineId: row.machineId,
    machineName,
    runtime: row.runtime,
    model: row.model,
    reasoningEffort: row.reasoningEffort as ReasoningEffort | null,
    executionMode: row.executionMode,
    workspaceRef: refFromRow(row, "workspaceRef"),
    workspacePathRef: refFromRow(row, "workspacePathRef"),
    sessionRef: refFromRow(row, "sessionRef"),
    observedAt: row.observedAt.toISOString(),
  };
}

function snapshotFromPending(row: RuntimeProfileRow, side: "before" | "after"): AgentRuntimeProfileSnapshot {
  const prefix = side === "before" ? "pendingBefore" : "pendingAfter";
  return {
    runtimeProfileFingerprint: row[`${prefix}RuntimeProfileFingerprint`] ?? undefined,
    daemonVersion: row[`${prefix}DaemonVersion`],
    machineId: row[`${prefix}MachineId`],
    runtime: row[`${prefix}Runtime`],
    model: row[`${prefix}Model`],
    reasoningEffort: row[`${prefix}ReasoningEffort`] as ReasoningEffort | null,
    executionMode: row[`${prefix}ExecutionMode`],
  };
}

function pendingFromRow(row: RuntimeProfileRow): AgentRuntimeProfilePending | null {
  if (!row.pendingKind || !row.pendingKey) return null;
  const before = snapshotFromPending(row, "before");
  const after = snapshotFromPending(row, "after");
  return {
    kind: row.pendingKind as AgentRuntimeProfilePendingKind,
    key: row.pendingKey,
    migratingSince: row.migratingSince?.toISOString() ?? null,
    lastNudgeAt: row.lastMigrationNudgeAt?.toISOString() ?? null,
    nudgeCount: row.migrationNudgeCount,
    before,
    after,
    changes: row.pendingKind === "migration" ? diffIdentity(
      {
        machineId: before.machineId || "",
        runtime: before.runtime || "",
        model: before.model || "",
        reasoningEffort: (before.reasoningEffort ?? null) as ReasoningEffort | null,
        executionMode: before.executionMode || "",
      },
      {
        machineId: after.machineId || "",
        runtime: after.runtime || "",
        model: after.model || "",
        reasoningEffort: (after.reasoningEffort ?? null) as ReasoningEffort | null,
        executionMode: after.executionMode || "",
      },
    ) : [],
    previousSessionRef: previousSessionFromRow(row),
  };
}

export async function getAgentRuntimeProfileSummary(
  agentId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<AgentRuntimeProfileSummary | null> {
  const [current] = await executor.select({
    profile: agentRuntimeProfiles,
    machineName: machines.name,
  })
    .from(agentRuntimeProfiles)
    .innerJoin(machines, eq(agentRuntimeProfiles.machineId, machines.id))
    .where(eq(agentRuntimeProfiles.agentId, agentId))
    .limit(1);

  if (!current) return null;
  return {
    current: snapshotFromCurrent(current.profile, current.machineName),
    migrationStatus: current.profile.migrationStatus as "stable" | "pending" | "migrating",
    pending: pendingFromRow(current.profile),
  };
}

export async function getAgentRuntimeProfileSummaries(
  agentIds: string[],
  opts: { traceQuery?: DbQueryTracer } = {},
): Promise<Map<string, AgentRuntimeProfileSummary>> {
  const result = new Map<string, AgentRuntimeProfileSummary>();
  if (agentIds.length === 0) return result;
  const traceQuery = opts.traceQuery ?? untracedDbQuery;
  const rows = await traceQuery(
    "agents.runtime_profiles_by_agents",
    () => getDb().select({
      profile: agentRuntimeProfiles,
      machineName: machines.name,
    })
      .from(agentRuntimeProfiles)
      .innerJoin(machines, eq(agentRuntimeProfiles.machineId, machines.id))
      .where(inArray(agentRuntimeProfiles.agentId, agentIds)),
    (rows) => ({
      row_count: rows.length,
      input_count: agentIds.length,
    }),
  );
  for (const row of rows) {
    result.set(row.profile.agentId, {
      current: snapshotFromCurrent(row.profile, row.machineName),
      migrationStatus: row.profile.migrationStatus as "stable" | "pending" | "migrating",
      pending: pendingFromRow(row.profile),
    });
  }
  return result;
}

export async function loadAgentRuntimeProfileContext(agentId: string) {
  const db = getDb();
  const [row] = await db.select({
    agent: agents,
    machine: machines,
  })
    .from(agents)
    .innerJoin(machines, eq(agents.machineId, machines.id))
    .where(eq(agents.id, agentId))
    .limit(1);
  return row || null;
}

export function renderRuntimeProfileMigrationMessage(profile: RuntimeProfileRow): string {
  if (!profile.pendingKind) {
    return "Runtime Profile changed.";
  }
  if (profile.pendingKind === "daemon_release_notice") {
    const notice = getAgentDaemonReleaseNotice(profile.pendingBeforeDaemonVersion, profile.pendingAfterDaemonVersion);
    if (notice) return renderAgentDaemonReleaseNotice(notice);
    return `Runtime Profile notice: daemon upgraded ${profile.pendingBeforeDaemonVersion ?? "unknown"} -> ${profile.pendingAfterDaemonVersion ?? "unknown"}.`;
  }
  const changes = pendingFromRow(profile)?.changes || [];
  const notice = getAgentDaemonReleaseNotice(profile.pendingBeforeDaemonVersion, profile.pendingAfterDaemonVersion);
  const lines = [
    "Runtime Profile changed. Slock reset the runtime session for this change; no migration acknowledgment is required.",
    ...changes.map((change) => `- ${change.field}: ${String(change.before ?? "null")} -> ${String(change.after ?? "null")}`),
    notice ? "" : null,
    notice ? renderAgentDaemonReleaseNotice(notice) : null,
    "",
    "Continue from MEMORY.md and the current workspace. Normal inbox delivery is not gated by this reset notice.",
  ].filter(Boolean);
  return lines.join("\n");
}

export function renderRuntimeProfileMigrationNudgeMessage(profile: RuntimeProfileRow): string {
  void profile;
  return [
    "Runtime Profile migration acknowledgments are deprecated.",
    "Runtime Profile changes now reset the runtime session automatically; no action is required.",
  ].join("\n");
}
