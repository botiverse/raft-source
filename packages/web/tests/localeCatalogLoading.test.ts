import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { vi } from "vitest";
import { isTestPath } from "../scripts/testLocations";

// Every catalog, en included, is a separate chunk loaded when its locale is
// shown: en and zh-cn are complete and load alone, a partial locale loads en
// too. The test setup registers every catalog, so these cases import a fresh
// module instance to see the production starting state.

async function freshMessages() {
  vi.resetModules();
  return import("../src/i18n/messages");
}

test("nothing is loaded at first; a partial locale loads its catalog and en, once, then overlays en", async () => {
  const messages = await freshMessages();
  assert.equal(messages.isLocaleMessagesLoaded("en"), false);
  assert.equal(messages.isLocaleMessagesLoaded("ja"), false);
  assert.deepEqual(messages.catalogsFor("ja"), ["ja", "en"]);

  let notified = 0;
  const unsubscribe = messages.subscribeLocaleMessages(() => {
    notified += 1;
  });
  const load = messages.loadLocaleMessages("ja");
  await Promise.all([load, messages.loadLocaleMessages("ja")]);
  unsubscribe();

  assert.equal(notified, 2, "ja and en, each once, though asked for twice");
  assert.equal(messages.isLocaleMessagesLoaded("ja"), true);
  assert.equal(messages.isLocaleMessagesLoaded("en"), true, "en came with ja");
  assert.equal(messages.mergedMessages("ja")["common.confirm.cancel"], "キャンセル");
  assert.equal(messages.mergedMessages("ja"), messages.mergedMessages("ja"), "a stable object for IntlProvider");
  assert.equal(messages.isLocaleMessagesLoaded("ko"), false, "loading one locale leaves the others alone");
});

test("a Simplified Chinese reader loads zh-cn alone, never en", async () => {
  const messages = await freshMessages();
  assert.deepEqual(messages.catalogsFor("zh-cn"), ["zh-cn"]);
  await messages.loadLocaleMessages("zh-cn");
  assert.equal(messages.isLocaleMessagesLoaded("zh-cn"), true);
  assert.equal(messages.isLocaleMessagesLoaded("en"), false);
  assert.equal(messages.mergedMessages("zh-cn")["common.confirm.cancel"], "取消");
  assert.equal(messages.shownLocaleMessages().locale, "en", "nothing shown yet");
  messages.setShownLocale("zh-cn");
  assert.equal(messages.shownLocaleMessages().messages["common.confirm.cancel"], "取消", "words outside React follow the shown locale");
});

test("every display locale has a loader", async () => {
  const messages = await freshMessages();
  const { SUPPORTED_LOCALES } = await import("../src/i18n/locale");
  for (const locale of SUPPORTED_LOCALES) {
    await messages.loadLocaleMessages(locale);
    assert.equal(messages.isLocaleMessagesLoaded(locale), true, locale);
  }
});

test("app code never imports a catalog statically, en included", () => {
  // A static import pulls the catalog back into the app shell for every user.
  // `import type` is fine; the loader in messages/index.ts uses import().
  const srcRoot = resolve(import.meta.dirname, "../src");
  const files = (readdirSync(srcRoot, { recursive: true }) as string[])
    // Feature tests (src/features/<feature>/tests/) are test code, not the app.
    .filter((file) => /\.(?:ts|tsx)$/.test(file) && !isTestPath(`src/${file}`))
    .map((file) => resolve(srcRoot, file));
  const offenders = files.filter((file) =>
    /^import(?!\s+type)[^;]*from\s+["'][^"']*messages\/[a-z-]+["']/m.test(readFileSync(file, "utf8")));
  assert.deepEqual(offenders.map((file) => relative(srcRoot, file)), []);
});

test("a catalog that lacks an id renders the English for that id only", async () => {
  // Catalogs other than zh-cn are Partial: new English copy is backfilled later.
  const messages = await freshMessages();
  const { en } = await import("../src/i18n/messages/en");
  messages.registerLocaleMessages("en", en);
  messages.registerLocaleMessages("ja", { "common.confirm.cancel": "キャンセル" });
  const merged = messages.mergedMessages("ja");
  assert.equal(merged["common.confirm.cancel"], "キャンセル");
  const english = messages.mergedMessages("en")["common.confirm.somethingWentWrong"];
  assert.ok(english, "positive control: the id exists in en");
  assert.equal(merged["common.confirm.somethingWentWrong"], english);
});
