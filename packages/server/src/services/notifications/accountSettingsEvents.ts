// notification_settings_changed (cindyz, #proj-analytics:fbb8f05c): what a
// PATCH /api/me/notification-settings changed, one entry per setting. Pure, so
// the route records exactly what the write replaced.
import type { NotificationAccountSettings, ProductEventProperties } from "@botiverse/raft-shared";

export type AccountSettingChange = ProductEventProperties<"notification_settings_changed">;
type PauseLength = NonNullable<AccountSettingChange["pause_length"]>;

/** Bounds between the presets (30m, 1h, 2h, until 9:00 tomorrow = 9h to 33h). */
export function pauseLength(ms: number): PauseLength {
  const minutes = ms / 60_000;
  if (minutes <= 45) return "up_to_45m";
  if (minutes <= 90) return "45m_to_90m";
  if (minutes <= 180) return "90m_to_3h";
  if (minutes <= 36 * 60) return "3h_to_36h";
  return "over_36h";
}

function pausedAt(pausedUntil: string | null, now: number): number | null {
  if (!pausedUntil) return null;
  const at = Date.parse(pausedUntil);
  return Number.isFinite(at) && at > now ? at : null;
}

export function accountSettingChanges(
  previous: NotificationAccountSettings,
  next: NotificationAccountSettings,
  now: Date,
): AccountSettingChange[] {
  const changes: AccountSettingChange[] = [];
  const nowMs = now.getTime();
  if (next.pausedUntil !== previous.pausedUntil) {
    const until = pausedAt(next.pausedUntil, nowMs);
    const wasPaused = pausedAt(previous.pausedUntil, nowMs) !== null;
    // A new pause, a moved one (`edited`), or a resume of one still running;
    // clearing a pause that already ran out changes nothing a person sees.
    if (until !== null) changes.push({ setting: "pause", change: wasPaused ? "edited" : "on", pause_length: pauseLength(until - nowMs) });
    else if (wasPaused) changes.push({ setting: "pause", change: "off" });
  }
  const was = previous.quietHours;
  const quiet = next.quietHours;
  const windowMoved = was.startMinute !== quiet.startMinute || was.endMinute !== quiet.endMinute || was.timeZone !== quiet.timeZone;
  // Turned on or off, or a window moved while on (`edited`); a window edited while off does nothing.
  if (was.enabled !== quiet.enabled) changes.push({ setting: "quiet_hours", change: quiet.enabled ? "on" : "off" });
  else if (quiet.enabled && windowMoved) changes.push({ setting: "quiet_hours", change: "edited" });
  if (next.previewMode !== previous.previewMode) changes.push({ setting: "preview", preview: next.previewMode });
  if (next.sound !== previous.sound) changes.push({ setting: "sound", change: next.sound ? "on" : "off" });
  if (next.mobileDelay !== previous.mobileDelay) changes.push({ setting: "mobile_delay", mobile_delay: next.mobileDelay });
  return changes;
}
