/**
 * Bounded runner-readiness readback for `raft-computer restart` (task #829).
 *
 * The live restart path hands the Computer service over via IPC and returns
 * without watching the runners: the replacement service must not depend on the
 * caller's shell. Field report #828 showed why that is not enough on its own:
 * the replacement service came up in ~100ms while all three runners spent ~250s
 * in the WebSocket retry envelope before reconnecting, so the user read
 * "restart requested" as "restart did nothing".
 *
 * This module keeps the handoff non-blocking but adds an observation window:
 * poll the same machine facts `start` gates on and report, per server, whether
 * the runner has connected *since the restart was requested*. A connection
 * marker written by the pre-restart runner never counts. On timeout the caller
 * prints a pending block plus where to look; it is not an error.
 *
 * Callers that run inside an agent process spawned by a runner must not wait:
 * restarting tears down their own runner. `callerIsRunnerHosted` detects that.
 */
import { collectMachineFacts, type MachineFacts } from "./machineFacts";
import { machineReadiness, type MachineReadinessReason } from "./machineReadiness";
import { COMPUTER_VERSION } from "./version";

export const RESTART_READINESS_TIMEOUT_MS = 60_000;
export const RESTART_READINESS_POLL_INTERVAL_MS = 500;

/** Set by the daemon on every agent child it spawns; see agentProcessManager. */
export const RUNNER_HOSTED_AGENT_ENV_VAR = "SLOCK_AGENT_ID";

export function callerIsRunnerHosted(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[RUNNER_HOSTED_AGENT_ENV_VAR];
  return typeof value === "string" && value.length > 0;
}

export type RestartRunnerState =
  | { readonly serverId: string; readonly state: "connected"; readonly pid: number }
  | { readonly serverId: string; readonly state: "pending"; readonly detail: string };

export interface RestartReadinessSnapshot {
  /** Every target runner has connected after the restart was requested. */
  readonly complete: boolean;
  readonly runners: readonly RestartRunnerState[];
}

function describeReason(reason: MachineReadinessReason): string {
  switch (reason.code) {
    case "runner-not-managed":
      return "server is not managed by this Computer";
    case "runner-absent":
      return "runner process not started yet";
    case "runner-unattested":
      return `runner starting (pid ${reason.pid}), version not attested yet`;
    case "runner-version-mismatch":
      return `runner pid ${reason.pid} is version ${reason.actualVersion}, expected ${reason.expectedVersion}`;
    case "runner-disconnected":
      return `runner starting (pid ${reason.pid}), not connected to the server yet`;
    case "runner-lock-conflict":
      return reason.ownerPid === null
        ? "runner blocked by another daemon's machine lock (owner unknown)"
        : `runner blocked by another daemon's machine lock (pid ${reason.ownerPid})`;
  }
}

/** Pure: classify each target from raw machine facts against the restart request time. */
export function classifyRestartReadiness(
  facts: MachineFacts,
  targetServerIds: readonly string[],
  requestedAtMs: number,
  expectedVersion: string = COMPUTER_VERSION,
): RestartReadinessSnapshot {
  const targets = [...new Set(targetServerIds)].sort();
  const verdict = machineReadiness(facts, { targetServerIds: targets, expectedVersion });
  const reasons = new Map(verdict.reasons.map((reason) => [reason.serverId, reason]));
  const runners = new Map(facts.runners.map((runner) => [runner.serverId, runner]));

  const states = targets.map((serverId): RestartRunnerState => {
    const reason = reasons.get(serverId);
    if (reason) return { serverId, state: "pending", detail: describeReason(reason) };
    const pid = verdict.runnerPids.get(serverId);
    const connectedAt = runners.get(serverId)?.connectionEvidence?.connectedAt ?? 0;
    if (pid === undefined) return { serverId, state: "pending", detail: "runner process not started yet" };
    if (connectedAt <= requestedAtMs) {
      return {
        serverId,
        state: "pending",
        detail: `runner pid ${pid} still shows a connection from before this restart`,
      };
    }
    return { serverId, state: "connected", pid };
  });

  return { complete: states.every((s) => s.state === "connected"), runners: states };
}

export interface WaitForRestartReadinessOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  collectFacts?: (slockHome: string, serverIds: readonly string[]) => Promise<MachineFacts>;
  expectedVersion?: string;
  signal?: AbortSignal;
  /** Fires once per server the first time it is observed connected. */
  onConnected?: (runner: Extract<RestartRunnerState, { state: "connected" }>) => void;
}

const defaultCollectFacts: NonNullable<WaitForRestartReadinessOptions["collectFacts"]> = (slockHome, serverIds) =>
  collectMachineFacts(slockHome, { runnerServerIds: serverIds });

/**
 * Poll until every target runner has connected after `requestedAtMs`, or the
 * bound elapses. Never throws on timeout; the returned snapshot carries the
 * pending detail for the caller to print.
 */
export async function waitForRestartReadiness(
  slockHome: string,
  targetServerIds: readonly string[],
  requestedAtMs: number,
  opts: WaitForRestartReadinessOptions = {},
): Promise<RestartReadinessSnapshot> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const collect = opts.collectFacts ?? defaultCollectFacts;
  const timeoutMs = opts.timeoutMs ?? RESTART_READINESS_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? RESTART_READINESS_POLL_INTERVAL_MS;
  const deadline = now() + timeoutMs;
  const announced = new Set<string>();

  for (;;) {
    opts.signal?.throwIfAborted();
    const facts = await collect(slockHome, targetServerIds);
    const snapshot = classifyRestartReadiness(facts, targetServerIds, requestedAtMs, opts.expectedVersion);
    for (const runner of snapshot.runners) {
      if (runner.state === "connected" && !announced.has(runner.serverId)) {
        announced.add(runner.serverId);
        opts.onConnected?.(runner);
      }
    }
    if (snapshot.complete) return snapshot;
    const remaining = deadline - now();
    if (remaining <= 0) return snapshot;
    await sleep(Math.min(pollIntervalMs, remaining));
  }
}
