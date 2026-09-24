// Computer-side concurrency control (RFC v0.8 contract v6 §3.2 / PR-H).
//
// Raft Computer holds local state under a single SLOCK_HOME. Multiple
// CLI invocations (e.g. `raft-computer attach` running while another
// shell `raft-computer status` polls) can race on file mutations. This
// module provides advisory locks scoped to the SLOCK_HOME so mutating
// commands serialize cleanly across processes.
//
// Lock surface:
//   ~/.slock/computer/.lock — proper-lockfile dir lock
//
// Lock policy (per §3.2):
//   - Read-only commands (status, doctor, runners list, logs): no lock
//     — they read state via single-shot file reads which are inherently
//     atomic at the file level; multiple readers are safe.
//   - Mutating commands (attach, start, stop, upgrade, runners stop):
//     exclusive lock with 5s timeout. Timeout → `CONCURRENT_OPERATION`
//     error with stable code.
//
// Why proper-lockfile: cross-platform (Windows + Unix), atomic directory
// ownership, freshness updates, and ownership-aware stale recovery.

import lockfile from "proper-lockfile";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { computerDir, resolveRaftHome } from "./paths.js";
import { fail } from "./output.js";
import { ComputerError } from "./lib/errors.js";

const STALE_LOCK_THRESHOLD_MS = 60_000;

/** @internal Timing seam used by the real child-process compromise test. */
export interface MutationLockOptions {
  staleMs?: number;
  updateMs?: number;
}

type LockOwnershipState =
  | "acquiring"
  | "owned"
  | "compromised"
  | "releasing"
  | "released";

/**
 * Acquire the SLOCK_HOME-scoped mutation lock, run `fn`, then release.
 *
 * Failure modes:
 *   - Another process holds the lock and doesn't release within 5s →
 *     throw CliExit with code `CONCURRENT_OPERATION`.
 *   - fn throws → lock is still released; the original error propagates.
 *   - Process crashes mid-fn → proper-lockfile detects on next acquire
 *     via stale-lock + pid check + our cleanupStaleLock fast-path.
 */
export async function withMutationLock<T>(
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  try {
    return await withComputerMutationLock(resolveRaftHome(), fn);
  } catch (err) {
    if (
      err instanceof ComputerError &&
      (err.code === "CONCURRENT_OPERATION" ||
        err.code === "MUTATION_LOCK_COMPROMISED")
    ) {
      fail(err.code, err.message);
    }
    throw err;
  }
}

/**
 * Library/GUI-safe variant of the mutation lock. Unlike `withMutationLock`,
 * this throws `ComputerError` instead of writing the CLI stderr fail shape.
 */
export async function withComputerMutationLock<T>(
  slockHome: string,
  fn: (signal: AbortSignal) => Promise<T>,
  options: MutationLockOptions = {},
): Promise<T> {
  const lockTarget = computerDir(slockHome);
  // proper-lockfile locks a path that must exist. Ensure the directory
  // is present (it's also created lazily by other operations).
  await mkdir(lockTarget, { recursive: true });

  // Override the default sibling-style `<target>.lock` path (would put
  // the lock at `~/.slock/computer.lock`, outside `computerDir`) with
  // the v7 §10-documented `~/.slock/computer/.lock` inside the computer
  // dir. Without this override, `cleanupStaleLock`
  // (which targets `~/.slock/computer/.lock`) misses the real blocking
  // lock — per @Jianwei PR-H regression msg=b79d7aff blocker.
  const lockfilePath = join(lockTarget, ".lock");

  let release: (() => Promise<void>) | null = null;
  let ownership: LockOwnershipState = "acquiring";
  let compromiseError: ComputerError | null = null;
  const abortController = new AbortController();
  let resolveCompromised!: (error: ComputerError) => void;
  const compromised = new Promise<ComputerError>((resolve) => {
    resolveCompromised = resolve;
  });
  try {
    // Retry config tuned so worst-case acquisition is ~5s (RFC §3.2 contract).
    // retries=10, min=200, max=800, factor=1.5 → ~200+300+450+675+800+800+800+800+800+800 ≈ 5.6s
    // Per @liuliu commit-2 review (msg=27d54012): align with RFC's stated 5s timeout
    // rather than the implicit ~3.5s.
    release = await lockfile.lock(lockTarget, {
      lockfilePath,
      stale: options.staleMs ?? STALE_LOCK_THRESHOLD_MS,
      ...(options.updateMs === undefined ? {} : { update: options.updateMs }),
      retries: {
        retries: 10,
        minTimeout: 200,
        maxTimeout: 800,
        factor: 1.5,
      },
      realpath: false,
      onCompromised: (cause) => {
        if (
          ownership === "released" ||
          ownership === "releasing" ||
          ownership === "compromised"
        ) return;
        ownership = "compromised";
        const error = new ComputerError(
          "MUTATION_LOCK_COMPROMISED",
          "This Computer command lost its mutation lock while it was running. The operation was stopped without a completion guarantee. Run `raft-computer doctor` before retrying.",
        );
        Object.defineProperty(error, "cause", { value: cause });
        compromiseError = error;
        abortController.abort(error);
        resolveCompromised(error);
      },
    });
    if (compromiseError) throw compromiseError;
    ownership = "owned";
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ELOCKED" || code === "ECOMPROMISED") {
      throw new ComputerError(
        "CONCURRENT_OPERATION",
        "Another Computer command is currently mutating state. Wait a moment and retry.",
      );
    }
    throw err;
  }
  try {
    const operation = fn(abortController.signal).then(
      (value) => ({ kind: "result" as const, value }),
      (error: unknown) => ({ kind: "error" as const, error }),
    );
    const outcome = await Promise.race([
      operation,
      compromised.then((error) => ({ kind: "error" as const, error })),
    ]);
    if (outcome.kind === "error") throw outcome.error;
    return outcome.value;
  } finally {
    if (release && ownership === "owned") {
      ownership = "releasing";
      try {
        await release();
      } catch {
        /* release-on-cleanup is best-effort; stale-lock cleanup will mop up */
      } finally {
        ownership = "released";
      }
    }
  }
}
