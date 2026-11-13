import { useCallback, useMemo, useRef } from "react";
import type { DragEvent } from "react";
import { PreviewCard, PreviewCardContent, PreviewCardTrigger } from "@botiverse/raft-ui";
import { useAgentDisplayState } from "../../../store/agentStore";
import type { Agent } from "../../../store/agentStore";
import { useProfileStore } from "../../../store/profileStore";
import { openConversationAgentActivity } from "../../../utils/profilePanelUrl";
import AgentActivityDot from "../../agent/AgentActivityDot";
import ProfilePreviewCardContent from "../../message/DeferredProfilePreviewCardContent";
import AvatarSlot from "../../ui/AvatarSlot";

/** The drag payload type for an agent slot (one agent at a time). */
export const AGENT_SLOT_DRAG_TYPE = "application/x-raft-agent-id";

/**
 * One agent on a computer row: its avatar with the activity light on the
 * corner (the sidebar's AgentActivityDot). It behaves like a message-list
 * avatar: hovering shows the same profile preview card with the same delays,
 * and clicking (or tapping on a phone) opens the agent's profile. Draggable
 * onto another computer's row when the viewer may move it (`draggable`).
 */
export function AgentRackSlot({
  agent,
  draggable,
  dimmed = false,
  onDragStart,
  onDragEnd,
}: {
  agent: Agent;
  draggable: boolean;
  /** The agent's computer is offline: the slot reads as away. */
  dimmed?: boolean;
  onDragStart?: (agent: Agent) => void;
  onDragEnd?: () => void;
}) {
  const previewActionsRef = useRef<{ close: () => void; unmount: () => void } | null>(null);
  const displayState = useAgentDisplayState(agent.id, agent);
  const name = agent.displayName || agent.name;
  // Close the card before moving anywhere, or it stays over the destination.
  const openProfile = useCallback(() => {
    previewActionsRef.current?.close();
    useProfileStore.getState().openProfile("agent", agent.id);
  }, [agent.id]);
  const openActivity = useCallback((agentId: string) => {
    previewActionsRef.current?.close();
    openConversationAgentActivity(useProfileStore.getState().openProfile, agentId);
  }, []);
  const handleDragStart = useCallback((event: DragEvent<HTMLButtonElement>) => {
    event.dataTransfer.setData(AGENT_SLOT_DRAG_TYPE, agent.id);
    event.dataTransfer.effectAllowed = "move";
    previewActionsRef.current?.close();
    onDragStart?.(agent);
  }, [agent, onDragStart]);
  const dragProps = useMemo(() => (draggable
    ? { draggable: true, onDragStart: handleDragStart, onDragEnd }
    : {}), [draggable, handleDragStart, onDragEnd]);

  return (
    <PreviewCard actionsRef={previewActionsRef}>
      <PreviewCardTrigger
        delay={200}
        closeDelay={120}
        render={(
          <button
            type="button"
            aria-label={name}
            onClick={openProfile}
            data-testid={`rack-slot-${agent.id}`}
            data-agent-activity={displayState.activity}
            className={`relative z-raised shrink-0 rounded-control outline-none transition-[filter] duration-75 hover:brightness-90 focus-visible:shadow-focus ${draggable ? "cursor-grab active:cursor-grabbing" : ""} ${dimmed ? "opacity-dimmed grayscale" : ""}`}
            {...dragProps}
          />
        )}
      >
        <AvatarSlot
          context="compact-row"
          type="agent"
          agentAvatarUrl={agent.avatarUrl}
          badge={<AgentActivityDot agentId={agent.id} size="sm" />}
        />
      </PreviewCardTrigger>
      <PreviewCardContent sideOffset={6} collisionPadding={6}>
        <ProfilePreviewCardContent
          mentionType="agent"
          mentionId={agent.id}
          fallbackAgent={agent}
          onOpenAgentActivity={openActivity}
        />
      </PreviewCardContent>
    </PreviewCard>
  );
}
