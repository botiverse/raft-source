export const SIDEBAR_CHANNEL_FOCUS_STATE_KEY = "sidebarChannelFocus";
export const SIDEBAR_DISCLOSURE_RESTORE_STATE_KEY = "sidebarDisclosureRestore";

export interface SidebarChannelFocusRequest {
  kind: "channel";
  id: string;
  align: "center";
}

export function buildSidebarChannelFocusState(
  channelId: string,
): Record<typeof SIDEBAR_CHANNEL_FOCUS_STATE_KEY, SidebarChannelFocusRequest> {
  return {
    [SIDEBAR_CHANNEL_FOCUS_STATE_KEY]: {
      kind: "channel",
      id: channelId,
      align: "center",
    },
  };
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
    candidate.kind !== "channel"
    || typeof candidate.id !== "string"
    || candidate.id.length === 0
    || candidate.align !== "center"
  ) {
    return null;
  }
  return {
    kind: "channel",
    id: candidate.id,
    align: "center",
  };
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
