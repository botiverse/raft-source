// `raft-computer detach <server>` (device-auth design §3.2): this machine
// leaves one server. The server revokes this machine's key there, with every
// runner key (`sk_agent_*`) the machine minted, and closes their connections
// (POST /internal/computer/detach, authenticated by that key). Only after the
// server confirms is the local credential deleted and that server's runner
// stopped. The machine and its agents stay on the server; it comes back only
// with a new `raft-computer attach <server>` (a new approval).
//
// Why this is not the detach that was removed (PR #3694, task #151): that one
// was a local disconnect. It deleted the local credential and left the server
// key live, so the server still held a working key nobody on the machine had
// (and a later attach by name could not tell a new machine from the old). This
// one changes the server first and the local state second, in that order
// only: there is never a usable server key without its local holder. A
// failure before the server confirms changes nothing locally; a key the
// server already refuses (revoked on the web or by a revoke link, or by an
// earlier detach whose local cleanup failed) is confirmed unusable with a
// second, read-only check before its local copy goes. It is never a side effect of another
// verb: `logout` still changes nothing.
//
// Other people's agents on this machine refuse the detach on the server (409
// `others_agents_on_computer`, the same gate as removing the Computer on the
// web; Tenny, #triage:d10ace06 msg=670f6e97): it lists them and how to go on.
// `--force-unbind <ids>` names them (exactly the ids listed, as the web's
// forceAgentIds) to unbind and stop them there with the detach.
import { readFile, unlink } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import {
  ComputerAttachClient,
  ComputerSelfClient,
  type ComputerDetachResult,
  type DetachBlockingAgent,
  type PreflightResult,
} from "./apiClient";
import { fail, info } from "./output";
import {
  legacyServerAttachmentPath,
  resolveRaftHome,
  serverAttachmentPath,
  serverRunnerPidReadFallback,
} from "./paths";
import {
  clearServerManaged,
  formatServerSlugDisplay,
  migrateKnownServerUrl,
  readServerAttachment,
} from "./serverState";
import { resolveTargetServerId } from "./targetServer";
import { isProcessAlive, readPidfileAt, readProcessStartTimeMsBeforeActing } from "./internal/process-primitives";
import { deferredLockOwner, describeDeferredOwnerNotStopped } from "./runnerLockConflict";

/** A credential for this server found in a local attachment file. */
interface LocalCredential {
  apiKey: string;
  serverUrl: string;
}

export interface DetachDeps {
  resolveRaftHome?: typeof resolveRaftHome;
  resolveTargetServerId?: typeof resolveTargetServerId;
  detachKey?: (serverUrl: string, apiKey: string, forceAgentIds: readonly string[]) => Promise<ComputerDetachResult>;
  preflight?: (serverUrl: string, apiKey: string) => Promise<PreflightResult>;
  isInteractive?: () => boolean;
  confirm?: (question: string) => Promise<boolean>;
  /** Wait for that server's runner to exit after its credential is gone; true when it did. */
  waitForRunnerExit?: (slockHome: string, serverId: string) => Promise<boolean>;
  /** How a deferred-to lock owner's start is read for the line about it (tests replace it). */
  processStartTimeMs?: (pid: number) => Promise<number | undefined>;
  /** Waits, by liveness only, for a deferred-to runner to exit by itself after the revoke (tests replace it). */
  waitForPidExit?: (pid: number) => Promise<boolean>;
  info?: (line: string) => void;
}

// What preflight answers when the server accepts this key for nothing. Today
// requireComputerAuth refuses with a bare 401 (`http_401`) whatever the reason
// (revoked, unknown, its machine unlinked, its server gone), so this proves
// the key is unusable on that server, not that it was revoked: deleting the
// local copy then cannot leave a usable key without its holder. The named
// codes are for a server that names the reason.
const KEY_REFUSED_CODES = new Set([
  "http_401",
  "legacy_machine_key_migrated",
  "computer_key_revoked",
  "computer_revoked",
  "computer_not_found",
  "computer_key_hash_mismatch",
  "invalid_principal",
]);

async function readCredentialAt(path: string): Promise<LocalCredential | null> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    if (raw.kind !== "computer-attachment" || typeof raw.apiKey !== "string" || raw.apiKey.length === 0
      || typeof raw.serverUrl !== "string") return null;
    return { apiKey: raw.apiKey, serverUrl: migrateKnownServerUrl(raw.serverUrl) };
  } catch {
    return null;
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

async function defaultConfirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

const RUNNER_EXIT_WAIT_MS = 15_000;

async function defaultWaitForRunnerExit(slockHome: string, serverId: string): Promise<boolean> {
  // The service drops a server's runner once its credential and managed flag
  // are gone (its reconcile runs every few seconds).
  const deadline = Date.now() + RUNNER_EXIT_WAIT_MS;
  for (;;) {
    let alive = false;
    for (const path of serverRunnerPidReadFallback(slockHome, serverId)) {
      const pid = await readPidfileAt(path);
      if (pid !== null && pid !== process.pid && isProcessAlive(pid)) alive = true;
    }
    if (!alive) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Whether `pid` exits within the runner-exit wait. Polls liveness; never signals. */
async function defaultWaitForPidExit(pid: number): Promise<boolean> {
  const deadline = Date.now() + RUNNER_EXIT_WAIT_MS;
  for (;;) {
    if (!isProcessAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

type RevokeOutcome = "revoked" | "already_refused" | Exclude<ComputerDetachResult, { status: "detached" }>;

/**
 * Server-supplied text on one line: no control characters (a name cannot start
 * a line of its own), no invisible, bidi or other format characters (Unicode
 * Cf: a name cannot reorder or hide the text around it), no line or paragraph
 * separators.
 */
export function oneLine(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\p{Cf}+/gu, "")
    .replace(/ {2,}/g, " ")
    .trim();
}

const AGENT_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Only an id shaped like a server agent id (a UUID) is ever printed, or put into a command to run. */
export function isAgentIdShaped(id: string): boolean {
  return AGENT_ID_SHAPE.test(id);
}

/** `--force-unbind a,b c`: the agent ids, split on commas and spaces, repeats dropped. */
export function parseForceUnbindIds(raw: string | readonly string[] | undefined): string[] {
  const parts = typeof raw === "string" ? [raw] : raw ?? [];
  return [...new Set(parts.flatMap((part) => part.split(/[\s,]+/)).filter((id) => id.length > 0))];
}

function formatBlockingAgents(agents: readonly DetachBlockingAgent[]): string[] {
  return agents.map((agent) => {
    const owner = agent.ownerName ? `owner ${oneLine(agent.ownerName)}` : "no owner to ask";
    return `  ${oneLine(agent.name) || "(unnamed)"} (${owner}): ${isAgentIdShaped(agent.id) ? agent.id : "(unrecognized id)"}`;
  });
}

export async function runDetach(
  opts: { serverSlug: string; yes?: boolean; forceUnbind?: readonly string[] },
  deps: DetachDeps = {},
): Promise<void> {
  const emit = deps.info ?? info;
  const slockHome = (deps.resolveRaftHome ?? resolveRaftHome)();
  const serverId = await (deps.resolveTargetServerId ?? resolveTargetServerId)({ server: opts.serverSlug });
  const attachment = await readServerAttachment(slockHome, serverId);
  if (!attachment) {
    fail("NOT_ATTACHED", `Server ${formatServerSlugDisplay(opts.serverSlug)} is not attached to this machine.`);
  }
  const label = formatServerSlugDisplay(attachment.serverSlug ?? opts.serverSlug);
  const forceAgentIds = [...new Set(opts.forceUnbind ?? [])];
  const forceNote = forceAgentIds.length > 0
    ? ` It also unbinds and stops the ${forceAgentIds.length === 1 ? "agent" : `${forceAgentIds.length} agents`} named with --force-unbind (not deleted).`
    : "";

  if (!opts.yes) {
    const interactive = deps.isInteractive?.() ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (!interactive) {
      fail(
        "DETACH_CONFIRM_REQUIRED",
        `Detaching ${label} revokes this machine's key on that server and the agent keys it issued.${forceNote} ` +
          `Run \`raft-computer detach ${label} --yes${forceAgentIds.length > 0 ? ` --force-unbind ${forceAgentIds.join(",")}` : ""}\` to confirm without a prompt. Nothing was changed.`,
      );
    }
    const confirmed = await (deps.confirm ?? defaultConfirm)(
      `Detach this machine from ${label}? This revokes its key on that server and the agent keys it issued; ` +
        `its agents stop running here until you attach it again.${forceNote} [y/N] `,
    );
    if (!confirmed) {
      emit("Detach cancelled. Nothing was changed.");
      return;
    }
  }

  // Every credential for this server on disk: the one in use, and a leftover
  // in the older attachment.json if it holds a different key. Each must be
  // revoked (or already refused) before any local file goes, or a live key
  // would be left with no holder.
  const credentials: LocalCredential[] = [{ apiKey: attachment.apiKey, serverUrl: attachment.serverUrl }];
  for (const path of [serverAttachmentPath(slockHome, serverId), legacyServerAttachmentPath(slockHome, serverId)]) {
    const credential = await readCredentialAt(path);
    if (credential && !credentials.some((c) => c.apiKey === credential.apiKey)) credentials.push(credential);
  }

  const detachKey = deps.detachKey
    ?? ((serverUrl: string, apiKey: string, force: readonly string[]) => new ComputerSelfClient(serverUrl, apiKey).detach(force));
  const preflight = deps.preflight ?? ((serverUrl: string, apiKey: string) => new ComputerAttachClient(serverUrl, "").preflight(apiKey));
  const revokeOne = async (credential: LocalCredential): Promise<RevokeOutcome> => {
    const result = await detachKey(credential.serverUrl, credential.apiKey, forceAgentIds);
    if (result.status === "detached") return "revoked";
    if (result.status === "unauthorized" && result.httpStatus === 401) {
      // Only a second, read-only answer that the server refuses this key
      // lets its local copy go without a revoke here.
      const check = await preflight(credential.serverUrl, credential.apiKey).catch((): PreflightResult => ({ ok: false, code: "request_failed" }));
      if (!check.ok && KEY_REFUSED_CODES.has(check.code)) return "already_refused";
    }
    return result;
  };

  // Read before the revoke: once the server refuses the key a runner's socket
  // drops and its connected marker goes, and the service then forgets the
  // record. A lock owner the service deferred to for this server is never
  // signalled, whoever it is: say which process was left running.
  const lockOwner = await deferredLockOwner(slockHome, serverId, {
    processStartTimeMs: deps.processStartTimeMs ?? readProcessStartTimeMsBeforeActing,
  });

  let revokedHere = 0;
  for (const credential of credentials) {
    const outcome = await revokeOne(credential);
    if (outcome === "revoked") {
      revokedHere += 1;
      continue;
    }
    if (outcome === "already_refused") continue;
    const before = revokedHere > 0
      ? "This machine's current key on that server was revoked, but an older one saved here was not; local files were kept."
      : "No key was revoked and nothing was changed on this machine.";
    if (outcome.status === "others_agents") {
      emit(`Other people's agents run on this machine on ${label}, so the server did not detach it:`);
      for (const line of formatBlockingAgents(outcome.agents)) emit(line);
      emit("Ask their owners to move them to another computer (you can notify them from this Computer on the server's Computers page on the web), then detach again.");
      if (outcome.agents.length === 0 || !outcome.agents.every((agent) => isAgentIdShaped(agent.id))) {
        // An id this command cannot vouch for never goes into a command to run.
        fail(
          "DETACH_OTHERS_AGENTS",
          `Other people's agents run on this machine on ${label}. ${before} ` +
            "The server's answer did not name them in a form this command can use; " +
            "remove this Computer from the server's Computers page on the web instead.",
        );
      }
      const ids = outcome.agents.map((agent) => agent.id).join(",");
      fail(
        "DETACH_OTHERS_AGENTS",
        `Other people's agents run on this machine on ${label}. ${before} ` +
          `To unbind and stop them there (they are not deleted; their owners are told) and detach, run ` +
          `\`raft-computer detach ${label}${opts.yes ? " --yes" : ""} --force-unbind ${ids}\`.`,
      );
    }
    if (outcome.status === "route_unavailable") {
      fail(
        "DETACH_SERVER_TOO_OLD",
        `The server for ${label} is too old to detach a Computer. ${before} ` +
          "Revoke this Computer from the server's Computers page on the web instead.",
      );
    }
    if (outcome.status === "unauthorized") {
      fail(
        "DETACH_KEY_REFUSED",
        `The server for ${label} refused this machine's key (${outcome.code}) and did not confirm it is revoked. ${before} ` +
          `Check with \`raft-computer doctor ${label}\`, or revoke this Computer from the server's Computers page on the web.`,
      );
    }
    fail(
      "DETACH_SERVER_UNREACHABLE",
      `Could not detach from ${label} (${outcome.code}). ${before} Check the network and retry \`raft-computer detach ${label}\`.`,
    );
  }

  emit(revokedHere > 0
    ? `Revoked this machine's key on ${label}, and the agent keys it issued.`
    : `The server for ${label} already refuses this machine's key; removing the local copy.`);

  // The server side is done: now this machine forgets that server.
  try {
    await clearServerManaged(slockHome, serverId);
    await unlinkIfPresent(legacyServerAttachmentPath(slockHome, serverId));
    await unlinkIfPresent(serverAttachmentPath(slockHome, serverId));
  } catch (err) {
    fail(
      "DETACH_LOCAL_CLEANUP_FAILED",
      `The server revoked this machine's key on ${label}, but its local copy could not be removed ` +
        `(${err instanceof Error ? err.message : String(err)}). Retry \`raft-computer detach ${label}\`.`,
    );
  }
  emit(`Removed this machine's saved key for ${label}.`);

  if (lockOwner) {
    // This server's own runner ends by itself once the server refuses its
    // key: look again before saying it is still running. Liveness only: no
    // signal. Any other owner has nothing to do with the revoke.
    const gone = lockOwner.identity === "own-runner" && (await (deps.waitForPidExit ?? defaultWaitForPidExit)(lockOwner.pid));
    if (!gone) {
      const left = describeDeferredOwnerNotStopped(lockOwner);
      emit(`Detached from ${label}. ${left[0]!.toUpperCase()}${left.slice(1)} To connect this machine again, run \`raft-computer attach ${label}\`.`);
      return;
    }
    emit(`Detached from ${label}. To connect this machine again, run \`raft-computer attach ${label}\`.`);
    return;
  }
  const stopped = await (deps.waitForRunnerExit ?? defaultWaitForRunnerExit)(slockHome, serverId);
  emit(stopped
    ? `Detached from ${label}. To connect this machine again, run \`raft-computer attach ${label}\`.`
    : `Detached from ${label}; its runner is still stopping (check with \`raft-computer status\`). ` +
      `To connect this machine again, run \`raft-computer attach ${label}\`.`);
}
