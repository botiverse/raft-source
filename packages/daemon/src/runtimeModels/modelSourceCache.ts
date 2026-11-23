import type { RuntimeModelSourceOutcome } from "@botiverse/raft-shared";

/** How long a live model list is served without a refresh. */
export const RUNTIME_MODEL_CACHE_FRESH_MS = 60_000;

/**
 * Runtimes whose listing is costly to repeat. Antigravity's (OAR 0.115) opens
 * an agy session and switches through every model to read each one's effort
 * levels; each listing leaves an agy conversation record (~390 KB) in the
 * person's profile. Its list therefore stays fresh for a day. Each catalog
 * round re-detects and replaces it: on connect (a changed agy version lifts
 * the 30-minute reconnect throttle; the agy version is read only then), on
 * every rescan or Upgrade, and on a sign-in or sign-out of Antigravity from
 * Raft (runtimeAuthHost). The form's refresh action (`force`) bypasses it. An
 * agy updated or re-signed outside Raft while the Computer stays connected
 * keeps the old list until one of those, at most a day.
 */
export const RUNTIME_MODEL_CACHE_FRESH_MS_BY_RUNTIME: Readonly<Record<string, number>> = {
  antigravity: 24 * 60 * 60_000,
};

/**
 * How a cached read was answered:
 *  - `fresh`  — a live list younger than the fresh window, no detection run;
 *  - `stale`  — an older live list, returned at once while a refresh runs in the background;
 *  - `miss`   — nothing usable cached, the caller waited for a detection;
 *  - `forced` — the caller asked to bypass the cache and waited for a detection.
 */
export type RuntimeModelCacheRead = "fresh" | "stale" | "miss" | "forced";

type LiveOutcome = Extract<RuntimeModelSourceOutcome, { kind: "live" }>;

/** `background`: a stale-entry refresh nobody waits on (it outlives the request's trace span). */
export type RuntimeModelDetect = (mode: "foreground" | "background") => Promise<RuntimeModelSourceOutcome>;

/**
 * Stale-while-revalidate cache of each runtime's detected model list, so
 * opening a create/edit form does not wait on a CLI listing every time.
 *
 * Only a live list is cached. A definitive non-live answer (not signed in, no
 * config, no models, not installed, unsupported) drops the entry: the runtime
 * said it cannot be used now, and an old list must not keep offering models.
 * A transient failure (timeout, a failed probe, a lookup that did not decide, or a retryable error naming no cause) keeps the
 * previous list, so one slow background refresh does not turn the next form
 * open back into a blocking wait.
 *
 * Runtime model lists are usable-now answers (login, plan and config change
 * them), so the cache is short (except RUNTIME_MODEL_CACHE_FRESH_MS_BY_RUNTIME)
 * and a caller can always force a fresh read.
 */
export class RuntimeModelSourceCache {
  private readonly entries = new Map<string, { outcome: LiveOutcome; atMs: number }>();
  private readonly refreshing = new Set<string>();

  constructor(
    private readonly now: () => number,
    private readonly freshMs: number = RUNTIME_MODEL_CACHE_FRESH_MS,
  ) {}

  async read(
    runtime: string,
    detect: RuntimeModelDetect,
    options: { force?: boolean } = {},
  ): Promise<{ outcome: RuntimeModelSourceOutcome; cache: RuntimeModelCacheRead }> {
    const entry = options.force ? undefined : this.entries.get(runtime);
    if (entry) {
      if (this.now() - entry.atMs < (RUNTIME_MODEL_CACHE_FRESH_MS_BY_RUNTIME[runtime] ?? this.freshMs)) return { outcome: entry.outcome, cache: "fresh" };
      this.refreshInBackground(runtime, detect);
      return { outcome: entry.outcome, cache: "stale" };
    }
    return { outcome: await this.detectAndStore(runtime, () => detect("foreground")), cache: options.force ? "forced" : "miss" };
  }

  /**
   * The last live list for `runtime`, whatever its age, with no detection run:
   * for a start that only wants to know what the Computer last listed.
   */
  peek(runtime: string): LiveOutcome["value"] | null {
    return this.entries.get(runtime)?.outcome.value ?? null;
  }

  /** Record a detection run elsewhere (the connect-time catalog push), so it warms the cache too. */
  store(runtime: string, outcome: RuntimeModelSourceOutcome): void {
    if (outcome.kind === "live") {
      this.entries.set(runtime, { outcome, atMs: this.now() });
    } else if (!isTransientFailure(outcome)) {
      this.entries.delete(runtime);
    }
  }

  private async detectAndStore(
    runtime: string,
    detect: () => Promise<RuntimeModelSourceOutcome>,
  ): Promise<RuntimeModelSourceOutcome> {
    const outcome = await detect();
    this.store(runtime, outcome);
    return outcome;
  }

  private refreshInBackground(runtime: string, detect: RuntimeModelDetect): void {
    if (this.refreshing.has(runtime)) return;
    this.refreshing.add(runtime);
    void this.detectAndStore(runtime, () => detect("background"))
      // A thrown refresh leaves the previous list in place, like a transient failure.
      .catch(() => undefined)
      .finally(() => this.refreshing.delete(runtime));
  }
}

function isTransientFailure(outcome: RuntimeModelSourceOutcome): boolean {
  if (outcome.kind !== "error" || !outcome.retryable) return false;
  if (outcome.code === undefined || outcome.code === "detect_timeout" || outcome.code === "detect_failed") return true;
  // task #1242: `runtime_not_found` with a lookup reason other than
  // `not_installed` means the PATH lookup did not decide (e.g. a Windows
  // cold-start `probe_timeout`), not that the runtime is gone. Only a
  // confirmed absence (or none given: a spawn ENOENT) drops the list.
  return outcome.code === "runtime_not_found" && outcome.reason !== undefined && outcome.reason !== "not_installed";
}
