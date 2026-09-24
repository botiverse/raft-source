export const TIME_FORMAT_PREFERENCES = ["12h", "24h"] as const;

export type TimeFormatPreference = typeof TIME_FORMAT_PREFERENCES[number];

export function normalizeTimeFormatPreference(value: unknown): TimeFormatPreference | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized === "12h" || normalized === "24h" ? normalized : null;
}

