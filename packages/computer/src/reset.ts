// Internal recovery mutations — RFC v9.8 §1.3 / §2.4.
//
// IPC/library scopes:
//   reset-service                      clear service-level crashHistory
//   reset-runner                       clear per-runner crashHistory
//
// Reset semantics (contract-locked):
//   - `--service` clears `crashHistory` in `service.state.json` and
//     transitions service state `degraded → running`. MUST NOT kill
//     runners (§1.3).
//   - `--runner` clears the per-runner `health.json` crashes and
//     transitions runner state `degraded → running`. MUST NOT respawn
//     or kill the runner process (§2.4).
//
// Internal vs CLI split:
//   - `resetService(installRoot)` and `resetRunner(installRoot,
//     serverId)` are the lib-pure handlers (no env reads, no
//     `info()`/`fail()`/`process.exit`). D-stage IPC handlers
//     (`reset-service` / `reset-runner` methods on `RequestMethodMap`)
//     delegate to these via mechanical `satisfies RequestMethodMap[M]
//     ["result"]`.
//   - The single-writer routing (`resetViaServiceOrDisk`) lives in
//     `lib/api.ts` (the ComputerApi). This module owns only the disk-pure
//     handlers and the routing helper they back.

import type {
  ResetRunnerResult,
  ResetServiceResult,
  ServiceClient,
} from "./lib/types.js";
import { resetRunnerHealth } from "./health.js";
import { clearServiceCrashHistory } from "./serviceState.js";
import { readServerAttachment } from "./serverState.js";
import { connectService } from "./lib/ipc-client.js";
import type { Tracer } from "@botiverse/raft-shared";

/**
 * Single-writer routing for a reset mutation. When a service is running,
 * route through it via IPC so the supervisor updates its in-memory runner
 * state (not just disk) — post-② a disk-only reset would leave the cached
 * lifecycle `degraded` and the runner would never respawn until the next
 * service restart. When no service is up (cold boot), apply the disk-only
 * lib-pure handler directly: there is no in-memory cache to keep consistent.
 *
 * Only a connection failure (no live service) falls back to disk; a handler
 * error from a live service propagates so the operator sees the real result.
 */
export async function resetViaServiceOrDisk<T>(
  slockHome: string,
  method: string,
  viaService: (client: ServiceClient) => Promise<T>,
  direct: () => Promise<T>,
  tracer: Tracer,
): Promise<T> {
  const span = tracer.startSpan(method, { surface: "computer", kind: "internal" });
  let client: ServiceClient | null = null;
  try {
    try {
      client = await connectService(slockHome);
    } catch {
      client = null; // no live service → cold-boot disk path
    }
    if (!client) {
      span.addEvent("route-decided", { decision: "via-disk" });
      const r = await direct();
      span.end("ok");
      return r;
    }
    span.addEvent("route-decided", { decision: "via-service" });
    try {
      const r = await viaService(client);
      span.end("ok");
      return r;
    } finally {
      await client.close();
    }
  } catch (err) {
    span.end("error");
    throw err;
  }
}

/**
 * Service-level reset handler — lib-pure entry point for the D-stage
 * `reset-service` IPC handler.
 */
export async function resetService(installRoot: string): Promise<ResetServiceResult> {
  const { previousState, clearedCrashCount } = await clearServiceCrashHistory(installRoot);
  return {
    status: "ok",
    previousState,
    clearedCrashCount,
  };
}

/**
 * Runner-level reset handler — lib-pure entry point for the D-stage
 * `reset-runner` IPC handler. The IPC handler accepts `serverId` directly
 * per `RequestMethodMap["reset-runner"].params`.
 *
 * Computer-attachment boundary: a valid-shape `serverId` with no local
 * attachment MUST short-circuit to `{status:"not-found"}` BEFORE we
 * touch `health.json` or emit a `runner-state-changed` trace. Otherwise
 * any IPC caller with a well-formed UUID could clear residue health
 * state + emit transitions for runners this Computer does not actually
 * manage, leaking across the per-Computer isolation boundary.
 */
export async function resetRunner(
  installRoot: string,
  serverId: string,
): Promise<ResetRunnerResult> {
  const attachment = await readServerAttachment(installRoot, serverId);
  if (!attachment) {
    return { status: "not-found", serverId };
  }
  const outcome = await resetRunnerHealth(installRoot, serverId);
  if (outcome.status === "not-found") {
    return { status: "not-found", serverId };
  }
  return {
    status: "ok",
    serverId,
    previousState: outcome.previousState ?? "running",
    clearedCrashCount: outcome.clearedCrashCount ?? 0,
  };
}
