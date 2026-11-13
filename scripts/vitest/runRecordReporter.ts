import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import type { Reporter, SerializedError, TestModule, TestRunEndReason, Vitest } from "vitest/node";

// Local-only run record: one JSON file per test run (web, server, daemon)
// under ~/.cache/raft-tests/<runId>.json, so a host (or an agent) can tell
// which run and file failed and why, even when a fork died before reporting
// results. The record is written at run start (endedAt: null) and rewritten at
// run end; a record whose endedAt stays null means the whole run was killed.
// Each run start deletes records older than RUN_RECORD_MAX_AGE_MS.

export type FailureReason = "assertion-failure" | "worker-oom-exit" | "timeout";

export interface FailedFile {
  file: string;
  reason: FailureReason;
  detail: string;
}

export interface RunRecord {
  runId: string;
  package: string;
  dom: boolean;
  maxWorkers: number;
  worktree: string;
  /** PID of the Vitest main process that drove the run (forks are its children). */
  driverPid: number;
  /** Raft agent that started the run (SLOCK_AGENT_ID), null outside an agent. */
  agentId: string | null;
  startedAt: string;
  endedAt: string | null;
  result: TestRunEndReason | null;
  failedFiles: FailedFile[];
}

export function runRecordDir(): string {
  return join(homedir(), ".cache", "raft-tests");
}

export const RUN_RECORD_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

// Only the agent identity the Raft daemon injects into every agent process;
// no other environment is read into the record.
export function agentIdFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.SLOCK_AGENT_ID || null;
}

/** Delete `<dir>/*.json` last modified more than maxAgeMs ago; returns the names removed. */
export function pruneRunRecords(dir: string, now = Date.now(), maxAgeMs = RUN_RECORD_MAX_AGE_MS): string[] {
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs <= maxAgeMs) continue;
      rmSync(path, { force: true });
      removed.push(name);
    } catch {
      // Another run may have removed it first; pruning is best effort.
    }
  }
  return removed;
}

// Vitest 5 reports a fork that dies mid-file (V8 heap-limit abort, kernel
// OOM kill) only as an unhandled pool error whose cause names the file(s):
// "Worker exited unexpectedly with signal SIGABRT during started state while
// running test file /abs/path.test.ts". The module itself stays "pending".
const unexpectedExit = /Worker exited unexpectedly (.*?)during \w+ state while running test files? (.+)$/;
const timedOut = /(?:Test|Hook) timed out in \d+ms/;

function messages(error: SerializedError | undefined, depth = 0): string[] {
  if (!error || depth > 3) return [];
  const cause = (error as { cause?: SerializedError }).cause;
  return [String(error.message ?? ""), ...messages(cause, depth + 1)];
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0] ?? "";
}

export function classifyModuleErrors(errors: readonly SerializedError[]): { reason: FailureReason; detail: string } {
  const timeout = errors.find((error) => timedOut.test(String(error.message ?? "")));
  if (timeout) return { reason: "timeout", detail: firstLine(String(timeout.message)) };
  const first = errors[0];
  const name = first?.name ? `${first.name}: ` : "";
  return { reason: "assertion-failure", detail: firstLine(`${name}${first?.message ?? "failed without an error"}`) };
}

export function crashedFiles(unhandledErrors: readonly SerializedError[]): Array<{ file: string; detail: string }> {
  const crashed: Array<{ file: string; detail: string }> = [];
  for (const error of unhandledErrors) {
    for (const message of messages(error)) {
      const match = unexpectedExit.exec(message);
      if (!match) continue;
      const detail = `worker exited ${match[1]?.trim() || "unexpectedly"}`;
      for (const file of match[2]!.split(", ")) crashed.push({ file: file.trim(), detail });
      break;
    }
  }
  return crashed;
}

function moduleErrors(module: TestModule): SerializedError[] {
  const errors: SerializedError[] = [...module.errors()];
  for (const test of module.children.allTests()) errors.push(...(test.result().errors ?? []));
  return errors;
}

export interface RunRecordReporterOptions {
  packageName: string;
  dom: boolean;
  worktree: string;
  dir?: string;
  env?: NodeJS.ProcessEnv;
}

export class RunRecordReporter implements Reporter {
  private vitest: Vitest | undefined;
  private record: RunRecord | undefined;

  constructor(private readonly options: RunRecordReporterOptions) {}

  onInit(vitest: Vitest) {
    this.vitest = vitest;
  }

  onTestRunStart() {
    const startedAt = new Date();
    pruneRunRecords(this.dir(), startedAt.getTime());
    this.record = {
      runId: `${startedAt.toISOString().replace(/[:.]/g, "-")}-${process.pid}-${randomBytes(3).toString("hex")}`,
      package: this.options.packageName,
      dom: this.options.dom,
      maxWorkers: this.vitest?.config.maxWorkers ?? 0,
      worktree: this.options.worktree,
      driverPid: process.pid,
      agentId: agentIdFromEnv(this.options.env),
      startedAt: startedAt.toISOString(),
      endedAt: null,
      result: null,
      failedFiles: [],
    };
    this.write();
  }

  onTestRunEnd(
    testModules: readonly TestModule[],
    unhandledErrors: readonly SerializedError[],
    reason: TestRunEndReason,
  ) {
    if (!this.record) return;
    const failed = new Map<string, FailedFile>();
    for (const { file, detail } of crashedFiles(unhandledErrors)) {
      failed.set(file, { file: this.relativeFile(file), reason: "worker-oom-exit", detail });
    }
    for (const module of testModules) {
      if (failed.has(module.moduleId) || module.state() !== "failed") continue;
      failed.set(module.moduleId, { file: this.relativeFile(module.moduleId), ...classifyModuleErrors(moduleErrors(module)) });
    }
    this.record.failedFiles = [...failed.values()].sort((a, b) => a.file.localeCompare(b.file));
    this.record.result = failed.size > 0 && reason === "passed" ? "failed" : reason;
    this.record.endedAt = new Date().toISOString();
    this.write();
  }

  private relativeFile(file: string): string {
    return relative(this.options.worktree, file);
  }

  private dir(): string {
    return this.options.dir ?? runRecordDir();
  }

  private write() {
    if (!this.record) return;
    try {
      const dir = this.dir();
      mkdirSync(dir, { recursive: true });
      const target = join(dir, `${this.record.runId}.json`);
      const temp = `${target}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify(this.record, null, 2)}\n`);
      renameSync(temp, target);
    } catch (error) {
      // A diagnostics write must never fail the test run.
      console.warn(`[raft-tests] could not write run record: ${(error as Error).message}`);
    }
  }
}
