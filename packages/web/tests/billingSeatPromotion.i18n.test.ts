import assert from "node:assert/strict";
import test from "node:test";

import { createIntl, createIntlCache } from "react-intl";

import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";

// PR #5561 promotion surface ids: verbatim zh transfer pins. These values were
// reviewed as ZH_BILLING_COPY entries in the original PR and are carried here
// unchanged; the catalog-equivalence gate cannot verify them against the frozen
// legacy fixture because that map never shipped before the react-intl migration.

const cache = createIntlCache();
const intlFor = (locale: string, messages: Record<string, string>) =>
  createIntl({ locale, messages }, cache);

const CASES: Array<{ id: string; en: string; zh: string }> = [
  { id: "billing.reviewing", en: "Reviewing...", zh: "正在核对…" },
  { id: "billing.failedToPreviewSeatUpdate", en: "Failed to preview seat update", zh: "无法预览席位更新" },
  { id: "billing.promotionCodeOptional", en: "Promotion code (optional)", zh: "优惠码（可选）" },
  { id: "billing.enterACodeApprovedForExistingSeatUpdate", en: "Enter a code approved for existing seat updates.", zh: "请输入可用于现有订阅席位更新的优惠码。" },
  { id: "billing.appliedPromotion", en: "Applied promotion", zh: "已应用优惠" },
  { id: "billing.estimatedProratedCharge", en: "Estimated prorated charge", zh: "预计本次按比例计费" },
  { id: "billing.discount", en: "Discount", zh: "优惠" },
  { id: "billing.estimatedNextYearlyTotal", en: "Estimated next yearly total", zh: "预计下次年付总额" },
  { id: "billing.estimatedNextMonthlyTotal", en: "Estimated next monthly total", zh: "预计下次月付总额" },
  { id: "billing.thisStripeEstimateExpiresAfter5MinutesRe", en: "This Stripe estimate expires after 5 minutes. Reopen the review if it expires.", zh: "此 Stripe 估算 5 分钟后失效；若已失效，请重新打开确认页。" },
];

test("promotion ids render the reviewed copy verbatim in both locales", () => {
  const enIntl = intlFor("en", enMessages as Record<string, string>);
  const zhIntl = intlFor("zh-cn", zhMessages as Record<string, string>);
  for (const { id, en, zh } of CASES) {
    assert.equal(enIntl.formatMessage({ id }), en, `${id} en drifted from the reviewed copy`);
    assert.equal(zhIntl.formatMessage({ id }), zh, `${id} zh drifted from the reviewed copy`);
  }
});

test("promotion ids exist in both catalogs", () => {
  for (const { id } of CASES) {
    assert.ok(id in (enMessages as Record<string, string>), `${id} missing from en catalog`);
    assert.ok(id in (zhMessages as Record<string, string>), `${id} missing from zh catalog`);
  }
});
