// The unified notification HTTP API (docs/contracts/notifications.md §2, §6).
// Thin typed wrappers; every caller goes through these so the wire shapes
// live in one place.

import {
  isNotificationLevel,
  isNotificationLevelSetting,
  isNotificationMobileDelay,
  isNotificationPreviewMode,
} from "@botiverse/raft-shared";
import type {
  NotificationAccountSettings,
  NotificationLevel,
  NotificationLevelScope,
  NotificationLevelSetting,
  NotificationTestDeviceKind,
  NotificationTestStatus,
} from "@botiverse/raft-shared";
import api from "../api/client";

export interface ServerLevelRow {
  serverId: string;
  level: NotificationLevel;
}

export interface AccountNotificationSettingsResponse {
  settings: NotificationAccountSettings;
  servers: ServerLevelRow[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isMinute = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1439;

/** Closed parse of NotificationAccountSettings; null when malformed. */
export function parseNotificationAccountSettings(value: unknown): NotificationAccountSettings | null {
  if (!isRecord(value)) return null;
  const quiet = value.quietHours;
  if (!isRecord(quiet)) return null;
  if (typeof quiet.enabled !== "boolean" || !isMinute(quiet.startMinute) || !isMinute(quiet.endMinute) || typeof quiet.timeZone !== "string") return null;
  if (value.pausedUntil !== null && typeof value.pausedUntil !== "string") return null;
  if (!isNotificationPreviewMode(value.previewMode) || typeof value.sound !== "boolean") return null;
  if (typeof value.version !== "number" || !Number.isSafeInteger(value.version) || value.version < 0) return null;
  return {
    pausedUntil: value.pausedUntil,
    quietHours: { enabled: quiet.enabled, startMinute: quiet.startMinute, endMinute: quiet.endMinute, timeZone: quiet.timeZone },
    previewMode: value.previewMode,
    sound: value.sound,
    // Added in contract v1.1; an older server sends none (its behaviour is `inactive`).
    mobileDelay: isNotificationMobileDelay(value.mobileDelay) ? value.mobileDelay : "inactive",
    // Added in contract v1.2; an older server sends none (its behaviour is on).
    followedThreadReplies: value.followedThreadReplies !== false,
    version: value.version,
  };
}

function parseServerLevels(value: unknown): ServerLevelRow[] {
  if (!Array.isArray(value)) return [];
  const rows: ServerLevelRow[] = [];
  for (const row of value) {
    if (isRecord(row) && typeof row.serverId === "string" && isNotificationLevel(row.level)) {
      rows.push({ serverId: row.serverId, level: row.level });
    }
  }
  return rows;
}

export async function fetchAccountNotificationSettings(): Promise<AccountNotificationSettingsResponse | null> {
  const { data } = await api.get("/me/notification-settings", { headers: { "X-Server-Id": false } });
  const settings = parseNotificationAccountSettings(isRecord(data) ? data.settings : null);
  if (!settings) return null;
  return { settings, servers: parseServerLevels(isRecord(data) ? data.servers : null) };
}

export type AccountNotificationSettingsPatch = Partial<
  Pick<NotificationAccountSettings, "pausedUntil" | "quietHours" | "previewMode" | "sound" | "mobileDelay" | "followedThreadReplies" | "version">
>;

export type PatchAccountSettingsResult =
  | { kind: "ok"; settings: NotificationAccountSettings }
  | { kind: "conflict"; settings: NotificationAccountSettings | null }
  | { kind: "error" };

export async function patchAccountNotificationSettings(patch: AccountNotificationSettingsPatch): Promise<PatchAccountSettingsResult> {
  try {
    const { data } = await api.patch("/me/notification-settings", patch, { headers: { "X-Server-Id": false } });
    const settings = parseNotificationAccountSettings(isRecord(data) ? data.settings : null);
    return settings ? { kind: "ok", settings } : { kind: "error" };
  } catch (err) {
    const response = (err as { response?: { status?: number; data?: unknown } })?.response;
    if (response?.status === 409) {
      return { kind: "conflict", settings: parseNotificationAccountSettings(isRecord(response.data) ? response.data.settings : null) };
    }
    return { kind: "error" };
  }
}

export interface PutLevelResult {
  scope: NotificationLevelScope;
  id: string;
  serverId: string;
  level: NotificationLevelSetting;
  effective: NotificationLevel;
  muted: boolean;
  prefsVersion: number | null;
}

export async function putNotificationLevel(input: {
  scope: NotificationLevelScope;
  id: string;
  level: NotificationLevelSetting;
  /** The server the scope is in (sent as X-Server-Id; the route itself needs none). */
  serverId?: string;
}): Promise<PutLevelResult> {
  const { data } = await api.put(
    "/notification-levels",
    { scope: input.scope, id: input.id, level: input.level },
    input.serverId ? { headers: { "X-Server-Id": input.serverId } } : undefined,
  );
  const record = isRecord(data) ? data : {};
  const level = isNotificationLevelSetting(record.level) ? record.level : input.level;
  return {
    scope: input.scope,
    id: input.id,
    serverId: typeof record.serverId === "string" ? record.serverId : input.serverId ?? "",
    level,
    effective: isNotificationLevel(record.effective) ? record.effective : (level === "default" ? "all" : level),
    muted: record.muted === true,
    prefsVersion: typeof record.prefsVersion === "number" && Number.isSafeInteger(record.prefsVersion) ? record.prefsVersion : null,
  };
}

export interface ServerExplicitLevels {
  serverId: string;
  server: NotificationLevel;
  channels: Record<string, NotificationLevel>;
  threads: Record<string, NotificationLevel>;
}

function explicitMap(value: unknown): Record<string, NotificationLevel> {
  const out: Record<string, NotificationLevel> = {};
  if (!Array.isArray(value)) return out;
  for (const row of value) {
    if (isRecord(row) && typeof row.id === "string" && isNotificationLevel(row.level)) out[row.id] = row.level;
  }
  return out;
}

export async function fetchServerExplicitLevels(serverId: string): Promise<ServerExplicitLevels | null> {
  const { data } = await api.get("/notification-levels", { headers: { "X-Server-Id": serverId } });
  if (!isRecord(data) || !isNotificationLevel(data.server)) return null;
  return {
    serverId,
    server: data.server,
    channels: explicitMap(data.channels),
    threads: explicitMap(data.threads),
  };
}

// ---------------------------------------------------------------------------
// Test notifications (§6)
// ---------------------------------------------------------------------------

export type NotificationTestDevice =
  | { kind: Extract<NotificationTestDeviceKind, "desktop">; socketId: string }
  | { kind: Extract<NotificationTestDeviceKind, "web">; endpoint: string };

export type StartTestResult =
  | { sent: true; testId: string }
  | { sent: false; testId: string | null; reason: string };

export async function startTestNotification(device: NotificationTestDevice): Promise<StartTestResult> {
  try {
    const { data } = await api.post("/notifications/test", { device });
    const record = isRecord(data) ? data : {};
    const testId = typeof record.testId === "string" ? record.testId : null;
    if (record.sent === true && testId) return { sent: true, testId };
    return { sent: false, testId, reason: typeof record.reason === "string" ? record.reason : "error" };
  } catch (err) {
    const data = (err as { response?: { data?: unknown } })?.response?.data;
    const reason = isRecord(data) && typeof data.reason === "string" ? data.reason
      : isRecord(data) && typeof data.error === "string" ? data.error
        : "error";
    return { sent: false, testId: null, reason };
  }
}

/** The client displayed (or failed to display) a test notification. Never throws. */
export async function ackTestNotification(testId: string, shown: boolean): Promise<void> {
  try {
    await api.post(`/notifications/test/${encodeURIComponent(testId)}/ack`, { shown });
  } catch {
    // The settings card times out to "not shown" on its own.
  }
}

export interface TestStatusResult {
  status: NotificationTestStatus;
  reason?: string;
}

export async function fetchTestNotificationStatus(testId: string): Promise<TestStatusResult | null> {
  try {
    const { data } = await api.get(`/notifications/test/${encodeURIComponent(testId)}`);
    if (!isRecord(data)) return null;
    const status = data.status;
    if (status !== "pending" && status !== "shown" && status !== "not_shown" && status !== "failed") return null;
    return { status, ...(typeof data.reason === "string" ? { reason: data.reason } : {}) };
  } catch {
    return null;
  }
}

export const TEST_NOTIFICATION_WAIT_MS = 15_000;
export const TEST_NOTIFICATION_POLL_MS = 1_000;

export type TestNotificationOutcome =
  | { state: "shown" }
  | { state: "not_shown" }
  /**
   * Delivered to this device, but the client cannot tell whether the OS showed
   * it (a Raft Desktop shell whose notifications.show() returns nothing). The
   * server contract has no such state (ack is {shown: boolean}): such a client
   * sends no ack, and the server's `not_shown` is read as this.
   */
  | { state: "unconfirmed" }
  | { state: "failed"; reason: string };

// Test notifications this page delivered but could not confirm
// (notificationGate: an older shell). Bounded, page-lifetime.
const unconfirmedTests = new Set<string>();

export function noteUnconfirmedTestNotification(testId: string): void {
  unconfirmedTests.add(testId);
  if (unconfirmedTests.size > 50) unconfirmedTests.delete(unconfirmedTests.values().next().value as string);
}

export function isUnconfirmedTestNotification(testId: string): boolean {
  return unconfirmedTests.has(testId);
}

export interface TestWaitDeps {
  /** The page delivered this test but could not confirm it (default: the gate's record). */
  isUnconfirmed?: (testId: string) => boolean;
  fetchStatus?: (testId: string) => Promise<TestStatusResult | null>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Sends a test notification to this device and waits up to 15 s for the
 * client's ack (contract §6): shown / sent-but-not-shown / failed.
 */
export async function runTestNotification(
  device: NotificationTestDevice,
  deps: TestWaitDeps & { start?: typeof startTestNotification } = {},
): Promise<TestNotificationOutcome> {
  const start = deps.start ?? startTestNotification;
  const fetchStatus = deps.fetchStatus ?? fetchTestNotificationStatus;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const isUnconfirmed = deps.isUnconfirmed ?? isUnconfirmedTestNotification;
  const started = await start(device);
  if (!started.sent) return { state: "failed", reason: started.reason };
  const testId = started.testId;
  const notShown = (): TestNotificationOutcome => (isUnconfirmed(testId) ? { state: "unconfirmed" } : { state: "not_shown" });
  const deadline = now() + TEST_NOTIFICATION_WAIT_MS;
  while (now() < deadline) {
    await sleep(TEST_NOTIFICATION_POLL_MS);
    // This device got it and cannot confirm: no ack will ever come, so say so now.
    if (isUnconfirmed(testId)) return { state: "unconfirmed" };
    const result = await fetchStatus(testId);
    if (!result || result.status === "pending") continue;
    if (result.status === "shown") return { state: "shown" };
    if (result.status === "failed") return { state: "failed", reason: result.reason ?? "error" };
    return notShown();
  }
  return notShown();
}
