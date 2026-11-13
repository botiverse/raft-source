// Settings search's matching and order (raft-design settings.md#searching-settings).
import assert from "node:assert/strict";
import { normalizeSettingsSearchText, searchSettings, settingsSearchAliases } from "../search/settingsSearchMatch";
import type { SearchableSetting } from "../search/settingsSearchMatch";
import { SETTINGS_SEARCH_INDEX } from "../search/settingsSearchCopy";

const setting = (id: string, fields: Partial<SearchableSetting>): SearchableSetting => ({
  id,
  page: "appearance",
  name: id,
  pageLabel: "Appearance",
  aliases: [],
  ...fields,
});

// In the list's order.
const SETTINGS: SearchableSetting[] = [
  setting("message-font-size", { name: "Message font size", description: "Text size of messages.", sectionLabel: "Appearance" }),
  setting("send-with", { name: "Send messages with", sectionLabel: "Message box", aliases: ["enter", "return", "send key"] }),
  setting("push-notifications", { page: "notifications", pageLabel: "Notifications", name: "Browser notifications", description: "Uses web push to send them.", sectionLabel: "This device", aliases: ["push"] }),
  setting("leave-server", { page: "server", pageLabel: "Server profile", name: "Leave server", description: "You will lose access to messages.", sectionLabel: "Danger zone", aliases: ["quit"] }),
];

const ids = (query: string) => searchSettings(SETTINGS, query).map((result) => result.setting.id);

test("names first, then other words, then descriptions, then page and section; the list's order within each", () => {
  // "message" is in a name, a name, and a description: the two names in list order, then the description.
  assert.deepEqual(ids("message"), ["message-font-size", "send-with", "leave-server"]);
  // "send" is a name ("Send messages with") before a description that also has it.
  assert.deepEqual(ids("send"), ["send-with", "push-notifications"]);
  // "push": another word for push notifications ranks before a description with it.
  assert.deepEqual(searchSettings(SETTINGS, "push").map((result) => [result.setting.id, result.field]), [
    ["push-notifications", "alias"],
  ]);
  assert.deepEqual(ids("danger"), ["leave-server"], "a section finds its settings");
  assert.equal(searchSettings(SETTINGS, "danger")[0].field, "where");
});

test("each kind of match outranks the next, against the list's order", () => {
  // In the list's order, each later setting matches by a stronger kind, so
  // the results run backwards: name, then other word, then description, then where.
  const list = [
    setting("where", { name: "Volume", sectionLabel: "Chime" }),
    setting("description", { name: "Sound", description: "Plays a chime." }),
    setting("alias", { name: "Send messages with", aliases: ["chime"] }),
    setting("name", { name: "Chime" }),
  ];
  assert.deepEqual(searchSettings(list, "chime").map((result) => [result.setting.id, result.field]), [
    ["name", "name"],
    ["alias", "alias"],
    ["description", "description"],
    ["where", "where"],
  ]);
});

test("another word that matched is the result's alias, so the row can show it", () => {
  const [result] = searchSettings(SETTINGS, "Return");
  assert.equal(result.setting.id, "send-with");
  assert.equal(result.field, "alias");
  assert.equal(result.alias, "return");
  assert.equal(searchSettings(SETTINGS, "font")[0].alias, undefined, "a name match has no alias");
});

test("case, full-width letters and extra spaces don't matter", () => {
  assert.deepEqual(ids("ENTER"), ["send-with"]);
  assert.deepEqual(ids("Ｅｎｔｅｒ"), ["send-with"], "full-width letters are the half-width ones (NFKC)");
  assert.deepEqual(ids("  message   font "), ["message-font-size"]);
  assert.equal(normalizeSettingsSearchText("  Ｓｅｎｄ　Key "), "send key", "an ideographic space is a space");
});

test("an empty or blank query finds nothing, and so does a word no setting has", () => {
  assert.deepEqual(ids(""), []);
  assert.deepEqual(ids("   "), []);
  assert.deepEqual(ids("launch"), []);
});

test("the other words are the display language's, then English, each once", () => {
  const aliases = { en: ["dark", "night"], "zh-cn": ["深色", "night"] };
  assert.deepEqual(settingsSearchAliases(aliases, "zh-cn"), ["深色", "night", "dark"]);
  assert.deepEqual(settingsSearchAliases(aliases, "ja"), ["dark", "night"], "a locale without its own list searches English");
  assert.deepEqual(settingsSearchAliases(aliases, "en"), ["dark", "night"]);
});

test("a cut description's words stay findable in each display locale: the index keeps them as other words", () => {
  // HelperText step 1 cut these rows' descriptions; a word from each, per locale, still finds it by its aliases.
  const words = (id: string, locale: string) => settingsSearchAliases(SETTINGS_SEARCH_INDEX.entries.find((entry) => entry.id === id)!.aliases, locale);
  const finds = (id: string, locale: string, query: string) =>
    searchSettings([setting(id, { name: id, aliases: words(id, locale) })], query).map((result) => result.field);
  const cases: Array<[string, string, string]> = [
    ["message-font-size", "zh-cn", "代码块"],
    ["message-font-size", "ja", "見出し"],
    ["hide-empty-sidebar-sections", "es", "mensajes directos"],
    ["timezone", "ru", "местное время"],
    ["translation-mode", "ko", "원문"],
    ["display-language", "pt-br", "interface"],
    ["single-sign-on", "zh-tw", "身分識別提供者"],
    ["live-agent-activity", "en", "above the composer"],
    ["show-agent-model", "en", "next to its name"],
    ["time-format", "zh-cn", "仅显示"],
  ];
  for (const [id, locale, query] of cases) assert.deepEqual(finds(id, locale, query), ["alias"], `${locale} "${query}" finds ${id}`);
});

test("the personal settings whose descriptions were cut stay findable by those words, in each display locale", () => {
  // HelperText step 1 (components/settings): Passkeys, Theme, Browser notifications, Notification preview, Sound
  // and Desktop app lost their descriptions; their key terms are the index's other words now.
  const words = (id: string, locale: string) => settingsSearchAliases(SETTINGS_SEARCH_INDEX.entries.find((entry) => entry.id === id)!.aliases, locale);
  const finds = (id: string, locale: string, query: string) =>
    searchSettings([setting(id, { name: id, aliases: words(id, locale) })], query).map((result) => result.field);
  const cases: Array<[string, string, string]> = [
    ["passkeys", "en", "screen lock"],
    ["passkeys", "ko", "화면 잠금"],
    ["theme", "ja", "ライト"],
    ["theme", "en", "follow your device"],
    ["push-notifications", "en", "web push"],
    ["push-notifications", "zh-tw", "網頁推播"],
    ["notification-preview", "es", "todos los dispositivos"],
    ["notification-sound", "pt-br", "som"],
    ["desktop-app", "ru", "компьютер"],
    ["desktop-app", "zh-cn", "桌面版"],
  ];
  for (const [id, locale, query] of cases) assert.deepEqual(finds(id, locale, query), ["alias"], `${locale} "${query}" finds ${id}`);
});
