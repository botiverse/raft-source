import assert from "node:assert/strict";
import test from "node:test";
import { createIntl } from "react-intl";

import {
  getBillingSeatCopyLabels,
  getBillingTotalSummaryLabels,
} from "../src/utils/billingSeatInput";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";

// Billing PR B2b part 4: the seat-copy and total-summary label GROUPS.
//
// WHY THIS FILE EXISTS — @Wug's review of #5788. I exempted these ids from the
// legacy-verbatim check and left a comment saying their behaviour was "pinned by
// billingSeatLabelGroups". THAT FILE DID NOT EXIST. The comment asserted coverage
// I had not written, so the exemption rested on nothing: every one of these
// strings could have been retranslated or swapped and the suite stayed green.
//
// That is the same over-exemption hole I had just flagged for
// `billing.billableSeats` — caught there by a guard, missed here because I wrote
// a claim instead of a test.
//
// So: both arms of every label are pinned below, taken from the pre-migration
// source (getBillingSeatCopyLabels / getBillingTotalSummaryLabels for English,
// SettingsPanel's inline `localized…Labels` objects for Chinese), including the
// composed {capacity} output in BOTH seat modes.

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;
const intls = {
  en: createIntl({ locale: "en", messages: en }),
  "zh-cn": createIntl({ locale: "zh-cn", messages: zh }),
};
const fmt = (loc: "en" | "zh-cn", id: string, v?: Record<string, unknown>) =>
  String(intls[loc].formatMessage({ id }, v as never));

/** field -> [English before migration, Chinese before migration] */
const MANAGE_SEATS: Record<string, readonly [string, string]> = {
  seatQuantityLabel: ["Total seats", "席位总数"],
  seatSummaryLabel: ["Seats after update", "更新后的席位"],
  billableSeatsSummaryLabel: ["Total seats after update", "更新后的席位总数"],
  capacitySummaryLabel: ["Capacity after update", "更新后的容量"],
};
const DEFAULT_MODE: Record<string, readonly [string, string]> = {
  seatQuantityLabel: ["Seats to buy", "要购买的席位"],
  seatSummaryLabel: ["Seats to buy", "要购买的席位"],
  billableSeatsSummaryLabel: ["Billable seats", "计费席位"],
  capacitySummaryLabel: ["Capacity", "容量"],
};

test("manage-seats labels render exactly what the old object held", () => {
  const ids = getBillingSeatCopyLabels("manageSeats") as unknown as Record<string, string>;
  for (const [field, [oldEn, oldZh]] of Object.entries(MANAGE_SEATS)) {
    assert.equal(fmt("en", ids[field]), oldEn, `${field}: English arm changed`);
    assert.equal(fmt("zh-cn", ids[field]), oldZh, `${field}: Chinese arm changed`);
  }
});

test("default-mode labels render exactly what the old object held", () => {
  const ids = getBillingSeatCopyLabels("default") as unknown as Record<string, string>;
  for (const [field, [oldEn, oldZh]] of Object.entries(DEFAULT_MODE)) {
    assert.equal(fmt("en", ids[field]), oldEn, `${field}: English arm changed`);
    assert.equal(fmt("zh-cn", ids[field]), oldZh, `${field}: Chinese arm changed`);
  }
});

test("the composed {capacity} help text matches the old template in both modes", () => {
  // Previously built by string interpolation:
  //   manage : `Enter the total seats to keep. ${capacityLabel}.`
  //   default: `${capacityLabel}.`
  //   zh     : `请输入要保留的席位总数。${capacityLabel}。` / `${capacityLabel}。`
  // The capacity phrase is itself translated now, so it arrives as an argument.
  const capEn = "up to 3 Humans or 1 Agent";
  const capZh = "最多 3 位人类成员或 1 个 Agent";

  const manage = getBillingSeatCopyLabels("manageSeats");
  assert.equal(
    fmt("en", manage.quantityHelpLabel, { capacity: capEn }),
    `Enter the total seats to keep. ${capEn}.`,
  );
  assert.equal(
    fmt("zh-cn", manage.quantityHelpLabel, { capacity: capZh }),
    `请输入要保留的席位总数。${capZh}。`,
  );

  const dflt = getBillingSeatCopyLabels("default");
  assert.equal(fmt("en", dflt.quantityHelpLabel, { capacity: capEn }), `${capEn}.`);
  assert.equal(fmt("zh-cn", dflt.quantityHelpLabel, { capacity: capZh }), `${capZh}。`);

  // zh ends with the full-width period; en with ASCII. Punctuation belongs to the
  // translation, which is the reason this is a message and not concatenation.
  assert.ok(zh[dflt.quantityHelpLabel].endsWith("。"), "zh must keep the full-width stop");
  assert.ok(en[dflt.quantityHelpLabel].endsWith("."), "en must keep the ASCII stop");
});

test("total-summary labels render exactly what the old object held", () => {
  const annual = getBillingTotalSummaryLabels("manageSeats", "annual");
  assert.equal(fmt("en", annual.currentTotalLabel!), "Current yearly total");
  assert.equal(fmt("zh-cn", annual.currentTotalLabel!), "当前年付总价");
  assert.equal(fmt("en", annual.totalLabel), "Total after update");
  assert.equal(fmt("zh-cn", annual.totalLabel), "更新后总价");

  const monthly = getBillingTotalSummaryLabels("manageSeats", "monthly");
  assert.equal(fmt("en", monthly.currentTotalLabel!), "Current monthly total");
  assert.equal(fmt("zh-cn", monthly.currentTotalLabel!), "当前月付总价");

  const dflt = getBillingTotalSummaryLabels("default", "monthly");
  assert.equal(dflt.currentTotalLabel, null, "checkout mode shows no current total");
  assert.equal(fmt("en", dflt.totalLabel), "Total");
  assert.equal(fmt("zh-cn", dflt.totalLabel), "总价");
});

test("the two modes stay distinct where they used to differ", () => {
  // manage vs default differed on four of five fields. Collapsing any of them
  // would show update-flow copy on the checkout flow, which reads as if the user
  // already has a subscription.
  const manage = getBillingSeatCopyLabels("manageSeats") as unknown as Record<string, string>;
  const dflt = getBillingSeatCopyLabels("default") as unknown as Record<string, string>;
  for (const field of ["seatQuantityLabel", "seatSummaryLabel", "billableSeatsSummaryLabel",
                       "capacitySummaryLabel", "quantityHelpLabel"]) {
    assert.notEqual(manage[field], dflt[field], `${field} must differ between the two modes`);
  }
});
