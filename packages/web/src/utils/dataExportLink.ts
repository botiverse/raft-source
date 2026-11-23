/**
 * The data export email's link (#triage:#512; server
 * services/dataExport/notifications.ts): `/?data_export=<export id>`, a
 * signed-in page, never the archive. It opens Settings › Account on Data &
 * privacy (features/settings/account/DataExportSection.tsx), or for a server
 * export that server's Settings › Administration
 * (features/settings/administration/ServerDataPrivacySection.tsx), which marks
 * that export and takes the parameter off the address.
 */

/** The query parameter the email's link carries. */
export const DATA_EXPORT_LINK_PARAM = "data_export";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An export id from a link, or null. */
export function dataExportIdOf(value: string | null | undefined): string | null {
  return typeof value === "string" && UUID_RE.test(value) ? value.toLowerCase() : null;
}

/** A server export's link also names its server (`&data_export_server=<server id>`). */
export const DATA_EXPORT_SERVER_LINK_PARAM = "data_export_server";

/**
 * Where `/?data_export=<id>` goes: a server export's (its server named, and
 * one of the person's) to that server's Settings › Administration, on its
 * data export section; otherwise the account settings of the last server
 * used (else the first), on the personal one. Null for any other address, or
 * with no server to open settings in.
 */
export function dataExportLandingPath(search: string, servers: ReadonlyArray<{ id?: string; slug: string }>, lastSlug: string | null): string | null {
  const params = new URLSearchParams(search);
  const id = dataExportIdOf(params.get(DATA_EXPORT_LINK_PARAM));
  if (!id) return null;
  const serverId = dataExportIdOf(params.get(DATA_EXPORT_SERVER_LINK_PARAM));
  const exported = serverId ? servers.find((candidate) => candidate.id?.toLowerCase() === serverId) : undefined;
  if (exported) return `/s/${exported.slug}/settings/administration?${DATA_EXPORT_LINK_PARAM}=${id}#server-data-export`;
  const server = servers.find((candidate) => candidate.slug === lastSlug) ?? servers[0];
  if (!server) return null;
  return `/s/${server.slug}/settings/account?${DATA_EXPORT_LINK_PARAM}=${id}#data-export`;
}
