import { useCallback, useMemo, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { useIntl } from "react-intl";
import type { Locale } from "../i18n/locale";
import { mergedMessages } from "../i18n/messages";
import type { MessageId } from "../i18n/messages";
import Banner from "./ui/Banner";
import { trackConfirmDialogClosed } from "../analytics/confirmUndo";
import type { ConfirmDialogName } from "../analytics/confirmUndo";
import { DialogActions, DialogCommit, NarrowDialogContent } from "./ui/NarrowDialog";
import { isSecondFactorStepUpCancelled } from "./settings/secondFactorStepUp";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Spinner,
  Button,
} from "@botiverse/raft-ui";
import type { ButtonProps } from "@botiverse/raft-ui";

interface ConfirmDialogProps {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  loadingLabel?: string;
  confirmIcon?: ReactNode;
  /** After the label, such as the ↗ of a confirm that leaves Raft (design: Navigation › Links that leave Raft). */
  confirmTrailingIcon?: ReactNode;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
  confirmDisabled?: boolean;
  /** Button variant for the confirm action; its colour says the consequence
   *  (Raft Design System › Dialog). Default: `danger`. */
  confirmVariant?: ButtonProps["variant"];
  /** Hide the secondary cancel action for informational acknowledgement dialogs. */
  hideCancel?: boolean;
  /** Stacking layer (0 = default z-dialog, 1 = z-dialog-layer for nested dialogs) */
  layer?: number;
  /** Optional test id for the confirm button (e2e selection) */
  confirmTestId?: string;
  /** Let parent-managed flows keep the dialog open after an async confirm. */
  closeOnConfirm?: boolean;
  /** Width utility for dialogs with richer body content. */
  maxWidthClass?: string;
  /**
   * The raft-ui Dialog size, instead of `maxWidthClass`: `md` for a small task
   * built on this frame, such as a list with a control per row (Raft DS ›
   * Dialog › Variants). Confirmations keep the default.
   */
  size?: "sm" | "md";
  /** Render interactive/rich body content without the default warning banner frame. */
  plainMessage?: boolean;
  /** Action button size. Default `lg` is the DS default 44px button, the
   *  size every modal dialog footer uses (Dialog README: the actions are
   *  ordinary `rf-btn`s). `md` is the DS small 32px button; keep it for
   *  confirmations embedded in an already-dense surface (a card or a row),
   *  never for a modal. */
  actionSize?: "md" | "lg";
  /** Caller-owned semantic foreground override for the confirm action. */
  confirmClassName?: string;
  /**
   * Locale for the dialog-owned chrome (Cancel, close labels, default loading
   * and fallback error). Defaults to `active`: every caller's own copy is
   * migrated, so the chrome follows the display locale. The old English
   * default (#5117, partial rollout) left a Chinese dialog with an English
   * "Cancel" whenever a caller forgot to opt in. Pass an explicit locale for an
   * independently localized surface such as the billing WebView. Catalogs other
   * than en load on demand (i18n/messages), so an explicit locale must already
   * be loaded (loadLocaleMessages) or its chrome reads as English.
   */
  chromeLocale?: Locale | "active";
  /**
   * Phone presentation (< 768px; NarrowDialog). `centered` (default) is the
   * card in the middle; raft-ui moves it up while the keyboard is open, so a
   * typed field (the name to delete, a reason to reject) stays in view.
   * `sheet` moves the confirm to the head of a bottom sheet, for a
   * confirmation with more to fill than one field.
   */
  narrow?: "centered" | "sheet";
  /**
   * Where focus goes when it closes, when the control that opened it is gone
   * (Raft DS › Accessibility: the nearest related element, never the page).
   */
  finalFocus?: RefObject<HTMLElement | null> | (() => boolean);
  /**
   * `cancel`: focus starts on Cancel instead of the dialog's first control
   * (×), as in a raft-ui AlertDialog, whose first control is Cancel. For a
   * confirm that takes something away, so Enter right after it opens doesn't
   * act. Ignored with `hideCancel`.
   */
  initialFocus?: "cancel";
  /**
   * A dangerous action's confirm (#proj-analytics:#17): records `confirm_dialog_closed`,
   * `confirmed` when the person presses the confirm (once), else `cancelled` when they close it.
   */
  analyticsDialog?: ConfirmDialogName;
}

/**
 * Unified confirmation dialog for destructive actions.
 * Shows one concise explanation followed by Cancel / Confirm actions.
 *
 * Raft Design System › Dialog: the raft-ui Dialog draws the popover card
 * (16px radius, 20px padding, headline title, 15/20 ink-2 body, actions on
 * the right). The confirm button's colour says the consequence — pink
 * (`primary` / `accent`) to do a thing, orange (`warning`) for something
 * disruptive but recoverable, red (`danger`, the default) for what cannot be
 * taken back; a red confirmation carries its one explanation inside the
 * red-soft danger banner. Cancel is the quiet ghost button on the left.
 */
export default function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  loadingLabel,
  confirmIcon,
  confirmTrailingIcon,
  onConfirm,
  onClose,
  confirmDisabled = false,
  confirmVariant,
  hideCancel = false,
  layer,
  confirmTestId,
  closeOnConfirm = true,
  maxWidthClass = "max-w-sm",
  size,
  plainMessage = false,
  actionSize = "lg",
  confirmClassName,  chromeLocale = "active",
  narrow = "centered",
  finalFocus,
  initialFocus,
  analyticsDialog,
}: ConfirmDialogProps) {
  const confirmedRef = useRef(false);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const { formatMessage } = useIntl();
  const fixedChromeMessages = useMemo(
    () => (chromeLocale === "active" ? null : mergedMessages(chromeLocale)),
    [chromeLocale],
  );
  const formatChromeMessage = useCallback(
    (id: MessageId) => fixedChromeMessages?.[id] ?? formatMessage({ id }),
    [fixedChromeMessages, formatMessage],
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Caller-supplied labels win; otherwise fall back within the caller's
  // declared composition boundary.
  const resolvedConfirmLabel = confirmLabel ?? formatChromeMessage("common.confirm.defaultConfirmLabel");
  const resolvedProcessing = loadingLabel ?? formatChromeMessage("common.confirm.processing");
  const resolvedProcessingEllipsis = loadingLabel ?? formatChromeMessage("common.confirm.processingEllipsis");
  const confirmTone = confirmVariant ?? "danger";
  // Irreversible: the explanation sits in the DS danger banner (red-soft,
  // octagon glyph, ink text). Rich caller layouts (`plainMessage`) keep their
  // own structure.
  const dangerFrame = confirmTone === "danger" && !plainMessage;

  const closeLabel = formatChromeMessage(
    loading ? "common.confirm.actionInProgress" : "common.confirm.closeDialog",
  );

  const handleClose = useCallback(() => {
    if (loading) return;
    if (analyticsDialog && !confirmedRef.current) trackConfirmDialogClosed(analyticsDialog, "cancelled");
    onClose();
  }, [analyticsDialog, loading, onClose]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) handleClose();
    },
    [handleClose],
  );

  const handleConfirm = useCallback(async () => {
    if (analyticsDialog && !confirmedRef.current) {
      confirmedRef.current = true;
      trackConfirmDialogClosed(analyticsDialog, "confirmed");
    }
    setLoading(true);
    setError(null);
    try {
      await onConfirm();
      if (closeOnConfirm) {
        onClose();
      } else {
        setLoading(false);
      }
    } catch (err) {
      setLoading(false);
      // "Verify it's you" closed: nothing happened, the dialog stays as it was.
      if (isSecondFactorStepUpCancelled(err)) return;
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(
        axiosErr.response?.data?.error ||
          (err instanceof Error ? err.message : formatChromeMessage("common.confirm.somethingWentWrong")),
      );
    }
  }, [analyticsDialog, onConfirm, closeOnConfirm, onClose, formatChromeMessage]);

  return (
    <Dialog
      open
      // The old Modal frame never closed on a backdrop press for confirmations
      // (closeOnBackdrop stayed false) — keep that: only Escape, the close
      // button and Cancel dismiss, all gated on the in-flight confirm.
      disablePointerDismissal
      onOpenChange={handleOpenChange}
    >
      <NarrowDialogContent
        narrow={narrow}
        finalFocus={finalFocus}
        initialFocus={initialFocus === "cancel" && !hideCancel ? cancelRef : undefined}
        layer={(layer ?? 0) >= 1 ? 1 : 0}
        size={size}
        className={size ? undefined : maxWidthClass}
        aria-modal="true"
        aria-busy={loading}
        title={title}
        closeLabel={closeLabel}
        closeDisabled={loading}
        header={(
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogClose
              disabled={loading}
              aria-label={closeLabel}
            />
          </DialogHeader>
        )}
      >

        {/* font-normal: confirmation copy is regular-weight body text (DS
            Dialog body 15/20 ink-2), matching JointConversionConfirmDialog. */}
        {message === null && !error ? null : <DialogBody className="font-normal">
          {/* The title establishes the action and this is its one explanation.
              Repeating the same warning inside a second coloured panel made
              confirmations read like two competing pieces of content, so a
              red confirmation puts that single explanation in the danger
              banner instead of adding a second one. Rich
              callers retain their own layout; ordinary copy gets the shared
              compact text treatment. */}
          {/* No bottom margin on the body wrapper: the rui Dialog recipe
              already spaces body and footer; a leftover mb-* here doubled the
              gap (Josh's review measurement on #8468). */}
          <div
            className={plainMessage ? undefined : "text-subhead text-foreground-muted"}
            data-slot="confirm-dialog-content"
          >
            {dangerFrame ? (
              // role="note": the dialog title is what assistive tech announces;
              // the banner is static explanation, not a live alert (the
              // error banner below keeps role="alert").
              <Banner intent="destructive" withIcon role="note">
                {message}
              </Banner>
            ) : message}
          </div>

          {/* Error: a problem is orange (warning); red is for consequences. */}
          {error && (
            <Banner intent="warning" className="mt-3">
              {error}
            </Banner>
          )}
        </DialogBody>}

        {/* raft-ui 0.22 DialogFooter (#673): one row, Cancel then the commit,
            stacking full width (commit on top) only when the row doesn't fit.
            No flex-wrap here: a wrapped row never overflows, so it would
            keep the footer from stacking. */}
        <DialogActions as={DialogFooter}>
          {!hideCancel && (
            <Button
              ref={cancelRef}
              onClick={handleClose}
              disabled={loading}
              size={actionSize}
              variant="ghost"
              className="whitespace-nowrap disabled:pointer-events-none disabled:cursor-not-allowed"
            >
              {cancelLabel ?? formatChromeMessage("common.confirm.cancel")}
            </Button>
          )}
          <DialogCommit>
            {(inHead) => (
              <Button
                data-testid={confirmTestId}
                onClick={handleConfirm}
                disabled={loading || confirmDisabled}
                size={inHead ? "md" : actionSize}
                variant={confirmTone}
                className={`whitespace-nowrap disabled:pointer-events-none disabled:cursor-not-allowed ${confirmClassName ?? ""}`.trim()}
                aria-busy={loading}
                aria-label={loading ? resolvedProcessingEllipsis : undefined}
              >
                {loading && <Spinner size="xs" aria-label={resolvedProcessing} />}
                {!loading && confirmIcon}
                {loading ? resolvedProcessingEllipsis : resolvedConfirmLabel}
                {!loading && confirmTrailingIcon}
              </Button>
            )}
          </DialogCommit>
        </DialogActions>
      </NarrowDialogContent>
    </Dialog>
  );
}
