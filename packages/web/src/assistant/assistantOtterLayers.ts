import { useEffect, useMemo, useRef } from "react";
import type { RefObject } from "react";
import { DISMISS_LAYER_ATTR } from "../components/ui/dismissLayer";

// What the panel's messages open floats in document.body, outside the
// popover: the selected-text Quote / Copy bar, the reaction and emoji
// pickers, a message's or sender's context menu and their backdrops, a
// dialog opened from them. While one is open, a press or Esc is that
// layer's: it closes or acts in the layer, and the panel stays open
// (otherwise closing the panel would unmount the composer a Quote is meant
// for, and the action with it). Some carry the dismiss-layer marker only on
// their backdrop, not on their items, so the press is judged by what was open
// when it began, not by where it lands (see useLayerGesture).
const LAYER_ABOVE_PANEL = `[${DISMISS_LAYER_ATTR}]:not([${DISMISS_LAYER_ATTR}="false"]), [data-message-selection-shortcut="true"]`;

/** A layer above the panel is open now: one in LAYER_ABOVE_PANEL that is neither the panel nor inside it. */
function layerAbovePanelOpen(panel: HTMLElement | null): boolean {
  return Array.from(document.querySelectorAll(LAYER_ABOVE_PANEL)).some((layer) => layer !== panel && !panel?.contains(layer) && !layer.contains(panel));
}

/**
 * While the panel is open: whether the press or key in progress began with a
 * layer above it open. Read first, in the window's capture phase, before the
 * layer handles the press or Esc and unmounts (its item is then gone, or
 * focus falls to the body). A new press or key starts over.
 */
function useLayerGesture(active: boolean, panelRef: { readonly current: HTMLElement | null }): { readonly current: () => boolean } {
  const began = useRef(false);
  useEffect(() => {
    if (!active) {
      began.current = false;
      return undefined;
    }
    // Any key, not only Esc: Enter on a menu item closes the menu too, and focus falls to the body.
    const begin = () => { began.current = layerAbovePanelOpen(panelRef.current); };
    window.addEventListener("pointerdown", begin, true);
    // keydown-global-exempt: only notes whether a layer above the panel is open as the key begins; handles no key
    window.addEventListener("keydown", begin, true);
    return () => {
      window.removeEventListener("pointerdown", begin, true);
      window.removeEventListener("keydown", begin, true);
    };
  }, [active, panelRef]);
  return useMemo(() => ({ current: () => began.current }), []);
}


/** The part of Base UI's open-change details the panel's close reads. */
interface PanelCloseDetails {
  reason: string;
  event: Event;
  cancel: () => void;
  allowPropagation: () => void;
}

/**
 * For the otter's popover (`panelRef` on its popup): `keepsOpen(details)` cancels a close by an outside
 * press, its focus-out or Esc that belongs to a layer above the panel, and
 * says so. A canceled Esc goes on to the layer's own handler (useShortcutLayer,
 * on the document): Base UI would stop it at the panel.
 */
export function useLayerAbovePanel(active: boolean): { panelRef: RefObject<HTMLDivElement | null>; keepsOpen: (details: PanelCloseDetails) => boolean } {
  const panelRef = useRef<HTMLDivElement>(null);
  const gesture = useLayerGesture(active, panelRef);
  return useMemo(() => ({
    panelRef,
    keepsOpen: (details: PanelCloseDetails) => {
      if (details.reason !== "outside-press" && details.reason !== "focus-out" && details.reason !== "escape-key") return false;
      const event = details.event as Event & { relatedTarget?: EventTarget | null };
      const target = details.reason === "focus-out" ? event.relatedTarget : event.target;
      const onLayer = details.reason !== "escape-key" && target instanceof Element && target.closest(LAYER_ABOVE_PANEL) !== null;
      if (!gesture.current() && !onLayer) return false;
      details.cancel();
      if (details.reason === "escape-key") details.allowPropagation();
      return true;
    },
  }), [gesture]);
}
