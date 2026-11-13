// `raft proc`: the daemon's proc routes (shared daemonApiContract `proc*`),
// reached through the managed runner's credential proxy as the calling
// agent's live launch. Every command first lists the agent's jobs: only a
// daemon that runs jobs answers that itself (`capability: "proc@1"`). An
// older daemon forwards the path to the Server, so the CLI says so before it
// would ever send a start (whose body carries its environment) there.
import { PROC_CAPABILITY, isValidProcName, PROC_NAME_PATTERN } from "@botiverse/raft-shared/src/agentCliSurface";
import type { DaemonApiResponseByRoute } from "@botiverse/raft-shared";

import type { ApiResponse } from "../../client";
import type { CommandContext } from "../../core/context";
import { CliError, type CliErrorCode } from "../../core/errors";
import { createDaemonApiSurfaceClient } from "../../daemonApiPath";
import {
  PROC_UNSUPPORTED_OLDER_DAEMON,
  PROC_UNSUPPORTED_PLATFORM,
  PROC_UNSUPPORTED_UNMANAGED,
} from "./_format";

export type ProcApi = ReturnType<typeof createDaemonApiSurfaceClient>["proc"];
export type ProcListing = DaemonApiResponseByRoute["procList"];

function unsupported(message: string): CliError {
  return new CliError({ code: "PROC_UNSUPPORTED", message });
}

/** The daemon's proc API and the agent's jobs, or the refusal for a daemon that runs none. */
export async function openProcApi(ctx: CommandContext): Promise<{ api: ProcApi; listing: ProcListing }> {
  const agentContext = ctx.loadAgentContext();
  if (agentContext.clientMode !== "managed-runner") throw unsupported(PROC_UNSUPPORTED_UNMANAGED);
  const api = createDaemonApiSurfaceClient(ctx.createApiClient(agentContext)).proc;
  let res: ApiResponse<ProcListing>;
  try {
    res = await api.list();
  } catch (err) {
    // A forwarded answer that is not the daemon's listing (an older daemon).
    if (err instanceof CliError && err.code === "INVALID_JSON_RESPONSE") throw unsupported(PROC_UNSUPPORTED_OLDER_DAEMON);
    throw err;
  }
  if (res.ok && res.data?.capability === PROC_CAPABILITY) return { api, listing: res.data };
  if (!res.ok && res.status === 501 && res.errorCode === "proc_unsupported") throw unsupported(PROC_UNSUPPORTED_PLATFORM);
  if (res.ok || res.status === 404 || res.status === 405 || res.status === 501) throw unsupported(PROC_UNSUPPORTED_OLDER_DAEMON);
  throw procFailure(res);
}

const CODES: Record<string, CliErrorCode> = {
  proc_invalid_name: "PROC_INVALID_NAME",
  proc_name_taken: "PROC_NAME_TAKEN",
  proc_limit: "PROC_LIMIT",
  proc_not_found: "PROC_NOT_FOUND",
  proc_scope_unconfirmed: "PROC_SCOPE_UNCONFIRMED",
  proc_runtime_restricted: "PROC_RUNTIME_RESTRICTED",
};

/** A refusal from the daemon: its sentence, which already names the next step. */
export function procFailure(res: ApiResponse<unknown>): CliError {
  return new CliError({
    code: (res.errorCode && CODES[res.errorCode]) || "PROC_FAILED",
    message: res.error ?? `HTTP ${res.status}`,
  });
}

/** A job name given on the command line. */
export function requireProcName(name: unknown, usage: string): string {
  if (isValidProcName(name)) return name;
  throw new CliError({
    code: "PROC_INVALID_NAME",
    message: `A job name matches ${PROC_NAME_PATTERN.source} (letters, digits, - and _, at most 40); got ${JSON.stringify(String(name ?? ""))}. ${usage}`,
  });
}
