import type { IntlShape } from "react-intl";
import { currentTimeMs } from "@botiverse/raft-shared";
import type { AgentMigrationSourceDrain, AgentMigrationSourceDrainWaitingFor } from "@botiverse/raft-shared";
import type { Machine } from "../../store/machineStore";
import {
  conventionalAgentWorkspacePath,
  formatMigrationSize,
  migrationAbortDetailMessageId,
  migrationErrorPresentation,
  migrationFailureCopyCode,
  parseMigrationComputerCapabilityDetails,
  parseMigrationResumableCapabilityDetail,
} from "./errors";
import type { MigrationErrorPresentation } from "./errors";
import type { MessageId } from "../../i18n/messages";
import type { AgentMigrationNotice } from "./realtime";
import {
  isCanceledMigrationState,
  isCompletedMigrationState,
  isFailedMigrationState,
  isHostedMigration,
  isHostedReviewPending,
} from "./state";

export function migrationTargetLabel(formatMessage: IntlShape["formatMessage"], machines: Machine[], targetMachineId: string | null | undefined): string {
  if (!targetMachineId) return formatMessage({ id: "agent.detail.unknownComputer" });
  return machines.find((machine) => machine.id === targetMachineId)?.name ?? targetMachineId.slice(0, 8);
}

/**
 * After the switch a move to the cloud can stall without ending: the import or
 * the agent's setup in the cloud failed, but a retry can still finish it. The
 * migration stays `arriving` with one of these reasons (server R5).
 */
const HOSTED_ARRIVAL_ATTENTION_IDS = {
  HOSTED_IMPORT_FAILED: "agent.migration.hosted.attention.importFailed",
  HOSTED_IMPORT_STALLED: "agent.migration.hosted.attention.importStalled",
  HOSTED_PROVIDER_FAILED: "agent.migration.hosted.attention.providerFailed",
  // Not retryable: the cloud never sets up a deleted agent again under the same agent.
  HOSTED_AGENT_DELETED: "agent.migration.hosted.attention.agentDeleted",
  HOSTED_PROVIDER_MISMATCH: "agent.migration.hosted.attention.providerMismatch",
} as const satisfies Record<string, MessageId>;

/** The reason a switched move to the cloud needs attention, or null while it is fine or over. */
export function hostedArrivalAttentionReason(notice: {
  state: string;
  targetKind?: string | null;
  failureReason?: string | null;
}): keyof typeof HOSTED_ARRIVAL_ATTENTION_IDS | null {
  if (!isHostedMigration(notice) || (notice.state !== "arriving" && notice.state !== "starting")) return null;
  const reason = notice.failureReason ?? "";
  return Object.hasOwn(HOSTED_ARRIVAL_ATTENTION_IDS, reason) ? reason as keyof typeof HOSTED_ARRIVAL_ATTENTION_IDS : null;
}

/** The cloud never set the agent up, so Raft put it back on its Computer (terminal `failed`). */
const HOSTED_AGENT_NOT_CREATED = "HOSTED_AGENT_NOT_CREATED";

/**
 * How a move between computers ended, when it has: the profile then drops the
 * Steps for one short line. Moves to the cloud and cancellations that need
 * attention keep the full panel.
 */
export function endedComputerMigration(notice: AgentMigrationNotice): "completed" | "failed" | "canceled" | null {
  if (isHostedMigration(notice) || notice.cancelNeedsAttention) return null;
  if (isCompletedMigrationState(notice.state)) return "completed";
  if (isFailedMigrationState(notice.state)) return "failed";
  if (isCanceledMigrationState(notice.state)) return "canceled";
  return null;
}

/** The pieces of an ended move between computers: where from and to, who started it, and when it ended. */
export function lastMigrationFacts(
  formatMessage: IntlShape["formatMessage"],
  machines: Machine[],
  notice: AgentMigrationNotice,
  formatTimestamp: (value: string) => string,
): { source: string; target: string; startedBy: string | null; endedAt: string | null } {
  const failed = isFailedMigrationState(notice.state);
  const endedAt = (failed ? notice.abortedAt : notice.completedAt) ?? notice.updatedAt;
  return {
    source: migrationTargetLabel(formatMessage, machines, notice.sourceMachineId),
    target: migrationNoticeTargetLabel(formatMessage, machines, notice),
    startedBy: notice.initiatedBy ? notice.initiatedBy.displayName || notice.initiatedBy.name : null,
    endedAt: endedAt ? formatTimestamp(endedAt) : null,
  };
}

/** Where the migration goes: the target computer's name, or the cloud for a move to the cloud. */
export function migrationNoticeTargetLabel(
  formatMessage: IntlShape["formatMessage"],
  machines: Machine[],
  notice: { targetKind?: string | null; targetMachineId?: string | null },
): string {
  if (isHostedMigration(notice)) return formatMessage({ id: "agent.migration.hosted.targetName" });
  return migrationTargetLabel(formatMessage, machines, notice.targetMachineId);
}

export function migrationStartErrorPresentation(
  err: unknown,
  formatMessage: IntlShape["formatMessage"],
  computers: {
    sourceComputerName?: string | null;
    targetComputerName?: string | null;
    sourceComputerId?: string | null;
    targetComputerId?: string | null;
  } = {},
): MigrationErrorPresentation {
  const e = err as {
    response?: { data?: { error?: string; code?: string; details?: unknown } };
    message?: string;
  } | null;
  return migrationErrorPresentation({
    code: e?.response?.data?.code,
    rawMessage: e?.response?.data?.error ?? e?.message,
    context: "start",
    // task #1268: TARGET_RUNTIME_DETECTION_PENDING copy depends on details.detectionStatus.
    details: e?.response?.data?.details,
    computerCapabilityDetails: parseMigrationComputerCapabilityDetails(
      e?.response?.data?.details,
    ),
    resumableCapabilityDetail: parseMigrationResumableCapabilityDetail(
      e?.response?.data?.details,
    ),
    ...computers,
  }, formatMessage);
}

export function migrationStatusErrorPresentation(
  error: { code?: string; message?: string },
  formatMessage: IntlShape["formatMessage"],
): MigrationErrorPresentation {
  return migrationErrorPresentation({
    code: error.code,
    rawMessage: error.message,
    context: "status",
  }, formatMessage);
}

/**
 * Failure copy for a migration that ended. Before the flip the agent never left
 * the source, so the copy says that first; a user's first worry is whether the
 * agent still works.
 */
function migrationFailurePresentation(
  notice: AgentMigrationNotice,
  machines: Machine[],
  formatMessage: IntlShape["formatMessage"],
  formatTimestamp: (value: string) => string,
): MigrationErrorPresentation {
  if (isHostedMigration(notice) && (notice.failureReason === HOSTED_AGENT_NOT_CREATED || notice.transportErrorCode === HOSTED_AGENT_NOT_CREATED)) {
    const source = migrationTargetLabel(formatMessage, machines, notice.sourceMachineId);
    return {
      placement: formatMessage({ id: "agent.detail.migrationStillOnSource" }, { source }),
      message: formatMessage({ id: "agent.migration.hosted.agentNotCreated" }, { source }),
      technicalCode: HOSTED_AGENT_NOT_CREATED,
    };
  }
  if (notice.flippedAt) {
    const target = migrationTargetLabel(formatMessage, machines, notice.targetMachineId);
    const reason = migrationFailureReasonPresentation(notice, machines, formatMessage, formatTimestamp);
    return {
      ...reason,
      message: isHostedMigration(notice)
        ? formatMessage({ id: "agent.migration.hosted.failedAfterMove" })
        : formatMessage({ id: "agent.detail.migrationFailedAfterMove" }, { target }),
    };
  }
  const source = migrationTargetLabel(formatMessage, machines, notice.sourceMachineId);
  const reason = migrationFailureReasonPresentation(notice, machines, formatMessage, formatTimestamp);
  return {
    ...reason,
    placement: formatMessage({ id: "agent.detail.migrationStillOnSource" }, { source }),
  };
}

function migrationFailureReasonPresentation(
  notice: AgentMigrationNotice,
  machines: Machine[],
  formatMessage: IntlShape["formatMessage"],
  formatTimestamp: (value: string) => string,
): MigrationErrorPresentation {
  const sourceMachine = machines.find((machine) => machine.id === notice.sourceMachineId);
  const targetMachine = machines.find((machine) => machine.id === notice.targetMachineId);
  const source = migrationTargetLabel(formatMessage, machines, notice.sourceMachineId);
  const target = migrationNoticeTargetLabel(formatMessage, machines, notice);
  if (notice.state === "aborted") {
    const fallback = migrationErrorPresentation({
      context: "aborted",
      reason: notice.abortReason,
    }, formatMessage);
    const prepDeadlineAt = notice.prepDeadlineAt ?? null;
    const id = migrationAbortDetailMessageId(notice.abortReason, prepDeadlineAt !== null);
    return {
      message: formatMessage({ id }, {
        source,
        target,
        ...(prepDeadlineAt ? { deadline: formatTimestamp(prepDeadlineAt) } : {}),
      }),
      ...(fallback.technicalCode ? { technicalCode: fallback.technicalCode } : {}),
    };
  }
  const copyCode = migrationFailureCopyCode(notice.transportErrorCode, notice.failureReason);
  // There is no second computer in a move to the cloud: only the upload from the source can drop.
  if (isHostedMigration(notice) && copyCode === "MIGRATION_TRANSPORT_LOST") {
    return {
      message: formatMessage({ id: "agent.migration.hosted.transportLost" }, { source }),
      technicalCode: copyCode,
    };
  }
  return migrationErrorPresentation({
    code: copyCode,
    rawMessage: notice.transportErrorMessage,
    context: "failed",
    reason: notice.abortReason,
    // Workspace conflicts are the one failure whose remedy is a directory the
    // user has to find. `agentId` is always on the notice, so the copy can at
    // least point at the conventional location instead of leaving them to guess.
    agentWorkspacePath: conventionalAgentWorkspacePath(notice.agentId),
    sourceComputerName: source,
    targetComputerName: target,
    sourceComputerStatus: sourceMachine?.status,
    targetComputerStatus: targetMachine?.status,
    transportLostAt: notice.transportLostAt,
    formatTimestamp,
  }, formatMessage);
}

/** What the viewer sees the agent as, and their own clock, for copy that names both. */
export type MigrationViewerCopy = {
  agentName: string;
  formatClock: (value: string) => string;
};

/** Per thing the draining source waits for: the copy with its stop time, and once that time has passed. */
const SOURCE_DRAIN_MESSAGE_IDS = {
  turn: { until: "agent.detail.migrationDrainTurn", now: "agent.detail.migrationDrainTurnNow" },
  background_tasks: { until: "agent.detail.migrationDrainBackgroundTasks", now: "agent.detail.migrationDrainBackgroundTasksNow" },
  queued_input: { until: "agent.detail.migrationDrainQueuedInput", now: "agent.detail.migrationDrainQueuedInputNow" },
  other: { until: "agent.detail.migrationDrainOther", now: "agent.detail.migrationDrainOtherNow" },
} as const satisfies Record<AgentMigrationSourceDrainWaitingFor, { until: MessageId; now: MessageId }>;

/** Why the source has not stopped the agent yet, and by when it will (server-clamped to the drain deadline). */
function migrationSourceDrainMessage(
  formatMessage: IntlShape["formatMessage"],
  drain: AgentMigrationSourceDrain,
  viewer: MigrationViewerCopy,
): string {
  const ids = SOURCE_DRAIN_MESSAGE_IDS[drain.waitingFor ?? "other"];
  const untilMs = Date.parse(drain.until);
  // An unparseable `until` reads as passed: the source stops at its deadline anyway.
  if (!(untilMs > currentTimeMs())) return formatMessage({ id: ids.now }, { agent: viewer.agentName });
  return formatMessage({ id: ids.until }, { agent: viewer.agentName, time: viewer.formatClock(drain.until) });
}

function migrationSourceStageMessage(
  formatMessage: IntlShape["formatMessage"],
  notice: AgentMigrationNotice,
  source: string,
  target: string,
  viewer: MigrationViewerCopy,
): string {
  if (notice.transportControlRegisteredAt) {
    return isHostedMigration(notice)
      ? formatMessage({ id: "agent.migration.hosted.uploading" }, { source })
      : formatMessage({ id: "agent.detail.migrationUploading" }, { source, target });
  }
  if (!notice.sourceQuiescedAt) {
    if (notice.sourceDrain) return migrationSourceDrainMessage(formatMessage, notice.sourceDrain, viewer);
    // The source first waits (up to the drain deadline) for the agent to be
    // quiet; after that, or without a deadline, it stops the agent at once.
    const remainingMs = notice.sourceDrainUntil ? Date.parse(notice.sourceDrainUntil) - currentTimeMs() : Number.NaN;
    if (remainingMs > 0) {
      const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
      return formatMessage({ id: "agent.detail.migrationWaitingForAgent" }, { source, minutes });
    }
    return formatMessage({ id: "agent.detail.migrationStoppingSource" }, { source });
  }
  const progress = notice.sourceBuildProgress;
  if (progress && (progress.files > 0 || progress.bytes > 0)) {
    return formatMessage({ id: "agent.detail.migrationPackingProgress" }, {
      source,
      files: progress.files,
      size: formatMigrationSize(progress.bytes),
    });
  }
  const elapsedMinutes = Math.floor((currentTimeMs() - Date.parse(notice.sourceQuiescedAt)) / 60_000);
  if (elapsedMinutes >= 1) {
    return formatMessage({ id: "agent.detail.migrationPackingElapsed" }, { source, minutes: elapsedMinutes });
  }
  return formatMessage({ id: "agent.detail.migrationPacking" }, { source });
}

// `ready`: the upload is done and the target downloads chunk by chunk; once it
// has them all it unpacks, which `in_transit` then reports too.
function migrationDownloadStageMessage(
  formatMessage: IntlShape["formatMessage"],
  notice: AgentMigrationNotice,
  target: string,
): string {
  const progress = notice.transferProgress;
  if (!progress || progress.totalChunks === 0 || progress.totalBytes <= 0) {
    return formatMessage({ id: "agent.detail.migrationReady" }, { target });
  }
  if (progress.receivedChunks >= progress.totalChunks) {
    return formatMessage({ id: "agent.detail.migrationUnpacking" }, { target });
  }
  return formatMessage({ id: "agent.detail.migrationDownloading" }, {
    target,
    // Floor, so it never reads 100% before the last chunk lands.
    percent: Math.min(99, Math.floor(progress.receivedBytes / progress.totalBytes * 100)),
    received: formatMigrationSize(progress.receivedBytes),
    total: formatMigrationSize(progress.totalBytes),
  });
}

/**
 * Stage copy for a move to the cloud where it differs from a computer move:
 * the cloud checks the files, the user reviews, then the agent switches. Null
 * falls back to the shared copy (stopping/packing on the source, failures,
 * cancel states, which pick their hosted wording inline).
 */
function hostedMigrationStageMessage(
  formatMessage: IntlShape["formatMessage"],
  notice: AgentMigrationNotice,
  source: string,
): string | null {
  switch (notice.state) {
    case "ready":
      return formatMessage({ id: "agent.migration.hosted.checkingFiles" });
    case "in_transit":
      return isHostedReviewPending(notice)
        ? formatMessage({ id: "agent.migration.hosted.waitingForReview" }, { source })
        : formatMessage({ id: "agent.migration.hosted.checkingFiles" });
    case "arriving":
    case "starting":
      return formatMessage({ id: "agent.migration.hosted.switching" });
    default:
      return null;
  }
}

export function migrationSupportRef(notice: AgentMigrationNotice): string {
  return notice.migrationRef;
}

export type MigrationNoticePresentation = MigrationErrorPresentation & {
  intent: "info" | "warning" | "success";
  title: string;
};

export function migrationNoticePresentation(
  formatMessage: IntlShape["formatMessage"],
  notice: AgentMigrationNotice,
  machines: Machine[],
  formatTimestamp: (value: string) => string,
  viewer: MigrationViewerCopy,
): MigrationNoticePresentation {
  const source = migrationTargetLabel(formatMessage, machines, notice.sourceMachineId);
  const target = migrationNoticeTargetLabel(formatMessage, machines, notice);
  const status = (message: string): MigrationNoticePresentation => ({
    intent: "info",
    title: formatMessage({ id: "agent.detail.migrationStatus" }),
    message,
  });
  const attention = hostedArrivalAttentionReason(notice);
  if (attention) {
    return {
      intent: "warning",
      title: formatMessage({ id: "agent.migration.hosted.attention.title" }),
      placement: formatMessage({ id: "agent.migration.hosted.attention.placement" }),
      message: formatMessage({ id: HOSTED_ARRIVAL_ATTENTION_IDS[attention] }),
      technicalCode: attention,
    };
  }
  if (isHostedMigration(notice)) {
    const hosted = hostedMigrationStageMessage(formatMessage, notice, source);
    if (hosted) return status(hosted);
  }
  switch (notice.state) {
    case "failed":
      return {
        intent: "warning",
        title: formatMessage({ id: "agent.detail.migrationFailed" }),
        ...migrationFailurePresentation(notice, machines, formatMessage, formatTimestamp),
      };
    case "aborted":
      return {
        intent: "warning",
        title: formatMessage({ id: "agent.detail.migrationAborted" }),
        ...migrationFailurePresentation(notice, machines, formatMessage, formatTimestamp),
      };
    case "cancel_requested_pre_flip":
      return notice.cancelNeedsAttention
        ? {
            intent: "warning",
            title: formatMessage({ id: "agent.migration.cancellationNeedsAttention" }),
            message: isHostedMigration(notice)
              ? formatMessage({ id: "agent.migration.hosted.cancelAttentionMessage" }, { source })
              : formatMessage({ id: "agent.migration.cancelPreAttentionMessage" }),
            technicalCode: notice.cancelErrorCode ?? undefined,
          }
        : {
            intent: "info",
            title: formatMessage({ id: "agent.migration.cancelingTitle" }),
            message: isHostedMigration(notice)
              ? formatMessage({ id: "agent.migration.hosted.cancelingMessage" }, { source })
              : formatMessage({ id: "agent.migration.cancelPreMessage" }),
          };
    case "cancel_requested_post_flip":
      return notice.cancelNeedsAttention
        ? {
            intent: "warning",
            title: formatMessage({ id: "agent.migration.cancellationNeedsAttention" }),
            message: formatMessage({ id: "agent.migration.cancelPostAttentionMessage" }),
            technicalCode: notice.cancelErrorCode ?? undefined,
          }
        : {
            intent: "info",
            title: formatMessage({ id: "agent.migration.stoppingMigratedAgentTitle" }),
            message: formatMessage({ id: "agent.migration.cancelPostMessage" }),
          };
    case "canceled_pre_flip":
      return {
        intent: "info",
        title: formatMessage({ id: "agent.migration.canceledTitle" }),
        message: isHostedMigration(notice)
          ? formatMessage({ id: "agent.migration.hosted.canceledMessage" }, { source })
          : formatMessage({ id: "agent.migration.canceledPreMessage" }),
      };
    case "canceled_post_flip":
      return {
        intent: "info",
        title: formatMessage({ id: "agent.migration.canceledTitle" }),
        message: formatMessage({ id: "agent.migration.canceledPostMessage" }),
      };
    case "provisioning":
      return status(migrationSourceStageMessage(formatMessage, notice, source, target, viewer));
    case "prep":
      return status(formatMessage({ id: "agent.detail.migrationPacking" }, { source }));
    case "ready":
      return status(migrationDownloadStageMessage(formatMessage, notice, target));
    case "in_transit":
      return status(formatMessage({ id: "agent.detail.migrationUnpacking" }, { target }));
    case "arriving":
      return status(formatMessage({ id: "agent.detail.migrationArriving" }, { target }));
    case "starting":
      return notice.failureReason === "auto_start_failed"
        ? {
            intent: "warning",
            title: formatMessage({ id: "agent.detail.agentDidNotStart" }),
            message: formatMessage({ id: "agent.detail.agentDidNotStartMessage" }, { target }),
            technicalCode: "auto_start_failed",
          }
        : status(formatMessage({ id: "agent.detail.migrationStarting" }, { target }));
    case "completed":
      return {
        intent: "success",
        title: formatMessage({ id: "agent.detail.migrationStatus" }),
        message: isHostedMigration(notice)
          ? formatMessage({ id: "agent.migration.hosted.completed" })
          : formatMessage({ id: "agent.detail.migrationCompleted" }, { target }),
      };
    default:
      return status(formatMessage(
        { id: "agent.detail.migrationUnknownState" },
        { state: String(notice.state), target },
      ));
  }
}
