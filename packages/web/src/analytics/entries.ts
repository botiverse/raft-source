// Entry-level events (xxchan, 2026-10-23, #proj-analytics:11ec2a34): which
// entry people use, per area of the screen. Called from the entries' own click
// handlers. No ids, paths or text (registry: CHANNEL_TABS, CONVERSATION_HEADER_ACTIONS, MESSAGE_ACTIONS).
import type { ProductEventProperties } from "@botiverse/raft-shared";
import { trackEvent } from "./track";

type ChannelTab = ProductEventProperties<"channel_tab_selected">;
type MessageAction = ProductEventProperties<"message_action_selected">;
type HeaderAction = ProductEventProperties<"conversation_header_action_selected">;

/**
 * A conversation's Chat / Tasks / Files. `wasActive`: it was already showing (a toggle or close hid it). `compact`:
 * the header was folded, where the entry is the header's (its toggle, or an item in its ⋯).
 */
export function trackChannelTabSelected(tab: ChannelTab["tab"], surface: ChannelTab["surface"], wasActive: boolean, compact?: boolean): void {
  trackEvent("channel_tab_selected", compact === undefined ? { tab, surface, was_active: wasActive } : { tab, surface, was_active: wasActive, compact });
}

/** The conversation header's Search, details (Settings or the name) or ⋯. `compact`: the header was folded (a phone, or buttons in ⋯). */
export function trackConversationHeaderAction(action: HeaderAction["action"], surface: HeaderAction["surface"], conversation: HeaderAction["conversation"], compact: boolean): void {
  trackEvent("conversation_header_action_selected", { action, surface, conversation, compact });
}

/** One action on one message, from one surface. */
export function trackMessageAction(action: MessageAction["action"], surface: MessageAction["surface"], inThread: boolean): void {
  trackEvent("message_action_selected", { action, surface, in_thread: inThread });
}

/** Which surface the message menu was opened from. */
export function messageMenuSurface(menu: { source: "pointer" | "touch"; fromToolbar?: boolean }): MessageAction["surface"] {
  if (menu.fromToolbar) return "toolbar_menu";
  return menu.source === "touch" ? "long_press" : "context_menu";
}
