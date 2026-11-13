/**
 * Notification settings (docs/contracts/notifications.md §2): the account-wide
 * settings (pause, quiet hours, preview, sound, phone alerts, followed-thread
 * replies), the one write path for the
 * two level scopes (server / channel), and the batched reads the
 * dispatcher's policy uses.
 *
 * Storage:
 * - account: user_notification_settings (no row = the defaults, version 0);
 * - server: server_members.server_push_mode (older clients' serverPushMuted /
 *   serverPushMentionsOnly are derived from it);
 * - channel (incl. DM): user_channel_notification_prefs (no row = default);
 * - thread (incl. task conversation): no level, only Follow / Unfollow
 *   (thread_follows). thread_follows.notification_level, written between
 *   #12135 and the change that removed thread levels, is no longer written
 *   or read.
 *
 * Every level change in a server bumps that member's counter in
 * user_notification_level_versions, and that one counter is the
 * `prefsVersion` of every level event in the server: a channel row deleted
 * back to `default` and created again never reuses a version a client holds.
 * The counter is kept off server_members on purpose: a level write must never
 * lock the member row, which the read-state and membership fences hold FOR
 * SHARE and a removal holds FOR UPDATE (bumpPrefsVersion). Reads take
 * GREATEST(counter, server_members.notification_prefs_version), the legacy
 * column that held it before.
 */
import {
  asServerId,
  DEFAULT_NOTIFICATION_ACCOUNT_SETTINGS,
  isNotificationLevel,
  isNotificationLevelSetting,
  isNotificationMobileDelay,
  isNotificationPreviewMode,
  NOTIFICATION_LEVEL_SCOPES,
  resolveEffectiveLevel,
  strictestPreviewMode,
  type NotificationAccountSettings,
  type NotificationLevel,
  type NotificationLevelScope,
  type NotificationLevelSetting,
  type NotificationMobileDelay,
  type NotificationPreviewMode,
  type NotificationQuietHours,
} from "@botiverse/raft-shared";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Server as SocketServer } from "socket.io";
import { getDb, type DatabaseExecutor } from "../../db/index";
import { PG_MAX_BIND_PARAMETERS } from "../../db/bindParameterBudget";
import {
  channels,
  inboxTargetMuteStates,
  serverMembers,
  servers,
  threadFollows,
  userChannelNotificationPrefs,
  userNotificationLevelVersions,
  userNotificationSettings,
} from "../../db/schema";
import * as channelService from "../channelService";
import { CompatibilityReadMutationPendingError } from "../readMutationSequencer";
import { isReceiverStatePushEnabled } from "../receiverStatePushService";
import { emitThreadFollowersUpdated } from "../threadFollowerRealtimeService";

export type { NotificationAccountSettings } from "@botiverse/raft-shared";

// ---------------------------------------------------------------------------
// Batched reads (dispatcher policy)
// ---------------------------------------------------------------------------

export interface NotificationPolicyPrefs {
  /** userId -> settings (the defaults when the user has no row). */
  account: Map<string, NotificationAccountSettings>;
  /** `${serverId}:${userId}` -> server level; absent = not a member. */
  serverLevel: Map<string, NotificationLevel>;
  /** `${channelId}:${userId}`, explicit rows only (absent = default). */
  channelLevel: Map<string, NotificationLevel>;
  /** `${channelId}:${userId}` for activity-muted channels (inbox_target_mute_states): the mute's from-seq. */
  mutedFromSeq: Map<string, number | null>;
}

export interface NotificationPolicyPrefsQuery {
  userIds: readonly string[];
  serverIds: readonly string[];
  channelIds: readonly string[];
  threadChannelIds: readonly string[];
}

// One statement binds the two id lists plus a few literals.
const IDS_PER_LIST = Math.floor((PG_MAX_BIND_PARAMETERS - 256) / 2);

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function chunks(ids: readonly string[], size = IDS_PER_LIST): string[][] {
  const out: string[][] = [];
  for (let start = 0; start < ids.length; start += size) out.push(ids.slice(start, start + size));
  return out;
}

/** Runs `read` for every (a-chunk, b-chunk) pair so no statement exceeds the bind limit. */
async function forEachChunkPair<T>(
  a: readonly string[],
  b: readonly string[],
  read: (aChunk: string[], bChunk: string[]) => Promise<T[]>,
): Promise<T[]> {
  const ua = unique(a);
  const ub = unique(b);
  if (ua.length === 0 || ub.length === 0) return [];
  const rows: T[] = [];
  for (const aChunk of chunks(ua)) {
    for (const bChunk of chunks(ub)) rows.push(...await read(aChunk, bChunk));
  }
  return rows;
}

type AccountRow = typeof userNotificationSettings.$inferSelect;

function defaultAccountSettings(): NotificationAccountSettings {
  return { ...DEFAULT_NOTIFICATION_ACCOUNT_SETTINGS, quietHours: { ...DEFAULT_NOTIFICATION_ACCOUNT_SETTINGS.quietHours } };
}

function accountSettingsFromRow(row: AccountRow): NotificationAccountSettings {
  return {
    pausedUntil: row.pausedUntil ? row.pausedUntil.toISOString() : null,
    quietHours: {
      enabled: row.quietHoursEnabled,
      startMinute: row.quietStartMinute,
      endMinute: row.quietEndMinute,
      timeZone: row.timeZone,
    },
    previewMode: isNotificationPreviewMode(row.previewMode) ? row.previewMode : "hidden",
    sound: row.soundEnabled,
    mobileDelay: isNotificationMobileDelay(row.mobileDelay) ? row.mobileDelay : "inactive",
    followedThreadReplies: row.followedThreadReplies,
    version: row.version,
  };
}

export async function loadAccountNotificationSettings(
  executor: DatabaseExecutor,
  userIds: readonly string[],
): Promise<Map<string, NotificationAccountSettings>> {
  const ids = unique(userIds);
  const result = new Map<string, NotificationAccountSettings>();
  for (const chunk of chunks(ids, PG_MAX_BIND_PARAMETERS - 256)) {
    const rows = await executor.select().from(userNotificationSettings).where(inArray(userNotificationSettings.userId, chunk));
    for (const row of rows) result.set(row.userId, accountSettingsFromRow(row));
  }
  for (const id of ids) if (!result.has(id)) result.set(id, defaultAccountSettings());
  return result;
}

export async function loadNotificationPolicyPrefs(
  executor: DatabaseExecutor,
  query: NotificationPolicyPrefsQuery,
): Promise<NotificationPolicyPrefs> {
  const account = await loadAccountNotificationSettings(executor, query.userIds);

  const serverLevel = new Map<string, NotificationLevel>();
  for (const row of await forEachChunkPair(query.serverIds, query.userIds, (serverIds, userIds) => executor
    .select({ serverId: serverMembers.serverId, userId: serverMembers.userId, level: serverMembers.serverPushMode })
    .from(serverMembers)
    .where(and(inArray(serverMembers.serverId, serverIds), inArray(serverMembers.userId, userIds))))) {
    serverLevel.set(`${row.serverId}:${row.userId}`, row.level);
  }

  const channelLevel = new Map<string, NotificationLevel>();
  for (const row of await forEachChunkPair(query.channelIds, query.userIds, (channelIds, userIds) => executor
    .select({ channelId: userChannelNotificationPrefs.channelId, userId: userChannelNotificationPrefs.userId, level: userChannelNotificationPrefs.level })
    .from(userChannelNotificationPrefs)
    .where(and(inArray(userChannelNotificationPrefs.channelId, channelIds), inArray(userChannelNotificationPrefs.userId, userIds))))) {
    channelLevel.set(`${row.channelId}:${row.userId}`, row.level);
  }

  // Only a mute that silences push (push_muted) is a notification mute: an
  // owner's DM with their assistant is kept out of Activity by an activity
  // mute with push_muted = false (#12144) and still notifies, like the
  // inbox-fact filter in recordInboxNotificationFacts.
  const mutedFromSeq = new Map<string, number | null>();
  for (const row of await forEachChunkPair(query.channelIds, query.userIds, (channelIds, userIds) => executor
    .select({ channelId: inboxTargetMuteStates.sourceChannelId, userId: inboxTargetMuteStates.receiverId, muteFromSeq: inboxTargetMuteStates.muteFromSeq })
    .from(inboxTargetMuteStates)
    .where(and(
      eq(inboxTargetMuteStates.receiverType, "user"),
      eq(inboxTargetMuteStates.activityMuted, true),
      eq(inboxTargetMuteStates.pushMuted, true),
      inArray(inboxTargetMuteStates.sourceChannelId, channelIds),
      inArray(inboxTargetMuteStates.receiverId, userIds),
    )))) {
    mutedFromSeq.set(`${row.channelId}:${row.userId}`, row.muteFromSeq);
  }

  return { account, serverLevel, channelLevel, mutedFromSeq };
}

// ---------------------------------------------------------------------------
// Account settings
// ---------------------------------------------------------------------------

export async function getAccountNotificationSettings(
  userId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<NotificationAccountSettings> {
  return (await loadAccountNotificationSettings(executor, [userId])).get(userId) ?? defaultAccountSettings();
}

export interface AccountSettingsPatch {
  pausedUntil?: string | null;
  quietHours?: NotificationQuietHours;
  previewMode?: NotificationPreviewMode;
  sound?: boolean;
  mobileDelay?: NotificationMobileDelay;
  followedThreadReplies?: boolean;
  /** Optimistic concurrency: must equal the stored version when present. */
  version?: number;
}

export function isValidTimeZone(value: string): boolean {
  if (!value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function isMinuteOfDay(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1439;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The longest pause (a far-future ISO time such as +010000-… would not fit timestamptz). */
export const MAX_PAUSE_MS = 366 * 24 * 60 * 60 * 1000;

/** Validates a PATCH body (contract §2.1). `now` decides whether pausedUntil is in the future. */
export function parseAccountSettingsPatch(
  body: unknown,
  now: Date,
): { ok: true; patch: AccountSettingsPatch } | { ok: false; error: string } {
  if (!isRecord(body)) return { ok: false, error: "Body must be an object" };
  const patch: AccountSettingsPatch = {};
  if ("pausedUntil" in body) {
    const raw = body.pausedUntil;
    if (raw === null) patch.pausedUntil = null;
    else {
      const at = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
      if (!Number.isFinite(at)) return { ok: false, error: "pausedUntil must be an ISO time or null" };
      if (at <= now.getTime()) return { ok: false, error: "pausedUntil must be in the future" };
      if (at > now.getTime() + MAX_PAUSE_MS) return { ok: false, error: "pausedUntil must be at most a year ahead" };
      patch.pausedUntil = new Date(at).toISOString();
    }
  }
  if ("quietHours" in body) {
    const raw = body.quietHours;
    if (!isRecord(raw)
      || typeof raw.enabled !== "boolean"
      || !isMinuteOfDay(raw.startMinute)
      || !isMinuteOfDay(raw.endMinute)
      || typeof raw.timeZone !== "string") {
      return { ok: false, error: "quietHours needs enabled, startMinute and endMinute (0-1439) and timeZone" };
    }
    if (!isValidTimeZone(raw.timeZone)) return { ok: false, error: "quietHours.timeZone must be an IANA time zone" };
    patch.quietHours = { enabled: raw.enabled, startMinute: raw.startMinute, endMinute: raw.endMinute, timeZone: raw.timeZone };
  }
  if ("previewMode" in body) {
    if (!isNotificationPreviewMode(body.previewMode)) return { ok: false, error: "previewMode must be one of full, sender_only, hidden" };
    patch.previewMode = body.previewMode;
  }
  if ("sound" in body) {
    if (typeof body.sound !== "boolean") return { ok: false, error: "sound must be a boolean" };
    patch.sound = body.sound;
  }
  if ("mobileDelay" in body) {
    if (!isNotificationMobileDelay(body.mobileDelay)) return { ok: false, error: "mobileDelay must be one of always, inactive, 1m, 2m, 5m, 10m" };
    patch.mobileDelay = body.mobileDelay;
  }
  if ("followedThreadReplies" in body) {
    if (typeof body.followedThreadReplies !== "boolean") return { ok: false, error: "followedThreadReplies must be a boolean" };
    patch.followedThreadReplies = body.followedThreadReplies;
  }
  if ("version" in body && body.version !== undefined) {
    const version = body.version;
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) {
      return { ok: false, error: "version must be a non-negative integer" };
    }
    patch.version = version;
  }
  return { ok: true, patch };
}

export type AccountSettingsUpdateResult =
  /** `previous`: the settings the write replaced (the same as `settings` when nothing changed). */
  | { kind: "updated"; settings: NotificationAccountSettings; previous: NotificationAccountSettings; changed: boolean }
  | { kind: "version_conflict"; settings: NotificationAccountSettings };

function mergeAccountSettings(current: NotificationAccountSettings, patch: AccountSettingsPatch): NotificationAccountSettings {
  return {
    pausedUntil: patch.pausedUntil !== undefined ? patch.pausedUntil : current.pausedUntil,
    quietHours: patch.quietHours ?? current.quietHours,
    previewMode: patch.previewMode ?? current.previewMode,
    sound: patch.sound ?? current.sound,
    mobileDelay: patch.mobileDelay ?? current.mobileDelay,
    followedThreadReplies: patch.followedThreadReplies ?? current.followedThreadReplies,
    version: current.version,
  };
}

function sameAccountSettings(a: NotificationAccountSettings, b: NotificationAccountSettings): boolean {
  return a.pausedUntil === b.pausedUntil
    && a.previewMode === b.previewMode
    && a.sound === b.sound
    && a.mobileDelay === b.mobileDelay
    && a.followedThreadReplies === b.followedThreadReplies
    && a.quietHours.enabled === b.quietHours.enabled
    && a.quietHours.startMinute === b.quietHours.startMinute
    && a.quietHours.endMinute === b.quietHours.endMinute
    && a.quietHours.timeZone === b.quietHours.timeZone;
}

/**
 * Applies a validated patch with optimistic concurrency: a `version` that is
 * not the stored one is a conflict; without one, a concurrent writer is
 * retried. A patch that changes nothing keeps the version.
 */
export async function updateAccountNotificationSettings(
  userId: string,
  patch: AccountSettingsPatch,
  executor: DatabaseExecutor = getDb(),
): Promise<AccountSettingsUpdateResult> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await getAccountNotificationSettings(userId, executor);
    if (patch.version !== undefined && patch.version !== current.version) {
      return { kind: "version_conflict", settings: current };
    }
    const next = mergeAccountSettings(current, patch);
    if (sameAccountSettings(current, next)) return { kind: "updated", settings: current, previous: current, changed: false };
    const values = {
      pausedUntil: next.pausedUntil ? new Date(next.pausedUntil) : null,
      quietHoursEnabled: next.quietHours.enabled,
      quietStartMinute: next.quietHours.startMinute,
      quietEndMinute: next.quietHours.endMinute,
      timeZone: next.quietHours.timeZone,
      previewMode: next.previewMode,
      soundEnabled: next.sound,
      mobileDelay: next.mobileDelay,
      followedThreadReplies: next.followedThreadReplies,
      version: current.version + 1,
      updatedAt: sql`now()`,
    };
    const [row] = await executor
      .insert(userNotificationSettings)
      .values({ userId, ...values })
      .onConflictDoUpdate({
        target: userNotificationSettings.userId,
        set: values,
        setWhere: eq(userNotificationSettings.version, current.version),
      })
      .returning();
    if (row) return { kind: "updated", settings: accountSettingsFromRow(row), previous: current, changed: true };
    // Someone else wrote first: a client that named a version conflicts, others retry on the new row.
  }
  throw new Error("user_notification_settings update kept racing");
}

/**
 * Rolling compatibility for older mobile apps that still send `previewMode`
 * with every registration (design §11.2): a value that differs from what this
 * registration last reported is the user changing it in the old UI, so it
 * becomes the account setting. A first report (no earlier one from this user
 * on this installation) is only adopted when it is stricter than the account
 * setting, so a fresh install's default never loosens it.
 */
export function previewModeToAdopt(input: {
  reported: NotificationPreviewMode | undefined;
  previouslyReported: NotificationPreviewMode | null;
  account: NotificationPreviewMode;
}): NotificationPreviewMode | null {
  const { reported, previouslyReported, account } = input;
  if (!reported || reported === account) return null;
  if (previouslyReported !== null) return reported !== previouslyReported ? reported : null;
  return strictestPreviewMode([reported, account]) === reported ? reported : null;
}

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

export interface SetLevelInput {
  userId: string;
  scope: NotificationLevelScope;
  id: string;
  level: NotificationLevelSetting;
  /**
   * The caller already checked the user may read this conversation (the
   * thread Follow / Unfollow routes check the parent their own way).
   */
  accessChecked?: boolean;
  /**
   * The thread Follow / Unfollow button: always run the follow / unfollow
   * (it is idempotent and also moves the read position, as the buttons did).
   */
  button?: boolean;
}

export interface SetLevelResult {
  scope: NotificationLevelScope;
  id: string;
  serverId: string;
  level: NotificationLevelSetting;
  effective: NotificationLevel;
  muted: boolean;
  prefsVersion: number;
  /** Whether anything was written (no event otherwise). */
  changed: boolean;
  /** Thread scope: the follow state moved (thread:followers-updated). */
  followChanged?: boolean;
  /**
   * Thread scope: the follow committed but its read-position side effect is
   * still pending (the Follow / Unfollow routes answer 202 with it, after the
   * prefs event).
   */
  pendingRead?: CompatibilityReadMutationPendingError;
}

export class NotificationLevelError extends Error {
  constructor(readonly status: 400 | 404, message: string) {
    super(message);
    this.name = "NotificationLevelError";
  }
}

export function parseSetLevelBody(body: unknown): { ok: true; scope: NotificationLevelScope; id: string; level: NotificationLevelSetting } | { ok: false; error: string } {
  if (!isRecord(body)) return { ok: false, error: "Body must be an object" };
  const { scope, id, level } = body;
  if (typeof scope !== "string" || !(NOTIFICATION_LEVEL_SCOPES as readonly string[]).includes(scope)) {
    return { ok: false, error: "scope must be one of server, channel, thread" };
  }
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return { ok: false, error: "id must be a uuid" };
  }
  if (!isNotificationLevelSetting(level)) return { ok: false, error: "level must be one of default, all, mentions, none" };
  if (scope === "server" && level === "default") return { ok: false, error: "A server level cannot be default" };
  return { ok: true, scope: scope as NotificationLevelScope, id: id.toLowerCase(), level };
}

async function readMemberLevel(executor: DatabaseExecutor, serverId: string, userId: string) {
  // A plain read (no row lock): it never waits on a fence or a removal.
  const [member] = await executor
    .select({
      level: serverMembers.serverPushMode,
      prefsVersion: sql<number>`GREATEST(${serverMembers.notificationPrefsVersion}, COALESCE(${userNotificationLevelVersions.version}, 0))`.mapWith(Number),
    })
    .from(serverMembers)
    .innerJoin(servers, eq(servers.id, serverMembers.serverId))
    .leftJoin(userNotificationLevelVersions, and(
      eq(userNotificationLevelVersions.userId, serverMembers.userId),
      eq(userNotificationLevelVersions.serverId, serverMembers.serverId),
    ))
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId), isNull(servers.deletedAt)));
  return member ?? null;
}

/**
 * The next level version of (user, server), in the caller's transaction. It
 * locks only the user's own counter row, never server_members: a Follow /
 * Unfollow (or any level write) neither waits behind a removal holding the
 * member row nor blocks the fences that hold it FOR SHARE. The first bump
 * starts above the legacy server_members column, so no version is reused.
 * A server-scope write stores its level on the member row (`extra`); the
 * legacy column is no longer written (migration
 * notification_level_versions_backfill copied it into the counter, so the
 * counter is never below it).
 */
async function bumpPrefsVersion(executor: DatabaseExecutor, serverId: string, userId: string, extra: Partial<typeof serverMembers.$inferInsert> = {}) {
  const member = await readMemberLevel(executor, serverId, userId);
  if (!member) throw new NotificationLevelError(404, "Server not found");
  const [counter] = await executor
    .insert(userNotificationLevelVersions)
    .values({ userId, serverId, version: member.prefsVersion + 1 })
    .onConflictDoUpdate({
      target: [userNotificationLevelVersions.userId, userNotificationLevelVersions.serverId],
      set: {
        version: sql`GREATEST(${userNotificationLevelVersions.version} + 1, excluded.version)`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ version: userNotificationLevelVersions.version });
  const prefsVersion = counter!.version;
  if (Object.keys(extra).length === 0) return { prefsVersion, level: member.level };
  const [row] = await executor
    .update(serverMembers)
    .set(extra)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)))
    .returning({ level: serverMembers.serverPushMode });
  if (!row) throw new NotificationLevelError(404, "Server not found");
  return { prefsVersion, level: row.level };
}

async function readChannelLevel(executor: DatabaseExecutor, channelId: string, userId: string): Promise<NotificationLevel | null> {
  const [row] = await executor
    .select({ level: userChannelNotificationPrefs.level })
    .from(userChannelNotificationPrefs)
    .where(and(eq(userChannelNotificationPrefs.userId, userId), eq(userChannelNotificationPrefs.channelId, channelId)));
  return row?.level ?? null;
}

/** The channel's notification mute (activity_muted with push_muted; see loadNotificationPolicyPrefs). */
async function readMuted(executor: DatabaseExecutor, channelId: string, userId: string): Promise<boolean> {
  const [row] = await executor
    .select({ muted: sql<boolean>`${inboxTargetMuteStates.activityMuted} AND ${inboxTargetMuteStates.pushMuted}` })
    .from(inboxTargetMuteStates)
    .where(and(
      eq(inboxTargetMuteStates.receiverType, "user"),
      eq(inboxTargetMuteStates.receiverId, userId),
      eq(inboxTargetMuteStates.sourceChannelId, channelId),
    ));
  return row?.muted === true;
}

async function readThreadFollow(executor: DatabaseExecutor, threadChannelId: string, userId: string) {
  const [row] = await executor
    .select({ reason: threadFollows.reason, unfollowedAt: threadFollows.unfollowedAt })
    .from(threadFollows)
    .where(and(eq(threadFollows.threadChannelId, threadChannelId), eq(threadFollows.followerType, "user"), eq(threadFollows.followerId, userId)));
  return row ?? null;
}

/** A readable, live conversation of the right kind for the scope, or a 404 / 400. */
async function resolveConversation(scope: "channel" | "thread", id: string, userId: string, accessChecked = false) {
  const channel = await channelService.getChannel(id);
  if (!channel) throw new NotificationLevelError(404, "Conversation not found");
  const isSub = channel.type === "thread" || channel.type === "task";
  if (scope === "thread" && !isSub) throw new NotificationLevelError(400, "Not a thread; use scope channel");
  if (scope === "channel" && isSub) throw new NotificationLevelError(400, "A thread; use scope thread");
  const member = await readMemberLevel(getDb(), channel.serverId, userId);
  if (!member) throw new NotificationLevelError(404, "Conversation not found");
  // The channel row is the authority for its server (asServerId at the row boundary).
  if (!accessChecked && !await channelService.canUserAccessChannel(channel.id, userId, asServerId(channel.serverId))) {
    throw new NotificationLevelError(404, "Conversation not found");
  }
  return { channel, member };
}

/**
 * The single level write path: PUT /notification-levels and the legacy server
 * notification-settings route for the server and channel scopes, and the
 * thread Follow / Unfollow routes (scope thread, `all` = follow, `mentions` =
 * unfollow). A thread has no level of its own: the thread scope only moves the
 * follow state, and thread_follows.notification_level is left as it is.
 */
export async function setLevel(input: SetLevelInput): Promise<SetLevelResult> {
  const { userId, scope, id, level, accessChecked = false } = input;
  const db = getDb();

  if (scope === "server") {
    if (!isNotificationLevel(level)) throw new NotificationLevelError(400, "A server level cannot be default");
    const member = await readMemberLevel(db, id, userId);
    if (!member) throw new NotificationLevelError(404, "Server not found");
    if (member.level === level) {
      return { scope, id, serverId: id, level, effective: level, muted: false, prefsVersion: member.prefsVersion, changed: false };
    }
    const row = await db.transaction((tx) => bumpPrefsVersion(tx, id, userId, { serverPushMode: level }));
    return { scope, id, serverId: id, level, effective: level, muted: false, prefsVersion: row.prefsVersion, changed: true };
  }

  if (scope === "channel") {
    const { channel, member } = await resolveConversation("channel", id, userId, accessChecked);
    const current = await readChannelLevel(db, id, userId);
    const muted = await readMuted(db, id, userId);
    const nextStored = level === "default" ? null : level;
    if (current === nextStored) {
      return {
        scope, id, serverId: channel.serverId, level,
        effective: resolveEffectiveLevel({ server: member.level, channel: nextStored, muted }),
        muted, prefsVersion: member.prefsVersion, changed: false,
      };
    }
    const row = await db.transaction(async (tx) => {
      const bumped = await bumpPrefsVersion(tx, channel.serverId, userId);
      if (nextStored === null) {
        await tx.delete(userChannelNotificationPrefs)
          .where(and(eq(userChannelNotificationPrefs.userId, userId), eq(userChannelNotificationPrefs.channelId, id)));
      } else {
        await tx.insert(userChannelNotificationPrefs)
          .values({ userId, channelId: id, serverId: channel.serverId, level: nextStored, prefsVersion: bumped.prefsVersion })
          .onConflictDoUpdate({
            target: [userChannelNotificationPrefs.userId, userChannelNotificationPrefs.channelId],
            set: { level: nextStored, serverId: channel.serverId, prefsVersion: bumped.prefsVersion, updatedAt: sql`now()` },
          });
      }
      return bumped;
    });
    return {
      scope, id, serverId: channel.serverId, level,
      effective: resolveEffectiveLevel({ server: row.level, channel: nextStored, muted }),
      muted, prefsVersion: row.prefsVersion, changed: true,
    };
  }

  // Thread or task conversation: Follow (`all`) / Unfollow (`mentions`) only.
  if (level !== "all" && level !== "mentions") throw new NotificationLevelError(400, "A thread has no notification level; follow or unfollow it");
  const { channel, member } = await resolveConversation("thread", id, userId, accessChecked);
  const parentChannelId = channel.parentChannelId;
  const [parentLevel, muted] = parentChannelId
    ? await Promise.all([readChannelLevel(db, parentChannelId, userId), readMuted(db, parentChannelId, userId)])
    : [null, false];
  const effectiveFor = (server: NotificationLevel) => resolveEffectiveLevel({ server, channel: parentLevel, muted });
  // Serialized per (thread, user) by an advisory lock: there may be no follow row to lock yet.
  const outcome = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`notification-thread-level:${id}:${userId}`}, 0))`);
    const before = await readThreadFollow(tx, id, userId);
    const following = before !== null && before.unfollowedAt === null;
    const followMatches = level === "all" ? following && before?.reason === "manual" : before !== null && !following;
    // A button press always runs its follow / unfollow (idempotent; it also
    // moves the read position, as it always did).
    if (followMatches && !input.button) return { written: false as const, ranFollow: false, followChanged: false };
    if (!await channelService.writeUserThreadFollowState(tx, userId, id, level === "all" ? "follow" : "unfollow")) {
      throw new NotificationLevelError(404, "Conversation not found");
    }
    if (followMatches) return { written: false as const, ranFollow: true, followChanged: false };
    return { written: true as const, ranFollow: true, followChanged: true, row: await bumpPrefsVersion(tx, channel.serverId, userId) };
  });

  // After commit, like the buttons always did: the read position moves. A
  // pending read mutation (202 to the client) leaves the committed level as is.
  let pending: CompatibilityReadMutationPendingError | null = null;
  if (outcome.ranFollow) {
    try {
      await channelService.markThreadReadAfterFollowChange(userId, id);
    } catch (error) {
      if (!(error instanceof CompatibilityReadMutationPendingError)) throw error;
      pending = error;
    }
  }
  const server = outcome.written ? outcome.row.level : member.level;
  return {
    scope, id, serverId: channel.serverId, level, effective: effectiveFor(server), muted,
    prefsVersion: outcome.written ? outcome.row.prefsVersion : member.prefsVersion,
    changed: outcome.written,
    ...(outcome.written ? { followChanged: outcome.followChanged } : {}),
    ...(pending ? { pendingRead: pending } : {}),
  };
}

/** Server level of every server the user is a member of (GET /me/notification-settings). */
export async function listServerLevels(userId: string): Promise<Array<{ serverId: string; level: NotificationLevel }>> {
  const rows = await getDb()
    .select({ serverId: serverMembers.serverId, level: serverMembers.serverPushMode })
    .from(serverMembers)
    .innerJoin(servers, eq(servers.id, serverMembers.serverId))
    .where(and(eq(serverMembers.userId, userId), ne(servers.kind, "joint_storage"), isNull(servers.deletedAt)))
    .orderBy(asc(serverMembers.joinedAt));
  return rows;
}

/**
 * Of these users, those who are members of two or more servers (joint storage
 * and deleted servers excluded, as listServerLevels): a notification names
 * its server only for them. One query per chunk of users.
 */
export async function loadMultiServerUserIds(
  executor: DatabaseExecutor,
  userIds: readonly string[],
): Promise<Set<string>> {
  const multi = new Set<string>();
  for (const chunk of chunks(unique(userIds), PG_MAX_BIND_PARAMETERS - 256)) {
    const rows = await executor
      .select({ userId: serverMembers.userId })
      .from(serverMembers)
      .innerJoin(servers, eq(servers.id, serverMembers.serverId))
      .where(and(inArray(serverMembers.userId, chunk), ne(servers.kind, "joint_storage"), isNull(servers.deletedAt)))
      .groupBy(serverMembers.userId)
      .having(sql`count(distinct ${serverMembers.serverId}) >= 2`);
    for (const row of rows) multi.add(row.userId);
  }
  return multi;
}

/**
 * One user's stored level setting per conversation, for the channel / DM /
 * thread payloads (`notificationLevel`): channels by their explicit row,
 * `default` otherwise; threads are always `default` (a thread has no level,
 * the field stays for older clients). Chunked for the bind limit.
 */
export async function loadConversationLevelSettings(
  userId: string,
  ids: { channelIds?: readonly string[]; threadChannelIds?: readonly string[] },
  executor: DatabaseExecutor = getDb(),
): Promise<{ channel: Map<string, NotificationLevelSetting>; thread: Map<string, NotificationLevelSetting> }> {
  const channel = new Map<string, NotificationLevelSetting>();
  const thread = new Map<string, NotificationLevelSetting>();
  for (const chunk of chunks(unique(ids.channelIds ?? []), PG_MAX_BIND_PARAMETERS - 256)) {
    const rows = await executor
      .select({ channelId: userChannelNotificationPrefs.channelId, level: userChannelNotificationPrefs.level })
      .from(userChannelNotificationPrefs)
      .where(and(eq(userChannelNotificationPrefs.userId, userId), inArray(userChannelNotificationPrefs.channelId, chunk)));
    for (const row of rows) channel.set(row.channelId, row.level);
  }
  // A thread has no level: every thread reads as `default`.
  for (const id of unique(ids.threadChannelIds ?? [])) thread.set(id, "default");
  return { channel, thread };
}

/** Adds `notificationLevel` to channel-shaped payload items (threads and task conversations: always `default`). */
export async function withNotificationLevels<T extends { id: string; type?: string | null }>(
  userId: string,
  items: readonly T[],
): Promise<Array<T & { notificationLevel: NotificationLevelSetting }>> {
  const isSub = (item: T) => item.type === "thread" || item.type === "task";
  const levels = await loadConversationLevelSettings(userId, {
    channelIds: items.filter((item) => !isSub(item)).map((item) => item.id),
    threadChannelIds: items.filter(isSub).map((item) => item.id),
  });
  return items.map((item) => ({
    ...item,
    notificationLevel: (isSub(item) ? levels.thread.get(item.id) : levels.channel.get(item.id)) ?? "default",
  }));
}

export interface ServerLevelsSnapshot {
  serverId: string;
  server: NotificationLevel;
  channels: Array<{ id: string; level: NotificationLevel }>;
  threads: Array<{ id: string; level: NotificationLevel }>;
  prefsVersion: number;
}

/** Explicit levels in one server (GET /notification-levels); null when not a member. */
export async function getServerLevels(userId: string, serverId: string): Promise<ServerLevelsSnapshot | null> {
  const db = getDb();
  const member = await readMemberLevel(db, serverId, userId);
  if (!member) return null;
  const channelRows = await db
    .select({ id: userChannelNotificationPrefs.channelId, level: userChannelNotificationPrefs.level })
    .from(userChannelNotificationPrefs)
    .innerJoin(channels, eq(channels.id, userChannelNotificationPrefs.channelId))
    .where(and(eq(userChannelNotificationPrefs.userId, userId), eq(userChannelNotificationPrefs.serverId, serverId), isNull(channels.deletedAt)))
    .orderBy(asc(userChannelNotificationPrefs.channelId));
  // A thread has no level; `threads` stays (always empty) for older clients.
  const threads: Array<{ id: string; level: NotificationLevel }> = [];
  return { serverId, server: member.level, channels: channelRows, threads, prefsVersion: member.prefsVersion };
}

// ---------------------------------------------------------------------------
// Sync (notification_prefs:updated, contract §2.3)
// ---------------------------------------------------------------------------

export function serverLevelPrefs(level: NotificationLevel) {
  return { serverPushMuted: level === "none", serverPushMentionsOnly: level === "mentions", serverPushMode: level };
}

export type NotificationPrefsUpdatedPayload =
  | { type: "account"; settings: NotificationAccountSettings }
  | { type: "server"; serverId: string; scopeId: string; level: NotificationLevel; prefs: ReturnType<typeof serverLevelPrefs>; prefsVersion: number }
  | { type: "channel" | "thread"; serverId: string; scopeId: string; level: NotificationLevelSetting; prefsVersion: number };

export function levelUpdatedPayload(result: SetLevelResult): NotificationPrefsUpdatedPayload {
  if (result.scope === "server") {
    const level = result.level as NotificationLevel;
    return { type: "server", serverId: result.serverId, scopeId: result.id, level, prefs: serverLevelPrefs(level), prefsVersion: result.prefsVersion };
  }
  return { type: result.scope, serverId: result.serverId, scopeId: result.id, level: result.level, prefsVersion: result.prefsVersion };
}

/** After setLevel: the prefs event (when something changed) and, when the follow state moved, the followers event. */
export async function emitLevelChange(io: SocketServer | undefined, userId: string, result: SetLevelResult): Promise<void> {
  if (result.changed) emitNotificationPrefsUpdated(io, userId, levelUpdatedPayload(result));
  if (result.followChanged) await emitThreadFollowersUpdated(io, result.id);
}

/** Emits to the user's sockets (honors the receiver-state push kill switch). */
export function emitNotificationPrefsUpdated(io: SocketServer | undefined, userId: string, payload: NotificationPrefsUpdatedPayload): void {
  if (!io || !isReceiverStatePushEnabled()) return;
  io.to(`user:${userId}`).emit("notification_prefs:updated", payload);
}
