// Data export (#triage:#512, design v7): what the server and its clients
// share about an export job. Two kinds: `personal` (any person, their own
// data, in some or all of their servers) and `server` (an owner, the
// server's public channels). The job lifecycle, limits and routes are the
// server's (services/dataExport/, docs/development/data-export.md); what an
// archive holds is each kind's producer's (personal: the server's personalProducer.ts).
import type { Brand } from "./brandedIds";

// The flag, data_export_v0, is declared in featureFlags.ts with the other keys.

export type DataExportId = Brand<string, "DataExportId">;
/** Brand at the boundary: a validated route param or a row read back. */
export const asDataExportId = (id: string): DataExportId => id as DataExportId;

export const DATA_EXPORT_KINDS = ["personal", "server"] as const;
export type DataExportKind = (typeof DATA_EXPORT_KINDS)[number];

/**
 * queued -> running -> ready -> expired (retention over: objects deleted, row kept)
 *                   -> failed (not counted against the limits)
 * any of queued, running, ready -> deleted (the requester, or an account or server deletion)
 */
export const DATA_EXPORT_STATUSES = ["queued", "running", "ready", "failed", "expired", "deleted"] as const;
export type DataExportStatus = (typeof DATA_EXPORT_STATUSES)[number];
export const DATA_EXPORT_IN_FLIGHT_STATUSES = ["queued", "running"] as const satisfies readonly DataExportStatus[];

/**
 * A personal export: the person's own messages, files and account data in
 * `serverIds` (or every server they belong to). `includeContext` adds the
 * other people's messages of the conversations the person can see now
 * (decision 2, off by default, only where the server's owner allows it).
 */
export interface PersonalDataExportScope {
  serverIds: string[] | "all";
  includeContext: boolean;
  includeFiles: boolean;
}

/**
 * A server export: the server's public channels (decision 1). Free plan:
 * the last 30 days. `fullHistoryAfterClose`: the whole history, the same
 * channels, asked only between the server's close and its purge (design §5).
 */
export interface ServerDataExportScope {
  includeFiles: boolean;
  fullHistoryAfterClose: boolean;
}

export type DataExportScope = PersonalDataExportScope | ServerDataExportScope;
export type DataExportScopeOf<K extends DataExportKind> = K extends "personal" ? PersonalDataExportScope : ServerDataExportScope;

/** Bumped when a scope's stored shape changes; a job keeps the version it was asked with. */
export const DATA_EXPORT_SCOPE_VERSION = 1;
/** The most servers a personal export may name (the rest: "all"). */
export const DATA_EXPORT_MAX_SCOPE_SERVERS = 100;

const DAY_MS = 24 * 60 * 60 * 1000;
/** A ready archive is kept this long, then deleted (the row stays, `expired`). */
export const DATA_EXPORT_RETENTION_MS = 7 * DAY_MS;
/** One personal export per person per this long (failed ones not counted). */
export const DATA_EXPORT_PERSONAL_COOLDOWN_MS = 7 * DAY_MS;
/** One server export per server per this long (failed ones not counted). */
export const DATA_EXPORT_SERVER_COOLDOWN_MS = DAY_MS;
/** A sign-in younger than this can't start an export (a stolen session can't take the data at once). */
export const DATA_EXPORT_MIN_SESSION_AGE_MS = DAY_MS;
/** How long a download link works. */
export const DATA_EXPORT_DOWNLOAD_URL_TTL_SECONDS = 300;

export type DataExportScopeParse<S> = { ok: true; scope: S } | { ok: false; field: string; error: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function record(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
}

function flag(input: Record<string, unknown>, key: string): boolean | null {
  const value = input[key];
  if (value === undefined) return false;
  return typeof value === "boolean" ? value : null;
}

function unknownKey(input: Record<string, unknown>, allowed: readonly string[]): string | null {
  return Object.keys(input).find((key) => !allowed.includes(key)) ?? null;
}

/** A personal scope as asked: unknown keys and malformed values refused; booleans default to false. */
export function parsePersonalDataExportScope(raw: unknown): DataExportScopeParse<PersonalDataExportScope> {
  const input = record(raw);
  if (!input) return { ok: false, field: "scope", error: "The scope must be an object." };
  const extra = unknownKey(input, ["serverIds", "includeContext", "includeFiles"]);
  if (extra) return { ok: false, field: extra, error: "This field is not part of a personal export's scope." };
  let serverIds: string[] | "all";
  if (input.serverIds === "all") serverIds = "all";
  else if (Array.isArray(input.serverIds) && input.serverIds.length > 0 && input.serverIds.length <= DATA_EXPORT_MAX_SCOPE_SERVERS
    && input.serverIds.every((id) => typeof id === "string" && UUID_RE.test(id))) {
    serverIds = [...new Set((input.serverIds as string[]).map((id) => id.toLowerCase()))].sort();
  } else {
    return { ok: false, field: "serverIds", error: `Name "all" or 1 to ${DATA_EXPORT_MAX_SCOPE_SERVERS} server ids.` };
  }
  const includeContext = flag(input, "includeContext");
  if (includeContext === null) return { ok: false, field: "includeContext", error: "includeContext must be true or false." };
  const includeFiles = flag(input, "includeFiles");
  if (includeFiles === null) return { ok: false, field: "includeFiles", error: "includeFiles must be true or false." };
  return { ok: true, scope: { serverIds, includeContext, includeFiles } };
}

/** A server scope as asked; whether `fullHistoryAfterClose` fits the server is the server's check. */
export function parseServerDataExportScope(raw: unknown): DataExportScopeParse<ServerDataExportScope> {
  const input = record(raw ?? {});
  if (!input) return { ok: false, field: "scope", error: "The scope must be an object." };
  const extra = unknownKey(input, ["includeFiles", "fullHistoryAfterClose"]);
  if (extra) return { ok: false, field: extra, error: "This field is not part of a server export's scope." };
  const includeFiles = flag(input, "includeFiles");
  if (includeFiles === null) return { ok: false, field: "includeFiles", error: "includeFiles must be true or false." };
  const fullHistoryAfterClose = flag(input, "fullHistoryAfterClose");
  if (fullHistoryAfterClose === null) return { ok: false, field: "fullHistoryAfterClose", error: "fullHistoryAfterClose must be true or false." };
  return { ok: true, scope: { includeFiles, fullHistoryAfterClose } };
}

/** One finished volume of an archive, as clients see it. */
export interface DataExportVolumeView {
  index: number;
  sizeBytes: number;
}

/** An export job as the requester sees it (GET routes). Never the storage keys. */
export interface DataExportView {
  id: DataExportId;
  kind: DataExportKind;
  serverId: string | null;
  scope: DataExportScope;
  status: DataExportStatus;
  /** When it was asked: also the moment the archive's visibility is computed for. */
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Ready: when the archive is deleted. */
  expiresAt: string | null;
  sizeBytes: number | null;
  volumes: DataExportVolumeView[];
  /** Failed: why (a stable code). */
  errorCode: string | null;
  downloadedAt: string | null;
  lastDownloadedAt: string | null;
}

/**
 * What a server export would hold now, shown before it is asked for (design
 * §5: channels, messages, size). Messages and files are counted up to a cap
 * (`...Capped`: more than that).
 */
export interface ServerDataExportSummary {
  publicChannels: number;
  messages: number;
  messagesCapped: boolean;
  files: number;
  /** The files' total size (of those counted). */
  fileBytes: number;
  filesCapped: boolean;
  /** The free plan's window: messages after this; null: the whole history. */
  historyFrom: string | null;
}

/** The owner's data export switches of a server (GET/PATCH /api/servers/:id/data-export-settings). */
export interface ServerDataExportSettings {
  /** "Allow members to export this server's context": other people's messages in a member's personal export. Default off. */
  memberContextExportEnabled: boolean;
  /** The caller may change it (an owner: exportServerData). */
  canManage: boolean;
}
