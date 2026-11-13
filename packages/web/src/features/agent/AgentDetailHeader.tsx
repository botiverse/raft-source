import { Badge, PanelAction } from "@botiverse/raft-ui";
import { useMemo, useCallback } from "react";
import { useIntl } from "react-intl";
import { X } from "lucide-react";
import { useMobileBack } from "../../hooks/useAppNavigate";
import { isExternalAgentRuntime } from "@botiverse/raft-shared";
import { agentRuntimeControls } from "../../utils/agentBlockedState";
import { useAgentStore, useAgentDisplayState } from "../../store/agentStore";
import type { Agent } from "../../store/agentStore";
import { useServerStore } from "../../store/serverStore";
import AgentProfileOverflowMenu from "../../components/agent/AgentProfileOverflowMenu";
import PanelHeader, { PROFILE_HANDLE_FONT_CLASS } from "../../components/ui/PanelHeader";
import AvatarSlot from "../../components/ui/AvatarSlot";
import { RowExpandAction } from "../../components/layout/RowExpandAction";
import { shownOwnActions, useHeadWidth } from "../../components/layout/headFit";
import { useRowExpand, useRowPlanned } from "../../components/layout/rowPlanStore";



// Isolated header component — only re-renders on activity changes for this agent,
// without triggering re-render of ChatPanel / tabs below.
export function AgentDetailHeader({ agent, canControlAgentRuntime, canStopAgent, canMessageAgent, onMessage, onOpenLounge, onClose, onBack, onShowResetDialog, onShowStopConfirm, onPauseAssistant, onStartSettled, computerOffline }: {   agent: Agent;
  canControlAgentRuntime: boolean;
  canStopAgent: boolean;
  canMessageAgent: boolean;
  onMessage: () => void;
  /** Agent Lounge v0: open this agent's Lounge; omitted while the flag is off or for a Guest. */
  onOpenLounge?: () => void;
  onClose?: () => void;
  onBack?: () => void;
  onShowResetDialog: () => void;
  onShowStopConfirm: () => void;
  /** A server owner/admin on someone else's assistant: Pause Assistant (confirmed by the caller). */
  onPauseAssistant?: () => void;
  /** Start answered: null when it went through, else the refusal (#triage:#206: the panel says why). */
  onStartSettled?: (error: unknown) => void;
  /** Its Computer is offline: Start gives way to the profile's offline card (#triage:#206). */
  computerOffline?: boolean;
}) {
  const { formatMessage } = useIntl();
  const slug = useServerStore((s) => s.current?.slug);
  // Two render modes for AgentDetailPanel:
  //   - Standalone route `/agent/<id>` — back falls back to /members rail.
  //   - Overlay (`?profile=agent:<id>` driven by ProfilePanel + useProfileStore)
  //     — `onClose` is closeProfile; back should close the overlay so the
  //     user lands on the underlying channel/DM, NOT skip to /members.
  // See useMobileBack JSDoc for the cold-start permalink scenario fixed
  // by this branch (#proj-mobile:b1c622e5 stdrc 2026-05-08).
  const responsiveBack = useMobileBack(onClose ?? (slug ? `/s/${slug}/members` : "/"));
  const headerBack = onBack ?? responsiveBack;
  const displayState = useAgentDisplayState(agent.id, agent);
  const currentServerId = useServerStore((s) => s.current?.id);
  const startAgent = useAgentStore((s) => s.startAgent);
  // The live record: a Stop just now makes it a person-stopped agent (no Stop while its Computer is offline).
  const stoppedByPerson = useAgentStore((s) => (s.agents.find((a) => a.id === agent.id) ?? agent).status === "stopped");
  const isOnline = displayState.isOnline;
  const isDeleted = !!agent.deletedAt;
  const isExternalAgent = agent.external === true || isExternalAgentRuntime(agent.runtime);
  // Pinned by agentVisibility.test.ts as the...
  // stay in member-view mode" contract. Currently the rendered JSX dropped
  // the surfacing branch in a recent layout pass, so the value is unread —
  // `void` keeps it lint-clean without breaking the contract test that
  // guards the source-server resolution shape for future re-introduction.
  const sourceServerLabel =
    currentServerId && agent.serverId && agent.serverId !== currentServerId
      ? agent.serverName || agent.serverSlug || null
      : null;
  void sourceServerLabel;
  // The same rule picks the control's label (AgentProfileOverflowMenu) and its action, so they can't drift.
  const controls = agentRuntimeControls({
    canControl: canControlAgentRuntime && !isExternalAgent,
    canStop: canStopAgent,
    isOnline,
    computerOffline: computerOffline ?? false,
    stoppedByPerson,
  });
  const handleStartStop = useCallback(() => {
    if (controls.stop) onShowStopConfirm();
    else if (controls.start) startAgent(agent.id).then(() => onStartSettled?.(null), (error: unknown) => onStartSettled?.(error));
  }, [agent.id, controls.start, controls.stop, onShowStopConfirm, onStartSettled, startAgent]);
  const mobileBackTitle = formatMessage({ id: "common.announcement.back" });
  const mobileBackProps = useMemo(
    () => ({ "data-testid": "agent-mobile-back", title: mobileBackTitle }),
    [mobileBackTitle],
  );
  const headerTitle = agent.managedByAppInstallId
    ? (agent.managedByApp ? agent.managedByApp.name : (agent.displayName || agent.name))
    : (agent.displayName || agent.name);
  const titleClickProps = useMemo(() => ({ title: headerTitle }), [headerTitle]);
  // A column of the planned row (#189 rule 6): the head always fits. Its avatar goes under 240px (the prototype's),
  // and Direct Message goes into ⋯ where the title would drop under its room; ⋯, Expand and Close stay.
  const planned = useRowPlanned();
  const [measure, headWidth] = useHeadWidth();
  const containerProps = useMemo(() => ({ className: "agent-profile-header-container", ref: measure }), [measure]);
  const expand = useRowExpand("profile");
  const narrow = planned && headWidth > 0;
  const showAvatar = !narrow || headWidth >= 240;
  const messageInMenu = narrow && canMessageAgent && shownOwnActions({ width: headWidth, lead: showAvatar ? 1 : 0, own: [32], controls: (expand.shown ? 1 : 0) + (onClose ? 1 : 0), menuItems: 1 }) === 0;

  const overflowActions = !isDeleted ? (
    <AgentProfileOverflowMenu
      canMessageAgent={canMessageAgent}
      canControlAgentRuntime={canControlAgentRuntime && !isExternalAgent}
      canStopAgent={canStopAgent}
      isOnline={isOnline}
      computerOffline={computerOffline}
      stoppedByPerson={stoppedByPerson}
      messageLabel={formatMessage({ id: "agent.detail.directMessage" })}
      onMessage={onMessage}
      onStartStop={handleStartStop}
      onRestartReset={onShowResetDialog}
      onPauseAssistant={onPauseAssistant}
      onOpenLounge={onOpenLounge}
      messageInMenu={messageInMenu}
    />
  ) : null;
  const actions = (
    <>
      {overflowActions}
      {/* The profile's Expand (#189 rule 5), a window control against Close; none outside the planned row. */}
      <RowExpandAction />
      {onClose && (
        <PanelAction
          onClick={onClose}
          className={onBack ? "flex" : "hidden md:flex"}
          aria-label={formatMessage({ id: "common.close" })}
          title={formatMessage({ id: "common.close" })}
        >
          <X />
        </PanelAction>
      )}
    </>
  );

  return (
    <PanelHeader
      onMobileBack={headerBack}
      backButtonVisibility={onBack ? "always" : "responsive"}
      mobileBackProps={mobileBackProps}
      iconSlot={showAvatar ? (
        <AvatarSlot
          context="panel-header"
          type="agent"
          agentAvatarUrl={agent.avatarUrl}
          className={isDeleted ? "grayscale opacity-dimmed" : ""}
        />
      ) : undefined}
      iconAlwaysVisible
      iconKind="avatar"
      title={headerTitle}
      // Handle parity with the human profile header (cindyz 2026-10-10, #737):
      // title = display name, subtitle = the weaker @handle in the same meta spec.
      subtitle={`@${agent.name}`}
      subtitleClassName={PROFILE_HANDLE_FONT_CLASS}
      titleClickProps={titleClickProps}
      titleSuffix={
        isDeleted ? (
          <div className="flex min-w-0 items-center gap-1.5">
            <Badge appearance="soft" variant="muted" className="shrink-0">
              {formatMessage({ id: "agent.detail.deleted" })}
            </Badge>
          </div>
        ) : undefined
      }
      containerProps={containerProps}
      actions={actions}
    />
  );
}
