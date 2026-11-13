// Server notification text in the display language (contract §1.5): the web
// catalogs carry every `push.*` key the server sends, with the server's
// English as en, and the localizer keeps the English whenever it cannot
// render a key.
import assert from "node:assert/strict";
import { DISPLAY_LOCALES, NOTIFICATION_COPY } from "@botiverse/raft-shared";
import { en } from "../src/i18n/messages/en";
import { setShownLocale } from "../src/i18n/messages";
import { localizeNotificationKey, localizeNotificationText } from "../src/notifications/localizeNotification";

const SERVER_KEYS = Object.keys(NOTIFICATION_COPY).sort();

afterEach(() => setShownLocale("en"));

test("en has exactly the server's push.* keys, each with the server's English template", () => {
  const ours = Object.keys(en).filter((id) => id.startsWith("push.")).sort();
  assert.deepEqual(ours, SERVER_KEYS);
  for (const key of SERVER_KEYS) {
    assert.equal((en as Record<string, string>)[key], NOTIFICATION_COPY[key as keyof typeof NOTIFICATION_COPY].en, key);
  }
});

test("every display locale translates every push.* key", async () => {
  for (const locale of DISPLAY_LOCALES) {
    const module = await import(`../src/i18n/messages/${locale}.ts`) as Record<string, Partial<Record<string, string>>>;
    const [catalog] = Object.values(module);
    const missing = SERVER_KEYS.filter((key) => !catalog[key]);
    assert.deepEqual(missing, [], locale);
  }
});

test("a key renders in the shown locale with its positional args", () => {
  assert.equal(localizeNotificationKey("push.title.thread_in_channel", ["eng"]), "Thread in #eng");
  setShownLocale("ja");
  assert.equal(localizeNotificationKey("push.title.thread_in_channel", ["eng"]), "#eng のスレッド");
  assert.equal(localizeNotificationKey("push.body.sender_attachments", ["Ann", "3"]), "Ann：添付ファイルを 3 件送信しました");
  setShownLocale("zh-cn");
  assert.equal(localizeNotificationKey("push.subtitle.dm_server", ["Acme"]), "私信 · Acme");
  // An arg is a name: never parsed as a message.
  assert.equal(localizeNotificationKey("push.preview.sender_only.message", ["{1} <b>"]), "{1} <b> 发来一条消息");
});

test("unknown keys, non-push ids and missing args keep the English", () => {
  assert.equal(localizeNotificationKey("push.title.from_the_future", []), null);
  assert.equal(localizeNotificationKey("settings.notifications.preview.title", []), null, "only push.* ids");
  assert.equal(localizeNotificationKey("push.body.sender_attachments", ["Ann"]), null, "{1} has no arg");

  setShownLocale("ko");
  const text = localizeNotificationText(
    { title: "Thread in #eng", subtitle: "Acme", body: "Ann: Sent an attachment" },
    { titleKey: "push.title.thread_in_channel", titleArgs: ["eng"], bodyKey: "push.body.sender_attachment", bodyArgs: [] },
  );
  assert.equal(text.subtitle, "Acme", "no subtitle key: the name as sent");
  assert.equal(text.body, "Ann: Sent an attachment", "an arg missing: the English");
  assert.deepEqual(localizeNotificationText({ title: "T", body: "B" }, undefined), { title: "T", body: "B" });
});
