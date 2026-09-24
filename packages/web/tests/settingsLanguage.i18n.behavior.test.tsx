import assert from "node:assert/strict";
import test from "node:test";
import "./helpers/domSetup";
import { createIntl } from "react-intl";

import {
  getTimezoneOptions,
  getTranslationLanguageOptions,
} from "../src/store/translationStore";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { mergedMessages } from "../src/i18n/messages";

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;

test("catalog pins settings-language MessageIds", () => {
  assert.equal(en["settings.language.browserLanguage"], "Browser language");
  assert.equal(en["settings.language.selectTimezone"], "Select timezone");
  assert.match(zh["settings.language.browserLanguage"], /\p{Script=Han}/u);
  assert.match(zh["settings.language.selectTimezone"], /\p{Script=Han}/u);
});

test("language and timezone option producers format through zh-cn", () => {
  const zhIntl = createIntl({
    locale: "zh-cn",
    defaultLocale: "en",
    messages: mergedMessages("zh-cn"),
  });
  const languages = getTranslationLanguageOptions(null, zhIntl.formatMessage);
  assert.equal(languages[0]?.label, zh["settings.language.browserLanguage"]);
  assert.doesNotMatch(languages[0]?.label ?? "", /Browser language/);

  const timezones = getTimezoneOptions(null, zhIntl.formatMessage);
  assert.equal(timezones[0]?.label, zh["settings.language.selectTimezone"]);
  assert.doesNotMatch(timezones[0]?.label ?? "", /Select timezone/);
});
