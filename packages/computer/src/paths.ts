// Computer state paths (RFC v9.8 §8.1).
//
// Identity: **a Computer IS one Computer home on one real machine** (liuliu
// §1, tygg). It manages ALL Raft connections under that home: one
// shared user identity + N independent per-server attachments, each with
// its own runner, all owned by one service.
//
//   ~/.slock/computer/
//     user-session.json              # SHARED — one user identity per Computer
//     run/                           # service-level runtime state (RFC v9.8 §8.1)
//       service.sock                 # §4 IPC socket (POSIX)
//       service.pid                  # the single per-Computer service pidfile
//       service.state.json           # ServiceState
//       service.log                  # service stdout/stderr capture
//     servers/<serverId>/
//       runner.state.json            # sk_computer_* + serverMachineId (per server)
//       runner.pid                   # this server's runner child
//       runner.log
//
// Per-server isolation is a HARD contract invariant (§5, my axis):
// reading/writing one serverId's subdir must never touch another's.
//
// Service-level isolation under `run/` (RFC v9.8 §8.1): the install-root
// holds long-lived install state (`user-session.json`, `channel`, the
// upgrade snapshot/log files, etc.); `run/` holds files whose lifetime
// matches the running service — pidfile, IPC socket, structured state.
// Anything that should be wiped by the internal `reset-service` IPC
// mutation belongs under `run/`, not at the install root.
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

/**
 * Current on-disk JSON-state schema version (pre-release hardening).
 *
 * Every typed on-disk JSON state file (runner.state.json, service.state.json,
 * health.json, user-session.json, K operation.json, …) stamps
 * `schemaVersion: CURRENT_SCHEMA_VERSION` on WRITE. READERS MUST tolerate a
 * MISSING `schemaVersion` — files written by already-deployed dev/test
 * Computers have none, and must be treated as version 1 (current), never
 * rejected. When this constant is bumped (>1), each reader gets a
 * migrate-on-read hook: `if ((parsed.schemaVersion ?? 1) < CURRENT_SCHEMA_VERSION) migrate(...)`.
 */
export const CURRENT_SCHEMA_VERSION = 1;

export function resolveRaftHome(
  env: { SLOCK_HOME?: string; RAFT_HOME?: string } = process.env,
  homeDir = os.homedir(),
): string {
  const configured = env.RAFT_HOME?.trim() || env.SLOCK_HOME?.trim();
  const raw = configured && configured.length > 0 ? configured : path.join(homeDir, ".slock");
  return path.resolve(expandHome(raw, homeDir));
}

export function formatRaftHomeForDisplay(raftHome: string, homeDir = os.homedir()): string {
  const resolved = path.resolve(raftHome);
  const resolvedHome = path.resolve(homeDir);
  if (resolved === resolvedHome) return "~";
  const prefix = `${resolvedHome}${path.sep}`;
  return resolved.startsWith(prefix) ? `~/${resolved.slice(prefix.length)}` : resolved;
}

function expandHome(input: string, homeDir: string): string {
  if (input === "~") return homeDir;
  if (input.startsWith("~/")) return path.join(homeDir, input.slice(2));
  return input;
}

export function computerDir(slockHome: string): string {
  return path.join(slockHome, "computer");
}

export function upgradeLogPath(slockHome: string): string {
  return path.join(computerDir(slockHome), "upgrade.log");
}

// login output — user identity/session ONLY (no sk_computer_*). SHARED
// across every per-server attachment under this Computer (§1: one user
// identity per SLOCK_HOME).
export function userSessionPath(slockHome: string): string {
  return path.join(computerDir(slockHome), "user-session.json");
}

// --- per-server attachment state (contract v4 §10) ---

/**
 * serverId is user-supplied (`attach <serverId>`) and is used as a
 * directory name — it MUST be validated to a strict shape so it can
 * never escape `servers/` via traversal / separators / `.`. Raft
 * server ids are UUIDs; accept exactly that.
 */
const SERVER_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isValidServerId(serverId: string): boolean {
  return SERVER_ID_RE.test(serverId);
}

export function assertValidServerId(serverId: string): string {
  if (!isValidServerId(serverId)) {
    throw new Error(`invalid server id: ${JSON.stringify(serverId)} (expected a UUID)`);
  }
  return serverId;
}

export function serversDir(slockHome: string): string {
  return path.join(computerDir(slockHome), "servers");
}

export function serverDir(slockHome: string, serverId: string): string {
  return path.join(serversDir(slockHome), assertValidServerId(serverId));
}

export function serverAttachmentPath(slockHome: string, serverId: string): string {
  return path.join(serverDir(slockHome, serverId), "runner.state.json");
}

// Install-root scoped migration dismissal state. This deliberately lives
// outside `servers/<serverId>/`: setup needs to consult it before a current
// attachment exists, so there may be no serverId to resolve yet.
export function migrationDismissalsPath(slockHome: string): string {
  return path.join(computerDir(slockHome), "migration-dismissals.json");
}

// Legacy per-server attachment location (pre-runner.state.json). Restored in
// the hotfix for tygg's prod 401: deployed computers attached with an older
// version can still carry their working credential here, so the reader falls
// back to it. (Removed in #3074/③a on a wrong "no deployed legacy installs"
// assumption.)
export function legacyServerAttachmentPath(slockHome: string, serverId: string): string {
  return path.join(serverDir(slockHome, serverId), "attachment.json");
}

// Per-server runner pidfile + log. Current writers use `runner.pid` /
// `runner.log` (unified naming — previously `server-runner.{pid,log}`).
//
// Readers must still tolerate the legacy names. A user can upgrade the
// CLI/app while an older service keeps running and actively writing
// `server-runner.*`; treating those files as orphaned hides the only useful
// incident evidence and points operators at paths that do not exist.
export function serverRunnerPidPath(slockHome: string, serverId: string): string {
  return path.join(serverDir(slockHome, serverId), "runner.pid");
}

export function serverRunnerLogPath(slockHome: string, serverId: string): string {
  return path.join(serverDir(slockHome, serverId), "runner.log");
}

export function serverRunnerVersionPath(slockHome: string, serverId: string): string {
  return path.join(serverDir(slockHome, serverId), "runner-version.json");
}

export function legacyServerRunnerPidPath(slockHome: string, serverId: string): string {
  return path.join(serverDir(slockHome, serverId), "server-runner.pid");
}

export function legacyServerRunnerLogPath(slockHome: string, serverId: string): string {
  return path.join(serverDir(slockHome, serverId), "server-runner.log");
}

export function serverRunnerPidReadFallback(slockHome: string, serverId: string): string[] {
  return [
    serverRunnerPidPath(slockHome, serverId),
    legacyServerRunnerPidPath(slockHome, serverId),
  ];
}

export function serverRunnerLogReadFallback(slockHome: string, serverId: string): string[] {
  return [
    serverRunnerLogPath(slockHome, serverId),
    legacyServerRunnerLogPath(slockHome, serverId),
  ];
}

// Per-server "managed" marker — presence indicates "service should
// keep this server's runner running". Distinct from runner.state.json:
// attach establishes the credential; `start [serverId]` writes the
// managed flag for the targeted server(s); `stop [serverId]` removes it.
//
// Contract v4 §6 line 80: `start [serverId]` without a serverId manages
// all attached; with a serverId, manages only that one. This file is how
// the service's reconcile loop knows the difference.
export function serverManagedFlagPath(slockHome: string, serverId: string): string {
  return path.join(serverDir(slockHome, serverId), "managed.flag");
}

// Per-server crash history file — JSON array of recent crash entries
// with timestamp + exitCode + signal. The service appends on each
// runner child exit; `status` derives `health` enum from recent crash
// count; repeated-crash threshold (>=3 in 60s) marks the server as
// `degraded`, stopping service auto-restart per v6 §3.3.
//
// Cleared by explicit `raft-computer start` / `restart` after the
// operator has inspected recent crash reasons + fixed the underlying issue.
export function serverHealthPath(slockHome: string, serverId: string): string {
  return path.join(serverDir(slockHome, serverId), "health.json");
}

export function serverConnectedMarkerPath(slockHome: string, serverId: string): string {
  return path.join(serverDir(slockHome, serverId), "runner.connected");
}

export function serverLifecycleOperationsPath(slockHome: string, serverId: string): string {
  return path.join(serverDir(slockHome, serverId), "lifecycle-operations.json");
}

// --- the single per-Computer service (RFC v9.8 §1 / §6 / §8.1) ---

// Service-level runtime directory under the install root (RFC v9.8 §8.1).
// Holds files whose lifetime matches the running service: pidfile, IPC
// socket, structured `ServiceState`, and the service log. Distinct from
// the install root, which keeps long-lived install state (user session,
// channel marker, upgrade artifacts).
//
// PR-impl-5b moved `service.{pid,log,state.json}` from
// `<installRoot>/<file>` into `<installRoot>/run/<file>` so the §8.1
// layout matches code. (The pre-release migration fallback for the old
// locations has been removed — Computer is unreleased.)
export function serviceRunDir(slockHome: string): string {
  return path.join(computerDir(slockHome), "run");
}

// Service-level state file — RFC v9.8 §1.3.
//
//   { "state": "running" | "degraded" | ..., "crashHistory": CrashEntry[] }
//
// The service-level crashHistory is the cascade record (≥2 runners
// degraded → service flips degraded, §2.4); the per-runner health.json
// is the runner-level crash log. Cleared by the internal `reset-service`
// IPC mutation, which clears crashHistory and transitions state back to
// `running` without killing any runners (§1.3 invariant).
export function serviceStatePath(slockHome: string): string {
  return path.join(serviceRunDir(slockHome), "service.state.json");
}

export function servicePidPath(slockHome: string): string {
  return path.join(serviceRunDir(slockHome), "service.pid");
}

/**
 * Pidfile path(s) a reader walks when locating a running service.
 *
 * Historically this was a multi-layout fallback chain (current
 * `run/service.pid` → legacy `service.pid` → legacy `supervisor.pid`) for
 * the on-disk-layout migration window. Those legacy layouts only ever
 * existed on pre-release dev machines (Computer is unreleased), so the
 * fallback is removed: the canonical `run/service.pid` is the only path.
 * The reader (`internal/service-pid-fallback.ts`) still does the
 * liveness-check + stale-clear over this single candidate.
 */
export function servicePidReadFallback(slockHome: string): string[] {
  return [servicePidPath(slockHome)];
}

export function serviceLogPath(slockHome: string): string {
  return path.join(serviceRunDir(slockHome), "service.log");
}

// --- §4 IPC socket (Computer service ↔ library client) ---

/**
 * Unix-domain socket path for the §4 IPC endpoint.
 *
 * Per RFC v9.8 §4.1:
 *   - POSIX: `<installRoot>/run/service.sock`
 *   - Permissions: `0600`, owned by the user who installed Computer
 *
 * Windows uses named pipes (`\\.\pipe\raft-computer-<installRootHash>`)
 * via a separate `serviceWindowsPipeName` helper because the path shape
 * does not live on the filesystem.
 *
 * Callers MUST go through this helper rather than re-joining `service.sock`
 * inline so the path can move (e.g. under a `run/` subdirectory addition)
 * in a single edit.
 */
export function serviceSocketPath(slockHome: string): string {
  return path.join(computerDir(slockHome), "run", "service.sock");
}

/**
 * Windows named-pipe identity for the §4 IPC endpoint. The pipe name is
 * derived from a stable hash of the install root so multi-install (rare,
 * mostly a dev / testing case) does not collide. ACL on the pipe MUST
 * restrict access to the installing user SID at creation time.
 */
export function serviceWindowsPipeName(slockHome: string): string {
  const hash = createHash("sha256").update(computerDir(slockHome)).digest("hex").slice(0, 16);
  return `\\\\.\\pipe\\raft-computer-${hash}`;
}

/**
 * Active-service version evidence — `service-version.json`.
 *
 * The running service writes this on startup with:
 *   { version, installRoot, pid, writtenAt }
 *
 * Purpose (Dayu msg=73312d23): proves which install-root the CURRENTLY
 * RUNNING service was started from, independent of the file tree at
 * `<install>/dist`. The file tree can be swapped mid-upgrade and look
 * "new" while the running pid is still the old binary; this evidence
 * file is written ONCE on service startup, so the values reflect the
 * actual running process. Used by PR-E QA harness to assert
 * active-version post-upgrade / post-rollback, and useful operationally
 * (operator can `cat` it to see what binary the service pid actually
 * came from).
 */
export function serviceVersionPath(slockHome: string): string {
  return path.join(computerDir(slockHome), "service-version.json");
}

const HOSTNAME_SUFFIXES = [
  ".fritz.box",
  ".localdomain",
  ".local",
  ".lan",
  ".home",
] as const;

function shortHostnameHash(hostname: string): string {
  return createHash("sha256").update(hostname).digest("hex").slice(0, 8);
}

/**
 * Derive the default user-visible Computer display name from the host.
 * Server-side `computers.name` remains canonical; this helper is the
 * single client-side default used by attach/setup prompts.
 */
export function deriveDefaultComputerName(hostname: string = os.hostname()): string {
  const original = hostname.trim();
  let name = original;
  let lower = name.toLowerCase();

  for (;;) {
    const suffix = HOSTNAME_SUFFIXES.find((candidate) => lower.endsWith(candidate));
    if (!suffix) break;
    name = name.slice(0, -suffix.length);
    lower = name.toLowerCase();
  }

  name = name
    .replace(/[\s'"]+/g, "-")
    .replace(/-+$/g, "");

  return name.length > 0 ? name : `raft-computer-${shortHostnameHash(original)}`;
}

// --- legacy daemon adoption forensic log (RFC v8.2 §5.11.4 / task #39 PR-J1) ---

// `~/.slock/computer/adoption.log` — append-only forensic log of every
// legacy daemon adoption attempt on this Computer. Each line records the
// credential bridge mode (which secret channel the user chose) plus the
// PID transition + new sk_computer mint timestamp, so a later operator
// can reconstruct what happened during a one-way migration.
//
// Raw legacy keys MUST NEVER appear here — at most a redacted prefix
// (first 8 chars) or HMAC surrogate `mch_<hex>`.
export function adoptionLogPath(slockHome: string): string {
  return path.join(computerDir(slockHome), "adoption.log");
}

// --- release channel state (contract v6 §6 / §10 / §11 / PR-E §2.1) ---

// `~/.slock/computer/channel` — release channel marker. One-line text
// file. Default `latest` if absent. Contract-mutable ONLY via
// `raft-computer channel set <name>` (manual edit is undefined behavior).
//
// v6 §11 enum: `latest | alpha | pinned:<semver>`. Other values rejected
// with stable code `CHANNEL_INVALID`.
export function channelPath(slockHome: string): string {
  return path.join(computerDir(slockHome), "channel");
}

// --- v8.3 upgrade lifecycle paths (RFC v0.8 §4.4 contract) ---
//
// Adopted as canonical paths.ts accessors per v8.3 §4.4 (10): all
// upgrade-related paths must derive from paths.ts::* helpers, not
// string literals scattered through upgrade.ts. Existing upgrade.ts
// (PR-E narrow-v1 era) currently constructs these paths inline;
// follow-up PR will refactor to consume these helpers.

// Canonical timestamp formatter used by migration evidence. Format:
// `YYYYMMDDTHHmmssZ` (ISO
// 8601 basic UTC, no separators).
//
// Why this format:
//   - Windows-path-safe: no `:`, no ` `, no `/`. Can appear in any
//     filename on any filesystem.
//   - Lexicographic sort = chronological sort.
//   - Fixed length (16 chars including Z) — easy to grep / parse.
//   - UTC (Z suffix) — no timezone ambiguity across operator hosts.
//
// Centralized so callers don't reinvent
// `new Date().toISOString().replace(...)` patterns that drift between callsites.
export function formatUpgradeLogTimestamp(date: Date = new Date()): string {
  const iso = date.toISOString(); // "2026-05-24T17:30:00.123Z"
  // Strip separators + drop millis: "20260524T173000Z"
  return iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
