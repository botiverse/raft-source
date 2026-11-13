import { useCallback, useEffect, useRef } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import { useIntl } from "react-intl";
import { ChevronDown, Globe, Laptop, Plus, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  PanelAction,
  Tabs,
  TabsLabel,
  TabsList,
  TabsTab,
} from "@botiverse/raft-ui";

import Tooltip from "../../components/ui/Tooltip";
import { splitBrowserTabs, TAB_MIN_WIDTH } from "./browserHeadFit";
import { BROWSER_MAX_TABS, browserTabLabel, isLocalAddress, useBrowserTabsStore } from "./browserTabsStore";
import type { BrowserTab } from "./browserTabsStore";

/**
 * The built-in browser's tab strip (the side-window prototype's "Browser +
 * Artifact" row; the switch chip's mock is its picture): the tabs (raft-ui
 * Tabs, the one in front selected), More tabs where they don't all fit, then
 * New tab.
 *
 * - A tab shows a laptop for a page on this computer or the local network,
 *   else a globe (no favicon: the app does not load an image a page names),
 *   then the page's title, else its host. The tabs behind narrow down to
 *   TAB_MIN_WIDTH before any goes under More tabs; the one in front keeps its
 *   title (168px at most).
 * - Closing: the × at the end of the tab in front; on a tab behind, the ×
 *   that takes its icon's place under the pointer; Delete or Backspace on the
 *   focused tab; a middle click. raft-ui's Tabs has no closable tab, so the ×
 *   is a small button laid over the tab (a sibling, not nested in it).
 * - Keys: the row is a tab list (Base UI): arrow keys, Home and End move the
 *   focus, Enter or Space brings the focused tab to the front.
 */
function TabClose({ label, active, onClose }: { label: string; active: boolean; onClose: () => void }) {
  const close = useCallback((event: MouseEvent) => {
    event.stopPropagation();
    onClose();
  }, [onClose]);
  return (
    <button
      type="button"
      // The tab's own key closes it (Delete); this is the pointer's way.
      tabIndex={-1}
      aria-label={label}
      onClick={close}
      className={active
        ? "z-raised mr-1.5 flex size-5 cursor-pointer items-center justify-center justify-self-end rounded-sticker border-0 bg-transparent p-0 text-sticker-ink hover:bg-fill-medium"
        : "invisible z-raised ml-2 flex size-5 cursor-pointer items-center justify-center justify-self-start rounded-sticker border-0 bg-transparent p-0 text-foreground-muted group-hover/tab:visible hover:bg-fill-medium"}
      data-testid="web-preview-tab-close"
    >
      <X className="size-3.5" aria-hidden />
    </button>
  );
}

function StripTab({ tab, active, onClose, measure }: { tab: BrowserTab; active: boolean; onClose: (tabId: string, byKey: boolean) => void; measure?: (element: HTMLElement | null) => void }) {
  const { formatMessage } = useIntl();
  const label = browserTabLabel(tab) ?? formatMessage({ id: "webPreview.newTab" });
  const Icon = isLocalAddress(tab.url) ? Laptop : Globe;
  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.key !== "Delete" && event.key !== "Backspace") return;
    event.preventDefault();
    onClose(tab.id, true);
  }, [onClose, tab.id]);
  const handleAuxClick = useCallback((event: MouseEvent) => {
    if (event.button !== 1) return;
    event.preventDefault();
    onClose(tab.id, false);
  }, [onClose, tab.id]);
  const close = useCallback(() => onClose(tab.id, false), [onClose, tab.id]);
  return (
    <span
      ref={measure}
      className="group/tab grid max-w-[168px] flex-[0_1_auto] items-center *:col-start-1 *:row-start-1"
      style={active ? { flexShrink: 0 } : { minWidth: TAB_MIN_WIDTH }}
      data-testid="web-preview-tab-slot"
      data-tab-id={tab.id}
    >
      <TabsTab
        value={tab.id}
        title={tab.url ?? undefined}
        aria-keyshortcuts="Delete"
        onKeyDown={handleKeyDown}
        onAuxClick={handleAuxClick}
        className={`w-full min-w-0 shrink justify-start px-2.5 *:data-[slot=tabs-tab-content]:min-w-0 *:data-[slot=tabs-tab-content]:flex-1 ${active ? "pr-7" : ""}`}
        data-testid="web-preview-tab"
      >
        <Icon aria-hidden className={active ? undefined : "group-hover/tab:invisible"} />
        <TabsLabel className="block min-w-0 truncate" data-testid="web-preview-tab-label">{label}</TabsLabel>
      </TabsTab>
      <TabClose label={formatMessage({ id: "webPreview.closeTab" }, { title: label })} active={active} onClose={close} />
    </span>
  );
}

/** A tab the row has no room for, in More tabs: picking it brings it to the front (and into the row). */
function MoreTab({ tab, onSelect }: { tab: BrowserTab; onSelect: (tabId: string) => void }) {
  const { formatMessage } = useIntl();
  const Icon = isLocalAddress(tab.url) ? Laptop : Globe;
  const pick = useCallback(() => onSelect(tab.id), [onSelect, tab.id]);
  return (
    <DropdownMenuItem onClick={pick} title={tab.url ?? undefined} data-testid="web-preview-more-tab">
      <Icon aria-hidden />
      <span className="max-w-[240px] min-w-0 truncate">{browserTabLabel(tab) ?? formatMessage({ id: "webPreview.newTab" })}</span>
    </DropdownMenuItem>
  );
}

export function BrowserTabStrip({ conversationId, tabs, activeId, tabsShown, measureFront }: {
  conversationId: string;
  tabs: readonly BrowserTab[];
  activeId: string;
  /** How many tabs the row has room for (browserHeadFit); the rest go under More tabs. */
  tabsShown: number;
  /** Measures the tab in front, for the fit. */
  measureFront: (element: HTMLElement | null) => void;
}) {
  const { formatMessage } = useIntl();
  const activate = useBrowserTabsStore((s) => s.activate);
  const closeTab = useBrowserTabsStore((s) => s.closeTab);
  const newTab = useBrowserTabsStore((s) => s.newTab);
  const stripRef = useRef<HTMLDivElement | null>(null);
  // A tab closed by its key took the focus with it: the tab now in front takes it.
  const refocus = useRef(false);
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    stripRef.current?.querySelector<HTMLElement>(`[data-tab-id="${activeId}"] [role="tab"]`)?.focus();
  }, [activeId, tabs.length]);
  const close = useCallback((tabId: string, byKey: boolean) => {
    refocus.current = byKey;
    closeTab(conversationId, tabId);
  }, [closeTab, conversationId]);
  const select = useCallback((tabId: string) => activate(conversationId, tabId), [activate, conversationId]);
  const add = useCallback(() => newTab(conversationId), [conversationId, newTab]);
  const { row, more } = splitBrowserTabs(tabs, activeId, tabsShown);
  const full = tabs.length >= BROWSER_MAX_TABS;
  const moreLabel = formatMessage({ id: "webPreview.moreTabs" });
  const newLabel = formatMessage({ id: "webPreview.newTab" });
  return (
    <div ref={stripRef} className="flex min-w-0 flex-1 items-center gap-1" data-testid="web-preview-tab-strip">
      <Tabs<string> value={activeId} onValueChange={select} className="w-auto min-w-0 flex-[0_1_auto]" data-testid="web-preview-tabs">
        <TabsList aria-label={formatMessage({ id: "webPreview.tabs" })} className="w-full overflow-hidden">
          {row.map((tab) => (
            <StripTab key={tab.id} tab={tab} active={tab.id === activeId} onClose={close} measure={tab.id === activeId ? measureFront : undefined} />
          ))}
        </TabsList>
      </Tabs>
      {more.length > 0 ? (
        <DropdownMenu>
          <Tooltip content={moreLabel}>
            <DropdownMenuTrigger render={(
              <PanelAction aria-label={moreLabel} data-testid="web-preview-more-tabs">
                <ChevronDown />
              </PanelAction>
            )} />
          </Tooltip>
          <DropdownMenuContent side="bottom" align="start" data-testid="web-preview-more-tabs-list">
            {more.map((tab) => <MoreTab key={tab.id} tab={tab} onSelect={select} />)}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {/* At the cap it stays focusable, so its tooltip can say why it does nothing. */}
      <Tooltip content={full ? formatMessage({ id: "webPreview.tabLimit" }, { count: BROWSER_MAX_TABS }) : newLabel}>
        <PanelAction
          aria-label={newLabel}
          onClick={add}
          disabled={full}
          focusableWhenDisabled
          className="data-disabled:cursor-default data-disabled:text-foreground-disabled data-disabled:hover:bg-transparent data-disabled:active:bg-transparent"
          data-testid="web-preview-new-tab"
        >
          <Plus />
        </PanelAction>
      </Tooltip>
    </div>
  );
}
