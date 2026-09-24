import assert from "node:assert/strict";
import test from "node:test";
import { createIntl } from "react-intl";

import { getBillingPlanPresentation } from "../src/utils/billingControls";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";

// Billing step 2, PR B (part 1): the three dynamic `t(variable)` sites.
//
// `BillingPlanPresentation` used to carry DISPLAY TEXT, which SettingsPanel fed
// to `billingText()` — an exact source-text lookup. It now carries `MessageId`s.
// That change is FAIL-CLOSED by construction (@Wug's requirement): MessageId is
// a literal union, so a string that is not a catalog key is a compile error. It
// caught six sites I had missed, including two `input.displayName ?? "Pro"`
// fallbacks that would have put SERVER-SUPPLIED text into a localized surface.
//
// Because the type system enforces "is a valid id", the assertions here are the
// things it cannot see: that the ids are the RIGHT ones per plan, and that the
// seat sentence actually renders in both locales.

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;

const intls = {
  en: createIntl({ locale: "en", messages: en }),
  "zh-cn": createIntl({ locale: "zh-cn", messages: zh }),
};

function proWithSeats(seats: number) {
  return getBillingPlanPresentation({
    plan: "pro",
    displayName: "ignored-server-text",
    currentHumanSeats: 1,
    currentAgentSeats: 1,
    currentSeatQuantity: seats,
    proAgentSeatFractionLabel: "1/3",
  });
}

function render(locale: "en" | "zh-cn", id: string, values?: Record<string, unknown>): string {
  return String(intls[locale].formatMessage({ id }, values as never));
}


test("the seat sentence renders in BOTH locales from one ICU message", () => {
  // This is the sentence billingText could never look up (it is interpolated),
  // which is why SettingsPanel carried a hand-written zh fallback beside it.
  // One message now serves both locales and the locale branch is gone.
  const p = proWithSeats(3);
  assert.equal(p.description, "billing.proSeatsPurchased");
  assert.deepEqual(p.descriptionValues, { count: 3, fraction: "1/3" });

  assert.equal(
    render("en", p.description, p.descriptionValues),
    "3 seats purchased. Each human uses 1 seat; each agent uses 1/3 seat.",
  );
  assert.equal(
    render("zh-cn", p.description, p.descriptionValues),
    "已购买 3 个席位。每位人类占用 1 个席位，每个 Agent 占用 1/3 个席位。",
  );
});

test("the seat sentence pluralizes in English and does not in Chinese", () => {
  // The old code hand-rolled `seat${n === 1 ? "" : "s"}`. English needs the
  // distinction, Chinese does not — which is exactly what an ICU plural encodes
  // and what a hand-rolled suffix cannot.
  const one = proWithSeats(1);
  assert.match(render("en", one.description, one.descriptionValues), /^1 seat purchased\./);
  assert.match(render("zh-cn", one.description, one.descriptionValues), /^已购买 1 个席位。/);

  const many = proWithSeats(12);
  assert.match(render("en", many.description, many.descriptionValues), /^12 seats purchased\./);
  assert.match(render("zh-cn", many.description, many.descriptionValues), /^已购买 12 个席位。/);
});

test("server-supplied displayName is NOT rendered as copy", () => {
  // `input.displayName` comes from the API. It is not a catalog key and cannot
  // be translated, so both plan branches deliberately ignore it. Passing a
  // recognisable value proves it does not leak into the presentation.
  for (const plan of ["pro", "free"]) {
    const p = getBillingPlanPresentation({
      plan,
      displayName: "SERVER-SUPPLIED-NAME",
      currentHumanSeats: 0,
      currentAgentSeats: 0,
      currentSeatQuantity: 0,
      proAgentSeatFractionLabel: "1/3",
    });
    assert.ok(
      !JSON.stringify(p).includes("SERVER-SUPPLIED-NAME"),
      `${plan}: server-supplied display name leaked into the presentation`,
    );
  }
});

test("each plan maps to its own ids, and every id resolves in both catalogs", () => {
  // The compiler guarantees each value IS a catalog key; it cannot guarantee the
  // RIGHT key. Distinctness across plans is what a mis-wire would break.
  const plans = {
    free: getBillingPlanPresentation({ plan: "free", displayName: null, currentHumanSeats: 0, currentAgentSeats: 0, currentSeatQuantity: 0, proAgentSeatFractionLabel: "1/3" }),
    pro: getBillingPlanPresentation({ plan: "pro", displayName: null, currentHumanSeats: 0, currentAgentSeats: 0, currentSeatQuantity: 0, proAgentSeatFractionLabel: "1/3" }),
    founder: getBillingPlanPresentation({ plan: "founder", displayName: null, currentHumanSeats: 0, currentAgentSeats: 0, currentSeatQuantity: 0, proAgentSeatFractionLabel: "1/3" }),
    partner: getBillingPlanPresentation({ plan: "partner", displayName: null, currentHumanSeats: 0, currentAgentSeats: 0, currentSeatQuantity: 0, proAgentSeatFractionLabel: "1/3" }),
    // Pro has TWO branches — with and without provisioned seats — and they build
    // their presentation separately. Mutation testing caught that: seeding every
    // plan with 0 seats left the with-seats branch unexercised, so injecting a
    // server-supplied displayName there, and giving it Free's not-included list,
    // both stayed green.
    proWithSeats: proWithSeats(4),
  };

  // The two Pro branches legitimately share a displayName; the four distinct
  // PLANS must not.
  const names = ["free", "pro", "founder", "partner"].map((k) => plans[k as keyof typeof plans].displayName);
  assert.equal(new Set(names).size, names.length, "each plan needs its own displayName id");
  assert.equal(plans.proWithSeats.displayName, plans.pro.displayName, "both Pro branches name the plan the same");

  for (const [plan, p] of Object.entries(plans)) {
    for (const id of [p.displayName, p.description, ...p.includedFeatures, ...p.notIncludedFeatures]) {
      assert.ok(en[id], `${plan}: ${id} missing from en`);
      assert.ok(zh[id], `${plan}: ${id} missing from zh`);
    }
    assert.ok(p.includedFeatures.length > 0, `${plan} should list included features`);
  }

  // Only Free advertises what it lacks; a mix-up here would show "not included"
  // rows on a paid plan.
  assert.ok(plans.free.notIncludedFeatures.length > 0, "Free lists its gaps");
  for (const plan of ["pro", "proWithSeats", "founder", "partner"] as const) {
    assert.deepEqual(plans[plan].notIncludedFeatures, [], `${plan} must not list gaps`);
  }
});

test("Free and Pro render their distinct Joint Channel allowances in both locales", () => {
  const free = getBillingPlanPresentation({
    plan: "free",
    displayName: null,
    currentHumanSeats: 0,
    currentAgentSeats: 0,
    currentSeatQuantity: 0,
    proAgentSeatFractionLabel: "1/3",
  });
  const pro = getBillingPlanPresentation({
    plan: "pro",
    displayName: null,
    currentHumanSeats: 0,
    currentAgentSeats: 0,
    currentSeatQuantity: 0,
    proAgentSeatFractionLabel: "1/3",
  });

  assert.ok(free.includedFeatures.includes("billing.limitedTimeFreeJointChannel"));
  assert.ok(free.notIncludedFeatures.includes("billing.unlimitedJointChannels"));
  assert.ok(pro.includedFeatures.includes("billing.unlimitedJointChannels"));

  assert.equal(render("en", "billing.limitedTimeFreeJointChannel"), "1 free Joint Channel for a limited time");
  assert.equal(render("zh-cn", "billing.limitedTimeFreeJointChannel"), "限时免费 1 个联合频道");
  assert.equal(render("en", "billing.unlimitedJointChannels"), "Unlimited Joint Channels");
  assert.equal(render("zh-cn", "billing.unlimitedJointChannels"), "不限数量的联合频道");
});
