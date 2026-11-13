import { createHash } from "node:crypto";
import { accessSync, chmodSync, constants as fsConstants, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RUNTIME_OOM_SCORE_ADJ } from "../drivers/index";
import { logger } from "../logger";
import type { OarLaunch } from "./oarLaunch";

/**
 * Linux OOM-killer preference for a runtime OAR starts (the legacy host's
 * `raiseRuntimeOomScore`). OAR spawns its own children and exposes no pid, and
 * the host chooses the command anyway, so the command becomes a small script
 * that raises the score and execs the runtime: same pid, no extra process, and
 * set before the runtime starts, so what it starts inherits it. OAR gives the
 * ACP terminal commands it starts for a runtime the same score (OAR 0.90).
 *
 * As the legacy host: only ever raises. Lowering needs privilege, and a process
 * that has it must not lose a higher score. Every failure here is silent.
 */
function oomWrapperScript(command: string): string {
  const quoted = `'${command.replaceAll("'", `'\\''`)}'`;
  return [
    "#!/bin/sh",
    "{",
    "  read -r score < /proc/self/oom_score_adj",
    `  [ "\${score:-0}" -lt ${RUNTIME_OOM_SCORE_ADJ} ] && echo ${RUNTIME_OOM_SCORE_ADJ} > /proc/self/oom_score_adj`,
    "} 2>/dev/null",
    `exec ${quoted} "$@"`,
    "",
  ].join("\n");
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The script for one command: named by its hash, so launches of one command share
 * it. Throws when it can't run here (a read-only or noexec Raft home): spawning it
 * would fail every start, and nothing retries without it.
 */
export function writeOomWrapper(dir: string, command: string, canExecute: (file: string) => boolean = isExecutable): string {
  const script = oomWrapperScript(command);
  const file = path.join(dir, `oom-${createHash("sha256").update(command).digest("hex").slice(0, 16)}.sh`);
  try {
    if (readFileSync(file, "utf8") === script && canExecute(file)) return file;
  } catch {
    // not written yet
  }
  mkdirSync(dir, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, script, { mode: 0o755 });
  chmodSync(temporary, 0o755);
  renameSync(temporary, file);
  if (!canExecute(file)) throw new Error(`${file} can't be executed here`);
  return file;
}

/**
 * The launch with its executable wrapped, on Linux. A launch that can't be wrapped
 * (no writable or executable directory, an installation OAR bundles) runs as it
 * is: this is a preference, and not worth failing a start.
 */
export function withOarOomPreference(launch: OarLaunch, dir: string, platform: NodeJS.Platform = process.platform, canExecute?: (file: string) => boolean): OarLaunch {
  if (platform !== "linux" || launch.installation.via !== "executable") return launch;
  try {
    return { ...launch, installation: { ...launch.installation, command: writeOomWrapper(dir, launch.installation.command, canExecute) } };
  } catch (error) {
    logger.warn(`[OAR host] OOM preference not set for ${launch.runtimeId}: ${error instanceof Error ? error.message : String(error)}`);
    return launch;
  }
}
