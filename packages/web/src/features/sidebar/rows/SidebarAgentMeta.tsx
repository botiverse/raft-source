import { SidebarItemMeta } from "@botiverse/raft-ui";
import { useIntl } from "react-intl";
import { useAgentCurrentActivityState, useAgentStore } from "../../../store/agentStore";
import { formatActivityText } from "../../../utils/activity";
import { getRuntimeDisplayName } from "@botiverse/raft-shared";

const SIDEBAR_AGENT_LIVE_META_CLASS = "min-w-0 truncate font-sans text-footnote font-normal text-foreground-muted group-data-active/sidebar-item:text-sticker-ink";

/**
 * The right side of an agent row (Raft Design System › Sidebar `rf-srow__meta`):
 * its runtime in Space Mono, or — while it works — what it is doing, in
 * Grotesk 13/18 ink-2 (`rf-srow__meta--live`). A leaf beside the avatar's
 * status pixel with the same narrow O(1) subscription (this one agent's
 * current activity), so an activity push re-renders only this span and an
 * unread change never reaches it. External agents keep their runtime label:
 * their presence is time-derived and the raw activity can outlive it.
 * Visual only (`aria-hidden`): the row's accessible name stays the agent's
 * name, and a sentence that changes every few seconds is not announced; the
 * avatar's status pixel already carries the state for assistive tech.
 */
export function SidebarAgentMeta({ agentId, runtime, external = false }: {
  agentId: string;
  runtime: string | null | undefined;
  external?: boolean;
}) {
  const { formatMessage } = useIntl();
  const activityState = useAgentCurrentActivityState(agentId);
  const activity = activityState?.activity;
  // A paused personal assistant (#10654) says so in place of its runtime.
  // Not aria-hidden: the avatar light reads only "offline", this is the word.
  const paused = useAgentStore((s) => Boolean(s.agents.find((a) => a.id === agentId)?.assistantPausedAt));
  // A personal assistant has no runtime chip (DS Terminology): its hosted
  // runtime is the "External agent" placeholder, which its messages never
  // say. It reads as what it is, as its messages' "Personal assistant of …".
  const isAssistant = useAgentStore((s) => Boolean(s.agents.find((a) => a.id === agentId)?.assistantOwnerUserId));
  if (paused) {
    return (
      <SidebarItemMeta className="whitespace-nowrap" data-testid="sidebar-agent-paused">
        {formatMessage({ id: "assistant.paused.chip" })}
      </SidebarItemMeta>
    );
  }
  if (!external && activityState && (activity === "working" || activity === "thinking")) {
    const text = formatActivityText(formatMessage, activityState.activity, activityState.activityDetail, activityState.detailKind);
    return (
      <span className={SIDEBAR_AGENT_LIVE_META_CLASS} data-testid="sidebar-agent-live-meta" title={text} aria-hidden="true">
        {text}
      </span>
    );
  }
  if (isAssistant) {
    return (
      <SidebarItemMeta className="whitespace-nowrap" data-testid="sidebar-agent-assistant" aria-hidden="true">
        {formatMessage({ id: "layout.sidebar.assistantMeta" })}
      </SidebarItemMeta>
    );
  }
  if (!runtime) return null;
  return (
    <SidebarItemMeta className="whitespace-nowrap" data-testid="sidebar-agent-runtime" aria-hidden="true">
      {getRuntimeDisplayName(runtime)}
    </SidebarItemMeta>
  );
}
