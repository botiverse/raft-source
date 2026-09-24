// AdoptLegacyService — Computer domain service for §5.11 / §6 / §9 / §10
// legacy-machine adoption (RFC v0.8 contract v3 v8.2). CLI and Electron
// main are both adapters over this surface; the service itself never
// touches process.stdout / process.stderr / process.exit / process.stdin.
//
// Shape (Hao msg=51a17400 + liuliu msg=7a1a2c3d / 35034229 / 240069cd):
//   - typed AdoptLegacyInput + AdoptLegacyOptions (onEvent best-effort + AbortSignal)
//   - typed AdoptLegacyResult on success — SECRET-FREE (raw legacy
//     sk_machine_*/sk_daemon_* and the freshly-issued sk_computer_* both
//     live only in attachment.json, mode 0o600). Event + result carry
//     ONLY an 8-char `apiKeyRedactedPrefix` of the FRESH key (mirrors the
//     adoption.log redacted_prefix convention). The legacy key prefix
//     flows in on the input (already resolved by the adapter) and is
//     persisted to adoption.log only as the 8-char prefix.
//   - typed `ComputerServiceError { code, message, cause? }` thrown on
//     failure; cause retained in-process only — adapters MUST NOT forward it.
//   - §6/§9 service codes remain byte-identical, including LEGACY_MACHINE_NOT_FOUND;
//     process-bound source-resolution codes stay in the CLI adapter.
//   - Fail-closed invariant (§5.11 / Jianwei #39 acceptance):
//       PREFLIGHT_FAILED       → no attachment.json
//       LEGACY_DAEMON_STOP_FAILED → no attachment.json
//     Adoption.log is forensic and ALWAYS appended (best-effort) — even
//     on failure paths.
//   - AbortSignal honored before each network/fs boundary. After the
//     local-state write commits, abort is a no-op (state is committed).
import { chmod, mkdir, readFile, writeFile, appendFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ComputerAttachClient } from "../apiClient.js";
import { LEGACY_MACHINE_NOT_FOUND_MESSAGE } from "../lib/adoptLegacyResponse.js";
import { refreshUserSession } from "../lib/userSession.js";
import {
  resolveRaftHome,
  userSessionPath,
  serverAttachmentPath,
  adoptionLogPath,
  computerDir,
} from "../paths.js";
import { formatServerSlugDisplay, normalizeServerSlug } from "../serverState.js";
import { resolveServerUrl, resolveServerUrlEnv } from "../serverUrl.js";
import { ComputerServiceError } from "./errors.js";

interface UserSession {
  kind?: string;
  userId?: string;
  accessToken?: string;
  serverUrl?: string;
}

/** Credential bridge mode — §5.11.4 closed enum, snake_case byte-exact. */
export type CredentialBridgeMode =
  | "legacy_key_argv"
  | "legacy_key_file"
  | "legacy_key_stdin"
  | "legacy_key_env"
  | "legacy_fingerprint_roster"
  | "legacy_daemon_id_roster";

export interface AdoptLegacyInput {
  serverSlug: string;
  serverUrl?: string;
  name?: string;
  /** Raw legacy api key (sk_machine_* / sk_daemon_*). REQUIRED INPUT for
   *  the server adopt call. NEVER echoed on events / result / log. The
   *  adapter is responsible for the 4-channel exactly-one-source resolution
   *  (LEGACY_KEY_REQUIRED / LEGACY_KEY_MULTIPLE_SOURCES / LEGACY_KEY_INVALID
   *  prefix-shape) and for clearing the source after read. */
  rawKey: string;
  mode: CredentialBridgeMode;
  /** First 8 characters of the LEGACY raw key — mirrors adoption.log
   *  legacy_key_prefix convention. The full raw key MUST be passed via
   *  rawKey only and held in this service's locals for the smallest
   *  possible window. */
  redactedPrefix: string;
}

export interface AdoptLegacyByFingerprintInput {
  serverSlug: string;
  serverUrl?: string;
  name?: string;
  /** Server roster identity selected after user login. */
  legacyMachineId: string;
  /** sha256(legacy api key).slice(0,16), intersected with local owner.json. */
  apiKeyFingerprint: string;
  /** Absolute local owner.json path from detection/validation. */
  legacyOwnerPath: string;
}

export interface AdoptLegacyByDaemonIdInput {
  serverSlug: string;
  serverUrl?: string;
  name?: string;
  /** Server roster identity selected after user login. */
  legacyMachineId: string;
}

export interface LegacyStopResult {
  attempted: boolean;
  pid?: number;
  outcome: "absent" | "already_dead" | "stopped" | "timed_out" | "denied" | "error";
  reason?: string;
}

export interface AdoptLegacyResult {
  serverId: string;
  serverMachineId: string;
  /** Legacy machine row id — emitted by the server on success so the
   *  attachment.json can carry `adoptedFromLegacy: true` / `legacyMachineId`. */
  legacyMachineId: string;
  serverSlug: string;
  serverUrl: string;
  attachmentPath: string;
  resumed: boolean;
  /** First 8 characters of the FRESHLY-ISSUED sk_computer_*; mirrors
   *  attachment.json/adoption.log convention. The raw fresh key lives ONLY
   *  in attachment.json (mode 0o600) — NEVER on this event/result. */
  apiKeyRedactedPrefix: string;
  legacyStop: LegacyStopResult;
}

export type AdoptLegacyEvent =
  | { type: "adopting"; serverSlug: string; mode: CredentialBridgeMode }
  | { type: "preflight"; resumed: boolean }
  | {
      type: "adopted";
      serverId: string;
      serverMachineId: string;
      legacyMachineId: string;
      serverSlug: string;
      attachmentPath: string;
      resumed: boolean;
      apiKeyRedactedPrefix: string;
      legacyStop: LegacyStopResult;
    };

export interface AdoptLegacyOptions {
  signal?: AbortSignal;
  onEvent?: (event: AdoptLegacyEvent) => void;
}

function emit(opts: AdoptLegacyOptions | undefined, event: AdoptLegacyEvent): void {
  const cb = opts?.onEvent;
  if (!cb) return;
  try {
    cb(event);
  } catch {
    // onEvent is best-effort — never let a renderer/listener fault break
    // the adopt flow.
  }
}

// --- legacy daemon pid stop (§5.11 / Jianwei's acceptance for #39) ---
//
// The legacy daemon writes its lock at
//   `<SLOCK_HOME>/machines/machine-<sha256(rawKey)[0..15]>/daemon.lock/owner.json`
// (see daemon/machineLock.ts). Adoption's post-success step:
//   1. derive the fingerprint from the raw key (BEFORE we drop the key)
//   2. read owner.json → pid
//   3. SIGTERM + wait-for-exit (up to STOP_WAIT_MS)
// All steps are best-effort with stable RETURN codes; failures are logged
// to adoption.log via `failureReason`.
const LEGACY_STOP_WAIT_MS = 10_000;
const LEGACY_STOP_POLL_MS = 200;

interface LegacyOwnerEvidence {
  ownerFile: string;
  pid?: number;
  alive?: boolean;
  startedAt?: string;
  serverUrl?: string;
  reason?: string;
}

export function legacyLockOwnerPath(slockHome: string, rawKey: string): string {
  return join(slockHome, "machines", `machine-${legacyApiKeyFingerprint(rawKey)}`, "daemon.lock", "owner.json");
}

function legacyApiKeyFingerprint(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex").slice(0, 16);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = typeof err === "object" && err && "code" in err ? (err as { code?: string }).code : undefined;
    return code !== "ESRCH";
  }
}

async function stopLegacyDaemonByOwnerFile(
  ownerFile: string,
): Promise<LegacyStopResult> {
  let raw: string;
  try {
    raw = await readFile(ownerFile, "utf8");
  } catch {
    return { attempted: false, outcome: "absent" };
  }
  let pid: number;
  try {
    const owner = JSON.parse(raw) as { pid?: unknown };
    if (typeof owner.pid !== "number") {
      return { attempted: false, outcome: "error", reason: "owner_json_missing_pid" };
    }
    pid = owner.pid;
  } catch {
    return { attempted: false, outcome: "error", reason: "owner_json_unparseable" };
  }
  if (!isProcessAlive(pid)) {
    return { attempted: false, pid, outcome: "already_dead" };
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    const code = typeof err === "object" && err && "code" in err ? (err as { code?: string }).code : undefined;
    if (code === "EPERM") return { attempted: true, pid, outcome: "denied", reason: "eperm" };
    return { attempted: true, pid, outcome: "error", reason: code ?? "signal_failed" };
  }
  const deadline = Date.now() + LEGACY_STOP_WAIT_MS;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return { attempted: true, pid, outcome: "stopped" };
    await delay(LEGACY_STOP_POLL_MS);
  }
  return { attempted: true, pid, outcome: "timed_out" };
}

async function readLegacyOwnerEvidence(ownerFile: string): Promise<LegacyOwnerEvidence> {
  let raw: string;
  try {
    raw = await readFile(ownerFile, "utf8");
  } catch {
    return { ownerFile, reason: "owner_file_absent" };
  }
  let owner: Record<string, unknown>;
  try {
    owner = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { ownerFile, reason: "owner_json_unparseable" };
  }

  const pid = typeof owner.pid === "number" ? owner.pid : undefined;
  return {
    ownerFile,
    pid,
    alive: typeof pid === "number" ? isProcessAlive(pid) : undefined,
    startedAt: typeof owner.startedAt === "string" ? owner.startedAt : undefined,
    serverUrl: typeof owner.serverUrl === "string" ? owner.serverUrl : undefined,
    reason: typeof pid === "number" ? undefined : "owner_json_missing_pid",
  };
}

function formatLegacyOwnerEvidence(slockHome: string, evidence: LegacyOwnerEvidence): string {
  const fields = [
    `SLOCK_HOME=${slockHome}`,
    `owner=${evidence.ownerFile}`,
  ];
  if (typeof evidence.pid === "number") {
    fields.push(`pid=${evidence.pid}`);
    if (typeof evidence.alive === "boolean") fields.push(`alive=${evidence.alive}`);
  }
  if (evidence.startedAt) fields.push(`startedAt=${evidence.startedAt}`);
  if (evidence.serverUrl) fields.push(`serverUrl=${evidence.serverUrl}`);
  if (evidence.reason) fields.push(`ownerStatus=${evidence.reason}`);
  return fields.join(" ");
}

interface UserSessionContext {
  accessToken: string;
  baseUrl: string;
}

async function readUserSessionContext(
  slockHome: string,
  serverUrl?: string,
): Promise<UserSessionContext> {
  const sessionFile = userSessionPath(slockHome);

  let session: UserSession;
  try {
    session = JSON.parse(await readFile(sessionFile, "utf8")) as UserSession;
  } catch (err) {
    throw new ComputerServiceError(
      "NO_USER_SESSION",
      `No user session at ${sessionFile}. Run \`raft-computer login\` first.`,
      err,
    );
  }
  if (session.kind !== "user-session" || typeof session.accessToken !== "string" || !session.accessToken) {
    throw new ComputerServiceError(
      "INVALID_USER_SESSION",
      `User session at ${sessionFile} is invalid. Re-run \`raft-computer login\`.`,
    );
  }

  return {
    accessToken: session.accessToken,
    baseUrl: resolveServerUrl(serverUrl, session.serverUrl, resolveServerUrlEnv()),
  };
}

interface AdoptionLogIdentity {
  mode: CredentialBridgeMode;
  redactedPrefix?: string;
  legacyFingerprint?: string;
  legacyMachineId?: string;
}

interface AdoptionCopy {
  invalidFailureReason: string;
  invalidMessage: string;
  migratedMessage: string;
  authRequiredMessage: string;
  failedMessage: (code: string) => string;
  stopFailureRetryCommand: string;
  unexpectedAuthHint?: (httpStatus: number) => string;
}

async function appendAdoptionFailureLog(
  slockHome: string,
  log: AdoptionLogIdentity,
  startedAt: Date,
  failureReason: string,
  extra: Partial<Pick<AdoptionLogLine, "computerId" | "machineId" | "serverId" | "legacyStop">> = {},
): Promise<void> {
  await appendAdoptionLog(slockHome, {
    ...log,
    startedAt,
    outcome: "failed",
    failureReason,
    ...extra,
  });
}

async function completeAdoptionExchange(
  input: {
    slockHome: string;
    client: ComputerAttachClient;
    baseUrl: string;
    slugForServer: string;
    ownerEvidence: LegacyOwnerEvidence;
    legacyOwnerFile: string;
    legacyApiKeyFingerprint?: string;
    result: Awaited<ReturnType<ComputerAttachClient["adoptLegacy"]>>;
    startedAt: Date;
    log: AdoptionLogIdentity;
    copy: AdoptionCopy;
  },
  options: AdoptLegacyOptions,
): Promise<AdoptLegacyResult> {
  const {
    slockHome,
    client,
    baseUrl,
    slugForServer,
    ownerEvidence,
    legacyOwnerFile,
    legacyApiKeyFingerprint,
    result,
    startedAt,
    log,
    copy,
  } = input;

  if (result.status === "disabled") {
    await appendAdoptionFailureLog(slockHome, log, startedAt, "computer_adopt_disabled");
    throw new ComputerServiceError(
      "ADOPT_DISABLED",
      "Computer legacy adoption is not enabled on this server. Upgrade the server or set SLOCK_DEVICE_LOGIN_ENABLED.",
    );
  }
  if (result.status === "legacy_key_invalid") {
    await appendAdoptionFailureLog(slockHome, log, startedAt, copy.invalidFailureReason);
    throw new ComputerServiceError("LEGACY_KEY_INVALID", copy.invalidMessage);
  }
  if (result.status === "legacy_machine_key_migrated") {
    await appendAdoptionFailureLog(slockHome, log, startedAt, "legacy_machine_key_migrated");
    throw new ComputerServiceError("LEGACY_MACHINE_KEY_MIGRATED", copy.migratedMessage);
  }
  if (result.status === "legacy_machine_not_found") {
    await appendAdoptionFailureLog(slockHome, log, startedAt, "legacy_machine_not_found");
    throw new ComputerServiceError("LEGACY_MACHINE_NOT_FOUND", LEGACY_MACHINE_NOT_FOUND_MESSAGE);
  }
  if (result.status === "auth_required") {
    await appendAdoptionFailureLog(slockHome, log, startedAt, "auth_required");
    throw new ComputerServiceError("ADOPT_AUTH_REQUIRED", copy.authRequiredMessage);
  }
  if (result.status === "not_authorized") {
    await appendAdoptionFailureLog(slockHome, log, startedAt, "not_authorized");
    throw new ComputerServiceError(
      "ADOPT_NOT_AUTHORIZED",
      "Not authorized to adopt this machine on this server. Check that you are a current member.",
    );
  }
  if (result.status === "requires_admin") {
    await appendAdoptionFailureLog(slockHome, log, startedAt, "requires_admin");
    throw new ComputerServiceError(
      "ADOPT_REQUIRES_ADMIN",
      "Adopting a legacy machine into a Computer requires the admin or owner role on this server. You are a member, but holding the legacy machine key is not enough — ask a server admin to adopt it or to grant you the admin role.",
    );
  }
  if (result.status === "unexpected_response") {
    await appendAdoptionFailureLog(
      slockHome,
      log,
      startedAt,
      result.code ? `unexpected_response_${result.code}` : "unexpected_response_missing_code",
    );
    const responseDetail = result.code
      ? `status ${result.httpStatus}, code ${result.code}`
      : `status ${result.httpStatus}, missing error code`;
    const authHint = copy.unexpectedAuthHint?.(result.httpStatus) ?? "";
    throw new ComputerServiceError(
      "ADOPT_UNEXPECTED_RESPONSE",
      `Server returned an unexpected legacy adoption response (${responseDetail}).${authHint} Local legacy owner evidence: ${formatLegacyOwnerEvidence(slockHome, ownerEvidence)}. Please report this with the command, server URL, and SLOCK_HOME; no local Computer state was written.`,
    );
  }
  if (result.status === "network_failed") {
    await appendAdoptionFailureLog(slockHome, log, startedAt, "network_failed");
    throw new ComputerServiceError(
      "ADOPT_NETWORK_FAILED",
      `Could not reach the Computer server at ${result.serverUrl} while adopting the legacy daemon. Check the network/VPN and --server-url, then retry ${copy.stopFailureRetryCommand}. No local Computer state was written.`,
    );
  }
  if (result.status === "error") {
    await appendAdoptionFailureLog(slockHome, log, startedAt, result.code);
    throw new ComputerServiceError("ADOPT_FAILED", copy.failedMessage(result.code));
  }

  // result.status === "success" — we now hold a fresh sk_computer_*.
  // Run §9 preflight before committing local state, mirroring `attach`.
  emit(options, { type: "preflight", resumed: result.resumed });
  options.signal?.throwIfAborted?.();
  const pre = await client.preflight(result.apiKey);
  if (!pre.ok) {
    await appendAdoptionFailureLog(slockHome, log, startedAt, `preflight_${pre.code}`);
    throw new ComputerServiceError(
      "PREFLIGHT_FAILED",
      `Server preflight failed (${pre.code}); local state not written. Upgrade the server or retry.`,
    );
  }

  // Stop the legacy daemon process BEFORE writing attachment.json
  // (RFC v8.2 §5.11 / Jianwei #39 acceptance). The server already rejects
  // the old key with `legacy_machine_key_migrated`, but the v8.2 single-owner
  // invariant also demands that the local lock file no longer represents a
  // live process. If the legacy pid cannot be stopped (timed_out / denied /
  // error), fail closed: do NOT write attachment.json, so `raft-computer
  // start` cannot mint a second supervisor while the legacy daemon is still
  // alive locally.
  options.signal?.throwIfAborted?.();
  const stop = await stopLegacyDaemonByOwnerFile(legacyOwnerFile);
  if (stop.outcome === "timed_out" || stop.outcome === "denied" || stop.outcome === "error") {
    await appendAdoptionFailureLog(slockHome, log, startedAt, `legacy_stop_${stop.outcome}`, {
      computerId: result.computerId,
      machineId: result.machineId,
      serverId: result.serverId,
      legacyStop: stop,
    });
    const detail =
      stop.outcome === "timed_out"
        ? `pid ${stop.pid} did not exit within ${LEGACY_STOP_WAIT_MS}ms`
        : stop.outcome === "denied"
          ? `pid ${stop.pid} cannot be stopped (permission denied)`
          : `stop attempt error (${stop.reason ?? "unknown"})`;
    throw new ComputerServiceError(
      "LEGACY_DAEMON_STOP_FAILED",
      `Adoption succeeded server-side but the legacy daemon could not be stopped: ${detail}. Run ${copy.stopFailureRetryCommand} after stopping the legacy daemon with your OS service controls, or run \`raft-computer attach\` after confirming the legacy process is gone. No local Computer state was written.`,
    );
  }

  const file = serverAttachmentPath(slockHome, result.serverId);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify(
      {
        kind: "computer-attachment",
        serverId: result.serverId,
        serverSlug: slugForServer,
        serverMachineId: result.computerId,
        apiKey: result.apiKey,
        serverUrl: baseUrl,
        attachedAt: new Date().toISOString(),
        adoptedFromLegacy: true,
        legacyMachineId: result.machineId,
        ...(legacyApiKeyFingerprint ? { legacyApiKeyFingerprint } : {}),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  // writeFile mode only applies on create; force 0o600 on the resume
  // (overwrite) path too so a rotated credential never widens perms.
  await chmod(file, 0o600);

  await appendAdoptionLog(slockHome, {
    ...log,
    startedAt,
    outcome: "succeeded",
    computerId: result.computerId,
    machineId: result.machineId,
    serverId: result.serverId,
    legacyStop: stop,
  });

  const apiKeyRedactedPrefix = result.apiKey.slice(0, 8);
  emit(options, {
    type: "adopted",
    serverId: result.serverId,
    serverMachineId: result.computerId,
    legacyMachineId: result.machineId,
    serverSlug: slugForServer,
    attachmentPath: file,
    resumed: result.resumed,
    apiKeyRedactedPrefix,
    legacyStop: stop,
  });

  return {
    serverId: result.serverId,
    serverMachineId: result.computerId,
    legacyMachineId: result.machineId,
    serverSlug: slugForServer,
    serverUrl: baseUrl,
    attachmentPath: file,
    resumed: result.resumed,
    apiKeyRedactedPrefix,
    legacyStop: stop,
  };
}


/**
 * A MATCHED migration must not die on a refreshable session (PR-A2,
 * #wg-raft-computer:f818952a — the 0.71 field case: the interactive setup
 * flow outlived the 15-minute access token and the adopt POST failed
 * `auth_required` 240ms in). On the FIRST `auth_required`, refresh the user
 * session once, rebuild the client with the new token, and retry the same
 * call; only a second `auth_required` (refresh unavailable/failed or the
 * server still rejecting) surfaces to the caller.
 */
async function retryOnceOnAuthRequired<T extends { status: string }>(
  slockHome: string,
  serverUrl: string | undefined,
  firstClient: ComputerAttachClient,
  call: (client: ComputerAttachClient) => Promise<T>,
): Promise<{ client: ComputerAttachClient; result: T }> {
  let client = firstClient;
  let result = await call(client);
  if (result.status === "auth_required") {
    const refreshed = await refreshUserSession(slockHome, serverUrl).catch(() => false);
    if (refreshed) {
      const ctx = await readUserSessionContext(slockHome, serverUrl);
      client = new ComputerAttachClient(ctx.baseUrl, ctx.accessToken);
      result = await call(client);
    }
  }
  return { client, result };
}

export async function adoptLegacy(
  input: AdoptLegacyInput,
  options: AdoptLegacyOptions = {},
): Promise<AdoptLegacyResult> {
  options.signal?.throwIfAborted?.();
  const slockHome = resolveRaftHome();
  const { accessToken, baseUrl } = await readUserSessionContext(slockHome, input.serverUrl);

  const slugForServer = normalizeServerSlug(input.serverSlug);
  if (!slugForServer) {
    throw new ComputerServiceError("ADOPT_NOT_AUTHORIZED", "Server slug must not be empty.");
  }

  options.signal?.throwIfAborted?.();
  emit(options, { type: "adopting", serverSlug: slugForServer, mode: input.mode });

  const adoptStartedAt = new Date();
  // Compute the legacy lock fingerprint BEFORE the network call so we can
  // drop the raw key reference as soon as the response lands. The lock
  // owner path is derived from the SHA-256 of the raw key.
  const legacyOwnerFile = legacyLockOwnerPath(slockHome, input.rawKey);
  const fingerprint = legacyApiKeyFingerprint(input.rawKey);
  const ownerEvidence = await readLegacyOwnerEvidence(legacyOwnerFile);
  const { client, result } = await retryOnceOnAuthRequired(
    slockHome,
    input.serverUrl,
    new ComputerAttachClient(baseUrl, accessToken),
    (c) => c.adoptLegacy(input.rawKey, input.name),
  );
  // Best-effort scrub of the raw key memory binding. JS can't truly zero
  // a string, but we drop the reference so no later code path sees it.
  (input as { rawKey?: string }).rawKey = undefined;

  return completeAdoptionExchange(
    {
      slockHome,
      client,
      baseUrl,
      slugForServer,
      ownerEvidence,
      legacyOwnerFile,
      legacyApiKeyFingerprint: fingerprint,
      result,
      startedAt: adoptStartedAt,
      log: { mode: input.mode, redactedPrefix: input.redactedPrefix },
      copy: {
        invalidFailureReason: "legacy_key_invalid",
        invalidMessage: `Server rejected the legacy api key (unknown / wrong server / malformed). Local legacy owner evidence for this key: ${formatLegacyOwnerEvidence(slockHome, ownerEvidence)}. Verify the key came from this SLOCK_HOME and server, or use a fresh isolated SLOCK_HOME for a clean Computer setup.`,
        migratedMessage: `This machine has already been adopted; the legacy key is no longer accepted. Local legacy owner evidence for this key: ${formatLegacyOwnerEvidence(slockHome, ownerEvidence)}. Use \`raft-computer attach\` to add another Computer attachment, or use a fresh isolated SLOCK_HOME for a clean setup.`,
        authRequiredMessage: `Your Computer user session was rejected by the server before legacy adoption. Local legacy owner evidence for this key: ${formatLegacyOwnerEvidence(slockHome, ownerEvidence)}. Re-run \`raft-computer login\` for this server (use the same \`--server-url\` if not on production), then retry the adopt command. No local Computer state was written.`,
        failedMessage: (code) =>
          `Adoption failed at server exchange (${code}). Local legacy owner evidence for this key: ${formatLegacyOwnerEvidence(slockHome, ownerEvidence)}. Confirm the user session is valid, the legacy key belongs to this server/SLOCK_HOME, and the server URL is correct. No local Computer state was written.`,
        stopFailureRetryCommand: `\`raft-computer setup ${formatServerSlugDisplay(slugForServer)}\``,
        unexpectedAuthHint: (httpStatus) =>
          httpStatus === 401
            ? " If your server may be on an older release that does not emit `code: auth_required`, re-run `raft-computer login` first to refresh your user session, then retry. If the issue persists, report it as server contract drift."
            : "",
      },
    },
    options,
  );
}

export async function adoptLegacyByFingerprint(
  input: AdoptLegacyByFingerprintInput,
  options: AdoptLegacyOptions = {},
): Promise<AdoptLegacyResult> {
  options.signal?.throwIfAborted?.();
  const slockHome = resolveRaftHome();
  const { accessToken, baseUrl } = await readUserSessionContext(slockHome, input.serverUrl);
  const slugForServer = normalizeServerSlug(input.serverSlug);
  if (!slugForServer) {
    throw new ComputerServiceError("ADOPT_NOT_AUTHORIZED", "Server slug must not be empty.");
  }

  options.signal?.throwIfAborted?.();
  emit(options, { type: "adopting", serverSlug: slugForServer, mode: "legacy_fingerprint_roster" });

  const adoptStartedAt = new Date();
  const ownerEvidence = await readLegacyOwnerEvidence(input.legacyOwnerPath);
  const { client, result } = await retryOnceOnAuthRequired(
    slockHome,
    input.serverUrl,
    new ComputerAttachClient(baseUrl, accessToken),
    (c) =>
      c.adoptLegacyByFingerprint({
        serverSlug: slugForServer,
        legacyMachineId: input.legacyMachineId,
        apiKeyFingerprint: input.apiKeyFingerprint,
        ...(input.name ? { name: input.name } : {}),
      }),
  );

  return completeAdoptionExchange(
    {
      slockHome,
      client,
      baseUrl,
      slugForServer,
      ownerEvidence,
      legacyOwnerFile: input.legacyOwnerPath,
      legacyApiKeyFingerprint: input.apiKeyFingerprint,
      result,
      startedAt: adoptStartedAt,
      log: { mode: "legacy_fingerprint_roster", legacyFingerprint: input.apiKeyFingerprint },
      copy: {
        invalidFailureReason: "legacy_fingerprint_invalid",
        invalidMessage: `Server rejected the selected legacy machine (unknown / wrong server / malformed fingerprint). Local legacy owner evidence for this candidate: ${formatLegacyOwnerEvidence(slockHome, ownerEvidence)}. Re-run setup and pick a currently listed legacy daemon, or choose fresh attach.`,
        migratedMessage: `This machine has already been adopted. Local legacy owner evidence for this candidate: ${formatLegacyOwnerEvidence(slockHome, ownerEvidence)}. Use \`raft-computer attach\` to add another Computer attachment, or choose fresh attach in setup.`,
        authRequiredMessage: `Your Computer user session was rejected by the server before legacy adoption. Local legacy owner evidence for this candidate: ${formatLegacyOwnerEvidence(slockHome, ownerEvidence)}. Re-run \`raft-computer login\` for this server, then retry setup. No local Computer state was written.`,
        failedMessage: (code) =>
          `Adoption failed at server exchange (${code}). Local legacy owner evidence for this candidate: ${formatLegacyOwnerEvidence(slockHome, ownerEvidence)}. Confirm the user session is valid and the server URL is correct. No local Computer state was written.`,
        stopFailureRetryCommand: `\`raft-computer setup ${formatServerSlugDisplay(slugForServer)}\``,
      },
    },
    options,
  );
}

export async function adoptLegacyByDaemonId(
  input: AdoptLegacyByDaemonIdInput,
  options: AdoptLegacyOptions = {},
): Promise<AdoptLegacyResult> {
  options.signal?.throwIfAborted?.();
  const slockHome = resolveRaftHome();
  const { accessToken, baseUrl } = await readUserSessionContext(slockHome, input.serverUrl);
  const slugForServer = normalizeServerSlug(input.serverSlug);
  if (!slugForServer) {
    throw new ComputerServiceError("ADOPT_NOT_AUTHORIZED", "Server slug must not be empty.");
  }

  options.signal?.throwIfAborted?.();
  emit(options, { type: "adopting", serverSlug: slugForServer, mode: "legacy_daemon_id_roster" });

  const adoptStartedAt = new Date();
  const legacyOwnerFile = join(slockHome, "machines", "server-selected-legacy-daemon", "daemon.lock", "owner.json");
  const ownerEvidence = await readLegacyOwnerEvidence(legacyOwnerFile);
  const { client, result } = await retryOnceOnAuthRequired(
    slockHome,
    input.serverUrl,
    new ComputerAttachClient(baseUrl, accessToken),
    (c) =>
      c.adoptLegacyByDaemonId({
        serverSlug: slugForServer,
        daemonId: input.legacyMachineId,
        ...(input.name ? { name: input.name } : {}),
      }),
  );

  return completeAdoptionExchange(
    {
      slockHome,
      client,
      baseUrl,
      slugForServer,
      ownerEvidence,
      legacyOwnerFile,
      result,
      startedAt: adoptStartedAt,
      log: { mode: "legacy_daemon_id_roster", legacyMachineId: input.legacyMachineId },
      copy: {
        invalidFailureReason: "legacy_daemon_id_invalid",
        invalidMessage: "Server rejected the selected legacy machine row. Re-run setup and pick a currently listed legacy daemon, or choose fresh attach.",
        migratedMessage: "This machine has already been adopted. Use `raft-computer attach` to add another Computer attachment, or choose fresh attach in setup.",
        authRequiredMessage: "Your Computer user session was rejected by the server before legacy adoption. Re-run `raft-computer login` for this server, then retry setup. No local Computer state was written.",
        failedMessage: (code) =>
          `Adoption failed at server exchange (${code}). Confirm the user session is valid and the server URL is correct. No local Computer state was written.`,
        stopFailureRetryCommand: `\`raft-computer setup ${formatServerSlugDisplay(slugForServer)}\``,
      },
    },
    options,
  );
}

// --- adoption.log writer (§5.11.4) ---

export interface AdoptionLogLine {
  mode: CredentialBridgeMode;
  redactedPrefix?: string;
  legacyFingerprint?: string;
  legacyMachineId?: string;
  startedAt: Date;
  outcome: "succeeded" | "failed";
  failureReason?: string;
  computerId?: string;
  machineId?: string;
  serverId?: string;
  legacyStop?: LegacyStopResult;
}

/**
 * Append one forensic line per §5.11.4. Closed enum field order:
 *   ts outcome bridge_mode redacted_prefix [failure_reason] [computer_id]
 *   [machine_id] [server_id]
 *
 * Format choice: one line, space-separated `key=value`. Best-effort —
 * a log write failure must never block the adoption flow result.
 */
export async function appendAdoptionLog(
  slockHome: string,
  line: AdoptionLogLine,
): Promise<void> {
  try {
    await mkdir(computerDir(slockHome), { recursive: true });
    const fields: string[] = [
      `ts=${new Date().toISOString()}`,
      `started_at=${line.startedAt.toISOString()}`,
      `outcome=${line.outcome}`,
      `credential_bridge_mode=${line.mode}`,
    ];
    if (line.redactedPrefix) fields.push(`legacy_key_prefix=${line.redactedPrefix}`);
    if (line.legacyFingerprint) fields.push(`legacy_fingerprint=${line.legacyFingerprint}`);
    if (line.legacyMachineId) fields.push(`legacy_machine_selector=${line.legacyMachineId}`);
    if (line.failureReason) fields.push(`failure_reason=${line.failureReason}`);
    if (line.computerId) fields.push(`computer_id=${line.computerId}`);
    if (line.machineId) fields.push(`legacy_machine_id=${line.machineId}`);
    if (line.serverId) fields.push(`server_id=${line.serverId}`);
    if (line.legacyStop) {
      fields.push(`legacy_stop_outcome=${line.legacyStop.outcome}`);
      if (typeof line.legacyStop.pid === "number") {
        fields.push(`legacy_stop_pid=${line.legacyStop.pid}`);
      }
      if (line.legacyStop.reason) {
        fields.push(`legacy_stop_reason=${line.legacyStop.reason}`);
      }
    }
    const path = adoptionLogPath(slockHome);
    await appendFile(path, fields.join(" ") + "\n", { mode: 0o600 });
    try {
      const st = await stat(path);
      if ((st.mode & 0o077) !== 0) await chmod(path, 0o600);
    } catch {
      // ignore
    }
  } catch {
    // adoption.log is forensic — never block the user's adoption outcome
    // on a log-write failure.
  }
}
