import { createTraceClient, LocalRotatingTraceSink } from "@botiverse/raft-trace-client";
import { noopTracer } from "@botiverse/raft-shared";
import { computerDir } from "../paths.js";
import type { ComputerTraceClientSource, ComputerTracer } from "./traceTypes.js";

/**
 * Build the env-gated Computer trace client for a given emitting `source`
 * (CLI vs menu-bar). Both surfaces share this so their spans land in the same
 * `<computerDir>/traces/` sink with consistent gating.
 * `RAFT_COMPUTER_LOCAL_TRACE=0` disables (default on, mirrors the daemon);
 * any setup failure falls back to noop.
 */
export function computerLocalTraceDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RAFT_COMPUTER_LOCAL_TRACE === "0";
}

export function createComputerTracer(slockHome: string, source: ComputerTraceClientSource): ComputerTracer {
  if (computerLocalTraceDisabled()) return noopTracer;
  try {
    return createTraceClient({ source, sinks: [new LocalRotatingTraceSink({ machineDir: computerDir(slockHome) })] });
  } catch {
    return noopTracer;
  }
}
