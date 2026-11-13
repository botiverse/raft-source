import { useMemo } from "react";

import type { ArtifactCardPlace, ArtifactSideCard } from "../../apps/artifacts";
import { PanelHeadLeadContext } from "../../components/layout/appPanelHead";
import { browserChipWidth } from "./browserHeadFit";
import { useBrowserTabsStore } from "./browserTabsStore";
import { BrowserSwitchChip } from "./SwitchChip";
import { useDesktopBrowserTabs } from "./useWebPreview";
import { useWebPreviewSideCard } from "./useWebPreviewSideCard";
import { useWebPreviewStore } from "./webPreviewStore";

/**
 * What the Artifact's place beside `channelId` shows: a page opened beside the
 * conversation takes it, and of the two, the one opened last shows; closing it
 * gives the other back. `closeWebPreview` is set while the web preview is the
 * one shown (a phone's header Back closes it first), else null.
 *
 * With Raft Desktop's built-in browser (desktop_web_preview_view_v0, a shell
 * with tabs) the place is the side window of "Browser + Artifact": the
 * browser or the Artifact in front, the other open behind it, and the one in
 * front leads its first row with the switch chip (SwitchChip) that brings the
 * other forward. Opening either brings it to the front and parks the other;
 * closing the one in front shows the one behind. The browser's chip reaches
 * the Artifact's head through PanelHeadLeadContext. Without that browser the
 * Artifact's card is returned as it came: its head has no chip and nothing
 * here touches it.
 */
export function useArtifactPlaceCard(
  channelId: string | null | undefined,
  artifactCard: ArtifactSideCard | null,
): { card: ArtifactSideCard | null; closeWebPreview: (() => void) | null } {
  const webPreviewCard = useWebPreviewSideCard(channelId, artifactCard !== null);
  const closePage = useWebPreviewStore((s) => s.close);
  const tabs = useDesktopBrowserTabs();
  const conversationId = tabs && channelId ? channelId : null;
  // How many tabs the conversation's browser holds (0: none open): the chip's room in the Artifact's head.
  const browserTabs = useBrowserTabsStore((s) => (conversationId ? s.browsers[conversationId]?.tabs.length ?? 0 : 0));
  const closeBrowser = useBrowserTabsStore((s) => s.close);
  // When the switch chip last let the Artifact in front of the browser (0: never, or no browser).
  const parkedAt = useBrowserTabsStore((s) => (conversationId ? s.browsers[conversationId]?.parkedAt ?? 0 : 0));
  // Of the two, the one that came to the front last: opened, or brought forward by the other's chip.
  const shown = webPreviewCard !== null && (artifactCard === null || webPreviewCard.openedAt >= Math.max(artifactCard.openedAt, parkedAt));
  const chipWidth = browserTabs > 0 ? browserChipWidth(browserTabs) : 0;
  // The Artifact in front of the browser: the same card, its head led by the browser's chip.
  const lead = useMemo(
    () => (conversationId && chipWidth > 0 ? { node: <BrowserSwitchChip conversationId={conversationId} />, width: chipWidth } : null),
    [chipWidth, conversationId],
  );
  const artifactOverBrowser = useMemo<ArtifactSideCard | null>(() => {
    if (!artifactCard || !lead) return null;
    return {
      ...artifactCard,
      render: (place: ArtifactCardPlace) => <PanelHeadLeadContext.Provider value={lead}>{artifactCard.render(place)}</PanelHeadLeadContext.Provider>,
    };
  }, [artifactCard, lead]);
  const closeWebPreview = useMemo(() => {
    if (!shown) return null;
    return conversationId && browserTabs > 0 ? () => closeBrowser(conversationId) : closePage;
  }, [browserTabs, closeBrowser, closePage, conversationId, shown]);
  return { card: shown ? webPreviewCard : artifactOverBrowser ?? artifactCard, closeWebPreview };
}
