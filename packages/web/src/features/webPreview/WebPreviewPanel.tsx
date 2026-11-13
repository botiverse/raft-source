import { useCallback, useContext, useEffect, useMemo, useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import { ArrowLeft, ArrowUpRight, Monitor, RefreshCw, ShieldAlert, Smartphone, X } from "lucide-react";
import type { DesktopWebPreviewBridge } from "@botiverse/raft-shared";
import {
  Button,
  Panel,
  PanelAction,
  PanelActions,
  PanelHeader,
  PanelHeaderContent,
  PanelHeading,
  PanelMeta,
  PanelTitle,
  Text,
  TextLink,
} from "@botiverse/raft-ui";

import Tooltip from "../../components/ui/Tooltip";
import EmptyState from "../../components/ui/EmptyState";
import { PanelHeadChromeContext, RowExpandAction, RowRegionBody, useHeadWidth, useRowInRow } from "../../components/layout/appPanelHead";
import { usePhoneHistoryEntry } from "../../apps/artifacts";
import { useMediaQuery } from "../../hooks/effectPrimitives";
import { canShowWebPreview, openWebPreviewInNewTab, useWebPreviewStore, WEB_PREVIEW_PHONE_WIDTH, WEB_PREVIEW_SANDBOX, webPreviewUrl } from "./webPreviewStore";
import type { WebPreviewPage, WebPreviewWidth } from "./webPreviewStore";
import { useDesktopWebPreviewState, useDesktopWebPreviewView } from "./useWebPreview";
import { DesktopSiteView } from "./DesktopWebPreviewView";
import { DesktopWebPreviewHead } from "./DesktopWebPreviewHead";


/** Below this head width Refresh steps out of the head (the head has no ⋯ of its own). */
const HEAD_REFRESH_MIN = 300;
/** Below this, the width toggle steps out too: the page shows at the panel's width. */
const HEAD_WIDTH_MIN = 260;
/** Below this, Open in new tab steps out as well: the foot's line still opens one. */
const HEAD_OPEN_MIN = 200;

/**
 * The address in the head: the host as the title, the rest (path, query,
 * hash) muted after it, each truncating on its own and both selectable, so
 * the address can be read and copied. The full address is the title's
 * tooltip. The frame's later navigation can't be read (another origin): this
 * is the address that was opened. In the desktop app's native view
 * (desktop_web_preview_view_v0) it is the view's current address.
 */
function useAddressParts(url: string): { host: string; rest: string } {
  return useMemo(() => {
    const parsed = webPreviewUrl(url);
    if (!parsed) return { host: url, rest: "" };
    const rest = `${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}${parsed.hash}`;
    return { host: parsed.host, rest };
  }, [url]);
}

function SiteFrame({ url, title, width, reloads, native }: { url: string; title: string; width: WebPreviewWidth; reloads: number; native: DesktopWebPreviewBridge | null }) {
  // `credentialless` (Chromium): the page loads in a fresh, throwaway storage
  // partition with no cookies of the person's, so a site they are signed in
  // to elsewhere shows signed out here and can't act as them. A boolean
  // attribute React knows; browsers without it ignore it.
  const credentialless = { credentialless: true };
  // Raft Desktop with desktop_web_preview_view_v0: a placeholder the shell's
  // real browser view is laid over (DesktopWebPreviewView), not a frame.
  const frame = native ? <DesktopSiteView bridge={native} url={url} title={title} /> : (
    <iframe
      key={`${url}#${reloads}`}
      src={url}
      title={title}
      // Every token is justified at WEB_PREVIEW_SANDBOX (security boundary).
      sandbox={WEB_PREVIEW_SANDBOX}
      // The page learns only that it was opened from Raft, Raft's origin
      // (`https://app.raft.build`), never which page: no channel, message or
      // path. An embedded player needs that much (YouTube's /embed refuses to
      // play with no Referer at all, "Error 153"); an http page gets nothing.
      // Only the frame sends it: the new-tab links stay `noreferrer`, and the
      // document's own Referrer-Policy is unchanged.
      referrerPolicy="strict-origin"
      // No powerful features at all: camera, microphone, geolocation,
      // clipboard, payment, fullscreen and the rest are denied to the page.
      allow=""
      {...credentialless}
      className="block size-full border-0"
      data-testid="web-preview-frame"
    />
  );
  if (width === "desktop") return frame;
  return (
    <div className="flex h-full justify-center overflow-hidden bg-fill-subtle py-4" data-testid="web-preview-phone">
      <div
        className="h-full shrink-0 overflow-hidden rounded-[6px] border border-line-hairline bg-layer-card"
        style={{ width: WEB_PREVIEW_PHONE_WIDTH }}
      >
        {frame}
      </div>
    </div>
  );
}

/**
 * The page beside the conversation (web_preview_v0), in the side area's
 * Artifact place, laid out, resized and covering on a phone as the Artifact
 * viewer is. The head is the panel head every column has: the address (host
 * bold, the rest muted), then its own actions: Open in new tab, the width
 * toggle (one button, named for the width it switches to: Phone width, a
 * 390px frame centred, or Desktop width; Jasper, so the head stays one line)
 * and Refresh; then the row's Expand and Close (raft-design panel.md, Rules:
 * own actions, then window controls). Then the page, sandboxed, and one
 * quiet line at the foot: a site that refuses to be framed (X-Frame-Options,
 * CSP frame-ancestors) shows blank, which the app can't detect, so the way
 * out is always on screen. An http:// page is never framed (mixed content):
 * an empty state says so and opens it in a new tab (the native view below
 * shows it, its address bar marked Not secure).
 *
 * In Raft Desktop with desktop_web_preview_view_v0 on, the page is a real
 * browser view the shell lays over a placeholder (DesktopWebPreviewView):
 * the head is a tab row and an address bar (DesktopWebPreviewHead, after
 * Remy's side-window prototype): the view's current address, Back, Forward,
 * Reload and Open in browser (the system browser); no width toggle and no
 * foot line (nothing refuses a real view). Esc pressed in the page stays with
 * the page (the view has its own keyboard focus; nothing forwards it here).
 * Off, or in a browser: the frame.
 */
export function WebPreviewPanel({ page, covering }: { page: WebPreviewPage; covering: boolean }) {
  const { formatMessage } = useIntl();
  const width = useWebPreviewStore((s) => s.width);
  const reloads = useWebPreviewStore((s) => s.reloads);
  const setWidth = useWebPreviewStore((s) => s.setWidth);
  const reload = useWebPreviewStore((s) => s.reload);
  const close = useWebPreviewStore((s) => s.close);
  const chrome = useContext(PanelHeadChromeContext);
  const rowTabs = chrome?.tabs ?? null;
  const inRow = useRowInRow("artifact");
  const [measureHead, headWidth] = useHeadWidth();
  // The desktop app's native view (desktop_web_preview_view_v0), else null: the frame.
  const native = useDesktopWebPreviewView();
  const nativeState = useDesktopWebPreviewState(native);
  const currentUrl = (native && nativeState?.url) || page.url;
  const { host, rest } = useAddressParts(currentUrl);
  // The frame never shows http (mixed content); the native view does, marked Not secure.
  const framed = canShowWebPreview(page.url, native !== null);
  const panelRef = useRef<HTMLElement | null>(null);
  // Focus moves into the panel when a page opens in it; Close and Esc give it
  // back to the button that opened it (webPreviewStore's return focus).
  useEffect(() => {
    panelRef.current?.focus();
  }, [page.url]);
  // On a phone the page covers the conversation as a page of its own: the
  // system Back closes it, as it does the Artifact viewer.
  const phone = useMediaQuery("(max-width: 767px)");
  usePhoneHistoryEntry(covering && phone, close);
  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    close();
  }, [close]);
  // In the desktop app window.open goes to the system browser (main's window-open handler).
  const openTab = useCallback(() => openWebPreviewInNewTab(currentUrl), [currentUrl]);
  // Refresh reloads the native view's page; the frame mounts again (webPreviewStore.reloads).
  const refresh = useCallback(() => (native ? native.reload() : reload()), [native, reload]);

  const closeLabel = formatMessage({ id: "webPreview.close" });
  const openLabel = formatMessage({ id: native ? "webPreview.openInBrowser" : "webPreview.openInNewTab" });

  const refreshLabel = formatMessage({ id: "webPreview.refresh" });
  // The head fits its column (raft-design panel.md, "A head fits its column"):
  // with no ⋯ of its own, Refresh steps out first, then Open in new tab (the
  // foot's line keeps that one); Expand and Close always stay.
  const showRefresh = framed && (headWidth === 0 || headWidth >= HEAD_REFRESH_MIN);
  // On a phone the page is the whole screen already: no width to pick.
  const showWidth = framed && !covering && (headWidth === 0 || headWidth >= HEAD_WIDTH_MIN);
  const toWidth: WebPreviewWidth = width === "desktop" ? "phone" : "desktop";
  const widthLabel = formatMessage({ id: toWidth === "phone" ? "webPreview.toPhoneWidth" : "webPreview.toDesktopWidth" });
  const toggleWidth = useCallback(() => setWidth(toWidth), [setWidth, toWidth]);
  const showOpen = headWidth === 0 || headWidth >= HEAD_OPEN_MIN;
  const newTabLink = useCallback((chunks: ReactNode[]) => (
    // In a new tab without opener or referrer, as a message link opens.
    <TextLink
      key="open"
      variant="muted"
      render={<a href={page.url} target="_blank" rel="noopener noreferrer">{chunks}</a>}
      data-testid="web-preview-hint-open"
    />
  ), [page.url]);
  return (
    <Panel
      ref={panelRef}
      edge="inset"
      aria-label={formatMessage({ id: "webPreview.panelLabel" }, { host })}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className="flex size-full min-h-0 flex-col outline-none keyboard:focus-visible:outline-2 keyboard:focus-visible:outline-solid keyboard:focus-visible:-outline-offset-2 keyboard:focus-visible:outline-foreground"
      data-testid="web-preview"
      data-side-card-focus=""
    >
      {native && framed ? (
        // Raft Desktop's native view: a tab row and an address bar (DesktopWebPreviewHead).
        <DesktopWebPreviewHead
          bridge={native}
          state={nativeState}
          url={currentUrl}
          host={host}
          rest={rest}
          covering={covering}
          inRow={inRow}
          onRefresh={refresh}
          onOpenInBrowser={openTab}
          onClose={close}
        />
      ) : (
        <PanelHeader data-testid="web-preview-header" {...(covering ? null : chrome?.props)} ref={measureHead}>
          {covering ? (
            // Covering (a phone, a narrow panel) Back closes it, as the Artifact viewer's does.
            <PanelAction aria-label={closeLabel} onClick={close} activateOnTouchEnd data-testid="web-preview-back">
              <ArrowLeft />
            </PanelAction>
          ) : null}
          <PanelHeaderContent>
            {rowTabs ?? (
              <PanelHeading>
                {/* The panel's heading (raft-design panel.md, Accessibility). */}
                <PanelTitle render={<h2>{host}</h2>} title={currentUrl} className="select-text" data-testid="web-preview-host" />
              </PanelHeading>
            )}
            {rowTabs || !rest ? null : (
              <PanelMeta title={currentUrl} className="select-text" data-testid="web-preview-path">
                {rest}
              </PanelMeta>
            )}
            {covering ? null : chrome?.grip}
          </PanelHeaderContent>
          <PanelActions>
            {showOpen ? (
              <Tooltip content={openLabel}>
                <PanelAction aria-label={openLabel} onClick={openTab} data-testid="web-preview-open-tab">
                  <ArrowUpRight />
                </PanelAction>
              </Tooltip>
            ) : null}
            {showWidth ? (
              // One button for the two widths (Jasper), so the head stays one
              // line: its icon and name are the width it switches to.
              <Tooltip content={widthLabel}>
                <PanelAction aria-label={widthLabel} onClick={toggleWidth} data-testid="web-preview-width" data-width={width}>
                  {toWidth === "phone" ? <Smartphone /> : <Monitor />}
                </PanelAction>
              </Tooltip>
            ) : null}
            {showRefresh ? (
              <Tooltip content={refreshLabel}>
                <PanelAction aria-label={refreshLabel} onClick={refresh} data-testid="web-preview-refresh">
                  <RefreshCw />
                </PanelAction>
              </Tooltip>
            ) : null}
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
      )}
      <RowRegionBody>
        {framed ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-hidden">
              <SiteFrame url={page.url} title={host} width={covering || native ? "desktop" : width} reloads={reloads} native={native} />
            </div>
            {native ? null : <Text.Sans size="caption" variant="muted" className="block shrink-0 truncate border-t border-line-seam px-(--column-margin) py-1.5" data-testid="web-preview-hint">
              {formatMessage({ id: "webPreview.notShowing" }, { link: newTabLink })}
            </Text.Sans>}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center px-(--column-margin)" data-testid="web-preview-insecure">
            <EmptyState
              icon={<ShieldAlert size={36} />}
              title={formatMessage({ id: "webPreview.insecureTitle" })}
              titleHeading="h3"
              description={formatMessage({ id: "webPreview.insecureDescription" })}
              action={(
                <Button variant="default" size="md" onClick={openTab} data-testid="web-preview-insecure-open">
                  {openLabel}
                </Button>
              )}
            />
          </div>
        )}
      </RowRegionBody>
    </Panel>
  );
}
