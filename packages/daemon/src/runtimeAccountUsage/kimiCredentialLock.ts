import { closeSync, constants, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

import lockfile from "proper-lockfile";

/**
 * task #1282 — the Kimi Code client's own refresh lock, taken the same way it
 * takes it (kimi-code `OAuthManager.acquireRefreshLock`, identical in 0.31.1
 * and 2.1.1): proper-lockfile on the sentinel `<home>/oauth/<storageName>`
 * (the lock directory is `<target>.lock`), stale after 5 s, `realpath: false`.
 * The client retries 120 times at 0.5–1 s; this daemon's wait is bounded
 * (default ~10 s) and a lock it cannot take is a bounded failure, never a
 * reason to touch the credentials without it.
 *
 * The client takes no lock on win32 or with `KIMI_DISABLE_OAUTH_LOCK=1`; the
 * daemon does not refresh at all in those states (reported as
 * `platform_unsupported`), so the lock is never bypassed from our side.
 */
export const KIMI_LOCK_STALE_MS = 5_000;

export interface KimiLockOptions {
  /** Retry schedule; the default waits about 10 s. */
  retries?: { retries: number; factor: number; minTimeout: number; maxTimeout: number };
  staleMs?: number;
}

const DEFAULT_RETRIES = { retries: 12, factor: 1, minTimeout: 500, maxTimeout: 1_000 } as const;

export type KimiLockResult<T> =
  | { kind: "held"; value: T }
  | { kind: "unavailable"; reason: string };

/**
 * What `fn` sees of the lock while it runs. proper-lockfile renews the lock's
 * mtime every `stale / 2` (2.5 s) and reports the lock as compromised when the
 * mtime is no longer ours or the lock directory vanished (another holder
 * reclaimed a lock it judged stale, or the directory was removed). A
 * compromised lock must stop any write that was about to rely on it.
 */
export interface KimiLockHandle {
  isCompromised(): boolean;
  /** The error proper-lockfile reported, when compromised. */
  compromisedBy(): Error | null;
}

/**
 * Creates the lock sentinel the way it is safe to: a home this daemon creates first (the user never ran Kimi) is
 * private (0700), and the sentinel is never reached through a symbolic link:
 * an existing link is refused, and the open itself does not follow one.
 */
export function prepareKimiLockSentinel(target: string): void {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  let existing: ReturnType<typeof lstatSync> | undefined;
  try {
    existing = lstatSync(target);
  } catch {
    existing = undefined;
  }
  if (existing?.isSymbolicLink()) throw new Error("lock sentinel is a symbolic link");
  if (existing !== undefined && !existing.isFile()) throw new Error("lock sentinel is not a regular file");
  const noFollow = constants.O_NOFOLLOW ?? 0;
  closeSync(openSync(target, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | noFollow, 0o600));
}

/**
 * Runs `fn` while holding the client's refresh lock. Returns `unavailable`
 * (without running `fn`) when the lock cannot be prepared or taken in time.
 * The lock is released after `fn` settles, never before. The library's
 * default compromise handler throws out of a timer; here it only marks the
 * handle, so the caller decides (and never writes once it is marked).
 */
export async function withKimiRefreshLock<T>(target: string, fn: (handle: KimiLockHandle) => Promise<T>, options: KimiLockOptions = {}): Promise<KimiLockResult<T>> {
  try {
    prepareKimiLockSentinel(target);
  } catch (error) {
    return { kind: "unavailable", reason: `cannot prepare lock sentinel: ${error instanceof Error ? error.message : String(error)}` };
  }
  let release: (() => Promise<void>) | undefined;
  let compromised: Error | null = null;
  const handle: KimiLockHandle = {
    isCompromised: () => compromised !== null,
    compromisedBy: () => compromised,
  };
  try {
    release = await lockfile.lock(target, {
      retries: options.retries ?? DEFAULT_RETRIES,
      stale: options.staleMs ?? KIMI_LOCK_STALE_MS,
      realpath: false,
      onCompromised: (error) => {
        compromised = error;
      },
    });
  } catch (error) {
    return { kind: "unavailable", reason: `cannot acquire refresh lock: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    return { kind: "held", value: await fn(handle) };
  } finally {
    try {
      await release();
    } catch {
      // released or stale-reclaimed; nothing else to do
    }
  }
}

/** True when another holder currently owns the lock (used by tests and diagnostics). */
export async function isKimiRefreshLockHeld(target: string): Promise<boolean> {
  try {
    return await lockfile.check(target, { stale: KIMI_LOCK_STALE_MS, realpath: false });
  } catch {
    return false;
  }
}
