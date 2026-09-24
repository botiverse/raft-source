// RFC v9.8 §3 library API surface — typed IPC/RPC pins (byte-pin v2 seed)
// plus state-reader result types (C3 follow-up — `service-status` /
// `runner-status` / `list-runners` concrete result shapes).
//
// The shapes in this file are the PUBLIC LIBRARY CONTRACT exported via
// `@botiverse/raft-computer/lib`. The IPC transport that satisfies them lives in
// PR-impl-2 §4 (liuliu-owned); this commit lands only the type surface so
// G-stage (`apps/raft-computer-app`) and other library consumers can
// type-check against the locked shape before the implementation ships.
//
// Naming convention (§5.5):
//   - Wire literals (RequestMethodMap keys, ServiceEvent.topic, IPC frame
//     `type` / `topic` strings) are kebab-case.
//   - TypeScript identifiers (interface members, function names) are
//     camelCase.
//
// Closed-set discipline (§7):
//   - `ServiceClientError.code` MUST be a member of the §7 closed-set
//     `ErrorCode` union. This commit pins the IPC family seed inline;
//     the full §7.3 enumeration lands in a follow-up reconcile PR.

/**
 * IPC error code family — the seed that `ServiceClient.request` and
 * `ServiceClient.events` propagate. Forward-only post v9-sign: additions
 * are additive minor library bumps; renames / removals are major.
 *
 * Full §7.3 enumeration (SETUP/ATTACH/MIGRATE/UPGRADE/SERVICE families)
 * lands in a follow-up reconcile commit that also unifies the codes
 * currently emitted via `ComputerServiceError` across services/*.
 */
export const IPC_ERROR_CODES = [
  "IPC_FRAME_TOO_LARGE",
  "IPC_PROTOCOL_VERSION_UNSUPPORTED",
  "IPC_PROTOCOL_HANDSHAKE_FAILED",
  "IPC_HEARTBEAT_TIMEOUT",
  "IPC_MALFORMED_FRAME",
  "IPC_REQUEST_TIMEOUT",
  "IPC_REQUEST_CANCELED",
  "IPC_CLIENT_CLOSED",
  "SELF_RELAUNCH_UNAVAILABLE",
  "CONTROL_BUSY",
  // task #779: a typed `upgrade-start` refusal (K receipt blocked, coordinator
  // rejected/missing/timed out, non-SEA service). Previously mis-reported as
  // `IPC_MALFORMED_FRAME`, which is a wire-format code and steered users to
  // `raft-computer doctor` for a condition doctor cannot fix.
  "UPGRADE_START_REJECTED",
] as const;

export type IpcErrorCode = (typeof IPC_ERROR_CODES)[number];

/**
 * Runtime narrow guard — exposed so consumers can pattern-match without
 * pulling in a generic `as` cast. The CI gate (§7.4) over a final
 * `ERROR_CODES` union will subsume this once the reconcile lands.
 */
export function isIpcErrorCode(value: unknown): value is IpcErrorCode {
  return (
    typeof value === "string" && (IPC_ERROR_CODES as readonly string[]).includes(value)
  );
}

/**
 * Caller-facing options for `ServiceClient.request`. Pairs active cancel
 * (`signal` — primary G-stage unmount path) with passive deadline
 * (`timeoutMs` — library-side safety net). On either path the client
 * emits an IPC `cancel` frame for the in-flight request id and rejects
 * the returned promise with `IPC_REQUEST_CANCELED` or
 * `IPC_REQUEST_TIMEOUT` respectively (§4.4).
 */
export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Typed RPC table — keys are kebab-case wire literals (§5.5), values are
 * per-method `{ params, result }` pairs. The v9 sign-lock seed listed
 * here started as the §3.2 method floor; new methods are additive minor bumps
 * (extending this map).
 *
 * State-reader results (`service-status` / `runner-status` /
 * `list-runners`) are pinned to the lib reader return types — the
 * D-stage §4 IPC handlers in PR-impl-2 satisfy the wire surface by
 * delegating to those readers (mechanical `satisfies`).
 *
 * Mutation results pin alongside the PR-impl-3 §X migration / verb pipeline
 * that owns the corresponding handlers.
 */
export interface RequestMethodMap {
  "service-status": { params: void; result: ServiceStatusResult };
  "machine-attestation": { params: void; result: MachineServiceAttestation };
  "runner-status": { params: { serverId: string }; result: RunnerStatusResult };
  "list-runners": { params: void; result: ListRunnersResult };
  "restart-service": { params: RestartServiceParams | void; result: RestartServiceResult };
  "upgrade-start": { params: UpgradeStartParams; result: UpgradeStartResult };
  "reset-service": { params: void; result: ResetServiceResult };
  "reset-runner": { params: { serverId: string }; result: ResetRunnerResult };
}

export interface MachineServiceAttestation {
  computerVersion: string;
  serviceGeneration: string;
  servicePid: number;
  /** Exact live SEA path reported by this process, not release metadata. */
  serviceExecutablePath?: string;
  sourceServicePid?: number;
  managedServerIds: string[];
  /** Stable server-issued Computer identity for each managed server. */
  managedMachineIdentities?: Record<string, string>;
  managedSetRevision: string;
}

/**
 * Server-pushed event over `ServiceClient.events`. The discriminant field
 * is `kind` (§5.5 — established at v9.7 sign); values are past-participle
 * kebab-case literals. The 6-kind enumeration is the v9.8 §4.4 floor.
 *
 * Payload shapes finalize alongside §4 IPC impl (PR-impl-2, liuliu-owned);
 * the discriminator is locked here so consumers can write exhaustive
 * switches today.
 *
 * Note: v9.8 §4.4 has an example block still showing the v9.7-pre field
 * name `topic` + present-tense values; §5.5 is the byte-pin source of
 * truth (`kind` + past-participle). The §4.4 example will be reconciled
 * in a follow-up doc-clean pass.
 */
export type ServiceEvent =
  | { kind: "service-state-changed"; payload: unknown }
  | { kind: "runner-state-changed"; payload: unknown }
  | { kind: "runner-attached"; payload: unknown }
  | { kind: "runner-detached"; payload: unknown }
  | { kind: "upgrade-log-appended"; payload: unknown }
  | { kind: "upgrade-progressed"; payload: UpgradeProgressEvent }
  | { kind: "upgrade-completed"; payload: UpgradeCompletedEvent }
  | { kind: "heartbeat"; payload: unknown };

/**
 * Library-side error envelope thrown by `ServiceClient`. `code` is a
 * member of the §7 closed-set; `cause` is retained in-process only and
 * MUST NOT cross IPC / CLI fail boundaries (§7.4 redaction).
 */
export class ServiceClientError extends Error {
  readonly code: IpcErrorCode;
  override readonly cause?: unknown;
  constructor(code: IpcErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "ServiceClientError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Typed IPC client. The implementation in PR-impl-2 §4 satisfies this
 * interface; this commit only locks the surface.
 *
 * Termination semantics (§4.7):
 *   - `events` completes naturally (`Symbol.asyncIterator` return) on any
 *     socket-close path (graceful local/remote, transient, TCP RST). The
 *     `for-await` loop exits without throwing — idiomatic reconnect is a
 *     plain outer `while (!stopped) { … }` wrap, no try/catch.
 *   - `events` THROWS `ServiceClientError` only on protocol-level
 *     failures: handshake mismatch, frame parse, frame > 1 MiB.
 * The disjoint split lets consumers distinguish "retry" (iterator end)
 * from "give up" (throw) without runtime classification.
 */
export interface ServiceClient {
  events: AsyncIterable<ServiceEvent>;
  request<M extends keyof RequestMethodMap>(
    method: M,
    params: RequestMethodMap[M]["params"],
    options?: RequestOptions,
  ): Promise<RequestMethodMap[M]["result"]>;
  close(): Promise<void>;
}

/**
 * Connection options. `protocolVersion` lets a consumer opt-in to a
 * specific handshake version; the service negotiates highest mutually
 * supported (§4.3) and may reject with `IPC_PROTOCOL_VERSION_UNSUPPORTED`.
 */
export interface ConnectServiceOptions {
  protocolVersion?: number;
  /** Overall socket-connect + hello-handshake deadline. */
  timeoutMs?: number;
}

/**
 * Open a typed IPC connection to the Computer service. Throws
 * `ServiceClientError` on handshake failure. Concrete implementation
 * lands in PR-impl-2 §4 (liuliu-owned); the type is locked here so
 * `apps/raft-computer-app` and other library consumers can type-check
 * call sites before the transport ships.
 */
export type ConnectService = (
  installRoot: string,
  options?: ConnectServiceOptions,
) => Promise<ServiceClient>;

// --- State-reader result surface (§3.2 readers) ---
//
// These are the result types of `readServiceStatus(installRoot)` /
// `readRunnerStatus(installRoot, serverId)` / `listRunners(installRoot,
// opts?)` exported via `@botiverse/raft-computer/lib`. They also pin the
// `RequestMethodMap.result` for the three IPC reader methods above.
//
// Re-exported verbatim from the internal modules that compute them so
// downstream consumers depend on `@botiverse/raft-computer/lib` only.
export type {
  ComputerStatusReport,
  DaemonState,
  ServerHealth,
  ServerStatusRow,
} from "../status.js";
export type { RunnerListItem as RunnerInfo } from "../apiClient.js";

import type { ComputerStatusReport, ServerStatusRow } from "../status.js";
import type { RunnerListItem } from "../apiClient.js";

/**
 * Canonical lib-side name for the `service-status` reader result, aligned
 * with the wire method literal. Identical shape to `ComputerStatusReport`
 * (re-exported above for callers that prefer the historical internal
 * name).
 *
 * SECRET-FREE INVARIANT: the report carries server attachment IDENTITY
 * and pid/liveness derived from filesystem state but NEVER the user
 * access token or any `sk_computer_*` credential (status.ts §3.3.1
 * redline, enforced by `status.test.ts` token-leak guards).
 */
export type ServiceStatusResult = ComputerStatusReport;

/**
 * Per-server block in `ListRunnersResult.servers[]`. The discriminator
 * preserves the underlying `RunnersClient.list()` outcome so a single
 * server's `unauthorized` / `error` does NOT mask another server's data.
 */
export type RunnerListPerServer =
  | { serverId: string; serverSlug: string | null; status: "ok"; whitelist: string[]; runners: RunnerListItem[] }
  | { serverId: string; serverSlug: string | null; status: "unauthorized" }
  | { serverId: string; serverSlug: string | null; status: "error"; code: string };

/**
 * Aggregate result of `listRunners(installRoot, opts?)`. When `opts.serverId`
 * is omitted, `servers[]` contains one block per attached server (zero
 * blocks if the Computer has no attachments). When `opts.serverId` is set,
 * `servers[]` contains exactly that server's block, or the call throws
 * `StateReaderError("NOT_ATTACHED")` if the id is not attached.
 */
export interface ListRunnersResult {
  servers: RunnerListPerServer[];
}

/**
 * Result of `readRunnerStatus(installRoot, serverId)` — per-server state
 * row plus the runners running on it. Unauthorized / error discriminate
 * the runners-API outcome while still surfacing the `server` row so the
 * caller has the daemon state context.
 */
export type RunnerStatusResult =
  | { status: "ok"; server: ServerStatusRow; whitelist: string[]; runners: RunnerListItem[] }
  | { status: "unauthorized"; server: ServerStatusRow }
  | { status: "error"; server: ServerStatusRow; code: string };

/**
 * State-reader error closed set. Library boundary errors only — does NOT
 * include the CLI ambient-rule errors (`NO_ATTACHMENT` / `AMBIGUOUS_SERVER`)
 * which are v4 §6 ergonomics handled by the CLI wrapper, not the lib
 * primitive.
 */
export const STATE_READER_ERROR_CODES = ["NOT_ATTACHED", "INVALID_ATTACHMENT"] as const;

export type StateReaderErrorCode = (typeof STATE_READER_ERROR_CODES)[number];

/**
 * Library-side error envelope thrown by state-readers. Lib readers
 * NEVER call `fail()` / `process.exit` — CLI wrappers translate this to
 * `fail(code, message)` at the boundary; D-stage IPC handlers map it to
 * an IPC error frame.
 */
export class StateReaderError extends Error {
  readonly code: StateReaderErrorCode;
  constructor(code: StateReaderErrorCode, message: string) {
    super(message);
    this.name = "StateReaderError";
    this.code = code;
  }
}

// --- Mutation method result surface (§1.3 / §2.4 / §12) ---
//
// Result shapes for mutation methods on `RequestMethodMap`. The
// PR-impl-3 §X migration / verb pipeline owns the implementations; the
// D-stage IPC handlers `satisfies RequestMethodMap[M]["result"]` against
// these concrete shapes via mechanical delegation.

import type { RunnerState, ServiceState } from "./state.js";

/**
 * Result of the service-level restart mutation. `accepted` means a replacement
 * has proved unique IPC ownership and the same managed-machine identity; the
 * incumbent schedules its own exit only after that proof.
 */
export interface RestartServiceResult {
  status: "accepted";
}

export interface RestartServiceParams {
  /** Preserve the Web/server request id across runner -> supervisor IPC. */
  requestId: string;
  /** Only this server's runner may report the post-restart completion. */
  originServerId: string;
}

export type UpgradeStartParams =
  | {
      scope: "local";
      targetVersion: string;
      /** Locally generated operation identity; never borrowed from a Server. */
      requestId: string;
      trigger: "cli" | "tray";
      originServerId?: never;
    }
  | {
      scope: "remote";
      targetVersion?: string;
      /** Preserve the authorized Web/server request id across runner -> supervisor IPC. */
      requestId: string;
      /** Route post-restart completion only through the Server that authorized it. */
      originServerId: string;
      trigger: "web";
    };

export interface UpgradeProgressEvent {
  requestId: string;
  phase: "downloading" | "verifying" | "applying" | "restarting";
  message?: string;
  percent?: number;
  fromVersion?: string;
  targetVersion?: string;
}

export interface UpgradeCompletedEvent {
  requestId: string;
  ok: boolean;
  newVersion?: string;
  rolledBack?: boolean;
  error?: string;
}

/**
 * Result of the internal `reset-service` IPC mutation. Clears the
 * service-level `crashHistory` and transitions service state
 * `degraded → running`. MUST NOT kill runners (§1.3).
 *
 * `previousState` reports the state observed prior to the reset write —
 * for callers that want to log/surface "was already running" vs
 * "recovered from degraded". `clearedCrashCount` counts the entries
 * removed from `service.state.json::crashHistory`.
 */
export interface ResetServiceResult {
  status: "ok";
  previousState: ServiceState;
  clearedCrashCount: number;
}

/**
 * Result of the internal `reset-runner` IPC mutation.
 * Clears the per-runner `crashHistory` and transitions runner state
 * `degraded → running`. MUST NOT respawn or kill the runner process
 * (§2.4).
 *
 * `status: "not-found"` is returned when the resolved `serverId` does
 * not correspond to an attached server (the CLI ambient `--server` slug
 * resolver returns its own error before the handler is invoked; this
 * branch defends the IPC path where the caller passes a serverId
 * directly).
 */
export type ResetRunnerResult =
  | {
      status: "ok";
      serverId: string;
      previousState: RunnerState;
      clearedCrashCount: number;
    }
  | { status: "not-found"; serverId: string };

/**
 * Result of `upgrade-start` (§12 phase pipeline trigger). The same
 * pipeline is funneled by manual CLI / auto scheduler / IPC; this
 * result describes the trigger outcome only — the per-phase events
 * stream over `ServiceEvent` (`upgrade-log-appended` kind).
 *
 * `status: "already-running"` is returned when an upgrade is already
 * in flight; `upgradeId` then refers to the in-flight upgrade so the
 * caller can attach to its event stream instead of starting a new one.
 */
export interface UpgradeStartResult {
  status: "started" | "already-running";
  upgradeId: string;
  targetVersion: string;
}

// --- §X migration detection (lib consumer surface) ---

/**
 * Identity record for a legacy `@slock-ai/daemon` machine candidate
 * surfaced by `detectLegacyMigration`. Each candidate is the result of
 * intersecting (a) local `<installRoot>/machines/machine-<fp>/owner.json`
 * evidence with (b) the server's `GET /api/computer/legacy-machines`
 * roster on `apiKeyFingerprint` for the logged-in user + target server.
 * The shape is identity-only — it never carries credentials.
 *
 * `apiKeyFingerprint` is the v9.9 intersection key —
 * `sha256(apiKey).slice(0,16)`. The same value is computed locally by
 * the legacy daemon (`packages/daemon/src/machineLock.ts`) and stored
 * server-side on `daemons.api_key_fingerprint` (handshake-backfilled).
 * Stable as long as the legacy api key is unchanged.
 *
 * `daemonId` is the server's `daemons.id` UUID (display + post-migration
 * identity). It is NOT a join key — fingerprint is. Cody redline
 * msg=ec68c27f: server daemonId / machineName are display-only.
 *
 * `localPath` is the absolute path of the local owner.json that
 * supplied the fingerprint side of the intersection. Surfaced so the
 * picker can show the operator which on-disk legacy install they are
 * about to adopt, and so the manual `--migrate-from` flag's three-gate
 * validator (path-readable / owner.json-parseable / fingerprint-in-roster)
 * can return a candidate that points at the same path the operator
 * passed.
 *
 * `machineName` / `hostname` / `lastSeenAt` / `legacyKeyMigratedAt` come
 * from the server roster row — display-only, used for picker presentation
 * and interrupted-adoption recovery. May be empty for stale rows; the
 * picker tolerates blanks.
 */
export interface LegacyMachineCandidate {
  apiKeyFingerprint: string;
  daemonId: string;
  localPath: string;
  machineName: string;
  hostname?: string;
  lastSeenAt?: string;
  legacyKeyMigratedAt?: string;
}

/**
 * §X.2 migration detection result — the adjudication returned by
 * `detectLegacyMigration(installRoot, target)`.
 */
/**
 * Closed set of `MigrationDetection.kind` discriminator values. Mirrors
 * the `IPC_ERROR_CODES` / `RUNNER_STATE_VALUES` `as const` tuple pattern
 * so consumers can pattern-match exhaustively and so a future §7.4 CI
 * gate can verify the runtime kind against the type union without an
 * `as` cast (state-machine-modeling discipline — correlated/mutex
 * properties land as a closed-set state-enum).
 */
export const MIGRATION_DETECTION_KINDS = [
  "matched",
  "zero_match",
  "no_local_evidence",
  "roster_unavailable",
] as const;

export type MigrationDetectionKind = (typeof MIGRATION_DETECTION_KINDS)[number];

/** Runtime narrow guard for `MigrationDetection.kind`. */
export function isMigrationDetectionKind(value: unknown): value is MigrationDetectionKind {
  return (
    typeof value === "string" &&
    (MIGRATION_DETECTION_KINDS as readonly string[]).includes(value)
  );
}

export type OwnerFileState =
  | "ok"
  | "absent"
  | "unreadable"
  | "malformed_json"
  | "missing_fingerprint";

export interface LocalCandidateEvidence {
  dirName: string;
  dirFingerprint: string | null;
  ownerState: OwnerFileState;
  ownerFingerprint: string | null;
  ownerServerUrl: string | null;
  effectiveFingerprint: string | null;
  localPath: string;
}

export type ExclusionReason =
  | "owner_unreadable"
  | "owner_malformed"
  | "no_fingerprint_evidence"
  | "not_in_roster"
  | "server_url_mismatch";

export interface ExcludedCandidate {
  evidence: LocalCandidateEvidence;
  reasons: ExclusionReason[];
}

export type MigrationDetection =
  | { kind: "matched"; candidates: LegacyMachineCandidate[]; excluded: ExcludedCandidate[] }
  | { kind: "zero_match"; excluded: ExcludedCandidate[] }
  | { kind: "no_local_evidence" }
  | { kind: "roster_unavailable"; localCount: number };
