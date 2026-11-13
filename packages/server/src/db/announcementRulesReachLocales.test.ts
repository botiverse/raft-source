import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { DISPLAY_LOCALES } from "@botiverse/raft-shared";

// announcement_rules_reach hard-codes the display locales it recognises (0617
// shipped without 'ru'). The newest migration that defines the function must
// list exactly DISPLAY_LOCALES, so adding a language fails here until a
// migration redefines the function with it.
const drizzleDir = new URL("../../drizzle/", import.meta.url);

function latestDefinition(): { file: string; sql: string } {
  const files = readdirSync(drizzleDir)
    .filter((name) => /^\d{4}_.*\.sql$/.test(name))
    .sort();
  for (const file of files.reverse()) {
    const sql = readFileSync(new URL(file, drizzleDir), "utf8");
    if (/CREATE (OR REPLACE )?FUNCTION public\.announcement_rules_reach\(/.test(sql)) return { file, sql };
  }
  throw new Error("no migration defines public.announcement_rules_reach");
}

test("announcement_rules_reach recognises exactly DISPLAY_LOCALES", () => {
  const { file, sql } = latestDefinition();
  const lists = [...sql.matchAll(/display_language IN \(([^)]*)\)/g)].map((match) =>
    [...match[1].matchAll(/'([^']+)'/g)].map((locale) => locale[1]).sort(),
  );
  assert.ok(lists.length > 0, `${file}: no display_language list found`);
  const expected = [...DISPLAY_LOCALES].sort();
  for (const list of lists) assert.deepEqual(list, expected, `${file} locale list differs from DISPLAY_LOCALES`);
});
