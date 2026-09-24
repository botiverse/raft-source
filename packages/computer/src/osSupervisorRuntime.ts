import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { currentDate } from "@botiverse/raft-shared";
import {
  buildOsSupervisorSpec,
  buildSupervisorCommandPlan,
  classifySupervisorDefinition,
  isOwnedHistoricalLaunchdDefinition,
  type BuildOsSupervisorSpecInput,
  type OsSupervisorSpec,
  type SupervisorCommand,
} from "./osSupervisor.js";
import { createWindowsPowerShellChildEnv } from "./windowsPowerShellEnv.js";

const execFileAsync = promisify(execFile);
const OS_SUPERVISOR_COMMAND_TIMEOUT_MS = 5_000;

/**
 * `HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)`. With `/HRESULT`, schtasks exits
 * with this value when — and, in the shape we probed, only when — the named task
 * does not exist. A caller who may not READ the task exits `0x80070005` instead,
 * so absence and unreadability no longer share one reading.
 *
 * This is an exact allowlist of ONE code, deliberately. We do not claim to have
 * enumerated every non-missing failure; safety comes from everything else —
 * other numerics, string codes like `ENOENT`, timeouts, spawn failures —
 * falling through to `incomplete`.
 */
const WINDOWS_TASK_MISSING_HRESULT = 0x80070002;

/**
 * The same 32 bits spelled signed: `-2147024894`. Node reports this HRESULT
 * unsigned on the paths we measured, but a plain int32 exit code is the same
 * value, so both spellings are accepted — and nothing else is.
 */
const WINDOWS_TASK_MISSING_HRESULT_SIGNED = WINDOWS_TASK_MISSING_HRESULT | 0;

/**
 * Carries the child's numeric exit code across `runPlan`'s rewrap. Without this
 * the plan path loses `.code` and the only thing left to classify on is the
 * message text — which is the defect being fixed.
 */
class SupervisorCommandError extends Error {
  readonly exitCode: number | null;
  constructor(message: string, exitCode: number | null) {
    super(message);
    this.name = "SupervisorCommandError";
    this.exitCode = exitCode;
  }
}

/**
 * The child's exit code as a number, or null when there is not one.
 *
 * A string `code` (`"ENOENT"` when the binary is missing) and a non-finite value
 * both yield null rather than being coerced: "we could not run it" must never be
 * able to normalize into "the task is not there".
 */
export function supervisorExitCode(error: unknown): number | null {
  const candidate = error as { exitCode?: unknown; code?: unknown };
  const raw = candidate?.exitCode ?? candidate?.code;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw)) return null;
  return raw;
}

/**
 * Absence for a Windows scheduled task, decided from the typed exit code alone.
 * Never from stderr text: that text is localized, and on a non-UTF8 console
 * codepage it also arrives mojibake — which is how a task that did not exist got
 * reported as "cleanup incomplete".
 */
export function isWindowsTaskMissingExitCode(error: unknown): boolean {
  const code = supervisorExitCode(error);
  if (code === null) return false;
  // ⚠️ NOT `(code >>> 0) === MISSING`. ToUint32 is modulo 2**32, so that admits an
  // entire residue class — 0x80070002 + 2**32, + 2*2**32, - 2*2**32 and so on all
  // wrapped onto the missing code and were classified absent. That is the opposite
  // of the "exactly one HRESULT, everything else incomplete" contract this gate
  // exists to keep, and it silently widened the one judgement we most need narrow.
  // Compare against the two exact spellings of those 32 bits instead.
  return (
    code === WINDOWS_TASK_MISSING_HRESULT ||
    code === WINDOWS_TASK_MISSING_HRESULT_SIGNED
  );
}

export interface SupervisorCommandResult {
  stdout: string;
  stderr: string;
}

export interface SupervisorCommandOptions {
  env?: NodeJS.ProcessEnv;
}

export type SupervisorCommandRunner = (
  command: string,
  args: string[],
  options?: SupervisorCommandOptions,
) => Promise<SupervisorCommandResult>;

export interface OsSupervisorRuntimeDeps {
  runCommand?: SupervisorCommandRunner;
  platform?: NodeJS.Platform;
  userHome?: string;
  runtimeSearchPath?: string;
  uid?: number | null;
  windowsUserId?: string;
  xdgConfigHome?: string;
}

function defaultRunCommand(
  command: string,
  args: string[],
  options?: SupervisorCommandOptions,
): Promise<SupervisorCommandResult> {
  return execFileAsync(command, args, {
    encoding: "utf8",
    env: options?.env,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    timeout: OS_SUPERVISOR_COMMAND_TIMEOUT_MS,
  }).then(({ stdout, stderr }) => ({ stdout, stderr }));
}

function runSupervisorCommand(
  runCommand: SupervisorCommandRunner,
  command: string,
  args: string[],
): Promise<SupervisorCommandResult> {
  return runCommand(
    command,
    args,
    command.toLowerCase() === "powershell.exe"
      ? { env: createWindowsPowerShellChildEnv(undefined) }
      : undefined,
  );
}

async function resolveWindowsUserId(
  runCommand: SupervisorCommandRunner,
): Promise<string> {
  const result = await runSupervisorCommand(runCommand, "powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
  ]);
  const sid = result.stdout.trim();
  if (!/^S-\d+(?:-\d+)+$/.test(sid)) {
    throw new Error(
      "OS_SUPERVISOR_WINDOWS_USER_UNPROVEN: could not resolve the current user SID",
    );
  }
  return sid;
}

export async function resolveOsSupervisorSpec(
  slockHome: string,
  binaryPath: string,
  deps: OsSupervisorRuntimeDeps = {},
): Promise<OsSupervisorSpec> {
  const platform = deps.platform ?? process.platform;
  const runCommand = deps.runCommand ?? defaultRunCommand;
  const input: BuildOsSupervisorSpecInput = {
    platform,
    slockHome,
    binaryPath,
    userHome: deps.userHome ?? os.homedir(),
    runtimeSearchPath: deps.runtimeSearchPath ?? process.env.PATH,
    uid: deps.uid ?? process.getuid?.() ?? null,
    xdgConfigHome: deps.xdgConfigHome ?? process.env.XDG_CONFIG_HOME,
  };
  if (platform === "win32") {
    input.windowsUserId =
      deps.windowsUserId ?? (await resolveWindowsUserId(runCommand));
  }
  return buildOsSupervisorSpec(input);
}

async function runPlan(
  commands: SupervisorCommand[],
  runCommand: SupervisorCommandRunner,
): Promise<SupervisorCommandResult[]> {
  const results: SupervisorCommandResult[] = [];
  for (const step of commands) {
    try {
      results.push(
        await runSupervisorCommand(runCommand, step.command, step.args),
      );
    } catch (error) {
      if (step.allowFailure) {
        results.push({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new SupervisorCommandError(
        `OS_SUPERVISOR_COMMAND_FAILED: ${step.command} ${step.args.join(" ")}: ${detail}`,
        supervisorExitCode(error),
      );
    }
  }
  return results;
}

/**
 * Read a definition that lives in a FILE (launchd/systemd).
 *
 * File-only on purpose. This used to carry a schtasks fallback whose `catch`
 * treated any failure as absence — but its only caller reaches it under
 * `definitionPath !== null`, and a Windows spec's `definitionPath` is always
 * null, so that branch was dead. Narrowing the helper removes the possibility of
 * wiring it back up by accident rather than leaving a wider oracle parked in the
 * file. Windows absence is decided in `readRetirementDefinition` from the typed
 * `/HRESULT` code.
 */
async function readSupervisorDefinition(
  spec: OsSupervisorSpec & { definitionPath: string },
): Promise<string | null> {
  try {
    return await readFile(spec.definitionPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export type LegacyOsSupervisorRetirementResult = {
  status: "absent" | "already-retired" | "retired" | "incomplete";
  kind: OsSupervisorSpec["kind"] | null;
  id: string | null;
  managerUnloaded: boolean;
  definitionRemoved: boolean;
  receiptPath: string;
  message: string;
};

function legacyRetirementReceiptPath(slockHome: string): string {
  return path.join(
    slockHome,
    "computer",
    "legacy-os-supervisor-retirement.json",
  );
}

async function hasLegacyRetirementReceipt(
  receiptPath: string,
): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(receiptPath, "utf8")) as {
      managerUnloaded?: unknown;
      definitionRemoved?: unknown;
    };
    return parsed.managerUnloaded === true && parsed.definitionRemoved === true;
  } catch {
    return false;
  }
}

type OwnedHistoricalLaunchdDefinition = {
  id: string;
  definitionPath: string;
  definition: string;
};

async function listOwnedHistoricalLaunchdDefinitions(
  slockHome: string,
  userHome: string,
): Promise<OwnedHistoricalLaunchdDefinition[]> {
  const launchAgentsDir = path.join(
    path.resolve(userHome),
    "Library",
    "LaunchAgents",
  );
  let entries;
  try {
    entries = await readdir(launchAgentsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const candidates: OwnedHistoricalLaunchdDefinition[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = /^(build\.raft\.computer\.[0-9a-f]{16})\.plist$/.exec(
      entry.name,
    );
    if (!match) continue;
    const definitionPath = path.join(launchAgentsDir, entry.name);
    const definition = await readFile(definitionPath, "utf8");
    if (
      isOwnedHistoricalLaunchdDefinition(slockHome, match[1]!, definition)
    ) {
      candidates.push({ id: match[1]!, definitionPath, definition });
    }
  }
  return candidates.sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * A stable, machine-readable description of a cleanup failure for the user note.
 *
 * Deliberately NOT the child's message or stderr. That text is localized, and on
 * a non-UTF8 console codepage it reaches the user as mojibake — the original
 * report on this bug was an unreadable error about a task that did not exist.
 * A stage plus a typed code keeps a real failure diagnosable without pasting
 * bytes we cannot decode.
 */
export function supervisorFailureDetail(error: unknown): string {
  const code = supervisorExitCode(error);
  const stage =
    error instanceof SupervisorCommandError
      ? /OS_SUPERVISOR_COMMAND_FAILED: (\S+) (\/\S+)/.exec(error.message)?.slice(1, 3).join(" ")
      : undefined;
  const stagePart = `stage=${stage ?? "unknown"}`;
  if (code === null) {
    // No numeric code: a spawn failure, a timeout, a signal. Say which of those
    // we can distinguish, and never guess at absence.
    const raw = (error as { code?: unknown })?.code;
    return `${stagePart}, code=${typeof raw === "string" ? raw : "none"}`;
  }
  return `${stagePart}, code=0x${(code >>> 0).toString(16).padStart(8, "0")}`;
}

function supervisorCommandErrorDetail(error: unknown): string {
  const candidate = error as { message?: unknown; stderr?: unknown };
  return [candidate?.message, candidate?.stderr]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

function isExpectedMissingSupervisorError(
  kind: OsSupervisorSpec["kind"],
  error: unknown,
): boolean {
  const detail = supervisorCommandErrorDetail(error);
  if (kind === "launchd-user") {
    return /could not find (?:service|domain)|domain does not support specified action|no such process/i.test(
      detail,
    );
  }
  if (kind === "windows-task") {
    // Typed exact code only. The former text predicate matched English phrasing,
    // so a localized Windows reported a task that does not exist as an incomplete
    // cleanup — and the same reading also swallowed genuine failures.
    return isWindowsTaskMissingExitCode(error);
  }
  return false;
}

async function readRetirementDefinition(
  spec: OsSupervisorSpec,
  runCommand: SupervisorCommandRunner,
): Promise<string | null> {
  if (spec.definitionPath !== null)
    return readSupervisorDefinition(
      spec as OsSupervisorSpec & { definitionPath: string },
    );
  try {
    return (
      await runSupervisorCommand(runCommand, "schtasks.exe", [
        "/Query",
        "/TN",
        spec.id,
        "/XML",
        // Exact existence query: the typed code is the oracle, not stderr text.
        "/HRESULT",
      ])
    ).stdout;
  } catch (error) {
    if (isExpectedMissingSupervisorError(spec.kind, error)) return null;
    throw error;
  }
}

async function proveRetiredManagerAbsent(
  spec: OsSupervisorSpec,
  uid: number | null,
  runCommand: SupervisorCommandRunner,
): Promise<true> {
  try {
    const results = await runPlan(
      buildSupervisorCommandPlan(spec, "status", { uid }),
      runCommand,
    );
    const manager = parseManagerStatus(
      spec,
      results.map((result) => result.stdout).join("\n"),
    );
    if (manager.loaded || manager.running) {
      throw new Error("legacy OS autostart item is still loaded after cleanup");
    }
  } catch (error) {
    if (isExpectedMissingSupervisorError(spec.kind, error)) return true;
    throw error;
  }
  return true;
}

/**
 * Best-effort, one-time installer migration away from the retired OS manager.
 * This function never throws a cleanup failure into the install hard path.
 * Runtime start/stop/status/doctor do not call it.
 */
export async function retireLegacyOsSupervisor(
  slockHome: string,
  binaryPath: string,
  deps: OsSupervisorRuntimeDeps = {},
): Promise<LegacyOsSupervisorRetirementResult> {
  const receiptPath = legacyRetirementReceiptPath(slockHome);
  const completedReceipt = await hasLegacyRetirementReceipt(receiptPath);
  const platform = deps.platform ?? process.platform;
  if (completedReceipt && platform !== "darwin") {
    return {
      status: "already-retired",
      kind: null,
      id: null,
      managerUnloaded: true,
      definitionRemoved: true,
      receiptPath,
      message: "legacy OS autostart was already removed",
    };
  }

  const runCommand = deps.runCommand ?? defaultRunCommand;
  let spec: OsSupervisorSpec | null = null;
  try {
    spec = await resolveOsSupervisorSpec(slockHome, binaryPath, deps);
    if (spec.kind === "launchd-user") {
      const uid = deps.uid ?? process.getuid?.() ?? null;
      if (uid === null || !Number.isSafeInteger(uid) || uid < 0) {
        throw new Error("launchd user jobs require a numeric uid");
      }
      const definitions = await listOwnedHistoricalLaunchdDefinitions(
        slockHome,
        deps.userHome ?? os.homedir(),
      );
      if (definitions.length === 0) {
        return {
          status: completedReceipt ? "already-retired" : "absent",
          kind: spec.kind,
          id: null,
          managerUnloaded: true,
          definitionRemoved: true,
          receiptPath,
          message: completedReceipt
            ? "legacy OS autostart was already removed"
            : "no legacy OS autostart item was present",
        };
      }

      for (const candidate of definitions) {
        const candidateSpec: OsSupervisorSpec = {
          ...spec,
          id: candidate.id,
          definitionPath: candidate.definitionPath,
          definition: candidate.definition,
        };
        await runPlan(
          [
            {
              command: "launchctl",
              args: ["bootout", `gui/${uid}/${candidate.id}`],
              allowFailure: true,
            },
          ],
          runCommand,
        );
        await proveRetiredManagerAbsent(candidateSpec, uid, runCommand);
        await rm(candidate.definitionPath, { force: true });
        await proveRetiredManagerAbsent(candidateSpec, uid, runCommand);
      }

      const receipt = {
        version: 2,
        kind: spec.kind,
        ids: definitions.map((candidate) => candidate.id),
        retiredAt: currentDate().toISOString(),
        managerUnloaded: true,
        definitionRemoved: true,
      };
      await mkdir(path.dirname(receiptPath), { recursive: true });
      const temp = `${receiptPath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, `${JSON.stringify(receipt, null, 2)}\n`, {
          mode: 0o600,
        });
        await rename(temp, receiptPath);
      } finally {
        await rm(temp, { force: true }).catch(() => {});
      }
      return {
        status: "retired",
        kind: spec.kind,
        id: definitions[0]!.id,
        managerUnloaded: true,
        definitionRemoved: true,
        receiptPath,
        message: `${definitions.length} legacy OS autostart item(s) were unloaded and removed`,
      };
    }
    const actual = await readRetirementDefinition(spec, runCommand);
    const ownership = classifySupervisorDefinition(spec, actual);
    if (ownership === "absent") {
      return {
        status: "absent",
        kind: spec.kind,
        id: spec.id,
        managerUnloaded: true,
        definitionRemoved: true,
        receiptPath,
        message: "no legacy OS autostart item was present",
      };
    }
    if (ownership === "foreign") {
      return {
        status: "incomplete",
        kind: spec.kind,
        id: spec.id,
        managerUnloaded: false,
        definitionRemoved: false,
        receiptPath,
        message:
          "legacy_os_supervisor_cleanup_incomplete: Computer remains usable; an unrecognized old autostart item was left untouched. Re-run the installer from that user's normal login session to retry cleanup.",
      };
    }

    const uid = deps.uid ?? process.getuid?.() ?? null;
    if (spec.kind === "systemd-user") {
      await runPlan(
        buildSupervisorCommandPlan(spec, "stop", { uid }),
        runCommand,
      );
      await rm(spec.definitionPath!, { force: true });
      await runPlan(
        [{ command: "systemctl", args: ["--user", "daemon-reload"] }],
        runCommand,
      );
    } else {
      await runPlan(
        buildSupervisorCommandPlan(spec, "stop", { uid }),
        runCommand,
      );
      await runPlan(
        [{ command: "schtasks.exe", args: ["/Delete", "/TN", spec.id, "/F"] }],
        runCommand,
      );
      await proveRetiredManagerAbsent(spec, uid, runCommand);
    }

    // Windows has no definition FILE, so removal is exactly what the absence
    // readback above proved — carry that witness instead of a hardcoded literal
    // that merely happens to sit after it. No second definition oracle.
    const absenceProven = await proveRetiredManagerAbsent(spec, uid, runCommand);
    const definitionRemoved =
      spec.definitionPath === null
        ? absenceProven
        : await readFile(spec.definitionPath, "utf8").then(
            () => false,
            () => true,
          );
    if (!definitionRemoved)
      throw new Error("legacy OS autostart definition still exists");

    const receipt = {
      version: 1,
      kind: spec.kind,
      id: spec.id,
      retiredAt: currentDate().toISOString(),
      managerUnloaded: true,
      definitionRemoved: true,
    };
    await mkdir(path.dirname(receiptPath), { recursive: true });
    const temp = `${receiptPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(receipt, null, 2)}\n`, {
        mode: 0o600,
      });
      await rename(temp, receiptPath);
    } finally {
      await rm(temp, { force: true }).catch(() => {});
    }
    return {
      status: "retired",
      kind: spec.kind,
      id: spec.id,
      managerUnloaded: true,
      definitionRemoved: true,
      receiptPath,
      message: "legacy OS autostart item was unloaded and removed",
    };
  } catch (error) {
    return {
      status: "incomplete",
      kind: spec?.kind ?? null,
      id: spec?.id ?? null,
      managerUnloaded: false,
      definitionRemoved: false,
      receiptPath,
      message:
        "legacy_os_supervisor_cleanup_incomplete: Computer remains usable; only the old " +
        `optional autostart item could not be fully removed (${supervisorFailureDetail(error)}). ` +
        "Re-run the installer from that user's normal login session to retry cleanup.",
    };
  }
}

function parseManagerStatus(
  spec: OsSupervisorSpec,
  output: string,
): { loaded: boolean; running: boolean; pid: number | null } {
  if (spec.kind === "systemd-user") {
    const values = Object.fromEntries(
      output.split(/\r?\n/).flatMap((line) => {
        const at = line.indexOf("=");
        return at < 0 ? [] : [[line.slice(0, at), line.slice(at + 1)]];
      }),
    );
    const pid = Number.parseInt(values.MainPID ?? "0", 10);
    return {
      loaded: values.LoadState === "loaded",
      running:
        values.ActiveState === "active" &&
        values.SubState === "running" &&
        pid > 0,
      pid: pid > 0 ? pid : null,
    };
  }
  if (spec.kind === "launchd-user") {
    const pid = Number.parseInt(
      output.match(/\bpid\s*=\s*(\d+)/)?.[1] ?? "0",
      10,
    );
    return {
      loaded:
        output.includes(`service = ${spec.id}`) ||
        output.includes(`"${spec.id}"`) ||
        output.length > 0,
      running: /\bstate\s*=\s*running\b/.test(output) && pid > 0,
      pid: pid > 0 ? pid : null,
    };
  }
  const running = /^Running$/im.test(output) || /^4$/m.test(output.trim());
  return { loaded: output.trim().length > 0, running, pid: null };
}
