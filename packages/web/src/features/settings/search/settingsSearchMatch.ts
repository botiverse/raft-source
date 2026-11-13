/**
 * Settings search's matching and order (raft-design
 * design/products/raft-chat/settings.md#searching-settings), pure: the
 * settings come in already in the words of the display language, in the
 * list's order, and only those the person can see.
 */

/** One setting as the search sees it: its own words, where it is, and the other words for it. */
export interface SearchableSetting {
  /** The index id, and the setting's anchor on its page. */
  readonly id: string;
  /** The settings slug of the page it is on. */
  readonly page: string;
  readonly name: string;
  readonly description?: string;
  readonly pageLabel: string;
  /** The section on the page; none where the page has no sections of its own. */
  readonly sectionLabel?: string;
  /** Other words for it: the display language's, then English. */
  readonly aliases: readonly string[];
}

/** What the query matched, in result order: names, then other words, then descriptions, then where it is. */
export type SettingsSearchField = "name" | "alias" | "description" | "where";

export interface SettingsSearchResult {
  readonly setting: SearchableSetting;
  readonly field: SettingsSearchField;
  /** The other word that matched, when `field` is "alias". */
  readonly alias?: string;
}

const FIELD_ORDER: Readonly<Record<SettingsSearchField, number>> = { name: 0, alias: 1, description: 2, where: 3 };

/**
 * The form both the query and the words are compared in: NFKC, so full-width
 * and half-width letters are the same ("Ｅｎｔｅｒ" is "Enter"); lower case;
 * one space for each run of white space, none at the ends.
 */
export function normalizeSettingsSearchText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function matchSetting(setting: SearchableSetting, query: string): Omit<SettingsSearchResult, "setting"> | null {
  const has = (text: string | undefined) => text !== undefined && normalizeSettingsSearchText(text).includes(query);
  if (has(setting.name)) return { field: "name" };
  const alias = setting.aliases.find((word) => has(word));
  if (alias !== undefined) return { field: "alias", alias };
  if (has(setting.description)) return { field: "description" };
  if (has(setting.sectionLabel ? `${setting.pageLabel} ${setting.sectionLabel}` : setting.pageLabel)) return { field: "where" };
  return null;
}

/**
 * The settings that match the query, in result order: those whose name has
 * it first, then those with another word that has it, then descriptions, then
 * page and section; within each, the list's order. An empty query finds
 * nothing (the list shows its groups instead).
 */
export function searchSettings(settings: readonly SearchableSetting[], query: string): SettingsSearchResult[] {
  const normalized = normalizeSettingsSearchText(query);
  if (!normalized) return [];
  const found: { result: SettingsSearchResult; index: number }[] = [];
  settings.forEach((setting, index) => {
    const match = matchSetting(setting, normalized);
    if (match) found.push({ result: { setting, ...match }, index });
  });
  found.sort((a, b) => FIELD_ORDER[a.result.field] - FIELD_ORDER[b.result.field] || a.index - b.index);
  return found.map(({ result }) => result);
}

/**
 * The other words to search for one display locale: that locale's own, then
 * English, which is always searched; each word once.
 */
export function settingsSearchAliases(
  aliases: { readonly en: readonly string[] } & Partial<Record<string, readonly string[]>>,
  locale: string,
): string[] {
  const words = [...(locale === "en" ? [] : aliases[locale] ?? []), ...aliases.en];
  return [...new Set(words)];
}
