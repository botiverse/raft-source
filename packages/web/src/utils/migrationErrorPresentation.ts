import type { IntlShape } from "react-intl";
import { getRuntimeDisplayName } from "@botiverse/raft-shared";
import type {
  AgentMigrationUserErrorCode,
} from "@botiverse/raft-shared";

import type { MessageId } from "../i18n/messages";

export interface MigrationErrorPresentation {
  message: string;
  issues?: string[];
  technicalCode?: string;
  diagnosticRef?: string;
  recovery?: "open_computers_and_retry";
  recoveryComputerId?: string;
}

export type MigrationResumableCapabilitySide = "source" | "target";
export type MigrationResumableCapabilityReason =
  | "protocol_missing"
  | "protocol_old"
  | "capability_missing";

export interface MigrationResumableCapabilityDetail {
  side: MigrationResumableCapabilitySide;
  reason: MigrationResumableCapabilityReason;
}

export type MigrationComputerCapabilitySide = "source" | "target";
export type MigrationComputerCapabilityReason =
  | "daemon_version_unconfirmed"
  | "daemon_version_too_old"
  | "runtime_unconfirmed"
  | "runtime_missing";

export interface MigrationComputerCapabilityFailure {
  side: MigrationComputerCapabilitySide;
  reason: MigrationComputerCapabilityReason;
  minimumDaemonVersion?: string;
  runtime?: string;
}

export interface MigrationComputerCapabilityDetails {
  failures: MigrationComputerCapabilityFailure[];
}

const SAFE_RUNTIME_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
export function parseMigrationComputerCapabilityDetails(
  value: unknown,
): MigrationComputerCapabilityDetails | null {
  if (!value || typeof value !== "object") return null;
  const failures = (value as { failures?: unknown }).failures;
  if (!Array.isArray(failures) || failures.length < 1 || failures.length > 4) return null;

  const parsed: MigrationComputerCapabilityFailure[] = [];
  const identities = new Set<string>();
  for (const candidate of failures) {
    if (!candidate || typeof candidate !== "object") return null;
    const failure = candidate as {
      side?: unknown;
      reason?: unknown;
      minimumDaemonVersion?: unknown;
      runtime?: unknown;
    };
    if (failure.side !== "source" && failure.side !== "target") return null;
    if (
      failure.reason !== "daemon_version_unconfirmed"
      && failure.reason !== "daemon_version_too_old"
      && failure.reason !== "runtime_unconfirmed"
      && failure.reason !== "runtime_missing"
    ) {
      return null;
    }
    const identity = `${failure.side}:${failure.reason.startsWith("daemon_version_") ? "daemon_version" : "runtime"}`;
    if (identities.has(identity)) return null;
    identities.add(identity);

    if (failure.reason.startsWith("daemon_version_")) {
      if (typeof failure.minimumDaemonVersion !== "string" || !SAFE_SEMVER.test(failure.minimumDaemonVersion)) {
        return null;
      }
      parsed.push({
        side: failure.side,
        reason: failure.reason,
        minimumDaemonVersion: failure.minimumDaemonVersion,
      });
      continue;
    }
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
  if (detail.side !== "source" && detail.side !== "target") return null;
  if (
    detail.reason !== "protocol_missing"
    && detail.reason !== "protocol_old"
    && detail.reason !== "capability_missing"
  ) {
    return null;
  }
  return { side: detail.side, reason: detail.reason };
}

export interface MigrationErrorInput {
  code?: string | null;
  rawMessage?: string | null;
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
  sourceComputerLastHeartbeat?: string | null;
  targetComputerLastHeartbeat?: string | null;
  transportLostAt?: string | null;
  formatTimestamp?: ((value: string) => string) | null;
}

type KnownMigrationErrorCode = AgentMigrationUserErrorCode;

type Format = IntlShape["formatMessage"];

const GIB = 1024 ** 3;
const SAFE_TECHNICAL_CODE = /^[A-Za-z][A-Za-z0-9_-]{1,127}$/;
// Mirrors the migration admission window enforced by the Server. At exactly
// two minutes the heartbeat is still fresh, so historical attribution stays
// conservative at the boundary.
const MIGRATION_HEARTBEAT_FRESHNESS_MS = 2 * 60 * 1000;

function timestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function heartbeatWasStaleAt(
  lastHeartbeat: string | null | undefined,
  transportLostAtMs: number | null,
): boolean {
  const heartbeatMs = timestampMs(lastHeartbeat);
  return heartbeatMs !== null
    && transportLostAtMs !== null
    && heartbeatMs < transportLostAtMs - MIGRATION_HEARTBEAT_FRESHNESS_MS;
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

  const sourceWasStale = Boolean(input.sourceComputerName) && heartbeatWasStaleAt(
    input.sourceComputerLastHeartbeat,
    transportLostAtMs,
  );
  const targetWasStale = Boolean(input.targetComputerName) && heartbeatWasStaleAt(
    input.targetComputerLastHeartbeat,
    transportLostAtMs,
  );
  const heartbeat = sourceWasStale && targetWasStale
    ? fm(
        { id: "migration.error.transportLostHeartbeatBoth" },
        { source: input.sourceComputerName, target: input.targetComputerName },
      )
    : sourceWasStale
      ? fm(
          { id: "migration.error.transportLostHeartbeatOne" },
          { computer: input.sourceComputerName },
        )
      : targetWasStale
        ? fm(
            { id: "migration.error.transportLostHeartbeatOne" },
            { computer: input.targetComputerName },
          )
        : fm({ id: "migration.error.transportLostHeartbeatUnknown" });

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

  return `${event} ${heartbeat} ${retry}`;
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

function formatGib(bytes: number): string {
  const value = bytes / GIB;
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)} GiB`;
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
  // Counts go through ICU `{n, number}` so they group per app locale. This
  // deliberately replaces the explicit "en-US" that #5848 used as a minimal
  // guard-satisfying placeholder — flagged to @Wug rather than changed silently.
  // Each list item is itself a formatted message so its number groups per locale
  // too — the top-level count went through ICU while these did not, which silently
  // dropped the thousands separators the original had.
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

// code -> MessageId. Holding ids rather than sentences is the whole point: this
// module is imported by AgentDetailPanel, which renders `presentation.message`
// directly (L2457/L2648). While these were English, that page could scan clean
// and still show English on every migration failure — the sentence was built one
// module away, so nothing at the call site looked like copy.
//
// `satisfies … MessageId` is the rail against English creeping back in. It is
// NOT an exhaustiveness rail — this table is Partial, because three codes are
// handled by builders below. Exhaustiveness is enforced separately, over the
// union of both tables; see the coverage rail after MIGRATION_ERROR_BUILDERS.
const MIGRATION_ERROR_IDS = {
  agent_migration_ui_disabled: "migration.error.uiDisabled",
  not_supported: "migration.error.notSupported",
  AGENT_NOT_FOUND: "migration.error.agentNotFound",
  TARGET_COMPUTER_REQUIRED: "migration.error.targetRequired",
  AGENT_HAS_NO_SOURCE_MACHINE: "migration.error.noSourceMachine",
  TARGET_COMPUTER_NOT_IN_SERVER: "migration.error.targetNotInServer",
  TARGET_COMPUTER_MATCHES_SOURCE: "migration.error.targetMatchesSource",
  COMPUTER_CAPABILITY_INSUFFICIENT: "migration.error.capabilityInsufficient",
  TARGET_COMPUTER_OFFLINE: "migration.error.targetOffline",
  MIGRATION_ALREADY_IN_PROGRESS: "migration.error.alreadyInProgress",
  MIGRATION_PRO_PLAN_REQUIRED: "migration.error.proPlanRequired",
  MIGRATION_TRANSPORT_NOT_PROVISIONED: "migration.error.transportNotProvisioned",
  MIGRATION_TRANSPORT_PROVISION_FAILED: "migration.error.transportProvisionFailed",
  MIGRATION_WORKSPACE_ALREADY_EXISTS: "migration.error.workspaceAlreadyExists",
  MIGRATION_WORKSPACE_COMPLETE_OLD_COPY: "migration.error.workspaceCompleteOldCopy",
  MIGRATION_CHUNK_DIGEST_MISMATCH: "migration.error.chunkDigestMismatch",
  MIGRATION_WHOLE_BUNDLE_DIGEST_MISMATCH: "migration.error.bundleDigestMismatch",
  MIGRATION_LEASE_EXPIRED: "migration.error.leaseExpired",
  MIGRATION_GENERATION_STALE: "migration.error.generationStale",
  MIGRATION_CONTROL_MANIFEST_INVALID: "migration.error.controlManifestInvalid",
  MIGRATION_CONTROL_MANIFEST_TOO_LARGE: "migration.error.controlManifestTooLarge",
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

const MIGRATION_INPUT_BUILDERS = {
  MIGRATION_TRANSPORT_LOST: transportLostMessage,
} as const satisfies Partial<Record<KnownMigrationErrorCode, (fm: Format, input: MigrationErrorInput) => string>>;

// COMBINED COVERAGE RAIL. Splitting the old exhaustive
// `satisfies Record<KnownMigrationErrorCode, …>` into two `Partial<…>` tables
// silently dropped exhaustiveness: a new member of KnownMigrationErrorCode would
// compile and fall through to the generic fallback, showing a user the vague
// message instead of the specific one. Neither table can enforce it alone, so
// the check lives here, over their union.
//
// If a code is uncovered, `_Exhaustive` resolves to a tuple and the assignment
// below fails to compile with the missing code named in the error.
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
  // status/start reuse the coded ids rather than minting a second id with
  // identical English — the catalog ratchet would flag that as drift, and
  // task #17's common.* hoist has enough duplicate rows already.
  if (context === "status") return fm({ id: "migration.error.statusFailed" });
  if (context === "aborted") {
    // Reuse the existing id rather than minting a second one with identical
    // English — the catalog ratchet caught exactly that, and its two Chinese
    // renderings had already drifted apart.
    const id = ABORT_REASON_IDS[reason as keyof typeof ABORT_REASON_IDS]
      ?? "agent.detail.migrationAbortedFallback";
    return fm({ id });
  }
  if (context === "failed") return fm({ id: "migration.error.failedGeneric" });
  return fm({ id: "migration.error.startFailed" });
}

const RESUMABLE_CAPABILITY_MESSAGE_IDS = {
  protocol_missing: "agent.migration.error.resumable.protocolMissing",
  protocol_old: "agent.migration.error.resumable.protocolOld",
  capability_missing: "agent.migration.error.resumable.capabilityMissing",
} satisfies Record<MigrationResumableCapabilityReason, MessageId>;

const COMPUTER_CAPABILITY_MESSAGE_IDS = {
  daemon_version_unconfirmed: "agent.migration.error.computerCapability.daemonVersionUnconfirmed",
  daemon_version_too_old: "agent.migration.error.computerCapability.daemonVersionTooOld",
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
      {
        computer,
        minimumVersion: failure.minimumDaemonVersion ?? "",
        runtime: failure.runtime ? getRuntimeDisplayName(failure.runtime) : "",
      },
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
  if (detail && computer) {
    return {
      message: formatMessage(
        { id: RESUMABLE_CAPABILITY_MESSAGE_IDS[detail.reason] },
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
