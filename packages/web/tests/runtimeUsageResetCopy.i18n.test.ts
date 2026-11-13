import assert from "node:assert/strict";
import { test } from "vitest";
import { createIntl } from "react-intl";

import { mergedMessages } from "../src/i18n/messages";
import { formatRelativeTime } from "../src/utils/relativeTime";

// The usage card fills {reset} with a relative time, which already says "in"
// ("2 小时后", "2 小時後"), so the template must not say it again
// (it read "2 小时后后重置").
test("a usage window's reset reads the relative time once in Chinese", () => {
  const reset = new Date(Date.now() + 2 * 3_600_000 + 60_000).toISOString();
  for (const [locale, word] of [["zh-cn", "后"], ["zh-tw", "後"]] as const) {
    const intl = createIntl({ locale, defaultLocale: "en", messages: mergedMessages(locale) });
    const when = formatRelativeTime(reset, locale)!;
    assert.ok(when.endsWith(word), `${locale} relative time "${when}" should end with ${word}`);
    for (const id of ["machine.runtimeUsage.windowUsed", "machine.runtimeUsage.windowUsedUp"]) {
      const text = intl.formatMessage({ id }, { percent: 72, reset: when });
      assert.ok(text.includes(when), `${locale} ${id}: "${text}"`);
      assert.ok(!text.includes(`${word}${word}`), `${locale} ${id} doubles ${word}: "${text}"`);
    }
  }
});
