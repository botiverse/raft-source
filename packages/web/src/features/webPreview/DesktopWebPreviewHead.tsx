import { useCallback, useContext } from "react";
import { useIntl } from "react-intl";
import { ArrowLeft, ArrowRight, ArrowUpRight, Globe, RefreshCw, X } from "lucide-react";
import {
  Badge,
  InputGroup,
  PanelAction,
  PanelActions,
  PanelHeader,
  PanelHeaderContent,
  Tabs,
  TabsLabel,
  TabsList,
  TabsTab,
} from "@botiverse/raft-ui";
import type { DesktopWebPreviewBridge, DesktopWebPreviewState } from "@botiverse/raft-shared";

import Tooltip from "../../components/ui/Tooltip";
import { PanelHeadChromeContext, RowExpandAction } from "../../components/layout/appPanelHead";

/** The one tab's id (step 1 is a single tab). */
const PAGE_TAB = "page";

/**
 * The head of the desktop web preview view (desktop_web_preview_view_v0),
 * drawn as Remy's side-window prototype draws its External Site view on
 * Desktop: a tab row, then an address bar.
 * - Tab row (the panel head): the page's one tab (globe, the page title or
 *   host), then the row's Expand and Close. The prototype's "+ New tab" is
 *   left out (one tab in this step), as are its pin and tab menus and the
 *   tab's own close (Close closes the one tab).
 * - Address bar: Back, Forward, Reload, the address (host bold, the rest
 *   muted, read-only and selectable; typing an address is not in this step),
 *   then Open in browser. A plain-http page (the view shows those, unlike
 *   the frame: security review, 2026-11-12) gets a Not secure badge before
 *   its host, as a browser's address bar does. The prototype's Comment toggle and More menu are
 *   left out.
 */
export function DesktopWebPreviewHead({
  bridge,
  state,
  url,
  host,
  rest,
  covering,
  inRow,
  onRefresh,
  onOpenInBrowser,
  onClose,
}: {
  bridge: DesktopWebPreviewBridge;
  state: DesktopWebPreviewState | null;
  url: string;
  host: string;
  rest: string;
  covering: boolean;
  inRow: boolean;
  onRefresh: () => void;
  onOpenInBrowser: () => void;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  const chrome = useContext(PanelHeadChromeContext);
  const rowTabs = chrome?.tabs ?? null;
  const closeLabel = formatMessage({ id: "webPreview.close" });
  const backLabel = formatMessage({ id: "webPreview.back" });
  const forwardLabel = formatMessage({ id: "webPreview.forward" });
  const refreshLabel = formatMessage({ id: "webPreview.refresh" });
  const openLabel = formatMessage({ id: "webPreview.openInBrowser" });
  const addressLabel = formatMessage({ id: "webPreview.address" });
  const tabLabel = state?.title || host;
  const notSecure = url.startsWith("http:");
  const back = useCallback(() => bridge.back(), [bridge]);
  const forward = useCallback(() => bridge.forward(), [bridge]);
  return (
    <>
      <PanelHeader className="gap-1" data-testid="web-preview-header" {...(covering ? null : chrome?.props)}>
        {covering ? (
          <PanelAction aria-label={closeLabel} onClick={onClose} activateOnTouchEnd data-testid="web-preview-back">
            <ArrowLeft />
          </PanelAction>
        ) : null}
        <PanelHeaderContent>
          {rowTabs ?? (
            <Tabs<string> value={PAGE_TAB} className="w-auto min-w-0" data-testid="web-preview-tabs">
              <TabsList aria-label={formatMessage({ id: "webPreview.tabs" })}>
                <TabsTab value={PAGE_TAB} title={url} data-testid="web-preview-tab">
                  <Globe aria-hidden />
                  {/* The panel's heading is its one tab (raft-design panel.md, Accessibility). */}
                  <TabsLabel className="block max-w-[108px] truncate" data-testid="web-preview-tab-label">{tabLabel}</TabsLabel>
                </TabsTab>
              </TabsList>
            </Tabs>
          )}
          {covering ? null : chrome?.grip}
        </PanelHeaderContent>
        <PanelActions>
          {inRow ? <RowExpandAction region="artifact" testId="web-preview-expand" /> : null}
          {covering ? null : (
            <Tooltip content={closeLabel}>
              <PanelAction aria-label={closeLabel} onClick={onClose} data-testid="web-preview-close">
                <X />
              </PanelAction>
            </Tooltip>
          )}
        </PanelActions>
      </PanelHeader>
      <div
        className="flex h-(--shell-header-height,var(--header-height)) shrink-0 items-center gap-1 border-b border-line-seam bg-layer-canvas px-(--column-margin)"
        data-testid="web-preview-address-bar"
      >
        <Tooltip content={backLabel}>
          <PanelAction aria-label={backLabel} onClick={back} disabled={!state?.canGoBack} data-testid="web-preview-history-back">
            <ArrowLeft />
          </PanelAction>
        </Tooltip>
        <Tooltip content={forwardLabel}>
          <PanelAction aria-label={forwardLabel} onClick={forward} disabled={!state?.canGoForward} data-testid="web-preview-history-forward">
            <ArrowRight />
          </PanelAction>
        </Tooltip>
        <Tooltip content={refreshLabel}>
          <PanelAction aria-label={refreshLabel} onClick={onRefresh} data-testid="web-preview-refresh">
            <RefreshCw />
          </PanelAction>
        </Tooltip>
        <div className="mx-1 flex min-w-0 flex-1">
          <InputGroup size="md" className="min-w-0 flex-1">
            {notSecure ? (
              <Badge appearance="soft" variant="warning" className="ml-2 shrink-0 self-center" data-testid="web-preview-not-secure">
                {formatMessage({ id: "webPreview.notSecure" })}
              </Badge>
            ) : null}
            {/* Read-only, selectable text, as the prototype's address when it can't be edited (raft-ui has no read-only address field). */}
            <div
              aria-label={addressLabel}
              title={url}
              className="min-w-0 flex-1 cursor-text truncate px-3 font-sans text-callout outline-none select-text"
              data-testid="web-preview-address"
            >
              <span className="font-bold text-foreground" data-testid="web-preview-host">{host}</span>
              <span className="text-foreground-muted" data-testid="web-preview-path">{rest}</span>
            </div>
          </InputGroup>
        </div>
        <Tooltip content={openLabel}>
          <PanelAction aria-label={openLabel} onClick={onOpenInBrowser} data-testid="web-preview-open-tab">
            <ArrowUpRight />
          </PanelAction>
        </Tooltip>
      </div>
    </>
  );
}
