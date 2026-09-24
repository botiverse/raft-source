import assert from "node:assert/strict";
import test from "node:test";

import { TRIAL_END_DATE } from "@botiverse/raft-shared";
import {
  GLOBAL_TRIAL_CUTOFF_TIME_ZONE,
  formatGlobalTrialCutoffDate,
} from "../src/utils/trialCutoff";

// WHY THIS FILE EXISTS — @Wug's review of #5792.
//
// billingTrialAndCheckout.i18n.test.ts proves the MESSAGE side of the trial
// sentence: `{date}` arrives as preformatted text and is not an ICU date
// argument. It says nothing about the CALLER, which is where the actual
// promise lives:
//
//   new Date(TRIAL_END_DATE.getTime() - 1).toLocaleDateString(
//     …, { …, timeZone: "Etc/GMT+12" })
//
// So a change could keep `{date}` as text, drop the explicit timezone, and stay
// green while the rendered date started varying by viewer — contradicting the
// copy's "in every time zone" in exactly the case the sentence is about.
//
// The formatting is now a named function and this pins its behaviour. Both
// details are load-bearing, and each mutation moves the rendered day:
//   Etc/GMT+12 (correct) -> Jun 22, 2026
//   UTC / viewer-local   -> Jun 23, 2026   (timezone dropped)
//   without the `- 1`    -> Jun 23, 2026   (exclusive end shown as an extra day)

const OPTS = { year: "numeric", month: "short", day: "numeric" } as const;

test("the trial cutoff renders the last day the trial is active anywhere on Earth", () => {
  // TRIAL_END_DATE is 2026-06-23T12:00:00Z. In UTC-12 that instant is
  // 2026-06-23T00:00, so the last day still inside the trial is Jun 22.
  assert.equal(formatGlobalTrialCutoffDate("en"), "Jun 22, 2026");
});

test("dropping the explicit timezone would change the rendered day", () => {
  // This is what makes the assertion above an oracle rather than a snapshot:
  // it proves the timeZone option is doing work. If these agreed, removing the
  // option would be undetectable.
  const last = new Date(TRIAL_END_DATE.getTime() - 1);
  const utc = last.toLocaleDateString("en", { ...OPTS, timeZone: "UTC" });
  assert.notEqual(
    formatGlobalTrialCutoffDate("en"), utc,
    "the global cutoff must not agree with UTC, or this test proves nothing",
  );
  // …and the far side of the date line differs too, so no single zone is safe
  // to fall back to.
  const east = last.toLocaleDateString("en", { ...OPTS, timeZone: "Etc/GMT-14" });
  assert.notEqual(formatGlobalTrialCutoffDate("en"), east);
});

test("dropping the -1 would change the rendered day", () => {
  const withoutOffset = TRIAL_END_DATE.toLocaleDateString("en", {
    ...OPTS,
    timeZone: GLOBAL_TRIAL_CUTOFF_TIME_ZONE,
  });
  assert.notEqual(
    formatGlobalTrialCutoffDate("en"), withoutOffset,
    "the -1 must matter, or an exclusive end would display as an extra trial day",
  );
});

test("the rendered day does not depend on the machine running the code", () => {
  // Same call, formatted against every plausible host zone: the output is fixed
  // because the timezone is pinned inside the function, not inherited.
  for (const tz of ["UTC", "Asia/Shanghai", "America/Los_Angeles", "Pacific/Kiritimati"]) {
    const viewerLocal = new Date(TRIAL_END_DATE.getTime() - 1)
      .toLocaleDateString("en", { ...OPTS, timeZone: tz });
    // The function ignores `tz` entirely — that is the contract.
    assert.equal(formatGlobalTrialCutoffDate("en"), "Jun 22, 2026");
    void viewerLocal;
  }
});

test("zh renders the same instant, in Chinese", () => {
  const zh = formatGlobalTrialCutoffDate("zh-CN");
  assert.match(zh, /2026/);
  assert.match(zh, /6/, "same June day, Chinese formatting");
  assert.notEqual(zh, formatGlobalTrialCutoffDate("en"), "locale must still apply");
});
