import assert from "node:assert/strict";
import test from "node:test";
import { createIntl } from "react-intl";

import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";

// Billing PR B2b part 3: the seat-coverage sentences and the cancellation suffix.
//
// The coverage sentences were template literals inside a locale ternary, repeated
// at three call sites — so a copy change had to be made six times (two languages
// x three sites) and could silently miss one. They are one message each now.
//
// The cancellation suffix was a FRAGMENT appended after the interval label:
//   {label}{isCancelScheduled ? " · cancellation scheduled" : ""}
// The separator and the suffix position were fixed by code. It now takes the
// interval as an argument, so a translation can place both.

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;
const intls = {
  en: createIntl({ locale: "en", messages: en }),
  "zh-cn": createIntl({ locale: "zh-cn", messages: zh }),
};
const fmt = (loc: "en" | "zh-cn", id: string, v?: Record<string, unknown>) =>
  String(intls[loc].formatMessage({ id }, v as never));

test("the seat-coverage sentences render exactly what the templates produced", () => {
  assert.equal(
    fmt("en", "billing.keepAtLeastSeats", { min: 3 }),
    "Keep at least 3 seats to cover current server usage.",
  );
  assert.equal(
    fmt("zh-cn", "billing.keepAtLeastSeats", { min: 3 }),
    "至少保留 3 个席位以覆盖服务器当前用量。",
  );
  assert.equal(
    fmt("en", "billing.enterAtLeastSeats", { min: 5 }),
    "Enter at least 5 seats to cover current server usage.",
  );
  assert.equal(
    fmt("zh-cn", "billing.enterAtLeastSeats", { min: 5 }),
    "请输入至少 5 个席位以覆盖服务器当前用量。",
  );
});

test("keep and enter stay distinct messages", () => {
  // They differ by one verb and were separate ternary arms. Collapsing them onto
  // one id would show "Keep at least…" on the input-validation path, where the
  // user has not yet entered anything.
  assert.notEqual(en["billing.keepAtLeastSeats"], en["billing.enterAtLeastSeats"]);
  assert.notEqual(zh["billing.keepAtLeastSeats"], zh["billing.enterAtLeastSeats"]);
});

test("the cancellation suffix carries the interval, not a bare fragment", () => {
  assert.equal(
    fmt("en", "billing.intervalWithCancellationScheduled", { interval: "Monthly" }),
    "Monthly · cancellation scheduled",
  );
  assert.equal(
    fmt("zh-cn", "billing.intervalWithCancellationScheduled", { interval: "每月" }),
    "每月 · 已安排取消",
  );
  // The separator lives INSIDE the message. If it stayed in JSX, a language that
  // punctuates differently could not change it.
  for (const cat of [en, zh]) {
    assert.match(cat["billing.intervalWithCancellationScheduled"], /\{interval\}/);
    assert.match(cat["billing.intervalWithCancellationScheduled"], /·/);
  }
});
