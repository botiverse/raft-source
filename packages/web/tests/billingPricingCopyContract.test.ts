import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");

function read(path: string) {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

test("settings billing pricing copy matches current landing pricing copy", () => {
  const shared = read("../shared/src/index.ts");
  const settings = read("src/components/settings/SettingsPanel.tsx");
  const billingCopy = `${shared}\n${settings}`;
  // PRE-EXISTING BUG, found while re-anchoring: this slice looked for
  // `const freeIncludedFeatures` in SettingsPanel, but those constants live in
  // utils/billingControls.ts and are UPPER_SNAKE. Both indexOf calls returned -1,
  // so the slice was the empty string and every assertion over it passed
  // vacuously — independent of the i18n migration. Anchored on the real file and
  // the real names, with a length check so a future rename cannot silently empty
  // it again.
  const billingControls = read("src/utils/billingControls.ts");
  const publicPlanBlocks = billingControls.slice(
    billingControls.indexOf("const FREE_INCLUDED_FEATURES"),
    billingControls.indexOf("const FOUNDER_INCLUDED_FEATURES"),
  );
  assert.ok(
    publicPlanBlocks.length > 100,
    "public feature block slice is empty — its anchors no longer match the source",
  );

  assert.match(billingCopy, /Channels/);
  assert.match(billingCopy, /Tasks/);
  assert.match(billingCopy, /Agents on your own computers/);
  assert.match(billingCopy, /Agent reminders/);
  assert.match(billingCopy, /Basic observability/);
  assert.match(billingCopy, /30 days of message history/);
  assert.match(billingCopy, /100 MB file uploads\/month/);
  assert.doesNotMatch(billingCopy, /Unlimited agents on your own computers/);
  assert.doesNotMatch(billingCopy, /Unlimited human seats/);
  assert.doesNotMatch(billingCopy, /unlimited humans/i);
  assert.doesNotMatch(billingCopy, /Up to 10 agent seats/);
  assert.doesNotMatch(billingCopy, /Up to 5 agent seats/);
  assert.match(billingCopy, /\/ seat \/ month/);
  assert.match(billingCopy, /Each human uses 1 seat; each agent uses \$\{PRO_AGENT_SEAT_FRACTION\} seat/);
  // The seat-coverage sentence is one catalog message now; its exact en/zh
  // output is pinned in tests/billingTrialAndCheckout.i18n.test.ts.
  assert.match(billingCopy, /id: "billing\.seatCoverageHelp"/);
  assert.match(billingCopy, /Everything in Free/);
  assert.match(billingCopy, /Unlimited message history/);
  assert.match(billingCopy, /Higher file upload limits/);
  assert.match(billingCopy, /Joint channels/);
  assert.match(billingCopy, /More professional features coming soon/);
  assert.match(billingCopy, /Everything in Pro/);
  assert.match(billingCopy, /Private deployment options/);
  assert.match(billingCopy, /SSO and advanced access control/);
  assert.match(billingCopy, /Dedicated onboarding and rollout support/);
  assert.doesNotMatch(billingCopy, /Security and compliance review/);
  assert.doesNotMatch(billingCopy, /Deployment architecture review/);
  assert.doesNotMatch(billingCopy, /More PRO features coming soon/);
  assert.doesNotMatch(billingCopy, /Audit and admin controls coming soon/);
  assert.doesNotMatch(billingCopy, /First Pro Seat Pack free 14 days/);
  assert.doesNotMatch(billingCopy, /Start 14-day Free Trial/);
  assert.doesNotMatch(billingCopy, /14 days free/i);
  // The public (Free/Pro) feature blocks must not name the internal plans.
  // billingControls holds catalog IDS now, and `billing.founder` is lower-case
  // after the dot — so /Founder/ could no longer match a mis-added id.
  assert.doesNotMatch(publicPlanBlocks, /billing\.founder/);
  assert.doesNotMatch(publicPlanBlocks, /billing\.partner/);
  assert.doesNotMatch(billingCopy, /early supporter/);
  assert.doesNotMatch(billingCopy, /permanent free unlimited access/);
});
