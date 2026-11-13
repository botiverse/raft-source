import { createPortal } from "react-dom";
import { dismissLayerProps } from "./dismissLayer";

/**
 * Invisible click-outside catcher for context menus and drawer overlays.
 *
 * Replaces the recurring pattern:
 *   <div className="fixed inset-0 z-popup" onClick={close} onContextMenu={...} />
 *
 * Used in: SavedPanel ctx menu, MessageItem ctx menu, Sidebar server-switcher
 * ctx menu (including the iOS phantom-click shield variant).
 *
 * Gestures that begin on the backdrop must stay on the backdrop: `touch-none`
 * prevents a swipe intended to dismiss a floating menu from panning the page
 * behind it. This does NOT mutate body styles or own ESC handling — those
 * lifecycle concerns still belong to the parent.
 *
 * It sits on the popup layer (`z-popup`) with the menu it belongs to; what is
 * over what is the DOM order, so render it before the menu (or after it, for a
 * shield that must cover the menu too).
 */
export default function DismissBackdrop({
  onDismiss,
  trapContextMenu = false,
  stopPropagation = false,
}: {
  onDismiss: () => void;
  /** If true, also intercepts right-click (prevents native context menu). */
  trapContextMenu?: boolean;
  /** If true, stops propagation instead of calling onDismiss (iOS phantom-click shield). */
  stopPropagation?: boolean;
}) {
  return createPortal(
    <div
      // The dismiss-layer marker: a full-window dismiss layer (task #121).
      data-slot="dismiss-backdrop"
      {...dismissLayerProps}
      className="fixed inset-0 z-popup touch-none"
      onClick={
        stopPropagation
          ? (e) => { e.stopPropagation(); e.preventDefault(); }
          : onDismiss
      }
      onContextMenu={
        trapContextMenu
          ? (e) => { e.preventDefault(); onDismiss(); }
          : undefined
      }
    />,
    document.body
  );
}
