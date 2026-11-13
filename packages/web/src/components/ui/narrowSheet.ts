import { useEffect, useState } from "react";
import type { CSSProperties } from "react";

/**
 * A phone's narrow presentation surface (NarrowDialog): a bottom sheet 90% of
 * the screen tall over the scrim, its top corners on the dialog radius like
 * raft-ui's bottom-sheet Drawer (`rounded-t-dialog`, popover layer, seam ring,
 * float shadow); it slides up (reduced motion: no slide). With the keyboard up
 * it shrinks to the visual viewport (useNarrowKeyboardBox) so its head stays
 * in view. A raft-ui DialogContent passes it as its className
 * (tailwind-merge drops the centred card's position, width, radius and ring);
 * The phone sheets (NarrowDialogContent, FramedDialogContent) use it as is.
 */
export function narrowSurfaceClass() {
  return [
    "fixed inset-x-0 top-auto bottom-0 left-0 h-[90dvh] max-h-none w-full max-w-none translate-none",
    "overflow-clip rounded-none rounded-t-dialog bg-layer-popover shadow-float ring-1 ring-line-seam",
    "narrow-dialog-enter",
    "flex flex-col text-foreground outline-none",
    "pr-[env(safe-area-inset-right,0px)] pl-[env(safe-area-inset-left,0px)]",
    // A raft-ui DialogBody inside: the phone's 16px margin, room under the
    // head's seam, the home indicator's inset at the bottom, and (a grid body
    // now taller than its content) rows packed at the top, not stretched.
    "[&_[data-slot=dialog-body]]:px-4 [&_[data-slot=dialog-body]]:pt-4 [&_[data-slot=dialog-body]]:pb-[max(16px,env(safe-area-inset-bottom,0px))] [&_[data-slot=dialog-body]]:content-start",
    // A step that brings its own framed surface (onboarding's setup steps,
    // with their own head and footer) is stretched to the surface, unframed.
    "[&>[data-slot=dialog-surface]]:min-h-0 [&>[data-slot=dialog-surface]]:max-h-none [&>[data-slot=dialog-surface]]:w-full [&>[data-slot=dialog-surface]]:max-w-none [&>[data-slot=dialog-surface]]:flex-1",
    "[&>[data-slot=dialog-surface]]:rounded-none [&>[data-slot=dialog-surface]]:shadow-none [&>[data-slot=dialog-surface]]:ring-0",
  ].join(" ");
}

/**
 * The sheet's box while the on-screen keyboard is up: the visual viewport
 * (less the same 10% the sheet leaves open), so the head stays in view and the
 * body scrolls above the keyboard. `undefined` otherwise (the CSS box).
 */
export function useNarrowKeyboardBox(active: boolean): CSSProperties | undefined {
  const [box, setBox] = useState<CSSProperties | undefined>(undefined);
  useEffect(() => {
    const viewport = typeof window === "undefined" ? undefined : window.visualViewport;
    if (!active || !viewport) return;
    const update = () => {
      const focused = document.activeElement;
      const editing = focused instanceof HTMLInputElement
        || focused instanceof HTMLTextAreaElement
        || (focused instanceof HTMLElement && focused.isContentEditable);
      const keyboardUp = editing && window.innerHeight - viewport.height > 100;
      const height = Math.round(Math.min(viewport.height, window.innerHeight * 0.9));
      const top = Math.round(Math.max(viewport.offsetTop, 0) + viewport.height - height);
      setBox((previous) => {
        if (!keyboardUp) return previous === undefined ? previous : undefined;
        return previous?.top === `${top}px` && previous?.height === `${height}px`
          ? previous
          : { top: `${top}px`, bottom: "auto", height: `${height}px` };
      });
    };
    // The keyboard opening resizes the visual viewport, so listening is enough.
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update, { passive: true });
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
    };
  }, [active]);
  return active ? box : undefined;
}
