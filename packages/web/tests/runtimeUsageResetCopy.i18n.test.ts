import assert from "node:assert/strict";
import { test } from "vitest";
import { createIntl } from "react-intl";

import { mergedMessages } from "../src/i18n/messages";
import { resetWhen } from "../src/components/machine/rack/rackResetText";

// The usage card fills {reset} with a relative time, which already says "in"
// ("2 小时后", "2 小時後"), so the template must not say it again
// (it read "2 小时后后重置").
test("a usage window's reset reads the relative time once in Chinese", () => {
  const now = Date.now();
  const reset = new Date(now + 2 * 3_600_000 + 60_000).toISOString();
  for (const [locale, word] of [["zh-cn", "后"], ["zh-tw", "後"]] as const) {
    const intl = createIntl({ locale, defaultLocale: "en", messages: mergedMessages(locale) });
    const when = resetWhen(reset, locale, now)!;
    assert.ok(when.endsWith(word), `${locale} relative time "${when}" should end with ${word}`);
    for (const id of ["machine.runtimeUsage.windowUsed", "machine.runtimeUsage.windowUsedUp"]) {
      const text = intl.formatMessage({ id }, { percent: 72, reset: when });
      assert.ok(text.includes(when), `${locale} ${id}: "${text}"`);
      assert.ok(!text.includes(`${word}${word}`), `${locale} ${id} doubles ${word}: "${text}"`);
    }
  }
});

// One word for a window's reset, used up or not: the card's rows, the cell's
// name for a used-up window and the pickers' line (it read
// "已用 85% · 6 天后重置" beside "已用完 · 6 天后恢复").
test("a usage window's reset is one word, used up or not, in the card, the cell and the pickers", () => {
  const resetWord = { en: "resets", "zh-cn": "重置", "zh-tw": "重設", ja: "リセット", ko: "초기화", "pt-br": "redefinição", es: "se restablece", ru: "сброс" } as const;
  for (const [locale, word] of Object.entries(resetWord)) {
    const intl = createIntl({ locale, defaultLocale: "en", messages: mergedMessages(locale as keyof typeof resetWord) });
    const texts = [
      intl.formatMessage({ id: "machine.runtimeUsage.windowUsed" }, { percent: 85, reset: "X" }),
      intl.formatMessage({ id: "machine.runtimeUsage.windowUsedUp" }, { reset: "X" }),
      intl.formatMessage({ id: "machine.rack.usedUpResets" }, { when: "X" }),
      // The pickers' line (bulk Change model, Move to another computer).
      intl.formatMessage({ id: "machine.detail.bulkModel.usageLimit" }, { plan: "Max", reset: "X" }),
      intl.formatMessage({ id: "machine.runtimeUsage.line.limit" }, { window: "5h", reset: "X" }),
    ];
    for (const text of texts) assert.ok(text.includes(word), `${locale}: "${text}" should say ${word}`);
  }
});
