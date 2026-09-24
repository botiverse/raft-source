import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  applyBillingSeatInputChange,
  applyBillingSeatInputCommit,
  commitBillingSeatInputValue,
  getBillingCurrentTotalLabel,
  getBillingSeatCopyLabels,
  getBillingSeatDraftState,
  getBillingSelectedTotalLabels,
  getBillingSeatInputChange,
  getBillingSeatInputValue,
  getBillingTotalSummaryLabels,
  sanitizeBillingSeatInput,
} from "../src/utils/billingSeatInput";

const repoRoot = resolve(import.meta.dirname, "..");

function read(path: string) {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

test("billing seat input sanitizes typing without forcing cleared or lower fields back to a number", () => {
  assert.equal(sanitizeBillingSeatInput(""), "");
  assert.equal(sanitizeBillingSeatInput("12 agents"), "12");
  assert.equal(sanitizeBillingSeatInput("Stryker was here!"), "");

  assert.deepEqual(getBillingSeatInputChange(""), {
    inputValue: "",
    overrideValue: null,
  });
  assert.deepEqual(getBillingSeatInputChange("abc"), {
    inputValue: "",
    overrideValue: null,
  });
  assert.deepEqual(getBillingSeatInputChange("Stryker was here!"), {
    inputValue: "",
    overrideValue: null,
  });
  assert.deepEqual(getBillingSeatInputChange("2 humans"), {
    inputValue: "2",
    overrideValue: 2,
  });
  assert.deepEqual(getBillingSeatInputChange("25"), {
    inputValue: "25",
    overrideValue: 25,
  });
});

test("billing seat change application preserves numeric drafts and only skips empty drafts", () => {
  const inputValues: string[] = [];
  const overrideValues: number[] = [];

  applyBillingSeatInputChange("abc", (value) => inputValues.push(value), (value) => overrideValues.push(value));
  applyBillingSeatInputChange("1", (value) => inputValues.push(value), (value) => overrideValues.push(value));
  applyBillingSeatInputChange("14", (value) => inputValues.push(value), (value) => overrideValues.push(value));

  assert.deepEqual(inputValues, ["", "1", "14"]);
  assert.deepEqual(overrideValues, [1, 14]);
});

test("billing seat input commit clamps on blur, falls back when needed, and clears the draft", () => {
  assert.equal(getBillingSeatInputValue(null, 4), "4");
  assert.equal(getBillingSeatInputValue("", 4), "");
  assert.equal(commitBillingSeatInputValue(null, 4, 2), 4);
  assert.equal(commitBillingSeatInputValue("", 4, 2), 2);
  assert.equal(commitBillingSeatInputValue("1", 4, 2), 2);
  assert.equal(commitBillingSeatInputValue("12", 4, 2), 12);

  const overrideValues: number[] = [];
  const clearedValues: Array<string | null> = [];
  const committed = applyBillingSeatInputCommit(
    "1",
    4,
    2,
    (value) => overrideValues.push(value),
    (value) => clearedValues.push(value),
  );

  assert.equal(committed, 2);
  assert.deepEqual(overrideValues, [2]);
  assert.deepEqual(clearedValues, [null]);
});

test("billing selected totals show yearly discount against undiscounted annual price", () => {
  const formatUsd = (value: number) => Number.isInteger(value) ? String(value) : value.toFixed(2);

  // Priced totals are {id, amount} now — the "/ month" period is a translated
  // part of the message instead of English text patched by replace() downstream.
  // The AMOUNTS are what this test is about, and they are unchanged; the rendered
  // strings are pinned in tests/billingPricedTotals.i18n.test.ts.
  assert.deepEqual(getBillingSelectedTotalLabels("monthly", 3, 10, 105.6, formatUsd), {
    totalLabel: { id: "billing.perMonth", amount: "30" },
    originalLabel: null,
  });
  assert.deepEqual(getBillingSelectedTotalLabels("annual", 3, 10, 105.6, formatUsd), {
    totalLabel: { id: "billing.perYear", amount: "316.80" },
    originalLabel: { id: "billing.perYear", amount: "360" },
  });
});

test("billing total labels distinguish checkout total from manage-seat current and updated totals", () => {
  const formatUsd = (value: number) => Number.isInteger(value) ? String(value) : value.toFixed(2);

  assert.deepEqual(getBillingCurrentTotalLabel("monthly", 40, null, formatUsd),
    { id: "billing.perMonth", amount: "40" });
  assert.deepEqual(getBillingCurrentTotalLabel("annual", 26.4, 316.8, formatUsd),
    { id: "billing.perYear", amount: "316.80" });
  // annualUsd null still falls back to monthly x12 (26.4 * 12 = 316.80).
  assert.deepEqual(getBillingCurrentTotalLabel("annual", 26.4, null, formatUsd),
    { id: "billing.perYear", amount: "316.80" });
  assert.deepEqual(getBillingTotalSummaryLabels("default", "monthly"), {
    currentTotalLabel: null,
    totalLabel: "billing.total",
  });
  assert.deepEqual(getBillingTotalSummaryLabels("manageSeats", "monthly"), {
    currentTotalLabel: "billing.currentMonthlyTotal",
    totalLabel: "billing.totalAfterUpdate",
  });
  assert.deepEqual(getBillingTotalSummaryLabels("manageSeats", "annual"), {
    currentTotalLabel: "billing.currentYearlyTotal",
    totalLabel: "billing.totalAfterUpdate",
  });
});

test("billing copy labels present seats as the paid input", () => {
  assert.deepEqual(getBillingSeatCopyLabels("default", "3 seats selected"), {
    seatQuantityLabel: "billing.seatsToBuy",
    seatSummaryLabel: "billing.seatsToBuy",
    billableSeatsSummaryLabel: "billing.billableSeats",
    capacitySummaryLabel: "billing.capacity",
    quantityHelpLabel: "billing.capacityOnly",
  });
  assert.deepEqual(getBillingSeatCopyLabels("manageSeats", "Removes 2 seats"), {
    seatQuantityLabel: "billing.totalSeats",
    seatSummaryLabel: "billing.seatsAfterUpdate",
    billableSeatsSummaryLabel: "billing.totalSeatsAfterUpdate",
    capacitySummaryLabel: "billing.capacityAfterUpdate",
    quantityHelpLabel: "billing.enterTotalSeatsToKeep",
  });
});

test("billing manage-seat draft state can reduce to actual usage floor", () => {
  const currentProductionCase = getBillingSeatDraftState({
    requestedSeatQuantity: 16,
    draftSeatQuantity: 16,
    minimumUsageSeatQuantity: 12,
    minimumSeatQuantity: 16,
  });

  assert.equal(currentProductionCase.requestedSeatQuantity, 16);
  assert.equal(currentProductionCase.draftSeatQuantity, 16);
  assert.equal(currentProductionCase.belowCurrentUsage, false);
  assert.equal(currentProductionCase.reducesPurchasedSeats, false);

  const addOneSeat = getBillingSeatDraftState({
    requestedSeatQuantity: 17,
    draftSeatQuantity: 17,
    minimumUsageSeatQuantity: 12,
    minimumSeatQuantity: 16,
  });

  assert.equal(addOneSeat.requestedSeatQuantity, 17);
  assert.equal(addOneSeat.draftSeatQuantity, 17);
  assert.equal(addOneSeat.belowCurrentUsage, false);
  assert.equal(addOneSeat.reducesPurchasedSeats, false);

  const belowActualUsage = getBillingSeatDraftState({
    requestedSeatQuantity: 11,
    draftSeatQuantity: 11,
    minimumUsageSeatQuantity: 12,
    minimumSeatQuantity: 1,
  });

  assert.equal(belowActualUsage.belowCurrentUsage, true);
  assert.equal(belowActualUsage.reducesPurchasedSeats, false);

  const reducedToUsage = getBillingSeatDraftState({
    requestedSeatQuantity: 12,
    draftSeatQuantity: 12,
    minimumUsageSeatQuantity: 12,
    minimumSeatQuantity: 1,
  });

  assert.equal(reducedToUsage.requestedSeatQuantity, 12);
  assert.equal(reducedToUsage.draftSeatQuantity, 12);
  assert.equal(reducedToUsage.belowCurrentUsage, false);
  assert.equal(reducedToUsage.reducesPurchasedSeats, false);
});

test("settings billing copy sells seat quantity directly and keeps numeric text inputs", () => {
  const settings = read("src/components/settings/SettingsPanel.tsx");

  assert.match(settings, /formatMessage\(\{ id: "billing\.enterTheNumberOfSeatsToBuy" \}\)/);
  assert.match(settings, /formatMessage\(\{ id: "billing\.enterTheTotalSeatsAfterThisUpdate" \}\)/);
  // `capacityLabel` is no longer passed in: the help string takes {capacity} as
  // an ICU argument, so the capacity phrase can be translated too.
  assert.match(settings, /getBillingSeatCopyLabels\(billingSeatCopyMode\)/);
  assert.match(settings, /\{ capacity: capacityLabel \}/);
  assert.match(settings, /aria-label=\{localizedBillingSeatCopyLabels\.seatQuantityLabel\}/);
  assert.match(settings, /type="text"/);
  assert.match(settings, /inputMode="numeric"/);
  assert.match(settings, /pattern="\[0-9\]\*"/);
  // The seat-coverage sentence is one catalog message now; its exact en/zh
  // output is pinned in tests/billingTrialAndCheckout.i18n.test.ts.
  assert.match(settings, /id: "billing\.seatCoverageHelp"/);
  assert.match(settings, /formatMessage\(\{ id: "billing\.enterAtLeastSeats" \}, \{ min: minimumUsageSeatQuantity \}\)/);
  assert.match(settings, /disabled=\{!!billingControlsDisabledReason \|\| !!billingSeatDraftError \|\| billingAction != null\}/);
  assert.doesNotMatch(settings, /minimumPurchasedOrRequiredHumanSeats/);
  assert.doesNotMatch(settings, /minimumPurchasedOrRequiredAgentSeats/);
  assert.match(settings, /applyBillingSeatInputChange/);
  assert.match(settings, /applyBillingSeatInputCommit/);
  assert.match(settings, /formatMessage\(\{ id: "billing\.confirmProCheckout" \}\)/);
  assert.match(settings, /formatMessage\(\{ id: "billing\.confirmSeatUpdate" \}\)/);
  assert.match(settings, /formatMessage\(\{ id: "billing\.reviewSeatUpdate" \}\)/);
  assert.match(settings, /formatMessage\(\{ id: "billing\.confirmAndUpdateSeats" \}\)/);
  assert.match(settings, /const openSeatUpdateConfirm = async \(\) => \{[\s\S]*\/billing\/seat-pack-quantity\/preview[\s\S]*setConfirmBillingAction\("update"\);[\s\S]*\};/);
  assert.match(settings, /onClick=\{openSeatUpdateConfirm\}/);
  assert.doesNotMatch(settings, /onClick=\{handlePackQuantityUpdate\}/);
  assert.match(settings, /onConfirm=\{confirmBillingAction === "checkout" \? handleCheckout : handlePackQuantityUpdate\}/);
  assert.match(settings, /"billing\.seatsToRemove".*removedSeats/);
  assert.match(settings, /"billing\.seatsToAdd".*additionalSeats/);
  assert.match(settings, /"billing\.totalSeatsAfterUpdate".*draftSeatQuantity/);
  assert.match(settings, /formatMessage\(\{ id: "billing\.continueToStripe" \}\)/);
  assert.match(settings, /formatMessage\(\{ id: "billing\.stripeMayBillThisSeatIncreaseImmediatelyAfterY" \}\)/);
  assert.match(settings, /formatMessage\(\{ id: "billing\.stripeWillUpdateTheSubscriptionQuantityAfterYo" \}\)/);
  assert.match(settings, /formatMessage\(\{ id: "billing\.promotionCodeOptional" \}\)/);
  assert.match(settings, /previewToken: seatUpdatePreview\.previewToken/);
  assert.match(settings, /formatMessage\(\{ id: "billing\.estimatedProratedCharge" \}\)/);
  assert.match(settings, /formatMessage\(\{ id: "billing\.estimatedNextMonthlyTotal" \}\)/);
});
