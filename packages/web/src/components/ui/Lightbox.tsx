import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import type {
  ReactNode,
  HTMLAttributes,
  RefObject,
} from "react";
import { createPortal } from "react-dom";

const LightboxPortalContainerContext = createContext<RefObject<HTMLDivElement | null> | null>(null);

/**
 * Floating UI rendered from inside a Lightbox must stay in the Lightbox's
 * stacking context. Body-level portals sit below the overlay's z-index and
 * are visible to accessibility APIs while remaining impossible to click.
 */
export function useLightboxPortalContainer() {
  return useContext(LightboxPortalContainerContext);
}

/**
 * Full-screen dark-backdrop overlay for lightboxes and bottom sheets.
 *
 * Replaces the recurring pattern:
 *   <div className="fixed inset-0 z-[70] flex flex-col bg-black/75" onClick={...}>
 *
 * Used in: ImageLightbox, SelectShareLightbox, MessageItem mobile reaction sheet.
 *
 * Distinct from <Modal> (centered card) — this primitive is content-agnostic:
 * callers control layout via `className` on children. Modal stays for
 * centered-card dialogs (ConfirmDialog, CreateChannelDialog, etc.).
 *
 * Body scroll lock is applied while mounted.
 *
 * Extra HTML attributes (e.g. `data-testid`) are forwarded to the backdrop div.
 */
interface LightboxProps extends Omit<HTMLAttributes<HTMLDivElement>, "onClick" | "className" | "children"> {
  onClose: () => void;
  children: ReactNode;
  /** CSS z-index. Default 70 (above Modal's z-50/z-[60]). */
  zIndex?: number;
  /** Tailwind bg class for the backdrop. Default "bg-black/75". */
  backdropClass?: string;
  /** Click on backdrop closes. Default true. */
  dismissOnBackdrop?: boolean;
  /** Extra classes on the backdrop div (e.g. "flex flex-col"). */
  className?: string;
  /** Positioning class for the backdrop. Default fixed viewport overlay. */
  positionClass?: string;
  /** Lock body scroll while mounted. Default true. */
  lockBodyScroll?: boolean;
  /** Scroll the overlay root into view after mount. Useful for document-flow overlays. */
  scrollIntoViewOnMount?: boolean;
}

export default function Lightbox({
  onClose,
  children,
  zIndex = 70,
  backdropClass = "bg-black/75",
  dismissOnBackdrop = true,
  className = "",
  positionClass = "fixed inset-0",
  lockBodyScroll = true,
  scrollIntoViewOnMount = false,
  onPointerDownCapture,
  ...rest
}: LightboxProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const backdropPressStartedRef = useRef(false);

  // Close the topmost preview before browser-level close shortcuts can close
  // the whole tab/window.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const closeShortcut =
        e.key.toLowerCase() === "w" &&
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey;
      if (e.key !== "Escape" && !closeShortcut) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    // keydown-focus-on-open
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  // Body scroll lock
  useEffect(() => {
    const html = document.documentElement;
    const prevHtmlOverflow = html.style.overflow;
    const prevHtmlOverflowX = html.style.overflowX;
    const prevHtmlOverflowY = html.style.overflowY;
    const prevHtmlHeight = html.style.height;
    const prevBodyOverflow = document.body.style.overflow;
    const prevBodyOverflowX = document.body.style.overflowX;
    const prevBodyOverflowY = document.body.style.overflowY;
    const prevBodyHeight = document.body.style.height;

    if (lockBodyScroll) {
      document.body.style.overflow = "hidden";
    } else {
      html.style.overflowY = "auto";
      html.style.overflowX = "hidden";
      html.style.height = "auto";
      document.body.style.overflowY = "auto";
      document.body.style.overflowX = "hidden";
      document.body.style.height = "auto";
    }

    return () => {
      html.style.overflow = prevHtmlOverflow;
      html.style.overflowX = prevHtmlOverflowX;
      html.style.overflowY = prevHtmlOverflowY;
      html.style.height = prevHtmlHeight;
      document.body.style.overflow = prevBodyOverflow;
      document.body.style.overflowX = prevBodyOverflowX;
      document.body.style.overflowY = prevBodyOverflowY;
      document.body.style.height = prevBodyHeight;
    };
  }, [lockBodyScroll]);

  useEffect(() => {
    if (!scrollIntoViewOnMount) return;
    rootRef.current?.scrollIntoView({ block: "start" });
  }, [scrollIntoViewOnMount]);

  // Move focus into the overlay on open so a focused background element can't
  // swallow keys (Escape / ⌘W close, arrow nav in consumers like ImageLightbox)
  // meant for it. Guarded so we don't steal focus from content that already
  // grabbed it (autofocused inputs run first). Full Tab-cycle focus-trap is Phase 2.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (root && !root.contains(document.activeElement)) root.focus();
  }, []);

  return createPortal(
    <div
      ref={rootRef}
      tabIndex={-1}
      {...rest}
      className={`${positionClass} ${backdropClass} ${className} outline-none`}
      style={{ zIndex }}
      onPointerDownCapture={(e) => {
        backdropPressStartedRef.current = e.target === e.currentTarget;
        onPointerDownCapture?.(e);
      }}
      onClick={
        dismissOnBackdrop
          ? (e) => {
            const shouldClose = e.target === e.currentTarget && backdropPressStartedRef.current;
            backdropPressStartedRef.current = false;
            if (shouldClose) onClose();
          }
          : undefined
      }
    >
      <LightboxPortalContainerContext.Provider value={rootRef}>
        {children}
      </LightboxPortalContainerContext.Provider>
    </div>,
    document.body
  );
}
