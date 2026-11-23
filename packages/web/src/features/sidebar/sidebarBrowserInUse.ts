import type { DesktopWebPreviewMediaKind } from "@botiverse/raft-shared";
import type { BrowserInUse } from "../webPreview/browserInUseStore";
import type { SidebarDndDisplayItem } from "./sidebarDisplayItems";

/**
 * The sidebar's browser mark (SidebarBrowserInUseMark) from what the built-in
 * browser's kept pages of each conversation do (browserInUseStore): a row's
 * own, and a folded section head's for its rows together. Never for the
 * conversation on screen (`current`, the route's): its pages show beside it.
 */

const MEDIA_KINDS: readonly DesktopWebPreviewMediaKind[] = ["microphone", "camera"];

/** The conversation a row opens, whose browser it is: an agent's row its DM's, once there is one. */
export function sidebarItemConversationId(item: SidebarDndDisplayItem, agentDmChannelId: Readonly<Record<string, string>>): string | null {
  switch (item.type) {
    case "channel": return item.channel.id;
    case "dm": return item.dm.id;
    case "agent": return agentDmChannelId[item.agent.id] ?? null;
    case "lounge": return item.lounge.channelId;
  }
}

/**
 * The conversations the sidebar has a row for (`projection`: each section's drag ids, a folded section's too, whose
 * head shows the mark): the ones whose pages with a device the shell may keep (`list.setMarkable`). Each once.
 */
export function sidebarMarkableConversationIds(
  projection: Readonly<Record<string, readonly string[]>>,
  items: ReadonlyMap<string, SidebarDndDisplayItem>,
  agentDmChannelId: Readonly<Record<string, string>>,
): string[] {
  const ids = new Set<string>();
  for (const itemIds of Object.values(projection)) {
    for (const itemId of itemIds) {
      const item = items.get(itemId);
      const id = item ? sidebarItemConversationId(item, agentDmChannelId) : null;
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

/** A row's mark: what its conversation's kept pages do (the same object while that does not change); null: none. */
export function sidebarRowBrowserInUse(byOwner: Readonly<Record<string, BrowserInUse>>, conversationId: string | null | undefined, current: string | null): BrowserInUse | null {
  if (!conversationId || conversationId === current) return null;
  return byOwner[conversationId] ?? null;
}

/**
 * A folded section head's mark: its rows' together. A device any of them uses (the red light wins on the mark),
 * else sound heard from any, else a muted page; null where none of them has a mark.
 */
export function sidebarSectionBrowserInUse(byOwner: Readonly<Record<string, BrowserInUse>>, conversationIds: Iterable<string | null | undefined>, current: string | null): BrowserInUse | null {
  const media = new Set<DesktopWebPreviewMediaKind>();
  let audible = false;
  let muted = false;
  let marked = false;
  for (const id of conversationIds) {
    const use = sidebarRowBrowserInUse(byOwner, id, current);
    if (!use) continue;
    marked = true;
    for (const kind of use.media) media.add(kind);
    audible ||= use.audible;
    muted ||= use.muted;
  }
  if (!marked) return null;
  return { media: MEDIA_KINDS.filter((kind) => media.has(kind)), audible, muted: muted && !audible };
}
