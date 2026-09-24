import { useEffect, useMemo } from "react";
import { formatRuntimeLabelWithStatus } from "../../utils/runtimeAvailabilityLabel";
import { useIntl } from "react-intl";
import { isExternalAgentRuntime, REASONING_EFFORT_RUNTIMES, runtimeConfigModelValue } from "@botiverse/raft-shared";
import { useAgentDisplayState, useAgentStore } from "../../store/agentStore";
import type { Agent } from "../../store/agentStore";
import { useMachineStore } from "../../store/machineStore";
import { resolveAgentMachineRow } from "../../utils/agentMachineRow";
import { useServerStore } from "../../store/serverStore";
import type { ServerMember } from "../../store/serverStore";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useAuthStore } from "../../store/authStore";
import { canViewAgentPrivateSurfaces } from "../../utils/agentVisibility";
import { formatActivityText } from "../../utils/activity";
import { hydrateRuntimeConfigForm } from "../../utils/runtimeConfigForm";
import { projectRuntimeModelLabelPresentation, useRuntimeModels } from "../../hooks/useRuntimeModels";
import AvatarSlot from "../ui/AvatarSlot";
import StatusDot from "../ui/StatusDot";
import MentionHoverActivityPreview from "./MentionHoverActivityPreview";

interface ProfilePreviewCardContentProps {
  mentionType: "agent" | "user";
  mentionId: string;
  fallbackAgent?: Agent | null;
  fallbackMember?: ServerMember | null;
  /**
   * Best-effort handle for the mention (e.g. from the mention token) so the
   * card can still render a minimal, non-empty state when the referenced
   * entity is not in the local store and no fallback profile was supplied.
   * Without this, a missing entity used to render `null`, collapsing the
   * hover card into an empty black bar (joint-channel cross-server mentions).
   */
  fallbackLabel?: string;
  /**
   * Opens the agent's activity from the recent-activity heading.
   *
   * Deliberately a prop rather than a `useAppNavigate()` call inside this
   * component: dismissing the hover card is the caller's job (it owns
   * `previewActionsRef`), and every sibling navigation out of this card closes
   * it before navigating. Navigating from in here would leave the card
   * floating over the destination.
   */
  onOpenAgentActivity?: (agentId: string) => void;
}

export default function ProfilePreviewCardContent({ mentionType, mentionId, fallbackAgent, fallbackMember, fallbackLabel, onOpenAgentActivity }: ProfilePreviewCardContentProps) {
  const { formatMessage } = useIntl();
  const { formatClockWithSeconds } = useTimeFormatter();
  const currentUserId = useAuthStore((s) => s.user?.id);
  const { capabilities } = useServerPermissions();
  const agent = useAgentStore((s) => (mentionType === "agent" ? s.agents.find((a) => a.id === mentionId) : undefined));
  const profileAgent = mentionType === "agent" ? agent ?? fallbackAgent : undefined;
  // task #259: same rule as the agent detail panel — no "No computer assigned" while the
  // machine store has no snapshot yet; the Computer line is simply not rendered until then.
  const machines = useMachineStore((s) => s.machines);
  const machineLoadStatus = useMachineStore((s) => s.loadStatus);
  const agentMachineRow = resolveAgentMachineRow(
    mentionType === "agent" ? profileAgent?.machineId : null,
    machines,
    machineLoadStatus,
  );
  const agentMachine = agentMachineRow.kind === "machine" ? agentMachineRow.machine : undefined;
  const trajectoryLog = useAgentStore((s) => (mentionType === "agent" ? s.trajectoryLogs[mentionId] : undefined));
  const ensureAgentProfile = useAgentStore((s) => s.ensureAgentProfile);
  const loadTrajectoryLog = useAgentStore((s) => s.loadTrajectoryLog);
  const displayState = useAgentDisplayState(mentionId, mentionType === "agent" ? profileAgent : undefined);
  const member = useServerStore((s) => (mentionType === "user" ? s.members.find((m) => m.userId === mentionId) : undefined));
  const profileMember = mentionType === "user" ? member ?? fallbackMember : undefined;
  const canViewPrivateAgentSurfaces = mentionType === "agent" && profileAgent
    ? canViewAgentPrivateSurfaces(profileAgent, currentUserId, capabilities.editAgents)
    : false;
  const isChannelSummaryAgent = mentionType === "agent" && profileAgent?.profileProjection === "channel_summary";
  // Only hydrate when the projection actually carried a private `runtimeConfig`.
  // Member/non-admin agent projections and the `agent:created` broadcast strip it
  // legitimately, and hydrating that shape used to build a Built-in config with no
  // provider and throw while deriving trace attributes. Gating on the payload —
  // not on the viewer's permission — is deliberate: an admin can still receive a
  // stripped agent from the broadcast before the full profile loads.
  //
  // With `null` here the card falls through to the public `profileAgent.runtime` /
  // `profileAgent.model` columns below, which is the intended degraded display. We
  // never synthesize a provider just to render, so no writeOnly key is requested.
  const runtimeConfig = useMemo(() => (
    mentionType === "agent" && profileAgent?.runtimeConfig
      ? hydrateRuntimeConfigForm(profileAgent)
      : null
  ), [mentionType, profileAgent]);
  const runtimeModels = useRuntimeModels(profileAgent?.machineId, runtimeConfig?.runtime ?? "");

  useEffect(() => {
    if (!canViewPrivateAgentSurfaces || mentionType !== "agent" || trajectoryLog !== undefined) return;
    void loadTrajectoryLog(mentionId, 5);
  }, [canViewPrivateAgentSurfaces, loadTrajectoryLog, mentionId, mentionType, trajectoryLog]);

  useEffect(() => {
    if (mentionType !== "agent" || profileAgent) return;
    void ensureAgentProfile(mentionId);
  }, [ensureAgentProfile, mentionId, mentionType, profileAgent]);

  const unavailableHandle = fallbackLabel ? `@${fallbackLabel.replace(/^@/, "")}` : null;

  return useMemo(() => {
    if (mentionType === "agent") {
      if (!profileAgent) {
        // Missing entity + no fallback profile (e.g. cross-server @mention not
        // in the local store). Render a minimal graceful card instead of
        // `null` so the hover card never collapses into an empty black bar.
        return (
          <div className="flex items-start gap-3 px-3 py-3">
            <AvatarSlot context="mention-card" type="agent" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-bold text-black">{unavailableHandle ?? formatMessage({ id: "message.profilePreview.fallbackAgent" })}</div>
              <div className="truncate font-mono text-xs text-black/60">{formatMessage({ id: "message.profilePreview.unavailable" })}</div>
            </div>
          </div>
        );
      }
      const displayName = profileAgent.displayName || profileAgent.name;
      const activityText = canViewPrivateAgentSurfaces
        ? displayState
          ? formatActivityText(
            formatMessage,
            displayState.activity,
            displayState.activityDetail,
            displayState.activityDetailKind,
          )
          : undefined
        : displayState
          ? formatActivityText(formatMessage, displayState.activity, "")
          : formatMessage({ id: "activity.status.offline" });
      const renderedActivityText = activityText || formatMessage({ id: "activity.status.offline" });
      const runtimeId = runtimeConfig?.runtime ?? profileAgent.runtime ?? "unknown";
      const modelId = runtimeConfig ? runtimeConfigModelValue(runtimeConfig) : profileAgent.model || "default";
      const runtimeLabel = formatRuntimeLabelWithStatus(runtimeId, formatMessage);
      const modelPresentation = projectRuntimeModelLabelPresentation(runtimeId, modelId, runtimeModels);
      const modelLabel = modelPresentation.kind === "pending"
        ? formatMessage({ id: "common.loading" })
        : modelPresentation.label;
      const reasoningLabel = REASONING_EFFORT_RUNTIMES.has(runtimeId)
        ? runtimeConfig?.reasoningEffort || formatMessage({ id: "message.profilePreview.reasoningDefault" })
        : null;
      const isExternalAgent = profileAgent.external === true || isExternalAgentRuntime(runtimeId);
      const computerLabel = isExternalAgent
        ? formatMessage({ id: "message.profilePreview.externalRuntime" })
        : agentMachineRow.kind === "pending"
          ? null
          : agentMachine
            ? agentMachine.name
            : formatMessage({ id: "message.profilePreview.noComputerAssigned" });
      return (
        <>
          <div className="flex items-start gap-3 px-3 py-3">
            <AvatarSlot context="mention-card" type="agent" agentAvatarUrl={profileAgent.avatarUrl} className="mt-0.5 self-start" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-bold text-black">{displayName}</span>
                <StatusDot activity={displayState?.activity ?? "offline"} external={displayState?.isExternal} size="sm" />
                <span className="truncate font-mono text-xs text-black/60">
                  {renderedActivityText}
                </span>
              </div>
              <div className="truncate font-mono text-xs text-black/60">@{profileAgent.name}</div>
              {!isChannelSummaryAgent ? <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 border-t border-black/20 pt-2 text-[11px] leading-tight">
                {computerLabel !== null ? (
                  <>
                    <dt className="font-mono text-black/45">{formatMessage({ id: "message.profilePreview.labelComputer" })}</dt>
                    <dd className="min-w-0 truncate font-mono text-black/70" title={computerLabel}>{computerLabel}</dd>
                  </>
                ) : null}
                <dt className="font-mono text-black/45">{formatMessage({ id: "message.profilePreview.labelRuntime" })}</dt>
                <dd className="min-w-0 truncate font-mono text-black/70" title={runtimeLabel}>{runtimeLabel}</dd>
                <dt className="font-mono text-black/45">{formatMessage({ id: "message.profilePreview.labelModel" })}</dt>
                <dd className="min-w-0 truncate font-mono text-black/70" title={modelLabel}>{modelLabel}</dd>
                {reasoningLabel ? (
                  <>
                    <dt className="font-mono text-black/45">{formatMessage({ id: "message.profilePreview.labelReasoning" })}</dt>
                    <dd className="min-w-0 truncate font-mono capitalize text-black/70" title={reasoningLabel}>{reasoningLabel}</dd>
                  </>
                ) : null}
              </dl> : null}
            </div>
          </div>
          {profileAgent.description ? (
            <div className="truncate border-t-2 border-black px-3 py-2 text-xs text-black/70" title={profileAgent.description}>
              {profileAgent.description}
            </div>
          ) : null}
          {canViewPrivateAgentSurfaces ? (
            <MentionHoverActivityPreview
              entries={trajectoryLog ?? []}
              formatTimestamp={formatClockWithSeconds}
              onOpenActivity={
                onOpenAgentActivity && profileAgent
                  ? () => onOpenAgentActivity(profileAgent.id)
                  : undefined
              }
            />
          ) : null}
        </>
      );
    }

    if (!profileMember) {
      // Missing entity + no fallback profile (cross-server human @mention not
      // in the local store). Minimal graceful card, never a null/black-bar.
      return (
        <div className="flex items-start gap-3 px-3 py-3">
          <AvatarSlot context="mention-card" type="human" humanPlaceholder />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-bold text-black">{unavailableHandle ?? formatMessage({ id: "message.profilePreview.fallbackMember" })}</div>
            <div className="truncate font-mono text-xs text-black/60">{formatMessage({ id: "message.profilePreview.unavailable" })}</div>
          </div>
        </div>
      );
    }
    const displayName = profileMember.displayName || profileMember.name;
    return (
      <>
        <div className="flex items-start gap-3 px-3 py-3">
          <AvatarSlot context="mention-card" type="human" humanAvatarUrl={profileMember.avatarUrl} gravatarHash={profileMember.gravatarHash} className="mt-0.5 self-start" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-bold text-black">{displayName}</div>
            <div className="truncate font-mono text-xs text-black/60">@{profileMember.name}</div>
          </div>
        </div>
        {profileMember.description ? (
          <div className="truncate border-t-2 border-black px-3 py-2 text-xs text-black/70" title={profileMember.description}>
            {profileMember.description}
          </div>
        ) : null}
      </>
    );
  }, [mentionType, profileAgent, agentMachine, agentMachineRow.kind, runtimeConfig, runtimeModels, canViewPrivateAgentSurfaces, isChannelSummaryAgent, displayState, trajectoryLog, formatClockWithSeconds, profileMember, unavailableHandle, formatMessage, onOpenAgentActivity]);
}
