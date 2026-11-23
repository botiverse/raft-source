import type { InstallationSnapshot, Runtime, UpdateCheck } from "@botiverse/oar";
import {
  RUNTIME_UPDATE_CHECK_MAX_AGE_MS,
  RUNTIME_UPDATE_CHECK_UNAVAILABLE_REASONS,
  runtimeUpdateCheckSchema,
  runtimeUpgradeVersion,
  type RuntimeAuthRuntime,
  type RuntimeUpdateCheck,
  type RuntimeUpdateCheckUnavailableReason,
} from "@botiverse/raft-shared";

/**
 * Upgrade on the web: whether a runtime the Computer can upgrade has a newer
 * version, from OAR's read-only `checkUpdate` (never an install, never a
 * change to the runtime's update settings), so the web offers Upgrade only
 * where there is one (docs/contracts/runtime-auth.md §6d). Runs only for a
 * server that reads the answer (SERVER_CAPABILITY_RUNTIME_UPDATE_CHECK_V1).
 *
 * A status report never waits on a check: it carries the answers kept for
 * the installation it just read (`keptFor`) and starts the missing ones in
 * the background (`start`, one per runtime at a time). Once every started
 * check has settled, `onSettled` asks for one more report, which finds them
 * kept and starts nothing. Each answer is kept for a day per runtime (a
 * failed one for an hour), keyed by the installation's command and version:
 * a changed installation (a move, an upgrade the rescan sees) is checked
 * again. A person's rescan of the Computer's runtimes, and the end of an
 * Upgrade, drop what is kept (`forget`). Only the versions and the verdict
 * leave here, never OAR's `source` or `detail` (URLs, paths).
 */

/** The bound on one runtime's background check (with its installation probe, when it needs one). */
export const RUNTIME_UPDATE_CHECK_TIMEOUT_MS = 15_000;
/** How long an answer is kept for the same installation. */
export const RUNTIME_UPDATE_CHECK_CACHE_MS = RUNTIME_UPDATE_CHECK_MAX_AGE_MS;
/** How long a failed lookup (a network error, a timeout, a throw, a probe that failed) is kept: retried well before a day. */
export const RUNTIME_UPDATE_CHECK_FAILURE_CACHE_MS = 60 * 60_000;

export interface RuntimeUpdateChecksDeps {
  now(): number;
  /** Every check `start` began has settled, and one kept a new answer: report again, so it goes out. */
  onSettled(): void;
  /** RUNTIME_UPDATE_CHECK_TIMEOUT_MS when absent. */
  timeoutMs?: number;
}

interface Kept {
  /** The installation the answer is for (its command and installed version); null: the probe itself failed. */
  key: string | null;
  atMs: number;
  check: RuntimeUpdateCheck;
}

type Checkable = Extract<InstallationSnapshot, { via: "executable" }>;

const TIMED_OUT = Symbol("timed out");

/** The executable OAR's checker takes (a usable one, or one too old to sign in), or null: nothing to check. */
function checkable(installation: InstallationSnapshot): Checkable | null {
  if (installation.kind === "available") return installation.via === "executable" ? installation : null;
  return installation.kind === "unsupported" && installation.code === "version_unsupported" ? installation : null;
}

function keyOf(installation: Checkable): string {
  return `${installation.command}\0${installation.kind === "available" ? installation.version ?? "" : installation.installedVersion ?? ""}`;
}

export class RuntimeUpdateChecks {
  private readonly kept = new Map<RuntimeAuthRuntime, Kept>();
  private readonly running = new Set<RuntimeAuthRuntime>();
  /** Bumped by `forget()` (all) and `forget(id)` (that runtime's): a check that began before it is not kept. */
  private generation = 0;
  private readonly runtimeGenerations = new Map<RuntimeAuthRuntime, number>();
  /** A check settled since the last `onSettled` with something a report should carry (or retry). */
  private reportDue = false;

  constructor(private readonly deps: RuntimeUpdateChecksDeps) {}

  /**
   * The answer kept for this installation while it is fresh, or null (none
   * yet, stale, another installation, nothing to check). With no installation
   * read (a runtime whose status has its own path: OpenCode), any fresh
   * answer for an installation: a rescan or an Upgrade still drops it.
   */
  keptFor(id: RuntimeAuthRuntime, installation: InstallationSnapshot | undefined): RuntimeUpdateCheck | null {
    const kept = this.fresh(id);
    if (!kept || kept.key === null) return null;
    if (!installation) return kept.check;
    const target = checkable(installation);
    return target && kept.key === keyOf(target) ? kept.check : null;
  }

  /**
   * Starts this runtime's check in the background unless one is running, or
   * a fresh answer is kept for this installation (or, with no installation
   * read, any fresh answer or failed probe is). Probes the installation only
   * when none is given. Never throws; true when a check began.
   */
  start(id: RuntimeAuthRuntime, runtime: Pick<Runtime, "installation" | "checkUpdate">, installation?: InstallationSnapshot): boolean {
    const { checkUpdate, installation: probe } = runtime;
    if (!checkUpdate || !probe || this.running.has(id)) return false;
    const target = installation ? checkable(installation) : null;
    if (installation && !target) return false;
    const kept = this.fresh(id);
    if (kept && (target === null || kept.key === keyOf(target))) return false;
    this.running.add(id);
    const generation = this.generationOf(id);
    void this.run(target, probe, checkUpdate).then((outcome) => {
      if (generation !== this.generationOf(id)) {
        // Forgotten while it ran: not kept, and the next report starts it again.
        this.reportDue = true;
      } else if (outcome) {
        this.kept.set(id, { ...outcome, atMs: this.deps.now() });
        this.reportDue = true;
      }
      this.running.delete(id);
      if (this.running.size > 0 || !this.reportDue) return;
      // Only for something new: a report that finds every answer kept starts nothing, so this cannot loop.
      this.reportDue = false;
      this.deps.onSettled();
    });
    return true;
  }

  /** Drops what is kept for this runtime, or for every runtime; a check of it running now is not kept either. */
  forget(id?: RuntimeAuthRuntime): void {
    if (id) {
      this.runtimeGenerations.set(id, (this.runtimeGenerations.get(id) ?? 0) + 1);
      this.kept.delete(id);
    } else {
      this.generation += 1;
      this.kept.clear();
    }
  }

  /**
   * Keeps an answer OAR gave elsewhere for this installation: an Upgrade that
   * found nothing newer (`current`) carries the check it ran, so it is not
   * asked again. Nothing for an installation there is nothing to check on.
   */
  seed(id: RuntimeAuthRuntime, installation: InstallationSnapshot, check: UpdateCheck): void {
    const target = checkable(installation);
    if (!target) return;
    const atMs = this.deps.now();
    this.kept.set(id, { key: keyOf(target), atMs, check: updateCheckForServer(check, atMs) });
  }

  private generationOf(id: RuntimeAuthRuntime): string {
    return `${this.generation}:${this.runtimeGenerations.get(id) ?? 0}`;
  }

  private fresh(id: RuntimeAuthRuntime): Kept | null {
    const kept = this.kept.get(id);
    return kept && this.deps.now() - kept.atMs < keepMs(kept.check) ? kept : null;
  }

  /** One bounded check; null: nothing to check after all (the probe found no executable). Never rejects. */
  private async run(
    given: Checkable | null,
    probe: NonNullable<Runtime["installation"]>,
    checkUpdate: NonNullable<Runtime["checkUpdate"]>,
  ): Promise<{ key: string | null; check: RuntimeUpdateCheck } | null> {
    const timeoutMs = this.deps.timeoutMs ?? RUNTIME_UPDATE_CHECK_TIMEOUT_MS;
    const startedAt = this.deps.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      timer.unref?.();
    });
    let key: string | null = null;
    try {
      let target = given;
      if (!target) {
        const probed = await Promise.race([probe(), deadline]);
        // A probe that ran out of time: kept under no installation, so it is not retried on every report.
        if (probed === TIMED_OUT) return { key: null, check: unavailable("lookup_failed", startedAt) };
        target = checkable(probed);
        if (!target) return null;
      }
      key = keyOf(target);
      const remainingMs = Math.max(1, timeoutMs - (this.deps.now() - startedAt));
      const answer = await Promise.race([checkUpdate(target, { timeoutMs: remainingMs }), deadline]);
      return { key, check: answer === TIMED_OUT ? unavailable("lookup_failed", startedAt) : updateCheckForServer(answer, startedAt) };
    } catch {
      return { key, check: unavailable("lookup_failed", startedAt) };
    } finally {
      clearTimeout(timer);
    }
  }
}

function keepMs(check: RuntimeUpdateCheck): number {
  return check.kind === "unavailable" && check.reason === "lookup_failed" ? RUNTIME_UPDATE_CHECK_FAILURE_CACHE_MS : RUNTIME_UPDATE_CHECK_CACHE_MS;
}

function unavailable(reason: RuntimeUpdateCheckUnavailableReason, atMs: number): RuntimeUpdateCheck {
  return { kind: "unavailable", reason, checkedAt: new Date(atMs).toISOString() };
}

/**
 * OAR's answer without its source, channel or detail. A version that is not a
 * plain release version is `version_unreadable`; a reason this build does not
 * know is `lookup_failed`.
 */
export function updateCheckForServer(check: UpdateCheck, atMs: number): RuntimeUpdateCheck {
  if (check.kind === "unavailable") {
    const reason = (RUNTIME_UPDATE_CHECK_UNAVAILABLE_REASONS as readonly string[]).includes(check.reason)
      ? check.reason as RuntimeUpdateCheckUnavailableReason
      : "lookup_failed";
    return unavailable(reason, atMs);
  }
  const installed = runtimeUpgradeVersion(check.installed);
  const latest = runtimeUpgradeVersion(check.latest);
  if (!installed || !latest || typeof check.updateAvailable !== "boolean") return unavailable("version_unreadable", atMs);
  return runtimeUpdateCheckSchema.parse({ kind: "ok", installed, latest, updateAvailable: check.updateAvailable, checkedAt: new Date(atMs).toISOString() });
}

/** The trace's word for a check: its verdict or why there is none. Never a version, a source or a path. */
export function updateCheckTraceOutcome(check: RuntimeUpdateCheck | undefined): string | undefined {
  if (!check) return undefined;
  if (check.kind === "ok") return check.updateAvailable ? "update_available" : "latest";
  return check.reason;
}
