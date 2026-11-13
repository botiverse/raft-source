// Reconciler step 13 (PR 3): the service's half of a drained web upgrade.
//
// After the upgrade passed its refusal checks and the installer is resolved
// and verified, and right before the installer is spawned, the service asks
// every runner it supervises (one per attached server, Tenny Q-J) to hold new
// work and wait for its agents to be quiet: `upgrade-drain.json` in the
// server's directory, read by the runner's drain channel (daemon
// computerUpgradeDrain.ts). Each runner answers in `upgrade-drain-state.json`.
// The service spawns the installer once every runner finished (quiet, its
// deadline, or let go) or is gone, or at the deadline plus a pick-up grace.
//
// The request files stay while the installer stops the service: a runner
// that let go before its shutdown would deliver the held work into turns the
// shutdown cuts off. They are removed when the upgrade does not go on (the
// spawn failed, the installer gave up without stopping the service), and by
// the next service's startup recovery when the service that wrote them is
// gone. A runner also lets go by itself at its hold cap.
import { readdir, readFile, rm, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  COMPUTER_UPGRADE_DRAIN_FILE_FORMAT_VERSION,
  parseComputerUpgradeDrainRequestFile,
  parseComputerUpgradeDrainStateFile,
  type ComputerUpgradeDrainRequestFile,
} from "@botiverse/raft-shared";
import { isProcessAlive } from "./internal/process-primitives";
import { SERVER_UPGRADE_DRAIN_REQUEST_FILE, serversDir, serverUpgradeDrainRequestPath, serverUpgradeDrainStatePath } from "./paths";

/** How often the service reads the runners' drain state. */
export const UPGRADE_DRAIN_POLL_MS = 1_000;
/**
 * Past the deadline, how long the service still waits for a runner to report
 * that its own deadline passed (its poll is 1 s, its deadline timer fires on
 * the same clock).
 */
export const UPGRADE_DRAIN_PICKUP_GRACE_MS = 5_000;

export interface UpgradeDrainRunner {
  serverId: string;
  pid: number;
}

export interface UpgradeDrainRequest {
  requestId: string;
  originServerId: string;
  deadlineAtMs: number;
  servicePid: number;
}

export interface UpgradeDrainOutcome {
  /** `quiet`: every runner was quiet; `deadline`: one was not when the wait ended; `ended`: one let go of the drain (a reconnect, its hold cap). */
  finished: "quiet" | "deadline" | "ended";
  durationMs: number;
  /** Agents not quiet when the wait ended (an unknown runner counts once). */
  notQuietAtEnd: number;
  runners: number;
}

async function writeAtomic(file: string, body: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, body, { mode: 0o600 });
  await rename(temporary, file);
}

/** Ask one runner to drain (idempotent; a state file of an earlier drain is removed first). */
export async function writeUpgradeDrainRequest(slockHome: string, runner: UpgradeDrainRunner, request: UpgradeDrainRequest): Promise<void> {
  const file: ComputerUpgradeDrainRequestFile = {
    formatVersion: COMPUTER_UPGRADE_DRAIN_FILE_FORMAT_VERSION,
    requestId: request.requestId,
    origin: runner.serverId === request.originServerId,
    deadlineAtMs: request.deadlineAtMs,
    servicePid: request.servicePid,
  };
  await rm(serverUpgradeDrainStatePath(slockHome, runner.serverId), { force: true });
  await writeAtomic(serverUpgradeDrainRequestPath(slockHome, runner.serverId), `${JSON.stringify(file)}\n`);
}

async function readRequest(slockHome: string, serverId: string): Promise<ComputerUpgradeDrainRequestFile | null> {
  try {
    return parseComputerUpgradeDrainRequestFile(JSON.parse(await readFile(serverUpgradeDrainRequestPath(slockHome, serverId), "utf8")));
  } catch {
    return null;
  }
}

/**
 * Remove the drain files of every server: the runners let go of the drain
 * and deliver what it held. `onlyStale`: only those a service that is gone
 * wrote (startup recovery must not end a live service's drain). Returns how
 * many requests were removed.
 */
export async function clearUpgradeDrainRequests(
  slockHome: string,
  options: { onlyStale?: boolean; isAlive?: (pid: number) => boolean } = {},
): Promise<number> {
  const alive = options.isAlive ?? isProcessAlive;
  let entries: string[];
  try {
    entries = await readdir(serversDir(slockHome));
  } catch {
    return 0;
  }
  let removed = 0;
  for (const serverId of entries) {
    const dir = join(serversDir(slockHome), serverId);
    const requestFile = join(dir, SERVER_UPGRADE_DRAIN_REQUEST_FILE);
    let request: ComputerUpgradeDrainRequestFile | null | undefined;
    try {
      request = parseComputerUpgradeDrainRequestFile(JSON.parse(await readFile(requestFile, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      request = null;
    }
    if (options.onlyStale && request && alive(request.servicePid)) continue;
    await rm(requestFile, { force: true });
    await rm(join(dir, "upgrade-drain-state.json"), { force: true });
    removed += 1;
  }
  return removed;
}

/**
 * Wait until every runner finished its drain or is gone, or the deadline
 * plus UPGRADE_DRAIN_PICKUP_GRACE_MS passed. A runner without a request
 * (spawned since) is asked on the next poll.
 */
export async function waitForUpgradeDrain(slockHome: string, options: {
  request: UpgradeDrainRequest;
  runners: () => UpgradeDrainRunner[];
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  pickupGraceMs?: number;
}): Promise<UpgradeDrainOutcome> {
  const now = options.now ?? Date.now;
  const alive = options.isAlive ?? isProcessAlive;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref(); }));
  const startedAtMs = now();
  const { request } = options;
  const giveUpAtMs = request.deadlineAtMs + (options.pickupGraceMs ?? UPGRADE_DRAIN_PICKUP_GRACE_MS);
  for (;;) {
    const runners = options.runners().filter((runner) => alive(runner.pid));
    let pendingNotQuiet = 0;
    let pending = 0;
    let deadline = false;
    let ended = false;
    for (const runner of runners) {
      if ((await readRequest(slockHome, runner.serverId))?.requestId !== request.requestId) {
        await writeUpgradeDrainRequest(slockHome, runner, request).catch(() => undefined);
      }
      let state = null;
      try {
        state = parseComputerUpgradeDrainStateFile(JSON.parse(await readFile(serverUpgradeDrainStatePath(slockHome, runner.serverId), "utf8")));
      } catch {
        state = null;
      }
      const own = state && state.requestId === request.requestId && state.pid === runner.pid ? state : null;
      if (own?.finished) {
        if (own.finished === "deadline") deadline = true;
        if (own.finished === "ended") ended = true;
        pendingNotQuiet += own.finished === "quiet" ? 0 : own.notQuietAgentIds.length;
        continue;
      }
      pending += 1;
      pendingNotQuiet += own ? own.notQuietAgentIds.length : 1;
    }
    const at = now();
    if (pending === 0 || at >= giveUpAtMs) {
      return {
        finished: pending > 0 || deadline ? "deadline" : ended ? "ended" : "quiet",
        durationMs: at - startedAtMs,
        notQuietAtEnd: pendingNotQuiet,
        runners: runners.length,
      };
    }
    await sleep(Math.max(1, Math.min(options.pollMs ?? UPGRADE_DRAIN_POLL_MS, giveUpAtMs - at)));
  }
}
