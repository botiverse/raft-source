/**
 * Data exports (#triage:#512; server routes/dataExports.ts,
 * docs/development/data-export.md), each call through a mount: the person's
 * own at /api/me/data-exports (PERSONAL_DATA_EXPORTS), a server's at
 * /api/servers/:id/data-exports (serverDataExports, an owner's):
 *   GET    /                    { exports, available, nextAllowedAt, contextServerIds (personal) | closed (server) };
 *                               404 while data_export_v0 is off for the person (and server)
 *   GET    /summary             server mount: ServerDataExportSummary
 *   POST   /                    { scope, password?, emailCode? } -> 202 { export }
 *   POST   /email-code          { sent, expiresAt }
 *   DELETE /:id                 { deleted: true }
 *   POST   /:id/download        { volume } -> { url } (S3, 300 s), or the zip's bytes (local disk)
 * Refusals of POST /: 403 data_export_session_too_new, 403 reauth_required
 * (details.methods), 403 second_factor_step_up_required (step-up), 400
 * email_code_invalid, 409 data_export_in_flight, 429 data_export_cooldown
 * (retryAfterSeconds); a server's also 403 data_export_owner_only and 409 for
 * a closed server's window. No X-Server-Id on the personal mount (a personal
 * export is the person's); the server's id on a server's.
 * And the owner's switch: GET/PATCH /api/servers/:id/data-export-settings.
 */
import { DATA_EXPORT_STATUSES } from "@botiverse/raft-shared";
import type { DataExportScope, DataExportStatus, ServerDataExportSettings, ServerDataExportSummary } from "@botiverse/raft-shared";

import api from "../../../api/client";
import { getApiErrorResponse } from "../../../utils/apiErrorResponse";

/** Where a kind of export is asked for, and how its downloads are named. */
export interface DataExportMount {
  kind: "personal" | "server";
  base: string;
  /** The X-Server-Id it sends: none for the personal mount, the server's id for a server's. */
  headers: { "X-Server-Id": string | false };
  /** The download's file name part, as the server names it: `me`, or the server's slug. */
  who: string;
}

export const PERSONAL_DATA_EXPORTS: DataExportMount = { kind: "personal", base: "/me/data-exports", headers: { "X-Server-Id": false }, who: "me" };

export function serverDataExports(server: { id: string; slug: string }): DataExportMount {
  return { kind: "server", base: `/servers/${encodeURIComponent(server.id)}/data-exports`, headers: { "X-Server-Id": server.id }, who: server.slug.replace(/[^a-zA-Z0-9-]/g, "-") || "server" };
}

/** The archive's file name (the server's Content-Disposition names it the same). */
export function dataExportFileName(mount: DataExportMount, item: Pick<DataExportItem, "createdAt" | "volumes">, volume: number): string {
  const date = item.createdAt.slice(0, 10);
  return item.volumes.length > 1 ? `raft-export-${mount.who}-${date}-${volume}.zip` : `raft-export-${mount.who}-${date}.zip`;
}

export interface DataExportItem {
  id: string;
  status: DataExportStatus;
  createdAt: string;
  expiresAt: string | null;
  sizeBytes: number | null;
  volumes: Array<{ index: number; sizeBytes: number }>;
  errorCode: string | null;
}

function itemOf(raw: unknown): DataExportItem | null {
  const row = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
  if (!row || typeof row.id !== "string" || typeof row.createdAt !== "string") return null;
  const status = DATA_EXPORT_STATUSES.find((candidate) => candidate === row.status);
  if (!status) return null;
  const volumes = Array.isArray(row.volumes) ? row.volumes.flatMap((volume) => {
    const v = volume && typeof volume === "object" ? volume as Record<string, unknown> : null;
    return v && typeof v.index === "number" && typeof v.sizeBytes === "number" ? [{ index: v.index, sizeBytes: v.sizeBytes }] : [];
  }) : [];
  return {
    id: row.id,
    status,
    createdAt: row.createdAt,
    expiresAt: typeof row.expiresAt === "string" ? row.expiresAt : null,
    sizeBytes: typeof row.sizeBytes === "number" ? row.sizeBytes : null,
    volumes,
    errorCode: typeof row.errorCode === "string" ? row.errorCode : null,
  };
}

export interface DataExportList {
  exports: DataExportItem[];
  available: boolean;
  /** When the cooldown lets the person (or server) ask again (deleted exports count, and aren't listed). */
  nextAllowedAt: string | null;
  /** Personal: the person's servers whose owner allows context. */
  contextServerIds: string[];
  /** Server: closed, so only its full history may be asked for. */
  closed: boolean;
}

/** The list; null when data export is off here (the 404 every route answers then). */
export async function listDataExports(mount: DataExportMount = PERSONAL_DATA_EXPORTS): Promise<DataExportList | null> {
  try {
    const { data } = await api.get<{ exports?: unknown; available?: unknown; nextAllowedAt?: unknown; contextServerIds?: unknown; closed?: unknown }>(mount.base, { headers: mount.headers });
    const exports = Array.isArray(data?.exports) ? data.exports.flatMap((row) => itemOf(row) ?? []) : [];
    const contextServerIds = Array.isArray(data?.contextServerIds) ? data.contextServerIds.filter((id): id is string => typeof id === "string") : [];
    return { exports, available: data?.available === true, nextAllowedAt: typeof data?.nextAllowedAt === "string" ? data.nextAllowedAt : null, contextServerIds, closed: data?.closed === true };
  } catch (err) {
    if (getApiErrorResponse(err)?.status === 404) return null;
    throw err;
  }
}

export type DataExportProof = { password: string } | { emailCode: string } | Record<string, never>;

export async function requestDataExport(mount: DataExportMount, scope: DataExportScope, proof: DataExportProof): Promise<DataExportItem | null> {
  const { data } = await api.post<{ export?: unknown }>(mount.base, { scope, ...proof }, { headers: mount.headers });
  return itemOf(data?.export);
}

export async function sendDataExportEmailCode(mount: DataExportMount): Promise<void> {
  await api.post(`${mount.base}/email-code`, {}, { headers: mount.headers });
}

export async function deleteDataExport(mount: DataExportMount, id: string): Promise<void> {
  await api.delete(`${mount.base}/${encodeURIComponent(id)}`, { headers: mount.headers });
}

/** What a server export would hold now (server mount, owners). */
export async function getServerDataExportSummary(mount: DataExportMount): Promise<ServerDataExportSummary> {
  const { data } = await api.get<ServerDataExportSummary>(`${mount.base}/summary`, { headers: mount.headers });
  return data;
}

/** The owner's switch; null while data export is off for the server (404). */
export async function getServerDataExportSettings(serverId: string): Promise<ServerDataExportSettings | null> {
  try {
    const { data } = await api.get<ServerDataExportSettings>(`/servers/${encodeURIComponent(serverId)}/data-export-settings`, { headers: { "X-Server-Id": serverId } });
    return data;
  } catch (err) {
    if (getApiErrorResponse(err)?.status === 404) return null;
    throw err;
  }
}

export async function setServerMemberContextExport(serverId: string, enabled: boolean): Promise<ServerDataExportSettings> {
  const { data } = await api.patch<ServerDataExportSettings>(`/servers/${encodeURIComponent(serverId)}/data-export-settings`, { memberContextExportEnabled: enabled }, { headers: { "X-Server-Id": serverId } });
  return data;
}

/**
 * Download one volume: S3 answers a short-lived link, local disk the bytes.
 * Either way the browser saves it through a hidden link.
 */
export async function downloadDataExportVolume(mount: DataExportMount, id: string, volume: number, fileName: string): Promise<void> {
  const { data, headers } = await api.post<Blob>(`${mount.base}/${encodeURIComponent(id)}/download`, { volume }, { headers: mount.headers, responseType: "blob" })
    .catch(async (err: unknown) => { throw await withJsonRefusal(err); });
  const type = String((headers as Record<string, unknown> | undefined)?.["content-type"] ?? data?.type ?? "");
  let href: string;
  let revoke = false;
  if (type.includes("application/json")) {
    const body = JSON.parse(await data.text()) as { url?: unknown };
    // Only a link to an https: store (S3) or to this app: never another scheme a response could name.
    const url = typeof body.url === "string" ? new URL(body.url, window.location.href) : null;
    if (!url || !(url.protocol === "https:" || url.origin === window.location.origin)) throw new Error("data_export_download_url_invalid");
    href = url.href;
  } else {
    href = URL.createObjectURL(data);
    revoke = true;
  }
  const link = document.createElement("a");
  link.href = href;
  link.download = fileName;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  if (revoke) setTimeout(() => URL.revokeObjectURL(href), 60_000);
}

/**
 * A refusal to a blob request arrives as a Blob: read its JSON body back onto
 * the error, so dataExportRefusalOf sees the code (data_export_session_too_new).
 */
async function withJsonRefusal(err: unknown): Promise<unknown> {
  const response = (err as { response?: { data?: unknown } } | null)?.response;
  if (!response || !(response.data instanceof Blob)) return err;
  try {
    response.data = JSON.parse(await response.data.text()) as unknown;
  } catch {
    // Not JSON: the refusal stays unworded (a plain failure).
  }
  return err;
}

/** How a refused request reads to the dialog. */
export type DataExportRefusal =
  | { kind: "reauth"; method: "password" | "email_code" }
  | { kind: "session_too_new" }
  | { kind: "sign_in_again" }
  | { kind: "in_flight" }
  | { kind: "server_not_found" }
  | { kind: "cooldown"; retryAt: Date | null }
  | { kind: "owner_only" }
  /** A closed server past its window, or being deleted. */
  | { kind: "window_over" }
  | { kind: "email_code_invalid" }
  | { kind: "failed" };

export function dataExportRefusalOf(err: unknown, now: Date = new Date()): DataExportRefusal {
  const response = getApiErrorResponse(err);
  const data = (err as { response?: { data?: { details?: { methods?: unknown }; methods?: unknown; retryAfterSeconds?: unknown } } } | null)?.response?.data;
  switch (response?.code) {
    case "reauth_required":
    case "email_code_not_available": {
      const methods = data?.details?.methods ?? data?.methods;
      const listed = Array.isArray(methods) ? methods : [];
      if (listed.includes("password")) return { kind: "reauth", method: "password" };
      if (listed.includes("email_code")) return { kind: "reauth", method: "email_code" };
      return { kind: "failed" };
    }
    case "data_export_session_too_new": return { kind: "session_too_new" };
    case "session_family_required": return { kind: "sign_in_again" };
    case "data_export_in_flight": return { kind: "in_flight" };
    case "data_export_server_not_found": return { kind: "server_not_found" };
    case "data_export_cooldown": {
      const seconds = typeof data?.retryAfterSeconds === "number" ? data.retryAfterSeconds : null;
      return { kind: "cooldown", retryAt: seconds ? new Date(now.getTime() + seconds * 1000) : null };
    }
    case "email_code_invalid": return { kind: "email_code_invalid" };
    case "data_export_owner_only": return { kind: "owner_only" };
    case "data_export_window_over": return { kind: "window_over" };
    default: return { kind: "failed" };
  }
}
