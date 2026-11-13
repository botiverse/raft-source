import assert from "node:assert/strict";

import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { LEGACY_ZH_BILLING_COPY } from "./fixtures/legacyBillingZhCopy";
import { BILLING_MIGRATION_BASELINE } from "./fixtures/billingMigrationBaseline";

// EXPECTED MIGRATED ID SET — the migration-target billing ids still in use (45
// of the 49 migrated), frozen INDEPENDENTLY of the baseline fixture
// (@铁根/@Wug successor contract). Deriving the expected set from the fixture
// would make "delete an id AND its fixture entry together" pass vacuously; this
// hardcoded set makes that RED. The 14 dropped legacy entries (retired "Add
// Seats" flow), the 25 retired with the old Plan & Billing page (#12097), the
// 3 retired with the old downgrade notice and the trial banner's title are
// documented in fixtures/billingMigrationBaseline.ts.
export const EXPECTED_MIGRATED_IDS: readonly string[] = [
  "billing.100MbFileUploadsMonth",
  "billing.30DaysOfMessageHistory",
  "billing.agentReminders",
  "billing.agents",
  "billing.agentsOnYourOwnComputers",
  "billing.basicObservability",
  "billing.billing",
  "billing.billingInterval",
  "billing.cancelSubscription",
  "billing.cancelTheWholeProSubscriptionAtTheEndOfTheCu",
  "billing.canceling",
  "billing.channels",
  "billing.everythingInFree",
  "billing.everythingWithoutAnyLimitations",
  "billing.failedToCancelSubscription",
  "billing.failedToOpenBillingPortal",
  "billing.failedToUpdateSeats",
  "billing.fileUploads",
  "billing.forBuildersAndTeamsScalingAgentCollaboration",
  "billing.founder",
  "billing.free",
  "billing.grandfatheredUnlimitedAccess",
  "billing.higherFileUploadLimits",
  "billing.humans",
  "billing.managePlan",
  "billing.messageHistory",
  "billing.monthly",
  "billing.moreProfessionalFeaturesComingSoon",
  "billing.onlyServerOwnersAndAdminsCanViewBilling",
  "billing.onlyServerOwnersCanChangeBilling",
  "billing.opening",
  "billing.paidPlansAreNotAvailableYet",
  "billing.partner",
  "billing.partnerAccessForTestingAndSponsoredUse",
  "billing.planBilling",
  "billing.pro",
  "billing.raftFeaturesEnabledForPartnerTestingAndSponsor",
  "billing.seat",
  "billing.startBuildingWithAgents",
  "billing.subscriptionCancellationScheduledForTheEndOf",
  "billing.subscriptionReactivatedYourCurrentProSeatCap",
  "billing.tasks",
  "billing.unlimitedMessageHistory",
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
  // Pending AppSumo verification is a new source state; it had no legacy copy.
  "billing.appsumoPendingTitle",
  "billing.appsumoPendingBilling",
  // The Free limited-time Joint Channel row and the Pro unlimited Joint Channel
  // row need distinct plan-card values; the legacy generic "Joint channels"
  // row cannot express both.
  // Both plan-to-id wiring and exact en/zh output are pinned in
  // tests/billingPlanPresentation.i18n.test.ts.
  "billing.limitedTimeFreeJointChannel",
  "billing.unlimitedJointChannels",
  // 2026-10-22, task #148: the cancel button of the Cancel Subscription dialog.
  // The action is itself a cancel, so its Cancel says what stays. New copy, not
  // migrated; the rendered dialog is pinned in src/features/settings/tests/billingSummary.behavior.test.tsx.
  "billing.keepSubscription",
  // New AppSumo lifetime source copy, never part of the legacy billingText map.
  // Billing/redemption mounted behavior is covered in appsumoRedemption and billingSummary tests.
  "billing.appsumoLifetimePlan",
  "billing.appsumoManaged",
  "billing.appsumoStripeConflict",
  "billing.appsumoStripePeriodEnd",
  // New checkout uncertainty and concurrent billing-change guidance; behavior
  // is covered by billingConfirmComposition.behavior.test.tsx.
  "billing.checkoutOutcomeUnknown",
  "billing.sourceCheckBusy",
  // PR B2b FINAL slice. Three composed messages whose legacy counterpart cannot
  // exist by construction: billingText's map was keyed by the finished English
  // SOURCE STRING, and each of these varies at runtime (an amount, a percent), so
  // no fixed key could ever have been in it.
  //
  // Each is pinned against its pre-migration output in a file that EXISTS — a
  // lesson from #5788, where I exempted ten ids citing a test I had only planned:
  //   billing.perYear / billing.perMonth  -> tests/billingPricedTotals.i18n.test.ts
  //     (both locales, incl. the `.replace(" / year", " / 年")` surgery they replace)
  //   billing.saveAnnualPercent           -> tests/billingPricedTotals.i18n.test.ts
  //     (ternary-sourced; not in TERNARY_SOURCED because the arms held a `${}`
  //      interpolation, so the catalog value is not byte-equal to either arm.
  //      The test renders it at the real constant and compares to the old output.)
  "billing.perYear",
  "billing.perMonth",
  "billing.saveAnnualPercent",
  "billing.proSeatsPurchased",
  // PR B2b part 1: the seat count label. It was never a map entry either — it
  // was built by hand-rolled English pluralization inside a locale branch, which
  // billingText could not have expressed. Its behaviour is pinned in
  // tests/billingSeatLabels.i18n.test.ts, which renders both locales.
  "billing.seatCount",
  // Task #3 in #proj-commercial: the notice for a week after a server goes back
  // to Free says what it lost (the old one counted down to stopping agents Free
  // no longer caps). New copy, worded as upgradeDialog.downgraded.hint; pinned
  // in tests/planDowngradeNotice.behavior.test.tsx.
  "billing.downgraded.title",
  "billing.downgraded.whatChanged",
  "billing.downgraded.whatChangedUpgrade",
  // Lifted from an inline ternary, not from ZH_BILLING_COPY — its provenance is
  // the pre-migration source and is pinned by TERNARY_SOURCED below.
  "billing.seats",
  // #9896: the Agent migration plan row is a new benefit, not migrated copy, so
  // the legacy catalog never had it. Plan wiring and both locales are pinned in
  // tests/billingPlanPresentation.i18n.test.ts.
  "billing.agentMigration",
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
  assert.equal(zh["billing.appsumoPendingTitle"], "AppSumo 许可更新");
  assert.equal(zh["billing.appsumoPendingBilling"], "正在核验你的 AppSumo 许可。确认状态前无法通过 Stripe 购买；如果长时间未恢复，请联系客服。");
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
// TERNARY-SOURCED IDS (billing step 2, PR B2a).
//
// This one came from an inline `locale === "zh-CN" ? zh : en` ternary, NOT from
// ZH_BILLING_COPY — so the verbatim check above cannot cover it: it has no
// legacy map entry by construction. Its provenance is the pre-migration
// SOURCE, and that is what this pins.
//
// Both halves are recorded, so this fails if either the English or the Chinese
// was altered while moving it into the catalog. Verified against
// origin/staging at migration time; the table is the frozen record of that.
// ---------------------------------------------------------------------------
const TERNARY_SOURCED: ReadonlyArray<readonly [string, string, string]> = [
  ["billing.seats", "Seats", "席位"],
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
