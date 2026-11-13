// `@botiverse/raft-computer/lib` — RFC v9.8 §3 public library surface.
//
// This is THE Computer contract for downstream consumers (Electron app,
// Hermes, future SDK integrations). CLI text output and CLI exit codes
// are NOT contract; library exports are.
//
// Versioning (§3.3):
//   - Strict semver against this barrel's exported names + shapes.
//   - Additions are additive minor bumps; removals / renames are major.
//   - Consumers pin against the library semver, not the CLI binary
//     version.
//
// What this commit lands (PR-v9.9 — §X migration detection v9.9):
//   - Export `detectLegacyMigration(installRoot, serverSlug, clientFactory):
//     Promise<MigrationDetection>` — the §X.2 lib consumer surface.
//     Returns closed adjudication kinds (`matched` / `zero_match` /
//     `no_local_evidence` / `roster_unavailable`) so `setup.ts` (and
//     future D-stage IPC handlers) can drive the picker / fresh-attach
//     trigger choice while retaining structured excluded-candidate
//     evidence. The intersection key is `apiKeyFingerprint`
//     (sha256(apiKey).slice(0,16) — Cody redline `msg=ec68c27f`),
//     never `apiKeyHash` / raw key. The matched roster row's `daemonId`
//     plus the fingerprint are the setup adoption identity after user
//     login; ownership remains server-side (`session user owns machine row`).
//   - Export `validateManualMigratePath(path, roster):
//     Promise<ManualPathValidation>` — the §X.4 `--migrate-from`
//     three-gate validator (`MIGRATE_FROM_NOT_FOUND` /
//     `MIGRATE_FROM_INVALID` / `MIGRATE_FROM_NOT_OWNED`).
//
// Previously landed (PR-impl-3 commit 1 — `reset` verb + mutation
// type pins):
//   - Pin `RequestMethodMap.result` for mutation methods
//     (`restart-service` / `upgrade-start` / `reset-service` / `reset-runner`) to concrete
//     result shapes (replaces the `unknown` placeholders left by C3).
//   - Export `ResetServiceResult` / `ResetRunnerResult` /
//     `UpgradeStartResult` so D-stage IPC handler bindings can
//     `satisfies RequestMethodMap[M]["result"]` via mechanical
//     delegation (same pattern as C3 readers).
//
// Previously landed (C-stage commit 3, PR #2264):
//   - §3.2 state readers (`readServiceStatus` / `readRunnerStatus` /
//     `listRunners`) with explicit `installRoot` argument and lib-pure
//     error surface (`StateReaderError`, per-server status union).
//   - Pin `RequestMethodMap.result` for the 3 reader methods
//     (`service-status` / `runner-status` / `list-runners`) to the
//     concrete lib reader return types.
//   - Re-export of internal status / apiClient types as the canonical lib
//     surface (`ComputerStatusReport` aka `ServiceStatusResult`,
//     `ServerStatusRow`, `DaemonState`, `ServerHealth`, `RunnerInfo`).
//
// Previously landed (C-stage commit 2, PR #2252):
//   - Subpath export (`packages/computer/package.json` `exports` field
//     with `./lib`; `internal/*` blocked by being absent from `exports`).
//   - §3.2 type surface seed: `ConnectService` / `ServiceClient` /
//     `RequestOptions` / `RequestMethodMap` method floor /
//     `ServiceEvent` 6-kind / `ServiceClientError` / `IPC_ERROR_CODES`
//     / state-value tuples + guards / `UpgradeLogEntry` family.
//
// What lands later (deliberately NOT in this commit):
//   - §4 IPC transport implementation (`connectService` runtime body) —
//     PR-impl-2, liuliu-owned. Handlers will `satisfies` against these
//     readers + mutation result types via mechanical delegation.
//   - `upgrade-start` server-side handler — PR-impl-3 commit 2 (binds
//     to the existing §12 upgrade pipeline; this commit pins only the
//     result type).
//   - §1.3 service-state forward path (`running → degraded` cascade
//     from runner-degraded ≥2) — separate follow-up; this commit ships
//     only the backward transition (`degraded → running` via `reset
//     --service`) plus the `service.state.json` shape that the forward
//     path will populate.
//   - Full §7.3 `ERROR_CODES` enumeration (SETUP/ATTACH/MIGRATE/SERVICE
//     families) — reconciled with currently-emitted `ComputerServiceError`
//     codes in a follow-up commit so the closed set matches runtime
//     truth in one atomic step.
//   - The setup-driver behavior changes that consume the richer §X
//     excluded-candidate evidence beyond compatibility normalization.
//
// Hard invariant (package-private gate):
//   `packages/computer/src/internal/*` is NOT exported via `package.json`
//   `exports`. Cross-package imports of `@botiverse/raft-computer/internal/*`
//   are unresolvable from outside this package. The `internal/` segment
//   is the publishing-side gate; `lint:boundaries` is the in-repo
//   sibling gate.

export { ComputerError, isComputerError } from "./errors";
export { createComputerApi } from "./api";
export {
  convergeCliHostLifecycle,
  readHostLifecycleMarker,
} from "../macosLoginCarrier";
export type {
  HostLifecycleConvergenceResult,
  HostLifecycleMarker,
  HostLifecycleOwner,
  MacosHostLifecycleDeps,
} from "../macosLoginCarrier";
export { createComputerTracer } from "./computerTracer";
export type { ComputerApi, ListWorkspacesResult, WorkspaceEntry } from "./api";
export {
  ensureUsableUserSession,
  hasUnexpiredUserSessionShape,
  refreshUserSession,
} from "./userSession";
export type { UsableUserSession } from "./userSession";
export type {
  ComputerActiveSpan,
  ComputerEndSpanOptions,
  ComputerStartSpanOptions,
  ComputerTraceAttributes,
  ComputerTraceClientSource,
  ComputerTraceContext,
  ComputerTracer,
  ComputerTraceSpanKind,
  ComputerTraceStatus,
  ComputerTraceSurface,
} from "./traceTypes";
// The unified interactive-command event sink (login/attach/start/stop
// typed steps + setup/upgrade `log.line` prose). Downstream presenters (CLI
// `present()`, the menu-bar app) switch on `event.kind` to render — it is part
// of the public library contract, not CLI text.
export type { ComputerApiEvent } from "./events";

export {
  IPC_ERROR_CODES,
  MIGRATION_DETECTION_KINDS,
  isIpcErrorCode,
  isMigrationDetectionKind,
  ServiceClientError,
  STATE_READER_ERROR_CODES,
  StateReaderError,
} from "./types";
export type {
  ComputerStatusReport,
  ConnectService,
  ConnectServiceOptions,
  DaemonState,
  ExcludedCandidate,
  ExclusionReason,
  IpcErrorCode,
  LegacyMachineCandidate,
  ListRunnersResult,
  LocalCandidateEvidence,
  MigrationDetection,
  MigrationDetectionKind,
  OwnerFileState,
  RequestMethodMap,
  RequestOptions,
  RestartServiceResult,
  ResetRunnerResult,
  ResetServiceResult,
  RunnerInfo,
  RunnerListPerServer,
  RunnerStatusResult,
  ServerHealth,
  ServerStatusRow,
  ServiceClient,
  ServiceEvent,
  ServiceStatusResult,
  StateReaderErrorCode,
  UpgradeStartParams,
  UpgradeStartResult,
} from "./types";

export { adjudicate, collectDetectionEvidence, detectLegacyMigration } from "./migration";
export type { LegacyMachineRosterClient, LegacyMachineRosterClientFactory, MigrationDetectionEvidence } from "./migration";
export { LegacyMachinesClient } from "../apiClient";
export type { LegacyMachineRosterEntry, LegacyMachineRosterResult } from "../apiClient";
export { ServersClient } from "../apiClient";
export type { UserServerEntry, UserServersResult } from "../apiClient";
export {
  MIGRATION_FRESH_TRIGGERS,
  pickMigrationCandidateFromInput,
} from "../setup";
export type { MigrationFreshTrigger, PickerSelection } from "../setup";
export { listRunners, readRunnerStatus, readServiceStatus } from "./readers";

export {
  RUNNER_STATE_VALUES,
  SERVICE_STATE_VALUES,
  isRunnerState,
  isServiceState,
} from "./state";
export type { RunnerState, ServiceState } from "./state";

// §4 IPC transport — `connectService(installRoot)` opens a typed-RPC client
// to the running Computer service. With the §3/§4 service-side seam wired
// in `service.ts`, this is the canonical entry point for downstream
// consumers (Electron app, future SDKs) that want the same lib-pure
// handlers the CLI hits — no execFile shell-out.
export { connectService } from "./ipc-client";

// Domain service primitives — the lower-level service entry points
// (`login` / `attach` / etc.) hang off `createComputerApi(slockHome)` now
// (see `./api.ts`). Consumers call `api.login(opts, onEvent)` not these
// raw primitives. Per-method event types (`LoginEvent` / `AttachEvent` /
// …) were unified into a single `ComputerApiEvent` discriminated union
// in #3212 — see `./events.ts` for the canonical event surface.
//
// We keep the input / result types re-exported so consumers can name the
// method's argument / return shapes statically (e.g. for typed UI form
// state) without dynamic-importing a deep path.
export type { LoginInput, LoginResult } from "../services/login";
export type { AttachInput, AttachResult } from "../services/attach";
export type {
  DiagnosticsPushFailReason,
  DiagnosticsPushInput,
  DiagnosticsPushResult,
} from "../services/diagnosticsPush";
export { ComputerServiceError } from "../services/errors";

// Path helpers shared by CLI and GUI adapters. `resolveRaftHome` is the
// canonical home resolver; consumers must not fork env precedence / `~`
// expansion or CLI and app can end up controlling different supervisors.
// `userSessionPath` is exposed so consumers that need to read the session
// directly don't have to reconstruct the path.
export { resolveRaftHome, userSessionPath } from "../paths";
// The machine name a Computer gives itself by default (from the hostname):
// Raft Desktop asks for its approval under the same name the CLI would use.
export { deriveDefaultComputerName } from "../paths";
// The OS label an approval request carries (what the approval page shows).
export { approvalOsLabel } from "../services/attachGrant";
export type { AttachWithTokenInput } from "../services/attachGrant";
export { withComputerMutationLock } from "../concurrency";
export { resolveServerUrl, resolveServerUrlEnv } from "../serverUrl";

// Local computer version — bake-time injected via an otherwise-absent bundler
// identifier, falling back to the package.json version. Same value the daemon reports
// upstream as `computerVersion`. Surface so menubar/other clients can
// display the running version next to a CDN-resolved "latest" check.
export { COMPUTER_VERSION } from "../version";

// CDN base + latest-version probe. The default base is what install.sh and
// the upgrade pipeline use; consumers wanting to surface a "v X.Y.Z (Update
// available)" affordance can call `fetchCdnLatestVersion(DEFAULT_UPGRADE_BASE_URL)`
// and compare against `COMPUTER_VERSION`. Returns null on any failure
// (network, bad JSON, missing field) — caller decides whether to surface
// "no update info" silently.
export { DEFAULT_UPGRADE_BASE_URL, fetchCdnLatestVersion } from "../computerRelease";

// Resident service entry points — the same `runService` / `runResident` the
// CLI's `__service` / `__run` hidden commands dispatch to. Exposed so any
// adapter that owns the process entry (Electron menu-bar, daemon harness,
// future SDKs) can wire its own argv guard to these, mirroring the CLI's
// `index.ts:494-503` pattern. Without this, `spawnDetachedService` re-execs
// `process.execPath argv[1] __service` and adapters that lack a dispatcher
// (e.g. Electron, where argv[1] is `main.js` and `__service` is ignored)
// silently re-launch the GUI instead of starting the supervisor.
// (#wg-raft-computer:f2a02081 BUG 5.)
export { runService, runResident } from "../service";
// The `__detect-runtimes` child mode, for the same adapters: the hosted daemon
// re-execs its host with that mode for every runtime detection round
// (resolveSelfExec), so an adapter's argv guard must route it here too.
export { runRuntimeDetectionChildEntry as runRuntimeDetectionChild } from "../runtimeDetectionEntry";

// Shared bootstrap launcher for standalone Computer consumers.
export { installerArgs, installerCommand } from "../externalInstaller";

export { readMachineTurnActivity } from "../turnActivity";
export type { MachineTurnActivity } from "../turnActivity";
