import assert from "node:assert/strict";
import test from "node:test";
import { createIntl } from "react-intl";

import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { mergedMessages } from "../src/i18n/messages";

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;

test("catalog pins AI provider MessageIds", () => {
  assert.equal(en["settings.providers.openaiCompatible"], "OpenAI-compatible");
  assert.equal(en["settings.providers.anthropicCompatible"], "Anthropic-compatible");
  assert.equal(zh["settings.providers.openaiCompatible"], "OpenAI-compatible");
  assert.equal(zh["settings.providers.anthropicCompatible"], "Anthropic-compatible");
});

test("AI provider labels format under zh-cn", () => {
  const zhIntl = createIntl({
    locale: "zh-cn",
    defaultLocale: "en",
    messages: mergedMessages("zh-cn"),
  });
  assert.equal(zhIntl.formatMessage({ id: "settings.providers.openaiCompatible" }), "OpenAI-compatible");
  assert.equal(zhIntl.formatMessage({ id: "settings.providers.anthropicCompatible" }), "Anthropic-compatible");
});
