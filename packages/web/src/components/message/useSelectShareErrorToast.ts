import { useEffect, useEffectEvent, useRef } from "react";
import { useIntl } from "react-intl";
import { toast } from "@botiverse/raft-ui";

/**
 * The select-share failure receipt (Save image / Copy as
 * Markdown) as a raft-ui toast: the neutral HUD, the problem pixel, the
 * message and Retry as the toast's one text action (no Dismiss, raft-ui 0.28).
 *
 * `picError` stays the source of truth: the toast shows while it is set, and
 * when the toast closes (on its own after the provider's timeout, paused on
 * hover and focus, or by a swipe or Esc) the error is cleared, so the same
 * failure can be reported again (raft-design toast.md, feedback.md).
 */
export function useSelectShareErrorToast({
  picError,
  setPicError,
  onRetry,
}: {
  picError: string | null;
  setPicError: (value: string | null) => void;
  onRetry: () => void;
}): void {
  const { formatMessage } = useIntl();
  // The toast on screen for the current error; cleared before this hook
  // dismisses it, so only a close by the person clears the error.
  const activeToastIdRef = useRef<string | null>(null);
  const retry = useEffectEvent(() => onRetry());
  const clearError = useEffectEvent(() => setPicError(null));
  const describe = useEffectEvent((error: string) => ({
    title: formatMessage({ id: "message.chatPanel.imageActionFailed" }, { error }),
    retryLabel: formatMessage({ id: "message.share.retry" }),
  }));

  useEffect(() => {
    if (!picError) return;
    const { title, retryLabel } = describe(picError);
    const id = toast.error(title, {
      action: { label: retryLabel, onClick: () => retry() },
      onClose: () => {
        if (activeToastIdRef.current !== id) return;
        activeToastIdRef.current = null;
        clearError();
      },
    });
    activeToastIdRef.current = id;
    return () => {
      if (activeToastIdRef.current === id) activeToastIdRef.current = null;
      toast.dismiss(id);
    };
  }, [picError]);
}
