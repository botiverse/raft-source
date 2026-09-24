// Output helpers. Progress → stdout (human readable); errors → stderr.
//
// Default stderr is for humans: what happened, the next command, local-state
// guarantee, and support link.
import { isComputerError } from "./lib/errors.js";
import { formatRaftHomeForDisplay, resolveRaftHome } from "./paths.js";

const SUPPORT_URL = "https://app.raft.build/s/community/";

export class CliExit extends Error {
  /**
   * v8.3.3 PR-2c — carry the closed-set / stderr token through the thrown
   * error so callers can pattern-match without parsing stderr. Optional
   * because some callsites throw `new CliExit(code)` directly without a
   * named token (e.g. the harness EX_CONFIG paths).
   */
  constructor(public readonly exitCode: number, public readonly code?: string) {
    super(`CliExit(${exitCode}${code ? ` ${code}` : ""})`);
    this.name = "CliExit";
  }
}

export function info(line: string): void {
  process.stdout.write(`${line}\n`);
}

export function fail(code: string, message: string, exitCode = 1): never {
  const next = inferNextCommands(code, message);
  process.stderr.write(formatHumanError(code, message, next));
  throw new CliExit(exitCode, code);
}

export function formatHumanError(code: string, message: string, next = inferNextCommands(code, message)): string {
  const lines = [
    ...(shouldPrintStateRoot(code) ? [`Using state at ${formatRaftHomeForDisplay(resolveRaftHome())}`] : []),
    formatWhatHappened(code, message),
    `Next: ${next.length > 0 ? next.join(" && ") : fallbackNextCommand(code)}`,
    `State: ${stateGuarantee(code)}`,
    `Help: ${SUPPORT_URL}`,
  ];
  const note = postHelpNote(code, message);
  if (note) lines.push(note);
  return lines.join("\n") + "\n";
}

function shouldPrintStateRoot(code: string): boolean {
  return (
    code.startsWith("SETUP_") ||
    code.startsWith("MIGRATE_") ||
    code.startsWith("MIGRATION_") ||
    code.startsWith("LEGACY_") ||
    code === "NON_INTERACTIVE_SETUP_REQUIRES_FLAGS"
  );
}

export function inferNextCommands(code: string, message: string): string[] {
  const commands: string[] = [];
  const seen = new Set<string>();
  const fenceWidths = [...new Set([...message.matchAll(/`+/g)].map((match) => match[0].length))]
    .sort((left, right) => right - left);
  for (const width of fenceWidths) {
    const fence = "`".repeat(width);
    const backtickCommand = new RegExp(
      "(?<!`)" + fence + "(?!`)([\\s\\S]*?)(?<!`)" + fence + "(?!`)",
      "g",
    );
    for (let match = backtickCommand.exec(message); match !== null; match = backtickCommand.exec(message)) {
      const command = match[1]?.trim();
      if (!command || !/\braft-computer\b/.test(command) || seen.has(command)) continue;
      seen.add(command);
      commands.push(command);
    }
    if (commands.length > 0) return commands;
  }

  const bareCommand = /\b(raft-computer\s+[^\n.]+)/;
  const bare = message.match(bareCommand)?.[1]?.trim();
  if (bare) return [bare];

  return [fallbackNextCommand(code)];
}

function formatWhatHappened(code: string, message: string): string {
  return `What happened (${code}): ${message.replace(/\s+/g, " ").trim()}`;
}

function fallbackNextCommand(code: string): string {
  if (code.startsWith("UPGRADE_")) return "raft-computer upgrade";
  if (code.startsWith("CHANNEL_VERSIONS_")) return "raft-computer channel versions";
  if (code === "MIGRATION_LOCAL_EVIDENCE_UNMATCHED") return "raft-computer doctor --migration-details";
  if (
    code.startsWith("MIGRATE_") ||
    code.startsWith("MIGRATION_") ||
    code.startsWith("SETUP_") ||
    code.startsWith("LEGACY_")
  ) {
    return "raft-computer setup /<server>";
  }
  if (code.startsWith("RUNNER_") || code.startsWith("RUNNERS_")) return "raft-computer runners list";
  if (code === "NO_DAEMON_LOG") return "raft-computer logs --service";
  if (code === "NO_ATTACHMENT" || code === "INVALID_ATTACHMENT" || code === "NOT_ATTACHED") {
    return "raft-computer setup /<server>";
  }
  if (code === "CHANNEL_INVALID") return "raft-computer channel set latest";
  if (code === "NON_INTERACTIVE_SETUP_REQUIRES_FLAGS") return "raft-computer setup /<server>";
  if (code === "CONCURRENT_OPERATION") return "raft-computer status";
  if (code === "MUTATION_LOCK_COMPROMISED") return "raft-computer doctor";
  return "raft-computer doctor";
}

function stateGuarantee(code: string): string {
  if (code.startsWith("UPGRADE_")) return "No completed upgrade was confirmed by this command.";
  if (code.startsWith("CHANNEL_VERSIONS_")) return "This read-only command did not change local Computer state.";
  if (code.startsWith("RUNNER_") || code.startsWith("RUNNERS_")) return "No runner change was confirmed by this command.";
  if (code === "CHANNEL_INVALID") return "The saved release channel was not changed.";
  if (code === "CONCURRENT_OPERATION") return "This command did not start because another Computer operation is already running.";
  if (code === "MUTATION_LOCK_COMPROMISED") return "The command stopped after losing its mutation lock; completion was not confirmed.";
  if (code === "MIGRATION_LOCAL_EVIDENCE_UNMATCHED") return "Nothing was changed on this computer.";
  if (code.startsWith("MIGRATION_") || code.startsWith("MIGRATE_") || code.startsWith("LEGACY_")) {
    return "Setup stopped before changing local Computer state.";
  }
  if (code === "NO_DAEMON_LOG" || code === "NO_ATTACHMENT" || code === "INVALID_ATTACHMENT" || code === "NOT_ATTACHED") {
    return "No local Computer state was changed.";
  }
  return "No local Computer state change was confirmed by this command.";
}

function postHelpNote(code: string, message: string): string | null {
  if (code !== "MIGRATION_LOCAL_EVIDENCE_UNMATCHED") return null;
  const server = message.match(/traces of a (\/\S+) connection/)?.[1] ?? "/<server>";
  return `(If you are sure you want a brand-new computer: raft-computer setup ${server} --fresh)`;
}

/**
 * CLI presenter bridge for the pure ComputerApi (CLI-over-lib convergence).
 *
 * Runs a pure api call (+ its human formatting) and maps a thrown
 * `ComputerError` → the CLI fail contract via `fail()`. Lib api methods are
 * PURE — they NEVER call `info()`/`fail()`/`process.exit`; this presenter is
 * the single place that turns their typed `ComputerError` into stderr. The
 * `withCliExit` wrapper in index.ts still converts the resulting `CliExit` into
 * a process exit code; any non-ComputerError rethrows unchanged.
 */
export async function present(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    if (isComputerError(err)) fail(err.code, err.message, err.exitCode);
    throw err;
  }
}
