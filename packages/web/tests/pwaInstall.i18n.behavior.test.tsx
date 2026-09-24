import assert from "node:assert/strict";
import test from "node:test";
import { createIntl } from "react-intl";

import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { mergedMessages } from "../src/i18n/messages";

const zh = zhMessages as Record<string, string>;

test("pwa-install ids format under zh-cn", () => {
  const zhIntl = createIntl({
    locale: "zh-cn",
    defaultLocale: "en",
    messages: mergedMessages("zh-cn"),
  });
  assert.equal(
    zhIntl.formatMessage({ id: "pwa.install.addToHomeScreen" }),
    zh["pwa.install.addToHomeScreen"],
  );
  assert.doesNotMatch(
    zhIntl.formatMessage({ id: "pwa.install.safariSubtitle" }),
    /fullscreen app/,
  );
  assert.doesNotMatch(
    zhIntl.formatMessage({ id: "pwa.install.gotIt" }),
    /Got it/,
  );
});
