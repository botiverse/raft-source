import { EllipsisVertical, Pause, Play, RotateCcw, Square } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  PanelAction,
} from "@botiverse/raft-ui";
import { DirectMessageIcon } from "@botiverse/ricons";
import { useIntl } from "react-intl";
import Tooltip from "../ui/Tooltip";
import { AgentLoungeIcon } from "./agentLounge";
import { useContext } from "react";
import { ColumnMoveMenuItems } from "../layout/ColumnMoveMenu";
import { RowRegionContext } from "../layout/rowPlanStore";
import { useColumnMoveItems } from "../task/columnMoves";
import { agentRuntimeControls } from "../../utils/agentBlockedState";

interface AgentProfileOverflowMenuProps {
  canMessageAgent: boolean;
  canControlAgentRuntime: boolean;
  /** Stop Agent: a server owner/admin or the agent's creator; members may still start, restart and stop a turn. */
  canStopAgent: boolean;
  isOnline: boolean;
  /** Its Computer is offline (#triage:#206): no Start or Restart / Reset; the profile's offline card takes their place. */
  computerOffline?: boolean;
  /** A person stopped it (`status: "stopped"`): no Stop while its Computer is offline. */
  stoppedByPerson?: boolean;
  messageLabel: string;
  onMessage: () => void;
  onStartStop: () => void;
  onRestartReset: () => void;
  /**
   * Someone else's personal assistant, for a server owner/admin: their Stop
   * pauses it until its owner starts it, so it says so ("Pause Assistant")
   * and the caller confirms first.
   */
  onPauseAssistant?: () => void;
  /**
   * The head too narrow for Direct Message as a button (#189 rule 6, a column of the planned row): it goes first in
   * ⋯, which then shows at every width.
   */
  messageInMenu?: boolean;
  /** Agent Lounge v0: open this agent's Lounge (flag on, not a Guest). Omitted: no Lounge item. */
  onOpenLounge?: () => void;
}

// The profile action strip sits flush against the top edge of its panel.
// RUI's tooltip defaults to `side="top"`; at this edge collision shifting
// can keep the popup inside the viewport by moving it back over the
// trigger. Use the documented panel-header direction so the label always
// clears the action button instead of occluding it.
const PROFILE_TOOLTIP_CONTENT_PROPS = { side: "bottom" as const };

/**
 * The Agent Profile header's commands. Direct Message is its own button at
 * every width, before ⋯ (artin, 2026-11-03). The other commands show as
 * buttons while the panel has room and fold into ⋯ as it narrows. Stop
 * Current Turn is not a header command: the stuck-tool notice offers it where
 * it is needed. Structural navigation (Back / Close) stays outside, and
 * unavailable commands are omitted instead of shown disabled.
 */
export default function AgentProfileOverflowMenu({
  canMessageAgent,
  canControlAgentRuntime,
  canStopAgent,
  isOnline,
  computerOffline = false,
  stoppedByPerson = false,
  messageLabel,
  onMessage,
  onStartStop,
  onRestartReset,
  onPauseAssistant,
  onOpenLounge,
  messageInMenu = false,
}: AgentProfileOverflowMenuProps) {
  const { formatMessage } = useIntl();
  const menuLabel = formatMessage({ id: "agent.detail.moreActions" });
  const restartResetLabel = formatMessage({ id: "agent.detail.restartReset" });
  const pauseAssistantLabel = formatMessage({ id: "assistant.pause.action" });
  const loungeLabel = formatMessage({ id: "agent.lounge.label" });
  // Start when offline; Stop only for those who may stop the agent; neither Start nor Restart / Reset while the
  // Computer is offline (agentRuntimeControls, the rule every surface shares).
  const controls = agentRuntimeControls({ canControl: canControlAgentRuntime, canStop: canStopAgent, isOnline, computerOffline, stoppedByPerson });
  // What the Start/Stop control offers: Stop also for an agent waiting on its offline Computer.
  const offersStop = controls.stop;
  const startStopLabel = formatMessage({ id: offersStop ? "agent.detail.stopAgent" : "agent.detail.startAgent" });
  const canStartStop = controls.start || controls.stop;
  const canRestartReset = controls.restartReset;

  // What shows as buttons with room and in ⋯ without (Start/Stop needs runtime control too).
  const hasFoldingCommands = Boolean(onOpenLounge) || controls.start || controls.stop || controls.restartReset || Boolean(onPauseAssistant);
  // In the row's column: Move Left / Move Right in ⋯, and Direct Message there where the head is narrow (#189).
  const region = useContext(RowRegionContext);
  const moves = useColumnMoveItems(region);
  const foldMessage = messageInMenu && canMessageAgent;
  const menuAlways = foldMessage || moves.length > 0;
  if (!canMessageAgent && !hasFoldingCommands && moves.length === 0) return null;

  // Header icon buttons are raft-ui PanelAction (44 on a phone, the DS small
  // 32 on desktop); the groups keep the panel head's action gap.
  const messageAction = canMessageAgent && !foldMessage ? (
    <Tooltip content={messageLabel} contentProps={PROFILE_TOOLTIP_CONTENT_PROPS}>
      <PanelAction
        aria-label={messageLabel}
        onClick={onMessage}
        data-testid="agent-profile-message"
      >
        <DirectMessageIcon />
      </PanelAction>
    </Tooltip>
  ) : null;

  const inlineActions = (
    <div
      className="agent-profile-inline-actions hidden items-center gap-0.5 md:pointer-fine:gap-1"
      data-testid="agent-profile-inline-actions"
    >
      {onOpenLounge && (
        <Tooltip content={loungeLabel} contentProps={PROFILE_TOOLTIP_CONTENT_PROPS}>
          <PanelAction
            aria-label={loungeLabel}
            onClick={onOpenLounge}
            data-testid="agent-profile-inline-lounge"
          >
            <AgentLoungeIcon />
          </PanelAction>
        </Tooltip>
      )}
      {canStartStop && (
        <Tooltip content={startStopLabel} contentProps={PROFILE_TOOLTIP_CONTENT_PROPS}>
          <PanelAction
            aria-label={startStopLabel}
            onClick={onStartStop}
            data-testid="agent-profile-inline-start-stop"
          >
            {offersStop ? <Square /> : <Play />}
          </PanelAction>
        </Tooltip>
      )}
      {canRestartReset && (
        <Tooltip content={restartResetLabel} contentProps={PROFILE_TOOLTIP_CONTENT_PROPS}>
          <PanelAction
            aria-label={restartResetLabel}
            onClick={onRestartReset}
            data-testid="agent-profile-inline-restart-reset"
          >
            <RotateCcw />
          </PanelAction>
        </Tooltip>
      )}
      {onPauseAssistant && (
        <Tooltip content={pauseAssistantLabel} contentProps={PROFILE_TOOLTIP_CONTENT_PROPS}>
          <PanelAction
            aria-label={pauseAssistantLabel}
            onClick={onPauseAssistant}
            data-testid="agent-profile-inline-pause-assistant"
          >
            <Pause />
          </PanelAction>
        </Tooltip>
      )}
    </div>
  );

  const overflowMenu = (
    <div className={menuAlways ? "agent-profile-overflow-actions agent-profile-overflow-shown" : "agent-profile-overflow-actions"}>
      <DropdownMenu>
        <Tooltip content={menuLabel} contentProps={PROFILE_TOOLTIP_CONTENT_PROPS}>
          <DropdownMenuTrigger
            render={(
              <PanelAction
                aria-label={menuLabel}
                data-testid="agent-profile-overflow-trigger"
              >
                <EllipsisVertical />
              </PanelAction>
            )}
          />
        </Tooltip>
        <DropdownMenuContent
          side="bottom"
          align="end"
          sideOffset={4}
              aria-label={menuLabel}
          data-testid="agent-profile-overflow-menu"
        >
          {foldMessage && (
            <DropdownMenuItem onClick={onMessage} data-testid="agent-profile-overflow-message">
              <DirectMessageIcon />
              {messageLabel}
            </DropdownMenuItem>
          )}
          {onOpenLounge && (
            <DropdownMenuItem
              onClick={onOpenLounge}
              data-testid="agent-profile-overflow-lounge"
            >
              <AgentLoungeIcon />
              {loungeLabel}
            </DropdownMenuItem>
          )}
          {canStartStop && (
            <DropdownMenuItem
              onClick={onStartStop}
              data-testid="agent-profile-overflow-start-stop"
            >
              {offersStop ? <Square /> : <Play />}
              {formatMessage({
                id: offersStop ? "agent.detail.stopAgent" : "agent.detail.startAgent",
              })}
            </DropdownMenuItem>
          )}
          {canRestartReset && (
            <DropdownMenuItem
              onClick={onRestartReset}
              data-testid="agent-profile-overflow-restart-reset"
            >
              <RotateCcw />
              {formatMessage({ id: "agent.detail.restartReset" })}
            </DropdownMenuItem>
          )}
          {onPauseAssistant && (
            <DropdownMenuItem
              onClick={onPauseAssistant}
              data-testid="agent-profile-overflow-pause-assistant"
            >
              <Pause />
              {pauseAssistantLabel}
            </DropdownMenuItem>
          )}
          {/* In the row's column: Move Left / Move Right where it can move (#189 rule 7). */}
          <ColumnMoveMenuItems />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  return (
    <div
      className="agent-profile-responsive-actions gap-0.5 md:pointer-fine:gap-1"
      data-testid="agent-profile-responsive-actions"
    >
      {messageAction}
      {hasFoldingCommands && inlineActions}
      {hasFoldingCommands || menuAlways ? overflowMenu : null}
    </div>
  );
}
