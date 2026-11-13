import { readFileSync, writeFileSync } from "node:fs";

/**
 * Linux OOM-killer preference for agent runtime processes (#triage:#169).
 *
 * When memory runs out, the kernel kills the process with the highest
 * oom_score, which `oom_score_adj` shifts (-1000..1000). A runtime child is
 * raised to this value so a runaway agent, and every tool it starts (they
 * inherit it), is killed before the Computer service and the other agents.
 * Raising needs no privilege; lowering does, so a child already above it is
 * left alone. Not Linux, or /proc not writable: nothing happens.
 */
export const RUNTIME_OOM_SCORE_ADJ = 500;

export interface OomScoreDeps {
  platform?: NodeJS.Platform;
  readFile?: (path: string) => string;
  writeFile?: (path: string, value: string) => void;
}

/** True when the process now has at least RUNTIME_OOM_SCORE_ADJ. */
export function raiseRuntimeOomScore(pid: number | undefined, deps: OomScoreDeps = {}): boolean {
  if ((deps.platform ?? process.platform) !== "linux" || !pid) return false;
  const path = `/proc/${pid}/oom_score_adj`;
  const read = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const write = deps.writeFile ?? ((p: string, v: string) => writeFileSync(p, v));
  try {
    const current = Number.parseInt(read(path).trim(), 10);
    if (Number.isFinite(current) && current >= RUNTIME_OOM_SCORE_ADJ) return true;
    write(path, String(RUNTIME_OOM_SCORE_ADJ));
    return true;
  } catch {
    // Already exited, or /proc not writable (a hardened container): the
    // kernel's default choice applies, as before.
    return false;
  }
}
