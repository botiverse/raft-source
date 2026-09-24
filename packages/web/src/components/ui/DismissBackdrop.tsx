import { createPortal } from "react-dom";

/**
 * Invisible click-outside catcher for context menus and drawer overlays.
 *
 * Replaces the recurring pattern:
 *   <div className="fixed inset-0 z-50" onClick={close} onContextMenu={...} />
 *
 * Used in: SavedPanel ctx menu, MessageItem ctx menu, Sidebar server-switcher
 * ctx menu (including the iOS phantom-click shield variant).
 *
 * Gestures that begin on the backdrop must stay on the backdrop: `touch-none`
 * prevents a swipe intended to dismiss a floating menu from panning the page
 * behind it. This does NOT mutate body styles or own ESC handling — those
 * lifecycle concerns still belong to the parent.
 */
export default function DismissBackdrop({
  onDismiss,
  zIndex = 50,
  trapContextMenu = false,
  stopPropagation = false,
}: {
  onDismiss: () => void;
  /** CSS z-index value. Default 50. */
  zIndex?: number;
  /** If true, also intercepts right-click (prevents native context menu). */
  trapContextMenu?: boolean;
  /** If true, stops propagation instead of calling onDismiss (iOS phantom-click shield). */
  stopPropagation?: boolean;
}) {
  return createPortal(
    <div
      className="fixed inset-0 touch-none"
      style={{ zIndex }}
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
