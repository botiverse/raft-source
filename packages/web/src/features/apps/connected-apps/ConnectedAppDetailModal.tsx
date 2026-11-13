import { Dialog, DialogBody, DialogClose, DialogHeader } from "@botiverse/raft-ui";
import { useCallback, useRef } from "react";
import type { ReactNode } from "react";
import { NarrowDialogContent } from "../../../components/ui/NarrowDialog";

/**
 * An app's details (installed or in the directory): a centred card, on a
 * phone too (view-only dialogs stay centred; stdrc, Artea, 2026-10-21), at the
 * DS Dialog's lg width (640) for its key-value facts. A raft-ui Dialog: Base
 * UI owns Esc, the focus trap and focus return; the body scrolls between the
 * identity head and the footer. No scrim press, as the old Modal.
 */
export function ConnectedAppDetailModal({
  labelledBy,
  onClose,
  closeLabel,
  identity,
  footer,
  children,
}: {
  /** The card's aria-labelledby: the id of the app's name in its identity block. */
  labelledBy: string;
  onClose: () => void;
  closeLabel: string;
  identity: ReactNode;
  footer: ReactNode;
  children: ReactNode;
}) {
  const popupRef = useRef<HTMLDivElement | null>(null);
  const handleOpenChange = useCallback((open: boolean) => { if (!open) onClose(); }, [onClose]);
  return (
    // disablePointerDismissal is deliberate, as the old Modal: a stray press doesn't lose the place in a long detail.
    <Dialog open disablePointerDismissal onOpenChange={handleOpenChange}>
      <NarrowDialogContent
        ref={popupRef}
        narrow="centered"
        size="lg"
        // Focus starts on the dialog itself, as the old Modal: not on ×.
        initialFocus={popupRef}
        title={null}
        closeLabel={closeLabel}
        aria-labelledby={labelledBy}
        header={(
          <DialogHeader className="items-start">
            {identity}
            <DialogClose aria-label={closeLabel} />
          </DialogHeader>
        )}
      >
        {/* The body scrolls (overflow-y-auto, flex-1 in a max-height dialog), so
            its sections must keep their own height: a raft-ui Card is
            overflow-hidden, whose automatic minimum height is 0, and as a
            shrinkable flex item it was squeezed to a sliver once the detail
            outgrew the dialog (the App setup section, title spilling onto the
            next one). shrink-0 on every section; the body scrolls instead. */}
        <DialogBody className="flex flex-col gap-4 pt-4 pb-4 text-foreground *:shrink-0" data-testid="connected-app-detail-body">
          {children}
        </DialogBody>
        <div className="shrink-0 px-(--surface-inset) pb-(--surface-inset)">{footer}</div>
      </NarrowDialogContent>
    </Dialog>
  );
}
