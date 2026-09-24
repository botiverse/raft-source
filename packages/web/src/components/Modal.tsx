import { useEffect, useLayoutEffect, useRef } from "react";
import type { ReactNode, MouseEvent } from "react";
import { createPortal } from "react-dom";

/**
 * Reusable modal backdrop with centered content.
 * Backdrop clicks do not close by default to avoid losing in-progress form input.
 * Pass `closeOnBackdrop` to opt specific lightweight modals back in.
 * Use `layer` prop for stacking: layer=0 (default) → z-50, layer=1 → z-[60].
 *
 * Renders via portal to document.body so modals aren't clipped or repositioned
 * by parent containers with CSS transforms (e.g. mobile sidebar drawer).
 */
export default function Modal({
  onClose,
  children,
  layer = 0,
  closeOnBackdrop = false,
  closeOnEscape = true,
}: {
  onClose: () => void;
  children: ReactNode;
  layer?: number;
  closeOnBackdrop?: boolean;
  // Onboarding's gate is not dismissible: it must not be possible to tap Escape and end
  // up in an app that is not set up. Passing a no-op onClose worked by accident; saying so
  // out loud is the point (stdrc, 2026-07-13).
  closeOnEscape?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!closeOnEscape) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // keydown-focus-on-open
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closeOnEscape, onClose]);

  // Move focus into the overlay on open so a focused background element (e.g.
  // the message composer, which preventDefaults Enter) can't swallow keys meant
  // for this modal. Guarded so we never steal focus from content that already
  // grabbed it — autofocused inputs in `children` run their effect before this
  // parent effect, so document.activeElement is already inside by now. Full
  // Tab-cycle focus-trap is Phase 2 (<FocusTrap> primitive).
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (root && !root.contains(document.activeElement)) root.focus();
  }, []);

  // #5888: when a field inside the modal is focused (keyboard up on mobile),
  // scroll it into the modal's own scrollport. Body is overflow:hidden so
  // the browser will not rescue a covered input for us.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target === root) return;
      requestAnimationFrame(() => {
        target.scrollIntoView({ block: "nearest", inline: "nearest" });
      });
    };
    root.addEventListener("focusin", onFocusIn);
    return () => root.removeEventListener("focusin", onFocusIn);
  }, []);

  const handleBackdropClick = (e: MouseEvent) => {
    if (closeOnBackdrop && e.target === e.currentTarget) {
      onClose();
    }
  };

  const zClass = layer >= 1 ? "z-[60]" : "z-50";

  return createPortal(
    <div
      ref={rootRef}
      tabIndex={-1}
      className={`fixed inset-0 ${zClass} overflow-y-auto bg-black/60 outline-none`}
    >
      <div className="flex min-h-full w-full p-4" onClick={handleBackdropClick}>
        <div className="m-auto flex w-full justify-center" onClick={handleBackdropClick}>
          {children}
        </div>
      </div>
    </div>,
    document.body
  );
}
