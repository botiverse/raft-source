import { clearClockTimeout, setClockTimeout } from "@botiverse/raft-shared";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { copyTextToClipboard } from "../utils/selectMarkdown";

export const DEFAULT_COPY_FEEDBACK_TIMEOUT_MS = 1_400;

export interface CopyTextDependencies {
  copyText(text: string): Promise<void>;
  scheduleReset(callback: () => void, delayMs: number): unknown;
  clearReset(handle: unknown): void;
}

const defaultDependencies: CopyTextDependencies = {
  copyText: copyTextToClipboard,
  scheduleReset: setClockTimeout,
  clearReset: clearClockTimeout,
};

export interface CopyTextController {
  copied: boolean;
  pending: boolean;
  copyText(text: string): Promise<void>;
  reset(): void;
}

/**
 * Owns the shared text-copy lifecycle while leaving each caller in control of
 * its own button chrome and error presentation. A new successful copy replaces
 * the previous reset; changing identity or unmounting invalidates pending work.
 */
export function useCopyText(
  {
    resetKey,
    timeoutMs = DEFAULT_COPY_FEEDBACK_TIMEOUT_MS,
  }: {
    resetKey: unknown;
    timeoutMs?: number;
  },
  dependencies: CopyTextDependencies = defaultDependencies,
): CopyTextController {
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);
  const committedResetKeyRef = useRef(resetKey);
  const resetHandleRef = useRef<unknown | null>(null);
  const operationRef = useRef(0);
  const pendingRef = useRef(false);

  const clearPendingReset = useCallback(() => {
    if (resetHandleRef.current === null) return;
    dependencies.clearReset(resetHandleRef.current);
    resetHandleRef.current = null;
  }, [dependencies]);

  const reset = useCallback(() => {
    operationRef.current += 1;
    pendingRef.current = false;
    clearPendingReset();
    setPending(false);
    setCopied(false);
  }, [clearPendingReset]);

  // Derive the rendered feedback from the last committed identity so a new
  // identity never paints the old success state. Invalidation itself must wait
  // for commit: a render that suspends or is otherwise aborted still belongs
  // to the currently mounted identity and must not cancel its pending reset.
  const copiedForResetKey = Object.is(committedResetKeyRef.current, resetKey)
    ? copied
    : false;
  const pendingForResetKey = Object.is(committedResetKeyRef.current, resetKey)
    ? pending
    : false;

  useLayoutEffect(() => {
    if (Object.is(committedResetKeyRef.current, resetKey)) return;
    committedResetKeyRef.current = resetKey;
    operationRef.current += 1;
    pendingRef.current = false;
    clearPendingReset();
    setPending(false);
    setCopied(false);
  }, [clearPendingReset, resetKey]);

  useEffect(() => () => {
    operationRef.current += 1;
    pendingRef.current = false;
    clearPendingReset();
  }, [clearPendingReset]);

  const copyText = useCallback(async (text: string) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    const operation = operationRef.current + 1;
    operationRef.current = operation;
    clearPendingReset();

    try {
      await dependencies.copyText(text);
    } catch (error) {
      if (operationRef.current === operation) {
        pendingRef.current = false;
        setPending(false);
        setCopied(false);
      }
      throw error;
    }

    if (operationRef.current !== operation) return;
    pendingRef.current = false;
    setPending(false);
    setCopied(true);
    resetHandleRef.current = dependencies.scheduleReset(() => {
      if (operationRef.current !== operation) return;
      resetHandleRef.current = null;
      setCopied(false);
    }, timeoutMs);
  }, [clearPendingReset, dependencies, timeoutMs]);

  return { copied: copiedForResetKey, pending: pendingForResetKey, copyText, reset };
}
