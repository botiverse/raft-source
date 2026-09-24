export function parseDurationSeconds(input: string): number | null {
  const raw = input.trim();
  const match = /^(\d+)(s|m|h|d)?$/.exec(raw);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2] ?? "s";
  const multiplier = unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : 86400;
  const seconds = value * multiplier;
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return null;
  return seconds;
}
