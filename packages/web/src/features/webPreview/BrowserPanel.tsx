import { useCallback, useContext, useEffect, useRef } from "react";
import type { KeyboardEvent } from "react";
import { useIntl } from "react-intl";
import { ArrowLeft, Globe, X } from "lucide-react";
import type { DesktopWebPreviewTabsBridge } from "@botiverse/raft-shared";
import { Panel, PanelAction, PanelActions, PanelHeader, PanelHeaderContent } from "@botiverse/raft-ui";

import Tooltip from "../../components/ui/Tooltip";
import EmptyState from "../../components/ui/EmptyState";
import { PanelHeadChromeContext, RowExpandAction, RowRegionBody, useHeadWidth, useRowExpand, useRowInRow } from "../../components/layout/appPanelHead";
import { useOpenArtifactTitle } from "../../apps/artifacts";
import { BrowserAddressBar } from "./BrowserAddressBar";
import { BrowserTabStrip } from "./BrowserTabStrip";
import { fitBrowserHead } from "./browserHeadFit";
import { browserTabLabel, useBrowserTabsStore } from "./browserTabsStore";
import { DesktopBrowserView } from "./DesktopBrowserView";
import { ArtifactSwitchChip } from "./SwitchChip";

/**
 * The built-in browser beside the conversation (Raft Desktop,
 * desktop_web_preview_view_v0, a shell with tabs), in the side window's
 * place: a tab row (the switch chip while the conversation's Artifact is open
 * behind it, the tabs, New tab, then the row's Expand and Close), an address
 * row for the tab in front, and that tab's page in the shell's native view
 * (DesktopBrowserView). An empty tab shows a line in the page's place.
 *
 * Close closes the browser with every tab (the Artifact behind it shows
 * again, else the side window closes); Escape with the focus in the Raft
 * page does the same, as the one-page panel's. Escape pressed in the page
 * stays with the page (the view has its own keyboard focus).
 */
export function BrowserPanel({ bridge, conversationId, covering, artifactBehind }: {
  bridge: DesktopWebPreviewTabsBridge;
  conversationId: string;
  covering: boolean;
  /** The conversation's Artifact is open behind the browser: the switch chip leads the tab row. */
  artifactBehind: boolean;
}) {
  const { formatMessage } = useIntl();
  const browser = useBrowserTabsStore((s) => s.browsers[conversationId]);
  const closeBrowser = useBrowserTabsStore((s) => s.close);
  const close = useCallback(() => closeBrowser(conversationId), [closeBrowser, conversationId]);
  const chrome = useContext(PanelHeadChromeContext);
  const rowTabs = chrome?.tabs ?? null;
  const inRow = useRowInRow("artifact");
  const rowExpand = useRowExpand("artifact");
  const [measureHead, headWidth] = useHeadWidth();
  const [measureFront, frontWidth] = useHeadWidth();
  const artifactTitle = useOpenArtifactTitle(artifactBehind ? conversationId : null);
  const panelRef = useRef<HTMLElement | null>(null);
  // Focus moves into the panel when the browser opens; Close and Esc give it back to what opened it.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);
  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    close();
  }, [close]);
  if (!browser) return null;
  const active = browser.tabs.find((tab) => tab.id === browser.activeId) ?? browser.tabs[0]!;
  const activeLabel = browserTabLabel(active);
  const closeLabel = formatMessage({ id: "webPreview.close" });
  const fit = fitBrowserHead({
    width: headWidth,
    chip: artifactBehind,
    tabs: browser.tabs.length,
    frontWidth,
    controls: (covering ? 1 : 0) + (inRow && rowExpand.shown ? 1 : 0) + (covering ? 0 : 1),
  });
  return (
    <Panel
      ref={panelRef}
      edge="inset"
      aria-label={activeLabel ? formatMessage({ id: "webPreview.panelLabel" }, { host: activeLabel }) : formatMessage({ id: "webPreview.browser" })}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className="flex size-full min-h-0 flex-col outline-none keyboard:focus-visible:outline-2 keyboard:focus-visible:outline-solid keyboard:focus-visible:-outline-offset-2 keyboard:focus-visible:outline-foreground"
      data-testid="web-preview"
      data-side-card-focus=""
    >
      <PanelHeader className="gap-1" data-testid="web-preview-header" {...(covering ? null : chrome?.props)} ref={measureHead}>
        {covering ? (
          <PanelAction aria-label={closeLabel} onClick={close} activateOnTouchEnd data-testid="web-preview-back">
            <ArrowLeft />
          </PanelAction>
        ) : null}
        {artifactBehind ? <ArtifactSwitchChip conversationId={conversationId} title={artifactTitle} titleRoom={fit.chipTitle} /> : null}
        <PanelHeaderContent className="flex-row items-center gap-1 md:items-center md:gap-1">
          {rowTabs ?? (
            <BrowserTabStrip conversationId={conversationId} tabs={browser.tabs} activeId={active.id} tabsShown={fit.tabsShown} measureFront={measureFront} />
          )}
          {covering ? null : chrome?.grip}
        </PanelHeaderContent>
        <PanelActions>
          {inRow ? <RowExpandAction region="artifact" testId="web-preview-expand" /> : null}
          {covering ? null : (
            <Tooltip content={closeLabel}>
              <PanelAction aria-label={closeLabel} onClick={close} data-testid="web-preview-close">
                <X />
              </PanelAction>
            </Tooltip>
          )}
        </PanelActions>
      </PanelHeader>
      <BrowserAddressBar key={active.id} bridge={bridge} conversationId={conversationId} tab={active} />
      <RowRegionBody>
        <div className="min-h-0 flex-1 overflow-hidden">
          <DesktopBrowserView bridge={bridge} conversationId={conversationId} tabId={active.id} title={activeLabel ?? formatMessage({ id: "webPreview.newTab" })}>
            {active.url === null ? (
              <div className="flex size-full items-center justify-center px-(--column-margin)" data-testid="web-preview-empty-tab">
                <EmptyState
                  icon={<Globe size={36} />}
                  title={formatMessage({ id: "webPreview.newTab" })}
                  titleHeading="h3"
                  description={formatMessage({ id: "webPreview.emptyTabDescription" })}
                />
              </div>
            ) : undefined}
          </DesktopBrowserView>
        </div>
      </RowRegionBody>
    </Panel>
  );
}
