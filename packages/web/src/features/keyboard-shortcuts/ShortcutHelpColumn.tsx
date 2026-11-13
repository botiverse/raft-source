import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useIntl } from "react-intl";
import { X } from "lucide-react";
import { PanelAction, PanelBody, ProfilePanel, ScrollArea } from "@botiverse/raft-ui";
import ColumnResizeHandle from "../../components/ui/ColumnResizeHandle";
import PanelHeader from "../../components/ui/PanelHeader";
import Tooltip from "../../components/ui/Tooltip";
import { PROFILE_PANEL_OVERLAY_CLASS, profilePanelDesktopStyle } from "../../components/profile/profilePanelGeometry";
import { useMediaQuery } from "../../hooks/effectPrimitives";
import { useFocusRestore } from "../../hooks/useFocusRestore";
import { useColumnWidth } from "../../store/columnWidthStore";
import { useLegacyTaskPanelStore } from "../../store/legacyTaskPanelStore";
import { useProfileStore } from "../../store/profileStore";
import { useThreadStore } from "../../store/threadStore";
import { PanelHeadChromeContext } from "../../components/layout/panelHeadChrome";
import type { PanelHeadChrome } from "../../components/layout/panelHeadChrome";
import { SHORTCUT_HELP } from "../../components/layout/rowPlan";
import { useRowTabs } from "../../components/layout/rowPlanStore";
import { RowTabs } from "../../components/layout/RowTabs";
import { useShortcut } from "../shortcuts/useShortcut";
import { ShortcutHelpList } from "./DeferredShortcutHelpList";
import { useCanEditShortcuts } from "./useCanEditShortcuts";
import {
  HELP_MENU_TRIGGER_ID,
  SHORTCUT_HELP_PANEL_ID,
  toggleShortcutHelpFromKeyboard,
  useShortcutHelpStore,
} from "./shortcutHelpStore";
import { useShortcutLayer } from "../shortcuts/useShortcutLayer";

/**
 * What the panel covers in the conversation row: the thread, the profile, the
 * legacy task. index.css keeps them laid out but unseen (no display none,
 * which would drop their scroll, #11439); the panel makes them inert.
 */
const COVERED_SURFACES = '.thread-side-column, .thread-profile-side-column, [data-testid="legacy-task-panel"], [data-legacy-task-panel-fallback]';
/** Over a thread covering the channel the panel takes the whole row, Task v2's side columns too. */
const COVERED_WITH_COVERING_THREAD = `${COVERED_SURFACES}, [data-testid="channel-side-slot"]`;

const close = () => useShortcutHelpStore.getState().close();

/** The thread's reply box and the channel's composer, where focus goes back to when the one it left is gone. */
const THREAD_REPLY_BOX = '.thread-side-column [data-testid="composer-textarea"]';
const CHANNEL_COMPOSER = '.thread-main-column [data-testid="composer-textarea"]';

/**
 * The keyboard shortcuts panel's place in the conversation row (MainLayout,
 * right after RightPanel), and ⌘/ / Ctrl+/, which opens and closes it from
 * anywhere, text fields included (like ⌘K).
 *
 * The panel takes the right-hand detail column over whatever is open there:
 * index.css hides the thread, profile or legacy task (still mounted, so it
 * comes back as it was on close). Opening a thread, a profile or a legacy
 * task closes it.
 */
export function ShortcutHelpColumn() {
  const open = useShortcutHelpStore((s) => s.open);

  // The registry's dispatcher skips an IME composition (the `/` key reports "Process") and a key a surface took
  // for itself, and takes a held key without toggling again. Opening by key leaves focus where it is; closing
  // moves it out of the panel (the panel's layout effect).
  useShortcut("open-help", toggleShortcutHelpFromKeyboard);

  useEffect(() => {
    const stopThread = useThreadStore.subscribe((state, previous) => {
      if (state.openParentMessageId && state.openedAt !== previous.openedAt) close();
    });
    const stopProfile = useProfileStore.subscribe((state, previous) => {
      if (state.profileId && state.openedAt !== previous.openedAt) close();
    });
    // A legacy task takes the same column: opening one closes the panel too,
    // so the surfaces the panel covers never change while it is open.
    const stopLegacyTask = useLegacyTaskPanelStore.subscribe((state, previous) => {
      if (state.task && state.task !== previous.task) close();
    });
    return () => {
      stopThread();
      stopProfile();
      stopLegacyTask();
    };
  }, []);

  return open ? <ShortcutHelpPanel /> : null;
}

/**
 * ProfilePanel's container: `edge="attached"`, the remembered detail width
 * from 1024px (it covers the page below that), the column's resize handle,
 * and PanelHeader with ×.
 */
function ShortcutHelpPanel() {
  const { formatMessage } = useIntl();
  const width = useColumnWidth("detail");
  const inline = useMediaQuery("(min-width: 1024px)", true);
  const style = useMemo(() => (inline ? profilePanelDesktopStyle(width) : undefined), [inline, width]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const focusRequested = useShortcutHelpStore((s) => s.focusRequested);
  const canEdit = useCanEditShortcuts();
  // Where focus was in what the panel covers when it opened, and whether that was the thread.
  const returnToRef = useRef<{ element: HTMLElement | null; fromThread: boolean }>({ element: null, fromThread: false });
  const restoreFocus = useFocusRestore(() => {
    const { element: returnTo, fromThread } = returnToRef.current;
    return [
      returnTo,
      // The element itself may have been drawn again: the same place, found again.
      fromThread ? document.querySelector<HTMLElement>(THREAD_REPLY_BOX) : null,
      returnTo ? document.querySelector<HTMLElement>(CHANNEL_COMPOSER) : null,
      document.getElementById(HELP_MENU_TRIGGER_ID),
    ];
  }, { preventScroll: true });

  // Opened from the Help menu: focus goes to the list, so the arrow keys scroll it.
  useEffect(() => {
    if (!focusRequested) return;
    scrollRef.current?.focus({ preventScroll: true });
    useShortcutHelpStore.getState().focusTaken();
  }, [focusRequested]);

  // Cover the thread, profile or legacy task in the row: inert while the panel
  // is open. Focus in one of them (the thread's reply box) moves to the list,
  // and comes back to it on close. Focus the closing panel held goes back
  // there too, or to the rail's Help button (as ⌘\ sends it to the sidebar
  // toggle), never to <body>. Focus elsewhere (the channel's composer) stays.
  useLayoutEffect(() => {
    const panel = document.getElementById(SHORTCUT_HELP_PANEL_ID);
    const row = panel?.parentElement;
    const surfaces = row?.querySelector(":scope > .thread-side-column[data-covers]") ? COVERED_WITH_COVERING_THREAD : COVERED_SURFACES;
    const covered = Array.from(row?.children ?? []).filter((element) => element.matches(surfaces));
    const active = document.activeElement;
    const returnTo = active instanceof HTMLElement && covered.some((element) => element.contains(active)) ? active : null;
    for (const element of covered) element.setAttribute("inert", "");
    // The thread beside the conversation leaves the planned row (rowPlan `withShortcutHelpColumn`): it keeps the width
    // the row gave it, so its replies don't reflow and its scroll holds (index.css `--covered-width`). Read before the
    // row is laid out again without it (ChannelSideArea's layout effect runs after this one).
    const thread = covered.find((element) => element.matches(".thread-side-column:not([data-covers])")) as HTMLElement | undefined;
    const keptWidth = thread?.style.getPropertyValue("--row-width") ?? "";
    if (thread && keptWidth) thread.style.setProperty("--covered-width", keptWidth);
    returnToRef.current = { element: returnTo, fromThread: !!returnTo?.closest(".thread-side-column") };
    if (returnTo) scrollRef.current?.focus({ preventScroll: true });
    return () => {
      thread?.style.removeProperty("--covered-width");
      for (const element of covered) element.removeAttribute("inert");
      // Not now: the panel is still in the row here, and while it is, index.css keeps the covered surfaces unseen
      // (visibility), which a browser won't move focus into. Once it has gone and the row has the thread back
      // (rowPlan), and only if focus was lost with it.
      restoreFocus();
    };
  }, [restoreFocus]);

  // Esc closes the panel only while focus is in it, as the thread panel does, so an Esc in the composer (closing a
  // mention menu) leaves it open. A docked panel layer, in the capture phase: a tooltip in the panel (on ×) takes
  // Escape at the document first. Taken, it is marked handled: the covered profile's and legacy task's Esc skip it.
  useShortcutLayer("panel", true, {
    phase: "capture",
    ignoreDefaultPrevented: true,
    onEscape: (event) => {
      const panel = document.getElementById(SHORTCUT_HELP_PANEL_ID);
      if (!(event.target instanceof Node) || !panel?.contains(event.target)) return false;
      close();
    },
  });

  // Where the planned row is too narrow to give every column its 160 (#189 rule 4), the panel may hold the columns
  // right of it as tabs, or be one in its neighbour's head: its head shows them in place of its title.
  const tabs = useRowTabs(SHORTCUT_HELP);
  // Never its head alone (rule 5): the panel is a column of its own, never stacked with another region.
  const chrome = useMemo<PanelHeadChrome>(() => ({ props: {}, grip: null, tabs: tabs ? <RowTabs region={SHORTCUT_HELP} /> : null, headOnly: false }), [tabs]);
  const title = formatMessage({ id: "keyboardShortcuts.title" });
  const closeLabel = formatMessage({ id: "common.close" });
  return (
    <PanelHeadChromeContext.Provider value={chrome}>
    <ProfilePanel
      id={SHORTCUT_HELP_PANEL_ID}
      aria-label={title}
      edge="attached"
      className={`shortcut-help-column ${PROFILE_PANEL_OVERLAY_CLASS}`}
      style={style}
      data-testid="shortcut-help-panel"
    >
      <ColumnResizeHandle column="detail" edge="left" visibleFrom="lg" />
      <PanelHeader
        title={title}
        actions={(
          <Tooltip content={closeLabel}>
            <PanelAction onClick={close} aria-label={closeLabel}>
              <X size={22} aria-hidden="true" />
            </PanelAction>
          </Tooltip>
        )}
      />
      <PanelBody>
        <ScrollArea ref={scrollRef} tabIndex={-1} className="h-full min-h-0 outline-none" contentClassName="px-(--column-margin) py-4" data-testid="shortcut-help-scroll">
          <ShortcutHelpList editable={canEdit} />
        </ScrollArea>
      </PanelBody>
    </ProfilePanel>
    </PanelHeadChromeContext.Provider>
  );
}
