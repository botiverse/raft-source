// `@botiverse/raft-computer/lib` — the ComputerApi (CLI-over-lib convergence).
//
// This is THE logic home for Computer operations. Each method is PURE: it
// returns a structured result OR throws a `ComputerError` carrying a closed-set
// `code` + actionable `message` (+ the CLI process exit code). Methods NEVER
// call `info()`/`fail()`/`process.exit` or write to stdout/stderr — that is the
// CLI presenter's job (see `present`/`fail` in ../output.ts). The CLI, GUI, and
// future SDK consumers all drive these same methods and present the result.
//
// Interactive commands (login / setup) take an EVENT SINK / PROMPT callback the
// presenter supplies: the api drives the flow + returns/throws, while the sink
// performs the actual stdout (device-code lines / picker prompts). The api
// itself never prints.
//
// Mutating commands keep their `withMutationLock` wrapping in the CLI/presenter
// layer (unchanged) — the api owns the lifecycle logic only.

import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";

import type { ComputerStatusReport } from "../status.js";
import { buildStatusReport } from "../status.js";
import {
  ServiceClientError,
  type ResetRunnerResult,
  type ResetServiceResult,
  type LegacyMachineCandidate,
} from "./types.js";
import { ServersClient, type UserServerEntry, type UserServersResult } from "../apiClient.js";
import {
  resetRunner as resetRunnerDisk,
  resetService as resetServiceDisk,
  resetViaServiceOrDisk,
} from "../reset.js";
import { connectService } from "./ipc-client.js";
import { noopTracer } from "@botiverse/raft-shared";
import type { ComputerTracer } from "./traceTypes.js";
import { ComputerError } from "./errors.js";
import { ComputerServiceError } from "../services/errors.js";
import {
  resolveRaftHome,
  userSessionPath,
  serverRunnerLogReadFallback,
  serviceLogPath,
} from "../paths.js";
import { resolveServerUrl, resolveServerUrlEnv } from "../serverUrl.js";
import { login as loginService, type LoginResult } from "../services/login.js";
import { attach as attachService, type AttachResult } from "../services/attach.js";
import { start as startService, type StartResult, type StartDeps } from "../services/start.js";
import { stop as stopService, type StopResult, type StopDeps, type StopStatus } from "../services/stop.js";
import {
  diagnosticsPush as diagnosticsPushService,
  type DiagnosticsPushResult,
} from "../services/diagnosticsPush.js";
import type { ComputerApiEvent } from "./events.js";
import { runDoctorChecks, type DoctorCheck, redactSecrets } from "../doctor.js";
import { runFullCleanup, type CleanupReport } from "../cleanup.js";
import { readCrashHistory } from "../health.js";
import { clearServerManaged, formatServerSlugDisplay, listAttachedServerIds } from "../serverState.js";
import { RunnersClient } from "../apiClient.js";
import { listRunners } from "./readers.js";
import { parseChannel, readChannel, writeChannel, type Channel } from "./channelState.js";
import { setupCore, type SetupOptions, type SetupDeps } from "../setup.js";
import { findLiveServicePidReadOnly } from "../internal/service-pid-fallback.js";
import type { RunnerListItem } from "../apiClient.js";
import { ensureUsableUserSession, refreshUserSession } from "./userSession.js";
import { prepareLocalLifecycleOperations } from "../localLifecycleIntents.js";

/**
 * Helper: run a `services/*` call whose failures are `ComputerServiceError`,
 * re-throwing them as the api's typed `ComputerError` (same `code` + `message`,
 * so the presenter can apply the shared CLI error contract consistently).
 * Any non-service error (e.g. a programming fault) propagates unchanged.
 */
async function viaService<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof ComputerServiceError) {
      throw new ComputerError(err.code, err.message);
    }
    throw err;
  }
}

// --- doctor result surface ---

/**
 * Pure result of `doctor` (`raft-computer doctor [serverSlug] [--fix]`). The
 * presenter formats it (with `redactSecrets` on every emitted line) and sets
 * the process exit code from `allOk`.
 */
export interface DoctorReport {
  checks: DoctorCheck[];
  allOk: boolean;
  cleanup: CleanupReport | null;
  crashes: Awaited<ReturnType<typeof readCrashHistory>>;
  serverId?: string;
  serverLabel?: string;
}

// --- runners result surface (presenter formats these) ---

export interface RunnersListResult {
  serverSlug: string | null;
  serverId: string;
  runners: RunnerListItem[];
}

export interface RunnersStopResult {
  serverSlug: string | null;
  serverId: string;
  agentId: string;
}

// --- workspace listing result surface (D2 onboarding picker) ---

export interface WorkspaceEntry {
  id: string;
  name: string;
  slug: string;
  /** Open server role vocabulary; only owner/admin make `attachable` true. */
  role: string;
  attachable: boolean;
  alreadyAttached: boolean;
}

export type ListWorkspacesResult =
  | { status: "success"; workspaces: WorkspaceEntry[] }
  | { status: "not_logged_in" }
  | { status: "error"; code: string };

// --- logout result surface ---

export interface LogoutResult {
  status: "logged-out" | "already-logged-out";
  sessionPath: string;
  /** Outcome of stopping the service — and therefore every per-server runner —
   *  as part of sign-out (rule 1: sign out disconnects every workspace
   *  Computer; the web shows them offline). `stop_error` means the stop attempt
   *  threw; the user session is still cleared (sign-out is best-effort on the
   *  stop). Local attachments are always KEPT so re-login resumes the same
   *  Computers. */
  runnersStopped?: StopStatus | "stop_error";
}

/**
 * The typed Computer library API. Each method is PURE (result | throw
 * `ComputerError`). `createComputerApi(slockHome)` binds an install root so the
 * methods take no ambient env reads of their own.
 */
export interface ComputerApi {
  /**
   * Build the Computer-level aggregate status report. Read-only and
   * secret-free (status.ts §3.3.1 redline).
   */
  getStatus(): Promise<ComputerStatusReport>;
  /**
   * List workspaces the logged-in user belongs to, annotated with
   * attachability (owner/admin) and whether already attached locally.
   * Used by the D2 onboarding workspace picker. Read-only.
   */
  listWorkspaces(): Promise<ListWorkspacesResult>;
  /**
   * Clear the service-level crash history and transition service state
   * `degraded → running` (§1.3). Routes through the running service via IPC
   * when one is up (single-writer), else applies the disk-only handler.
   */
  resetService(): Promise<ResetServiceResult>;
  /**
   * Clear a per-runner crash history and transition runner state
   * `degraded → running` (§2.4). Same single-writer routing as `resetService`.
   * Returns `{status:"not-found"}` (a RESULT, not a throw) when `serverId` is
   * not an attached server.
   */
  resetRunner(serverId: string): Promise<ResetRunnerResult>;

  /**
   * Device-code login (one user identity per Computer / SLOCK_HOME). Drives
   * the device-code flow; the presenter-supplied `onEvent` sink prints the
   * verification URL/code + waiting lines. The api itself never prints.
   */
  login(opts: { serverUrl?: string }, onEvent?: (event: ComputerApiEvent) => void): Promise<LoginResult>;
  /** Clear the saved user session (idempotent). Pure: returns a result. */
  logout(onEvent?: (event: ComputerApiEvent) => void, deps?: StopDeps): Promise<LogoutResult>;
  /**
   * Attach this Computer to one server (add-not-replace). `onEvent` prints
   * the attach progress lines presenter-side.
   */
  attach(
    opts: { serverSlug: string; serverUrl?: string; name?: string },
    onEvent?: (event: ComputerApiEvent) => void,
  ): Promise<AttachResult>;
  /** Start/ensure the Computer service. `onEvent` formats the start lines. */
  start(
    opts: {
      foreground?: boolean;
      serverId?: string | null;
      serverLabel?: string | null;
      recordLifecycleIntent?: boolean;
      hostLifecycleOwner?: "cli" | "app" | "none";
    },
    onEvent?: (event: ComputerApiEvent) => void,
    deps?: StartDeps,
  ): Promise<StartResult>;
  /** Stop the Computer service (idempotent). `onEvent` formats the stop lines. */
  stop(
    onEvent?: (event: ComputerApiEvent) => void,
    deps?: StopDeps,
    options?: {
      recordLifecycleIntent?: boolean;
      hostLifecycleOwner?: "cli" | "app" | "none";
    },
  ): Promise<StopResult>;

  /**
   * V0 Sync diagnostics — write a `diagnostics.push` marker span into every
   * known trace dir (Computer surface + each per-server runner) so the next
   * periodic upload pass (≤5min) carries the marker to the worker. Returns a
   * `correlationId` the user can quote when filing an issue; does NOT return
   * a reportId / traceId, because the upload is async (b2 semantic — Yingjun
   * msg=2753a3ad). Closed reason set on failure: OFFLINE / NO_TRACE_DIR /
   * UPLOAD_DISABLED. (#wg-raft-computer:f2a02081 task #97 → #11.)
   */
  diagnosticsPush(
    opts?: Record<string, never>,
    onEvent?: (event: ComputerApiEvent) => void,
  ): Promise<DiagnosticsPushResult>;

  /**
   * Diagnose login + per-server attachments + preflight + service. Returns the
   * report (runs the cleanup pass when `cleanup` is true). Pure — the presenter
   * formats (with `redactSecrets`) and sets the exit code from `allOk`.
   */
  doctor(opts: { cleanup?: boolean; serverId?: string; serverLabel?: string }): Promise<DoctorReport>;

  /**
   * Tail one server's runner log (or the service log). Returns the trailing
   * (already secret-redacted) lines; the presenter prints them. Throws
   * `NO_DAEMON_LOG` when the target log is absent.
   */
  logs(opts: { lines?: number; serverId?: string; service?: boolean }): Promise<string[]>;

  /** List runners on one attached server. Defaults to this machine; all=true preserves the legacy server-wide view. Throws RUNNERS_* on failure. */
  runnersList(serverId: string, opts?: { all?: boolean }): Promise<RunnersListResult>;
  /** Stop a runner on one attached server. Throws the RUNNER/RUNNERS errors on failure. */
  runnersStop(agentId: string, attachment: { serverUrl: string; apiKey: string; serverSlug: string | null; serverId: string }): Promise<RunnersStopResult>;

  /** Read the current release channel (default `latest` when unset). */
  channelShow(): Promise<Channel>;
  /** Validate + persist the release channel. Throws `CHANNEL_INVALID`. */
  channelSet(raw: string): Promise<Channel>;

  /**
   * Orchestrate `setup <serverSlug>`: login → (detect + picker / --migrate-from)
   * → attach → start. INTERACTIVE: `onEvent` is the event sink (the presenter
   * unwraps `log.line` events to `info`); the interactive picker is the
   * dep-injected `pickMigrationCandidate` prompt callback. The api drives the
   * flow and throws `ComputerError` for its closed-set fail points; it never
   * prints.
   */
  setup(opts: SetupOptions, deps: SetupDeps, onEvent: (event: ComputerApiEvent) => void): Promise<void>;

  /**
   * Route a forward upgrade through a live service via IPC (`upgrade-start`):
   * the service drives download/verify/swap + self-restart in-process
   * (single-writer), so the resident process actually re-execs onto the new
   * binary (the whole point — a swapped binary with the old process still
   * running keeps reporting the old version; see #wg-raft-computer task #100).
   *
   * Returns:
   * - `{routed:true}` — handed to the live service (started / already-running
   *   line emitted via `onEvent`).
   * - `{routed:false, reason:"no-service"}` — NO live service (cold boot); the
   *   caller runs the K coordinator directly. Safe: nothing is running to
   *   strand on old bytes.
   * - `{routed:false, reason:"unreachable"}` — a service pidfile points at a
   *   LIVE process but its IPC socket could not be reached. The caller MUST
   *   fail-loud here, NOT fall through to a standalone swap: swapping the
   *   binary under a still-running old service is exactly the silent-strand
   *   bug task #100 exists to kill (the swap "succeeds" but the resident
   *   process never re-execs, so the version never takes effect).
   *
   * The cross-process upgrade race is guarded by the service's own
   * `inFlightUpgrade` + the `upgrade-start` already-running response — NOT a
   * caller-side lock. The presenter still keeps dry-run / rollback standalone
   * (local-only ops); a plain `--channel` override DOES route now (the CLI
   * resolves the override to an explicit target version first).
   */
  tryUpgradeViaService(
    targetVersion: string,
    onEvent?: (event: ComputerApiEvent) => void,
    opts?: { trigger?: "cli" | "tray" },
  ): Promise<{ routed: true } | { routed: false; reason: "no-service" | "unreachable" }>;
}

export interface CreateComputerApiOptions {
  tracer?: ComputerTracer;
  /** Bind lifecycle ownership once for a concrete presenter. CLI command
   * adapters pass `cli`; Electron passes `app`; internal users default none. */
  hostLifecycleOwner?: "cli" | "app" | "none";
  /** Narrow test seams for the cross-process upgrade routing contract. */
  upgradeRoutingDeps?: {
    connectServiceFn?: typeof connectService;
    findLiveServicePidReadOnlyFn?: typeof findLiveServicePidReadOnly;
  };
}

/**
 * Construct a ComputerApi bound to an explicit install root. The single-writer
 * reset routing (`resetViaServiceOrDisk`) lives here so the api owns the
 * IPC-vs-disk decision: when a service is running, mutations route through it
 * via IPC so the supervisor's in-memory runner state stays consistent; when no
 * service is up (cold boot) the disk-only lib-pure handlers apply directly.
 *
 * The single-writer ops (reset / upgrade routing) are spanned through the
 * caller-injected `opts.tracer` (default `noopTracer`, so untraced callers /
 * tests are zero-side-effect). The CALLER owns `source` attribution — the CLI
 * injects a `computer.cli` trace-client, the menu-bar a `computer.menu-bar`
 * one — so the same lib code attributes correctly across both surfaces.
 */
export function createComputerApi(slockHome: string, opts?: CreateComputerApiOptions): ComputerApi {
  const tracer = opts?.tracer ?? noopTracer;
  const configuredHostLifecycleOwner = opts?.hostLifecycleOwner ?? "none";
  return {
    getStatus(): Promise<ComputerStatusReport> {
      return buildStatusReport(slockHome);
    },
    async listWorkspaces(): Promise<ListWorkspacesResult> {
      let session = await ensureUsableUserSession(slockHome);
      if (session.status !== "usable") {
        return { status: "not_logged_in" };
      }
      const baseUrl = resolveServerUrl(session.serverUrl, resolveServerUrlEnv());
      let client = new ServersClient(baseUrl, session.accessToken);
      let result = await client.list();
      if (result.status === "auth_required") {
        if (!(await refreshUserSession(slockHome, baseUrl))) return { status: "not_logged_in" };
        session = await ensureUsableUserSession(slockHome, baseUrl);
        if (session.status !== "usable") return { status: "not_logged_in" };
        client = new ServersClient(baseUrl, session.accessToken);
        result = await client.list();
        if (result.status === "auth_required") return { status: "not_logged_in" };
      }
      if (result.status === "error") return { status: "error", code: result.code };
      const status = await buildStatusReport(slockHome);
      const attachedIds = new Set(status.servers.map((s) => s.serverId));
      const workspaces: WorkspaceEntry[] = result.servers.map((s) => ({
        id: s.id,
        name: s.name,
        slug: s.slug,
        role: s.role,
        attachable: s.role === "owner" || s.role === "admin",
        alreadyAttached: attachedIds.has(s.id),
      }));
      return { status: "success", workspaces };
    },
    resetService(): Promise<ResetServiceResult> {
      return resetViaServiceOrDisk(
        slockHome,
        "reset-service",
        (client) => client.request("reset-service", undefined),
        () => resetServiceDisk(slockHome),
        tracer,
      );
    },
    resetRunner(serverId: string): Promise<ResetRunnerResult> {
      return resetViaServiceOrDisk(
        slockHome,
        "reset-runner",
        (client) => client.request("reset-runner", { serverId }),
        () => resetRunnerDisk(slockHome, serverId),
        tracer,
      );
    },

    login(opts, onEvent): Promise<LoginResult> {
      return viaService(() =>
        loginService({ serverUrl: opts.serverUrl, slockHome }, onEvent ? { onEvent } : {}),
      );
    },

    async logout(onEvent, deps): Promise<LogoutResult> {
      const sessionPath = userSessionPath(slockHome);
      // Sign-out disconnects every workspace Computer, but keeps attachment
      // identity. Clear managed intent first so a later stray service restart
      // cannot rehydrate runners until re-login/start sets the flags again.
      try {
        const attached = await listAttachedServerIds(slockHome);
        await Promise.all(attached.map((serverId) => clearServerManaged(slockHome, serverId)));
      } catch {
        // Best-effort: sign-out must still clear the user session. Stop below
        // remains the primary live-runner shutdown path.
      }
      // rule 1 (sign out disconnects every workspace Computer): stop the service
      // so every per-server runner exits — no heartbeat means the web shows
      // these Computers offline. Local attachments (runner.state.json) are KEPT,
      // so a later re-login resumes the SAME Computers. Best-effort: a stop
      // failure must never block clearing the session.
      let runnersStopped: StopStatus | "stop_error";
      try {
        const stopped = await viaService(() =>
          stopService({ slockHome }, { ...(deps ?? {}), ...(onEvent ? { onEvent } : {}) }),
        );
        runnersStopped = stopped.status;
      } catch {
        runnersStopped = "stop_error";
      }
      try {
        await unlink(sessionPath);
        return { status: "logged-out", sessionPath, runnersStopped };
      } catch (err) {
        if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
          return { status: "already-logged-out", sessionPath, runnersStopped };
        }
        throw err;
      }
    },

    attach(opts, onEvent): Promise<AttachResult> {
      return viaService(() =>
        attachService(
          { serverSlug: opts.serverSlug, serverUrl: opts.serverUrl, name: opts.name, slockHome },
          onEvent ? { onEvent } : {},
        ),
      );
    },

    async start(opts, onEvent, deps): Promise<StartResult> {
      const targets = opts.serverId ? [opts.serverId] : await listAttachedServerIds(slockHome);
      if (opts.recordLifecycleIntent !== false) {
        await prepareLocalLifecycleOperations(slockHome, "start", targets).catch(() => []);
      }
      return viaService(() =>
        startService(
          {
            foreground: opts.foreground,
            serverId: opts.serverId ?? null,
            serverLabel: opts.serverLabel ?? null,
            slockHome,
            hostLifecycleOwner: opts.hostLifecycleOwner ?? configuredHostLifecycleOwner,
          },
          { ...(deps ?? {}), ...(onEvent ? { onEvent } : {}) },
        ),
      );
    },

    async stop(onEvent, deps, options): Promise<StopResult> {
      const targets = await listAttachedServerIds(slockHome).catch(() => []);
      if (options?.recordLifecycleIntent !== false) {
        await prepareLocalLifecycleOperations(slockHome, "stop", targets).catch(() => []);
      }
      return viaService(() =>
        stopService(
          {
            slockHome,
            hostLifecycleOwner: options?.hostLifecycleOwner ?? configuredHostLifecycleOwner,
          },
          { ...(deps ?? {}), ...(onEvent ? { onEvent } : {}) },
        ),
      );
    },

    diagnosticsPush(_opts, onEvent): Promise<DiagnosticsPushResult> {
      // Pure result — `diagnosticsPush` never throws `ComputerServiceError`,
      // every failure mode is part of the result union (closed reason set).
      // No `viaService` wrap needed.
      return diagnosticsPushService(
        { slockHome },
        onEvent ? { onEvent } : {},
      );
    },

    async doctor(opts): Promise<DoctorReport> {
      const checks = await runDoctorChecks(slockHome, opts.serverId ? { serverId: opts.serverId } : {});
      const allOk = checks.every((c) => c.ok);

      // v6 §6 LOCAL-STATE-ONLY INVARIANT: doctor cleanup never touches
      // server-side state — all operations are scoped to `~/.slock/computer/`.
      let cleanup: CleanupReport | null = null;
      if (opts.cleanup) {
        cleanup = await runFullCleanup(slockHome);
      }

      // PR-H §3.3 — when a serverId is provided, include its recent crash
      // history (60s window) so the operator can see WHY a runner is degraded.
      let crashes: DoctorReport["crashes"] = [];
      if (opts.serverId) {
        crashes = await readCrashHistory(slockHome, opts.serverId);
      }

      return {
        checks,
        allOk,
        cleanup,
        crashes,
        ...(opts.serverId ? { serverId: opts.serverId } : {}),
        ...(opts.serverLabel ? { serverLabel: opts.serverLabel } : {}),
      };
    },

    async logs(opts): Promise<string[]> {
      const candidates = opts.service
        ? [serviceLogPath(slockHome)]
        : serverRunnerLogReadFallback(slockHome, opts.serverId as string);

      let content: string;
      let file = candidates[0]!;
      try {
        let lastErr: unknown = null;
        content = "";
        for (const candidate of candidates) {
          try {
            content = await readFile(candidate, "utf8");
            file = candidate;
            lastErr = null;
            break;
          } catch (err) {
            lastErr = err;
          }
        }
        if (lastErr !== null) throw lastErr;
      } catch {
        throw new ComputerError(
          "NO_DAEMON_LOG",
          opts.service
            ? `No service log at ${file}. Start the service first (\`raft-computer start\`).`
            : `No server runner log at ${file}. Start its server runner first (\`raft-computer start\`).`,
        );
      }

      const DEFAULT_LINES = 200;
      const n =
        Number.isInteger(opts.lines) && (opts.lines as number) > 0
          ? (opts.lines as number)
          : DEFAULT_LINES;

      const lines = content.split("\n");
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      const tail = lines.slice(-n);
      return tail.map((line) => redactSecrets(line));
    },

    async runnersList(serverId, opts): Promise<RunnersListResult> {
      const { servers } = await listRunners(slockHome, { serverId, all: opts?.all });
      const block = servers[0];
      // User-facing label: canonical `/<slug>` for known slug; serverId only
      // as a transitional fallback for pre-PR-G attachments not yet refreshed.
      const label = block.serverSlug ? formatServerSlugDisplay(block.serverSlug) : block.serverId;

      if (block.status === "unauthorized") {
        throw new ComputerError(
          "RUNNERS_UNAUTHORIZED",
          `The Computer credential for ${label} was rejected. Re-run \`raft-computer attach ${label}\`.`,
        );
      }
      if (block.status === "error") {
        throw new ComputerError(
          "RUNNERS_LIST_FAILED",
          `Could not list runners on ${label} (${block.code}). Check --server-url / server version.`,
        );
      }
      return { serverSlug: block.serverSlug, serverId: block.serverId, runners: block.runners };
    },

    async runnersStop(agentId, attachment): Promise<RunnersStopResult> {
      const client = new RunnersClient(attachment.serverUrl, attachment.apiKey);
      const result = await client.stop(agentId);
      const label = attachment.serverSlug ? formatServerSlugDisplay(attachment.serverSlug) : attachment.serverId;

      if (result.status === "unauthorized") {
        throw new ComputerError(
          "RUNNERS_UNAUTHORIZED",
          `The Computer credential for ${label} was rejected. Re-run \`raft-computer attach ${label}\`.`,
        );
      }
      if (result.status === "not_found") {
        throw new ComputerError("RUNNER_NOT_FOUND", `No runner ${agentId} on server ${label}.`);
      }
      if (result.status === "error") {
        throw new ComputerError(
          "RUNNER_STOP_FAILED",
          `Could not stop runner on ${label} (${result.code}). Check --server-url / server version.`,
        );
      }
      return { serverSlug: attachment.serverSlug, serverId: attachment.serverId, agentId };
    },

    channelShow(): Promise<Channel> {
      return readChannel(slockHome);
    },

    async channelSet(raw): Promise<Channel> {
      const parsed = parseChannel(raw);
      if (parsed === null) {
        throw new ComputerError(
          "CHANNEL_INVALID",
          `Invalid channel "${raw}". Accepted: \`latest\`, \`alpha\`, or \`pinned:<semver>\` (e.g. pinned:0.52.2).`,
        );
      }
      await writeChannel(slockHome, parsed);
      return parsed;
    },

    setup(opts, deps, onEvent): Promise<void> {
      return setupCore(slockHome, opts, deps, onEvent, tracer);
    },

    async tryUpgradeViaService(targetVersion, onEvent, upgradeOptions): Promise<{ routed: true } | { routed: false; reason: "no-service" | "unreachable" }> {
      const span = tracer.startSpan("upgrade", { surface: "computer", kind: "internal" });
      const routingDeps = opts?.upgradeRoutingDeps;
      let client = null;
      try {
        client = await (routingDeps?.connectServiceFn ?? connectService)(slockHome);
      } catch {
        // Connect failed. Distinguish two cases so the caller can decide
        // safely (task #100): a genuine cold boot (no live service) where a
        // standalone swap is safe, vs a LIVE service whose socket we couldn't
        // reach — where a standalone swap would silently strand the running
        // process on the old binary. Read-only liveness probe (never unlinks a
        // pidfile — that's the mutation path's job).
        const { pid } = await (routingDeps?.findLiveServicePidReadOnlyFn ?? findLiveServicePidReadOnly)(slockHome);
        const reason = pid !== null ? "unreachable" : "no-service";
        span.addEvent("route-decided", { decision: "standalone", reason });
        span.end("ok");
        return { routed: false, reason };
      }
      const requestedTrigger = upgradeOptions?.trigger ?? "cli";
      try {
        span.addEvent("route-decided", { decision: "ipc" });
        const requestId = randomUUID();
        const r = await client.request("upgrade-start", {
          scope: "local",
          targetVersion,
          requestId,
          trigger: requestedTrigger,
        });
        if (r.targetVersion !== targetVersion) {
          throw new ComputerError(
            "UPGRADE_RECEIPT_MISMATCH",
            "The service accepted a different target version; the exact local intent remains pending for reconciliation.",
          );
        }
        if (r.status === "already-running") {
          onEvent?.({
            kind: "log.line",
            line: `An upgrade to ${r.targetVersion} is already running (id ${r.upgradeId}).`,
          });
        } else {
          onEvent?.({
            kind: "log.line",
            line:
              `Upgrade to ${r.targetVersion} started (id ${r.upgradeId}). The service downloads, ` +
              `verifies, swaps the binary, and restarts on it; run \`raft-computer status\` to confirm.`,
          });
        }
        span.end("ok");
        return { routed: true };
      } catch (err) {
        span.end("error");
        if (err instanceof ServiceClientError) {
          throw new ComputerError(err.code, err.message);
        }
        throw err;
      } finally {
        await client.close();
      }
    },
  };
}

// Re-export the doctor secret-redactor the presenter applies on every line.
export { redactSecrets };
export type { LegacyMachineCandidate };
