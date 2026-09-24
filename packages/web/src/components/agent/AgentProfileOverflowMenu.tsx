import { EllipsisVertical, MessageSquare, Play, RotateCcw, Square } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "raft-ui";
import { useIntl } from "react-intl";
import Button from "../ui/Button";
import Tooltip from "../ui/Tooltip";

interface AgentProfileOverflowMenuProps {
  canMessageAgent: boolean;
  canControlAgentRuntime: boolean;
  isOnline: boolean;
  messageLabel: string;
  onMessage: () => void;
  onStartStop: () => void;
  onRestartReset: () => void;
  /**
   * Keep the high-frequency commands visible while the containing panel has
   * room, and collapse them into the overflow menu as that panel narrows.
   * The default remains the menu-only primitive for existing callers.
   */
  responsive?: boolean;
}

/**
 * Immediate Agent Profile commands belong in the same lightweight command
 * menu as Thread topbar actions. Structural navigation (Back / Close) stays
 * outside the menu, while unavailable commands are omitted instead of shown
 * disabled.
 */
export default function AgentProfileOverflowMenu({
  canMessageAgent,
  canControlAgentRuntime,
  isOnline,
  messageLabel,
  onMessage,
  onStartStop,
  onRestartReset,
  responsive = false,
}: AgentProfileOverflowMenuProps) {
  const { formatMessage } = useIntl();
  const menuLabel = formatMessage({ id: "agent.detail.moreActions" });
  const startStopLabel = formatMessage({
    id: isOnline ? "agent.detail.stopAgent" : "agent.detail.startAgent",
  });
  const restartResetLabel = formatMessage({ id: "agent.detail.restartReset" });

  if (!canMessageAgent && !canControlAgentRuntime) return null;

  // The profile action strip sits flush against the top edge of its panel.
  // RUI's tooltip defaults to `side="top"`; at this edge collision shifting
  // can keep the popup inside the viewport by moving it back over the
  // trigger. Use the documented panel-header direction so the label always
  // clears the action button instead of occluding it.
  const profileTooltipContentProps = { side: "bottom" as const, className: "bg-white" };

  const inlineActions = (
    <div
      className="agent-profile-inline-actions hidden items-center gap-1.5"
      data-testid="agent-profile-inline-actions"
    >
      {canMessageAgent && (
        <Tooltip content={messageLabel} contentProps={profileTooltipContentProps}>
          <Button
            shape="icon"
            aria-label={messageLabel}
            onClick={onMessage}
            data-testid="agent-profile-inline-message"
          >
            <MessageSquare size={14} />
          </Button>
        </Tooltip>
      )}
      {canControlAgentRuntime && (
        <>
          <Tooltip content={startStopLabel} contentProps={profileTooltipContentProps}>
            <Button
              shape="icon"
              aria-label={startStopLabel}
              onClick={onStartStop}
              data-testid="agent-profile-inline-start-stop"
            >
              {isOnline ? <Square size={14} /> : <Play size={14} />}
            </Button>
          </Tooltip>
          <Tooltip content={restartResetLabel} contentProps={profileTooltipContentProps}>
            <Button
              shape="icon"
              aria-label={restartResetLabel}
              onClick={onRestartReset}
              data-testid="agent-profile-inline-restart-reset"
            >
              <RotateCcw size={14} />
            </Button>
          </Tooltip>
        </>
      )}
    </div>
  );

  const overflowMenu = (
    <div className={responsive ? "agent-profile-overflow-actions" : undefined}>
      <DropdownMenu>
        <Tooltip content={menuLabel} contentProps={profileTooltipContentProps}>
          <DropdownMenuTrigger
            render={(
              <Button
                shape="icon"
                aria-label={menuLabel}
                data-testid="agent-profile-overflow-trigger"
              >
                <EllipsisVertical size={14} />
              </Button>
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
          {canMessageAgent && (
            <DropdownMenuItem
              onClick={onMessage}
              data-testid="agent-profile-overflow-message"
            >
              <MessageSquare />
              {messageLabel}
            </DropdownMenuItem>
          )}
          {canControlAgentRuntime && (
            <DropdownMenuItem
              onClick={onStartStop}
              data-testid="agent-profile-overflow-start-stop"
            >
              {isOnline ? <Square /> : <Play />}
              {formatMessage({
                id: isOnline ? "agent.detail.stopAgent" : "agent.detail.startAgent",
              })}
            </DropdownMenuItem>
          )}
          {canControlAgentRuntime && (
            <DropdownMenuItem
              onClick={onRestartReset}
              data-testid="agent-profile-overflow-restart-reset"
            >
              <RotateCcw />
              {formatMessage({ id: "agent.detail.restartReset" })}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  if (responsive) {
    return (
      <div className="agent-profile-responsive-actions" data-testid="agent-profile-responsive-actions">
        {inlineActions}
        {overflowMenu}
      </div>
    );
  }

  return overflowMenu;
}
