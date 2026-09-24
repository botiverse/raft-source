// AttachService — Computer domain service for §6/§9 attach (RFC v0.8
// contract v3). CLI and Electron main are both adapters over this surface;
// the service itself never touches process.stdout / process.stderr /
// process.exit.
//
// Shape (Hao msg=51a17400 + liuliu msg=7a1a2c3d / 35034229):
//   - typed AttachInput + AttachOptions (onEvent best-effort + AbortSignal)
//   - typed AttachResult on success — SECRET-FREE (raw sk_computer_* lives
//     only in runner.state.json, mode 0o600); event + result carry only an
//     8-char `apiKeyRedactedPrefix` (mirrors adoption.log convention).
//   - typed `ComputerServiceError { code, message, cause? }` thrown on
//     failure; cause retained in-process only — adapters MUST NOT forward it.
//   - §6/§9 closed-set codes preserved BYTE-IDENTICAL: NO_USER_SESSION /
//     INVALID_USER_SESSION / ATTACH_NOT_AUTHORIZED / ATTACH_DISABLED /
//     ATTACH_SERVER_NOT_FOUND / USER_SESSION_EXPIRED / ATTACH_REQUEST_FAILED /
//     COMPUTER_NAME_COLLISION / ATTACH_FAILED / PREFLIGHT_FAILED.
//   - Fail-closed invariant: PREFLIGHT_FAILED leaves zero local-state residue
//     (runner.state.json written ONLY after preflight passes).
//   - AbortSignal honored before each network call. After the local-state
//     write commits, abort is a no-op (state is committed; service returns
//     normally).
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ComputerAttachClient } from "../apiClient.js";
import {
  deriveDefaultComputerName,
  serverAttachmentPath,
  userSessionPath,
} from "../paths.js";
import { formatServerSlugDisplay, normalizeServerSlug, resolveAttachedServerSlug } from "../serverState.js";
import { canonicalizeServerUrl, resolveServerUrl, resolveServerUrlEnv } from "../serverUrl.js";
import type { ComputerApiEvent } from "../lib/events.js";
import { ComputerServiceError } from "./errors.js";
import {
  ensureUsableUserSession,
  readUserSessionIdentity,
  refreshUserSession,
  type UserSessionIdentity,
} from "../lib/userSession.js";
import { accountUnavailableMessage } from "../accountUnavailable.js";

export interface AttachInput {
  serverSlug: string;
  serverUrl?: string;
  name?: string;
  /** The Computer install root to write the attachment under. Required: env
   *  resolution lives at `createComputerApi` construction, so mutations
   *  can't silently regress to ambient `~/.slock`. (#wg-raft-computer:f2a02081
   *  BUG 3 sweep.) */
  slockHome: string;
}

export interface AttachResult {
  serverId: string;
  serverMachineId: string;
  /** `machines.id` linked to this Computer (vs `serverMachineId` =
   *  `computers.id`). The dashboard's `/s/<slug>/computer/:machineId`
   *  resolves against this; the menu-bar's "Open This Computer in
   *  Browser" uses it. Optional when speaking to an older server that
   *  doesn't return it — downstream code MUST not assume present.
   *  Bug 2 in #wg-raft-computer:f2a02081 was caused by menu-bar
   *  using `serverMachineId` (== `computers.id`) here instead. */
  machineId?: string;
  serverSlug: string;
  serverUrl: string;
  attachmentPath: string;
  resumed: boolean;
  /** First 8 characters of the freshly-issued sk_computer_*; mirrors
   *  adoption.log redacted_prefix convention. The raw key lives only in
   *  runner.state.json (mode 0o600) — NEVER on this event/result. */
  apiKeyRedactedPrefix: string;
}

export interface AttachOptions {
  signal?: AbortSignal;
  onEvent?: (event: ComputerApiEvent) => void;
}

function emit(opts: AttachOptions | undefined, event: ComputerApiEvent): void {
  const cb = opts?.onEvent;
  if (!cb) return;
  try {
    cb(event);
  } catch {
    // onEvent is best-effort — never let a renderer/listener fault break
    // the attach flow.
  }
}

function attachNotAuthorizedMessage(
  slugForServer: string,
  slockHome: string,
  identity: UserSessionIdentity | null,
): string {
  return accountUnavailableMessage({
    serverLabel: formatServerSlugDisplay(slugForServer),
    serverSlug: slugForServer,
    slockHome,
    identity,
  });
}

export async function attach(input: AttachInput, options: AttachOptions = {}): Promise<AttachResult> {
  options.signal?.throwIfAborted?.();
  const { slockHome } = input;
  const slugForServer = normalizeServerSlug(input.serverSlug);
  if (!slugForServer) {
    throw new ComputerServiceError("ATTACH_NOT_AUTHORIZED", "Server slug must not be empty.");
  }

  const existing = await resolveAttachedServerSlug(slockHome, slugForServer);
  if (existing) {
    const explicitServerUrl = input.serverUrl?.trim();
    const requestedServerUrl = explicitServerUrl ? canonicalizeServerUrl(explicitServerUrl) : "";
    if (requestedServerUrl && requestedServerUrl !== existing.serverUrl) {
      throw new ComputerServiceError(
        "ATTACH_FAILED",
        `Existing local attachment for ${formatServerSlugDisplay(slugForServer)} points at ${existing.serverUrl}; ` +
          `refusing to use display name or slug to bind identity on ${requestedServerUrl}. ` +
          `Run \`raft-computer setup ${formatServerSlugDisplay(slugForServer)}\` to recover this Computer identity, or ask an admin to rebind it.`,
      );
    }

    emit(options, { kind: "attach.attaching", serverSlug: slugForServer });
    emit(options, { kind: "attach.preflight", resumed: true });
    options.signal?.throwIfAborted?.();
    const client = new ComputerAttachClient(existing.serverUrl, "");
    let pre: Awaited<ReturnType<ComputerAttachClient["preflight"]>>;
    try {
      pre = await client.preflight(existing.apiKey);
    } catch {
      pre = { ok: false as const, code: "request_failed" };
    }
    if (!pre.ok) {
      const detail =
        pre.code === "request_failed"
          ? `Network or server may be unavailable; not creating a fresh attachment. Retry later.`
          : `The saved Computer credential may be revoked or invalid; not creating a fresh attachment. ` +
            `Ask an admin to recover/rebind, then run \`raft-computer setup ${formatServerSlugDisplay(slugForServer)}\` again.`;
      throw new ComputerServiceError(
        "PREFLIGHT_FAILED",
        `Existing local attachment for ${formatServerSlugDisplay(slugForServer)} failed preflight (${pre.code}). ` +
          detail,
      );
    }

    const file = serverAttachmentPath(slockHome, existing.serverId);
    const apiKeyRedactedPrefix = existing.apiKey.slice(0, 8);
    const existingSlug = existing.serverSlug ?? slugForServer;
    emit(options, {
      kind: "attach.attached",
      serverId: existing.serverId,
      serverMachineId: existing.serverMachineId,
      serverSlug: existingSlug,
      attachmentPath: file,
      resumed: true,
      apiKeyRedactedPrefix,
    });
    return {
      serverId: existing.serverId,
      serverMachineId: existing.serverMachineId,
      ...(existing.machineId ? { machineId: existing.machineId } : {}),
      serverSlug: existingSlug,
      serverUrl: existing.serverUrl,
      attachmentPath: file,
      resumed: true,
      apiKeyRedactedPrefix,
    };
  }

  const sessionFile = userSessionPath(slockHome);

  let session = await ensureUsableUserSession(slockHome, input.serverUrl);
  if (session.status === "not_logged_in" && session.reason === "missing") {
    throw new ComputerServiceError(
      "NO_USER_SESSION",
      `No user session at ${sessionFile}. Run \`raft-computer login\` first.`,
    );
  }
  if (session.status === "not_logged_in" && session.reason === "invalid") {
    throw new ComputerServiceError(
      "INVALID_USER_SESSION",
      `User session at ${sessionFile} is invalid. Re-run \`raft-computer login\`.`,
    );
  }
  if (session.status === "not_logged_in") {
    throw new ComputerServiceError(
      "USER_SESSION_EXPIRED",
      "Your user session is no longer valid. Re-run `raft-computer login`.",
    );
  }

  const baseUrl = resolveServerUrl(input.serverUrl, session.serverUrl, resolveServerUrlEnv());
  const computerName = input.name?.trim() || deriveDefaultComputerName();

  options.signal?.throwIfAborted?.();
  emit(options, { kind: "attach.attaching", serverSlug: slugForServer });

  let client = new ComputerAttachClient(baseUrl, session.accessToken);
  let attached = await client.attach(slugForServer, computerName);
  if (attached.status === "error" && attached.code === "session_invalid") {
    if (await refreshUserSession(slockHome, baseUrl)) {
      session = await ensureUsableUserSession(slockHome, baseUrl);
      if (session.status === "usable") {
        client = new ComputerAttachClient(baseUrl, session.accessToken);
        attached = await client.attach(slugForServer, computerName);
      }
    }
  }

  if (attached.status === "disabled") {
    throw new ComputerServiceError(
      "ATTACH_DISABLED",
      "Computer attach is not enabled on this server (ask an admin to unset SLOCK_DEVICE_LOGIN_ENABLED or set it back to a non-false value; this surface is on by default since PR-G — upgrade the server if you are on an older build).",
    );
  }
  if (attached.status === "not_authorized") {
    throw new ComputerServiceError(
      "ATTACH_NOT_AUTHORIZED",
      attachNotAuthorizedMessage(slugForServer, slockHome, await readUserSessionIdentity(slockHome)),
    );
  }
  if (attached.status === "requires_admin") {
    throw new ComputerServiceError(
      "ATTACH_REQUIRES_ADMIN",
      "Attaching a Computer requires the admin or owner role on this server. You are a member, but only admins/owners can attach — ask a server admin to attach this Computer or to grant you the admin role.",
    );
  }
  if (attached.status === "server_not_found") {
    throw new ComputerServiceError(
      "ATTACH_SERVER_NOT_FOUND",
      `Server ${formatServerSlugDisplay(slugForServer)} was not found on ${baseUrl}. Check the slug spelling and --server-url, then retry.`,
    );
  }
  if (attached.status === "error") {
    if (attached.code === "session_invalid") {
      throw new ComputerServiceError(
        "USER_SESSION_EXPIRED",
        "Your user session is no longer valid. Re-run `raft-computer login`.",
      );
    }
    if (attached.code === "request_failed") {
      throw new ComputerServiceError(
        "ATTACH_REQUEST_FAILED",
        `Could not reach ${baseUrl} while attaching to ${formatServerSlugDisplay(slugForServer)}. Check --server-url / network connectivity, then retry.`,
      );
    }
    if (attached.code === "COMPUTER_NAME_COLLISION") {
      throw new ComputerServiceError(
        "COMPUTER_NAME_COLLISION",
        `A Computer named ${JSON.stringify(computerName)} already exists on that server. Run \`raft-computer attach ${formatServerSlugDisplay(slugForServer)} --name <uniqueName>\`.`,
      );
    }
    throw new ComputerServiceError(
      "ATTACH_FAILED",
      `Attach failed (${attached.code}). Re-run after checking --server-url / server version.`,
    );
  }

  // attached.status === "success" — sk_computer_* held in this binding only
  // for the preflight call below + the runner.state.json write. Event/result
  // payloads only ever carry the 8-char prefix.
  emit(options, { kind: "attach.preflight", resumed: attached.resumed });
  options.signal?.throwIfAborted?.();
  const pre = await client.preflight(attached.apiKey);
  if (!pre.ok) {
    throw new ComputerServiceError(
      "PREFLIGHT_FAILED",
      `Server preflight failed (${pre.code}). The server's Computer surface is not aligned; nothing was written locally. Upgrade the server or retry.`,
    );
  }

  // Preflight passed → commit local state (0600), per add-not-replace.
  const file = serverAttachmentPath(slockHome, attached.serverId);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify(
      {
        kind: "computer-attachment",
        serverId: attached.serverId,
        serverSlug: attached.serverSlug,
        serverMachineId: attached.serverMachineId,
        // `machines.id` (== `computers.machineId` link on the server); used
        // by `ServerStatusRow.machineId` so the menu-bar's
        // "Open This Computer in Browser" lands on a real dashboard row.
        // Optional: a pre-#99 server doesn't return it.
        ...(attached.machineId ? { machineId: attached.machineId } : {}),
        apiKey: attached.apiKey,
        serverUrl: baseUrl,
        attachedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  // writeFile mode only applies on create; force 0o600 on the resume
  // (overwrite) path too so a rotated credential never widens perms.
  await chmod(file, 0o600);

  const apiKeyRedactedPrefix = attached.apiKey.slice(0, 8);
  emit(options, {
    kind: "attach.attached",
    serverId: attached.serverId,
    serverMachineId: attached.serverMachineId,
    serverSlug: attached.serverSlug,
    attachmentPath: file,
    resumed: attached.resumed,
    apiKeyRedactedPrefix,
  });

  return {
    serverId: attached.serverId,
    serverMachineId: attached.serverMachineId,
    ...(attached.machineId ? { machineId: attached.machineId } : {}),
    serverSlug: attached.serverSlug,
    serverUrl: baseUrl,
    attachmentPath: file,
    resumed: attached.resumed,
    apiKeyRedactedPrefix,
  };
}
