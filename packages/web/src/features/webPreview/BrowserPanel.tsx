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
import { usePaneFrame } from "../../components/layout/paneFocus";
import { isApplePlatform } from "../../utils/keyboardShortcuts";
import { BrowserAddressBar } from "./BrowserAddressBar";
import { BrowserBlockedNotice } from "./BrowserBlockedNotice";
import { BrowserFindBar } from "./BrowserFindBar";
import { BrowserPermissionPrompt } from "./BrowserPermissionPrompt";
import { BrowserTabStrip } from "./BrowserTabStrip";
import { fitBrowserHead, GRIP_ROOM } from "./browserHeadFit";
import { browserOf, browserTabLabel, useBrowserTabsStore } from "./browserTabsStore";
import { hasBrowserFind } from "./browserViews";
import { DesktopBrowserView } from "./DesktopBrowserView";
import { ArtifactSwitchChip } from "./SwitchChip";

const GRIP_ROOM_STYLE = { minWidth: GRIP_ROOM };

/**
 * The built-in browser beside the conversation (Raft Desktop,
 * desktop_web_preview_view_v0, a shell with tabs), in the side window's
 * place: a tab row (the switch chip while the conversation's Artifact is open
 * behind it, the tabs, New tab, then the row's Expand and Close), an address
 * row for the tab in front, the find row while a search of its page is open
 * (BrowserFindBar: Cmd/Ctrl+F in the page or in the panel), and that tab's
 * page in the shell's native view (DesktopBrowserView). An empty tab shows a
 * line in the page's place.
 *
 * Close closes the browser with every tab of the conversation's own; the
 * pinned tabs stay the window's, out of sight until the browser opens again (the Artifact behind it shows
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
  const browser = useBrowserTabsStore((s) => browserOf(s, conversationId));
  const closeBrowser = useBrowserTabsStore((s) => s.close);
  const close = useCallback(() => closeBrowser(conversationId), [closeBrowser, conversationId]);
  const find = useBrowserTabsStore((s) => s.find[conversationId]);
  const openFind = useBrowserTabsStore((s) => s.openFind);
  const stepFind = useBrowserTabsStore((s) => s.stepFind);
  const canFind = hasBrowserFind(bridge);
  const frontId = browser ? (browser.tabs.find((tab) => tab.id === browser.activeId) ?? browser.tabs[0])?.id ?? null : null;
  const frontHasPage = browser ? (browser.tabs.find((tab) => tab.id === frontId)?.url ?? null) !== null : false;
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
  // The panel is the browser pane's frame (paneFocus.ts): with the focus anywhere in it, the new-tab page and the
  // address row included, the shell's browser keys act on the tab in front (Cmd+R, Cmd+W: the tab, never the app).
  usePaneFrame(panelRef, "browser", conversationId, frontId);
  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented) return;
    // The shell's find keys (apps/desktop webPreviewCommands.ts), with the keyboard in the panel instead of the page
    // (the address field, the find field): Mod+F, Mod+G and Mod+Shift+G, and F3 and Shift+F3 off macOS. A shell with
    // pane keys (raftDesktop.paneFocus) takes them before they get here and hands them over as commands; this stays
    // for a shell that predates it (none of these keys is a menu accelerator, so they reach the page there).
    const apple = isApplePlatform(navigator.platform);
    const mod = apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    const letter = mod && !event.altKey ? event.key.toLowerCase() : "";
    const f3 = !apple && event.key === "F3" && !event.ctrlKey && !event.metaKey && !event.altKey;
    if (canFind && frontId !== null && frontHasPage && ((letter === "f" && !event.shiftKey) || letter === "g" || f3)) {
      // The next or previous match with no search to step through is left alone: the key is someone else's.
      if (letter !== "f" && !(find?.tabId === frontId && find.text !== "")) return;
      event.preventDefault();
      if (letter === "f") openFind(conversationId, frontId);
      else stepFind(conversationId, frontId, !event.shiftKey);
      return;
    }
    if (event.key !== "Escape") return;
    event.preventDefault();
    close();
  }, [canFind, close, conversationId, find, frontHasPage, frontId, openFind, stepFind]);
  // The grip is rendered wherever the head has one: with its column's tabs in the title's place (#189 rule 4) it
  // draws nothing but stays the head's draggable node. Only a grip that shows takes room in the row.
  const grip = covering ? null : chrome?.grip ?? null;
  const gripRoom = grip !== null && !rowTabs;
  if (!browser) return null;
  const active = browser.tabs.find((tab) => tab.id === browser.activeId) ?? browser.tabs[0]!;
  const activeLabel = browserTabLabel(active);
  const closeLabel = formatMessage({ id: "webPreview.close" });
  const fit = fitBrowserHead({
    width: headWidth,
    chip: artifactBehind,
    tabs: browser.tabs.length,
    pinned: browser.tabs.filter((tab) => tab.pinned).length,
    frontPinned: active.pinned === true,
    frontWidth,
    controls: (covering ? 1 : 0) + (inRow && rowExpand.shown ? 1 : 0) + (covering ? 0 : 1),
    grip: gripRoom,
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
        <PanelHeaderContent className="flex-row items-center gap-1 self-stretch md:items-center md:gap-1">
          {rowTabs ?? (
            <BrowserTabStrip bridge={bridge} conversationId={conversationId} tabs={browser.tabs} activeId={active.id} tabsShown={fit.tabsShown} measureFront={measureFront} />
          )}
          {/* The strip owns its hit area (#proj-workspace:#296): the grip that moves the panel stands in the free room
              after New tab (the fit keeps GRIP_ROOM of it), centred there, never over a tab or its close button. It
              is the narrow grip a thread's head takes under 448px (48x24, a 32px bar): the tabs need the room. */}
          {gripRoom ? (
            <span
              className="relative flex-1 self-stretch [&_[data-side-grip]]:w-12 [&_[data-side-grip]]:before:w-8"
              style={GRIP_ROOM_STYLE}
              data-testid="web-preview-grip-room"
            >
              {grip}
            </span>
          ) : grip}
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
      {canFind && find && find.tabId === active.id && active.url !== null ? (
        <BrowserFindBar key={active.id} conversationId={conversationId} find={find} />
      ) : null}
      {active.permissionPrompt && bridge.answerPermission ? (
        <BrowserPermissionPrompt key={active.permissionPrompt.id} bridge={bridge} tabId={active.id} prompt={active.permissionPrompt} />
      ) : null}
      {active.blocked && active.blocked.at !== active.blockedDismissedAt ? (
        <BrowserBlockedNotice key={active.blocked.at} conversationId={conversationId} tab={active} blocked={active.blocked} />
      ) : null}
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
