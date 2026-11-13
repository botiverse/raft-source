import assert from "node:assert/strict";
import { createIntl } from "react-intl";

import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";

// Billing PR B2b (part 1): the seat count label.
//
// It used to hand-roll an English plural inside a locale branch:
//   locale === "zh-CN" ? `${n} 个席位` : `${n} seat${n === 1 ? "" : "s"}`
//
// The plural rule was English-specific code. It is now one ICU message, so
// English gets its plural arm and Chinese needs none.

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;
const intls = {
  en: createIntl({ locale: "en", messages: en }),
  "zh-cn": createIntl({ locale: "zh-cn", messages: zh }),
};
const fmt = (loc: "en" | "zh-cn", id: string, v?: Record<string, unknown>) =>
  String(intls[loc].formatMessage({ id }, v as never));

test("seat counts pluralize in English and not in Chinese", () => {
  assert.equal(fmt("en", "billing.seatCount", { count: 1 }), "1 seat");
  assert.equal(fmt("en", "billing.seatCount", { count: 3 }), "3 seats");
  assert.equal(fmt("zh-cn", "billing.seatCount", { count: 1 }), "1 个席位");
  assert.equal(fmt("zh-cn", "billing.seatCount", { count: 3 }), "3 个席位");
});

test("zh carries no English plural arm", () => {
  assert.ok(!/\bone\s*\{/.test(zh["billing.seatCount"]), "billing.seatCount: zh must not copy an English one-arm");
  assert.match(en["billing.seatCount"], /\{count, plural,/, "en seatCount must be an ICU plural");
});
