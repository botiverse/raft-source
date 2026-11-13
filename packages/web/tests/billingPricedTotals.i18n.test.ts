import assert from "node:assert/strict";
import { createIntl } from "react-intl";

import { getBillingSelectedTotalLabels } from "../src/utils/billingPricedTotals";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";

// Billing PR B2b, final slice: the PRICED totals ("$40 / year").
//
// These were the last strings in billing that were localized by SURGERY rather
// than by lookup: the getters returned finished English text, and SettingsPanel
// patched Chinese in afterwards with
//
//   label.replace(" / year", " / 年").replace(" / month", " / 月")
//
// which only works while the English happens to contain that exact substring —
// a silent no-op the day the getter's wording changes, with no test noticing.
// The period is now a translated part of the message and the amount is an ICU
// argument, so both arms come from the catalog.
//
// What this file pins: the rendered output of every priced total in both
// locales still equals what the old getter + replace() produced.

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;
const intls = {
  en: createIntl({ locale: "en", messages: en }),
  "zh-cn": createIntl({ locale: "zh-cn", messages: zh }),
};
const render = (loc: "en" | "zh-cn", total: { id: string; amount: string } | null) =>
  total == null ? null : String(intls[loc].formatMessage({ id: total.id }, { amount: total.amount }));

/** The exact formatter SettingsPanel passes in. */
const formatUsd = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2));

/** Reference implementation of the code being deleted, applied to the old English. */
const legacyZh = (oldEnglish: string) =>
  oldEnglish.replace(" / year", " / 年").replace(" / month", " / 月");

test("selected-total labels match the old strings in both locales", () => {
  const annual = getBillingSelectedTotalLabels("annual", 3, 20, 15, formatUsd);
  assert.equal(render("en", annual.totalLabel), "$45 / year");
  assert.equal(render("zh-cn", annual.totalLabel), legacyZh("$45 / year"));
  // The struck-through "original" price is the MONTHLY rate x12, not the annual.
  assert.equal(render("en", annual.originalLabel), "$720 / year");
  assert.equal(render("zh-cn", annual.originalLabel), legacyZh("$720 / year"));

  const monthly = getBillingSelectedTotalLabels("monthly", 3, 20, 15, formatUsd);
  assert.equal(render("en", monthly.totalLabel), "$60 / month");
  assert.equal(render("zh-cn", monthly.totalLabel), legacyZh("$60 / month"));
  assert.equal(monthly.originalLabel, null, "monthly shows no struck-through original");
});

test("billing selected totals show yearly discount against undiscounted annual price", () => {
  // Priced totals are {id, amount} now — the "/ month" period is a translated
  // part of the message instead of English text patched by replace() downstream.
  // The AMOUNTS are what this test is about, and they are unchanged; the rendered
  // strings are pinned by the test above.
  assert.deepEqual(getBillingSelectedTotalLabels("monthly", 3, 10, 105.6, formatUsd), {
    totalLabel: { id: "billing.perMonth", amount: "30" },
    originalLabel: null,
  });
  assert.deepEqual(getBillingSelectedTotalLabels("annual", 3, 10, 105.6, formatUsd), {
    totalLabel: { id: "billing.perYear", amount: "316.80" },
    originalLabel: { id: "billing.perYear", amount: "360" },
  });
});

test("non-integer amounts keep the caller's formatting", () => {
  // formatUsd is injected; the catalog must NOT reformat the number, or a
  // price like $12.50 would render as "12.5" through ICU's number formatter.
  const total = getBillingSelectedTotalLabels("monthly", 1, 12.5, 10, formatUsd).totalLabel;
  assert.equal(render("en", total), "$12.50 / month");
  assert.equal(render("zh-cn", total), "$12.50 / 月");
});

test("the amount is a plain string argument, not an ICU number", () => {
  // `{amount}` must stay a bare argument. `{amount, number}` would apply
  // locale grouping and drop the trailing zero the formatter deliberately kept.
  for (const id of ["billing.perYear", "billing.perMonth"]) {
    for (const [loc, table] of [["en", en], ["zh-cn", zh]] as const) {
      assert.ok(
        /\{amount\}/.test(table[id]),
        `${loc}/${id} must interpolate {amount} with no format specifier`,
      );
      assert.ok(table[id].startsWith("$"), `${loc}/${id} keeps the leading $`);
    }
  }
  assert.ok(zh["billing.perYear"].endsWith("/ 年"), "zh year period");
  assert.ok(zh["billing.perMonth"].endsWith("/ 月"), "zh month period");
});

test("the annual savings badge matches the old inline ternary", () => {
  const percent = 20;
  assert.equal(
    String(intls.en.formatMessage({ id: "billing.saveAnnualPercent" }, { percent })),
    "Save 20%",
  );
  assert.equal(
    String(intls["zh-cn"].formatMessage({ id: "billing.saveAnnualPercent" }, { percent })),
    "节省 20%",
  );
});

test("DELIBERATE DELTA: the settings tab title now follows the display locale", () => {
  // Not an equivalence case. Before this slice the billing tab title came from
  // billingText("Plan & billing"), which read the `?lang=` WebView param instead
  // of the react-intl locale — so it could disagree with every other tab title
  // on the same screen. @artin approved removing that mechanism outright
  // ("以前的那个可以去掉了"), so billing now resolves like every other tab.
  //
  // Both ids were byte-identical in both locales at migration time, which is why
  // the special case could collapse; pinned here so a future edit to one of them
  // is a visible decision rather than a silent divergence.
  for (const [loc, table] of [["en", en], ["zh-cn", zh]] as const) {
    assert.equal(
      table["settings.tabs.billingHeader"],
      table["billing.planBilling"],
      `${loc}: the tab title and the section heading have diverged — if that is ` +
        `intended, give the tab its own id rather than reintroducing a special case`,
    );
  }
  assert.equal(en["settings.tabs.billingHeader"], "Plan & billing");
  assert.equal(zh["settings.tabs.billingHeader"], "套餐与账单");
});
