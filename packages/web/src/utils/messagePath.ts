// A message's in-app path. Its own leaf module (no stores, no router) so pure
// code — Raft Desktop's notification text, link builders — can build the
// exact path the app navigates to; useAppNavigate re-exports it.

export type MessagePermalinkRouteKind = "channel" | "dm";

export interface MessagePermalinkOptions {
  routeKind?: MessagePermalinkRouteKind;
  threadParentMessageId?: string | null;
}

/**
 * `<base>/<channel|dm>/<id>?msg=…[&thread=<id>:<parent>]`: the one form
 * "Copy Link", search and Raft Desktop's notifications open.
 */
export function buildMessagePath(
  base: string,
  channelId: string,
  messageId: string,
  { routeKind = "channel", threadParentMessageId = null }: MessagePermalinkOptions = {}
): string {
  const params = new URLSearchParams({ msg: messageId });
  if (threadParentMessageId) {
    params.set("thread", `${channelId}:${threadParentMessageId}`);
  }
  return `${base}/${routeKind}/${channelId}?${params.toString()}`;
}
