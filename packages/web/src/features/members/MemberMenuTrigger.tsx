import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@botiverse/raft-ui";
import { DirectMessageIcon } from "@botiverse/ricons";
import { useCallback, useContext } from "react";
import type { HTMLAttributes, ReactElement, ReactNode } from "react";
import { useIntl } from "react-intl";
import { Play, RotateCcw, Square } from "lucide-react";
import { isExternalAgentRuntime } from "@botiverse/raft-shared";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import type { Agent } from "../../store/agentStore";
import { useAgentDisplayState } from "../../store/agentStore";
import { useAuthStore } from "../../store/authStore";
import { isMachineOffline, useMachineStore } from "../../store/machineStore";
import { agentRuntimeControls } from "../../utils/agentBlockedState";
import { agentRuntimePermissions } from "../../utils/agentVisibility";
import { MemberActionsContext, canMessageEntry } from "./memberActionsContext";
import type { MemberActions } from "./memberActionsContext";
import type { MemberEntry } from "./membersPageModel";

type TriggerProps = Omit<HTMLAttributes<HTMLElement>, "children" | "onDoubleClick"> & Record<`data-${string}`, string | undefined>;

/**
 * A member's tile or row as the trigger of its menu (raft-ui ContextMenu:
 * right-click, or a long press on touch), with a double-click that opens the
 * DM with them, as the retired Members sidebar had. A click still opens the
 * profile (the caller's onClick). The menu holds what the profile offers
 * from its head, by the profile's rules: Message, and for an agent Start or
 * Stop and Restart / reset. With nothing to offer (a Guest, either side) there
 * is no menu and no double-click.
 */
export function MemberMenuTrigger({ entry, render, children, ...props }: TriggerProps & {
  entry: MemberEntry;
  /** The tile or row element, without children. */
  render: ReactElement;
  children: ReactNode;
}) {
  const actions = useContext(MemberActionsContext);
  const canMessage = actions !== null && canMessageEntry(entry, actions.viewerRole);
  const handleDoubleClick = useCallback(() => {
    if (canMessage) actions?.openDm(entry);
  }, [actions, canMessage, entry]);
  return (
    <ContextMenu disabled={!canMessage}>
      <ContextMenuTrigger render={render} {...props} onDoubleClick={canMessage ? handleDoubleClick : undefined}>
        {children}
      </ContextMenuTrigger>
      {canMessage && actions ? (
        <ContextMenuContent className="min-w-48" data-testid={`member-menu-${entry.id}`}>
          {entry.kind === "agent"
            ? <AgentMenuItems entry={entry} agent={entry.agent} actions={actions} />
            : <MessageItem entry={entry} actions={actions} labelId="member.detail.message" />}
        </ContextMenuContent>
      ) : null}
    </ContextMenu>
  );
}

function MessageItem({ entry, actions, labelId }: { entry: MemberEntry; actions: MemberActions; labelId: "member.detail.message" | "agent.detail.directMessage" }) {
  const { formatMessage } = useIntl();
  const open = useCallback(() => actions.openDm(entry), [actions, entry]);
  return (
    <ContextMenuItem onClick={open} data-testid="member-menu-message">
      <DirectMessageIcon />
      {formatMessage({ id: labelId })}
    </ContextMenuItem>
  );
}

/** Mounted only while the menu is open: the agent's live state picks its controls (agentRuntimeControls, #triage:#206). */
function AgentMenuItems({ entry, agent, actions }: { entry: MemberEntry; agent: Agent; actions: MemberActions }) {
  const { formatMessage } = useIntl();
  const userId = useAuthStore((s) => s.user?.id);
  const { capabilities } = useServerPermissions();
  const { isOnline } = useAgentDisplayState(agent.id, agent);
  const computerOffline = useMachineStore((s) => isMachineOffline(s.machines, agent.machineId));
  const permissions = agentRuntimePermissions(agent, userId, capabilities, {
    isExternalAgent: agent.external === true || isExternalAgentRuntime(agent.runtime),
  });
  const controls = agentRuntimeControls({
    canControl: permissions.canControlAgentRuntime,
    canStop: permissions.canStopAgent,
    isOnline,
    computerOffline,
    stoppedByPerson: agent.status === "stopped",
  });
  // The label and the action come from the same `controls.stop`, so they can't drift.
  const startStop = useCallback(() => {
    if (controls.stop) actions.requestStop(agent);
    else actions.startAgent(agent);
  }, [actions, agent, controls.stop]);
  const restartReset = useCallback(() => actions.requestReset(agent), [actions, agent]);
  const hasControls = controls.start || controls.stop || controls.restartReset;
  return (
    <>
      <MessageItem entry={entry} actions={actions} labelId="agent.detail.directMessage" />
      {hasControls ? <ContextMenuSeparator /> : null}
      {controls.start || controls.stop ? (
        <ContextMenuItem onClick={startStop} data-testid="member-menu-start-stop">
          {controls.stop ? <Square /> : <Play />}
          {formatMessage({ id: controls.stop ? "agent.detail.stopAgent" : "agent.detail.startAgent" })}
        </ContextMenuItem>
      ) : null}
      {controls.restartReset ? (
        <ContextMenuItem onClick={restartReset} data-testid="member-menu-restart-reset">
          <RotateCcw />
          {formatMessage({ id: "agent.detail.restartReset" })}
        </ContextMenuItem>
      ) : null}
    </>
  );
}
