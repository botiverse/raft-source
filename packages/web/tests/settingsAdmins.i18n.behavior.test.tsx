import assert from "node:assert/strict";
import test from "node:test";
import { createIntl } from "react-intl";

import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { mergedMessages } from "../src/i18n/messages";

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;

test("catalog pins admin principal agent suffix MessageId", () => {
  assert.equal(en["settings.admins.principalAgentSuffix"], "{name} · Agent");
  assert.match(en["settings.admins.principalAgentSuffix"], /\{name\}/);
  assert.match(zh["settings.admins.principalAgentSuffix"], /\{name\}/);
});

test("admin principal agent suffix formats under zh-cn", () => {
  const zhIntl = createIntl({
    locale: "zh-cn",
    defaultLocale: "en",
    messages: mergedMessages("zh-cn"),
  });
  assert.equal(
    zhIntl.formatMessage({ id: "settings.admins.principalAgentSuffix" }, { name: "Bot" }),
    zh["settings.admins.principalAgentSuffix"].replace("{name}", "Bot"),
  );
});
