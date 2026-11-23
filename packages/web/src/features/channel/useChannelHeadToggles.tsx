import { useCallback, useMemo } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { ListTodo, Paperclip, Phone } from "lucide-react";

import { AgentLoungeIcon } from "../../components/agent/agentLounge";
import type { ColumnMenuItem } from "../../components/layout/ColumnOverflowMenu";
import { shownOwnActions, useHeadWidth } from "../../components/layout/headFit";
import { useRowExpand, useRowPlanned } from "../../components/layout/rowPlanStore";
import ChannelFilesToggle from "../../components/task/ChannelFilesToggle";
import ChannelTasksToggle from "../../components/task/ChannelTasksToggle";
import { OverflowMenuTrigger } from "../../components/ui/OverflowSheet";
import { trackConversationHeaderAction } from "../../analytics/entries";
import { useAgentVoiceCallAction } from "../agent/agentVoiceCallEntry";
import type { CallableAgent } from "../agent/agentVoiceCallEntry";

/** Where Tasks or Files was toggled from: the header's own button, or its item in the ⋯ (channel_tab_selected). */
export type HeadToggleSurface = "side_card_toggle" | "more_menu";

interface HeadToggles {
  nodes: ReactNode[];
  items: ColumnMenuItem[];
}

/**
 * The conversation head's own buttons between Search and Settings (an agent DM's Call and Lounge, Tasks, Files), each also
 * as a ⋯ item, and how many of Search, those and Settings fold into ⋯ so the head always fits (#189 rule 6): the
 * last first; ⋯ and Expand never fold. `compact`: the head is folded, a phone's width or some of its buttons in ⋯
 * (conversation_header_action_selected, and channel_tab_selected through `onToggleTasks` / `onToggleFiles`).
 */
export function useChannelHeadToggles({ cards, tasksOpen, filesOpen, onToggleTasks, onToggleFiles, onOpenLounge, callAgent, lounge, icon, phone }: {
  cards: boolean;
  tasksOpen: boolean;
  filesOpen: boolean;
  onToggleTasks: (surface: HeadToggleSurface, compact: boolean) => void;
  onToggleFiles: (surface: HeadToggleSurface, compact: boolean) => void;
  onOpenLounge: () => void;
  /** An agent DM's agent: its Call button, first, where the viewer may call it (agentVoiceCallEntry). */
  callAgent?: CallableAgent | null;
  /** The head has the Lounge button (an agent DM's), and an icon before its title (a channel's). */
  lounge: boolean;
  icon: boolean;
  phone: boolean;
}) {
  const { formatMessage } = useIntl();
  const tasksLabel = formatMessage({ id: tasksOpen ? "task.sidePanel.close" : "task.sidePanel.open" });
  const filesLabel = formatMessage({ id: filesOpen ? "message.chatPanel.filesCard.close" : "message.chatPanel.filesCard.open" });
  const loungeLabel = formatMessage({ id: "agent.lounge.label" });
  const onCall = useAgentVoiceCallAction(callAgent);
  const planned = useRowPlanned();
  const [measure, width] = useHeadWidth();
  const containerProps = useMemo(() => ({ ref: measure }), [measure]);
  const expand = useRowExpand("conversation");
  // How many of the head's own buttons fold: Search, Call, Lounge, Tasks and Files where it has them, Settings.
  const own = 2 + (onCall ? 1 : 0) + (lounge ? 1 : 0) + (cards ? 2 : 0);
  const fold = planned && width > 0
    ? own - shownOwnActions({ width, lead: icon ? 1 : 0, own: Array.from({ length: own }, () => 32), controls: expand.shown ? 1 : 0, menuItems: 0 })
    : 0;
  const compact = phone || fold > 0;
  const toggleTasks = useCallback(() => onToggleTasks("side_card_toggle", compact), [compact, onToggleTasks]);
  const toggleFiles = useCallback(() => onToggleFiles("side_card_toggle", compact), [compact, onToggleFiles]);
  const menuTasks = useCallback(() => onToggleTasks("more_menu", compact), [compact, onToggleTasks]);
  const menuFiles = useCallback(() => onToggleFiles("more_menu", compact), [compact, onToggleFiles]);
  // An agent DM's Lounge and Call (conversation_header_action_selected open_lounge / start_call).
  const openLounge = useCallback(() => {
    trackConversationHeaderAction("open_lounge", "header", "dm", compact);
    onOpenLounge();
  }, [compact, onOpenLounge]);
  const menuLounge = useCallback(() => {
    trackConversationHeaderAction("open_lounge", "more_menu", "dm", compact);
    onOpenLounge();
  }, [compact, onOpenLounge]);
  const callFromHead = useCallback(() => {
    trackConversationHeaderAction("start_call", "header", "dm", compact);
    onCall?.();
  }, [compact, onCall]);
  const callFromMenu = useCallback(() => {
    trackConversationHeaderAction("start_call", "more_menu", "dm", compact);
    onCall?.();
  }, [compact, onCall]);
  const cardToggles = useMemo<HeadToggles>(() => (cards ? {
    nodes: [<ChannelTasksToggle key="tasks" open={tasksOpen} onToggle={toggleTasks} />, <ChannelFilesToggle key="files" open={filesOpen} onToggle={toggleFiles} />],
    items: [
      { id: "tasks", label: tasksLabel, icon: <ListTodo />, onSelect: menuTasks, testId: "channel-header-overflow-tasks" },
      { id: "files", label: filesLabel, icon: <Paperclip />, onSelect: menuFiles, testId: "channel-header-overflow-files" },
    ],
  } : { nodes: [], items: [] }), [cards, filesLabel, filesOpen, menuFiles, menuTasks, tasksLabel, tasksOpen, toggleFiles, toggleTasks]);
  const loungeToggles = useMemo<HeadToggles>(() => ({
    nodes: [<OverflowMenuTrigger key="lounge" labelId="agent.lounge.label" onClick={openLounge} icon={<AgentLoungeIcon size={22} />} testId="agent-dm-open-lounge" />, ...cardToggles.nodes],
    items: [{ id: "lounge", label: loungeLabel, icon: <AgentLoungeIcon />, onSelect: menuLounge, testId: "channel-header-overflow-lounge" }, ...cardToggles.items],
  }), [cardToggles, loungeLabel, menuLounge, openLounge]);
  const callLabel = formatMessage({ id: "agent.voice.call.action" });
  const withCall = useMemo(() => {
    if (!onCall) return null;
    const node = <OverflowMenuTrigger key="call" labelId="agent.voice.call.action" onClick={callFromHead} icon={<Phone />} testId="agent-dm-call" />;
    const item: ColumnMenuItem = { id: "call", label: callLabel, icon: <Phone />, onSelect: callFromMenu, testId: "channel-header-overflow-call" };
    const add = (toggles: HeadToggles): HeadToggles => ({ nodes: [node, ...toggles.nodes], items: [item, ...toggles.items] });
    return { lounge: add(loungeToggles), cards: add(cardToggles) };
  }, [callFromHead, callFromMenu, callLabel, cardToggles, loungeToggles, onCall]);
  // The head's toggles, with the Lounge's where it has one (`own` counts them).
  const toggles = withCall ? (lounge ? withCall.lounge : withCall.cards) : lounge ? loungeToggles : cardToggles;
  return { cardToggles, containerProps, toggles, fold, compact };
}
