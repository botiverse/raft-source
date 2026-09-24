import { WebSocketServer, type WebSocket } from "ws";
import type http from "node:http";
import { URL } from "node:url";
import { noopTracer, asMachineId, type Tracer } from "@botiverse/raft-shared";
import {
  findMachineByApiKey,
  getMachine,
  extractApiKeyFingerprint,
} from "../services/machineService.js";
import {
  findComputerByApiKeyWithReason,
  isComputerApiKey,
  type ComputerAuthDenyReason,
} from "../services/computerCredentialService.js";
import { getServer } from "../services/serverService.js";
import type {
  AgentOrchestrator,
  MachineConnectionPrincipalKind,
} from "../services/agentOrchestrator.js";
import { sendAuthenticatedMachineContext } from "../services/machineContext.js";
import type { MachineToServerMessage } from "@botiverse/raft-shared";
import {
  buildMachineConnectTraceContext,
  projectMachineConnectTraceAttrs,
  type MachineConnectTraceContext,
} from "../tracing/migrationTraceContext.js";

type MatchedMachine = { id: string; serverId: string; legacyKeyMigratedAt?: Date | null };

// Closed-set principal kinds + deny reasons + stages for the `/daemon/connect`
// auth span (o11y review, Leiysky 2026-06-05). These are deliberately CLOSED
// unions, not `string`: the 401 reason is meant to be a stable, queryable,
// alertable enum, so the type structurally prevents any branch from leaking an
// arbitrary string into `Slock-Reason` or the trace. The computer-lookup
// sub-reasons fold in from `ComputerAuthDenyReason`. None of these strings
// carry an id, key, or prefix, so they are safe in both the span and the
// header. `legacy_machine_key_migrated` is byte-identical to the pre-existing
// header value older daemons already match on.
type PrincipalKind = MachineConnectionPrincipalKind;
type AuthDenyReason =
  | ComputerAuthDenyReason
  | "missing_key"
  | "invalid_key_format"
  | "computer_machine_unlinked"
  | "machine_not_found"
  | "machine_key_invalid"
  | "legacy_machine_key_migrated"
  | "exception";
type AuthStage =
  | "format"
  | "computer_lookup"
  | "machine_lookup"
  | "legacy_migration"
  | "server_lookup"
  | "exception";
type UpgradeAuthResult =
  | { outcome: "accepted"; principalKind: PrincipalKind; machine: MatchedMachine; computerId?: string }
  | { outcome: "rejected"; principalKind: PrincipalKind; reason: AuthDenyReason; stage: AuthStage };

function extractBearerToken(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return null;
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

/**
 * Resolve a `/daemon/connect` handshake to either an accepted machine or a
 * closed-set deny reason. The accept/deny DECISION is byte-for-byte the same
 * as before this seam landed — a computer is authorized iff its attachment is
 * live + verifies + its linked machine exists + its server is live; a legacy
 * key iff the machine exists, is not migrated, and its server is live. The
 * ONLY addition is the reason/stage, for tracing + Slock-Reason.
 */
async function resolveUpgradeAuth(apiKey: string | null): Promise<UpgradeAuthResult> {
  if (!apiKey) {
    return { outcome: "rejected", principalKind: "unknown", reason: "missing_key", stage: "format" };
  }
  const isComputer = isComputerApiKey(apiKey);
  const principalKind: PrincipalKind = isComputer
    ? "computer"
    : apiKey.startsWith("sk_machine_") || apiKey.startsWith("sk_daemon_")
      ? "legacy_machine"
      : "unknown";
  if (principalKind === "unknown") {
    return { outcome: "rejected", principalKind, reason: "invalid_key_format", stage: "format" };
  }

  if (isComputer) {
    const lookup = await findComputerByApiKeyWithReason(apiKey);
    if (!lookup.ok) {
      // The lookup owns the machine-link decision; keep the historical stage
      // for the unlinked reason so the trace contract is unchanged.
      const stage = lookup.reason === "computer_machine_unlinked" ? "machine_lookup" : "computer_lookup";
      return { outcome: "rejected", principalKind, reason: lookup.reason, stage };
    }
    const machine = await getMachine(asMachineId(lookup.computer.machineId));
    if (!machine) {
      // Reachable only by a lookup/delete race; trace it distinctly.
      return { outcome: "rejected", principalKind, reason: "machine_not_found", stage: "machine_lookup" };
    }
    const server = await getServer(machine.serverId);
    if (!server) {
      return { outcome: "rejected", principalKind, reason: "server_not_found", stage: "server_lookup" };
    }
    return { outcome: "accepted", principalKind, machine, computerId: lookup.computer.computerId };
  }

  const machine = await findMachineByApiKey(apiKey);
  if (!machine) {
    return { outcome: "rejected", principalKind, reason: "machine_key_invalid", stage: "machine_lookup" };
  }
  const legacyKeyMigratedAt =
    "legacyKeyMigratedAt" in machine ? machine.legacyKeyMigratedAt ?? null : null;
  if (legacyKeyMigratedAt) {
    return { outcome: "rejected", principalKind, reason: "legacy_machine_key_migrated", stage: "legacy_migration" };
  }
  const server = await getServer(machine.serverId);
  if (!server) {
    return { outcome: "rejected", principalKind, reason: "server_not_found", stage: "server_lookup" };
  }
  return { outcome: "accepted", principalKind, machine };
}

/**
 * Setup WebSocket endpoint for machine connections: ws://server/daemon/connect
 * Auth prefers Authorization: Bearer <api_key>. The legacy ?key= query form
 * remains accepted for older daemon processes during rollout.
 * Accepts both sk_daemon_ and sk_machine_ API key prefixes.
 */
export function setupMachineWebSocket(
  server: http.Server,
  orchestrator: AgentOrchestrator,
  tracer: Tracer | null = null,
) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", async (request, socket, head) => {
    const url = new URL(request.url || "", `http://${request.headers.host}`);
    if (url.pathname !== "/daemon/connect") {
      // Not a machine connection — let Socket.io handle it. Do NOT open an
      // auth span for non-/daemon/connect upgrades.
      return;
    }

    const apiKey = extractBearerToken(request.headers.authorization) ?? url.searchParams.get("key");
    const traceContext = buildMachineConnectTraceContext(request.headers.host);
    const traceAttrs = projectMachineConnectTraceAttrs(traceContext);
    // `apiKeyFingerprint` = sha256(key)[0..15] — an irreversible, offline-
    // reproducible join key. The raw key / `sk_computer_*` prefix / query
    // string are NEVER put in the span or the response.
    const span = (tracer ?? noopTracer).startSpan("server.daemon.connect.auth", {
      surface: "server",
      kind: "server",
      attrs: {
        ...traceAttrs,
        ...(apiKey ? { api_key_fingerprint: extractApiKeyFingerprint(apiKey) } : {}),
      },
    });

    try {
      const result = await resolveUpgradeAuth(apiKey);

      if (result.outcome === "rejected") {
        span.addEvent("auth.rejected", {
          outcome: "rejected",
          reason: result.reason,
          principal_kind: result.principalKind,
          auth_stage: result.stage,
          ...traceAttrs,
        });
        socket.write(`HTTP/1.1 401 Unauthorized\r\nSlock-Reason: ${result.reason}\r\n\r\n`);
        socket.destroy();
        // auth_stage lives on the span ROOT (end) attrs, not only the event —
        // ScopeDB aggregates 401s by root attrs and must not have to crack the
        // event payload to slice by stage (o11y review, Leiysky).
        span.end("ok", {
          attrs: {
            outcome: "rejected",
            reason: result.reason,
            principal_kind: result.principalKind,
            auth_stage: result.stage,
            ...traceAttrs,
          },
        });
        return;
      }

      span.addEvent("auth.accepted", {
        outcome: "accepted",
        principal_kind: result.principalKind,
        server_id: result.machine.serverId,
        machine_id: result.machine.id,
        ...traceAttrs,
        ...(result.computerId ? { computer_id: result.computerId } : {}),
      });
      span.end("ok", {
        attrs: {
          outcome: "accepted",
          principal_kind: result.principalKind,
          machine_id: result.machine.id,
          server_id: result.machine.serverId,
          ...traceAttrs,
        },
      });

      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, result.machine, traceContext, result.principalKind);
      });
    } catch (err) {
      console.error("Machine WebSocket upgrade error:", err);
      span.addEvent("auth.exception", {
        outcome: "error",
        reason: "exception",
        auth_stage: "exception",
        error_class: err instanceof Error ? err.name : typeof err,
        ...traceAttrs,
      });
      // Closed-set reason/stage on the root so an exploded auth path is
      // queryable/alertable the same way every other outcome is.
      span.end("error", { attrs: { outcome: "error", reason: "exception", auth_stage: "exception", ...traceAttrs } });
      try {
        socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
        socket.destroy();
      } catch {
        // socket already torn down
      }
    }
  });

  wss.on("connection", (
    ws: WebSocket,
    machine: any,
    traceContext?: MachineConnectTraceContext,
    principalKind: MachineConnectionPrincipalKind = "unknown",
  ) => {
    try {
      sendAuthenticatedMachineContext(ws, {
        machineId: machine.id,
        serverId: machine.serverId,
      });
    } catch (err) {
      console.error(`[Machine ${machine.id}] Failed to send authenticated context:`, err);
      try { ws.close(1011, "machine_context_send_failed"); } catch { /* already closed */ }
      return;
    }
    orchestrator.registerMachine(machine.id, machine.serverId, ws, traceContext, principalKind).catch((err) => {
      console.error(`[Machine ${machine.id}] Registration failed:`, err);
    });

    ws.on("message", (data: Buffer) => {
      try {
        const msg: MachineToServerMessage = JSON.parse(data.toString());
        orchestrator.handleMachineMessage(machine.id, msg, ws).catch((err) => {
          console.error(`[Machine ${machine.id}] Message handling failed:`, err);
        });
      } catch (err) {
        console.error(`[Machine ${machine.id}] Invalid message:`, err);
      }
    });

    ws.on("close", (code, reasonBuffer) => {
      orchestrator.handleMachineDisconnect(machine.id, ws, {
        cause: "socket_close",
        closeCode: code,
        closeReason: reasonBuffer.toString("utf8"),
      }).catch((err) => {
        console.error(`[Machine ${machine.id}] Disconnect handling failed:`, err);
      });
    });

    ws.on("error", (err: Error) => {
      console.error(`[Machine ${machine.id}] WebSocket error:`, err);
      orchestrator.handleMachineDisconnect(machine.id, ws, {
        cause: "socket_error",
        errorMessage: err.message,
      }).catch((err2) => {
        console.error(`[Machine ${machine.id}] Disconnect handling failed:`, err2);
      });
    });
  });

  return wss;
}
