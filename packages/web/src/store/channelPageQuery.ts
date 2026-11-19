/**
 * The query of a channel's message pages (docs/frontend/boot-requests.md).
 * Every page the web reads asks for its thread summaries' reply previews cut
 * to 200 characters (#14921: a cut preview is flagged `truncated`; a server
 * without the param ignores it). The boot script (bootInlineScript.ts), the
 * click's prefetch (messagePagePrefetch.ts) and loadMessages send the latest
 * page's exact URL, so the boot answer is taken. No imports: the Vite config
 * loads the boot script's module.
 */
export const THREAD_PREVIEW_PARAM = "threadPreviewChars=200";

/** The latest page's size. */
export const LATEST_PAGE_LIMIT = 50;

/** The latest page's query, as the boot script sends it. */
export const LATEST_PAGE_QUERY = `?limit=${LATEST_PAGE_LIMIT}&${THREAD_PREVIEW_PARAM}`;

/** The latest page's path. */
export function latestPagePath(channelId: string): string {
  return `/messages/channel/${channelId}${LATEST_PAGE_QUERY}`;
}

/** An older page's path: `limit` messages before `beforeSeq`. */
export function olderPagePath(channelId: string, limit: number, beforeSeq: number): string {
  return `/messages/channel/${channelId}?limit=${limit}&before=${beforeSeq}&${THREAD_PREVIEW_PARAM}`;
}
