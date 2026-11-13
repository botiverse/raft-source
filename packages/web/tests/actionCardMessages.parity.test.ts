import assert from "node:assert/strict";
import { parse, TYPE } from "@formatjs/icu-messageformat-parser";
import type { MessageFormatElement } from "@formatjs/icu-messageformat-parser";

import { ACTION_CARD_MESSAGES, DISPLAY_LOCALES } from "@botiverse/raft-shared";
import type { ActionCardMessageEntry, DisplayLocale } from "@botiverse/raft-shared";

// The action-card string table (packages/shared/src/actionCardMessages.ts) is
// a copy of this package's catalogs: the server sends it inside each card.
// Every entry with a `source` must say exactly what that web id says in every
// locale, so a translation fixed here cannot drift from what cards show (the
// catalogs are the source of the cards' copy; the table mirrors them). The table's
// conversion, re-derived here from the ICU syntax tree: `<n>` rich-text tags
// dropped, `{arg}` kept, literal braces doubled, and a plural split into one
// key per branch (`#` -> `{arg}`); a locale whose plural lacks a branch has
// none in that key, a locale with no plural has its one text in every key.

async function catalog(locale: DisplayLocale): Promise<Partial<Record<string, string>>> {
  const module = await import(`../src/i18n/messages/${locale}.ts`) as Record<string, Partial<Record<string, string>>>;
  const [messages] = Object.values(module);
  return messages!;
}

function template(elements: MessageFormatElement[], branch: string | undefined, pound: string | null): string {
  return elements.map((element): string => {
    switch (element.type) {
      case TYPE.literal: return element.value.replaceAll("{", "{{").replaceAll("}", "}}");
      case TYPE.argument: return `{${element.value}}`;
      case TYPE.pound:
        assert.ok(pound, "# outside a plural");
        return `{${pound}}`;
      case TYPE.tag:
        assert.equal(element.value, "n", `a card cannot carry <${element.value}>`);
        return template(element.children, branch, pound);
      case TYPE.plural: {
        assert.ok(branch, "a plural message needs one table key per branch");
        assert.equal(Object.keys(element.options).some((option) => option.startsWith("=")), false, "exact plural branches are not split");
        const option = element.options[branch] ?? element.options.other!;
        return template(option.value, branch, element.value);
      }
      default:
        throw new Error(`ICU element ${element.type} has no action-card form`);
    }
  }).join("");
}

function pluralBranches(elements: MessageFormatElement[]): string[] | null {
  for (const element of elements) {
    if (element.type === TYPE.plural) return Object.keys(element.options);
    if (element.type === TYPE.tag) {
      const inner = pluralBranches(element.children);
      if (inner) return inner;
    }
  }
  return null;
}

const entries = Object.entries(ACTION_CARD_MESSAGES as Record<string, ActionCardMessageEntry>);

test("every action-card table entry is its web id's text, in every locale", async () => {
  const catalogs = Object.fromEntries(await Promise.all(DISPLAY_LOCALES.map(async (locale) => [locale, await catalog(locale)] as const)));
  let compared = 0;
  for (const [key, entry] of entries) {
    if (entry.source === null) continue;
    const expected: Record<string, string> = {};
    for (const locale of DISPLAY_LOCALES) {
      const raw = catalogs[locale]![entry.source];
      if (raw === undefined) continue;
      const elements = parse(raw);
      const branches = pluralBranches(elements);
      if (entry.branch && branches && !branches.includes(entry.branch)) continue;
      expected[locale] = template(elements, entry.branch, null);
    }
    assert.ok(expected.en, `${key}: ${entry.source} is not in the English catalog`);
    assert.deepEqual(entry.text, expected, `${key} drifted from ${entry.source}`);
    compared++;
  }
  assert.ok(compared >= 70, `compared ${compared} entries`);
});

test("a table key is its web id when that is an action-card key, else the id under actionCard.", () => {
  for (const [key, entry] of entries) {
    if (entry.source === null) continue;
    const base = entry.branch ? key.slice(0, -(entry.branch.length + 1)) : key;
    const expected = /^actionCard(\.[A-Za-z0-9_]{1,64}){1,6}$/.test(entry.source) ? entry.source : `actionCard.${entry.source}`;
    assert.equal(base, expected, key);
  }
});

test("a web plural is split into one key per `one`/`other` branch any locale has (and every English branch); other branches fall back to `other`", async () => {
  // actionCardPluralMsg picks the branch with each locale's own plural rules and
  // falls back to `<key>.other` when the table has no key for it. Russian
  // `few`/`many` therefore render the `other` text, which must read right for
  // any count (docs/frontend/i18n/ru.md).
  const catalogs = Object.fromEntries(await Promise.all(DISPLAY_LOCALES.map(async (locale) => [locale, await catalog(locale)] as const)));
  const sources = new Set(entries.flatMap(([, entry]) => (entry.source ? [entry.source] : [])));
  for (const source of sources) {
    const english = pluralBranches(parse(catalogs.en![source]!)) ?? [];
    const union = new Set(DISPLAY_LOCALES.flatMap((locale) => {
      const raw = catalogs[locale]![source];
      return raw === undefined ? [] : pluralBranches(parse(raw)) ?? [];
    }));
    const required = new Set([...english, ...[...union].filter((branch) => branch === "one" || branch === "other")]);
    const split = entries.filter(([, entry]) => entry.source === source).map(([, entry]) => entry.branch ?? "");
    if (union.size === 0) { assert.deepEqual(split, [""], source); continue; }
    for (const branch of required) assert.ok(split.includes(branch), `${source}: no key for the ${branch} branch`);
    for (const branch of split) assert.ok(union.has(branch), `${source}: ${branch} is no locale's branch`);
    assert.ok(split.includes("other"), `${source}: no other key to fall back to`);
  }
});
