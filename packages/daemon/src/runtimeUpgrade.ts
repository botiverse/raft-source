import type { AvailableInstallation, Runtime, UpdateCheck, UpgradeResult, VersionUnsupportedInstallation } from "@botiverse/oar";
import {
  RUNTIME_UPGRADE_TIMEOUT_MS,
  runtimeUpgradeResultSchema,
  runtimeUpgradeVersion,
  type RuntimeAuthRuntime,
  type RuntimeUpgradeResult,
} from "@botiverse/raft-shared";

/**
 * Runs a runtime's own updater when a person pressed Upgrade on the web
 * (`machine:runtime:upgrade`, DAEMON_CAPABILITY_RUNTIME_UPGRADE). Never on its
 * own: Raft does not upgrade runtimes automatically. OAR resolves the
 * installation and judges the outcome by the version the executable reports
 * afterwards. Only the outcome's kind and versions are answered; the
 * updater's output (paths, tokens in a proxy URL) is never sent, logged or
 * traced, only its length.
 */
export interface RuntimeUpgradeHostDeps {
  /** OAR's runtime for this sign-in id (the same loader the sign-ins use). */
  loadRuntime(id: RuntimeAuthRuntime): Promise<Runtime>;
  send(message: { type: "machine:runtime:upgrade:result"; requestId: string; result: RuntimeUpgradeResult }): void;
  /** Re-detects the runtimes and reports them (as `machine:runtimes:rescan` does): versions, sign-in status, models. */
  rescan(): void;
  /**
   * The end of an Upgrade whose updater ran (`upgraded`, `unchanged`): what
   * the Computer kept of this runtime's update check is stale
   * (runtimeUpdateCheck.ts), so the next report checks fresh.
   */
  forgetUpdateCheck?(runtime: RuntimeAuthRuntime): void;
  /**
   * `current`: OAR's check just found nothing newer for this installation;
   * kept as this runtime's update check, so it is not asked again.
   */
  keepUpdateCheck?(runtime: RuntimeAuthRuntime, installation: AvailableInstallation | VersionUnsupportedInstallation, check: UpdateCheck): void;
  recordEvent(name: string, attrs: Record<string, string | number | boolean | undefined>): void;
  now(): number;
  /** OAR's bound for its update check and, again, for the updater run; RUNTIME_UPGRADE_TIMEOUT_MS when absent. */
  timeoutMs?: number;
}

/**
 * Runtimes whose sign-in is not an OAR CLI this daemon could update: Kimi
 * Code runs on the bundled SDK (it moves with the Computer), Pi signs in per
 * provider on its own store.
 */
const NOT_A_CLI: ReadonlySet<RuntimeAuthRuntime> = new Set(["kimi", "pi"]);

/** Whether this runtime's own updater can run from the web: a CLI whose OAR runtime has `upgrade`. */
export function runtimeUpgradable(id: RuntimeAuthRuntime, runtime: Pick<Runtime, "installation" | "upgrade">): boolean {
  return !NOT_A_CLI.has(id) && Boolean(runtime.installation) && Boolean(runtime.upgrade);
}

/** Whether to load the runtime at all to ask `runtimeUpgradable` (Kimi Code and Pi never are). */
export function runtimeMayBeUpgradable(id: RuntimeAuthRuntime): boolean {
  return !NOT_A_CLI.has(id);
}

export class RuntimeUpgradeHost {
  /** One upgrade per runtime at a time: a second request answers `in_progress`. */
  private readonly running = new Set<RuntimeAuthRuntime>();

  constructor(private readonly deps: RuntimeUpgradeHostDeps) {}

  async upgrade(requestId: string, runtime: RuntimeAuthRuntime): Promise<void> {
    if (this.running.has(runtime)) {
      this.answer(requestId, runtime, { kind: "error", code: "in_progress" }, { durationMs: 0 });
      return;
    }
    this.running.add(runtime);
    const startedAt = this.deps.now();
    let result: RuntimeUpgradeResult;
    let outputLength: number | undefined;
    try {
      const outcome = await this.run(runtime);
      result = outcome.result;
      outputLength = outcome.outputLength;
    } catch {
      result = { kind: "error", code: "internal" };
    } finally {
      this.running.delete(runtime);
    }
    // An Upgrade that ran (or may have) leaves the kept update check stale; a
    // `current` one kept the check OAR returned with it (above).
    if (result.kind === "upgraded" || result.kind === "unchanged") this.deps.forgetUpdateCheck?.(runtime);
    // An updater ran (or may have), or OAR just read the installed version
    // (`current`): the runtime's version, sign-in and models are read again,
    // and the status report that follows carries the update check. A CLI that
    // updated itself outside Raft answers `current` with a version the last
    // scan never saw, and the Computer page would keep the old one.
    if (result.kind === "upgraded" || result.kind === "unchanged" || result.kind === "current") this.deps.rescan();
    this.answer(requestId, runtime, result, { durationMs: this.deps.now() - startedAt, outputLength });
  }

  private async run(runtimeId: RuntimeAuthRuntime): Promise<{ result: RuntimeUpgradeResult; outputLength?: number }> {
    if (!runtimeMayBeUpgradable(runtimeId)) return { result: { kind: "unsupported", reason: "unsupported_installation" } };
    const runtime = await this.deps.loadRuntime(runtimeId);
    if (!runtimeUpgradable(runtimeId, runtime) || !runtime.installation || !runtime.upgrade) return { result: { kind: "unsupported", reason: "unsupported_installation" } };
    const installation = await runtime.installation();
    if (installation.kind === "not_found") return { result: { kind: "not_installed" } };
    // A CLI OAR finds too old (`version_unsupported`, OAR 0.112) is exactly the
    // one the web's "update it" notice offers this for; OAR's updater takes it
    // as it is. Any other unusable installation stays unsupported.
    const upgradable = installation.kind === "available" || (installation.kind === "unsupported" && installation.code === "version_unsupported");
    if (!upgradable) return { result: { kind: "unsupported", reason: "unsupported_installation" } };
    const outcome = await runtime.upgrade(installation, { timeoutMs: this.deps.timeoutMs ?? RUNTIME_UPGRADE_TIMEOUT_MS });
    if (outcome.kind === "current") this.deps.keepUpdateCheck?.(runtimeId, installation, outcome.check);
    return { result: upgradeResultForServer(outcome), ...("output" in outcome ? { outputLength: outcome.output.length } : {}) };
  }

  private answer(
    requestId: string,
    runtime: RuntimeAuthRuntime,
    result: RuntimeUpgradeResult,
    trace: { durationMs: number; outputLength?: number },
  ): void {
    this.deps.recordEvent("daemon.runtime.upgrade", {
      runtime,
      outcome: result.kind,
      ...(result.kind === "upgraded" ? { from_version: result.from, to_version: result.to } : {}),
      ...(result.kind === "current" || result.kind === "unchanged" ? { version: result.version } : {}),
      ...(result.kind === "failed" ? { exit_code: result.exitCode ?? "none" } : {}),
      ...(result.kind === "unsupported" ? { reason: result.reason } : {}),
      ...(result.kind === "error" ? { code: result.code } : {}),
      duration_ms: trace.durationMs,
      output_length: trace.outputLength,
    });
    this.deps.send({ type: "machine:runtime:upgrade:result", requestId, result });
  }
}

/** OAR's outcome without its output, check or detail; a version that is not a plain release version is left out. */
export function upgradeResultForServer(outcome: UpgradeResult): RuntimeUpgradeResult {
  const version = runtimeUpgradeVersion;
  const mapped: RuntimeUpgradeResult = (() => {
    switch (outcome.kind) {
      case "upgraded": {
        const from = version(outcome.from);
        const to = version(outcome.to);
        return { kind: "upgraded", ...(from ? { from } : {}), ...(to ? { to } : {}) };
      }
      case "current": {
        const current = version(outcome.version);
        return { kind: "current", ...(current ? { version: current } : {}) };
      }
      case "unchanged": {
        const current = version(outcome.version);
        return { kind: "unchanged", ...(current ? { version: current } : {}) };
      }
      case "failed":
        return { kind: "failed", exitCode: outcome.exitCode };
      case "unsupported":
        return { kind: "unsupported", reason: outcome.reason };
    }
  })();
  return runtimeUpgradeResultSchema.parse(mapped);
}
