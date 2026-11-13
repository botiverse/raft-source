// Approval for moving this machine's old Raft daemon over (`raft-computer
// setup`'s legacy-daemon migration branch), device-auth design v2: a one-time
// `computer_migrate` grant instead of a user session.
//
//   1. POST /api/auth/device/authorize with `grant: { kind: "computer_migrate",
//      machineName, hostname, os }`; the person types the code on the approval
//      page and picks the server there.
//   2. The token poll answers with a `dvmt_*` migrate token for that server —
//      never a session. Setup uses it as the bearer of the legacy roster
//      (GET /api/computer/legacy-machines) and of the one adoption
//      (POST /api/computer/adopt-legacy); the server accepts it nowhere else.
//
// Nothing here writes user-session.json, and the migrate token lives only in
// memory: it is never written, logged, put on an event or in an error.
//
// Older servers:
//   - one with one-time grants but not this kind refuses the grant at
//     authorize (400 grant_invalid / grant_kind_unsupported): reported as
//     `grant-unsupported`, and setup signs in with a user session as before;
//   - one from before one-time grants ignores `grant` and answers the poll
//     with a device session: written as `login` used to (`session`).
// A current server never answers either way to this request.
import { hostname as osHostname } from "node:os";

import { DeviceGrantRejectedError, type ComputerMigrateGrantRequest } from "../apiClient";
import { deriveDefaultComputerName } from "../paths";
import { formatServerSlugDisplay, normalizeServerSlug } from "../serverState";
import { resolveServerUrl, resolveServerUrlEnv } from "../serverUrl";
import { readUserSessionAuth } from "../lib/userSession";
import { ComputerServiceError } from "./errors";
import { approvalOsLabel } from "./attachGrant";
import { lostConnectionMessage, persistUserSession, runDeviceAuthorization, type LoginOptions } from "./login";

export interface MigrateApprovalInput {
  /** The server whose old daemon moves over; an approval for another server is refused. */
  serverSlug: string;
  serverUrl?: string;
  name?: string;
  slockHome: string;
  /** The command a failure message tells the person to run again. */
  retryCommand: string;
}

/** A `dvmt_*` migrate token for one server, held in memory only. */
export interface MigrateCredential {
  baseUrl: string;
  migrateToken: string;
  serverId: string;
  serverSlug: string;
}

export type MigrateApprovalResult =
  | { outcome: "approved"; credential: MigrateCredential }
  /** A server with one-time grants but not this kind: nothing was started there. */
  | { outcome: "grant-unsupported"; baseUrl: string }
  /** A server from before one-time grants gave a device session: written to user-session.json as `login` did. */
  | { outcome: "session"; baseUrl: string; sessionPath: string };

export async function requestMigrateApproval(
  input: MigrateApprovalInput,
  options: LoginOptions = {},
): Promise<MigrateApprovalResult> {
  options.signal?.throwIfAborted?.();
  const requestedSlug = normalizeServerSlug(input.serverSlug);
  // The saved session (if any, from an older `login`) is read for its server
  // URL only.
  const baseUrl = resolveServerUrl(input.serverUrl, (await readUserSessionAuth(input.slockHome)).serverUrl, resolveServerUrlEnv());
  const grant: ComputerMigrateGrantRequest = {
    kind: "computer_migrate",
    machineName: input.name?.trim() || deriveDefaultComputerName(),
    hostname: osHostname(),
    os: approvalOsLabel(),
  };
  const retry = input.retryCommand;

  let r: Awaited<ReturnType<typeof runDeviceAuthorization>>;
  try {
    r = await runDeviceAuthorization(baseUrl, grant, options);
  } catch (err) {
    if (err instanceof ComputerServiceError && err.cause instanceof DeviceGrantRejectedError) {
      return { outcome: "grant-unsupported", baseUrl };
    }
    throw err;
  }
  if (r.status === "denied") {
    throw new ComputerServiceError(
      "MIGRATE_APPROVAL_DENIED",
      `Moving the old daemon over was not approved: it was denied on the page, or the approval can no longer be used. Nothing was changed. Run \`${retry}\` to ask again.`,
    );
  }
  if (r.status === "expired") {
    throw new ComputerServiceError(
      "MIGRATE_APPROVAL_EXPIRED",
      `The code expired before it was approved. Nothing was changed. Run \`${retry}\` for a new code.`,
    );
  }
  if (r.status === "unreachable") {
    throw new ComputerServiceError("MIGRATE_APPROVAL_FAILED", lostConnectionMessage(baseUrl, r.cause, retry, "Nothing was changed."), r.cause);
  }
  if (r.status === "error") {
    if (r.code === "device_code_consumed") {
      throw new ComputerServiceError(
        "MIGRATE_APPROVAL_USED",
        `This code was already used: it was approved, but the server's answer was lost on the network before it reached this machine. Nothing was changed. Run \`${retry}\` for a new code.`,
      );
    }
    throw new ComputerServiceError(
      "MIGRATE_APPROVAL_FAILED",
      `The approval did not complete (${r.code}). Nothing was changed. Run \`${retry}\` to try again.`,
    );
  }
  if (r.status === "attach_token") {
    throw new ComputerServiceError(
      "MIGRATE_APPROVAL_FAILED",
      `The approval did not complete (unexpected_response). Nothing was changed. Run \`${retry}\` to try again.`,
    );
  }
  if (r.status === "success") {
    // A server from before one-time grants: it gave a device session.
    const sessionPath = await persistUserSession(input.slockHome, baseUrl, r);
    return { outcome: "session", baseUrl, sessionPath };
  }

  // r.status === "migrate_token": for the server the person picked.
  const approvedSlug = normalizeServerSlug(r.serverSlug);
  if (approvedSlug !== requestedSlug) {
    throw new ComputerServiceError(
      "MIGRATE_APPROVAL_SERVER_MISMATCH",
      `This was approved for ${formatServerSlugDisplay(approvedSlug)}, not ${formatServerSlugDisplay(requestedSlug)}. Nothing was changed. Run \`${retry}\` and choose ${formatServerSlugDisplay(requestedSlug)} on the page.`,
    );
  }
  return {
    outcome: "approved",
    credential: { baseUrl, migrateToken: r.migrateToken, serverId: r.serverId, serverSlug: approvedSlug },
  };
}
