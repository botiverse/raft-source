import { useId, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { X } from "lucide-react";
import { DEFAULT_LOCALE } from "../i18n/locale";
import type { Locale } from "../i18n/locale";
import { mergedMessages } from "../i18n/messages";
import type { MessageId } from "../i18n/messages";
import Modal from "./Modal";
import Banner from "./ui/Banner";
import Button from "./ui/Button";
import type { ButtonTone } from "./ui/Button";
import Spinner from "./ui/Spinner";

interface ConfirmDialogProps {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  loadingLabel?: string;
  confirmIcon?: ReactNode;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
  confirmDisabled?: boolean;
  /** Override the confirm button color (default: "bg-brutal-red" for destructive actions) */
  confirmColor?: string;
  /** Hide the secondary cancel action for informational acknowledgement dialogs. */
  hideCancel?: boolean;
  /** Modal stacking layer (0 = default z-50, 1 = z-[60] for nested dialogs) */
  layer?: number;
  /** Optional test id for the confirm button (e2e selection) */
  confirmTestId?: string;
  /** Let parent-managed flows keep the dialog open after an async confirm. */
  closeOnConfirm?: boolean;
  /** Width utility for dialogs with richer body content. */
  maxWidthClass?: string;
  /** Render interactive/rich body content without the default warning banner frame. */
  plainMessage?: boolean;
  /** Compact actions for confirmations embedded in already-dense surfaces. */
  actionSize?: "xs" | "sm";
  /**
   * Locale for the dialog-owned chrome (Cancel, close labels, default loading
   * and fallback error). Defaults to English so an unmigrated caller remains
   * one complete English surface. Use `active` only when every caller-owned
   * title/message/button string is migrated; pass an explicit locale for an
   * independently localized surface such as the billing WebView.
   */
  chromeLocale?: Locale | "active";
}

const CONFIRM_TONES_BY_LEGACY_COLOR: Record<string, ButtonTone> = {
  "bg-white": "white",
  "bg-soft-signal": "yellow",
  "bg-brutal-pink": "pink",
  "bg-brutal-cyan": "cyan",
  "bg-brutal-lavender": "lavender",
  "bg-brutal-orange": "orange",
  "bg-brutal-lime": "lime",
  "bg-brutal-red": "red",
  "bg-brutal-stone": "stone",
};

/**
 * Unified confirmation dialog for destructive actions.
 * Shows one concise explanation followed by Cancel / Confirm actions.
 */
export default function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  loadingLabel,
  confirmIcon,
  onConfirm,
  onClose,
  confirmDisabled = false,
  confirmColor,
  hideCancel = false,
  layer,
  confirmTestId,
  closeOnConfirm = true,
  maxWidthClass = "max-w-sm",
  plainMessage = false,
  actionSize = "sm",
  chromeLocale = DEFAULT_LOCALE,
}: ConfirmDialogProps) {
  const { formatMessage } = useIntl();
  const fixedChromeMessages = chromeLocale === "active" ? null : mergedMessages(chromeLocale);
  const formatChromeMessage = (id: MessageId) => fixedChromeMessages?.[id] ?? formatMessage({ id });
  const titleId = useId();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Caller-supplied labels win; otherwise fall back within the caller's
  // declared composition boundary.
  const resolvedConfirmLabel = confirmLabel ?? formatChromeMessage("common.confirm.defaultConfirmLabel");
  const resolvedProcessing = loadingLabel ?? formatChromeMessage("common.confirm.processing");
  const resolvedProcessingEllipsis = loadingLabel ?? formatChromeMessage("common.confirm.processingEllipsis");
  const confirmTone = CONFIRM_TONES_BY_LEGACY_COLOR[confirmColor ?? "bg-brutal-red"] ?? "red";

  const handleClose = () => {
    if (!loading) onClose();
  };

  const handleConfirm = async () => {
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
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(
        axiosErr.response?.data?.error ||
          (err instanceof Error ? err.message : formatChromeMessage("common.confirm.somethingWentWrong")),
      );
    }
  };

  return (
    <Modal onClose={handleClose} layer={layer}>
      <div
        className={`w-full ${maxWidthClass} card-brutal p-6`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={loading}
      >
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <h2 id={titleId} className="text-lg font-bold uppercase">{title}</h2>
          <button
            onClick={handleClose}
            disabled={loading}
            className="btn-brutal-sm bg-white p-1 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-30"
            aria-label={formatChromeMessage(
              loading ? "common.confirm.actionInProgress" : "common.confirm.closeDialog",
            )}
          >
            <X size={20} />
          </button>
        </div>

        {/* The title establishes the action and this is its one explanation.
            Repeating the same warning inside a second coloured panel made
            confirmations read like two competing pieces of content. Rich
            callers retain their own layout; ordinary copy gets the shared
            compact text treatment. */}
        <div
          className={plainMessage ? "mb-5" : "mb-5 text-sm leading-relaxed text-black/75"}
          data-slot="confirm-dialog-content"
        >
          {message}
        </div>

        {/* Error */}
        {error && (
          <Banner intent="warning" className="mb-4">
            {error}
          </Banner>
        )}

        {/* Actions */}
        <div className="flex flex-wrap justify-end gap-3">
          {!hideCancel && (
            <Button
              onClick={handleClose}
              disabled={loading}
              size={actionSize}
              tone="white"
              className="whitespace-nowrap disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-30"
            >
              {cancelLabel ?? formatChromeMessage("common.confirm.cancel")}
            </Button>
          )}
          <Button
            data-testid={confirmTestId}
            onClick={handleConfirm}
            disabled={loading || confirmDisabled}
            size={actionSize}
            shape={confirmIcon || loading ? "iconText" : "text"}
            tone={confirmTone}
            className="whitespace-nowrap disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-80"
            aria-busy={loading}
            aria-label={loading ? resolvedProcessingEllipsis : undefined}
          >
            {loading && <Spinner size="xs" label={resolvedProcessing} />}
            {!loading && confirmIcon}
            {loading ? resolvedProcessingEllipsis : resolvedConfirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
