// Pure decisions about the machine Raft Desktop runs on (useLocalComputerHost):
// which of the server's machines it is, what its local service is doing, who
// runs it, and how a failed operation reads. Extracted so it can be
// unit-tested / ablated. Each function takes an optional `ablate` flag that
// DISABLES a specific hardening fix — used by the ablation study to prove the
// fix reproduces a real defect when off. Defaults = all fixes ON.

export interface MachineLike {
  id: string;
  hostname: string | null;
  computerVersion?: string | null;
  /** The server says the current user attached this Computer. */
  computerAttachedByCurrentUser?: boolean;
}

/** What this machine knows about itself, to find it among the server's machines. */
export interface LocalMachineIdentity {
  /** The ids its attachments name (the attachment's machineId): authoritative. */
  machineIds: readonly string[];
  /** The OS hostname: a fallback for an attachment that names no id. */
  hostname: string | null;
}

export interface UpgradeRecord {
  phase: string;
  percent: number | null;
  outcome: unknown | null;
  targetVersion: string;
  updatedAt?: string;
}

export interface ServiceState {
  running: boolean;
  version?: { version?: string | null } | null;
}


// An in-flight upgrade record is only "live" for a bounded window; a service
// that died mid-upgrade leaves outcome:null forever, so without the bound the
// card would show "Updating…" (hiding all controls) indefinitely.
const UPGRADE_STALE_MS = 10 * 60 * 1000;
function isUpgradeLive(
  u: UpgradeRecord,
  now: number = Date.now(),
  ablate?: { staleBound?: boolean },
): boolean {
  if (u.outcome) return false;
  if (ablate?.staleBound === false) return true; // #3 OFF: no staleness bound
  if (!u.updatedAt) return true;
  const t = Date.parse(u.updatedAt);
  return Number.isNaN(t) || now - t < UPGRADE_STALE_MS;
}

/**
 * Which machineStore row is THIS machine (fix #2). The attachment's machineId
 * is authoritative: neither the bridge's status nor the server's machine rows
 * carry any other stable machine identity (no key fingerprint), so it is the
 * only id there is.
 *
 * The hostname is a fallback for a legacy attachment that names no machineId,
 * so it is used only while no attachment names one at all, and only for a row
 * the current user attached, and only when exactly one such row has it. A
 * hostname is not an identity (every new Mac is "Name-MacBook-Pro.local"), so
 * another member's same-named machine must never become "This device" and get
 * this machine's local Stop / Restart.
 *
 * Raft Desktop runs on the person's own computer. A row the attachment names
 * but the server says another account attached (the local Computer is linked
 * under a different Raft account) is not This device for this account: it
 * is not connected to this server for them, and Add connects it.
 *
 * Ablation (each flag false = that guard off, the defect back):
 *   uniqueHostname — first match among same-named rows
 *   hostnameOnlyWithoutIds — the hostname is tried even when ids are known
 *   attachedByCurrentUser — another member's machine may match by hostname
 */
export function correlateSelfMachine<T extends MachineLike>(
  machines: readonly T[],
  identity: LocalMachineIdentity,
  ablate?: { uniqueHostname?: boolean; hostnameOnlyWithoutIds?: boolean; attachedByCurrentUser?: boolean },
): T | null {
  const { machineIds, hostname } = identity;
  for (const id of machineIds) {
    const match = machines.find((m) => m.id === id && m.computerAttachedByCurrentUser !== false);
    if (match) return match;
  }
  if (!hostname) return null;
  if (machineIds.length > 0 && ablate?.hostnameOnlyWithoutIds !== false) return null;
  const matches = machines.filter((m) =>
    m.hostname != null && m.hostname === hostname &&
    (ablate?.attachedByCurrentUser === false || m.computerAttachedByCurrentUser === true));
  if (ablate?.uniqueHostname === false) return matches[0] ?? null;
  return matches.length === 1 ? matches[0] : null;
}

/**
 * This machine's attachment to `serverSlug` names a row another Raft account
 * attached: for this account it is not connected there (correlateSelfMachine).
 */
export function attachedHereByOtherAccount(
  servers: readonly { serverSlug: string | null; machineId?: string | null }[] | undefined,
  serverSlug: string | null,
  machines: readonly Pick<MachineLike, "id" | "computerAttachedByCurrentUser">[],
): boolean {
  if (!serverSlug) return false;
  const row = (servers ?? []).find((entry) => entry.serverSlug === serverSlug);
  if (!row?.machineId) return false;
  return machines.some((m) => m.id === row.machineId && m.computerAttachedByCurrentUser === false);
}

export interface ControlsInput {
  service?: ServiceState;
  upgrade?: UpgradeRecord | null;
}

export interface AblationFlags {
  staleBound?: boolean; // #3
}

export interface Controls {
  running: boolean;
  upgrading: UpgradeRecord | null;
}

export function deriveControls(input: ControlsInput, now: number = Date.now(), ablate?: AblationFlags): Controls {
  const { service, upgrade } = input;
  const upgrading = upgrade && isUpgradeLive(upgrade, now, { staleBound: ablate?.staleBound }) ? upgrade : null;
  const running = service?.running ?? true;
  return { running, upgrading };
}

/**
 * Computer 1.0.46 refuses to start a second service holding this machine's key
 * (code DUPLICATE_KEY_HOLDER, slock #9358). Its message names the fix — the
 * exact `RAFT_HOME=<root> raft-computer stop` — which a generic "try again"
 * would hide (retrying can never succeed). IPC wraps the error as "Error
 * invoking remote method …: Error: …".
 *
 * Returns null when `raw` is not this refusal; otherwise `{ command }` with the
 * exact command, or `command: null` when the message no longer carries one. No
 * bare `raft-computer stop` fallback: without RAFT_HOME it stops the service in
 * the DEFAULT home — Desktop's own ~/.slock one, which is not the holder — so
 * the user would follow it and still fail (Josh, #114 review).
 */
export function duplicateKeyRefusal(raw: string): { command: string | null } | null {
  if (!/DUPLICATE_KEY_HOLDER|already holds this machine key/i.test(raw)) return null;
  return { command: raw.match(/RAFT_HOME=\S+ raft-computer stop/)?.[0] ?? null };
}

/** Why a local Computer operation failed, for the web's copy (localComputerCopy.ts). */
export type HostErrorCode =
  | "not_signed_in"
  | "duplicate_key"
  | "admin_required"
  | "up_to_date"
  | "service_unreachable"
  | "host_unavailable"
  | "network"
  // Raft Desktop installs the official Raft Computer (its installer's exits).
  | "install_failed"
  /** Another manager owns the install: the installer says why (`detail`). */
  | "install_held"
  | "install_download_failed"
  | "install_unsupported"
  /** This Raft Computer is too old to be added from Raft Desktop. */
  | "too_old"
  /** Updated, and still older than this Raft Desktop needs: nothing newer is published yet. */
  | "update_unavailable"
  /** An installer run passed Raft Desktop's deadline; its worker is still finishing. */
  | "install_still_finishing"
  /** Installed, but it did not answer (`--version` / `status --json`): unknown, try again. */
  | "unreadable"
  /** Another change to Raft Computer is running (one at a time). */
  | "busy"
  /** The installed Computer does not offer this yet: update it. */
  | "capability_missing"
  /** The move from an older Desktop's embedded Computer failed. */
  | "migration_failed"
  /** A `raft-computer` command failed with its own code (`detail`: the code). */
  | "cli_failed"
  /** The server does not hand out one-time attach grants. */
  | "server_unsupported"
  | "unknown";

export interface ClassifiedHostError {
  code: HostErrorCode;
  /** duplicate_key: the exact command the refusal names (never shown: buttons only). */
  command: string | null;
  /** install_held: the installer's reason; cli_failed: the CLI's code. */
  detail?: string | null;
}

/**
 * A bridge rejection (incl. Electron's "Error invoking remote method …" IPC
 * wrapping) as the code the copy words. The desktop rejects with a stable
 * prefix: `computer_install_*: <detail>`, `computer_too_old: …`,
 * `computer_cli:<CODE>:<command>: <detail>`, `computer_migration_*: …`.
 */
export function classifyHostError(raw: string): ClassifiedHostError {
  if (raw === "not_signed_in") return { code: "not_signed_in", command: null };
  const duplicate = duplicateKeyRefusal(raw);
  if (duplicate) return { code: "duplicate_key", command: duplicate.command };
  const held = /computer_install_held:\s*([\s\S]*)$/u.exec(raw);
  if (held) return { code: "install_held", command: null, detail: held[1]!.trim() || null };
  if (/computer_install_still_finishing/u.test(raw)) return { code: "install_still_finishing", command: null };
  if (/computer_unreadable/u.test(raw)) return { code: "unreadable", command: null };
  if (/computer_busy/u.test(raw)) return { code: "busy", command: null };
  if (/computer_capability_missing/u.test(raw)) return { code: "capability_missing", command: null };
  if (/computer_install_download_failed/u.test(raw)) return { code: "install_download_failed", command: null };
  if (/computer_install_unsupported/u.test(raw)) return { code: "install_unsupported", command: null };
  if (/computer_install_failed/u.test(raw)) return { code: "install_failed", command: null };
  if (/computer_update_unavailable/u.test(raw)) return { code: "update_unavailable", command: null };
  if (/computer_too_old/u.test(raw)) return { code: "too_old", command: null };
  if (/computer_migration_/u.test(raw)) return { code: "migration_failed", command: null };
  if (/attach_grant_failed:server_unsupported/u.test(raw)) return { code: "server_unsupported", command: null };
  const cli = /computer_cli:([A-Z0-9_]+):/u.exec(raw);
  if (cli) return { code: "cli_failed", command: null, detail: cli[1]! };
  if (/requires_admin|not_authorized|admin|authoriz/i.test(raw)) return { code: "admin_required", command: null };
  if (/no_update_available/i.test(raw)) return { code: "up_to_date", command: null };
  if (/service_not_running|service_unreachable/i.test(raw)) return { code: "service_unreachable", command: null };
  if (/No handler registered|host unavailable|not.?armed/i.test(raw)) return { code: "host_unavailable", command: null };
  if (/network|fetch|timeout|ECONN/i.test(raw)) return { code: "network", command: null };
  return { code: "unknown", command: null };
}
