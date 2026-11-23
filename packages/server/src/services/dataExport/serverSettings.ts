// The owner's data export switch of a server (#triage:#512 design §4 "Owner
// 的开关", servers.member_context_export_enabled): "Allow members to export
// this server's context", off by default. Read by the personal producer
// (which servers let a member's export include other people's messages) and
// by GET/PATCH /api/servers/:id/data-export-settings (routes/servers.ts,
// owner only: exportServerData). Members' own messages are theirs whatever it says.
import { and, eq, inArray, isNull } from "drizzle-orm";

import { getDb } from "../../db/index";
import { servers } from "../../db/schema";

/** The open servers among these that allow members to export context. */
export async function contextAllowedServerIds(serverIds: readonly string[]): Promise<ReadonlySet<string>> {
  if (serverIds.length === 0) return new Set();
  const rows = await getDb().select({ id: servers.id }).from(servers)
    .where(and(inArray(servers.id, [...serverIds]), eq(servers.memberContextExportEnabled, true), isNull(servers.deletedAt)));
  return new Set(rows.map((row) => row.id));
}

/** The switch of an open server; null when there is none. */
export async function getMemberContextExportEnabled(serverId: string): Promise<boolean | null> {
  const [row] = await getDb().select({ enabled: servers.memberContextExportEnabled }).from(servers)
    .where(and(eq(servers.id, serverId), isNull(servers.deletedAt)));
  return row ? row.enabled : null;
}

/** Set it; null when the server is not open. A running personal export reads it again at every batch: turned off, no more context. */
export async function setMemberContextExportEnabled(serverId: string, enabled: boolean): Promise<boolean | null> {
  const [row] = await getDb().update(servers).set({ memberContextExportEnabled: enabled, updatedAt: new Date() })
    .where(and(eq(servers.id, serverId), isNull(servers.deletedAt)))
    .returning({ enabled: servers.memberContextExportEnabled });
  return row ? row.enabled : null;
}
