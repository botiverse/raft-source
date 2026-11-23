// Telling the requester an export is ready or failed (design §6): an email
// (emailService.sendDataExportEmail: a link to the signed-in download page,
// never to the archive) and an in-app system notice (a `system_notice`
// outbox row, as secondFactor/recovery.ts pushRecoveryStarted, opening
// Activity). Each is keyed by the export and the outcome, so a run that
// repeats after a crash does not tell the person twice. Never throws.
//
// A server export that is ready also tells the server's other owners (design
// §5 "透明度"): an in-app system notice each, naming who exported it, never
// an email and never the archive (only its requester downloads it).
import { and, eq, isNull, ne } from "drizzle-orm";

import { getDb } from "../../db/index";
import { serverMembers, servers, users } from "../../db/schema";
import { serializeErrorForLog } from "../../tracing/safeErrorLog";
import { sendDataExportEmail } from "../emailService";
import type { NotificationNoticePayload } from "../notifications/envelope";
import { enqueueNotificationRows } from "../notifications/enqueue";
import { listServerLevels } from "../notifications/settings";
import type { DataExportRow } from "./jobs";

export type DataExportOutcome = "ready" | "failed";

/** The notice's server: a server export's own; for a personal one, a server the scope names, else the person's first. */
async function noticeServerId(row: DataExportRow): Promise<string | null> {
  if (row.serverId) return row.serverId;
  const scoped = "serverIds" in row.scope && Array.isArray(row.scope.serverIds) ? row.scope.serverIds : [];
  const levels = await listServerLevels(row.requesterUserId);
  return levels.find((level) => scoped.includes(level.serverId))?.serverId ?? levels[0]?.serverId ?? null;
}

export async function notifyDataExportOutcome(row: DataExportRow, outcome: DataExportOutcome, now: Date): Promise<void> {
  let serverName: string | undefined;
  try {
    if (row.serverId) {
      const [server] = await getDb().select({ name: servers.name }).from(servers).where(eq(servers.id, row.serverId));
      serverName = server?.name;
    }
    const [person] = await getDb().select({ email: users.email, displayName: users.displayName, name: users.name, retiredAt: users.retiredAt })
      .from(users).where(eq(users.id, row.requesterUserId));
    if (person && !person.retiredAt) {
      await sendDataExportEmail(person.email, person.displayName || person.name,
        outcome === "ready"
          ? { kind: "ready", exportId: row.id, ...(serverName ? { serverName } : {}), ...(row.serverId ? { serverId: row.serverId } : {}), expiresAt: row.expiresAt ?? now }
          : { kind: "failed", exportId: row.id, ...(serverName ? { serverName } : {}), ...(row.serverId ? { serverId: row.serverId } : {}) },
        { idempotencyKey: `data-export:${row.id}:${outcome}` });
    }
  } catch (err) {
    console.error(`[data-export] ${outcome} email for ${row.id} failed:`, serializeErrorForLog(err));
  }
  try {
    const serverId = await noticeServerId(row);
    if (!serverId) return;
    const what = serverName ? `The export of ${serverName}` : "Your data export";
    const payload: NotificationNoticePayload = {
      title: outcome === "ready" ? `${what} is ready` : `${what} could not be made`,
      body: outcome === "ready"
        ? "Open Data & privacy in settings to download it. It is kept for 7 days."
        : "Nothing was exported, and it does not count against your limit. You can ask again.",
      kind: "mention",
      event: "system_notice",
      route: { type: "channel", serverId, channelId: "", messageId: null },
      opensActivity: true,
    };
    await enqueueNotificationRows([{
      receiverId: row.requesterUserId,
      serverId,
      kind: null,
      sourceChannelId: null,
      messageId: null,
      messageSeq: null,
      activityAt: now,
      personalMention: true,
      eventKey: `data_export:${row.id}:${outcome}`,
      category: "system_notice",
      payload: payload as unknown as Record<string, unknown>,
    }]);
  } catch (err) {
    console.error(`[data-export] ${outcome} notice for ${row.id} failed:`, serializeErrorForLog(err));
  }
  if (outcome === "ready" && row.kind === "server" && row.serverId) {
    try {
      await noticeOtherOwners(row, row.serverId, serverName, now);
    } catch (err) {
      console.error(`[data-export] other owners' notice for ${row.id} failed:`, serializeErrorForLog(err));
    }
  }
}

/** The server's owners but the requester (live accounts), each told once per export. */
async function noticeOtherOwners(row: DataExportRow, serverId: string, serverName: string | undefined, now: Date): Promise<void> {
  const owners = await getDb().select({ id: users.id }).from(serverMembers)
    .innerJoin(users, eq(users.id, serverMembers.userId))
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.role, "owner"), ne(serverMembers.userId, row.requesterUserId), isNull(users.retiredAt)));
  if (owners.length === 0) return;
  const [requester] = await getDb().select({ displayName: users.displayName, name: users.name }).from(users).where(eq(users.id, row.requesterUserId));
  const who = requester ? requester.displayName || requester.name : "Another owner";
  const payload: NotificationNoticePayload = {
    title: `${who} exported ${serverName ?? "this server"}`,
    body: "The export holds the server's public channels and is kept for 7 days. Only the owner who asked for it can download it.",
    kind: "mention",
    event: "system_notice",
    route: { type: "channel", serverId, channelId: "", messageId: null },
    opensActivity: true,
  };
  await enqueueNotificationRows(owners.map((owner) => ({
    receiverId: owner.id,
    serverId,
    kind: null,
    sourceChannelId: null,
    messageId: null,
    messageSeq: null,
    activityAt: now,
    personalMention: true,
    eventKey: `data_export:${row.id}:ready:other_owner`,
    category: "system_notice" as const,
    payload: payload as unknown as Record<string, unknown>,
  })));
}
