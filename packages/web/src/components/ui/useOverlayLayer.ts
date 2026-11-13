import { useState } from "react";
import type { ComponentProps } from "react";
import type { DialogContent } from "@botiverse/raft-ui";
import { useShortcutLayer } from "../../features/shortcuts/useShortcutLayer";
import type { ShortcutScope } from "../../features/shortcuts/registry";

/**
 * A raft-ui modal (Dialog, Drawer) open while `open`, told to the shortcut registry: a modal layer with no Esc of its
 * own. Global commands (⌘K, ⌘/ …) and the layers under it (another dialog, a lightbox, a selection) stop hearing keys
 * while it is open, and its Esc stays Base UI's, which closes the dialog (dispatcher.ts, `modal`).
 * raft-ui pushes no layer itself; every slock wrapper around a raft-ui modal calls this. A lightbox passes its own
 * scope, so the registry's lightbox commands (⌘W "close-preview") still reach it.
 */
export function useOverlayLayer(open = true, scope: ShortcutScope = "dialog"): void {
  useShortcutLayer(scope, open, { modal: true });
}

function focusedElement(): HTMLElement | null {
  const active = typeof document === "undefined" ? null : document.activeElement;
  return active instanceof HTMLElement && active !== document.body ? active : null;
}

/**
 * A raft-ui modal opened from state (no Trigger: a store, a click handler): its `finalFocus`, the element focused when
 * it first rendered, so focus goes back to what opened it. Read during the first render, before Base UI moves focus
 * in. When that element is gone by then (the row that opened it re-rendered away), Base UI's own fallback.
 */
export function useOpenerFocus(): () => HTMLElement | boolean {
  const [opener] = useState(focusedElement);
  const [finalFocus] = useState(() => () => (opener?.isConnected ? opener : true));
  return finalFocus;
}

type PopupKeyDownEvent = Parameters<NonNullable<ComponentProps<typeof DialogContent>["onKeyDown"]>>[0];

/**
 * A raft-ui modal popup's onKeyDown: an Esc something inside already took (a mention list, a field cancelling its
 * edit, a filter menu; it called preventDefault) doesn't close the dialog. Base UI's dismiss closes on every Esc,
 * handled or not, so this skips its handler and keeps the Esc from reaching the document, where Base UI listens
 * too. The same rule as the registry's layers (dispatcher.ts): it was theirs, and nothing further out closes on it.
 * Called only for a key already handled before the popup's own onKeyDown ran (NarrowDialogContent): the dialog marking
 * its own Esc handled doesn't count as something inside taking it.
 */
export function keepEscapeTakenInside(event: PopupKeyDownEvent): void {
  if (event.key !== "Escape" || !event.defaultPrevented) return;
  event.preventBaseUIHandler?.();
  event.stopPropagation();
}

/** Layers that can open over a raft-ui modal from outside its React tree: a lightbox (the App-level ImageLightbox,
 *  attachment previews), another raft-ui dialog rendered elsewhere (a dialog host's confirmation; its portal) and any
 *  other surface marked as a dismiss layer (dismissLayer.ts: a message's context menu, a picker). */
const FOREIGN_LAYER_SELECTOR = "[data-slot=lightbox-portal], [data-slot=dialog-portal], [data-slot=alert-dialog-portal], [data-dismiss-layer='']";

/**
 * A raft-ui modal's onOpenChange: true when a close (an Esc, an outside press) came from a layer opened over the
 * dialog from outside its React tree, such as a lightbox opened from a forwarded image. Base UI's document listeners
 * hear that Esc or press too and would close the dialog under it; the old Modal didn't (its backdrop press had to land
 * on the backdrop itself). Cancel the close then: the layer is the one to close.
 */
export function isFromForeignLayer(event: Event | undefined, popup: HTMLElement | null): boolean {
  const target = event?.target;
  if (!(target instanceof Element) || popup?.contains(target)) return false;
  const layer = target.closest(FOREIGN_LAYER_SELECTOR);
  // The dialog's own portal (its scrim) is not foreign.
  return layer !== null && !(popup && layer.contains(popup));
}
