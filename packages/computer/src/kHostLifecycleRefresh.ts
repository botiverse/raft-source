import {
  clearClockTimeout,
  currentTimeMs,
  setClockTimeout,
} from "@botiverse/raft-shared";
import { refreshCliLoginCarrierIfOwned } from "./macosLoginCarrier.js";
import { ComputerServiceError } from "./services/errors.js";

export interface KHostLifecycleRefreshDeps {
  now: () => number;
  setTimeoutFn: typeof setClockTimeout;
  clearTimeoutFn: typeof clearClockTimeout;
  refreshFn: typeof refreshCliLoginCarrierIfOwned;
}

/** Keep login-carrier repair inside K resume's one absolute deadline. The
 * refresh implementation owns rollback and must settle its abort before this
 * function returns, so no launchctl/file mutation can arrive after timeout. */
export async function refreshHostLifecycleWithinDeadline(
  slockHome: string,
  deadlineAtMs: number,
  overrides: Partial<KHostLifecycleRefreshDeps> = {},
): Promise<void> {
  const deps: KHostLifecycleRefreshDeps = {
    now: currentTimeMs,
    setTimeoutFn: setClockTimeout,
    clearTimeoutFn: clearClockTimeout,
    refreshFn: refreshCliLoginCarrierIfOwned,
    ...overrides,
  };
  const remainingMs = deadlineAtMs - deps.now();
  if (remainingMs <= 0) {
    throw new ComputerServiceError(
      "K_HOST_RESUME_REFRESH_TIMEOUT",
      "K_HOST_RESUME_REFRESH_TIMEOUT: macOS login-carrier refresh had no time left in the resume deadline",
    );
  }
  const controller = new AbortController();
  const timeout = deps.setTimeoutFn(() => controller.abort(), remainingMs);
  try {
    await deps.refreshFn(slockHome, {
      signal: controller.signal,
      deadlineAtMs,
      now: deps.now,
      setTimeoutFn: deps.setTimeoutFn,
      clearTimeoutFn: deps.clearTimeoutFn,
    });
  } catch (error) {
    if (
      controller.signal.aborted
      && (error as { code?: string }).code !== "HOST_LIFECYCLE_ROLLBACK_FAILED"
    ) {
      throw new ComputerServiceError(
        "K_HOST_RESUME_REFRESH_TIMEOUT",
        "K_HOST_RESUME_REFRESH_TIMEOUT: macOS login-carrier refresh exceeded the shared resume deadline and its abort settled",
        error,
      );
    }
    throw error;
  } finally {
    deps.clearTimeoutFn(timeout);
  }
}
