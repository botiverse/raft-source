/**
 * Runs `run` when the browser is next idle, or after `timeoutMs` at the latest
 * (requestIdleCallback's own timeout). Where there is no requestIdleCallback
 * (Safari), it runs on the next task.
 */
export function whenIdle(run: () => void, timeoutMs = 2_000): void {
  const idle = (globalThis as { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number })
    .requestIdleCallback;
  if (idle) idle(run, { timeout: timeoutMs });
  else setTimeout(run, 0);
}
