import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps, RefObject } from "react";
import { useIntl } from "react-intl";
import { Dialog, DialogContent, Kbd } from "@botiverse/raft-ui";
import { MessageSearchPage } from "./MessageSearchPage";
import { SEARCH_ANCHOR_FIELD_SELECTOR, searchOverlayCardStyle, searchOverlayColumnFromRect } from "./searchOverlayAnchor";
import type { SearchOverlayColumn } from "./searchOverlayAnchor";
import { isFromForeignLayer } from "../../components/ui/useOverlayLayer";
import { useShortcutLayer } from "../../features/shortcuts/useShortcutLayer";

type OpenChangeDetails = Parameters<NonNullable<ComponentProps<typeof Dialog>["onOpenChange"]>>[1];

/**
 * Desktop ⌘K search overlay. The topbar Search button / ⌘K navigates to the real
 * `/search` route with `location.state.backgroundLocation` set; MainLayout keeps
 * the underlying channel rendered (frozen) via `<Routes location={backgroundLocation}>`
 * and floats this overlay on top. So the URL genuinely IS `/search` — MessageSearchPage's
 * URL-as-source-of-truth for the query works unchanged, and this is the SAME search,
 * just presented as a floating panel over the current channel (Slack ⌘K behaviour).
 *
 * A raft-ui Dialog (layer 1) with `placement="top"`: the page dims behind it
 * (the dialog's scrim), focus is trapped in it and the page under it is
 * hidden from assistive tech. Its top edge is the anchor (`--dialog-top`,
 * searchOverlayAnchor.ts). Header and footer stay transparent so the surface
 * reads as one piece; seams separate the field, the results and the key hints.
 *
 * It is always open while mounted: every way out navigates (MainLayout clears
 * backgroundLocation), which unmounts it. Result activation runs in
 * `activateResultsInChat` mode: a single click / Enter jumps to the hit in chat,
 * which navigates away and so dismisses the overlay on its own; focus is left
 * to the chat then. A press on the scrim and Esc dismiss it (`onClose`), and
 * focus goes back to the top bar's search field.
 *
 * Escape is owned by the shortcut registry rather than Base UI (whose dismiss
 * closes on every Esc, handled or not): the layer respects a prior handler (the
 * search's filter menus take their Esc, leave the overlay open) and ignores an
 * input method's Esc. The layer is not modal, so ⌘K still reaches MainLayout
 * and puts the focus back in the search field, as before.
 */
const ARROW_UP_GLYPH = "↑";
const ARROW_DOWN_GLYPH = "↓";
const RETURN_KEY_GLYPH = "↵";

// A web surface without the top bar (the host-shell embed): track the content
// column (everything right of the sidebar) so the panel sits at its top, centred
// on the window (searchOverlayAnchor.ts). MainLayout owns that element and
// passes it in, or passes null when the top bar is shown. With a top bar (web
// or a host shell such as the desktop app, which always shows it) the panel
// anchors to the bar's field instead, so nothing is measured here.
function useWebContentColumn(columnRef: RefObject<HTMLElement | null> | null): SearchOverlayColumn | null {
  const [column, setColumn] = useState<SearchOverlayColumn | null>(null);
  useLayoutEffect(() => {
    const el = columnRef?.current;
    if (!el) return;
    const measure = () => {
      const next = searchOverlayColumnFromRect(el.getBoundingClientRect());
      setColumn((prev) => (prev && prev.top === next.top ? prev : next));
    };
    measure();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(el);
    window.addEventListener("resize", measure);
    return () => { ro?.disconnect(); window.removeEventListener("resize", measure); };
  }, [columnRef]);
  return column;
}

export function SearchOverlay({ onClose, contentColumnRef }: {
  onClose: () => void;
  /** Web: the content column the panel sits at the top of (MainLayout's).
   *  Required so a missing wire fails to compile instead of silently falling
   *  back to the centred placement; pass null only where there is no column. */
  contentColumnRef: RefObject<HTMLElement | null> | null;
}) {
  const { formatMessage } = useIntl();
  const column = useWebContentColumn(contentColumnRef);
  const cardStyle = useMemo(() => searchOverlayCardStyle(column), [column]);
  const popupRef = useRef<HTMLDivElement | null>(null);
  // Set by a dismissal (Esc, the scrim), read as the overlay unmounts: only
  // then does focus go back to the top bar. A result opened in chat keeps the
  // focus where the chat puts it.
  const dismissedRef = useRef(false);
  const dismiss = useCallback(() => {
    dismissedRef.current = true;
    onClose();
  }, [onClose]);
  // Esc dismisses the overlay as the innermost layer; the search's filter-menu Escape wins (defaultPrevented), and an
  // input method's Esc is the IME's (the dispatcher's guard).
  useShortcutLayer("dialog", true, { onEscape: () => { dismiss(); } });
  // Base UI's own closes: a press on the scrim dismisses. Its Esc is the
  // registry's (above): Base UI's is cancelled and let through to the document,
  // where the registry listens (Base UI stops it at the popup otherwise). A
  // press in a layer opened over the overlay from outside its tree (a result's
  // context menu) is that layer's.
  const handleOpenChange = useCallback((open: boolean, details: OpenChangeDetails) => {
    if (open) return;
    if (details.reason === "escape-key") details.allowPropagation();
    if (details.reason !== "outside-press" || isFromForeignLayer(details.event, popupRef.current)) {
      details.cancel();
      return;
    }
    dismiss();
  }, [dismiss]);
  const [initialFocus] = useState(() => () => popupRef.current?.querySelector<HTMLInputElement>("input") ?? true);
  const [finalFocus] = useState(() => () => {
    if (!dismissedRef.current) return false;
    return document.querySelector<HTMLElement>(SEARCH_ANCHOR_FIELD_SELECTOR) ?? true;
  });

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      {/*
        Fixed size + position (Slack command-palette pattern): a constant height
        so the frame never grows/shrinks or re-centers as the query and result
        count change — MessageSearchPage fills it (flex-1) and its result list
        scrolls internally. Placement is ANCHORED to the desktop top-bar search
        field via CSS variables (see searchOverlayAnchor.ts): top edge on the
        field, centred on the window, so the panel reads as the field expanding — with a
        centred 8vh fallback wherever the shell publishes no anchor.
      */}
      <DialogContent
        ref={popupRef}
        layer={1}
        placement="top"
        data-testid="desktop-search-overlay"
        className="min-h-0 max-w-none"
        style={cardStyle}
        initialFocus={initialFocus}
        finalFocus={finalFocus}
      >
        <MessageSearchPage activateResultsInChat overlayChrome />
        {/* Palette footer (task #113, Slack's "↑↓ Select"): the keyboard contract
            in one quiet line; Esc already sits in the field. */}
        <div
          data-testid="desktop-search-overlay-footer"
          className="flex shrink-0 items-center gap-4 border-t border-line-seam px-3 py-2 text-caption text-foreground-hint"
        >
          <span className="flex items-center gap-1">
            <Kbd aria-hidden="true">{ARROW_UP_GLYPH}</Kbd>
            <Kbd aria-hidden="true">{ARROW_DOWN_GLYPH}</Kbd>
            <span>{formatMessage({ id: "search.overlay.footerSelect" })}</span>
          </span>
          <span className="flex items-center gap-1">
            <Kbd aria-hidden="true">{RETURN_KEY_GLYPH}</Kbd>
            <span>{formatMessage({ id: "search.overlay.footerOpen" })}</span>
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
