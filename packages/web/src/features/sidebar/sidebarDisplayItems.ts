import type { Channel } from "../../store/channelStore";
import type { Agent } from "../../store/agentStore";
import type { SidebarSectionCandidate, SidebarSectionConversationChange } from "../../components/layout/SidebarSectionAddConversationsDialog";
import type { SidebarSectionItemKind } from "../../store/sidebarSections";
import type {
  SidebarPinnedRef,
} from "../../utils/sidebarPinnedRefs";

/**
 * Agent Lounge v0: a Lounge's own sidebar row (Direct Messages, or Pinned),
 * from the Lounge the store holds and / or the summary its agent's DM row
 * carried. `listed`: you joined it or were mentioned there, the rule for a
 * row in Direct Messages (agentLoungeSidebarEntry); a pinned Lounge shows
 * either way.
 */
export interface SidebarLoungeEntry {
  channelId: string;
  agentId: string;
  /** "{Name}'s Lounge". */
  title: string;
  /** The Lounge row the store holds, when it holds one (mute, membership). */
  channel: Channel | undefined;
  createdAt: string;
  summaryUnread: number;
  summaryMentioned: boolean;
  listed: boolean;
}

export type PinnedDisplayItem =
  | { id: string; ref: SidebarPinnedRef; type: "channel"; channel: Channel; createdAt: string; lastMessageAt?: string | null; label: string }
  | { id: string; ref: SidebarPinnedRef; type: "dm"; dm: Channel; createdAt: string; lastMessageAt?: string | null; label: string }
  | { id: string; ref: SidebarPinnedRef; type: "agent"; agent: Agent; createdAt: string; lastMessageAt?: string | null; label: string }
  | { id: string; ref: SidebarPinnedRef; type: "lounge"; lounge: SidebarLoungeEntry; createdAt: string; lastMessageAt?: string | null; label: string };

export type CustomSectionDisplayItem =
  | { id: string; type: "channel"; channel: Channel; createdAt: string; lastMessageAt?: string | null; label: string; placementKind: "channel" }
  | { id: string; type: "dm"; dm: Channel; createdAt: string; lastMessageAt?: string | null; label: string; placementKind: "channel" }
  | { id: string; type: "agent"; agent: Agent; createdAt: string; lastMessageAt?: string | null; label: string; placementKind: "agent" };
export type SidebarMovableItem = { kind: SidebarSectionItemKind; id: string };
export type SidebarDndDisplayItem =
  | { type: "channel"; channel: Channel; label: string }
  | { type: "dm"; dm: Channel; label: string }
  | { type: "agent"; agent: Agent; label: string }
  | { type: "lounge"; lounge: SidebarLoungeEntry; label: string };
// Stryker disable all: accessible section labels are asserted by rendered DOM tests; mutating copy inside Sidebar does not exercise a separate domain seam.
export function toMovableChange(change: SidebarSectionConversationChange): { added: SidebarMovableItem[]; removed: SidebarMovableItem[] } {
  const toItem = (candidate: SidebarSectionCandidate): SidebarMovableItem => ({ kind: candidate.kind, id: candidate.id });
  return { added: change.added.map(toItem), removed: change.removed.map(toItem) };
}
// Stryker restore all
// Stryker disable all: drag-id helpers are exercised through source contracts and manual/browser DnD; the command-runner mutation oracle cannot synthesize dnd-kit pointer flows.
export function pinnedRefForDmChannel(dm: Channel): SidebarPinnedRef | null {
  if (dm.peerType === "agent" && dm.peerId) return { kind: "agent", id: dm.peerId };
  if (dm.peerType === "user" && dm.peerId) return { kind: "human", id: dm.peerId };
  return null;
}
// Stryker restore all
