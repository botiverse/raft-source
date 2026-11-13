// "Pause notifications" presets (design §4.3; the desktop tray's
// pause-notifications command). Pure: the caller PATCHes pausedUntil.

export type PausePreset = "30m" | "1h" | "2h" | "tomorrow";

export const PAUSE_PRESETS: readonly PausePreset[] = ["30m", "1h", "2h", "tomorrow"];

/** 09:00 local time on the next calendar day ("until tomorrow 9:00", even when it is before 9:00 today). */
export function nextMorningNine(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0, 0, 0);
}

export function pausedUntilForPreset(preset: PausePreset, now: Date): Date {
  switch (preset) {
    case "30m":
      return new Date(now.getTime() + 30 * 60_000);
    case "1h":
      return new Date(now.getTime() + 60 * 60_000);
    case "2h":
      return new Date(now.getTime() + 120 * 60_000);
    case "tomorrow":
      return nextMorningNine(now);
  }
}

/** The tray's `{type: "pause-notifications", minutes}` (number of minutes, or "tomorrow"). */
export function pausedUntilForMinutes(minutes: number | "tomorrow", now: Date): Date | null {
  if (minutes === "tomorrow") return nextMorningNine(now);
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) return null;
  return new Date(now.getTime() + Math.round(minutes) * 60_000);
}

export function isPausedNow(pausedUntil: string | null | undefined, now: number): boolean {
  if (!pausedUntil) return false;
  const at = Date.parse(pausedUntil);
  return Number.isFinite(at) && at > now;
}
