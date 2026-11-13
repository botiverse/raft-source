/**
 * A personal assistant changes some of its owner's settings when the owner
 * asks it to (`GET`/`PATCH /internal/agent-api/assistant/owner-settings`):
 *
 *   theme, themeDecor   the owner's own look in THIS server (their
 *                       server_members row here; never another server's).
 *                       The read answers both what is stored and what the
 *                       owner sees (a Pro theme on a Free server shows as
 *                       Raft Yellow, as the web's effectiveRaftTheme).
 *   displayLanguage     users.display_language, the UI language
 *   preferredTimezone   users.preferred_timezone
 *
 * Same checks, same writes, same socket event as the owner's own web routes
 * (`PATCH /api/servers/:id/appearance-settings`, `PATCH /api/auth/me`). Every
 * value that actually changed is recorded in the server-wide audit
 * (integration_audit_events, `assistant.owner_setting_changed`, one row per
 * setting, in the same transaction as the write), and the owner reads those
 * rows back on their settings page (`listOwnerSettingChanges`). theme and
 * themeDecor rows belong to the server they were made in; displayLanguage and
 * preferredTimezone are the account's, so the owner sees those from every
 * server.
 */
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { Server as SocketServer } from "socket.io";
import { effectiveRaftTheme, raftThemeDecorShown, type RaftThemeId } from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db/index";
import { agents, integrationAuditEvents, serverMembers, servers, users } from "../db/schema";
import { parseDisplayLanguage, parsePreferredTimezone } from "../lib/accountPreferenceParsers";
import { emitMemberAppearanceUpdated, parseMemberAppearanceInput, type MemberAppearanceInput } from "../lib/memberAppearanceInput";
import { isServerOnFreePlan } from "./agentUpgradeCardService";
import { recordIntegrationAuditEvent } from "./integrationAuditService";
import * as serverService from "./serverService";
import { writeUserFields } from "./userService";

export const OWNER_SETTING_KEYS = ["theme", "themeDecor", "displayLanguage", "preferredTimezone"] as const;
export type OwnerSettingKey = (typeof OWNER_SETTING_KEYS)[number];

/** What is stored: the owner's membership row here and their account. */
type StoredOwnerSettings = {
  /** null is the default, Raft Yellow (as the web's appearance read). */
  theme: RaftThemeId | null;
  themeDecor: boolean;
  displayLanguage: string | null;
  preferredTimezone: string | null;
};

export type OwnerSettings = {
  /** The theme the owner sees here: effectiveRaftTheme of the stored choice and this server's plan. */
  theme: RaftThemeId;
  /**
   * The theme the owner chose here; the default (nothing chosen) reads "raft",
   * the same value the audit records and the only way to write it back. Differs
   * from `theme` only for a Pro theme kept on a Free server.
   */
  storedTheme: RaftThemeId;
  /** The stored decorations switch. */
  themeDecor: boolean;
  /** Whether decorations show: the shown theme has some and the switch is on. */
  themeDecorShown: boolean;
  displayLanguage: string | null;
  preferredTimezone: string | null;
};

export const OWNER_SETTING_CHANGED_EVENT = "assistant.owner_setting_changed" as const;

/** A refusal, with the status and `{ error }` body the owner's own web route answers. */
export class AssistantOwnerSettingsError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

type OwnerScope = { agentId: string; serverId: string; ownerUserId: string };

type OwnerSettingsPatch = { appearance: MemberAppearanceInput; displayLanguage?: string | null; preferredTimezone?: string | null };

/** The body checked with the web's own validators; the first bad field is the refusal. */
export function parseOwnerSettingsPatch(body: unknown): OwnerSettingsPatch {
  const record = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const appearance = parseMemberAppearanceInput(record.theme, record.themeDecor);
  if (!appearance.ok) throw new AssistantOwnerSettingsError(400, appearance.error);
  let displayLanguage: string | null | undefined;
  let preferredTimezone: string | null | undefined;
  try {
    displayLanguage = parseDisplayLanguage(record.displayLanguage);
    preferredTimezone = parsePreferredTimezone(record.preferredTimezone);
  } catch (err) {
    throw new AssistantOwnerSettingsError(400, err instanceof Error ? err.message : "Invalid account preference");
  }
  if (Object.keys(appearance.input).length === 0 && displayLanguage === undefined && preferredTimezone === undefined) {
    throw new AssistantOwnerSettingsError(400, "theme, themeDecor, displayLanguage or preferredTimezone is required");
  }
  return {
    appearance: appearance.input,
    ...(displayLanguage !== undefined ? { displayLanguage } : {}),
    ...(preferredTimezone !== undefined ? { preferredTimezone } : {}),
  };
}

async function readStoredOwnerSettings(serverId: string, ownerUserId: string, db: DatabaseExecutor): Promise<StoredOwnerSettings> {
  const appearance = await serverService.getMemberAppearance(serverId, ownerUserId, db);
  const [user] = await db
    .select({ displayLanguage: users.displayLanguage, preferredTimezone: users.preferredTimezone })
    .from(users)
    .where(eq(users.id, ownerUserId))
    .limit(1);
  // resolveAssistantOwner already found the owner a member here.
  if (!appearance || !user) throw new AssistantOwnerSettingsError(404, "Server not found");
  return {
    theme: appearance.theme,
    themeDecor: appearance.themeDecor,
    displayLanguage: user.displayLanguage ?? null,
    preferredTimezone: user.preferredTimezone ?? null,
  };
}

/** The stored settings with what the owner sees in this server, by its plan (billing first, as the web). */
async function presentOwnerSettings(serverId: string, stored: StoredOwnerSettings, db: DatabaseExecutor): Promise<OwnerSettings> {
  const theme = effectiveRaftTheme(stored.theme, await isServerOnFreePlan(serverId, db));
  return {
    theme,
    storedTheme: stored.theme ?? "raft",
    themeDecor: stored.themeDecor,
    themeDecorShown: raftThemeDecorShown(theme, stored.themeDecor),
    displayLanguage: stored.displayLanguage,
    preferredTimezone: stored.preferredTimezone,
  };
}

export async function getOwnerSettings(serverId: string, ownerUserId: string, db: DatabaseExecutor = getDb()): Promise<OwnerSettings> {
  return presentOwnerSettings(serverId, await readStoredOwnerSettings(serverId, ownerUserId, db), db);
}

/** A stored setting's value as the audit keeps it: the default theme by its id, "raft". */
function auditValue(settings: StoredOwnerSettings, key: OwnerSettingKey): string | boolean | null {
  if (key === "theme") return settings.theme ?? "raft";
  return settings[key];
}

export async function updateOwnerSettings(
  owner: OwnerScope & { io?: SocketServer },
  body: unknown,
): Promise<{ settings: OwnerSettings; changed: OwnerSettingKey[] }> {
  const patch = parseOwnerSettingsPatch(body);
  const given: OwnerSettingKey[] = OWNER_SETTING_KEYS.filter((key) => (
    key === "theme" || key === "themeDecor" ? patch.appearance[key] !== undefined : patch[key] !== undefined
  ));
  const result = await getDb().transaction(async (tx) => {
    // Hold both rows so "before" is what this write replaced.
    await tx.select({ id: users.id }).from(users).where(eq(users.id, owner.ownerUserId)).for("update");
    await tx.select({ userId: serverMembers.userId }).from(serverMembers)
      .where(and(eq(serverMembers.serverId, owner.serverId), eq(serverMembers.userId, owner.ownerUserId)))
      .for("update");
    const before = await readStoredOwnerSettings(owner.serverId, owner.ownerUserId, tx);
    if (Object.keys(patch.appearance).length > 0) {
      await serverService.updateMemberAppearance(owner.serverId, owner.ownerUserId, patch.appearance, tx);
    }
    const userFields = {
      ...(patch.displayLanguage !== undefined ? { displayLanguage: patch.displayLanguage } : {}),
      ...(patch.preferredTimezone !== undefined ? { preferredTimezone: patch.preferredTimezone } : {}),
    };
    if (Object.keys(userFields).length > 0) await writeUserFields(owner.ownerUserId, userFields, tx);
    const after = await readStoredOwnerSettings(owner.serverId, owner.ownerUserId, tx);
    const changed = given.filter((key) => auditValue(before, key) !== auditValue(after, key));
    for (const setting of changed) {
      await recordIntegrationAuditEvent({
        serverId: owner.serverId,
        eventType: OWNER_SETTING_CHANGED_EVENT,
        outcome: "success",
        source: "api",
        actor: { type: "agent", id: owner.agentId },
        subject: { type: "human", id: owner.ownerUserId },
        target: { type: "user", id: owner.ownerUserId },
        metadata: { setting, previousValue: auditValue(before, setting), nextValue: auditValue(after, setting) },
      }, tx);
    }
    return { stored: after, settings: await presentOwnerSettings(owner.serverId, after, tx), changed };
  });
  // As the web's appearance route: the owner's open tabs and devices follow
  // (the stored choice; each client works out what it shows).
  if (Object.keys(patch.appearance).length > 0) {
    emitMemberAppearanceUpdated(owner.io, owner.ownerUserId, owner.serverId, { theme: result.stored.theme, themeDecor: result.stored.themeDecor });
  }
  return { settings: result.settings, changed: result.changed };
}

export const OWNER_SETTING_CHANGES_LIMIT = 10;

export interface OwnerSettingChange {
  id: string;
  agentId: string | null;
  /** The assistant's display name now (null once it is gone). */
  assistantName: string | null;
  setting: OwnerSettingKey;
  /** The server the change was made in (null once it is gone); not the asking server only for an account-wide setting. */
  serverId: string | null;
  serverName: string | null;
  previousValue: string | boolean | null;
  nextValue: string | boolean | null;
  createdAt: string;
}

function isOwnerSettingKey(value: unknown): value is OwnerSettingKey {
  return typeof value === "string" && (OWNER_SETTING_KEYS as readonly string[]).includes(value);
}

function settingValue(value: unknown): string | boolean | null {
  return typeof value === "string" || typeof value === "boolean" ? value : null;
}

/** The owner's look in one server: a change to it shows in that server only. */
const SERVER_SETTINGS: readonly OwnerSettingKey[] = ["theme", "themeDecor"];
/** Settings that are the account's, not one server's: a change to them shows in every server. */
const ACCOUNT_WIDE_SETTINGS: readonly OwnerSettingKey[] = ["displayLanguage", "preferredTimezone"];

/**
 * What an assistant changed of this person's settings, newest first: their
 * look in this server, and their account-wide settings changed from any
 * server (by the audit's subject, whatever the assistant is now).
 */
export async function listOwnerSettingChanges(serverId: string, ownerUserId: string, limit = OWNER_SETTING_CHANGES_LIMIT): Promise<OwnerSettingChange[]> {
  const settingKey = sql<string>`${integrationAuditEvents.metadata}->>'setting'`;
  const rows = await getDb()
    .select({
      id: integrationAuditEvents.id,
      agentId: integrationAuditEvents.actorId,
      assistantName: agents.displayName,
      serverId: integrationAuditEvents.serverId,
      serverName: servers.name,
      metadata: integrationAuditEvents.metadata,
      createdAt: integrationAuditEvents.createdAt,
    })
    .from(integrationAuditEvents)
    .leftJoin(agents, eq(agents.id, integrationAuditEvents.actorId))
    .leftJoin(servers, eq(servers.id, integrationAuditEvents.serverId))
    .where(and(
      // In SQL, so the limit counts only what the owner is shown.
      or(
        and(eq(integrationAuditEvents.serverId, serverId), inArray(settingKey, [...SERVER_SETTINGS])),
        inArray(settingKey, [...ACCOUNT_WIDE_SETTINGS]),
      ),
      eq(integrationAuditEvents.eventType, OWNER_SETTING_CHANGED_EVENT),
      eq(integrationAuditEvents.subjectType, "human"),
      eq(integrationAuditEvents.subjectId, ownerUserId),
    ))
    .orderBy(desc(integrationAuditEvents.createdAt), desc(integrationAuditEvents.id))
    .limit(limit);
  const changes: OwnerSettingChange[] = [];
  for (const row of rows) {
    const setting = row.metadata?.setting;
    if (!isOwnerSettingKey(setting)) continue;
    changes.push({
      id: row.id,
      agentId: row.agentId,
      assistantName: row.assistantName ?? null,
      setting,
      serverId: row.serverId ?? null,
      serverName: row.serverName ?? null,
      previousValue: settingValue(row.metadata.previousValue),
      nextValue: settingValue(row.metadata.nextValue),
      createdAt: row.createdAt.toISOString(),
    });
  }
  return changes;
}
