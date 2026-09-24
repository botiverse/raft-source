import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { LEGACY_ZH_BILLING_COPY } from "./fixtures/legacyBillingZhCopy";
import { BILLING_MIGRATION_BASELINE } from "./fixtures/billingMigrationBaseline";

// EXPECTED MIGRATED ID SET — the 72 migration-target billing ids, frozen
// INDEPENDENTLY of the baseline fixture (@铁根/@Wug successor contract).
// Deriving the expected set from the fixture would make "delete an id AND its
// fixture entry together" pass vacuously; this hardcoded set makes that RED.
// The 14 dropped legacy entries (retired "Add Seats" flow) are documented in
// fixtures/billingMigrationBaseline.ts.
export const EXPECTED_MIGRATED_IDS: readonly string[] = [
  "billing.100MbFileUploadsMonth",
  "billing.30DaysOfMessageHistory",
  "billing.addedCapacity",
  "billing.agentReminders",
  "billing.agents",
  "billing.agentsOnYourOwnComputers",
  "billing.basicObservability",
  "billing.billableSeats",
  "billing.billing",
  "billing.billingInterval",
  "billing.billingPortal",
  "billing.cancelSubscription",
  "billing.cancelSubscription2",
  "billing.cancelTheWholeProSubscriptionAtPeriodEnd",
  "billing.cancelTheWholeProSubscriptionAtTheEndOfTheCu",
  "billing.canceling",
  "billing.capacity",
  "billing.channels",
  "billing.checkoutSummary",
  "billing.currentPlan",
  "billing.everythingInFree",
  "billing.everythingWithoutAnyLimitations",
  "billing.failedToCancelSubscription",
  "billing.failedToOpenBillingPortal",
  "billing.failedToStartCheckout",
  "billing.failedToUpdateSeats",
  "billing.fileUploads",
  "billing.finalTrialPeriod",
  "billing.forBuildersAndTeamsScalingAgentCollaboration",
  "billing.founder",
  "billing.free",
  "billing.gracePeriodExpired",
  "billing.grandfatheredUnlimitedAccess",
  "billing.higherFileUploadLimits",
  "billing.howOftenDoYouWantToBeBilled",
  "billing.humans",
  "billing.included",
  "billing.jointChannels",
  "billing.managePlan",
  "billing.messageHistory",
  "billing.monthly",
  "billing.moreProfessionalFeaturesComingSoon",
  "billing.notIncluded",
  "billing.onlyServerOwnersAndAdminsCanViewBilling",
  "billing.onlyServerOwnersCanChangeBilling",
  "billing.openStripeBillingPortal",
  "billing.opening",
  "billing.paidPlansAreNotAvailableYet",
  "billing.partner",
  "billing.partnerAccessForTestingAndSponsoredUse",
  "billing.planBilling",
  "billing.planDowngraded",
  "billing.pro",
  "billing.raftFeaturesEnabledForPartnerTestingAndSponsor",
  "billing.reactivateSubscription",
  "billing.reactivateThisProSubscriptionBeforeTheCurren",
  "billing.reactivating",
  "billing.seat",
  "billing.seatQuantitiesAreAlreadyUpToDate",
  "billing.seatUpdateIsPendingStripePaymentConfirmation",
  "billing.seeAllFeaturesAndComparePlans",
  "billing.startBuildingWithAgents",
  "billing.subscriptionCancellationScheduledForTheEndOf",
  "billing.subscriptionReactivatedYourCurrentProSeatCap",
  "billing.subscriptionSummary",
  "billing.tasks",
  "billing.theGracePeriodHasEndedExcessAgentsHaveBeenSt",
  "billing.unlimited",
  "billing.unlimitedMessageHistory",
  "billing.updating",
  "billing.upgradeToPro",
  "billing.yearly",
];


// Billing step 2, PR A: the 49 static `t("...")` sites move to `billing.*` ids.
//
// THE POINT OF THIS FILE: the zh copy already existed in ZH_BILLING_COPY and was
// reviewed there. A migration must transfer it VERBATIM, not retranslate it —
// and "I copied it carefully" is exactly the kind of claim that is not evidence.
// So while both representations still exist, assert them equal mechanically.
//
// This used to parse ZH_BILLING_COPY out of src/utils/billingI18n.ts, and was
// scoped to be deleted along with it. That would have retired the only mechanical
// guarantee that the zh copy was TRANSFERRED rather than retranslated — at the
// exact moment the original stopped existing in the tree. So the reference side
// is frozen as a fixture instead, verified byte-identical to the live map before
// the delete, and the check survives the deletion.

function readLegacyZhMap(): Record<string, string> {
  return { ...LEGACY_ZH_BILLING_COPY };
}

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;
const billingIds = Object.keys(en).filter((k) => k.startsWith("billing."));

/** Ids with NO legacy counterpart, because the old mechanism could not express
 *  them. Exempt by name, never by pattern — a wildcard here would silently
 *  re-admit retranslated copy, which is the whole thing this file prevents. */
const GENUINELY_NEW = new Set([
  // The Free limited-time Joint Channel row and the Pro unlimited Joint Channel
  // row need distinct plan-card values; the legacy generic "Joint channels"
  // row cannot express both.
  // Both plan-to-id wiring and exact en/zh output are pinned in
  // tests/billingPlanPresentation.i18n.test.ts.
  "billing.limitedTimeFreeJointChannel",
  "billing.unlimitedJointChannels",
  // PR B2b FINAL slice. Four composed messages whose legacy counterpart cannot
  // exist by construction: billingText's map was keyed by the finished English
  // SOURCE STRING, and each of these varies at runtime (an amount, a percent, two
  // capacity halves), so no fixed key could ever have been in it.
  //
  // Each is pinned against its pre-migration output in a file that EXISTS — a
  // lesson from #5788, where I exempted ten ids citing a test I had only planned:
  //   billing.perYear / billing.perMonth  -> tests/billingPricedTotals.i18n.test.ts
  //     (both locales, incl. the `.replace(" / year", " / 年")` surgery they replace)
  //   billing.saveAnnualPercent           -> tests/billingPricedTotals.i18n.test.ts
  //     (ternary-sourced; not in TERNARY_SOURCED because the arms held a `${}`
  //      interpolation, so the catalog value is not byte-equal to either arm.
  //      The test renders it at the real constant and compares to the old output.)
  //   billing.capacityPair                -> tests/billingCapacityPair.i18n.test.ts
  //     (separator ternary; the zh arm is a deliberate typography FIX, recorded
  //      there as a delta rather than claimed as a verbatim transfer)
  "billing.perYear",
  "billing.perMonth",
  "billing.saveAnnualPercent",
  "billing.capacityPair",
  "billing.proSeatsPurchased",
  // Bare English literals that were NEVER localized — not by billingText either,
  // so no legacy entry can exist. They made the zh billing surface partly English
  // (the review button stayed English even under ?lang=zh-CN).
  "billing.reviewSeatUpdate",
  "billing.reviewProSeatUpdateBeforeConfirming",
  // PR B2b part 1: the seat/capacity label helpers. These were never map entries
  // either — they were built by hand-rolled English pluralization inside a locale
  // branch, which billingText could not have expressed. Their behaviour is pinned
  // in tests/billingSeatLabels.i18n.test.ts, which renders both locales.
  "billing.seatCount",
  "billing.upToHumans",
  "billing.orAgents",
  "billing.addsSeats",
  "billing.removesSeats",
  "billing.selectedSeats",
  // PR B2b part 2: the grace-period paragraph and the "N over limit" rows. Also
  // never map entries — they were assembled in JSX around a bold <span>, which a
  // source-text lookup cannot represent. Rendered output is pinned verbatim in
  // tests/billingGracePeriod.i18n.test.ts.
  "billing.graceAllWithinLimits",
  "billing.graceExcessWillStop",
  "billing.agentsOverLimit",
  "billing.computersOverLimit",
  "billing.channelsOverLimit",
  // PR B2b part 3: interpolated seat-coverage sentences and the cancellation
  // suffix. Same reason again — an exact source-text lookup cannot express an
  // interpolated string, so these never had map entries. Output pinned in
  // tests/billingSeatCoverage.i18n.test.ts.
  "billing.keepAtLeastSeats",
  "billing.enterAtLeastSeats",
  "billing.intervalWithCancellationScheduled",
  // PR B2b part 4: the seat-copy and total-summary label GROUPS. SettingsPanel
  // kept a full parallel Chinese copy of these objects behind a locale branch, so
  // they were never map entries either. BOTH ARMS are pinned against the
  // pre-migration source in tests/billingSeatLabelGroups.i18n.test.ts — which is
  // what makes this exemption honest. The first version of this comment claimed
  // that file existed when it did not (@Wug caught it): an exemption justified by
  // a test that is not there is exactly the over-exemption hole flagged for
  // billing.billableSeats, one level of indirection further out.
  "billing.totalSeats", "billing.seatsAfterUpdate", "billing.seatsToBuy",
  "billing.enterTotalSeatsToKeep", "billing.capacityOnly",
  "billing.currentYearlyTotal", "billing.currentMonthlyTotal",
  "billing.totalAfterUpdate", "billing.total",
  // PR B2b part 5: the two seat-usage bar tooltips. Each held TWO hand-rolled
  // English plurals in one template, so they were never map entries. Output
  // pinned in tests/billingSeatUsageTooltips.i18n.test.ts.
  "billing.humansUsingSeats", "billing.agentsUsingSeats",
  // PR B2b part 6: trial-end sentence, seat-coverage help, checkout title. All
  // three were interpolated templates inside a locale ternary, so no map entry
  // could exist. Output pinned in tests/billingTrialAndCheckout.i18n.test.ts.
  "billing.trialActiveThrough", "billing.seatCoverageHelp", "billing.startCheckoutTitle",
  // PR #5561 (rebased onto the react-intl catalogs): the seat-update promotion
  // surface. The zh copy was reviewed as ZH_BILLING_COPY additions in the
  // original PR, but that map never shipped before the migration deleted it,
  // so the frozen legacy fixture cannot contain these entries. Values are
  // pinned verbatim in tests/billingSeatPromotion.i18n.test.ts.
  "billing.reviewing",
  "billing.failedToPreviewSeatUpdate",
  "billing.promotionCodeOptional",
  "billing.enterACodeApprovedForExistingSeatUpdate",
  "billing.appliedPromotion",
  "billing.estimatedProratedCharge",
  "billing.discount",
  "billing.estimatedNextYearlyTotal",
  "billing.estimatedNextMonthlyTotal",
  "billing.thisStripeEstimateExpiresAfter5MinutesRe",
  // Lifted from inline ternaries, not from ZH_BILLING_COPY — their provenance is
  // the pre-migration source and is pinned by TERNARY_SOURCED below.
  "billing.manageSeats",
  "billing.month",
  "billing.reactivateThisSubscriptionAndUpdateSeats",
  "billing.enterADifferentSeatTotal",
  "billing.reactivateAndUpdateSeats",
  "billing.keepsCurrentSeats",
  "billing.enterTheNumberOfSeatsToBuy",
  "billing.enterTheTotalSeatsAfterThisUpdate",
  "billing.seatUpdateConfirmedCapacityHasBeenRefreshedFro",
  "billing.seatUpdateRequestedCapacityWillUpdateAfterStri",
  "billing.used",
  "billing.days",
  "billing.thisMonth",
  "billing.manageSeatsSummary",
  "billing.currentSeats",
  "billing.removedCapacity",
  "billing.seatIncreasesMayBillImmediatelyAfterStripeConf",
  "billing.confirmProCheckout",
  "billing.confirmSeatUpdate",
  "billing.youAreAboutToStartProCheckout",
  "billing.youAreAboutToUpdateThisProSubscription",
  "billing.seatsToAdd",
  "billing.seatsToRemove",
  "billing.totalSeatsAfterUpdate",
  "billing.capacityAfterUpdate",
  "billing.seats",
  "billing.theNextPageIsStripeCheckoutWhereThePaymentAmou",
  "billing.stripeMayBillThisSeatIncreaseImmediatelyAfterY",
  "billing.stripeWillUpdateTheSubscriptionQuantityAfterYo",
  "billing.stripeWillReactivateThisSubscriptionWithoutCha",
  "billing.continueToStripe",
  "billing.confirmAndUpdateSeats",
  "billing.opening2",
  "billing.updating2",
]);

test("the genuinely-new ids are new for a REASON, not because I retranslated", () => {
  // billingText is an exact source-text lookup, so an interpolated sentence can
  // never match a key. That is why the seat description had no legacy entry AND
  // why SettingsPanel carried a hand-written zh fallback for it at the call site.
  // Asserting the absence keeps the exemption honest: if a legacy entry ever did
  // exist, this id should have been transferred, not minted.
  const legacy = readLegacyZhMap();
  for (const id of GENUINELY_NEW) {
    assert.equal(legacy[en[id]], undefined, `${id} DOES have a legacy entry — transfer it`);
  }
  assert.deepEqual(
    Object.keys(legacy).filter((k) => k.includes("purchased")), [],
    "no legacy key expresses the seat sentence; that is why it is an ICU message now",
  );
  // And it must actually be an ICU plural in both locales, or it is just a new
  // hardcoded sentence wearing a catalog id.
  assert.match(en["billing.proSeatsPurchased"], /\{count, plural,/);
  assert.match(zh["billing.proSeatsPurchased"], /\{count, plural,/);
  assert.ok(!/\bone\s*\{/.test(zh["billing.proSeatsPurchased"]), "zh takes no English one-arm");
});

test("every migrated billing id carries the legacy zh copy verbatim", () => {
  const legacy = readLegacyZhMap();
  assert.ok(billingIds.length >= 49, `expected the migrated ids, got ${billingIds.length}`);

  const mismatches: string[] = [];
  for (const id of billingIds) {
    if (GENUINELY_NEW.has(id)) continue;
    const source = en[id];
    const expected = legacy[source];
    if (expected === undefined) {
      mismatches.push(`${id}: no legacy entry for ${JSON.stringify(source)}`);
    } else if (zh[id] !== expected) {
      mismatches.push(`${id}: got ${JSON.stringify(zh[id])}, legacy had ${JSON.stringify(expected)}`);
    }
  }
  assert.deepEqual(mismatches, [], `zh copy was altered during migration:\n${mismatches.join("\n")}`);
});

test("the migrated billing id set exactly matches the frozen baseline — missing AND extra both RED", () => {
  // @铁根/@Wug successor contract: the old `billingIds.length >= 49` was a
  // lower bound — a missing id only red below 49, an extra id never red.
  // The EXPECTED set is hardcoded (independent of the fixture), so deleting an
  // id AND its fixture entry together still REDs.
  // "Actual migrated" is derived from the legacy source map (independent of
  // the baseline fixture): a migrated id is one whose English source existed in
  // the old billingText map. A retired legacy key RESTORED into the catalog
  // therefore shows up here as an extra and REDs.
  const legacy = readLegacyZhMap();
  const actualMigrated = billingIds
    .filter((id) => legacy[en[id]] !== undefined)
    .sort();
  assert.deepEqual(actualMigrated, [...EXPECTED_MIGRATED_IDS].sort());
});

test("every frozen billing baseline id still renders the approved en and zh", () => {
  for (const id of EXPECTED_MIGRATED_IDS) {
    const baseline = BILLING_MIGRATION_BASELINE[id];
    assert.ok(baseline, `${id} missing from the baseline fixture`);
    assert.equal(en[id], baseline.en, `${id} en drifted from the approved copy`);
    assert.equal(zh[id], baseline.zh, `${id} zh drifted from the approved copy`);
  }
});

test("the migration did not silently drop or merge any string", () => {
  // Distinct English must stay distinct ids. Two sources collapsing onto one id
  // would pass the verbatim check above (both sides equal) while losing a string.
  const byEnglish = new Map<string, string[]>();
  for (const id of billingIds) {
    const list = byEnglish.get(en[id]) ?? [];
    list.push(id);
    byEnglish.set(en[id], list);
  }
  for (const [source, list] of byEnglish) {
    assert.equal(list.length, 1, `${JSON.stringify(source)} minted ${list.length} ids: ${list.join(", ")}`);
  }
});

test("no migrated billing string is left calling the legacy lookup", () => {
  // Fail-closed, per @Wug. billingI18n.ts is deleted now, so a leftover call
  // would no longer compile — but this keeps biting if someone reintroduces a
  // local `t()` shim rather than using the catalog, which is the shape the
  // original mechanism had and the easiest one to recreate by habit.
  for (const rel of [
    "../src/components/settings/SettingsPanel.tsx",
    "../src/components/settings/SettingsSegmentedControls.tsx",
  ]) {
    const src = readFileSync(resolve(import.meta.dirname, rel), "utf8");
    const remaining = src.match(/\bt\(\s*"/g) ?? [];
    assert.equal(remaining.length, 0, `${rel} still has ${remaining.length} static t("...") calls`);
  }
});

test("zh values that intentionally match English are product terms, not misses", () => {
  // `Agents` -> `Agent` and similar: the legacy map already made these choices and
  // they were reviewed there. Listing the identical ones makes them visible rather
  // than letting a future "untranslated!" sweep silently 'fix' them.
  const identical = billingIds.filter((id) => zh[id] === en[id]);
  const legacy = readLegacyZhMap();
  for (const id of identical) {
    assert.equal(
      legacy[en[id]], zh[id],
      `${id} matches English but that is NOT what the reviewed legacy copy said`,
    );
  }
});

// ---------------------------------------------------------------------------
// CALLSITE <-> ID PAIRING.
//
// @铁根's 7/31 patrol finding, which applied to the first version of this file:
// "old English is gone" + "the catalog key is translated" proves the strings were
// MOVED. It does not prove any callsite uses the RIGHT id — swapping two existing
// ids at their callsites keeps both assertions green while the UI shows the wrong
// text. I verified that on this very file: swapping billing.billingPortal and
// billing.billingInterval left it 4/4 green.
//
// Per the standard @铁根 and @Wug settled on: a source guard only counts as a
// SEMANTIC oracle if a wrong-existing-id / swapped-id mutation goes RED.
//
// This table is ground truth, derived mechanically from the pre-migration file at
// origin/staging: the Nth `t("...")` call became the Nth formatMessage id, so the
// ORDERED sequence pins every site to the string it replaced. A swap reorders the
// sequence and fails; a deleted call shortens it and fails.
// ---------------------------------------------------------------------------
const EXPECTED_CALLSITE_IDS: Record<string, readonly string[]> = {
  "SettingsPanel.tsx": [
    "billing.planBilling", "billing.managePlan", "billing.gracePeriodExpired",
    "billing.planDowngraded", "billing.theGracePeriodHasEndedExcessAgentsHaveBeenSt", "billing.onlyServerOwnersCanChangeBilling",
    "billing.paidPlansAreNotAvailableYet", "billing.unlimited", "billing.unlimited",
    "billing.upgradeToPro", "billing.managePlan", "billing.yearly",
    "billing.monthly", "billing.unlimited", "billing.reactivateThisProSubscriptionBeforeTheCurren",
    "billing.reactivateSubscription", "billing.reactivating", "billing.updating",
    "billing.failedToStartCheckout", "billing.failedToOpenBillingPortal", "billing.seatUpdateIsPendingStripePaymentConfirmation",
    "billing.seatQuantitiesAreAlreadyUpToDate", "billing.subscriptionReactivatedYourCurrentProSeatCap", "billing.failedToUpdateSeats",
    "billing.subscriptionCancellationScheduledForTheEndOf", "billing.failedToCancelSubscription", "billing.currentPlan",
    "billing.finalTrialPeriod", "billing.included", "billing.notIncluded",
    "billing.seat", "billing.humans", "billing.agents",
    "billing.humans", "billing.agents", "billing.messageHistory",
    "billing.unlimited", "billing.fileUploads", "billing.openStripeBillingPortal",
    "billing.opening", "billing.billingPortal", "billing.cancelTheWholeProSubscriptionAtPeriodEnd",
    "billing.cancelSubscription2", "billing.seeAllFeaturesAndComparePlans", "billing.howOftenDoYouWantToBeBilled",
    "billing.billingInterval", "billing.opening", "billing.upgradeToPro",
    "billing.checkoutSummary", "billing.subscriptionSummary", "billing.addedCapacity",
    "billing.cancelSubscription", "billing.cancelTheWholeProSubscriptionAtTheEndOfTheCu", "billing.cancelSubscription2",
    "billing.canceling", "billing.capacity", "billing.billing",
    "billing.onlyServerOwnersAndAdminsCanViewBilling",
  ],
  "SettingsSegmentedControls.tsx": [
    "billing.monthly", "billing.yearly", "billing.billingInterval",
  ],
};

test("every migrated callsite uses the id for the string it replaced", () => {
  for (const [file, expected] of Object.entries(EXPECTED_CALLSITE_IDS)) {
    const src = readFileSync(
      resolve(import.meta.dirname, "../src/components/settings/" + file),
      "utf8",
    );
    // Later batches add MORE billing formatMessage calls (the inline-ternary
    // migration interleaves them), so compare the RELATIVE order of the ids this
    // table covers rather than the raw sequence. Filtering to the expected set
    // keeps the guarantee — a swap still reorders them — without freezing the
    // file against any further migration.
    const expectedSet = new Set(expected);
    const actual = [...src.matchAll(/formatMessage\(\{ id: "(billing\.[A-Za-z0-9]+)" \}\)/g)]
      .map((m) => m[1])
      .filter((id) => expectedSet.has(id));
    assert.deepEqual(
      actual, [...expected],
      `${file}: callsite ids no longer match the strings they replaced`,
    );
  }
});

// ---------------------------------------------------------------------------
// TERNARY-SOURCED IDS (billing step 2, PR B2a).
//
// These 34 came from inline `locale === "zh-CN" ? zh : en` ternaries, NOT from
// ZH_BILLING_COPY — so the verbatim check above cannot cover them: they have no
// legacy map entry by construction. Their provenance is the pre-migration
// SOURCE, and that is what this pins.
//
// Both halves are recorded, so this fails if either the English or the Chinese
// was altered while moving it into the catalog. Verified against
// origin/staging at migration time; the table is the frozen record of that.
// ---------------------------------------------------------------------------
const TERNARY_SOURCED: ReadonlyArray<readonly [string, string, string]> = [
  ["billing.manageSeats", "Manage Seats", "管理席位"],
  ["billing.month", "month", "月"],
  ["billing.reactivateThisSubscriptionAndUpdateSeats", "Reactivate this subscription and update seats.", "重新激活此订阅并更新席位。"],
  ["billing.enterADifferentSeatTotal", "Enter a different seat total.", "请输入不同的席位总数。"],
  ["billing.reactivateAndUpdateSeats", "Reactivate and update seats", "重新激活并更新席位"],
  ["billing.keepsCurrentSeats", "Keeps current seats", "保持当前席位"],
  ["billing.enterTheNumberOfSeatsToBuy", "Enter the number of seats to buy.", "请输入要购买的席位数量。"],
  ["billing.enterTheTotalSeatsAfterThisUpdate", "Enter the total seats after this update.", "请输入更新后的席位总数。"],
  ["billing.seatUpdateConfirmedCapacityHasBeenRefreshedFro", "Seat update confirmed. Capacity has been refreshed from Stripe.", "席位更新已确认，容量已从 Stripe 刷新。"],
  ["billing.seatUpdateRequestedCapacityWillUpdateAfterStri", "Seat update requested. Capacity will update after Stripe confirms the subscription change.", "已请求更新席位，Stripe 确认订阅变更后容量将更新。"],
  ["billing.used", "used", "已使用"],
  ["billing.days", "days", "天"],
  ["billing.thisMonth", "this month", "本月"],
  ["billing.manageSeatsSummary", "Manage seats summary", "管理席位摘要"],
  ["billing.currentSeats", "Current seats", "当前席位"],
  ["billing.removedCapacity", "Removed capacity", "减少的容量"],
  ["billing.seatIncreasesMayBillImmediatelyAfterStripeConf", "Seat increases may bill immediately after Stripe confirms payment. Seat decreases apply to this subscription after Stripe confirms the change.", "Stripe 确认付款后，增加席位可能会立即计费；减少席位会在 Stripe 确认变更后应用到此订阅。"],
  ["billing.confirmProCheckout", "Confirm Pro Checkout", "确认 Pro 结账"],
  ["billing.confirmSeatUpdate", "Confirm Seat Update", "确认席位更新"],
  ["billing.youAreAboutToStartProCheckout", "You are about to start Pro checkout.", "你即将开始 Pro 结账。"],
  ["billing.youAreAboutToUpdateThisProSubscription", "You are about to update this Pro subscription.", "你即将更新此 Pro 订阅。"],
  ["billing.seatsToAdd", "Seats to add", "要增加的席位"],
  ["billing.seatsToRemove", "Seats to remove", "要减少的席位"],
  ["billing.totalSeatsAfterUpdate", "Total seats after update", "更新后的席位总数"],
  ["billing.capacityAfterUpdate", "Capacity after update", "更新后的容量"],
  ["billing.seats", "Seats", "席位"],
  ["billing.theNextPageIsStripeCheckoutWhereThePaymentAmou", "The next page is Stripe Checkout, where the payment amount is shown before you pay.", "下一页是 Stripe 结账页，付款前会显示支付金额。"],
  ["billing.stripeMayBillThisSeatIncreaseImmediatelyAfterY", "Stripe may bill this seat increase immediately after you confirm.", "确认后，Stripe 可能会立即对新增席位计费。"],
  ["billing.stripeWillUpdateTheSubscriptionQuantityAfterYo", "Stripe will update the subscription quantity after you confirm; the lower total must still cover current usage.", "确认后 Stripe 将更新订阅数量；减少后的总量仍必须覆盖当前用量。"],
  ["billing.stripeWillReactivateThisSubscriptionWithoutCha", "Stripe will reactivate this subscription without changing seat count.", "Stripe 将重新激活此订阅，不更改席位数量。"],
  ["billing.continueToStripe", "Continue to Stripe", "继续前往 Stripe"],
  ["billing.confirmAndUpdateSeats", "Confirm and update seats", "确认并更新席位"],
  ["billing.opening2", "Opening", "正在打开"],
  ["billing.updating2", "Updating", "正在更新"],
];

test("ids lifted out of inline ternaries kept both arms verbatim", () => {
  for (const [id, sourceEn, sourceZh] of TERNARY_SOURCED) {
    assert.equal(en[id], sourceEn, `${id}: English arm was altered during the lift`);
    assert.equal(zh[id], sourceZh, `${id}: Chinese arm was altered during the lift`);
  }
});

test("no ternary-sourced id collides with a legacy-transferred one", () => {
  // A string that existed in BOTH the legacy map and an inline ternary would be
  // ambiguous about which copy is authoritative. None do; assert it stays that way.
  const legacy = readLegacyZhMap();
  for (const [id, sourceEn] of TERNARY_SOURCED) {
    assert.equal(
      legacy[sourceEn], undefined,
      `${id} exists in ZH_BILLING_COPY too — decide which copy is authoritative`,
    );
  }
});
