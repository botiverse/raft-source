import { Dialog, DialogDescription, DialogTitle, ScrollArea } from "@botiverse/raft-ui";
import type { DialogProps } from "@botiverse/raft-ui";
import CloseButton from "./CloseButton";
import { X } from "lucide-react";
import { useCallback, useRef } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { ICON_BAR_END_PULL } from "./headEdges";
import { NarrowDialogContent, useNarrowPresentation } from "./NarrowDialog";
import type { DialogNarrow } from "./NarrowDialog";
import { isFromForeignLayer } from "./useOverlayLayer";

type OpenChangeDetails = Parameters<NonNullable<DialogProps["onOpenChange"]>>[1];

type DialogCardProps = {
  title: ReactNode;
  titleId?: string;
  /** DialogDescription: one sentence under the title, muted callout text that wraps. */
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  maxWidthClass?: string;
  testId?: string;
  /** raft-ui's layer: 1 (or more) lifts the card and its scrim to z-60, for a card rendered outside the tree of the
   *  surface it opens over (raft-ui Dialog docs). A card rendered inside another dialog's tree stacks by itself, but
   *  sits at that dialog's layer: inside a layer-1 dialog it is layer 1 too. */
  layer?: number;
  /** A press on the scrim closes the card. Off by default: a form isn't thrown away by a stray click. */
  closeOnBackdrop?: boolean;
  /** Phone presentation (< 768px). Default: the centred card. */
  narrow?: DialogNarrow;
};

/**
 * Product dialog shell for small forms (Create Agent, Add/Edit MCP, …): a
 * raft-ui Dialog. Base UI owns Escape, the focus trap, the page's inertness
 * and focus return; while it is open it is a modal layer of the shortcut
 * registry (NarrowDialogContent), so global commands (⌘K …) stop under it.
 *
 * Raft Design System › Dialog (`rf-dialog`): raft-ui's DialogContent (the
 * popover layer, dialog radius, seam edge and float shadow, no motion) with
 * 20px padding, a sentence-case headline title (17/22 700) and a quiet ghost
 * close in the top right. A card taller than the window scrolls inside it.
 *
 * As the Modal it replaces: no scrim press unless `closeOnBackdrop`, focus
 * starting on the dialog itself unless a field inside took it (autoFocus),
 * and an Escape something inside took (a mention list) leaves it open.
 *
 * `narrow` is how it presents on a phone (NarrowDialog): `centered` (the
 * card, which raft-ui raises while the keyboard is open), `sheet` for a
 * bigger form (wrap the button row in DialogActions and the commit in
 * DialogCommit). Desktop is the same card either way.
 *
 * A card opened from another dialog (Edit provider connection from Create
 * Agent or the runtime editor) is rendered inside that dialog's tree, so
 * raft-ui stacks it: its own lighter scrim, and Esc closes only the top one.
 */
export default function DialogCard({
  title,
  titleId,
  description,
  onClose,
  children,
  maxWidthClass = "max-w-md",
  testId,
  closeOnBackdrop = false,
  layer,
  narrow = "centered",
}: DialogCardProps) {
  const { formatMessage } = useIntl();
  const popupRef = useRef<HTMLDivElement | null>(null);
  const sheet = useNarrowPresentation(narrow) === "sheet";
  const closeLabel = formatMessage({ id: "common.close" });
  const handleOpenChange = useCallback((open: boolean, details: OpenChangeDetails) => {
    if (open) return;
    // A dialog or a lightbox opened over this card from outside its tree closes on its own Escape; Base UI's
    // document listener hears that Escape too, and it isn't this dialog's.
    if (details.reason === "escape-key" && isFromForeignLayer(details.event, popupRef.current)) {
      details.cancel();
      return;
    }
    onClose();
  }, [onClose]);

  return (
    <Dialog open disablePointerDismissal={!closeOnBackdrop} onOpenChange={handleOpenChange}>
      <NarrowDialogContent
        ref={popupRef}
        narrow={narrow}
        // Focus starts on the dialog itself, as the old Modal: not on ×. A
        // field that autofocused is already inside, and Base UI leaves it there.
        initialFocus={popupRef}
        layer={(layer ?? 0) >= 1 ? 1 : 0}
        className={maxWidthClass}
        testId={testId}
        wrapBody
        title={title}
        titleId={titleId}
        closeLabel={closeLabel}
        header={null}
      >
        {sheet ? (
          <>
            {description ? <DialogDescription className="mb-3">{description}</DialogDescription> : null}
            {children}
          </>
        ) : (
          <ScrollArea
            data-slot="dialog-card"
            className="min-h-0 flex-1"
            contentClassName="flex min-w-0 flex-col p-5 md:pointer-fine:p-(--page-inset)"
          >
            <div className={`${description ? "" : "mb-4 "}flex items-start justify-between gap-2`}>
              <DialogTitle id={titleId} className="min-w-0 font-sans text-headline text-foreground">{title}</DialogTitle>
              <CloseButton
                type="button"
                size="icon-md"
                onClick={onClose}
                aria-label={closeLabel}
                className={`-my-1.5 ${ICON_BAR_END_PULL} shrink-0`}
              >
                <X size={18} />
              </CloseButton>
            </div>
            {description ? <DialogDescription className="mb-4 mt-1">{description}</DialogDescription> : null}
            {children}
          </ScrollArea>
        )}
      </NarrowDialogContent>
    </Dialog>
  );
}
