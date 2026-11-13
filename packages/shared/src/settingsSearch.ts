/**
 * The settings a Settings search finds (raft-design
 * design/products/raft-chat/settings.md#searching-settings) on the web and in
 * the desktop app: settingsSearch.v1.json. The App keeps its own index, with
 * the same id for the same setting (artin, #proj-raft-ui:#204).
 *
 * The file holds where a setting is and the other words for it; its name,
 * description, section and page are the web's own strings, looked up by id.
 */
import { DISPLAY_LOCALES } from "./displayLocales";
import type { DisplayLocale } from "./displayLocales";

export const SETTINGS_SEARCH_PLATFORMS = ["web", "desktop"] as const;
export type SettingsSearchPlatform = (typeof SETTINGS_SEARCH_PLATFORMS)[number];

export type SettingsSearchEntry = {
  /** Lowercase words joined by hyphens; on the web, the setting's anchor: /settings/<page>#<id>. */
  readonly id: string;
  /** The web settings slug. */
  readonly page: string;
  /** The section on the page, lowercase words joined by hyphens. */
  readonly section: string;
  /** Where it is: the web, the desktop app or both; each searches only its own. */
  readonly platforms: readonly SettingsSearchPlatform[];
  /** Not shown in results. */
  readonly experimental?: true;
  /** Other words people use for it, by display locale. `en` is always there and always searched. */
  readonly aliases: { readonly en: readonly string[] } & Partial<Record<DisplayLocale, readonly string[]>>;
};

export type SettingsSearchIndex = {
  readonly contract: "settings-search.v1";
  readonly schemaVersion: 1;
  readonly notes: string;
  readonly entries: readonly SettingsSearchEntry[];
};

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** What is wrong with a parsed index, one line each; empty when it is valid. */
export function settingsSearchIndexIssues(index: SettingsSearchIndex): string[] {
  const issues: string[] = [];
  if (index.contract !== "settings-search.v1") issues.push(`contract is ${String(index.contract)}`);
  if (index.schemaVersion !== 1) issues.push(`schemaVersion is ${String(index.schemaVersion)}`);
  const seen = new Set<string>();
  for (const entry of index.entries) {
    const at = `entry ${entry.id}`;
    if (!SLUG.test(entry.id)) issues.push(`${at}: id is not lowercase words joined by hyphens`);
    if (seen.has(entry.id)) issues.push(`${at}: id is listed twice`);
    seen.add(entry.id);
    if (!SLUG.test(entry.page)) issues.push(`${at}: page is not a slug`);
    if (!SLUG.test(entry.section)) issues.push(`${at}: section is not a slug`);
    if (entry.platforms.length === 0) issues.push(`${at}: no platforms`);
    for (const platform of entry.platforms) {
      if (!SETTINGS_SEARCH_PLATFORMS.includes(platform)) issues.push(`${at}: unknown platform ${String(platform)}`);
    }
    if (entry.experimental !== undefined && entry.experimental !== true) issues.push(`${at}: experimental is only ever true`);
    if (!Array.isArray(entry.aliases.en)) issues.push(`${at}: no en aliases`);
    for (const [locale, words] of Object.entries(entry.aliases)) {
      if (!(DISPLAY_LOCALES as readonly string[]).includes(locale)) issues.push(`${at}: unknown locale ${locale}`);
      if (!Array.isArray(words) || words.some((word) => typeof word !== "string" || word.trim() === "" || word !== word.trim())) {
        issues.push(`${at}: ${locale} aliases must be trimmed, non-empty words`);
      }
    }
  }
  return issues;
}
