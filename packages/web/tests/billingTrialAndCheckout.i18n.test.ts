import assert from "node:assert/strict";
import test from "node:test";
import { createIntl } from "react-intl";

import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";

// Billing PR B2b part 6: the trial-end sentence, the seat-coverage help text,
// and the checkout-button title.
//
// All three were locale ternaries around interpolated templates. The
// seat-coverage help also hand-rolled an English plural, and the checkout title
// nested a SECOND ternary for the billing interval (年付/月付 vs annual/monthly)
// inside the locale ternary.

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;
const intls = {
  en: createIntl({ locale: "en", messages: en }),
  "zh-cn": createIntl({ locale: "zh-cn", messages: zh }),
};
const fmt = (loc: "en" | "zh-cn", id: string, v?: Record<string, unknown>) =>
  String(intls[loc].formatMessage({ id }, v as never));

test("the trial sentence takes the date as pre-formatted text", () => {
  // The date is built with toLocaleDateString and an explicit `timeZone:
  // "Etc/GMT+12"` so the cutoff reads the same everywhere. ICU's own {date}
  // formatting cannot reproduce that timezone pin, so the caller formats it and
  // passes text — asserted here so nobody "improves" it into a date argument.
  assert.match(en["billing.trialActiveThrough"], /\{date\}/);
  assert.match(zh["billing.trialActiveThrough"], /\{date\}/);
  assert.ok(!/\{date,/.test(en["billing.trialActiveThrough"]), "must NOT be an ICU date argument");
  assert.ok(!/\{date,/.test(zh["billing.trialActiveThrough"]), "must NOT be an ICU date argument");

  assert.equal(
    fmt("en", "billing.trialActiveThrough", { date: "Aug 3, 2026" }),
    "Full-featured free trial remains active through Aug 3, 2026 in every time zone. "
      + "Paid plans begin after this global cutoff. All features currently unlocked — "
      + "enjoy unlimited computers, agents, channels, and message history while the trial lasts.",
  );
  assert.equal(
    fmt("zh-cn", "billing.trialActiveThrough", { date: "2026年8月3日" }),
    "全功能免费试用将在所有时区持续到 2026年8月3日。付费套餐将在这一全球截止时间后开始。"
      + "试用期间所有功能均已解锁，包括无限电脑、Agent、频道和消息历史。",
  );
});

test("the seat-coverage help pluralizes in English only", () => {
  assert.equal(
    fmt("en", "billing.seatCoverageHelp", { min: 1, price: 20 }),
    "Each seat covers 1 human or 10 agents. Current usage requires at least 1 seat. Each seat is $20/month.",
  );
  assert.equal(
    fmt("en", "billing.seatCoverageHelp", { min: 3, price: 20 }),
    "Each seat covers 1 human or 10 agents. Current usage requires at least 3 seats. Each seat is $20/month.",
  );
  assert.equal(
    fmt("zh-cn", "billing.seatCoverageHelp", { min: 3, price: 20 }),
    "每个席位可覆盖 1 位人类成员或 10 个 Agent。当前用量至少需要 3 个席位。每个席位每月 $20。",
  );
  assert.ok(!/plural/.test(zh["billing.seatCoverageHelp"]), "zh needs no plural");
});

test("the checkout title composes the interval from its own message", () => {
  // The interval word was a SECOND ternary nested inside the locale ternary.
  // It now reuses the existing billing.yearly / billing.monthly ids, so the
  // interval word cannot drift from the segmented control that shows it.
  const yearlyEn = fmt("en", "billing.yearly");
  const yearlyZh = fmt("zh-cn", "billing.yearly");
  assert.equal(
    fmt("en", "billing.startCheckoutTitle", { interval: yearlyEn, seats: 4 }),
    `Start ${yearlyEn} Pro checkout for 4 billable seats.`,
  );
  assert.equal(
    fmt("zh-cn", "billing.startCheckoutTitle", { interval: yearlyZh, seats: 4 }),
    `开始 Pro ${yearlyZh}结账，共 4 个计费席位。`,
  );
  // zh puts the interval AFTER "Pro" and en before "Pro checkout" — the argument
  // sits at different offsets, which is why it is an argument at all.
  assert.notEqual(
    en["billing.startCheckoutTitle"].indexOf("{interval}"),
    zh["billing.startCheckoutTitle"].indexOf("{interval}"),
  );
});
