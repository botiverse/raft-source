// Reconciler step 13 (PR 3): a web upgrade waits for the Computer's agents
// to finish their current work before the installer stops the service.
//
// The Server decides: it adds `drain` to `computer:upgrade` only for a daemon
// that advertises DAEMON_CAPABILITY_COMPUTER_UPGRADE_DRAIN_V1, and stretches
// the request's deadline by the drain. The daemon clamps the drain to
// COMPUTER_UPGRADE_DRAIN_MAX_DEADLINE_MS whatever the Server asks for. An old
// Server sends no `drain` (no drain, as before); an old daemon ignores it.
//
// On the machine the Computer service drains every runner it supervises
// through two small files per server (computer/servers/<id>/):
// `upgrade-drain.json` (service → runner: hold and wait, until when) and
// `upgrade-drain-state.json` (runner → service: how far it is). One writer
// per file. The runner of the Server that asked also reports its progress
// with `computer:upgrade:draining`.

/** The daemon drains a web upgrade's agents when `computer:upgrade` carries `drain`. */
export const DAEMON_CAPABILITY_COMPUTER_UPGRADE_DRAIN_V1 = "computer:upgrade-drain-v1";

/**
 * The longest a web upgrade waits for quiet agents, whatever the Server asks
 * for (Tenny Q-B: the daemon clamps). The daemon's own drain primitive has
 * the same cap (agentDrain.ts AGENT_DRAIN_MAX_DEADLINE_MS).
 */
export const COMPUTER_UPGRADE_DRAIN_MAX_DEADLINE_MS = 10 * 60_000;

/** `computer:upgrade.drain`: wait at most this long for quiet agents before the installer runs. */
export interface ComputerUpgradeDrainRequest {
  deadlineMs: number;
}

/** How a drain ended: every agent quiet, the deadline passed, or the drain was let go (the upgrade did not go on). */
export type ComputerUpgradeDrainFinished = "quiet" | "deadline" | "ended";

/**
 * Daemon → Server, from the runner of the Server that asked: the drain
 * began, its progress changed (at most once a second), or it finished
 * (`finished`). Only for a request that carried `drain`, so a Server that
 * gets it knows the frame.
 */
export interface ComputerUpgradeDrainingMessage {
  type: "computer:upgrade:draining";
  requestId: string;
  /** When the drain stops waiting (ISO). */
  deadlineAt: string;
  /** This runner's live agent processes. */
  live: number;
  /** The agents still finishing their work (bounded). */
  notQuietAgentIds: string[];
  finished?: ComputerUpgradeDrainFinished;
}

/** At most this many agent ids in a draining frame or a state file. */
export const COMPUTER_UPGRADE_DRAIN_MAX_LISTED_AGENTS = 100;

export const COMPUTER_UPGRADE_DRAIN_FILE_FORMAT_VERSION = 1;

/** Service → runner (`upgrade-drain.json`): hold new work and wait for quiet until `deadlineAtMs`. Removed when the upgrade is aborted. */
export interface ComputerUpgradeDrainRequestFile {
  formatVersion: typeof COMPUTER_UPGRADE_DRAIN_FILE_FORMAT_VERSION;
  requestId: string;
  /** This runner's Server asked for the upgrade: it reports `computer:upgrade:draining`. */
  origin: boolean;
  deadlineAtMs: number;
  /** The service that wrote it; a file of a service that is gone is ignored. */
  servicePid: number;
}

/** Runner → service (`upgrade-drain-state.json`): this runner's drain for `requestId`. */
export interface ComputerUpgradeDrainStateFile {
  formatVersion: typeof COMPUTER_UPGRADE_DRAIN_FILE_FORMAT_VERSION;
  requestId: string;
  /** The runner that wrote it. */
  pid: number;
  live: number;
  notQuietAgentIds: string[];
  /** Absent while it waits. */
  finished?: ComputerUpgradeDrainFinished;
  updatedAtMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFinished(value: unknown): value is ComputerUpgradeDrainFinished {
  return value === "quiet" || value === "deadline" || value === "ended";
}

/** A positive, finite `drain.deadlineMs`, clamped to COMPUTER_UPGRADE_DRAIN_MAX_DEADLINE_MS; anything else is no drain. */
export function clampComputerUpgradeDrain(drain: unknown): ComputerUpgradeDrainRequest | null {
  if (!isRecord(drain)) return null;
  const deadlineMs = drain.deadlineMs;
  if (typeof deadlineMs !== "number" || !Number.isFinite(deadlineMs) || deadlineMs <= 0) return null;
  return { deadlineMs: Math.min(Math.floor(deadlineMs), COMPUTER_UPGRADE_DRAIN_MAX_DEADLINE_MS) };
}

export function parseComputerUpgradeDrainRequestFile(raw: unknown): ComputerUpgradeDrainRequestFile | null {
  if (!isRecord(raw) || raw.formatVersion !== COMPUTER_UPGRADE_DRAIN_FILE_FORMAT_VERSION) return null;
  if (typeof raw.requestId !== "string" || !raw.requestId) return null;
  if (typeof raw.origin !== "boolean") return null;
  if (typeof raw.deadlineAtMs !== "number" || !Number.isFinite(raw.deadlineAtMs)) return null;
  if (!Number.isSafeInteger(raw.servicePid) || (raw.servicePid as number) <= 0) return null;
  return {
    formatVersion: COMPUTER_UPGRADE_DRAIN_FILE_FORMAT_VERSION,
    requestId: raw.requestId,
    origin: raw.origin,
    deadlineAtMs: raw.deadlineAtMs,
    servicePid: raw.servicePid as number,
  };
}

export function parseComputerUpgradeDrainStateFile(raw: unknown): ComputerUpgradeDrainStateFile | null {
  if (!isRecord(raw) || raw.formatVersion !== COMPUTER_UPGRADE_DRAIN_FILE_FORMAT_VERSION) return null;
  if (typeof raw.requestId !== "string" || !raw.requestId) return null;
  if (!Number.isSafeInteger(raw.pid) || !Number.isSafeInteger(raw.live)) return null;
  if (!Array.isArray(raw.notQuietAgentIds) || raw.notQuietAgentIds.some((id) => typeof id !== "string")) return null;
  if (raw.finished !== undefined && !isFinished(raw.finished)) return null;
  if (typeof raw.updatedAtMs !== "number") return null;
  return {
    formatVersion: COMPUTER_UPGRADE_DRAIN_FILE_FORMAT_VERSION,
    requestId: raw.requestId,
    pid: raw.pid as number,
    live: raw.live as number,
    notQuietAgentIds: raw.notQuietAgentIds as string[],
    ...(raw.finished !== undefined ? { finished: raw.finished as ComputerUpgradeDrainFinished } : {}),
    updatedAtMs: raw.updatedAtMs,
  };
}
