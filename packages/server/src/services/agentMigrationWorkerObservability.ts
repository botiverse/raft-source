import { randomUUID } from "node:crypto";
import { currentDate } from "@botiverse/raft-shared";
import { readBuildIdentityStatus, SERVER_VERSION, type BuildIdentityStatus } from "../version.js";

export type AgentMigrationWorkerName = "receipt_outbox" | "remediation";
export type AgentMigrationWorkerDrainOutcome = "empty" | "served" | "failed";

export type AgentMigrationWorkerObservation = {
  event: "startup" | "drain";
  worker: AgentMigrationWorkerName;
  outcome: "started" | AgentMigrationWorkerDrainOutcome;
  observed_at: string;
  runtime_id: string;
  server_version: string;
  release_identity: "available" | "unavailable";
  release_sha: string | null;
  release_branch: string | null;
  release_built_at: string | null;
};

export interface AgentMigrationWorkerObservability {
  startup(): void;
  drain(outcome: AgentMigrationWorkerDrainOutcome): void;
}

const DEFAULT_OUTCOME_HEARTBEAT_MS = 5 * 60_000;
const PROCESS_RUNTIME_ID = randomUUID();

function observationIdentity(status: BuildIdentityStatus): Pick<
  AgentMigrationWorkerObservation,
  "release_identity" | "release_sha" | "release_branch" | "release_built_at"
> {
  if (!status.ok) {
    return {
      release_identity: "unavailable",
      release_sha: null,
      release_branch: null,
      release_built_at: null,
    };
  }
  return {
    release_identity: "available",
    release_sha: status.identity.sha,
    release_branch: status.identity.branch,
    release_built_at: status.identity.builtAt,
  };
}

function defaultEmit(observation: AgentMigrationWorkerObservation): void {
  console.info("[AgentMigrationWorker]", JSON.stringify(observation));
}

/**
 * Emits a privacy-safe lifecycle signal for one worker instance.
 *
 * Drain success is a bounded heartbeat rather than a poll log: the first
 * outcome is emitted immediately and later empty/served outcomes are emitted
 * no more than once per heartbeat window. A transition into failed emits
 * immediately, while repeated failures are also bounded. Instrumentation is
 * best-effort and can never change worker scheduling or drain behavior.
 */
export function createAgentMigrationWorkerObservability(input: {
  worker: AgentMigrationWorkerName;
  now?: () => Date;
  runtimeId?: string;
  serverVersion?: string;
  buildIdentity?: BuildIdentityStatus;
  outcomeHeartbeatMs?: number;
  emit?: (observation: AgentMigrationWorkerObservation) => void;
}): AgentMigrationWorkerObservability {
  const now = input.now ?? currentDate;
  const runtimeId = input.runtimeId ?? PROCESS_RUNTIME_ID;
  const serverVersion = input.serverVersion ?? SERVER_VERSION;
  const buildIdentity = input.buildIdentity ?? readBuildIdentityStatus();
  const outcomeHeartbeatMs = input.outcomeHeartbeatMs ?? DEFAULT_OUTCOME_HEARTBEAT_MS;
  const emit = input.emit ?? defaultEmit;
  let startupEmitted = false;
  let lastDrainOutcome: AgentMigrationWorkerDrainOutcome | null = null;
  let lastDrainEmittedAtMs: number | null = null;

  const emitSafely = (
    event: AgentMigrationWorkerObservation["event"],
    outcome: AgentMigrationWorkerObservation["outcome"],
    observedAt: Date,
  ) => {
    const observation: AgentMigrationWorkerObservation = {
      event,
      worker: input.worker,
      outcome,
      observed_at: observedAt.toISOString(),
      runtime_id: runtimeId,
      server_version: serverVersion,
      ...observationIdentity(buildIdentity),
    };
    try {
      emit(observation);
    } catch {
      // Observability must never change worker authority or scheduling.
    }
  };

  return {
    startup() {
      if (startupEmitted) return;
      startupEmitted = true;
      emitSafely("startup", "started", now());
    },
    drain(outcome) {
      const observedAt = now();
      const elapsedMs = lastDrainEmittedAtMs === null
        ? Number.POSITIVE_INFINITY
        : observedAt.getTime() - lastDrainEmittedAtMs;
      const enteringFailure = outcome === "failed" && lastDrainOutcome !== "failed";
      if (elapsedMs < outcomeHeartbeatMs && !enteringFailure) {
        return;
      }
      lastDrainOutcome = outcome;
      lastDrainEmittedAtMs = observedAt.getTime();
      emitSafely("drain", outcome, observedAt);
    },
  };
}

export function classifyAgentMigrationReceiptDrain(input: {
  attempted: number;
  sent: number;
  failed: number;
}): AgentMigrationWorkerDrainOutcome {
  if (input.failed > 0) return "failed";
  if (input.attempted > 0 || input.sent > 0) return "served";
  return "empty";
}

export function classifyAgentMigrationRemediationDrain(input: {
  autoStart: boolean;
  cancellation: boolean;
}): AgentMigrationWorkerDrainOutcome {
  return input.autoStart || input.cancellation ? "served" : "empty";
}
