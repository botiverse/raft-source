import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Reporter, SerializedError, TestCase, TestModule, TestRunEndReason, Vitest } from "vitest/node";
import {
  DEV_TRACE_SCHEMA_VERSION,
  appendRows,
  caseId,
  collectIdentity,
  devTraceEnabled,
  errorFingerprint,
  firstRepoFrame,
  isCiEnv,
  safeErrorText,
  safeLabel,
  spoolPath,
  uuidv7,
  type DevCaseRow,
  type DevErrorKind,
  type DevRunIdentity,
  type DevRunResult,
  type DevRunRow,
} from "../devtrace/devTrace";

// Records every Vitest run (local and CI) into the development-process trace:
// one dev.runs row and one dev.cases row per test case, appended to the local
// spool at run end; a detached uploader ships the spool (scripts/devtrace/upload.ts).
// Must never slow down or fail a run: all work is in-memory until one append
// at the end, every step is wrapped, and RAFT_DEV_TRACE=0 disables it.

// Environment as it was when the config was loaded: some configs (packages/cli)
// delete every RAFT_*/SLOCK_* variable before workers fork, which would
// otherwise drop the agent identity and RAFT_DEV_TRACE* settings.
const LOAD_ENV: NodeJS.ProcessEnv = { ...process.env };

const timedOut = /(?:Test|Hook) timed out in \d+ms/;
const workerExit = /Worker exited unexpectedly/;

export function errorKindOf(error: { message?: string; name?: string } | undefined): DevErrorKind {
  const message = String(error?.message ?? "");
  if (timedOut.test(message)) return "timeout";
  if (workerExit.test(message)) return "worker_exit";
  if (error?.name === "AssertionError" || /expected .* to /i.test(message)) return "assertion";
  return "exception";
}

export function runResultOf(reason: TestRunEndReason, failedCases: number): DevRunResult {
  if (reason === "interrupted") return "interrupted";
  if (reason === "failed" || failedCases > 0) return "fail";
  return "pass";
}

export interface DevTraceReporterOptions {
  packageName: string;
  worktree: string;
  env?: NodeJS.ProcessEnv;
  /** Test seam: spool path and whether to start the uploader. */
  spool?: string;
  upload?: boolean;
}

export class DevTraceReporter implements Reporter {
  private vitest: Vitest | undefined;
  private runId = "";
  private startedAt = 0;
  private identity: Promise<DevRunIdentity | undefined> = Promise.resolve(undefined);

  constructor(private readonly options: DevTraceReporterOptions) {}

  private get env(): NodeJS.ProcessEnv {
    return this.options.env ?? LOAD_ENV;
  }

  onInit(vitest: Vitest) {
    this.vitest = vitest;
  }

  onTestRunStart() {
    this.startedAt = Date.now();
    this.runId = uuidv7(this.startedAt);
    // Async git calls run alongside the tests; awaited only at run end.
    this.identity = collectIdentity(this.options.worktree, this.env).catch(() => undefined);
  }

  async onTestRunEnd(testModules: readonly TestModule[], unhandledErrors: readonly SerializedError[], reason: TestRunEndReason) {
    try {
      const identity = await this.identity;
      if (!identity) return;
      const rows = this.buildRows(testModules, unhandledErrors, reason, Date.now(), identity);
      const path = this.options.spool ?? spoolPath(this.env);
      if (appendRows(rows, path) > 0 && (this.options.upload ?? !isCiEnv(this.env))) startUploader(path, this.env);
    } catch {
      // Telemetry must never affect the run.
    }
  }

  buildRows(
    testModules: readonly TestModule[],
    unhandledErrors: readonly SerializedError[],
    reason: TestRunEndReason,
    endedAt: number,
    identity: DevRunIdentity,
  ): Array<DevRunRow | DevCaseRow> {
    const startedAtIso = new Date(this.startedAt).toISOString();
    const cases: DevCaseRow[] = [];
    for (const module of testModules) {
      const file = relative(this.options.worktree, module.moduleId);
      for (const test of module.children.allTests()) cases.push(this.caseRow(test, file, startedAtIso, identity));
    }
    const failed = cases.filter((row) => row.state === "failed").length;
    const run: DevRunRow = {
      table: "runs",
      schema_v: DEV_TRACE_SCHEMA_VERSION,
      run_id: this.runId,
      kind: "test",
      tool: "vitest",
      tool_version: this.vitest?.version ?? null,
      package: this.options.packageName,
      argv: relativeArgv(process.argv.slice(2), this.options.worktree),
      started_at: startedAtIso,
      ended_at: new Date(endedAt).toISOString(),
      duration_ms: Math.max(0, endedAt - this.startedAt),
      result: unhandledErrors.length > 0 && reason === "passed" ? "error" : runResultOf(reason, failed),
      cases_total: cases.length,
      cases_failed: failed,
      cases_skipped: cases.filter((row) => row.state === "skipped" || row.state === "todo").length,
      cases_flaky: cases.filter((row) => row.flaky).length,
      ...identity,
    };
    return [run, ...cases];
  }

  private caseRow(test: TestCase, file: string, startedAt: string, identity: DevRunIdentity): DevCaseRow {
    const result = test.result();
    const diagnostic = test.diagnostic();
    const state = result.state === "pending" ? "skipped" : result.state === "skipped" && test.options.mode === "todo" ? "todo" : result.state;
    const error = result.state === "failed" ? result.errors[0] : undefined;
    const suite = test.fullName.endsWith(test.name) ? test.fullName.slice(0, -test.name.length).replace(/\s*>\s*$/, "") : "";
    const message = error ? `${error.name ? `${error.name}: ` : ""}${error.message ?? ""}` : "";
    return {
      table: "cases",
      schema_v: DEV_TRACE_SCHEMA_VERSION,
      run_id: this.runId,
      started_at: startedAt,
      case_id: caseId(this.options.packageName, file, test.fullName),
      package: this.options.packageName,
      file,
      suite: safeLabel(suite, 300),
      name: safeLabel(test.name, 300),
      state,
      duration_ms: diagnostic ? Math.round(diagnostic.duration) : null,
      retry_count: diagnostic?.retryCount ?? 0,
      flaky: diagnostic?.flaky ?? false,
      error_kind: error ? errorKindOf(error) : null,
      error_fp: error ? errorFingerprint(message, firstRepoFrame(error.stack, this.options.worktree)) : null,
      error_text: error ? safeErrorText(message) : null,
      commit_sha: identity.commit_sha,
      dirty: identity.dirty,
      where: identity.where,
      actor: identity.actor,
    };
  }
}

/** Command-line arguments with absolute worktree paths made relative, capped at 1 KiB. */
export function relativeArgv(argv: readonly string[], worktree: string): string {
  const joined = argv
    .map((arg) => (arg.startsWith(worktree) ? relative(worktree, arg) || "." : arg))
    .join(" ");
  return safeLabel(joined, 1024);
}

const uploaderScript = fileURLToPath(new URL("../devtrace/upload.ts", import.meta.url));

/** Starts the uploader detached; the run never waits for it. */
export function startUploader(spool: string, env: NodeJS.ProcessEnv): void {
  try {
    if (!env.RAFT_DEV_TRACE_URL || !existsSync(uploaderScript)) return;
    const child = spawn(process.execPath, ["--import", "@oxc-node/core/register", uploaderScript, "--spool", spool], {
      detached: true,
      stdio: "ignore",
      env,
    });
    child.unref();
  } catch {
    // Best effort.
  }
}

/** Repository root (this file is scripts/vitest/devTraceReporter.ts). */
export const DEV_TRACE_WORKTREE = fileURLToPath(new URL("../..", import.meta.url));

// Added through configureVitest so it survives a CLI --reporter override.
// Every Vitest config in the repo adds it, local and CI alike; watch mode and
// RAFT_DEV_TRACE=0 skip it.
export function devTracePlugin(packageName: string, worktree = DEV_TRACE_WORKTREE) {
  const options = { packageName, worktree };
  return {
    name: "raft-dev-trace",
    configureVitest({ vitest }: { vitest: { config: { reporters: unknown[]; watch?: boolean } } }) {
      if (!devTraceEnabled(LOAD_ENV) || vitest.config.watch) return;
      if (vitest.config.reporters.some((entry) => entry instanceof DevTraceReporter)) return;
      vitest.config.reporters.push(new DevTraceReporter(options));
    },
  };
}
