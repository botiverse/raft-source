// Account preference validators shared by `PATCH /api/auth/me` (routes/auth.ts)
// and the personal assistant's `PATCH /internal/agent-api/assistant/owner-settings`
// (services/assistantOwnerSettingsService.ts), so both accept and refuse the
// same values with the same messages.
import { normalizeDisplayLocale } from "@botiverse/raft-shared";
import { parseIanaTimezone } from "./ianaTimezone";

// UI display language (app-chrome i18n). Validated against the DISPLAY locale
// taxonomy — the set the web app ships a catalog for (en | zh-cn | ja | ko) — NOT
// the message-translation taxonomy. Region/script variants normalize within a
// shipped base (en-US→en, zh-Hans→zh-cn, ja-JP→ja); anything we cannot render
// (fr, zh-tw, …) is rejected so we never persist a preference that silently
// no-ops on read.
export function parseDisplayLanguage(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "string") {
    throw new Error("displayLanguage must be a string or null");
  }
  const value = raw.trim();
  if (!value) return null;
  const normalized = normalizeDisplayLocale(value);
  if (!normalized) {
    throw new Error("displayLanguage must be a supported UI display locale");
  }
  return normalized;
}

export function parsePreferredTimezone(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "string") {
    throw new Error("preferredTimezone must be a string or null");
  }
  const value = raw.trim();
  if (!value) return null;
  return parseIanaTimezone(value, "preferredTimezone");
}
