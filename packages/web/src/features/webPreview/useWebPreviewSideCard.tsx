import { useEffect, useMemo } from "react";
import { useIntl } from "react-intl";
import { Globe } from "lucide-react";

import type { ArtifactCardPlace, ArtifactSideCard } from "../../apps/artifacts";
import { BrowserPanel } from "./BrowserPanel";
import { useBrowserTabsStore } from "./browserTabsStore";
import { attachBrowserViews } from "./browserViews";
import { useDesktopBrowserTabs } from "./useWebPreview";
import { WebPreviewPanel } from "./WebPreviewPanel";
import { useWebPreviewStore, WEB_PREVIEW_MIN_WIDTH, webPreviewUrl } from "./webPreviewStore";

/**
 * The page open beside `channelId`, as a card for the channel's side area in
 * the Artifact's shape (ArtifactSideCard): ChatPanel shows whichever of the
 * two was opened last in the Artifact's place, so it lays out, stacks,
 * expands in the row, keeps the column's width and covers the chat on a phone
 * the same way. Null where no page is open beside this conversation.
 *
 * In Raft Desktop on a shell with tabs (desktop_web_preview_view_v0) the card
 * is the conversation's built-in browser (BrowserPanel, browserTabsStore),
 * and `openedAt` is when it last came to the front. While this hook is
 * mounted for the conversation (its channel panel is on screen) the browser's
 * native views may exist (browserViews); they go when it unmounts.
 * `artifactBehind`: the conversation's Artifact is open too, so the browser's
 * tab row leads with the switch chip.
 */
export function useWebPreviewSideCard(channelId: string | null | undefined, artifactBehind = false): ArtifactSideCard | null {
  const { formatMessage } = useIntl();
  const page = useWebPreviewStore((s) => (channelId && s.page?.conversationId === channelId ? s.page : null));
  const openedAt = useWebPreviewStore((s) => s.openedAt);
  const tabs = useDesktopBrowserTabs();
  const conversationId = tabs && channelId ? channelId : null;
  useEffect(() => {
    if (!tabs || !conversationId) return;
    return attachBrowserViews(tabs, conversationId);
  }, [tabs, conversationId]);
  // Only whether there is one and when it came to the front: a tab's title or loading state never renders the channel again.
  const browserFrontAt = useBrowserTabsStore((s) => (conversationId ? s.browsers[conversationId]?.frontAt ?? null : null));
  return useMemo(() => {
    const splitLabel = formatMessage({ id: "webPreview.resize" });
    if (tabs && conversationId && browserFrontAt !== null) {
      return {
        label: formatMessage({ id: "webPreview.browser" }),
        icon: <Globe />,
        openedAt: browserFrontAt,
        minWidth: WEB_PREVIEW_MIN_WIDTH,
        splitLabel,
        expanded: false,
        render: (place: ArtifactCardPlace) => (
          <BrowserPanel bridge={tabs} conversationId={conversationId} covering={place.mode === "overlay"} artifactBehind={artifactBehind} />
        ),
      };
    }
    if (!page) return null;
    return {
      label: webPreviewUrl(page.url)?.host ?? page.url,
      icon: <Globe />,
      openedAt,
      minWidth: WEB_PREVIEW_MIN_WIDTH,
      splitLabel,
      expanded: false,
      render: (place: ArtifactCardPlace) => <WebPreviewPanel key={page.url} page={page} covering={place.mode === "overlay"} />,
    };
  }, [artifactBehind, browserFrontAt, conversationId, formatMessage, openedAt, page, tabs]);
}
