import { create } from "zustand";
import { useChannelSideCardStore } from "./channelSideCardStore";

/**
 * The context view open beside a conversation (View Context, #wg-ax): what an
 * agent's model saw when it produced one of its messages, opened from that
 * message's ⋯ menu (or a phone's long-press menu). A desktop shows it as a
 * section of the channel's row (ChannelSideArea's "context"); a phone as a
 * page of its own over everything, with Back (AgentContextViewPage).
 *
 * The message is kept as it was when opened (sender, avatar, text, time), so
 * the panel's header and excerpt need no lookup of their own.
 */
export interface OpenAgentContextView {
  agentId: string;
  messageId: string;
  /** The agent's name and avatar as the message showed them. */
  agentName: string;
  agentAvatarUrl: string | null;
  /** The message's text (Markdown source) and when it was sent. */
  content: string;
  createdAt: string;
  /** The conversation the message is in (a thread by its own channel id). */
  conversationId: string;
  /** The channel whose panel it opened beside (a thread's parent channel): another channel there closes it. */
  hostChannelId: string;
}

interface AgentContextViewState {
  open: OpenAgentContextView | null;
  openView: (view: OpenAgentContextView) => void;
  close: () => void;
}

export const useAgentContextViewStore = create<AgentContextViewState>((set) => ({
  open: null,
  openView: (view) => set({ open: view }),
  close: () => set({ open: null }),
}));

/** Open `view` beside its conversation, on top where only one section shows. */
export function openAgentContextView(view: OpenAgentContextView) {
  useChannelSideCardStore.getState().focusCard("context");
  useAgentContextViewStore.getState().openView(view);
}

/** The channel panel shows `channelId`: a context view opened beside another channel closes. */
export function keepAgentContextViewFor(channelId: string) {
  const open = useAgentContextViewStore.getState().open;
  if (open && open.hostChannelId !== channelId) useAgentContextViewStore.getState().close();
}
