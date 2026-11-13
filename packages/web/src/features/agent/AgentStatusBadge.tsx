import { Badge, TextLink } from "@botiverse/raft-ui";
import type { BadgeProps } from "@botiverse/raft-ui";
import Tooltip from "../../components/ui/Tooltip";
import { AgentToolStuckNotice, visibleToolStuck } from "../../components/agent/AgentToolStuckNotice";
import { useCallback, useState } from "react";
import { useIntl } from "react-intl";
import type { AgentActivity, AgentRuntimeErrorState } from "@botiverse/raft-shared";
import { formatRelativeTime } from "../../utils/relativeTime";
import { externalSetupNeedsSignIn, useAgentDisplayState, useAgentCurrentActivityState, useAgentStore } from "../../store/agentStore";
import { formatReadiness, readinessBody, readinessHolds, readinessLight } from "../../utils/readinessCopy";
import type { Agent, ExternalAgentStatus } from "../../store/agentStore";
import { agentNeedsManualRestart, credentialInvalidReasonOf, formatActivityText, formatAgentBlockedText, formatCredentialInvalidText, formatSpawnFailureDetail } from "../../utils/activity";
import { showToast } from "../../components/toastBridge";
import { useAgentStatusCredential } from "./useAgentStatusCredential";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { useOpenAgentComputer } from "../../components/agent/useOpenAgentComputer";
import StatusDot from "../../components/ui/StatusDot";
import type { StatusDotPresence } from "../../components/ui/StatusDot";

// DS StatusChip presence washes: online lime, busy yellow, error orange, offline stone.
const PRESENCE_CHIP_VARIANT = {
  online: "success",
  thinking: "busy",
  working: "busy",
  error: "warning",
  offline: "muted",
} as const satisfies Record<AgentActivity, BadgeProps["variant"]>;

/**
 * #proj-raft-computer:#48: the agent's provider credential is invalid (its
 * own error, or another agent's on the same sign-in), read from typed data
 * by `credentialInvalidReasonOf`. The badge names the reason instead of
 * Online / "Error: <runtime text>". Its Retry is not only for this: the badge
 * offers it to whoever may restart the agent whenever the agent cannot run
 * until someone does (`agentNeedsManualRestart`).
 */
export interface AgentCredentialInvalidInput {
  runtime: string;
  model?: string | null;
  lastRuntimeError?: Pick<AgentRuntimeErrorState, "message" | "errorClass" | "requiredAction"> | null;
  /**
   * The manual restart (`resetAgent(id, "restart")`): the server lifts its
   * wake block and the daemon releases the hold. Absent when the viewer may
   * not restart this agent (or it is deleted): no Retry, whatever the state.
   */
  onRetry?: () => Promise<void>;
}

// Isolated status badge — subscribes to activity for this agent only.
export function AgentStatusBadge({ agentId, showDetail, fallbackStatus, externalStatus, onStop, credentialAgent, canRestart = false, onOpenModelSettings }: {
  agentId: string;
  showDetail: boolean;
  fallbackStatus?: Agent["status"];
  externalStatus?: ExternalAgentStatus | null;
  onStop?: () => void;
  /** #proj-raft-computer:#48: the agent record whose credential state the badge reads; none, no reason. */
  credentialAgent?: Pick<Agent, "id" | "runtime" | "model" | "lastRuntimeError" | "deletedAt">;
  /**
   * Whoever may restart this agent now (the reset route's
   * `controlAgentRuntime`, and its Computer online, as for the menu's
   * Restart): Retry, while the agent cannot run until someone restarts it.
   */
  canRestart?: boolean;
  /**
   * Opens the agent's model setting (the profile's runtime editor), for
   * whoever may change it: Change model, while a start failed because the
   * runtime cannot use the agent's model (`model_unsupported`) or the context
   * no longer fits it (`session_needs_reset`).
   */
  onOpenModelSettings?: () => void;
}) {
  const intl = useIntl();
  const { formatMessage } = intl;
  const rawDisplayState = useAgentDisplayState(agentId, fallbackStatus ? { status: fallbackStatus } : undefined);
  const activityState = useAgentCurrentActivityState(agentId);
  const agentName = useAgentStore((state) => {
    const found = state.agents.find((candidate) => candidate.id === agentId);
    return found ? found.displayName ?? found.name : "";
  });
  const { options: timeOptions } = useTimeFormatter();
  const credential = useAgentStatusCredential(credentialAgent, canRestart);
  const [retrying, setRetrying] = useState(false);
  const onRetry = credential?.onRetry;
  const retry = useCallback(async () => {
    if (!onRetry) return;
    setRetrying(true);
    try {
      await onRetry();
    } catch {
      showToast({ title: formatMessage({ id: "agent.reset.failed" }), type: "error" });
    } finally {
      setRetrying(false);
    }
  }, [formatMessage, onRetry]);
  const { open: openComputer } = useOpenAgentComputer(agentId);
  // #proj-raft-computer:#68: the server's composed readiness (already trimmed for this viewer).
  const readiness = useAgentStore((state) => state.agents.find((agent) => agent.id === agentId)?.readiness);
  // task #1123: a failed start carries a typed reason; pick catalog copy by
  // reason (never by parsing the detail text) and let it stand in for the
  // daemon's detail so the existing offline + runtime_unavailable text path
  // (which keeps the detail) renders it. See formatSpawnFailureDetail.
  const spawnFailure = rawDisplayState.activityDetailKind === "runtime_unavailable"
    ? activityState?.spawnFailure
    : undefined;
  const spawnFailureText = formatSpawnFailureDetail(formatMessage, spawnFailure, rawDisplayState.activityDetail ?? "", timeOptions);
  const displayState = spawnFailureText
    ? { ...rawDisplayState, activityDetail: spawnFailureText }
    : rawDisplayState;

  // External agents: presence = credential seen within the online window
  // (same rule as every other agent dot); managers also see setup state.
  // While seen with a non-idle activity (thinking/working/error from forwarded
  // activity events) the badge renders exactly like a managed agent's.
  const externalActivityShown = displayState.isExternal && displayState.isOnline && displayState.activity !== "online";
  if (displayState.isExternal && !externalActivityShown) {
    const setupState = externalStatus?.setupState;
    const lastSeenRelative = !displayState.isOnline
      ? formatRelativeTime(displayState.lastSeenAt, intl.locale)
      : null;
    // Not signed in yet is something a person must do (status.md "needs
    // attention"): the error light, and the step for whoever can take it (Jasper).
    const needsSetup = externalSetupNeedsSignIn(setupState);
    const activityPresence: StatusDotPresence = displayState.isOnline
      ? "online"
      : needsSetup
        ? "error"
        : "external";
    const chipVariant: BadgeProps["variant"] = displayState.isOnline
      ? "success"
      : needsSetup
        ? "warning"
        : "information";
    let externalText = formatMessage({ id: "agent.detail.external" });
    let externalTooltip: string | null = null;
    if (showDetail && needsSetup) {
      externalText = formatMessage({ id: "agent.detail.externalSetUp" });
      externalTooltip = formatMessage({ id: "agent.detail.externalSetUpLong" }, { name: agentName });
    } else if (displayState.isOnline) {
      externalText = formatMessage({ id: "agent.detail.externalOnline" });
    } else if (lastSeenRelative) {
      externalText = formatMessage({ id: "agent.detail.externalLastActive" }, { time: lastSeenRelative });
    } else if (showDetail && (setupState === "credential_minted" || setupState === "connected")) {
      externalText = formatMessage({ id: "agent.detail.externalNoRaftActivity" });
    } else if (showDetail && externalStatus) {
      externalText = formatMessage({ id: "agent.detail.externalNotConfigured" });
    }
    return (
      <div className="flex min-w-0 items-center gap-1.5">
        <Badge appearance="soft" variant={chipVariant} className="max-w-full">
          <StatusDot presence={activityPresence} className="shrink-0" />
          <Tooltip content={externalTooltip ?? externalText}><span className="min-w-0 truncate">
            {externalText}
          </span></Tooltip>
        </Badge>
      </div>
    );
  }

  // #proj-raft-computer:#68: when the agent can't work now, the chip reads the
  // first broken link of its readiness: what is stuck, whose problem it is and
  // who fixes it (a viewer who may not see the reason gets the generic
  // sentence). A Computer the live status shows offline, too old or revoked
  // keeps its own chip (its link and button; the live status is fresher than
  // the list). Without readiness (an older server) the old paths below decide.
  if (readinessHolds(readiness) && !displayState.blocked) {
    const copy = formatReadiness(formatMessage, readiness, credentialAgent?.runtime, true);
    // Restarting / updating: yellow (in progress); a limit wait or a block: orange; Computer offline: stone.
    const light = readinessLight(readiness);
    const body = readinessBody(formatMessage, copy);
    const tooltip = copy.scope ? formatMessage({ id: "readiness.scoped" }, { scope: copy.scope, text: body }) : body;
    const readinessRetry = !!onRetry && readiness.primary?.code === "verification_required";
    return (
      <div className="flex min-w-0 flex-col gap-1" data-testid="agent-status-row">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Badge
            appearance="soft"
            variant={light.variant}
            className={BLOCKED_STATUS_CHIP_CLASS_NAME}
            data-testid="agent-status-chip"
            data-readiness-code={readiness.primary?.code}
          >
            <StatusDot presence={light.presence} className="shrink-0" />
            <Tooltip content={tooltip}><span className="min-w-0 break-words">{copy.title}</span></Tooltip>
          </Badge>
          {showDetail && copy.link && (
            <TextLink
              className="shrink-0 whitespace-nowrap"
              render={<a href={copy.link.href} target="_blank" rel="noopener noreferrer" aria-label={copy.link.text} />}
              data-testid="agent-readiness-link"
            >
              {copy.link.text}
            </TextLink>
          )}
          {readinessRetry && (
            <TextLink className="shrink-0 whitespace-nowrap" disabled={retrying} onClick={retry} data-testid="agent-status-retry">
              {formatMessage({ id: retrying ? "agent.reset.loading" : "agent.status.retry" })}
            </TextLink>
          )}
        </div>
        {showDetail && (
          <span className="min-w-0 text-callout text-foreground-muted" data-testid="agent-readiness-detail">
            {tooltip}
          </span>
        )}
      </div>
    );
  }

  const credentialReason = credential && !displayState.blocked && !displayState.likelyOnline
    ? credentialInvalidReasonOf({
      activity: displayState.activity,
      activityDetail: displayState.activityDetail,
      activityDetailKind: displayState.activityDetailKind,
      credentialHold: activityState?.credentialHold,
      lastRuntimeError: credential.lastRuntimeError,
    })
    : null;
  // Held or not, it cannot run until someone acts: the error light. The
  // reason is a detail of the error, for its managers only (DS presence:
  // "Error, or Error and the reason").
  const chipActivity: AgentActivity = credentialReason ? "error" : displayState.activity;
  const activityText = credentialReason
    ? (showDetail
      ? formatCredentialInvalidText(formatMessage, credentialReason, credential!)
      : formatActivityText(formatMessage, "error", ""))
    : displayState.blocked
    ? formatAgentBlockedText(formatMessage, displayState.blocked)
    : displayState.likelyOnline
    ? formatMessage({ id: "activity.status.likelyOnline" })
    : showDetail
    ? formatActivityText(
      formatMessage,
      displayState.activity,
      displayState.activityDetail,
      displayState.activityDetailKind,
      displayState.activityErrorCode,
    )
    // #wg-rbac:#57: the code's title is catalog copy for every viewer; the detail is not.
    : formatActivityText(formatMessage, displayState.activity, "", undefined, displayState.activityErrorCode);
  const showRetry = !!onRetry && agentNeedsManualRestart({
    activity: displayState.activity,
    activityDetailKind: displayState.activityDetailKind,
    credentialReason,
    spawnFailureReason: spawnFailure?.reason,
    spawnFailurePaused: spawnFailure?.autoRestartPaused,
    runtimeErrorClass: credential?.lastRuntimeError?.errorClass,
    isExternal: displayState.isExternal,
    blocked: displayState.blocked,
    likelyOnline: displayState.likelyOnline,
  });
  // Reconciler step 12: the runtime cannot use the agent's model. Changing
  // the model is the way out (the server lifts the pause on the change);
  // Retry stays beside it, since a manual start is one too. A context too
  // large for the model (`session_needs_reset`) gets it too: a model with a
  // larger context is one way out (Reset session & restart, in the menu, is
  // the other; it has no Retry, a restart resumes the same session).
  const showChangeModel = showDetail && !!onOpenModelSettings
    && (spawnFailure?.reason === "model_unsupported" || spawnFailure?.reason === "session_needs_reset");
  // task #1116: when the daemon reports deliveries the runtime never consumed,
  // surface the typed counts (ids/classes only) in a truncating sibling so a
  // human can see the observation without opening the trajectory log.
  const deliveryConsumption = showDetail && displayState.activityDetailKind === "delivery_unconsumed"
    ? activityState?.deliveryConsumption
    : undefined;
  const wakeCrashLoop = showDetail && displayState.activityDetailKind === "wake_crash_loop_blocked"
    ? activityState?.wakeCrashLoop
    : undefined;
  const deliveryConsumptionText = deliveryConsumption
    ? formatMessage(
      { id: "activity.status.deliveryUnconsumedDetail" },
      {
        count: deliveryConsumption.unconsumedDeliveries,
        episode: deliveryConsumption.episode,
        path: deliveryConsumption.lastDeliveryPath ?? "unknown",
      },
    )
    : wakeCrashLoop
      ? formatMessage(
        { id: "activity.status.wakeCrashLoopBlockedDetail" },
        {
          count: wakeCrashLoop.earlyExitCount,
          episode: wakeCrashLoop.episode,
          exitKind: wakeCrashLoop.lastExitKind ?? "unknown",
          signal: wakeCrashLoop.lastSignal ? ` ${wakeCrashLoop.lastSignal}` : "",
        },
      )
      : null;
  // Revoked Computer access (reconciler step 15) is a sentence: on a narrow
  // (phone) profile the chip wraps its text instead of cutting it.
  const blocked = displayState.blocked === "computer_access_revoked";
  // Computer offline (#triage:#206) or Computer update required: the chip
  // itself opens that Computer (raft-design identity-and-presence, An agent
  // on an offline computer), where the steps are.
  const computerChip = displayState.blocked === "computer_offline" ? "offline" : displayState.blocked === "computer_too_old" ? "too-old" : null;
  const chipRender = computerChip && openComputer
    ? <button type="button" onClick={openComputer} className="outline-none focus-visible:shadow-focus" data-testid={`agent-status-computer-${computerChip}`} />
    : undefined;
  const statusRow = (
    <div className={blocked ? "flex min-w-0 flex-wrap items-center gap-1.5" : "flex min-w-0 items-center gap-1.5"} data-testid="agent-status-row">
      <Badge appearance="soft" variant={PRESENCE_CHIP_VARIANT[chipActivity]} className={blocked ? BLOCKED_STATUS_CHIP_CLASS_NAME : "max-w-full"} data-testid="agent-status-chip" data-credential-reason={credentialReason ?? undefined} render={chipRender}>
        <StatusDot activity={chipActivity} className="shrink-0" />
        <Tooltip content={activityText}><span className={blocked ? "min-w-0 break-words" : "min-w-0 truncate"}>
          {activityText}
        </span></Tooltip>
      </Badge>
      {/* The quiet action beside the chip is a TextLink (DS text-link; the
          stuck-tool notice's Stop is one too). It has no loading state:
          while the restart runs it says so and is disabled. */}
      {showChangeModel && (
        <TextLink
          className="shrink-0 whitespace-nowrap"
          onClick={onOpenModelSettings}
          data-testid="agent-status-change-model"
        >
          {formatMessage({ id: "agent.status.changeModel" })}
        </TextLink>
      )}
      {showRetry && (
        <TextLink
          className="shrink-0 whitespace-nowrap"
          disabled={retrying}
          onClick={retry}
          data-testid="agent-status-retry"
        >
          {formatMessage({ id: retrying ? "agent.reset.loading" : "agent.status.retry" })}
        </TextLink>
      )}
      {deliveryConsumptionText && (
        <Tooltip content={deliveryConsumptionText}><span className="min-w-0 truncate font-mono text-mono-meta text-foreground-hint">
          {deliveryConsumptionText}
        </span></Tooltip>
      )}
    </div>
  );
  // The stuck notice is not a private surface: every member sees it (Guests
  // never receive the stuck signal), as in a
  // DM's status line and the App; its Stop shows only for whoever may stop
  // the turn (`onStop`). Stop Current Turn lives only here (artin, 2026-11-03,
  // #proj-raft-ui:#191).
  const toolStuck = visibleToolStuck(activityState?.toolStuck, displayState);
  if (!toolStuck) return statusRow;
  // task #25: stuck on one tool call — its own line under the status chip, so
  // the chip never truncates it; with the way out for whoever can stop the agent.
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {statusRow}
      <AgentToolStuckNotice toolStuck={toolStuck} onStop={onStop} />
    </div>
  );
}

// raft-ui's Badge is one 22px nowrap line and does not merge classes, so the
// wrapping chip overrides its height and nowrap outright.
const BLOCKED_STATUS_CHIP_CLASS_NAME = "h-auto! min-h-[22px] max-w-full whitespace-normal! py-0.5";
