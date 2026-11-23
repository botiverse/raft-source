import type { InstallPlan, InstallPlanner, InstallResult, Installer, Runtime } from "@botiverse/oar";
import {
  RUNTIME_INSTALL_TIMEOUT_MS,
  runtimeInstallPlanSchema,
  runtimeInstallResultSchema,
  runtimeUpgradeVersion,
  type RuntimeAuthRuntime,
  type RuntimeInstallPlan,
  type RuntimeInstallResult,
} from "@botiverse/raft-shared";

/**
 * Installs a runtime that is not on this Computer when a person pressed
 * Install on the web and confirmed the plan (`machine:runtime:install_plan`,
 * `machine:runtime:install`, DAEMON_CAPABILITY_RUNTIME_INSTALL). Never on its
 * own: Raft does not install runtimes automatically. The request names only
 * the runtime: what runs is the vendor's official installer as OAR knows it
 * (`Runtime.installPlan` / `Runtime.install`), at the vendor's latest
 * version, never a command from the web.
 *
 * - The plan's steps (display strings, which can name a home path) go only
 *   in the answer to the person who asked (the server may hold it in their
 *   machine operation until read, at most 10 min): never logged, traced or
 *   audited (the trace has the step count).
 * - The installer's output never leaves the Computer: only the outcome's
 *   kind and version are answered, the output's length traced.
 * - A runtime with parallel release lines (OpenCode: `installLines`) is
 *   installed on the line Raft offers for it (INSTALL_LINES: OpenCode 2.x,
 *   #oar-raft:#41); one with lines but none chosen here is not offered. An
 *   OpenCode 1.x already on the Computer stays: OAR answers
 *   `already_installed` and replaces nothing.
 */
export type RuntimeInstallHostMessage =
  | { type: "machine:runtime:install_plan:result"; requestId: string; result: RuntimeInstallPlan }
  | { type: "machine:runtime:install:result"; requestId: string; result: RuntimeInstallResult };

export interface RuntimeInstallHostDeps {
  /** OAR's runtime for this sign-in id (the same loader the sign-ins and Upgrade use). */
  loadRuntime(id: RuntimeAuthRuntime): Promise<Runtime>;
  send(message: RuntimeInstallHostMessage): void;
  /** Re-detects the runtimes and reports them (as `machine:runtimes:rescan` does): the card leaves "not installed". */
  rescan(): void;
  recordEvent(name: string, attrs: Record<string, string | number | boolean | undefined>): void;
  now(): number;
  /** Whether Raft runs this runtime on this Computer at all (Qoder and Qwen Code not on Windows); every runtime when absent. */
  runsHere?(id: RuntimeAuthRuntime): boolean;
  /** OAR's bound for the installer run; RUNTIME_INSTALL_TIMEOUT_MS when absent. */
  timeoutMs?: number;
}

/**
 * Runtimes with nothing to install from the web: Kimi Code runs on the
 * bundled SDK (it moves with the Computer), Pi signs in per provider on its
 * own store and is not a CLI Raft installs.
 */
const NOT_INSTALLABLE: ReadonlySet<RuntimeAuthRuntime> = new Set(["kimi", "pi"]);

/** The release line Install puts on a runtime that has several (OAR `installLines`): new OpenCode installs are 2.x (tygg, #oar-raft:#41). */
const INSTALL_LINES: Readonly<Partial<Record<RuntimeAuthRuntime, string>>> = { opencode: "v2" };

/** The line to pass OAR for this runtime: INSTALL_LINES' when the runtime offers it, undefined for one without lines, null when it has lines but not that one. */
function installLineOf(id: RuntimeAuthRuntime, runtime: Pick<Runtime, "installLines">): string | undefined | null {
  if (!runtime.installLines || runtime.installLines.length === 0) return undefined;
  const line = INSTALL_LINES[id];
  return line && runtime.installLines.some((entry) => entry.line === line) ? line : null;
}

/** Whether to load the runtime at all to ask `runtimeInstallable` (Kimi Code and Pi never are). */
export function runtimeMayBeInstallable(id: RuntimeAuthRuntime): boolean {
  return !NOT_INSTALLABLE.has(id);
}

/**
 * Whether the web may offer Install for this runtime: its OAR runtime has an
 * installer and its planner and an installation probe, and either declares
 * no parallel release lines or offers the one Raft installs (INSTALL_LINES).
 */
export function runtimeInstallable(id: RuntimeAuthRuntime, runtime: Pick<Runtime, "installation" | "install" | "installPlan" | "installLines">): boolean {
  return runtimeMayBeInstallable(id)
    && Boolean(runtime.installation && runtime.install && runtime.installPlan)
    && installLineOf(id, runtime) !== null;
}

export class RuntimeInstallHost {
  /** One install per runtime at a time: a second request answers `in_progress`. */
  private readonly running = new Set<RuntimeAuthRuntime>();

  constructor(private readonly deps: RuntimeInstallHostDeps) {}

  /** What Install would run here, read without running anything. */
  async plan(requestId: string, runtimeId: RuntimeAuthRuntime): Promise<void> {
    const startedAt = this.deps.now();
    let result: RuntimeInstallPlan;
    try {
      result = await this.readPlan(runtimeId);
    } catch {
      result = { kind: "error", code: "internal" };
    }
    this.deps.recordEvent("daemon.runtime.install.plan", {
      runtime: runtimeId,
      outcome: result.kind,
      ...(result.kind === "unsupported" ? { reason: result.reason } : {}),
      step_count: result.kind === "error" ? undefined : (result.steps?.length ?? 0),
      duration_ms: this.deps.now() - startedAt,
    });
    this.deps.send({ type: "machine:runtime:install_plan:result", requestId, result });
  }

  async install(requestId: string, runtimeId: RuntimeAuthRuntime): Promise<void> {
    if (this.running.has(runtimeId)) {
      this.answer(requestId, runtimeId, { kind: "error", code: "in_progress" }, { durationMs: 0 });
      return;
    }
    this.running.add(runtimeId);
    const startedAt = this.deps.now();
    let result: RuntimeInstallResult;
    let outputLength: number | undefined;
    try {
      const outcome = await this.run(runtimeId);
      result = outcome.result;
      outputLength = outcome.outputLength;
    } catch {
      result = { kind: "error", code: "internal" };
    } finally {
      this.running.delete(runtimeId);
    }
    // The runtime is there now (or was all along, unseen): versions, sign-in and models are read again.
    if (result.kind === "installed" || result.kind === "already_installed") this.deps.rescan();
    this.answer(requestId, runtimeId, result, { durationMs: this.deps.now() - startedAt, outputLength });
  }

  /** The runtime's planner and installer, when the web may install it here; otherwise why not, as OAR would say it. */
  private async installer(runtimeId: RuntimeAuthRuntime): Promise<
    | { ok: true; installPlan: InstallPlanner; install: Installer; line: string | undefined }
    | { ok: false; unsupported: { kind: "unsupported"; reason: "bundled" | "platform" } }
  > {
    if (!runtimeMayBeInstallable(runtimeId)) return { ok: false, unsupported: { kind: "unsupported", reason: "bundled" } };
    if (this.deps.runsHere && !this.deps.runsHere(runtimeId)) return { ok: false, unsupported: { kind: "unsupported", reason: "platform" } };
    const runtime = await this.deps.loadRuntime(runtimeId);
    // No installer: nothing to install here (OAR's word for a bundled SDK).
    if (!runtime.install || !runtime.installPlan) return { ok: false, unsupported: { kind: "unsupported", reason: "bundled" } };
    // Lines but not the one Raft installs: no line, so OAR answers `line_required` (Raft never picks another).
    const line = installLineOf(runtimeId, runtime) ?? undefined;
    return { ok: true, installPlan: runtime.installPlan.bind(runtime), install: runtime.install.bind(runtime), line };
  }

  private async readPlan(runtimeId: RuntimeAuthRuntime): Promise<RuntimeInstallPlan> {
    const found = await this.installer(runtimeId);
    if (!found.ok) return found.unsupported;
    return installPlanForServer(await found.installPlan(found.line ? { line: found.line } : undefined));
  }

  private async run(runtimeId: RuntimeAuthRuntime): Promise<{ result: RuntimeInstallResult; outputLength?: number }> {
    const found = await this.installer(runtimeId);
    if (!found.ok) return { result: found.unsupported };
    // The plan's line; OAR probes first and runs nothing for one already there (an OpenCode 1.x included).
    const outcome = await found.install({ timeoutMs: this.deps.timeoutMs ?? RUNTIME_INSTALL_TIMEOUT_MS, ...(found.line ? { line: found.line } : {}) });
    return { result: installResultForServer(outcome), ...("output" in outcome ? { outputLength: outcome.output.length } : {}) };
  }

  private answer(
    requestId: string,
    runtimeId: RuntimeAuthRuntime,
    result: RuntimeInstallResult,
    trace: { durationMs: number; outputLength?: number },
  ): void {
    this.deps.recordEvent("daemon.runtime.install", {
      runtime: runtimeId,
      outcome: result.kind,
      ...(result.kind === "installed" || result.kind === "already_installed" ? { version: result.version } : {}),
      ...(result.kind === "failed" ? { exit_code: result.exitCode ?? "none" } : {}),
      ...(result.kind === "unsupported" ? { reason: result.reason } : {}),
      ...(result.kind === "error" ? { code: result.code } : {}),
      duration_ms: trace.durationMs,
      output_length: trace.outputLength,
    });
    this.deps.send({ type: "machine:runtime:install:result", requestId, result });
  }
}

/**
 * OAR's plan as the person reads it: each step's `display` (never its argv),
 * the vendor's page, and for `unsupported` the reason, OAR's plain-words
 * detail and the steps to run by hand where OAR gives them. Checked against
 * the shared schema: a plan it refuses (a step too long, a source that is not
 * https) is thrown, so the caller answers `error {internal}`.
 */
export function installPlanForServer(plan: InstallPlan): RuntimeInstallPlan {
  const mapped: RuntimeInstallPlan = plan.kind === "plan"
    ? { kind: "plan", steps: plan.steps.map((step) => step.display), source: plan.source }
    : {
      kind: "unsupported",
      reason: plan.reason,
      ...(plan.detail ? { detail: plan.detail } : {}),
      ...(plan.steps && plan.steps.length > 0 ? { steps: plan.steps.map((step) => step.display) } : {}),
      ...(plan.steps && plan.steps.length > 0 && plan.source ? { source: plan.source } : {}),
    };
  return runtimeInstallPlanSchema.parse(mapped);
}

/** The release version in what a CLI printed (`opencode v2.0.27` -> `2.0.27`); the text itself when it holds none. */
function releaseVersionOf(printed: string | undefined): string | undefined {
  return printed?.match(/\d+\.\d+\.\d+[0-9A-Za-z.+_-]*/)?.[0] ?? printed;
}

/** OAR's outcome without its output, installation (a command path), detail or steps; a version that is not a plain release version is left out. */
export function installResultForServer(outcome: InstallResult): RuntimeInstallResult {
  const mapped: RuntimeInstallResult = (() => {
    switch (outcome.kind) {
      case "installed":
      case "already_installed": {
        const version = runtimeUpgradeVersion(releaseVersionOf(outcome.installation.via === "executable" ? outcome.installation.version : undefined));
        return { kind: outcome.kind, ...(version ? { version } : {}) };
      }
      case "failed":
        return { kind: "failed", exitCode: outcome.exitCode };
      case "unsupported":
        return { kind: "unsupported", reason: outcome.reason };
    }
  })();
  return runtimeInstallResultSchema.parse(mapped);
}
