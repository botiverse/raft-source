// Attach by one-time approval (device-auth design v2 §3.1/§3.2): this machine
// joins one server with a single approval instead of a user session.
//
//   1. POST /api/auth/device/authorize with `grant: { kind: "computer_attach",
//      machineName, hostname, os }`; the person types the code on the approval
//      page and picks the server there.
//   2. The token poll answers with a single-use `dvat_*` attach token for that
//      server — never a session.
//   3. POST /api/computer/attach with `Authorization: Bearer dvat_*`; the
//      server takes the server and the machine name from the approval.
//   4. The existing preflight + runner.state.json (0600) commit.
//
// Nothing here writes user-session.json, and the attach token lives only in
// this call: it is never written, logged, put on an event or in an error.
//
// Older servers (before one-time grants) ignore `grant` and answer the poll
// with a device session. That answer is told apart by its shape (no
// `kind: "computer_attach"` + `dvat_*` token, an `accessToken` instead), and
// then this machine does what `login` + `attach` did before: write the
// session and attach with it.
import { hostname as osHostname } from "node:os";

import { ATTACH_TOKEN_PREFIX, ComputerAttachClient, type AttachResult as AttachClientResult, type ComputerAttachGrantRequest } from "../apiClient";
import { deriveDefaultComputerName, isValidServerId } from "../paths";
import {
  formatServerSlugDisplay,
  normalizeServerSlug,
  readServerAttachment,
  resolveAttachedServerSlug,
} from "../serverState";
import { canonicalizeServerUrl, resolveServerUrl, resolveServerUrlEnv } from "../serverUrl";
import { readUserSessionAuth } from "../lib/userSession";
import { ComputerServiceError } from "./errors";
import {
  attach as attachWithUserSession,
  commitAttachment,
  emitAttachEvent,
  resumeExistingAttachment,
  type AttachOptions,
  type AttachResult,
} from "./attach";
import { lostConnectionMessage, persistUserSession, runDeviceAuthorization } from "./login";

export interface AttachWithApprovalInput {
  /** The server to attach to. The person picks it on the approval page; an
   *  approval for any other server is refused before it is used. */
  serverSlug: string;
  serverUrl?: string;
  name?: string;
  /** The Computer install root (resolved once at `createComputerApi`). */
  slockHome: string;
  /** The command a failure message tells the person to run again (setup
   *  passes its own); defaults to `raft-computer attach <server>`. */
  retryCommand?: string;
}

export type ApproveMachineResult =
  | ({ outcome: "attached" } & AttachResult)
  /** Only without a server slug, on a server older than one-time grants: it
   *  gave a user session, which was written like `login` used to. */
  | { outcome: "signed-in"; userId: string; sessionPath: string; serverUrl: string };

/** The OS label the approval page shows next to the machine name. */
export function approvalOsLabel(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return "macOS";
  if (platform === "win32") return "Windows";
  if (platform === "linux") return "Linux";
  return platform;
}

function retryCommand(slug: string | null): string {
  return `raft-computer attach ${slug ? formatServerSlugDisplay(slug) : "/<server>"}`;
}

/**
 * `raft-computer attach <server>` (and setup's attach step): attach this
 * machine to one server through a one-time approval. An existing local
 * attachment for that server is resumed (preflight only) without asking.
 */
export async function attachWithApproval(
  input: AttachWithApprovalInput,
  options: AttachOptions = {},
): Promise<AttachResult> {
  const result = await approveMachine(input, options);
  if (result.outcome !== "attached") {
    // approveMachine only signs in without a slug.
    throw new ComputerServiceError("ATTACH_FAILED", `Attach failed (no_server). Run \`${retryCommand(null)}\`.`);
  }
  const { outcome: _outcome, ...attached } = result;
  return attached;
}

/**
 * The approval flow, with or without a server slug. Without one (the old
 * `raft-computer login`), the server picked on the approval page is the one
 * attached.
 */
export async function approveMachine(
  input: Omit<AttachWithApprovalInput, "serverSlug"> & { serverSlug?: string },
  options: AttachOptions = {},
): Promise<ApproveMachineResult> {
  options.signal?.throwIfAborted?.();
  const { slockHome } = input;
  let requestedSlug: string | null = null;
  if (input.serverSlug !== undefined) {
    requestedSlug = normalizeServerSlug(input.serverSlug);
    if (!requestedSlug) {
      throw new ComputerServiceError("ATTACH_NOT_AUTHORIZED", "Server slug must not be empty.");
    }
    // Already attached: resume from local state, exactly as before (the
    // session attach checks --server-url against the saved attachment and
    // runs the preflight; it never reads the user session on that path). No
    // approval is asked for.
    if (await resolveAttachedServerSlug(slockHome, requestedSlug)) {
      const resumed = await attachWithUserSession(
        { serverSlug: requestedSlug, ...(input.serverUrl ? { serverUrl: input.serverUrl } : {}), slockHome },
        options,
      );
      return { outcome: "attached", ...resumed };
    }
  }

  // The saved session (if any, from an older `login`) is read for its server
  // URL only, never refreshed or written here.
  const baseUrl = resolveServerUrl(input.serverUrl, (await readUserSessionAuth(slockHome)).serverUrl, resolveServerUrlEnv());
  const computerName = input.name?.trim() || deriveDefaultComputerName();
  const grant: ComputerAttachGrantRequest = {
    kind: "computer_attach",
    machineName: computerName,
    hostname: osHostname(),
    os: approvalOsLabel(),
  };
  const retry = input.retryCommand ?? retryCommand(requestedSlug);

  const r = await runDeviceAuthorization(baseUrl, grant, options);
  if (r.status === "denied") {
    throw new ComputerServiceError(
      "ATTACH_APPROVAL_DENIED",
      `This machine was not approved: it was denied on the page, or the approval can no longer be used. Nothing was changed. Run \`${retry}\` to ask again.`,
    );
  }
  if (r.status === "expired") {
    throw new ComputerServiceError(
      "ATTACH_APPROVAL_EXPIRED",
      `The code expired before this machine was approved. Nothing was changed. Run \`${retry}\` for a new code.`,
    );
  }
  if (r.status === "unreachable") {
    throw new ComputerServiceError("ATTACH_APPROVAL_FAILED", lostConnectionMessage(baseUrl, r.cause, retry, "Nothing was changed."), r.cause);
  }
  if (r.status === "error") {
    if (r.code === "device_code_consumed") {
      // Only this machine holds the device code: the server consumed it for
      // an earlier poll of ours whose answer never arrived.
      throw new ComputerServiceError(
        "ATTACH_APPROVAL_USED",
        `This code was already used: it was approved, but the server's answer was lost on the network before it reached this machine. Nothing was changed. Run \`${retry}\` for a new code.`,
      );
    }
    throw new ComputerServiceError(
      "ATTACH_APPROVAL_FAILED",
      `The approval did not complete (${r.code}). Nothing was changed. Run \`${retry}\` to try again.`,
    );
  }

  if (r.status === "success") {
    // Older server: no one-time grants, it gave a device session. Do what
    // `login` + `attach` did before.
    const sessionPath = await persistUserSession(slockHome, baseUrl, r);
    emitAttachEvent(options, { kind: "attach.session-fallback", sessionPath });
    if (!requestedSlug) {
      return { outcome: "signed-in", userId: r.userId, sessionPath, serverUrl: baseUrl };
    }
    const attached = await attachWithUserSession(
      { serverSlug: requestedSlug, ...(input.serverUrl ? { serverUrl: input.serverUrl } : {}), ...(input.name ? { name: input.name } : {}), slockHome },
      options,
    );
    return { outcome: "attached", ...attached };
  }

  if (r.status === "migrate_token") {
    // This flow asked for an attach grant: another kind's token is never used.
    throw new ComputerServiceError(
      "ATTACH_APPROVAL_FAILED",
      `The approval did not complete (unexpected_response). Nothing was changed. Run \`${retry}\` to try again.`,
    );
  }

  // r.status === "attach_token": a single-use token for the server the person
  // picked. It stays in this binding only.
  const approvedSlug = normalizeServerSlug(r.serverSlug);
  if (requestedSlug && approvedSlug !== requestedSlug) {
    throw new ComputerServiceError(
      "ATTACH_APPROVAL_SERVER_MISMATCH",
      `This machine was approved for ${formatServerSlugDisplay(approvedSlug)}, not ${formatServerSlugDisplay(requestedSlug)}. Nothing was changed. Run \`${retry}\` and choose ${formatServerSlugDisplay(requestedSlug)} on the page.`,
    );
  }
  return { outcome: "attached", ...(await attachWithIssuedToken(
    { baseUrl, attachToken: r.attachToken, serverId: r.serverId, serverSlug: approvedSlug, computerName, slockHome, retry },
    options,
  )) };
}

/**
 * The steps after a `dvat_*` attach token is in hand, shared by the approval
 * flow above and by Raft Desktop (`attachWithToken`): resume an attachment
 * this machine already has for that server (the token is left unused and
 * expires on its own), otherwise attach with the token as the bearer and
 * commit runner.state.json. The token is never written, logged or put on an
 * event or an error.
 */
async function attachWithIssuedToken(
  input: { baseUrl: string; attachToken: string; serverId: string; serverSlug: string; computerName: string; slockHome: string; retry: string },
  options: AttachOptions,
): Promise<AttachResult> {
  const { baseUrl, serverId, serverSlug, computerName, slockHome, retry } = input;
  // Never replace an attachment this machine already has for that server: a
  // fresh attach would orphan that Computer identity. Resume it instead and
  // leave the token unused (it expires on its own).
  const existingForServer = await readServerAttachment(slockHome, serverId);
  if (existingForServer) {
    return resumeExistingAttachment(existingForServer, existingForServer.serverSlug ?? serverSlug, slockHome, options);
  }

  options.signal?.throwIfAborted?.();
  emitAttachEvent(options, { kind: "attach.attaching", serverSlug });
  const client = new ComputerAttachClient(baseUrl, input.attachToken);
  // The server takes the machine name from the approval; the slug, when
  // sent, must name the approved server.
  const attached = await client.attach(serverSlug, computerName);
  if (attached.status !== "success") {
    throw approvalAttachFailure(attached, serverSlug, computerName, baseUrl, retry);
  }
  if (attached.serverId !== serverId) {
    throw new ComputerServiceError(
      "ATTACH_FAILED",
      `Attach failed (server_mismatch): the server answered for another server. Nothing was written locally. Run \`${retry}\` to try again.`,
    );
  }
  return commitAttachment(client, attached, baseUrl, slockHome, options);
}

export interface AttachWithTokenInput {
  /** The server the token was approved for, as the token answer named it. */
  serverSlug: string;
  /** Its id, as the token answer named it: the attach answer must match. */
  serverId: string;
  serverUrl: string;
  /** The single-use `dvat_*` token from `POST /api/auth/device/token`. */
  attachToken: string;
  /** The machine name the approval was asked for (the server uses the approval's). */
  name?: string;
  slockHome: string;
}

/**
 * Raft Desktop: attach with a `dvat_*` token the app obtained itself (it ran
 * the device flow and approved it with its own web session after the person
 * confirmed in the app). No user session is read or written here.
 */
export async function attachWithToken(input: AttachWithTokenInput, options: AttachOptions = {}): Promise<AttachResult> {
  options.signal?.throwIfAborted?.();
  const slug = normalizeServerSlug(input.serverSlug);
  const retry = retryCommand(slug || null);
  if (
    !slug ||
    typeof input.attachToken !== "string" ||
    !input.attachToken.startsWith(ATTACH_TOKEN_PREFIX) ||
    input.attachToken.length <= ATTACH_TOKEN_PREFIX.length ||
    typeof input.serverId !== "string" ||
    // A server id names a local directory (servers/<id>/): only a UUID.
    !isValidServerId(input.serverId) ||
    typeof input.serverUrl !== "string" ||
    input.serverUrl.trim().length === 0
  ) {
    // Never echo the input: it carries the token.
    throw new ComputerServiceError("ATTACH_APPROVAL_FAILED", `The approval did not complete (invalid_attach_token_input). Nothing was changed. Run \`${retry}\` to try again.`);
  }
  const baseUrl = canonicalizeServerUrl(input.serverUrl);
  return attachWithIssuedToken(
    {
      baseUrl,
      attachToken: input.attachToken,
      serverId: input.serverId,
      serverSlug: slug,
      computerName: input.name?.trim() || deriveDefaultComputerName(),
      slockHome: input.slockHome,
      retry,
    },
    options,
  );
}

function approvalAttachFailure(
  attached: Exclude<AttachClientResult, { status: "success" }>,
  slug: string,
  computerName: string,
  baseUrl: string,
  retry: string,
): ComputerServiceError {
  const label = formatServerSlugDisplay(slug);
  if (attached.status === "disabled") {
    return new ComputerServiceError(
      "ATTACH_DISABLED",
      "Computer attach is not enabled on this server (ask an admin to unset SLOCK_DEVICE_LOGIN_ENABLED or set it back to a non-false value; this surface is on by default since PR-G — upgrade the server if you are on an older build).",
    );
  }
  if (attached.status === "requires_admin") {
    return new ComputerServiceError(
      "ATTACH_REQUIRES_ADMIN",
      `The account that approved this machine can no longer add Computers to ${label}: that needs the admin or owner role. Nothing was changed. Run \`${retry}\` and have an admin or owner approve it.`,
    );
  }
  if (attached.status === "not_authorized" || attached.status === "server_not_found") {
    return new ComputerServiceError(
      "ATTACH_NOT_AUTHORIZED",
      `The account that approved this machine can no longer add Computers to ${label} (it is not a member, or the server is gone). Nothing was changed. Run \`${retry}\` and approve it with an account that can.`,
    );
  }
  if (attached.code.startsWith("attach_token_") || attached.code === "session_invalid") {
    return new ComputerServiceError(
      "ATTACH_APPROVAL_REJECTED",
      `The server did not accept this approval (${attached.code === "session_invalid" ? "attach_token_invalid" : attached.code}). Nothing was changed. Run \`${retry}\` to approve this machine again.`,
    );
  }
  if (attached.code === "request_failed") {
    return new ComputerServiceError(
      "ATTACH_REQUEST_FAILED",
      `Could not reach ${baseUrl} while attaching to ${label}. Check --server-url / network connectivity, then run \`${retry}\` again.`,
    );
  }
  if (attached.code === "COMPUTER_NAME_COLLISION") {
    return new ComputerServiceError(
      "COMPUTER_NAME_COLLISION",
      `A Computer named ${JSON.stringify(computerName)} already exists on that server. Run \`raft-computer attach ${label} --name <uniqueName>\`.`,
    );
  }
  return new ComputerServiceError(
    "ATTACH_FAILED",
    `Attach failed (${attached.code}). Re-run after checking --server-url / server version.`,
  );
}
