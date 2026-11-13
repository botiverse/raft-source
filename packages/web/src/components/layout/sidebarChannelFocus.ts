export const SIDEBAR_CHANNEL_FOCUS_STATE_KEY = "sidebarChannelFocus";
export const SIDEBAR_DISCLOSURE_RESTORE_STATE_KEY = "sidebarDisclosureRestore";

export type SidebarConversationKind = "channel" | "dm";

export interface SidebarChannelFocusRequest {
  kind: SidebarConversationKind;
  id: string;
  /**
   * `center`: an explicit one-shot request (e.g. search "Open") — always scroll
   * so the row sits mid-viewport. `nearest`: the route changed to this
   * conversation (⌘K, deep link, mention, notification…) — bring the
   * row into view only if it is not already fully visible.
   */
  align: "center" | "nearest";
}

export function buildSidebarChannelFocusState(
  channelId: string,
  kind: SidebarConversationKind = "channel",
): Record<typeof SIDEBAR_CHANNEL_FOCUS_STATE_KEY, SidebarChannelFocusRequest> {
  return {
    [SIDEBAR_CHANNEL_FOCUS_STATE_KEY]: {
      kind,
      id: channelId,
      align: "center",
    },
  };
}

/** `/s/<slug>/channel/<id>` | `/s/<slug>/dm/<id>` → the conversation the route shows. */
export function conversationFromPathname(pathname: string): { kind: SidebarConversationKind; id: string } | null {
  const match = pathname.match(/\/(channel|dm)\/([^/?#]+)/);
  if (!match) return null;
  return { kind: match[1] as SidebarConversationKind, id: decodeURIComponent(match[2]) };
}

/**
 * The reveal that a ROUTE CHANGE itself implies (task #125): when the active
 * conversation differs from the one shown before, bring its row into view
 * ("nearest"). Same conversation (thread/message navigation inside it), a
 * non-conversation route, or no previous route (first render) → nothing: the
 * first render is not a navigation and must not override a remembered
 * collapsed section or jump the list.
 */
export function implicitSidebarFocusRequest(
  previousPathname: string | null,
  nextPathname: string,
): SidebarChannelFocusRequest | null {
  if (previousPathname === null) return null;
  const next = conversationFromPathname(nextPathname);
  if (!next) return null;
  const previous = conversationFromPathname(previousPathname);
  if (previous && previous.kind === next.kind && previous.id === next.id) return null;
  return { kind: next.kind, id: next.id, align: "nearest" };
}

export function buildSidebarDisclosureRestoreState(): Record<
  typeof SIDEBAR_DISCLOSURE_RESTORE_STATE_KEY,
  true
> {
  return { [SIDEBAR_DISCLOSURE_RESTORE_STATE_KEY]: true };
}

export function isSidebarDisclosureRestoreState(state: unknown): boolean {
  return Boolean(
    state
    && typeof state === "object"
    && (state as Record<string, unknown>)[SIDEBAR_DISCLOSURE_RESTORE_STATE_KEY] === true,
  );
}

export function readSidebarChannelFocusRequest(
  state: unknown,
): SidebarChannelFocusRequest | null {
  if (!state || typeof state !== "object") return null;
  const request = (state as Record<string, unknown>)[SIDEBAR_CHANNEL_FOCUS_STATE_KEY];
  if (!request || typeof request !== "object") return null;
  const candidate = request as Record<string, unknown>;
  if (
    (candidate.kind !== "channel" && candidate.kind !== "dm")
    || typeof candidate.id !== "string"
    || candidate.id.length === 0
    || (candidate.align !== "center" && candidate.align !== "nearest")
  ) {
    return null;
  }
  return {
    kind: candidate.kind,
    id: candidate.id,
    align: candidate.align,
  };
}

/**
 * Scroll position that brings the row into view with the least movement, or
 * null when the row is already fully inside the viewport (no scroll at all —
 * a user who clicked a visible row must not see the list move).
 */
export function nearestSidebarScrollTop({
  currentScrollTop,
  itemHeight,
  itemTop,
  viewportHeight,
  viewportTop,
}: {
  currentScrollTop: number;
  itemHeight: number;
  itemTop: number;
  viewportHeight: number;
  viewportTop: number;
}): number | null {
  const itemBottom = itemTop + itemHeight;
  const viewportBottom = viewportTop + viewportHeight;
  if (itemTop >= viewportTop && itemBottom <= viewportBottom) return null;
  const itemTopInContent = currentScrollTop + itemTop - viewportTop;
  if (itemTop < viewportTop) return Math.max(0, itemTopInContent);
  return Math.max(0, itemTopInContent - (viewportHeight - itemHeight));
}

export function centeredSidebarScrollTop({
  currentScrollTop,
  itemHeight,
  itemTop,
  viewportHeight,
  viewportTop,
}: {
  currentScrollTop: number;
  itemHeight: number;
  itemTop: number;
  viewportHeight: number;
  viewportTop: number;
}): number {
  const itemTopInContent = currentScrollTop + itemTop - viewportTop;
  return Math.max(0, itemTopInContent - ((viewportHeight - itemHeight) / 2));
}
