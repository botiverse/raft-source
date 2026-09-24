import { useCallback } from "react";
import type { MouseEventHandler, ReactNode } from "react";
import {
  useCopyText,
} from "../../hooks/useCopyText";
import type {
  CopyTextController,
} from "../../hooks/useCopyText";

interface CopyButtonRenderProps {
  copied: boolean;
  pending: boolean;
  disabled: boolean;
  onMouseDown: MouseEventHandler<HTMLButtonElement>;
  onClick: () => void;
}

interface CopyButtonBaseProps {
  text: string | (() => string);
  enabled?: boolean;
  onCopyStart?: () => void;
  onCopyError?: (error: unknown) => void;
  children: (props: CopyButtonRenderProps) => ReactNode;
}

type CopyButtonProps = CopyButtonBaseProps & (
  | {
      controller: CopyTextController;
      resetKey?: never;
      timeoutMs?: never;
    }
  | {
      controller?: never;
      resetKey: unknown;
      timeoutMs?: number;
    }
);

const preventRepeatedClickSelection: MouseEventHandler<HTMLButtonElement> = (event) => {
  // Keep ordinary first-click focus behavior. Chromium begins native nearby-
  // content selection on the second mouse-down, before `dblclick` is emitted.
  if (event.detail > 1) event.preventDefault();
};

function CopyButtonView({
  controller,
  text,
  enabled = true,
  onCopyStart,
  onCopyError,
  children,
}: CopyButtonBaseProps & { controller: CopyTextController }) {
  const handleCopy = useCallback(async () => {
    if (!enabled || controller.pending) return;
    onCopyStart?.();
    try {
      await controller.copyText(typeof text === "function" ? text() : text);
    } catch (error) {
      onCopyError?.(error);
    }
  }, [controller, enabled, onCopyError, onCopyStart, text]);

  return children({
    copied: controller.copied,
    pending: controller.pending,
    disabled: !enabled || controller.pending,
    onMouseDown: preventRepeatedClickSelection,
    onClick: () => void handleCopy(),
  });
}

function StandaloneCopyButton({
  resetKey,
  timeoutMs,
  ...props
}: CopyButtonBaseProps & { resetKey: unknown; timeoutMs?: number }) {
  const controller = useCopyText({ resetKey, timeoutMs });
  return <CopyButtonView {...props} controller={controller} />;
}

/**
 * Headless copy-button component. It owns clipboard/feedback behavior but
 * renders no wrapper, so each surface retains its existing button and tooltip
 * DOM. Pass a controller only when several visible triggers share one status.
 */
export default function CopyButton(props: CopyButtonProps) {
  if (props.controller) {
    const { controller, ...viewProps } = props;
    return <CopyButtonView {...viewProps} controller={controller} />;
  }
  const { resetKey, timeoutMs, ...viewProps } = props;
  return <StandaloneCopyButton {...viewProps} resetKey={resetKey} timeoutMs={timeoutMs} />;
}
