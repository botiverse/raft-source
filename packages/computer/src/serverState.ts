// Per-server attachment state accessor (RFC v0.8 contract v4 §1/§10).
//
// A Computer (= one SLOCK_HOME) holds N independent per-server
// attachments under `computer/servers/<serverId>/`. This module is the
// single reader of that set — every aggregate surface (status, the
// service, doctor) lists/loads through here so the "one Computer
// manages all connections under its SLOCK_HOME" contract has exactly
// one implementation. Per-server isolation (§5): loading server X never
// reads server Y.
import { readFile, readdir, writeFile, mkdir, unlink, access, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { constants as fsConstants } from "node:fs";
import {
  isValidServerId,
  serversDir,
  serverAttachmentPath,
  legacyServerAttachmentPath,
  serverManagedFlagPath,
  CURRENT_SCHEMA_VERSION,
} from "./paths.js";
import { canonicalizeServerUrl, LEGACY_PRODUCTION_SERVER_URL } from "./serverUrl.js";

export interface ServerAttachment {
  kind: "computer-attachment";
  /**
   * On-disk schema version. Writers stamp CURRENT_SCHEMA_VERSION; readers
   * tolerate a missing value (existing deployed files have none) by treating
   * it as version 1 / current. Optional so old files still type-check.
   */
  schemaVersion?: number;
  serverId: string;
  serverSlug?: string;
  serverMachineId: string;
  /** Linked `machines.id` on the server (= `computers.machineId`); the
   *  field the dashboard's `/s/<slug>/computer/:machineId` route resolves
   *  against. Optional because pre-#99 servers and pre-#99 attachment
   *  files don't carry it. Consumers MUST treat absence as "fall back
   *  to opening the dashboard at server level" rather than emitting a
   *  link that 404s with the wrong id. */
  machineId?: string;
  apiKey: string;
  serverUrl: string;
  attachedAt?: string;
  adoptedFromLegacy?: boolean;
  legacyMachineId?: string;
  /** sha256(legacy api key).slice(0,16), used by new legacy daemons to
   * fail before relaunching a key already adopted by Computer. */
  legacyApiKeyFingerprint?: string;
}

export const STALE_STAGING_FLY_SERVER_URL = "https://slock-server-staging.fly.dev";
export const AWS_STAGING_SERVER_URL = "https://api-aws-staging.botiverse.dev";

/**
 * One-time endpoint migration for the staging Fly -> AWS cutover.
 *
 * Keep this deliberately narrow: it only rewrites the old staging Fly URL
 * after stripping trailing slashes. It must not normalize prod, unknown hosts,
 * or arbitrary user-provided server URLs.
 */
export function migrateKnownServerUrl(serverUrl: string): string {
  const canonical = canonicalizeServerUrl(serverUrl);
  return canonical === STALE_STAGING_FLY_SERVER_URL ? AWS_STAGING_SERVER_URL : canonical;
}

function isKnownStaleServerUrl(serverUrl: string): boolean {
  const trimmed = serverUrl.trim().replace(/\/+$/, "");
  return trimmed === STALE_STAGING_FLY_SERVER_URL || trimmed === LEGACY_PRODUCTION_SERVER_URL;
}

function parseAttachment(raw: string): ServerAttachment | null {
  try {
    const a = JSON.parse(raw) as Record<string, unknown>;
    if (
      a.kind === "computer-attachment" &&
      typeof a.serverId === "string" &&
      typeof a.serverMachineId === "string" &&
      typeof a.apiKey === "string" &&
      a.apiKey.length > 0 &&
      typeof a.serverUrl === "string"
    ) {
      // migrate-on-read: existing deployed files have no `schemaVersion`.
      // Default a missing value to CURRENT_SCHEMA_VERSION (treat as current,
      // NEVER reject). When CURRENT_SCHEMA_VERSION is bumped (>1), add the
      // migration here: when parsed.schemaVersion < CURRENT_SCHEMA_VERSION,
      // migrate the parsed shape before returning.
      const schemaVersion =
        typeof a.schemaVersion === "number" ? a.schemaVersion : CURRENT_SCHEMA_VERSION;
      return {
        kind: "computer-attachment",
        schemaVersion,
        serverId: a.serverId,
        serverSlug: typeof a.serverSlug === "string" && a.serverSlug.length > 0 ? a.serverSlug : undefined,
        serverMachineId: a.serverMachineId,
        machineId: typeof a.machineId === "string" && a.machineId.length > 0 ? a.machineId : undefined,
        apiKey: a.apiKey,
        serverUrl: migrateKnownServerUrl(a.serverUrl),
        attachedAt: typeof a.attachedAt === "string" ? a.attachedAt : undefined,
        adoptedFromLegacy: a.adoptedFromLegacy === true ? true : undefined,
        legacyMachineId: typeof a.legacyMachineId === "string" ? a.legacyMachineId : undefined,
        legacyApiKeyFingerprint:
          typeof a.legacyApiKeyFingerprint === "string" && a.legacyApiKeyFingerprint.length > 0
            ? a.legacyApiKeyFingerprint
            : undefined,
      };
    }
  } catch {
    /* fall through */
  }
  return null;
}

async function readAttachmentAt(path: string): Promise<ServerAttachment | null> {
  try {
    return parseAttachment(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Read one server's attachment, or null if absent/invalid.
 *
 * Dual-reads the canonical `runner.state.json` + the legacy `attachment.json`
 * and resolves a precedence-merge (see below). The legacy format only ever
 * existed on already-deployed computers attached with an older version, which
 * can carry the working credential in `attachment.json` while
 * `runner.state.json` holds a stale/fresh one (the prod 401 incident:
 * dropping the merge made this return the stale one → no valid `sk_computer_*`
 * → all requests 401 after an upgrade).
 *
 * MIGRATE-ON-READ (pre-release hardening): once the effective attachment is
 * resolved, if the legacy file decided it (legacy was chosen, OR
 * runner.state.json was absent), we write the effective attachment to the
 * canonical `runner.state.json` and best-effort delete the legacy
 * `attachment.json`, so subsequent reads are canonical-only. The migration is
 * idempotent and best-effort — wrapped in try/catch so a write/unlink failure
 * NEVER changes the returned value. The read still returns the correct
 * precedence-resolved attachment even if the migration write/unlink fails.
 */
export async function readServerAttachment(
  slockHome: string,
  serverId: string,
): Promise<ServerAttachment | null> {
  if (!isValidServerId(serverId)) return null;
  const currentPath = serverAttachmentPath(slockHome, serverId);
  const legacyPath = legacyServerAttachmentPath(slockHome, serverId);
  const current = await readAttachmentAt(currentPath);
  const legacy = await readAttachmentAt(legacyPath);
  const currentNeedsEndpointMigration = await attachmentAtPathNeedsEndpointMigration(currentPath);

  // Resolve the effective attachment + whether the legacy file decided it.
  let effective: ServerAttachment | null;
  let decidedByLegacy: boolean;
  if (!current) {
    // runner.state.json absent → legacy decides (may itself be null).
    effective = legacy;
    decidedByLegacy = legacy !== null;
  } else if (!legacy) {
    effective = current;
    decidedByLegacy = false;
  } else if (
    // Adopted-machine-still-wins: when the legacy attachment is an adopted
    // (working) machine and the current one is a different, not-adopted machine
    // (e.g. a fresh attach that the server rejects), prefer the legacy creds.
    legacy.adoptedFromLegacy === true &&
    current.adoptedFromLegacy !== true &&
    legacy.serverMachineId !== current.serverMachineId
  ) {
    effective = legacy;
    decidedByLegacy = true;
  } else {
    effective = current;
    decidedByLegacy = false;
  }

  // Migrate-then-remove the legacy file when it decided the effective value.
  // Best-effort + idempotent: any failure leaves the (still-correct) return
  // value untouched; the next read simply migrates again.
  if (decidedByLegacy && effective) {
    try {
      await writeServerAttachment(slockHome, effective);
      await unlink(legacyPath);
    } catch {
      /* ENOENT-tolerant + non-fatal: a failed migration must NEVER break the
         read. The correct effective attachment is still returned below. */
    }
  }

  if (!decidedByLegacy && effective && currentNeedsEndpointMigration) {
    try {
      await writeServerAttachment(slockHome, effective);
    } catch {
      /* Best-effort endpoint self-heal. A write failure must not break reading
         the migrated in-memory attachment; the next read will retry. */
    }
  }

  return effective;
}

async function attachmentAtPathNeedsEndpointMigration(path: string): Promise<boolean> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as { serverUrl?: unknown };
    return typeof parsed.serverUrl === "string" && isKnownStaleServerUrl(parsed.serverUrl);
  } catch {
    return false;
  }
}

/** Rewrite one runner.state.json while preserving the serverId-keyed path. */
export async function writeServerAttachment(
  slockHome: string,
  attachment: ServerAttachment,
): Promise<void> {
  if (!isValidServerId(attachment.serverId)) return;
  const path = serverAttachmentPath(slockHome, attachment.serverId);
  await mkdir(dirname(path), { recursive: true });
  // Stamp the current on-disk schema version on every write.
  const stamped: ServerAttachment = { ...attachment, schemaVersion: CURRENT_SCHEMA_VERSION };
  await writeFile(path, JSON.stringify(stamped, null, 2), { mode: 0o600 });
  await chmod(path, 0o600);
}

/**
 * The serverIds this Computer is attached to (a valid-UUID subdir of
 * `servers/` that contains a parseable runner.state.json). Sorted for
 * stable output. Never throws — a missing `servers/` dir = [].
 */
export async function listAttachedServerIds(slockHome: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(serversDir(slockHome));
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const name of entries) {
    if (!isValidServerId(name)) continue;
    if (await readServerAttachment(slockHome, name)) ids.push(name);
  }
  return ids.sort();
}

/** All attachments, in stable serverId order. */
export async function listServerAttachments(slockHome: string): Promise<ServerAttachment[]> {
  const ids = await listAttachedServerIds(slockHome);
  const out: ServerAttachment[] = [];
  for (const id of ids) {
    const a = await readServerAttachment(slockHome, id);
    if (a) out.push(a);
  }
  return out;
}

/**
 * Normalize a user-supplied server-slug input. The canonical user-facing
 * mental model is `/<slug>` (parallel to `@<handle>` for personal-server
 * namespace, locked tygg msg=1dbc346d / Jianwei msg=8e9116d7 in
 * `#wg-raft-computer:a0997b57`). The CLI accepts both `/aa` and `aa`;
 * stored slug is the bare form (matches `servers.slug` in the DB).
 *
 * Strips at most ONE leading `/` plus surrounding whitespace. Multiple
 * slashes / a full URL path are not a compatibility input — those fail
 * the lookup downstream. Returns `""` when the input is empty/blank.
 */
export function normalizeServerSlug(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
}

/** Render a slug in the canonical `/<slug>` form for help text and errors. */
export function formatServerSlugDisplay(slug: string | null | undefined): string {
  if (!slug) return "(unknown slug; re-run attach or doctor)";
  return slug.startsWith("/") ? slug : `/${slug}`;
}

/**
 * Resolve a user-facing server slug to the canonical serverId stored on
 * disk. Disk layout remains `servers/<serverId>/` so a server rename does
 * not move local credential/pid/log state. We intentionally do NOT accept
 * UUIDs as compatibility aliases here; the CLI surface is slug-only.
 *
 * Both `/aa` and `aa` resolve to the same attachment via `normalizeServerSlug`.
 */
export async function resolveAttachedServerSlug(
  slockHome: string,
  serverSlug: string,
): Promise<ServerAttachment | null> {
  const requested = normalizeServerSlug(serverSlug);
  if (!requested) return null;
  const attachments = await listServerAttachments(slockHome);
  return attachments.find((a) => a.serverSlug === requested) ?? null;
}

// --- managed-flag state (contract v4 §6 line 80) ---
//
// The service reconciles its set of daemon children against the set
// of server IDs that have BOTH an attachment AND a managed.flag file.
// `attach` establishes the credential without setting managed. `start <server>`
// sets managed for that server without clearing other managed servers; `start`
// without a server sets managed for all attached servers. `stop` clears managed
// without removing the attachment or server identity.

/** Set the managed-flag for a server. Caller must ensure the server dir
 * exists (typically via attach). Idempotent: writing twice is OK. */
export async function setServerManaged(slockHome: string, serverId: string): Promise<void> {
  if (!isValidServerId(serverId)) return;
  const flagPath = serverManagedFlagPath(slockHome, serverId);
  await mkdir(dirname(flagPath), { recursive: true });
  await writeFile(flagPath, "", { mode: 0o600 });
}

/** Clear the managed-flag for a server. Idempotent: missing file is fine. */
export async function clearServerManaged(slockHome: string, serverId: string): Promise<void> {
  if (!isValidServerId(serverId)) return;
  try {
    await unlink(serverManagedFlagPath(slockHome, serverId));
  } catch {
    /* already cleared */
  }
}

/** True iff the managed-flag file exists for that server. */
export async function isServerManaged(slockHome: string, serverId: string): Promise<boolean> {
  if (!isValidServerId(serverId)) return false;
  try {
    await access(serverManagedFlagPath(slockHome, serverId), fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** The serverIds that are both attached AND managed — i.e., the set the
 * service should keep daemons running for. Sorted for stable output. */
export async function listManagedServerIds(slockHome: string): Promise<string[]> {
  const attached = await listAttachedServerIds(slockHome);
  const out: string[] = [];
  for (const id of attached) {
    if (await isServerManaged(slockHome, id)) out.push(id);
  }
  return out;
}
