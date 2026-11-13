import { CheckboxIndicator, ListRow, ListRowBody, ListRowMeta, ListRowTitle } from "@botiverse/raft-ui";
import type { Agent, AgentDisplayState } from "../../store/agentStore";
import AvatarListRow from "../ui/AvatarListRow";
import AvatarSlot from "../ui/AvatarSlot";
import StatusDot from "../ui/StatusDot";
import Tooltip from "../ui/Tooltip";
import { agentModelLabel } from "../../utils/agentModelName";
import { formatActivityText, formatAgentBlockedText, getActivityTextDescriptor } from "../../utils/activity";
import { formatRuntimeLabelWithStatus } from "../../utils/runtimeAvailabilityLabel";
import { useRuntimeDeprecatedHere } from "../../hooks/useServerRuntimeCatalog";
import { useCallback } from "react";
import { useIntl } from "react-intl";

// A row a bulk action just changed is located (states.md#located): the same
// cyan as any item a jump lands on, not a green "success" (the banner above
// says it worked).
const BULK_HIGHLIGHT_BUTTON_PROPS = { "data-bulk-highlight": "true", "data-located": "" } as const;

export function MachineAgentRow({
  agent,
  displayState,
  selectionMode,
  selected,
  canManageMachines,
  onToggleSelection,
  onOpenAgent,
  located = false,
}: {
  agent: Agent;
  displayState: AgentDisplayState;
  selectionMode: boolean;
  selected: boolean;
  canManageMachines: boolean;
  onToggleSelection: (agentId: string) => void;
  onOpenAgent: (agentId: string) => void;
  /** Located (states.md#located) while the panel's highlight for the bulk
   *  change that just changed this row is on. */
  located?: boolean;
}) {
  const { formatMessage } = useIntl();
  const deprecatedHere = useRuntimeDeprecatedHere();
  const agentId = agent.id;
  const handleToggleSelection = useCallback(() => onToggleSelection(agentId), [agentId, onToggleSelection]);
  const handleOpenAgent = useCallback(() => onOpenAgent(agentId), [agentId, onOpenAgent]);
  // A Computer page is where these agent identities are managed:
  // show the model alongside the runtime (artin 2026-09-27), not
  // only the chat-side "Show agent model" preference.
  const agentIdentityLabel = [
    formatRuntimeLabelWithStatus(agent.runtime, formatMessage, deprecatedHere(agent.runtime)),
    agentModelLabel(agent),
  ].filter(Boolean).join(" · ");
  const activityText = displayState.blocked
    ? formatAgentBlockedText(formatMessage, displayState.blocked)
    : displayState.likelyOnline
    ? formatMessage({ id: "activity.status.likelyOnline" })
    : formatActivityText(
      formatMessage,
      displayState.activity,
      displayState.activityDetail,
      displayState.activityDetailKind,
      displayState.activityErrorCode,
    );
  const avatar = <AvatarSlot context="list-row" type="agent" agentAvatarUrl={agent.avatarUrl} />;
  // Only a plain Online / Offline may shrink to the dot alone; anything else
  // (an error, a block, what it is working on) is text the reader may need to
  // act on, and a tooltip is not enough (touch, screen readers).
  // "Likely online" (no state yet, #triage:#97) is a plain presence too.
  const activityTextId = displayState.blocked
    ? null
    : (() => {
      const { primary } = getActivityTextDescriptor(
        displayState.activity,
        displayState.activityDetail,
        displayState.activityDetailKind,
      );
      return "id" in primary ? primary.id : null;
    })();
  const plainPresence = activityTextId === "activity.status.online" || activityTextId === "activity.status.offline";
  // The row is the container (`@container`), not the window: next to an open
  // profile the Computer column is ~320px on a wide window. From @md the
  // status sits on the right; below it, non-plain status gets its own line
  // under the name and wraps.
  const rightStatus = (
    <span className={`${plainPresence ? "flex" : "hidden @md:flex"} items-center gap-1.5`}>
      <StatusDot activity={displayState.activity} title={activityText} />
      <Tooltip content={activityText}><span
        className="hidden max-w-[min(32rem,42cqw)] truncate align-middle font-mono text-mono-meta text-foreground-hint @md:inline-block"
      >
        {activityText}
      </span></Tooltip>
    </span>
  );
  const subtitle = plainPresence ? agentIdentityLabel : (
    <>
      <span className="block">{agentIdentityLabel}</span>
      <span className="mt-1 flex items-start gap-1.5 @md:hidden" data-testid="machine-agent-row-status-line">
        <StatusDot activity={displayState.activity} className="mt-[3px] shrink-0" />
        <span className="line-clamp-3 min-w-0 break-words text-foreground-muted">{activityText}</span>
      </span>
    </>
  );
  if (selectionMode) {
    // Selection mode adds a leading checkbox to the same raft-ui ListRow the
    // normal-mode AvatarListRow draws (avatar / name / subtitle / status):
    // the row toggles the selection, and a selected row is the cyan-soft
    // selection.
    return (
      <Tooltip content={
          selected
            ? formatMessage({ id: "machine.detail.deselectAgent" })
            : formatMessage({ id: "machine.detail.selectAgent" })
        }>
      <ListRow
        selected={canManageMachines && selected}
        onClick={handleToggleSelection}
        // `group`: CheckboxIndicator's previewOnHover hook (group-hover).
        className="group @container"
        aria-label={
          selected
            ? formatMessage({ id: "machine.detail.deselectAgentName" }, { name: agent.displayName || agent.name })
            : formatMessage({ id: "machine.detail.selectAgentName" }, { name: agent.displayName || agent.name })
        }
      >
        <CheckboxIndicator
          checked={selected}
          previewOnHover
          className="mt-0"
        />
        {avatar}
        <ListRowBody>
          <ListRowTitle>{agent.displayName || agent.name}</ListRowTitle>
          <ListRowMeta>{subtitle}</ListRowMeta>
        </ListRowBody>
        <span className="flex shrink-0 items-center">{rightStatus}</span>
      </ListRow>
      </Tooltip>
    );
  }
  return (
    <AvatarListRow
      avatar={avatar}
      name={agent.displayName || agent.name}
      subtitle={subtitle}
      rightContent={rightStatus}
      onClick={handleOpenAgent}
      selected={false}
      buttonProps={located ? BULK_HIGHLIGHT_BUTTON_PROPS : undefined}
      className="@container"
    />
  );
}
