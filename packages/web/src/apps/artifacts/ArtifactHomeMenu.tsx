import { useCallback, useContext, useRef } from "react";
import type { KeyboardEvent, MouseEvent, ReactElement, ReactNode, RefObject } from "react";
import { useIntl } from "react-intl";
import { AppWindow, ArrowUpRight, CircleCheck, Link, PanelRightOpen, Undo2 } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@botiverse/raft-ui";
import type { ArtifactCard } from "@botiverse/raft-shared";

import { artifactUrl } from "./artifactLinks";
import { ArtifactHomeSettleContext, settledShown } from "./artifactSettled";
import type { ArtifactHomeSettle } from "./artifactSettled";
import { artifactOpenLabelId, openArtifactWindow } from "./artifactWindow";
import { useCopyArtifactLink } from "./artifactCopyLink";
import { isNewWindowClick, openArtifactInWindow, useArtifactMiniWindows } from "./artifactWindowOpening";

/**
 * The keyboard's context menu (Shift+F10, the ContextMenu key) on a focused tile or row opens the menu at it, not at
 * the window's corner, where a keyboard's own `contextmenu` event says it is.
 */
function openAt(element: HTMLElement) {
  const box = element.getBoundingClientRect();
  element.dispatchEvent(new globalThis.MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: box.left + Math.min(24, box.width / 2),
    clientY: box.top + Math.min(24, box.height / 2),
  }));
}

function menuKey(event: KeyboardEvent<HTMLElement>) {
  if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
    event.preventDefault();
    openAt(event.currentTarget);
  }
}

/** A browser's own `contextmenu` from the keyboard (no pointer, at 0,0): opened at the tile or row instead. */
function fromKeyboard(event: MouseEvent<HTMLElement>) {
  const native = event.nativeEvent as globalThis.PointerEvent;
  if (native.isTrusted && (native.pointerType === "" || (native.clientX === 0 && native.clientY === 0))) {
    event.preventDefault();
    event.stopPropagation();
    openAt(event.currentTarget);
  }
}

/**
 * After the reader's own settle or unsettle from the menu, while focus went nowhere (the menu gave it back to the row,
 * and the row left: into the folded Other, or remounted in the other group): to the same row where it is now, else to
 * the row that took its place (the next one), else to Other's head. Focus somewhere else is the reader's: left there.
 */
function keepFocus(root: HTMLElement | null, id: string, index: number) {
  if (!root?.isConnected) return;
  const active = document.activeElement;
  if (active && active !== document.body && active.isConnected) return;
  const same = root.querySelector<HTMLElement>(`[data-artifact-id="${CSS.escape(id)}"] [data-artifact-open]`);
  const openers = [...root.querySelectorAll<HTMLElement>("[data-artifact-open]")];
  const next = index >= 0 && index < openers.length ? openers[index] : null;
  (same ?? next ?? root.querySelector<HTMLElement>("[data-testid='artifacts-group-other']"))?.focus();
}

/** The trigger's inline `-webkit-touch-callout: none` undone, so a long press on a link shows the system menu as before. */
const FLAG_OFF_STYLE = { WebkitTouchCallout: "default" } as const;

/**
 * A home page tile or row as the trigger of its menu (#334; raft-ui ContextMenu: right-click, a long press on a touch
 * screen, Shift+F10 or the ContextMenu key while its title has focus): Open, Open in new page (new window), Copy link, then Settle
 * or Unsettle, as the viewer's ⋯ has it. The reader's own act, so the tile or row changes group at once
 * (useArtifactHomeGroups). Tiles and rows have no ⋯ of their own, so this menu is the only one. Only where the card
 * says whether it is settled (the flag on): otherwise the menu is off (the browser's own, as before). Its text
 * stays selectable on a pointer (raft-ui's trigger makes it unselectable, for a long press; kept so on touch only).
 */
export function ArtifactHomeMenu({ card, onOpen, render, children }: {
  card: ArtifactCard;
  /** Open it over the page, as its title does; `from` is the title, where focus goes back. */
  onOpen: (from: HTMLElement) => void;
  /** The tile or row element, without children. */
  render: ReactElement;
  children: ReactNode;
}) {
  const shown = settledShown(card);
  const home = useContext(ArtifactHomeSettleContext);
  // The tile or row element, whichever it is (typed as the trigger's own div).
  const trigger = useRef<HTMLDivElement | null>(null);
  const open = useCallback(() => {
    const root = trigger.current;
    const from = root?.querySelector<HTMLElement>("[data-artifact-open]") ?? root;
    if (from) onOpen(from);
  }, [onOpen]);
  return (
    <ContextMenu disabled={!shown}>
      <ContextMenuTrigger
        ref={trigger}
        render={render}
        // raft-ui's trigger is select-none (for a long press): text stays selectable but on touch, and as before with the flag off.
        className={shown ? "select-text pointer-coarse:select-none" : "select-auto"}
        onKeyDown={shown ? menuKey : undefined}
        onContextMenuCapture={shown ? fromKeyboard : undefined}
        // The trigger turns off iOS's own long-press menu (for its own); with the flag off its links keep theirs.
        style={shown ? undefined : FLAG_OFF_STYLE}
      >
        {children}
      </ContextMenuTrigger>
      {shown ? <HomeMenuContent card={card} onOpen={open} home={home} trigger={trigger} /> : null}
    </ContextMenu>
  );
}

/** The menu's items (mounted only with the flag on). */
function HomeMenuContent({ card, onOpen, home, trigger }: { card: ArtifactCard; onOpen: () => void; home: ArtifactHomeSettle | null; trigger: RefObject<HTMLDivElement | null> }) {
  const { formatMessage } = useIntl();
  // Raft Desktop with the Artifact mini window (artifactWindowOpening.ts): Open in new window, the reused Artifact
  // window (another with Cmd/Ctrl), focus back to the row's title when it closes; else Open in new page as before.
  const miniWindows = useArtifactMiniWindows();
  const openInNewPage = useCallback((event: MouseEvent<HTMLElement>) => {
    const from = trigger.current?.querySelector<HTMLElement>("[data-artifact-open]") ?? trigger.current;
    if (openArtifactInWindow({ id: card.id, version: null }, { enabled: miniWindows, source: "all", additional: isNewWindowClick(event), from, title: card.title })) return;
    openArtifactWindow(artifactUrl(card.id, null), card.id);
  }, [card.id, card.title, miniWindows, trigger]);
  const copyLink = useCopyArtifactLink(card, "viewer");
  const settled = card.settled != null;
  const toggle = useCallback(() => {
    if (!home) return;
    // Where the row is now, for focus once the answer moved it (keepFocus).
    const row = trigger.current;
    const root = row?.closest<HTMLElement>("[data-testid='artifacts-all-list']") ?? null;
    const index = root && row ? [...root.querySelectorAll<HTMLElement>("[data-artifact-open]")].findIndex((opener) => row.contains(opener)) : -1;
    void home.setSettled(card, !settled).then(() => requestAnimationFrame(() => keepFocus(root, card.id, index)));
  }, [home, card, settled, trigger]);
  return (
    <ContextMenuContent aria-label={card.title} className="min-w-48" data-testid="artifacts-home-menu">
      <ContextMenuItem onClick={onOpen} data-testid="artifacts-home-menu-open">
        <PanelRightOpen />
        {formatMessage({ id: "artifacts.homeMenu.open" })}
      </ContextMenuItem>
      <ContextMenuItem onClick={openInNewPage} data-testid="artifacts-home-menu-open-in-new-page">
        {miniWindows ? <AppWindow /> : <ArrowUpRight />}
        {formatMessage({ id: miniWindows ? "artifacts.card.openInNewWindow" : artifactOpenLabelId("artifacts.card.openInNewPage") })}
      </ContextMenuItem>
      <ContextMenuItem onClick={copyLink} data-testid="artifacts-home-menu-copy-link">
        <Link />
        {formatMessage({ id: "artifacts.menu.copyLink" })}
      </ContextMenuItem>
      {home ? (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={toggle} disabled={home.pending.has(card.id)} data-testid="artifacts-home-menu-settle" data-settle={settled ? "unsettle" : "settle"}>
            {settled ? <Undo2 /> : <CircleCheck />}
            {formatMessage({ id: settled ? "artifacts.settled.unsettle" : "artifacts.settled.settle" })}
          </ContextMenuItem>
        </>
      ) : null}
    </ContextMenuContent>
  );
}
