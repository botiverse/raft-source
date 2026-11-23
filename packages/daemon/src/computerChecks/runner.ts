// One round of "On this computer" checks: runs each enabled check (all at
// once, commands through 3 shared slots, 20 s for the round), turns anything
// that did not finish into `unconfirmed` rows rather than hiding it, caps the
// size, and scrubs every string with the shared credential rules last.
import { lstat, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { redactDiagnosticCredentials } from "@botiverse/raft-shared";
import { logger } from "../logger";
import { CHECK_MAX_CONCURRENT_COMMANDS, commandSlots, createCheckContext, type CheckSpawn } from "./context";
import { isDisabledByOwner, type OwnerChecksSwitch } from "./ownerSwitch";
import { COMPUTER_CHECKS } from "./plugins";
import type { CheckItem, ComputerCheck, ComputerCheckId, ComputerCheckPluginReport, ComputerChecksReport, OwnerSwitchReport } from "./types";

export const CHECK_ROUND_BUDGET_MS = 20_000;
export const CHECK_ITEMS_MAX = 20;
export const CHECK_REPORT_MAX_BYTES = 16 * 1024;
const CHECK_TEXT_MAX = 120;

/** The empty directory commands run in: `<RAFT_HOME>/computer/checks-cwd`. */
export function checksWorkDir(raftHome: string): string {
  return path.join(raftHome, "computer", "checks-cwd");
}

export interface RunComputerChecksDeps {
  /** HOME of the Computer service's own user, `os.userInfo().homedir` (never `os.homedir()`, which follows `HOME`); declared files are relative to it. See README.md. */
  homeDir: string;
  /** Empty directory every command runs in (see `checksWorkDir`); created if missing. */
  workDir: string;
  /** Only PATH, LANG and LC_* of it reach a command (HOME is `homeDir`). */
  parentEnv: Readonly<Record<string, string | undefined>>;
  owner: OwnerChecksSwitch;
  /** From `observeOwnerChecksSwitch`; copied into the report as is. */
  ownerSwitch?: OwnerSwitchReport;
  spawn?: CheckSpawn;
  platform?: NodeJS.Platform;
  /** Tests substitute checks; production runs `COMPUTER_CHECKS`. */
  checks?: readonly ComputerCheck[];
  now?: () => number;
  commandTimeoutMs?: number;
  roundBudgetMs?: number;
}

/** The Computer's last pass over every key, label and value: the shared credential rules, then the 120-character cut. */
export function scrubCheckText(text: string): string {
  const clean = redactDiagnosticCredentials(text, { mask: "***REDACTED***" });
  return clean.length <= CHECK_TEXT_MAX ? clean : `${clean.slice(0, CHECK_TEXT_MAX - 1)}…`;
}

function scrubItem(item: CheckItem): CheckItem {
  return {
    ...item,
    key: scrubCheckText(item.key),
    label: scrubCheckText(item.label),
    ...(item.value !== undefined ? { value: scrubCheckText(item.value) } : {}),
  };
}

const ROUND_TIMEOUT = Symbol("round timeout");

async function runOne(check: ComputerCheck, deps: RunComputerChecksDeps, signal: AbortSignal, slots: ReturnType<typeof commandSlots>, budgetElapsed: Promise<typeof ROUND_TIMEOUT>): Promise<ComputerCheckPluginReport> {
  const now = deps.now ?? Date.now;
  const started = now();
  const ctx = createCheckContext(check, {
    homeDir: deps.homeDir,
    workDir: deps.workDir,
    parentEnv: deps.parentEnv,
    signal,
    slots,
    spawn: deps.spawn,
    platform: deps.platform,
    commandTimeoutMs: deps.commandTimeoutMs,
  });
  let items: CheckItem[];
  let error: ComputerCheckPluginReport["error"];
  try {
    const result = await Promise.race([check.run(ctx), budgetElapsed]);
    if (result === ROUND_TIMEOUT) {
      error = "timeout";
      items = [{ key: `${check.id}.check`, label: check.id, status: "unconfirmed", reason: "timeout" }];
    } else {
      items = result;
    }
  } catch {
    // The error is not logged or reported: a check's error may quote what it read.
    logger.warn(`[computer-checks] check ${check.id} failed`);
    error = "failed";
    items = [{ key: `${check.id}.check`, label: check.id, status: "unconfirmed", reason: "failed" }];
  }
  const truncated = items.length > CHECK_ITEMS_MAX;
  return {
    id: check.id,
    items: items.slice(0, CHECK_ITEMS_MAX).map(scrubItem),
    durationMs: Math.max(0, now() - started),
    ...(error ? { error } : {}),
    ...(truncated ? { truncated: true as const } : {}),
  };
}

/**
 * Creates the work directory if missing, then makes sure it is an empty real
 * directory (not a symlink, nothing planted in it) before any command runs there.
 */
async function prepareWorkDir(workDir: string): Promise<boolean> {
  try {
    await mkdir(workDir, { recursive: true });
    const stat = await lstat(workDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    return (await readdir(workDir)).length === 0;
  } catch {
    return false;
  }
}

/** The run folder could not be prepared: the check's commands were not run (not "not installed", not a failure of the check). */
function runFolderUnavailable(check: ComputerCheck): ComputerCheckPluginReport {
  return {
    id: check.id,
    items: [{ key: `${check.id}.check`, label: check.id, status: "unconfirmed", reason: "run_folder_unavailable" }],
    durationMs: 0,
    error: "run_folder_unavailable",
  };
}

/** Drops rows from the end until the report fits, marking what was cut. */
function capReportSize(report: ComputerChecksReport): ComputerChecksReport {
  const size = () => Buffer.byteLength(JSON.stringify(report), "utf8");
  for (let i = report.plugins.length - 1; i >= 0 && size() > CHECK_REPORT_MAX_BYTES; i -= 1) {
    const plugin = report.plugins[i]!;
    while (plugin.items.length > 0 && size() > CHECK_REPORT_MAX_BYTES) {
      plugin.items.pop();
      plugin.truncated = true;
      report.truncated = true;
    }
  }
  return report;
}

/**
 * `enabled` is the server's switch per check; the owner's local switch wins
 * over it. Checks the server did not enable are left out; ones the owner
 * switched off are listed with `disabledByOwner` and not run.
 *
 * For the caller (`service.ts`): keep at most one round in flight per
 * computer (a refresh during a round joins it, never starts a second), and
 * pass an `owner` switch re-read from disk for every round, never a cached one,
 * with `ownerSwitch` from `observeOwnerChecksSwitch(raftHome, owner)`.
 */
export async function runComputerChecks(
  enabled: Partial<Record<ComputerCheckId, boolean>>,
  deps: RunComputerChecksDeps,
): Promise<ComputerChecksReport> {
  const now = deps.now ?? Date.now;
  const checkedAt = new Date(now()).toISOString();
  const controller = new AbortController();
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  const budgetElapsed = new Promise<typeof ROUND_TIMEOUT>((resolve) => {
    budgetTimer = setTimeout(() => {
      controller.abort();
      resolve(ROUND_TIMEOUT);
    }, deps.roundBudgetMs ?? CHECK_ROUND_BUDGET_MS);
  });
  const slots = commandSlots(CHECK_MAX_CONCURRENT_COMMANDS);
  try {
    const workDirOk = await prepareWorkDir(deps.workDir);
    if (!workDirOk) logger.warn("[computer-checks] work directory is not an empty directory; checks that run commands not run");
    const plugins = await Promise.all(
      (deps.checks ?? COMPUTER_CHECKS)
        .filter((check) => enabled[check.id] === true)
        .map((check): Promise<ComputerCheckPluginReport> | ComputerCheckPluginReport =>
          isDisabledByOwner(deps.owner, check.id)
            ? { id: check.id, items: [], durationMs: 0, disabledByOwner: true }
            // Checks that run no command never use the work directory.
            : !workDirOk && check.commands.length > 0
              ? runFolderUnavailable(check)
              : runOne(check, deps, controller.signal, slots, budgetElapsed)),
    );
    return capReportSize({ schemaVersion: 1, checkedAt, plugins, ...(deps.ownerSwitch ? { ownerSwitch: deps.ownerSwitch } : {}) });
  } finally {
    clearTimeout(budgetTimer);
    controller.abort();
  }
}
