// RFC v9.8 §3.2 state-reader implementations.
//
// LIB BOUNDARY DISCIPLINE:
//   - No env reads. `installRoot` is always an explicit argument.
//   - No `info()` / `fail()` / `process.exit`. Errors throw
//     `StateReaderError`; per-server outcome unions surface unauthorized /
//     error without aborting the whole call.
//   - No CLI ambient ergonomics (`AMBIGUOUS_SERVER`, `NO_ATTACHMENT`) —
//     those belong to the CLI wrapper layer (`resolveTargetServerId`).
//
// The D-stage §4 IPC handlers (PR-impl-2, liuliu-owned) for
// `service-status` / `runner-status` / `list-runners` satisfy the wire
// surface by delegating directly to these readers — mechanical
// `satisfies RequestMethodMap[K]["result"]`.
import { buildStatusReport, type ComputerStatusReport } from "../status.js";
import { RunnersClient } from "../apiClient.js";
import { listServerAttachments, readServerAttachment } from "../serverState.js";
import {
  StateReaderError,
  type ListRunnersResult,
  type RunnerListPerServer,
  type RunnerStatusResult,
  type ServiceStatusResult,
} from "./types.js";

/**
 * Read the Computer-level aggregate status from `installRoot`. Identical
 * shape to `buildStatusReport(installRoot)` — exposed under the
 * wire-aligned name `readServiceStatus` for IPC `service-status` parity.
 */
export async function readServiceStatus(installRoot: string): Promise<ServiceStatusResult> {
  return buildStatusReport(installRoot);
}

/**
 * Read a single attached server's daemon state row plus the runners
 * currently running on it. Throws `StateReaderError("NOT_ATTACHED")` if
 * `serverId` is not in the attached set, or `"INVALID_ATTACHMENT"` if
 * the runner.state.json under that id is unreadable.
 */
export async function readRunnerStatus(
  installRoot: string,
  serverId: string,
): Promise<RunnerStatusResult> {
  const report: ComputerStatusReport = await buildStatusReport(installRoot);
  const server = report.servers.find((s) => s.serverId === serverId);
  if (!server) {
    throw new StateReaderError(
      "NOT_ATTACHED",
      `Server ${serverId} is not attached to this Computer.`,
    );
  }
  const attachment = await readServerAttachment(installRoot, serverId);
  if (!attachment) {
    throw new StateReaderError(
      "INVALID_ATTACHMENT",
      `Attachment for server ${serverId} is missing or invalid.`,
    );
  }
  const client = new RunnersClient(attachment.serverUrl, attachment.apiKey);
  const result = await client.list();
  if (result.status === "success") {
    return { status: "ok", server, whitelist: result.whitelist, runners: result.runners };
  }
  if (result.status === "unauthorized") {
    return { status: "unauthorized", server };
  }
  return { status: "error", server, code: result.code };
}

/**
 * List runners across attached servers. With no `serverId` filter,
 * returns one block per attached server (zero if no attachments). With
 * a `serverId` filter, returns exactly that server's block or throws
 * `StateReaderError("NOT_ATTACHED")`.
 *
 * Per-server discriminator preserves `unauthorized` / `error` outcomes
 * so consumers can pattern-match without losing context.
 */
export async function listRunners(
  installRoot: string,
  opts: { serverId?: string; all?: boolean } = {},
): Promise<ListRunnersResult> {
  const all = await listServerAttachments(installRoot);
  let subset = all;
  if (opts.serverId !== undefined) {
    const found = all.find((a) => a.serverId === opts.serverId);
    if (!found) {
      throw new StateReaderError(
        "NOT_ATTACHED",
        `Server ${opts.serverId} is not attached to this Computer.`,
      );
    }
    subset = [found];
  }

  const servers: RunnerListPerServer[] = [];
  for (const a of subset) {
    const client = new RunnersClient(a.serverUrl, a.apiKey);
    const result = await client.list({ all: opts.all });
    const idCols = { serverId: a.serverId, serverSlug: a.serverSlug ?? null };
    if (result.status === "success") {
      servers.push({
        ...idCols,
        status: "ok",
        whitelist: result.whitelist,
        runners: result.runners,
      });
    } else if (result.status === "unauthorized") {
      servers.push({ ...idCols, status: "unauthorized" });
    } else {
      servers.push({ ...idCols, status: "error", code: result.code });
    }
  }
  return { servers };
}
