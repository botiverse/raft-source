import { useEffect, useLayoutEffect, useRef } from "react";
import type { HTMLAttributes, ReactNode } from "react";
import { createPortal } from "react-dom";

export interface BottomSheetProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  children: ReactNode;
  onClose: () => void;
  /** CSS z-index. Default 50 to match modal-layer surfaces. */
  zIndex?: number;
  /** Click outside the sheet closes it. Default true. */
  dismissOnBackdrop?: boolean;
  /** Lock body scroll while mounted. Default true. */
  lockBodyScroll?: boolean;
  /** Width class for the sheet card. */
  widthClass?: string;
  /** Extra classes on the sheet card. */
  sheetClassName?: string;
}

/**
 * Mobile bottom sheet primitive.
 *
 * Unlike Lightbox, this has no dim backdrop. The sheet itself carries the
 * dialog affordance via brutal border + shadow while staying anchored to the
 * bottom safe area.
 */
export default function BottomSheet({
  children,
  onClose,
  zIndex = 50,
  dismissOnBackdrop = true,
  lockBodyScroll = true,
  widthClass = "max-w-md",
  sheetClassName = "",
  className = "",
  ...rest
}: BottomSheetProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // keydown-focus-on-open
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Move focus into the sheet on open so a focused background element can't
  // swallow keys (e.g. Escape) meant for it. Guarded so we don't steal focus
  // from content that already grabbed it (autofocused inputs run first). Full
  // Tab-cycle focus-trap is Phase 2.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (root && !root.contains(document.activeElement)) root.focus();
  }, []);

  useEffect(() => {
    if (!lockBodyScroll) return;
    const prevBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevBodyOverflow;
    };
  }, [lockBodyScroll]);

  return createPortal(
    <div
      {...rest}
      ref={rootRef}
      tabIndex={-1}
      className={`fixed inset-x-0 bottom-0 p-3 pb-[max(12px,env(safe-area-inset-bottom))] outline-none ${className}`}
      style={{ zIndex, ...rest.style }}
      onClick={
        dismissOnBackdrop
          ? (e) => {
              if (e.target === e.currentTarget) onClose();
            }
          : undefined
      }
    >
      <div
        className={`mx-auto border-2 border-black bg-white shadow-brutal-lg ${widthClass} ${sheetClassName}`}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
