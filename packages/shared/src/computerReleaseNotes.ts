// Release notes for the latest published Raft Computer version.
//
// Source of truth is the Hands release authority
// (`GET https://hands.build/public/v2/apps/raft-computer-cli/latest?channel=main`,
// `build.release_notes`), cached by the server next to `latestComputerVersion`
// and surfaced on `GET /api/servers/:id/machines` as
// `latestComputerReleaseNotes`. The notes are bilingual markdown bullet lists.
//
// The same normalizer validates both hops (Hands -> server, server -> web) so a
// malformed or oversized value is dropped instead of rendered.

import type { DisplayLocale } from "./displayLocales";

/** Locale keys as published by Hands (BCP 47 casing, not the web display locale). */
export const COMPUTER_RELEASE_NOTES_LOCALES = ["en", "zh-CN"] as const;
export type ComputerReleaseNotesLocale = (typeof COMPUTER_RELEASE_NOTES_LOCALES)[number];

/** Per-locale cap. Real notes are ~1 KB; anything far larger is not a changelog. */
export const COMPUTER_RELEASE_NOTES_MAX_CHARS = 16_000;
const COMPUTER_RELEASE_NOTES_MAX_VERSION_CHARS = 64;

export type ComputerReleaseNotes = {
  /** Computer version these notes describe. */
  version: string;
} & Partial<Record<ComputerReleaseNotesLocale, string>>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a version + locale->markdown map. Only non-empty string values for
 * known locales within the length cap survive; returns null when no locale does.
 */
export function normalizeComputerReleaseNotes(
  version: unknown,
  notes: unknown,
): ComputerReleaseNotes | null {
  if (typeof version !== "string") return null;
  const trimmedVersion = version.trim();
  if (!trimmedVersion || trimmedVersion.length > COMPUTER_RELEASE_NOTES_MAX_VERSION_CHARS) return null;
  if (!isPlainRecord(notes)) return null;
  const result: ComputerReleaseNotes = { version: trimmedVersion };
  let hasAny = false;
  for (const locale of COMPUTER_RELEASE_NOTES_LOCALES) {
    const value = notes[locale];
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (!text || text.length > COMPUTER_RELEASE_NOTES_MAX_CHARS) continue;
    result[locale] = text;
    hasAny = true;
  }
  return hasAny ? result : null;
}

/** Notes text for a UI locale: the matching language first, else whichever exists. */
export function pickComputerReleaseNotesText(
  notes: ComputerReleaseNotes | null | undefined,
  locale: DisplayLocale,
): string | null {
  if (!notes) return null;
  // Notes are written in en and zh-CN; a Traditional Chinese reader gets the Chinese.
  const preferred: ComputerReleaseNotesLocale = locale === "zh-cn" || locale === "zh-tw" ? "zh-CN" : "en";
  const fallback: ComputerReleaseNotesLocale = preferred === "en" ? "zh-CN" : "en";
  return notes[preferred] ?? notes[fallback] ?? null;
}
