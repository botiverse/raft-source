import { useCallback, useMemo } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { ListTodo, Paperclip } from "lucide-react";

import { AgentLoungeIcon } from "../../components/agent/agentLounge";
import type { ColumnMenuItem } from "../../components/layout/ColumnOverflowMenu";
import { shownOwnActions, useHeadWidth } from "../../components/layout/headFit";
import { useRowExpand, useRowPlanned } from "../../components/layout/rowPlanStore";
import ChannelFilesToggle from "../../components/task/ChannelFilesToggle";
import ChannelTasksToggle from "../../components/task/ChannelTasksToggle";
import { OverflowMenuTrigger } from "../../components/ui/OverflowSheet";

interface HeadToggles {
  nodes: ReactNode[];
  items: ColumnMenuItem[];
}

/**
 * The conversation head's own buttons between Search and Settings (an agent DM's Lounge, Tasks, Files), each also
 * as a ⋯ item, and how many of Search, those and Settings fold into ⋯ so the head always fits (#189 rule 6): the
 * last first; ⋯ and Expand never fold.
 */
export function useChannelHeadToggles({ cards, tasksOpen, filesOpen, onToggleTasks, onToggleFiles, onOpenLounge }: {
  cards: boolean;
  tasksOpen: boolean;
  filesOpen: boolean;
  onToggleTasks: () => void;
  onToggleFiles: () => void;
  onOpenLounge: () => void;
}) {
  const { formatMessage } = useIntl();
  const tasksLabel = formatMessage({ id: tasksOpen ? "task.sidePanel.close" : "task.sidePanel.open" });
  const filesLabel = formatMessage({ id: filesOpen ? "message.chatPanel.filesCard.close" : "message.chatPanel.filesCard.open" });
  const loungeLabel = formatMessage({ id: "agent.lounge.label" });
  const cardToggles = useMemo<HeadToggles>(() => (cards ? {
    nodes: [<ChannelTasksToggle key="tasks" open={tasksOpen} onToggle={onToggleTasks} />, <ChannelFilesToggle key="files" open={filesOpen} onToggle={onToggleFiles} />],
    items: [
      { id: "tasks", label: tasksLabel, icon: <ListTodo />, onSelect: onToggleTasks, testId: "channel-header-overflow-tasks" },
      { id: "files", label: filesLabel, icon: <Paperclip />, onSelect: onToggleFiles, testId: "channel-header-overflow-files" },
    ],
  } : { nodes: [], items: [] }), [cards, filesLabel, filesOpen, onToggleFiles, onToggleTasks, tasksLabel, tasksOpen]);
  const loungeToggles = useMemo<HeadToggles>(() => ({
    nodes: [<OverflowMenuTrigger key="lounge" labelId="agent.lounge.label" onClick={onOpenLounge} icon={<AgentLoungeIcon size={22} />} testId="agent-dm-open-lounge" />, ...cardToggles.nodes],
    items: [{ id: "lounge", label: loungeLabel, icon: <AgentLoungeIcon />, onSelect: onOpenLounge, testId: "channel-header-overflow-lounge" }, ...cardToggles.items],
  }), [cardToggles, onOpenLounge, loungeLabel]);
  const planned = useRowPlanned();
  const [measure, width] = useHeadWidth();
  const containerProps = useMemo(() => ({ ref: measure }), [measure]);
  const expand = useRowExpand("conversation");
  /**
   * The head's toggles (with the Lounge's where it has one) and how many of its own buttons fold; `lead`: a button
   * before Search (Show announcement), counted here and folded first (ChannelOverflowMenu).
   */
  const fit = useCallback((lounge: boolean, icon: boolean, lead = false) => {
    const toggles = lounge ? loungeToggles : cardToggles;
    const own = 2 + toggles.nodes.length + (lead ? 1 : 0);
    const fold = planned && width > 0
      ? own - shownOwnActions({ width, lead: icon ? 1 : 0, own: Array.from({ length: own }, () => 32), controls: expand.shown ? 1 : 0, menuItems: 0 })
      : 0;
    return { toggles, fold };
  }, [cardToggles, expand.shown, loungeToggles, planned, width]);
  return { cardToggles, containerProps, fit };
}
