/**
 * Which of a user's devices are in use (design §5.1, contract §1.3).
 *
 * Every client reports `presence:activity {active, idleSeconds, locked?,
 * attended?}` (desktops before the unified notifications send
 * `desktop:input-presence`, an alias). A computer counts as in use ("computer
 * active") while it had input within the active window and its screen is not
 * locked, whatever window has focus: Raft in the background on a computer in
 * use keeps the phone quiet. `attended` (Raft in front) is only the device's
 * own display gate and is never read here.
 * Per user and device kind one Redis hash `notif-presence:<uid>:<kind>` holds
 * one entry per socket: field = socket id, value = JSON
 * `{lastSeenAt, lastInputAt}`. Every write re-arms the whole key for
 * PRESENCE_ONLINE_TTL_MS. Each socket reports only for itself, so an idle
 * second tab or computer cannot clear the input of the one in use (D5: the
 * kind takes the maximum over its devices).
 *
 * - an entry is live while its lastSeenAt is under PRESENCE_ONLINE_TTL_MS old
 *   (older ones, e.g. a crashed replica's sockets, are ignored and pruned);
 * - a kind is online when it has a live entry;
 * - a kind is active when a live entry's last input is under
 *   ACTIVE_INPUT_WINDOW_MS old.
 *
 * Plan (planNotificationDevices): a computer in use alerts there (the desktop
 * app, or Web Push when no desktop app is online), and the phone follows the
 * "Phone alerts" setting; a phone in the foreground gets its in-app banner;
 * active nowhere, everything alerts (Web Push yields to an online desktop
 * app). A failed lookup fails open (nobody active, so everything alerts).
 */
import {
  ACTIVE_INPUT_WINDOW_MS,
  notificationMobileDelayMs,
  PRESENCE_FRESH_MS,
  PRESENCE_ONLINE_TTL_MS,
  type NotificationMobileDelay,
  type PresenceActivityReport,
} from "@botiverse/raft-shared";
import { getRedis, isRedisAvailable } from "../../redis";
import type {
  NotificationDeviceKind,
  NotificationDevicePlan,
  NotificationPresenceRecord,
  NotificationUserPresence,
} from "./types";

export const NOTIFICATION_PRESENCE_KINDS: readonly NotificationDeviceKind[] = ["desktop", "web", "mobile"];
const KEY_PREFIX = "notif-presence:";
// Replica clocks differ a little; a time further in the future is not trusted.
const CLOCK_SKEW_TOLERANCE_MS = 60 * 1000;
/** The entry of callers that report without a socket (tests, scripts). */
export const DEFAULT_PRESENCE_SOCKET_ID = "default";

export function notificationPresenceKey(userId: string, kind: NotificationDeviceKind): string {
  return `${KEY_PREFIX}${userId}:${kind}`;
}

// Single-replica fallback (dev, tests). Production always has Redis.
const localPresence = new Map<string, { entries: Map<string, NotificationPresenceRecord>; expiresAt: number }>();

function parseRecord(raw: string | null | undefined): NotificationPresenceRecord | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { lastSeenAt?: unknown; lastInputAt?: unknown; ackAlerts?: unknown; pushEndpointHash?: unknown };
    if (typeof value.lastSeenAt !== "number" || !Number.isFinite(value.lastSeenAt)) return null;
    const lastInputAt = typeof value.lastInputAt === "number" && Number.isFinite(value.lastInputAt) ? value.lastInputAt : null;
    return {
      lastSeenAt: value.lastSeenAt,
      lastInputAt,
      ...(value.ackAlerts === true ? { ackAlerts: true as const } : {}),
      ...(typeof value.pushEndpointHash === "string" ? { pushEndpointHash: value.pushEndpointHash } : {}),
    };
  } catch {
    return null;
  }
}

function isEntryLive(record: NotificationPresenceRecord, now: number): boolean {
  return record.lastSeenAt <= now + CLOCK_SKEW_TOLERANCE_MS && now - record.lastSeenAt < PRESENCE_ONLINE_TTL_MS;
}

/**
 * One kind's presence from its socket entries: the newest report and the
 * newest trusted input of the live entries; undefined when none is live.
 */
export function aggregatePresenceEntries(
  entries: Iterable<NotificationPresenceRecord & { socketId?: string }>,
  now: number,
): NotificationPresenceRecord | undefined {
  let result: { lastSeenAt: number; lastInputAt: number | null } | undefined;
  let active = 0;
  let acking = 0;
  let freshActive = 0;
  const hashes: string[] = [];
  const ackSocketIds: string[] = [];
  for (const entry of entries) {
    if (!isEntryLive(entry, now)) continue;
    // An input from a clock far ahead must not hide a real one.
    const inputAt = entry.lastInputAt !== null && entry.lastInputAt <= now + CLOCK_SKEW_TOLERANCE_MS ? entry.lastInputAt : null;
    if (inputAt !== null && now - inputAt < ACTIVE_INPUT_WINDOW_MS) {
      active += 1;
      if (entry.ackAlerts) {
        acking += 1;
        if (entry.socketId) ackSocketIds.push(entry.socketId);
      }
      if (now - entry.lastSeenAt < PRESENCE_FRESH_MS) freshActive += 1;
      if (entry.pushEndpointHash && !hashes.includes(entry.pushEndpointHash)) hashes.push(entry.pushEndpointHash);
    }
    if (!result) {
      result = { lastSeenAt: entry.lastSeenAt, lastInputAt: inputAt };
      continue;
    }
    result.lastSeenAt = Math.max(result.lastSeenAt, entry.lastSeenAt);
    if (inputAt !== null && (result.lastInputAt === null || inputAt > result.lastInputAt)) result.lastInputAt = inputAt;
  }
  if (!result) return undefined;
  return {
    ...result,
    ...(active > 0 && acking === active ? { confirmable: true as const } : {}),
    ...(ackSocketIds.length > 0 ? { ackSocketIds } : {}),
    ...(active > 0 && freshActive === 0 ? { stale: true as const } : {}),
    ...(hashes.length > 0 ? { pushEndpointHashes: hashes } : {}),
  };
}

/**
 * The last input time a report proves, or null when it proves none.
 *
 * - Computer-active protocol (`locked` present): derived from `idleSeconds`
 *   whenever the screen is not locked, regardless of focus, and also when it
 *   is past the active window (a `5m` / `10m` phone delay is measured from
 *   it). Locked, or idle unknown: null.
 * - Older clients and mobile (no `locked`): only an `active` report proves
 *   input, and only within the window (the behaviour before).
 */
export function reportedInputAt(report: PresenceActivityReport, now: number): number | null {
  if (typeof report.locked === "boolean") {
    if (report.locked || report.idleSeconds === null) return null;
    const idleMs = report.idleSeconds * 1000;
    if (!Number.isFinite(idleMs) || idleMs < 0) return null;
    return now - idleMs;
  }
  if (!report.active) return null;
  const idleMs = report.idleSeconds === null ? 0 : report.idleSeconds * 1000;
  if (!Number.isFinite(idleMs) || idleMs < 0 || idleMs >= ACTIVE_INPUT_WINDOW_MS) return null;
  return now - idleMs;
}

/** The report makes its device active now (input within the window, not locked). */
export function reportShowsActive(report: PresenceActivityReport, now: number): boolean {
  const inputAt = reportedInputAt(report, now);
  return inputAt !== null && now - inputAt < ACTIVE_INPUT_WINDOW_MS;
}

/**
 * Record one socket's report; it replaces that socket's entry only (its
 * latest report is the truth about its device). A report that is not active
 * (locked, idle past the window, older clients' `active: false`) makes that
 * device not active at once; other sockets of the kind are untouched.
 */
export async function recordPresenceActivity(
  userId: string,
  kind: NotificationDeviceKind,
  report: PresenceActivityReport,
  now: number = Date.now(),
  socketId: string = DEFAULT_PRESENCE_SOCKET_ID,
): Promise<void> {
  const key = notificationPresenceKey(userId, kind);
  const record: NotificationPresenceRecord = {
    lastSeenAt: now,
    lastInputAt: reportedInputAt(report, now),
    ...(report.ackAlerts ? { ackAlerts: true as const } : {}),
    ...(report.pushSubscribed !== false && report.pushEndpointHash ? { pushEndpointHash: report.pushEndpointHash } : {}),
  };
  if (isRedisAvailable()) {
    const results = await getRedis().multi()
      .hset(key, socketId, JSON.stringify(record))
      .pexpire(key, PRESENCE_ONLINE_TTL_MS)
      .exec();
    const failed = results?.find(([err]) => err);
    if (failed) throw failed[0];
    return;
  }
  const existing = localPresence.get(key);
  const entries = existing && existing.expiresAt > now ? existing.entries : new Map<string, NotificationPresenceRecord>();
  entries.set(socketId, record);
  localPresence.set(key, { entries, expiresAt: now + PRESENCE_ONLINE_TTL_MS });
}

/**
 * A socket went away: drop its entry. When it was the last one of the kind,
 * the kind is offline and inactive at once (an iOS app may lose its socket
 * before its `active: false` arrives).
 */
export async function removePresenceSocket(
  userId: string,
  kind: NotificationDeviceKind,
  socketId: string = DEFAULT_PRESENCE_SOCKET_ID,
  now: number = Date.now(),
): Promise<void> {
  const key = notificationPresenceKey(userId, kind);
  if (isRedisAvailable()) {
    // Redis deletes the hash with its last field.
    await getRedis().hdel(key, socketId);
    return;
  }
  const existing = localPresence.get(key);
  if (!existing) return;
  existing.entries.delete(socketId);
  if (existing.entries.size === 0 || existing.expiresAt <= now) localPresence.delete(key);
}

type RawEntries = Record<string, string> | null;

function readLocal(key: string, now: number): RawEntries {
  const existing = localPresence.get(key);
  if (!existing) return null;
  if (existing.expiresAt <= now) {
    localPresence.delete(key);
    return null;
  }
  const raw: Record<string, string> = {};
  for (const [socketId, record] of existing.entries) raw[socketId] = JSON.stringify(record);
  return raw;
}

function pruneStale(stale: Array<{ key: string; socketIds: string[] }>): void {
  if (stale.length === 0) return;
  if (!isRedisAvailable()) {
    for (const { key, socketIds } of stale) {
      const existing = localPresence.get(key);
      if (!existing) continue;
      for (const socketId of socketIds) existing.entries.delete(socketId);
      if (existing.entries.size === 0) localPresence.delete(key);
    }
    return;
  }
  try {
    const pipeline = getRedis().pipeline();
    for (const { key, socketIds } of stale) pipeline.hdel(key, ...socketIds);
    pipeline.exec().catch(() => {});
  } catch {
    // Best effort: a stale entry is ignored anyway and the key expires.
  }
}

/**
 * Presence of each user (one pipelined round trip for all users and kinds).
 * A user missing from the map had a failed lookup: callers fail open.
 */
export async function loadNotificationPresence(
  userIds: readonly string[],
  now: number = Date.now(),
): Promise<Map<string, NotificationUserPresence>> {
  const result = new Map<string, NotificationUserPresence>();
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return result;
  const keys = unique.flatMap((userId) => NOTIFICATION_PRESENCE_KINDS.map((kind) => notificationPresenceKey(userId, kind)));
  let values: Array<{ ok: true; raw: RawEntries } | { ok: false }>;
  try {
    if (isRedisAvailable()) {
      const pipeline = getRedis().pipeline();
      for (const key of keys) pipeline.hgetall(key);
      const replies = await pipeline.exec();
      if (!replies) throw new Error("presence pipeline aborted");
      values = keys.map((_, index) => {
        const [err, raw] = replies[index] ?? [new Error("missing reply"), null];
        if (err) {
          console.warn("[NotificationPresence] lookup failed for one key; notifying every device:", err.message);
          return { ok: false };
        }
        return { ok: true, raw: (raw as Record<string, string> | null) ?? null };
      });
    } else {
      values = keys.map((key) => ({ ok: true, raw: readLocal(key, now) }));
    }
  } catch (err) {
    console.warn("[NotificationPresence] lookup failed; notifying every device:", err instanceof Error ? err.message : String(err));
    return result;
  }
  const stale: Array<{ key: string; socketIds: string[] }> = [];
  unique.forEach((userId, userIndex) => {
    const presence: NotificationUserPresence = {};
    let failed = false;
    NOTIFICATION_PRESENCE_KINDS.forEach((kind, kindIndex) => {
      const index = userIndex * NOTIFICATION_PRESENCE_KINDS.length + kindIndex;
      const value = values[index]!;
      if (!value.ok) {
        failed = true;
        return;
      }
      if (!value.raw) return;
      const records: Array<NotificationPresenceRecord & { socketId: string }> = [];
      const staleIds: string[] = [];
      for (const [socketId, raw] of Object.entries(value.raw)) {
        const record = parseRecord(raw);
        // Only entries that aged out are pruned; one from a clock ahead stays.
        if (!record || now - record.lastSeenAt >= PRESENCE_ONLINE_TTL_MS) staleIds.push(socketId);
        if (record) records.push({ ...record, socketId });
      }
      if (staleIds.length > 0) stale.push({ key: keys[index]!, socketIds: staleIds });
      const aggregate = aggregatePresenceEntries(records, now);
      if (aggregate) presence[kind] = aggregate;
    });
    if (!failed) result.set(userId, presence);
  });
  pruneStale(stale);
  return result;
}

export function isPresenceOnline(record: NotificationPresenceRecord | undefined, now: number): boolean {
  return Boolean(record) && isEntryLive(record!, now);
}

export function isPresenceActive(record: NotificationPresenceRecord | undefined, now: number): boolean {
  return Boolean(record)
    && record!.lastInputAt !== null
    && record!.lastInputAt <= now + CLOCK_SKEW_TOLERANCE_MS
    && now - record!.lastInputAt < ACTIVE_INPUT_WINDOW_MS;
}

/**
 * Whether an alert can actually reach each computer path right now. A path
 * that cannot deliver never counts as "the computer in use" for keeping the
 * phone quiet: a message must never alert nowhere.
 */
export interface NotificationDeliverability {
  /**
   * pushEndpointHash() of the user's stored Web Push subscriptions (empty
   * when Web Push is not configured). A browser counts only when its own
   * reported endpoint is among them: per browser, not per user.
   */
  webPushEndpointHashes: ReadonlySet<string>;
  /** Desktop sockets can be reached (the socket server is up). */
  desktopSocket: boolean;
}

/** Fail-safe default: nothing on a computer is known to be deliverable, so the phone alerts. */
export const NO_COMPUTER_DELIVERY: NotificationDeliverability = { webPushEndpointHashes: new Set(), desktopSocket: false };

/** The computer paths of a kind that can deliver now (see NotificationDeliverability). */
function computerPathDeliverable(
  kind: "desktop" | "web",
  record: NotificationPresenceRecord | undefined,
  now: number,
  deliverable: NotificationDeliverability,
): boolean {
  if (!record) return false;
  if (kind === "web") return (record.pushEndpointHashes ?? []).some((hash) => deliverable.webPushEndpointHashes.has(hash));
  if (!deliverable.desktopSocket) return false;
  // A desktop whose active sockets all ack is judged by the ack itself (the
  // dispatcher waits for one from an active socket): a throttled hidden
  // renderer that reports late is not dropped while its user is reading.
  // An older client cannot ack: one of its active entries must be fresh
  // (a half-open socket or a crashed replica's entry stops reporting).
  return record.confirmable === true || record.stale !== true;
}

/**
 * A desktop app and a browser both active are taken for one computer (alert
 * once, on the desktop) unless the browser's input is newer than the
 * desktop's system input by more than this. The desktop's system input
 * includes the browser's on the same computer; its recorded time can lag by
 * a heartbeat (60 s) plus the shell's 30 s idle poll.
 */
export const SAME_COMPUTER_INPUT_SLACK_MS = 90 * 1000;

/**
 * The device plan (design §5.1, contract §1.3). `presence` undefined = the
 * lookup failed: fail open (nobody active, no desktop known online, so
 * everything alerts).
 *
 * Invariant: a message never alerts nowhere. A computer counts as in use
 * (and so may keep the phone quiet) only through a path that can deliver
 * there now (`deliverable`): the desktop app over a fresh socket entry, the
 * browser over a Web Push subscription of that very browser. A browser in
 * use without one does not count: the phone alerts. What the plan cannot
 * know (a half-open socket, a Web Push send that fails) the dispatcher
 * confirms after sending and alerts the phone when nothing was delivered.
 *
 * - Desktop app in use: alert it.
 * - Browser in use (deliverable): Web Push, unless a desktop app is in use on
 *   what looks like the same computer (SAME_COMPUTER_INPUT_SLACK_MS).
 * - A phone in the foreground: its alert goes (the app shows an in-app banner).
 * - Nothing (deliverable) in use: everything; Web Push yields to an online
 *   desktop app.
 *
 * The phone alert, unless the phone is in the foreground, follows the
 * "Phone alerts" setting (`mobileDelay`, contract §1.3):
 * - `inactive` (default): only when no computer is in use, decided now.
 * - `always`: always.
 * - `1m`-`10m`: once that long has passed since the last input on a
 *   deliverable computer; until then the plan carries `mobileDeferUntil`
 *   and the dispatcher holds the alert (re-checked at the due time,
 *   cancelled once read). Presence that failed to load never waits.
 */
export function planNotificationDevices(
  presence: NotificationUserPresence | undefined,
  now: number,
  mobileDelay: NotificationMobileDelay = "inactive",
  deliverable: NotificationDeliverability = NO_COMPUTER_DELIVERY,
): NotificationDevicePlan {
  const usable = (kind: NotificationDeviceKind) => presence !== undefined
    && isPresenceActive(presence[kind], now)
    && (kind === "mobile" || computerPathDeliverable(kind, presence[kind], now, deliverable));
  const activeKinds = NOTIFICATION_PRESENCE_KINDS.filter(usable);
  const desktopActive = activeKinds.includes("desktop");
  const webActive = activeKinds.includes("web");
  const mobileActive = activeKinds.includes("mobile");
  const webElsewhere = webActive && desktopActive
    && presence!.web!.lastInputAt! - presence!.desktop!.lastInputAt! > SAME_COMPUTER_INPUT_SLACK_MS;
  const base = { mobileSocket: true, activeKinds, mobileDeferUntil: null };
  const plan: NotificationDevicePlan = desktopActive || webActive || mobileActive
    ? { ...base, desktop: desktopActive, webPush: webActive && (!desktopActive || webElsewhere), mobileAlert: mobileActive }
    // Nothing in use: everywhere; the browser yields to the desktop app.
    : { ...base, desktop: true, webPush: !isPresenceOnline(presence?.desktop, now), mobileAlert: true };
  if (mobileActive || mobileDelay === "always") return { ...plan, mobileAlert: true };
  const delayMs = notificationMobileDelayMs(mobileDelay);
  if (delayMs === null || !presence) return plan;
  const lastComputerInputAt = lastComputerInput(presence, now, deliverable);
  if (lastComputerInputAt === null) return { ...plan, mobileAlert: true };
  const dueAt = lastComputerInputAt + delayMs;
  return dueAt > now
    ? { ...plan, mobileAlert: false, mobileDeferUntil: dueAt }
    : { ...plan, mobileAlert: true };
}

/**
 * The latest input on a computer that can be alerted (desktop app or web, per
 * `deliverable`), ignoring times from the future.
 */
export function lastComputerInput(
  presence: NotificationUserPresence,
  now: number,
  deliverable: NotificationDeliverability = NO_COMPUTER_DELIVERY,
): number | null {
  let latest: number | null = null;
  for (const kind of ["desktop", "web"] as const) {
    if (!computerPathDeliverable(kind, presence[kind], now, deliverable)) continue;
    const inputAt = presence[kind]?.lastInputAt ?? null;
    if (inputAt === null || inputAt > now + CLOCK_SKEW_TOLERANCE_MS) continue;
    if (latest === null || inputAt > latest) latest = inputAt;
  }
  return latest;
}

export function __resetNotificationPresenceForTests(): void {
  localPresence.clear();
}
