import type { IntlShape } from "react-intl";
import { getRuntimeDisplayName } from "@botiverse/raft-shared";
import type {
  AgentMigrationUserErrorCode,
} from "@botiverse/raft-shared";

import type { MessageId } from "../../i18n/messages";

export interface MigrationErrorPresentation {
  /** Shown first, on its own line: where the agent is now. */
  placement?: string;
  message: string;
  issues?: string[];
  technicalCode?: string;
  diagnosticRef?: string;
  recovery?: "open_computers_and_retry";
  recoveryComputerId?: string;
}

/** Which computer must upgrade Raft Computer before it can migrate. */
export interface MigrationResumableCapabilityDetail {
  side: "source" | "target" | "both";
  reason: "capability_missing";
}

export type MigrationComputerCapabilitySide = "source" | "target";
export type MigrationComputerCapabilityReason =
  | "runtime_unconfirmed"
  | "runtime_missing";

export interface MigrationComputerCapabilityFailure {
  side: MigrationComputerCapabilitySide;
  reason: MigrationComputerCapabilityReason;
  runtime: string;
}

export interface MigrationComputerCapabilityDetails {
  failures: MigrationComputerCapabilityFailure[];
}

const SAFE_RUNTIME_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export function parseMigrationComputerCapabilityDetails(
  value: unknown,
): MigrationComputerCapabilityDetails | null {
  if (!value || typeof value !== "object") return null;
  const failures = (value as { failures?: unknown }).failures;
  if (!Array.isArray(failures) || failures.length < 1 || failures.length > 2) return null;

  const parsed: MigrationComputerCapabilityFailure[] = [];
  const identities = new Set<string>();
  for (const candidate of failures) {
    if (!candidate || typeof candidate !== "object") return null;
    const failure = candidate as {
      side?: unknown;
      reason?: unknown;
      runtime?: unknown;
    };
    if (failure.side !== "source" && failure.side !== "target") return null;
    if (failure.reason !== "runtime_unconfirmed" && failure.reason !== "runtime_missing") return null;
    if (identities.has(failure.side)) return null;
    identities.add(failure.side);
    if (typeof failure.runtime !== "string" || !SAFE_RUNTIME_ID.test(failure.runtime)) return null;
    parsed.push({ side: failure.side, reason: failure.reason, runtime: failure.runtime });
  }

  return { failures: parsed };
}

export function parseMigrationResumableCapabilityDetail(
  value: unknown,
): MigrationResumableCapabilityDetail | null {
  if (!value || typeof value !== "object") return null;
  const detail = value as { side?: unknown; reason?: unknown };
  if (detail.side !== "source" && detail.side !== "target" && detail.side !== "both") return null;
  if (detail.reason !== "capability_missing") return null;
  return { side: detail.side, reason: detail.reason };
}

export interface MigrationErrorInput {
  code?: string | null;
  rawMessage?: string | null;
  /** Structured server `details` when a code needs them (task #1268: TARGET_RUNTIME_DETECTION_PENDING). */
  details?: unknown;
  context: "start" | "status" | "failed" | "aborted";
  reason?: string | null;
  computerCapabilityDetails?: MigrationComputerCapabilityDetails | null;
  resumableCapabilityDetail?: MigrationResumableCapabilityDetail | null;
  sourceComputerName?: string | null;
  targetComputerName?: string | null;
  sourceComputerId?: string | null;
  targetComputerId?: string | null;
  sourceComputerStatus?: "online" | "offline" | null;
  targetComputerStatus?: "online" | "offline" | null;
  /**
   * Conventional workspace location, used only to tell the user where to look
   * on a workspace conflict. It reflects the default Raft home, not a path read
   * from the target, so copy presents it as a place to check, not a fact.
   */
  agentWorkspacePath?: string | null;
  transportLostAt?: string | null;
  formatTimestamp?: ((value: string) => string) | null;
}

type KnownMigrationErrorCode = AgentMigrationUserErrorCode;

type Format = IntlShape["formatMessage"];

const GIB = 1024 ** 3;
const SAFE_TECHNICAL_CODE = /^[A-Za-z][A-Za-z0-9_-]{1,127}$/;

function timestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function transportLostMessage(fm: Format, input: MigrationErrorInput): string {
  if (input.context !== "failed") {
    return fm({ id: "migration.error.transportLost" });
  }
  const transportLostAtMs = timestampMs(input.transportLostAt);
  const formattedLostAt = transportLostAtMs !== null && input.transportLostAt && input.formatTimestamp
    ? input.formatTimestamp(input.transportLostAt)
    : null;
  const event = formattedLostAt
    ? fm({ id: "migration.error.transportLostAt" }, { time: formattedLostAt })
    : fm({ id: "migration.error.transportLostEvent" });

  const sourceKnown = Boolean(input.sourceComputerName)
    && (input.sourceComputerStatus === "online" || input.sourceComputerStatus === "offline");
  const targetKnown = Boolean(input.targetComputerName)
    && (input.targetComputerStatus === "online" || input.targetComputerStatus === "offline");
  const sourceOffline = input.sourceComputerStatus === "offline";
  const targetOffline = input.targetComputerStatus === "offline";
  const retry = sourceKnown && targetKnown && !sourceOffline && !targetOffline
    ? fm({ id: "migration.error.transportLostRetryReady" })
    : sourceKnown && targetKnown && sourceOffline && targetOffline
      ? fm(
          { id: "migration.error.transportLostRetryBothOffline" },
          { source: input.sourceComputerName, target: input.targetComputerName },
        )
      : sourceKnown && targetKnown && (sourceOffline || targetOffline)
        ? fm(
            { id: "migration.error.transportLostRetryOneOffline" },
            { computer: sourceOffline ? input.sourceComputerName : input.targetComputerName },
          )
        : fm({ id: "migration.error.transportLostRetryUnknown" });

  return `${event} ${retry}`;
}

function wireInteger(rawMessage: string | null | undefined, key: string): number | null {
  const match = rawMessage?.match(new RegExp(`(?:^|:)${key}=(\\d+)(?=:|$)`));
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function wireString(rawMessage: string | null | undefined, key: string): string | null {
  const match = rawMessage?.match(new RegExp(`(?:^|:)${key}=([^:]*)`));
  return match?.[1] ?? null;
}

function formatBinaryUnit(bytes: number, unitBytes: number, unit: string): string {
  const value = bytes / unitBytes;
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

function formatGib(bytes: number): string {
  return formatBinaryUnit(bytes, GIB, "GiB");
}

/**
 * A workspace size in the binary units the size-limit copy uses ("10 GiB"),
 * so sizes on the migration card read in the same unit as its limit: GiB from
 * 1 GiB (exactly as formatGib), MiB or KiB below, so a trimmed workspace never
 * reads as "0.0 GiB".
 */
export function formatMigrationSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(Number.isFinite(bytes) ? bytes : 0))} B`;
  if (bytes < 1024 ** 2) return formatBinaryUnit(bytes, 1024, "KiB");
  if (bytes < GIB) return formatBinaryUnit(bytes, 1024 ** 2, "MiB");
  return formatGib(bytes);
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function parseLargestEntries(rawMessage: string | null | undefined): Array<{ path: string; sizeBytes: number }> {
  const encoded = wireString(rawMessage, "topEntries");
  if (!encoded) return [];
  const entries: Array<{ path: string; sizeBytes: number }> = [];
  for (const item of encoded.split(";").slice(0, 3)) {
    const separator = item.lastIndexOf(",");
    if (separator <= 0) continue;
    let accountingPath: string;
    try {
      accountingPath = decodeURIComponent(item.slice(0, separator));
    } catch {
      continue;
    }
    const sizeBytes = Number(item.slice(separator + 1));
    if (
      !accountingPath
      || accountingPath.length > 128
      || hasControlCharacters(accountingPath)
      || !Number.isSafeInteger(sizeBytes)
      || sizeBytes < 0
    ) {
      continue;
    }
    entries.push({ path: accountingPath, sizeBytes });
  }
  return entries;
}

function isSafeAccountingPath(value: string): boolean {
  const basename = value.endsWith("/") ? value.slice(0, -1) : value;
  return Boolean(basename)
    && basename !== "."
    && basename !== ".."
    && !value.startsWith("/")
    && !value.startsWith("\\")
    && !value.includes("\\")
    && !basename.includes("/")
    && !/^[A-Za-z]:/.test(value)
    && !/^\.env(?:\.|$)/i.test(basename)
    && !/(?:secret|token|credential|api[-_]?key)/i.test(basename);
}

function parseTopPathCounts(
  rawMessage: string | null | undefined,
  key = "topPaths",
  strict = false,
): Array<{ path: string; entryCount: number }> | null {
  const encoded = wireString(rawMessage, key);
  if (encoded === null) return strict ? null : [];
  if (!encoded) return [];
  const items = encoded.split(";");
  if (strict && items.length > 3) return null;
  const entries: Array<{ path: string; entryCount: number }> = [];
  for (const item of items.slice(0, 3)) {
    const separator = item.lastIndexOf(",");
    if (separator <= 0) {
      if (strict) return null;
      continue;
    }
    let accountingPath: string;
    try {
      accountingPath = decodeURIComponent(item.slice(0, separator));
    } catch {
      if (strict) return null;
      continue;
    }
    const entryCount = Number(item.slice(separator + 1));
    if (
      !accountingPath
      || accountingPath.length > 128
      || hasControlCharacters(accountingPath)
      || !isSafeAccountingPath(accountingPath)
      || !Number.isSafeInteger(entryCount)
      || entryCount <= 0
    ) {
      if (strict) return null;
      continue;
    }
    entries.push({ path: accountingPath, entryCount });
  }
  return entries;
}

function bundleTooLargeMessage(fm: Format, rawMessage: string | null | undefined): string {
  const maxBytes = wireInteger(rawMessage, "maxBytes");
  const largestEntries = parseLargestEntries(rawMessage);
  // `items` is a select argument, not a concatenated fragment: the optional
  // clause lives INSIDE the message so a translation controls where it sits and
  // whether it needs different punctuation.
  const items = largestEntries.length > 0
    ? largestEntries.map((entry) => `${entry.path} (${formatGib(entry.sizeBytes)})`).join(", ")
    : "none";
  return maxBytes !== null
    ? fm({ id: "migration.error.bundleTooLargeWithLimit" }, { limit: formatGib(maxBytes), items })
    : fm({ id: "migration.error.bundleTooLarge" }, { items });
}

function manifestTooLargeMessage(fm: Format, rawMessage: string | null | undefined): string {
  const entryCount = wireInteger(rawMessage, "entryCount");
  const topPaths = parseTopPathCounts(rawMessage) ?? [];
  // Counts, including each list item's, go through ICU `{n, number}` so they
  // group per app locale.
  const paths = topPaths.length > 0
    ? topPaths
        .map((entry) => fm({ id: "migration.error.pathEntryCount" }, { path: entry.path, count: entry.entryCount }))
        .join(", ")
    : "none";
  return entryCount !== null
    ? fm({ id: "migration.error.manifestTooLargeWithCount" }, { count: entryCount, paths })
    : fm({ id: "migration.error.manifestTooLarge" }, { paths });
}

interface EntryCountRecovery {
  entryCount: number;
  maxEntries: number;
  topPathCounts: Array<{ path: string; entryCount: number }>;
}

function entryCountRecovery(rawMessage: string | null | undefined): EntryCountRecovery | null {
  const entryCount = wireInteger(rawMessage, "entryCount");
  const maxEntries = wireInteger(rawMessage, "maxEntries");
  const topPathCounts = parseTopPathCounts(rawMessage, "topPathCounts", true);
  if (
    entryCount === null
    || maxEntries === null
    || maxEntries <= 0
    || entryCount <= maxEntries
    || topPathCounts === null
    || topPathCounts.some((entry) => entry.entryCount > entryCount)
  ) {
    return null;
  }
  return { entryCount, maxEntries, topPathCounts };
}

function entryCountLimitMessage(fm: Format, rawMessage: string | null | undefined): string {
  const recovery = entryCountRecovery(rawMessage);
  if (!recovery) return fm({ id: "migration.error.entryCountLimitExceeded" });
  const paths = recovery.topPathCounts.length > 0
    ? recovery.topPathCounts
        .map((entry) => fm(
          { id: "migration.error.pathEntryCount" },
          { path: entry.path, count: entry.entryCount },
        ))
        .join(", ")
    : "none";
  return fm(
    { id: "migration.error.entryCountLimitExceededWithDetails" },
    { count: recovery.entryCount, limit: recovery.maxEntries, paths },
  );
}

function insufficientDiskMessage(fm: Format, rawMessage: string | null | undefined): string {
  const requiredBytes = wireInteger(rawMessage, "requiredBytes");
  const availableBytes = wireInteger(rawMessage, "availableBytes");
  return requiredBytes !== null && availableBytes !== null
    ? fm(
        { id: "migration.error.insufficientDiskWithSizes" },
        { required: formatGib(requiredBytes), available: formatGib(availableBytes) },
      )
    : fm({ id: "migration.error.insufficientDisk" });
}

// code -> MessageId (ids, never sentences, so copy stays translatable). Partial
// because some codes use builders below; exhaustiveness is checked over all
// tables after MIGRATION_INPUT_BUILDERS.
const MIGRATION_ERROR_IDS = {
  not_supported: "migration.error.notSupported",
  AGENT_NOT_FOUND: "migration.error.agentNotFound",
  TARGET_COMPUTER_REQUIRED: "migration.error.targetRequired",
  AGENT_HAS_NO_SOURCE_MACHINE: "migration.error.noSourceMachine",
  TARGET_COMPUTER_NOT_IN_SERVER: "migration.error.targetNotInServer",
  TARGET_COMPUTER_MATCHES_SOURCE: "migration.error.targetMatchesSource",
  COMPUTER_CAPABILITY_INSUFFICIENT: "migration.error.capabilityInsufficient",
  TARGET_COMPUTER_OFFLINE: "migration.error.targetOffline",
  HOSTED_TARGET_UNAVAILABLE: "migration.error.hostedUnavailable",
  HOSTED_TARGET_ALREADY_USED: "migration.error.hostedAlreadyUsed",
  HOSTED_TARGET_MODEL_INVALID: "migration.error.hostedModelInvalid",
  HOSTED_REVIEW_NOT_READY: "migration.error.hostedReviewNotReady",
  HOSTED_IMPORT_MEMORY_UNIMPORTABLE: "migration.error.hostedMemoryUnimportable",
  MIGRATION_NOT_CANCELABLE: "migration.error.notCancelable",
  MIGRATION_ALREADY_IN_PROGRESS: "migration.error.alreadyInProgress",
  MIGRATION_PRO_PLAN_REQUIRED: "migration.error.proPlanRequired",
  MIGRATION_TRANSPORT_NOT_PROVISIONED: "migration.error.transportNotProvisioned",
  MIGRATION_TRANSPORT_PROVISION_FAILED: "migration.error.transportProvisionFailed",
  MIGRATION_WORKSPACE_ALREADY_EXISTS: "migration.error.workspaceAlreadyExists",
  MIGRATION_WORKSPACE_COMPLETE_OLD_COPY: "migration.error.workspaceCompleteOldCopy",
  MIGRATION_OBJECT_STORE_UNREACHABLE: "migration.error.objectStoreUnreachable",
  MIGRATION_COMPUTER_OWNER_DELETED: "migration.error.computerOwnerDeleted",
  MIGRATION_TARGET_COMPUTER_DETACHED: "migration.error.targetComputerDetached",
  MIGRATION_TRANSFER_SUMMARY_INVALID: "migration.error.transferSummaryInvalid",
  MIGRATION_USER_IGNORE_WRITE_FAILED: "migration.error.userIgnoreWriteFailed",
  // Transient transfer faults: the user can only retry, so they share one line.
  MIGRATION_CHUNK_DIGEST_MISMATCH: "migration.error.failedGeneric",
  MIGRATION_WHOLE_BUNDLE_DIGEST_MISMATCH: "migration.error.failedGeneric",
  MIGRATION_LEASE_EXPIRED: "migration.error.failedGeneric",
  MIGRATION_GENERATION_STALE: "migration.error.failedGeneric",
  MIGRATION_CONTROL_MANIFEST_INVALID: "migration.error.controlManifestInvalid",
  MIGRATION_CONTROL_MANIFEST_TOO_LARGE: "migration.error.entryCountLimitExceeded",
  MIGRATION_REF_INVALID: "migration.error.refInvalid",
  MIGRATION_REVISION_INVALID: "migration.error.revisionInvalid",
  MIGRATION_NOT_FOUND: "migration.error.notFound",
  MIGRATION_REVISION_STALE: "migration.error.revisionStale",
  MIGRATION_CONCURRENT_UPDATE: "migration.error.concurrentUpdate",
  MIGRATION_CANCEL_FAILED: "migration.error.cancelFailed",
  MIGRATION_START_FAILED: "migration.error.startFailed",
  MIGRATION_STATUS_FAILED: "migration.error.statusFailed",
} as const satisfies Partial<Record<KnownMigrationErrorCode, MessageId>>;

// The four codes whose copy is assembled from wire data.
const MIGRATION_ERROR_BUILDERS = {
  MIGRATION_OBJECT_STORE_BUNDLE_TOO_LARGE: bundleTooLargeMessage,
  MIGRATION_OBJECT_STORE_MANIFEST_TOO_LARGE: manifestTooLargeMessage,
  MIGRATION_OBJECT_STORE_INSUFFICIENT_DISK: insufficientDiskMessage,
  MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED: entryCountLimitMessage,
} as const satisfies Partial<Record<KnownMigrationErrorCode, (fm: Format, raw: string | null | undefined) => string>>;

/**
 * The conventional location of an agent's workspace (the same convention the
 * Workspace tab shows), derived from the agent id rather than sent on the wire.
 */
export function conventionalAgentWorkspacePath(agentId: string | null | undefined): string | null {
  const id = agentId?.trim();
  // No `/workspace` suffix: the daemon uses `path.join(agentsDataDir, agentId)`
  // itself as the workspace, and `agentsDataDir` defaults to `agents` under the
  // Raft home.
  return id ? `~/.slock/agents/${id}` : null;
}

/**
 * Workspace-conflict copy: points at where to look and says to rename/move,
 * never delete. This fires when two copies exist and the user does not yet know
 * which is current, so a delete instruction could destroy the wrong one.
 */
function workspaceConflictMessage(
  datedId: MessageId,
  plainId: MessageId,
): (fm: Format, input: MigrationErrorInput) => string {
  return (fm, input) => {
    const path = input.agentWorkspacePath?.trim();
    return path ? fm({ id: datedId }, { path }) : fm({ id: plainId });
  };
}

/** task #1268: the target is still detecting (pending) or never probed (incomplete) the agent's runtime; both retryable. */
function targetRuntimeDetectionMessage(formatMessage: Format, input: MigrationErrorInput): string {
  const details = (input.details ?? {}) as { detectionStatus?: unknown; runtime?: unknown };
  if (details.detectionStatus === "incomplete") {
    return formatMessage({ id: "migration.error.targetRuntimeDetectionIncomplete" }, { runtime: typeof details.runtime === "string" ? details.runtime : "" });
  }
  return formatMessage({ id: "migration.error.targetRuntimeDetectionPending" });
}

const MIGRATION_INPUT_BUILDERS = {
  TARGET_RUNTIME_DETECTION_PENDING: targetRuntimeDetectionMessage,
  MIGRATION_TRANSPORT_LOST: transportLostMessage,
  MIGRATION_WORKSPACE_ALREADY_EXISTS: workspaceConflictMessage(
    "migration.error.workspaceAlreadyExistsAt",
    "migration.error.workspaceAlreadyExists",
  ),
  MIGRATION_WORKSPACE_COMPLETE_OLD_COPY: workspaceConflictMessage(
    "migration.error.workspaceCompleteOldCopyAt",
    "migration.error.workspaceCompleteOldCopy",
  ),
} as const satisfies Partial<Record<KnownMigrationErrorCode, (fm: Format, input: MigrationErrorInput) => string>>;

// Coverage rail over all copy tables: a known code with no copy would otherwise
// fall through to the generic fallback. If one is uncovered, `_Exhaustive`
// resolves to a tuple naming it and the assignment below fails to compile.
type CoveredMigrationErrorCode =
  | keyof typeof MIGRATION_ERROR_IDS
  | keyof typeof MIGRATION_ERROR_BUILDERS
  | keyof typeof MIGRATION_INPUT_BUILDERS
  | "MIGRATION_RESUMABLE_CAPABILITY_REQUIRED";
type _Exhaustive = Exclude<KnownMigrationErrorCode, CoveredMigrationErrorCode> extends never
  ? true
  : ["migration error codes with no copy:", Exclude<KnownMigrationErrorCode, CoveredMigrationErrorCode>];
const _migrationErrorCopyIsExhaustive: _Exhaustive = true;
void _migrationErrorCopyIsExhaustive;

/**
 * Aborted-migration detail copy. Copy never states a fixed prep duration, and
 * `prepDeadlineAt` arrives only over REST (the realtime payload carries no
 * deadline), so `prep-deadline` has a variant with and without the timestamp.
 */
export function migrationAbortDetailMessageId(
  reason: string | null | undefined,
  hasPrepDeadline: boolean,
): MessageId {
  if (reason === "prep-deadline") {
    return hasPrepDeadline
      ? "agent.detail.migrationAbortedPrepDeadlineAt"
      : "agent.detail.migrationAbortedPrepDeadline";
  }
  if (reason === "transfer-deadline") return "agent.detail.migrationAbortedTransferDeadline";
  if (reason === "arrival-deadline") return "agent.detail.migrationAbortedArrivalDeadline";
  return "agent.detail.migrationAbortedFallback";
}

const ABORT_REASON_IDS = {
  "prep-deadline": "migration.abort.prepDeadline",
  "transfer-deadline": "migration.abort.transferDeadline",
  "arrival-deadline": "migration.abort.arrivalDeadline",
} as const satisfies Record<string, MessageId>;

function fallbackMessage(
  fm: Format,
  context: MigrationErrorInput["context"],
  reason: string | null | undefined,
): string {
  // Reuse the coded ids rather than minting duplicates with identical English;
  // the catalog ratchet flags those.
  if (context === "status") return fm({ id: "migration.error.statusFailed" });
  if (context === "aborted") {
    const id = ABORT_REASON_IDS[reason as keyof typeof ABORT_REASON_IDS]
      ?? "agent.detail.migrationAbortedFallback";
    return fm({ id });
  }
  if (context === "failed") return fm({ id: "migration.error.failedGeneric" });
  return fm({ id: "migration.error.startFailed" });
}

const COMPUTER_CAPABILITY_MESSAGE_IDS = {
  runtime_unconfirmed: "agent.migration.error.computerCapability.runtimeUnconfirmed",
  runtime_missing: "agent.migration.error.computerCapability.runtimeMissing",
} satisfies Record<MigrationComputerCapabilityReason, MessageId>;

function computerCapabilityPresentation(
  formatMessage: Format,
  input: MigrationErrorInput,
  technicalCode: string | undefined,
): MigrationErrorPresentation {
  const failures = input.computerCapabilityDetails?.failures;
  if (!failures?.length) {
    return {
      message: formatMessage({ id: "migration.error.capabilityInsufficient" }),
      ...(technicalCode ? { technicalCode } : {}),
      recovery: "open_computers_and_retry",
    };
  }

  const issues: string[] = [];
  const affectedSides = new Set<MigrationComputerCapabilitySide>();
  for (const failure of failures) {
    const computer = failure.side === "source"
      ? input.sourceComputerName
      : input.targetComputerName;
    if (!computer) {
      return {
        message: formatMessage({ id: "migration.error.capabilityInsufficient" }),
        ...(technicalCode ? { technicalCode } : {}),
        recovery: "open_computers_and_retry",
      };
    }
    affectedSides.add(failure.side);
    issues.push(formatMessage(
      { id: COMPUTER_CAPABILITY_MESSAGE_IDS[failure.reason] },
      { computer, runtime: getRuntimeDisplayName(failure.runtime) },
    ));
  }

  const onlySide = affectedSides.size === 1 ? failures[0]?.side : null;
  const recoveryComputerId = onlySide === "source"
    ? input.sourceComputerId
    : onlySide === "target"
      ? input.targetComputerId
      : null;
  return {
    message: formatMessage({ id: "agent.migration.error.computerCapability.summary" }),
    issues,
    ...(technicalCode ? { technicalCode } : {}),
    recovery: "open_computers_and_retry",
    ...(recoveryComputerId ? { recoveryComputerId } : {}),
  };
}

function resumableCapabilityPresentation(
  formatMessage: Format,
  input: MigrationErrorInput,
  technicalCode: string | undefined,
): MigrationErrorPresentation {
  const detail = input.resumableCapabilityDetail;
  if (detail?.side === "both" && input.sourceComputerName && input.targetComputerName) {
    return {
      message: formatMessage(
        { id: "agent.migration.error.resumable.capabilityMissingBoth" },
        { source: input.sourceComputerName, target: input.targetComputerName },
      ),
      ...(technicalCode ? { technicalCode } : {}),
      recovery: "open_computers_and_retry",
    };
  }
  const computer = detail?.side === "source"
    ? input.sourceComputerName
    : detail?.side === "target"
      ? input.targetComputerName
      : null;
  const recoveryComputerId = detail?.side === "source"
    ? input.sourceComputerId
    : detail?.side === "target"
      ? input.targetComputerId
      : null;
  if (computer) {
    return {
      message: formatMessage(
        { id: "agent.migration.error.resumable.capabilityMissing" },
        { computer },
      ),
      ...(technicalCode ? { technicalCode } : {}),
      recovery: "open_computers_and_retry",
      ...(recoveryComputerId ? { recoveryComputerId } : {}),
    };
  }
  return {
    message: formatMessage({ id: "agent.migration.error.resumable.generic" }),
    ...(technicalCode ? { technicalCode } : {}),
    recovery: "open_computers_and_retry",
  };
}

/**
 * `transport_error_code` may carry a detailed daemon cause (e.g.
 * `MIGRATION_TARGET_IMPORT_ARRIVED_FAILED:503:...`) that has no dedicated copy;
 * pick it only when it has copy, otherwise the known `failure_reason`.
 */
export function migrationFailureCopyCode(
  transportErrorCode: string | null | undefined,
  failureReason: string | null | undefined,
): string | null | undefined {
  if (!transportErrorCode) return failureReason;
  const hasCopy = Object.hasOwn(MIGRATION_INPUT_BUILDERS, transportErrorCode)
    || Object.hasOwn(MIGRATION_ERROR_BUILDERS, transportErrorCode)
    || Object.hasOwn(MIGRATION_ERROR_IDS, transportErrorCode);
  return hasCopy || !failureReason ? transportErrorCode : failureReason;
}

export function migrationErrorPresentation(
  input: MigrationErrorInput,
  formatMessage: Format,
): MigrationErrorPresentation {
  const technicalCode = input.code && SAFE_TECHNICAL_CODE.test(input.code)
    ? input.code
    : input.reason && SAFE_TECHNICAL_CODE.test(input.reason)
      ? input.reason
      : undefined;
  if (input.code === "COMPUTER_CAPABILITY_INSUFFICIENT") {
    return computerCapabilityPresentation(formatMessage, input, technicalCode);
  }
  if (input.code === "MIGRATION_RESUMABLE_CAPABILITY_REQUIRED") {
    return resumableCapabilityPresentation(formatMessage, input, technicalCode);
  }
  const code = input.code ?? "";
  const copy = Object.hasOwn(MIGRATION_INPUT_BUILDERS, code)
    ? MIGRATION_INPUT_BUILDERS[code as keyof typeof MIGRATION_INPUT_BUILDERS](formatMessage, input)
    : Object.hasOwn(MIGRATION_ERROR_BUILDERS, code)
    ? MIGRATION_ERROR_BUILDERS[code as keyof typeof MIGRATION_ERROR_BUILDERS](formatMessage, input.rawMessage)
    : Object.hasOwn(MIGRATION_ERROR_IDS, code)
      ? formatMessage({ id: MIGRATION_ERROR_IDS[code as keyof typeof MIGRATION_ERROR_IDS] })
      : fallbackMessage(formatMessage, input.context, input.reason);
  return { message: copy, ...(technicalCode ? { technicalCode } : {}) };
}
