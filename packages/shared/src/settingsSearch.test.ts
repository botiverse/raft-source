import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { settingsSearchIndexIssues } from "./settingsSearch";
import type { SettingsSearchEntry, SettingsSearchIndex } from "./settingsSearch";

const here = dirname(fileURLToPath(import.meta.url));
const bytes = readFileSync(join(here, "settingsSearch.v1.json"));
const index = JSON.parse(bytes.toString("utf8")) as SettingsSearchIndex;

test("the index is valid", () => {
  assert.deepEqual(settingsSearchIndexIssues(index), []);
});

test("the checks catch what they guard", () => {
  const good: SettingsSearchEntry = { id: "theme", page: "appearance", section: "appearance", platforms: ["web"], aliases: { en: ["dark"] } };
  const issues = (entries: SettingsSearchEntry[]) => settingsSearchIndexIssues({ ...index, entries });
  assert.deepEqual(issues([good]), []);
  assert.match(issues([good, good]).join("\n"), /listed twice/);
  assert.match(issues([{ ...good, id: "Theme" }]).join("\n"), /lowercase words/);
  assert.match(issues([{ ...good, platforms: ["app" as never] }]).join("\n"), /unknown platform/);
  assert.match(issues([{ ...good, aliases: { en: [" dark"] } }]).join("\n"), /trimmed/);
  assert.match(issues([{ ...good, aliases: { en: [], xx: ["a"] } as never }]).join("\n"), /unknown locale/);
});

test("the web's entries are on web settings pages", () => {
  const webPages = new Set(["account", "language-region", "appearance", "notifications", "theme", "server-notifications", "server", "billing", "administration", "im-bridges", "integrations", "labs", "providers", "about", "feedback"]);
  for (const entry of index.entries) {
    assert.ok(webPages.has(entry.page), `${entry.id}: ${entry.page} is not a web settings page`);
  }
});
