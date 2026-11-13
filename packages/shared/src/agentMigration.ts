import { z } from "zod";
import { lazySchema } from "./lazySchema";
import { agentMigrationUserIgnoreAdditionsReceiptSchema } from "./agentMigrationUserIgnore";

export const AGENT_MIGRATION_STATES = [
  "provisioning",
  "prep",
  "ready",
  "in_transit",
  "arriving",
  "starting",
  "cancel_requested_pre_flip",
  "cancel_requested_post_flip",
  "canceled_pre_flip",
  "canceled_post_flip",
  "completed",
  "aborted",
  "failed",
] as const;

export const agentMigrationSupportRefSchema = lazySchema("agentMigrationSupportRefSchema", () => z.string().regex(/^mig_[A-Za-z0-9_-]{22}$/));

export const MAX_AGENT_MIGRATION_TRANSPORT_BYTES = 10 * 1024 * 1024 * 1024;
export const MAX_AGENT_MIGRATION_TRANSFER_FILE_COUNT = 1_000_000;
export const MAX_AGENT_MIGRATION_TRANSFER_BYTES = MAX_AGENT_MIGRATION_TRANSPORT_BYTES;
export const MAX_AGENT_MIGRATION_EXCLUDED_REGENERABLE_COUNT = 1_000_000;

const boundedTransferCountSchema = lazySchema("boundedTransferCountSchema", () => z.number().int().nonnegative().max(MAX_AGENT_MIGRATION_TRANSFER_FILE_COUNT));
const boundedExcludedCountSchema = lazySchema("boundedExcludedCountSchema", () => z.number().int().nonnegative().max(MAX_AGENT_MIGRATION_EXCLUDED_REGENERABLE_COUNT));

const agentMigrationIgnoredSourceTotalsSchema = lazySchema("agentMigrationIgnoredSourceTotalsSchema", () => z.object({
  count: boundedExcludedCountSchema,
  fileCount: boundedExcludedCountSchema,
  bytes: z.number().int().nonnegative(),
}).strict());

/**
 * Where the `excludedIgnored` paths were listed. Each ignored path is counted
 * once, in the first source that matched in the order userFile
 * (`.raftbackupignore.user`) > agentFile (`.raftbackupignore`) > legacyFile
 * (`.raftmigrateignore`); it is additionally counted in `wildcard` when that
 * match came through an any-depth (`**`-prefixed) pattern. Only a Computer that saw the
 * Server advertise SERVER_CAPABILITY_MIGRATION_BACKUP_IGNORE_SOURCES_V1 sends it.
 */
export const agentMigrationIgnoredBySourceSchema = lazySchema("agentMigrationIgnoredBySourceSchema", () => z.object({
  agentFile: agentMigrationIgnoredSourceTotalsSchema,
  legacyFile: agentMigrationIgnoredSourceTotalsSchema,
  userFile: agentMigrationIgnoredSourceTotalsSchema,
  wildcard: agentMigrationIgnoredSourceTotalsSchema,
}).strict());

const IGNORED_SOURCE_TOTAL_KEYS = ["count", "fileCount", "bytes"] as const;

export const agentMigrationTransferSummarySchema = lazySchema("agentMigrationTransferSummarySchema", () => z.object({
  includedFileCount: boundedTransferCountSchema,
  includedBytes: z.number().int().nonnegative().max(MAX_AGENT_MIGRATION_TRANSFER_BYTES),
  excludedRegenerableCount: boundedExcludedCountSchema,
  excludedRegenerableByCategory: z.object({
    thirdPartyDependencies: boundedExcludedCountSchema,
    caches: boundedExcludedCountSchema,
    buildArtifacts: boundedExcludedCountSchema,
    otherRegenerable: boundedExcludedCountSchema,
  }).strict(),
  keyWorkspaceEntries: z.object({
    memoryMdPresent: z.boolean(),
    notesPresent: z.boolean(),
  }).strict(),
  // Paths listed in `.raftmigrateignore` / `.raftbackupignore` /
  // `.raftbackupignore.user` (absent when none were).
  excludedIgnored: z.object({
    count: boundedExcludedCountSchema,
    fileCount: boundedExcludedCountSchema,
    bytes: z.number().int().nonnegative(),
    largest: z.array(z.object({
      path: z.string().min(1).max(4096),
      bytes: z.number().int().nonnegative(),
    }).strict()).max(5),
  }).strict().optional(),
  excludedIgnoredBySource: agentMigrationIgnoredBySourceSchema.optional(),
}).strict().superRefine((summary, ctx) => {
  const categorized = Object.values(summary.excludedRegenerableByCategory)
    .reduce((total, count) => total + count, 0);
  if (categorized !== summary.excludedRegenerableCount) {
    ctx.addIssue({
      code: "custom",
      path: ["excludedRegenerableByCategory"],
      message: "excluded regenerable category counts must sum to excludedRegenerableCount",
    });
  }
  const bySource = summary.excludedIgnoredBySource;
  if (bySource) {
    const ignored = summary.excludedIgnored;
    if (!ignored) {
      ctx.addIssue({
        code: "custom",
        path: ["excludedIgnoredBySource"],
        message: "excludedIgnoredBySource requires excludedIgnored",
      });
      return;
    }
    for (const key of IGNORED_SOURCE_TOTAL_KEYS) {
      // Sources partition the ignored paths, so they never exceed the total.
      const sourced = bySource.userFile[key] + bySource.agentFile[key] + bySource.legacyFile[key];
      if (sourced > ignored[key]) {
        ctx.addIssue({
          code: "custom",
          path: ["excludedIgnoredBySource", key],
          message: `ignore-file ${key} must not exceed excludedIgnored.${key}`,
        });
      }
      // Wildcard is a subset of those same paths, not a further source.
      if (bySource.wildcard[key] > sourced) {
        ctx.addIssue({
          code: "custom",
          path: ["excludedIgnoredBySource", "wildcard", key],
          message: `wildcard ${key} must not exceed the ignore-file ${key} total`,
        });
      }
    }
  }
}));

export type AgentMigrationTransferSummary = z.infer<typeof agentMigrationTransferSummarySchema>;

export const AGENT_MIGRATION_SOURCE_BUILD_PHASES = ["scanning", "packing", "hashing"] as const;

/** Bundle-build progress a source daemon reports between quiesce and control registration. */
export const agentMigrationSourceBuildProgressReportSchema = lazySchema("agentMigrationSourceBuildProgressReportSchema", () => z.object({
  migrationGeneration: z.string().min(1).max(512),
  phase: z.enum(AGENT_MIGRATION_SOURCE_BUILD_PHASES),
  files: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  /**
   * What the source did with the lease's `userIgnoreAdditions`, on its first
   * report after writing them. Sent only to a Server that advertises
   * SERVER_CAPABILITY_MIGRATION_USER_IGNORE_RECEIPT_V1: this schema is strict,
   * so an older Server rejects the field.
   */
  userIgnoreAdditions: agentMigrationUserIgnoreAdditionsReceiptSchema.optional(),
}).strict());

export type AgentMigrationSourceBuildProgress = {
  phase: (typeof AGENT_MIGRATION_SOURCE_BUILD_PHASES)[number];
  files: number;
  bytes: number;
  reportedAt: string;
};

/** What a draining source waits for before it stops the agent. A value outside this set is stored as `other`. */
export const AGENT_MIGRATION_SOURCE_DRAIN_WAITING_FOR = ["turn", "background_tasks", "queued_input", "other"] as const;
export type AgentMigrationSourceDrainWaitingFor = (typeof AGENT_MIGRATION_SOURCE_DRAIN_WAITING_FOR)[number];

/** Folds a reported `waitingFor` into the fixed set: missing stays missing, anything unknown is `other`. */
export function normalizeAgentMigrationSourceDrainWaitingFor(value: unknown): AgentMigrationSourceDrainWaitingFor | null {
  if (value === undefined || value === null) return null;
  return (AGENT_MIGRATION_SOURCE_DRAIN_WAITING_FOR as readonly unknown[]).includes(value)
    ? value as AgentMigrationSourceDrainWaitingFor
    : "other";
}

/**
 * The source's report while it waits (before quiesce, up to the lease's
 * `sourceDrainUntil`) for the agent to finish its current work. Sent to the
 * same source-progress endpoint, only to a Server that advertises
 * SERVER_CAPABILITY_MIGRATION_SOURCE_DRAIN_PROGRESS_V1 (an older Server's
 * strict build-progress schema rejects it). `drainUntil` is the source's own
 * estimate; the Server clamps it to [now, the lease's sourceDrainUntil] and
 * reads an unparseable one as that cap. `waitingFor` is bounded but not
 * enumerated on the wire: the Server folds it into
 * AGENT_MIGRATION_SOURCE_DRAIN_WAITING_FOR.
 */
export const agentMigrationSourceDrainProgressReportSchema = lazySchema("agentMigrationSourceDrainProgressReportSchema", () => z.object({
  migrationGeneration: z.string().min(1).max(512),
  phase: z.literal("draining"),
  drainUntil: z.string().max(64),
  waitingFor: z.string().max(64).optional(),
}).strict());

/** What the Server stores for a draining source (`agent_migrations.source_build_progress`, until quiesce or the first build report). */
export type AgentMigrationSourceDrainRecord = {
  phase: "draining";
  drainUntil: string;
  waitingFor: AgentMigrationSourceDrainWaitingFor | null;
  reportedAt: string;
};

/** Owner status (`GET /agents/:id/migration`) `sourceDrain`: the source waits until `until` for the agent; null otherwise. */
export type AgentMigrationSourceDrain = {
  until: string;
  waitingFor: AgentMigrationSourceDrainWaitingFor | null;
  reportedAt: string;
};

/** Bytes and chunks of the bundle the target Computer has downloaded; owner status only, not the realtime payload. */
export type AgentMigrationTransferProgress = {
  receivedBytes: number;
  totalBytes: number;
  receivedChunks: number;
  totalChunks: number;
};

/** Where a migration moves the agent: another Computer, or Raft hosted (antiproton). */
export const AGENT_MIGRATION_TARGET_KINDS = ["computer", "hosted"] as const;
export type AgentMigrationTargetKind = (typeof AGENT_MIGRATION_TARGET_KINDS)[number];

/** The workspace-size codes a migration source reports when the workspace is too big to move. */
export const AGENT_MIGRATION_WORKSPACE_SIZE_ERROR_CODES = [
  "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED",
  "MIGRATION_OBJECT_STORE_BUNDLE_TOO_LARGE",
] as const;
export type AgentMigrationWorkspaceSizeErrorCode = (typeof AGENT_MIGRATION_WORKSPACE_SIZE_ERROR_CODES)[number];

/** The size code a failed migration's `transport_error_code` / `transport_error_message` carries, if any. */
export function agentMigrationWorkspaceSizeErrorCode(failure: {
  transportErrorCode: string | null;
  transportErrorMessage: string | null;
}): AgentMigrationWorkspaceSizeErrorCode | null {
  for (const code of AGENT_MIGRATION_WORKSPACE_SIZE_ERROR_CODES) {
    if (failure.transportErrorMessage?.startsWith(code) || failure.transportErrorCode?.startsWith(code)) return code;
  }
  return null;
}

/**
 * How close the agent's workspace is to the limits of a migration to another
 * Computer, sent in `AgentConfig.migrationReadiness` so the daemon can remind
 * the agent to keep `.raftbackupignore` current before a move fails for size.
 */
export type AgentMigrationReadiness = {
  /** The limits a migration from a Computer faces today. */
  limits: { maxBytes: number; maxEntries: number };
  /**
   * The latest measurement of the workspace. `packed`: the files and
   * (uncompressed) bytes the last successful move carried, `at` its arrival on
   * the target (written once, before the agent starts there). `failed`: what the
   * last size failure measured, newer than any successful move; the value the
   * failure did not measure is carried over from the older `packed` one (0 if
   * none), and `bytes` from a too-large failure is a lower bound.
   */
  lastMeasured?: { files: number; bytes: number; at: string; source: "packed" | "failed" };
  /**
   * The last size failure newer than any successful move. `migrationId` (the
   * migration's id) identifies it; `at` is when it failed, written once, so
   * both stay the same on every later start. `topPaths` (at most 3) are
   * top-level paths with their entry counts or bytes.
   */
  lastSizeFailure?: {
    migrationId: string;
    at: string;
    code: AgentMigrationWorkspaceSizeErrorCode;
    topPaths: Array<{ path: string; value: number }>;
  };
};

/** antiproton `GET /provision/import-limits`, fixed on the migration at preflight. */
export type AgentMigrationHostedImportLimits = {
  maxTotalBytes: number;
  maxFiles: number;
  maxFileBytes: number;
};

export const AGENT_MIGRATION_HOSTED_SKIP_REASONS = [
  "symlink",
  "git",
  "raft_state",
  "path_rule",
  "reserved",
  "file_too_large",
  "not_text",
  "over_budget",
  "provider_rejected",
] as const;
export type AgentMigrationHostedSkipReason = (typeof AGENT_MIGRATION_HOSTED_SKIP_REASONS)[number];

/** What a hosted import brings over and what it leaves behind, shown before the switch and in the receipt. */
export type AgentMigrationHostedImportSummary = {
  importedFileCount: number;
  importedBytes: number;
  skipped: Array<{
    reason: AgentMigrationHostedSkipReason;
    count: number;
    bytes: number;
    /** The largest skipped paths for this reason, bounded. */
    largestPaths: string[];
  }>;
};

export const agentMigrationUpdatedPayloadSchema = lazySchema("agentMigrationUpdatedPayloadSchema", () => z.object({
  agentId: z.string().uuid(),
  migrationRef: agentMigrationSupportRefSchema,
  state: z.enum(AGENT_MIGRATION_STATES),
  revision: z.number().int().positive(),
  authority: z.enum(["source", "target"]),
  disposition: z.enum(["pre_flip_source_authoritative", "post_flip_target_authoritative"]).nullable(),
  needsAttention: z.boolean(),
  dispatchAttempts: z.number().int().nonnegative(),
  attentionDeadlineAt: z.string().datetime().nullable(),
  sourceAcknowledgedAt: z.string().datetime().nullable(),
  targetAcknowledgedAt: z.string().datetime().nullable(),
  targetOutcome: z.enum(["cleaned", "stopped"]).nullable(),
  canceledAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
}).strict());

export type AgentMigrationUpdatedPayload = z.infer<typeof agentMigrationUpdatedPayloadSchema>;
