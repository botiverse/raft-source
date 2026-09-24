import assert from "node:assert/strict";
import test from "node:test";
import { createIntl } from "react-intl";

import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";

// Billing PR B2b part 2: the grace-period paragraph and the three "N over limit"
// rows.
//
// Each was assembled in JSX from a bold <span> holding the count, followed by a
// locale ternary whose English arm hand-rolled the plural noun:
//
//   <span className="font-bold">{excessAgents}</span>
//   {locale === "zh-CN" ? `个 Agent 超出额度`
//                       : `${excessAgents === 1 ? "agent" : "agents"} over limit`}
//
// The count's POSITION was fixed by JSX, so no translation could move it, and the
// plural was English-only code. Each row is now one ICU message with a <b> tag,
// so the bold span travels with the translation.
//
// These assertions pin that the rendered output is UNCHANGED from what the JSX
// produced — a migration that quietly reworded the copy would pass a
// "does it contain the id" check but fail here.

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;
const intls = {
  en: createIntl({ locale: "en", messages: en }),
  "zh-cn": createIntl({ locale: "zh-cn", messages: zh }),
};
/** Render with the <b> tag flattened, so we compare VISIBLE text rather than
 *  markup. formatMessage returns a string when every chunk resolves to a string
 *  and an array otherwise, so normalise both. */
const plain = (loc: "en" | "zh-cn", id: string, v: Record<string, unknown>) => {
  const out = intls[loc].formatMessage({ id }, { ...v, b: (c: unknown) => String(c) } as never);
  return Array.isArray(out) ? out.join("") : String(out);
};

test("the over-limit rows render exactly what the JSX used to produce", () => {
  assert.equal(plain("en", "billing.agentsOverLimit", { count: 1 }), "1 agent over limit");
  assert.equal(plain("en", "billing.agentsOverLimit", { count: 4 }), "4 agents over limit");
  assert.equal(plain("zh-cn", "billing.agentsOverLimit", { count: 4 }), "4 个 Agent 超出额度");

  assert.equal(plain("en", "billing.computersOverLimit", { count: 1 }), "1 computer over limit");
  assert.equal(plain("en", "billing.computersOverLimit", { count: 2 }), "2 computers over limit");
  assert.equal(plain("zh-cn", "billing.computersOverLimit", { count: 2 }), "2 台电脑超出额度");

  assert.equal(plain("en", "billing.channelsOverLimit", { count: 1 }), "1 channel over limit");
  assert.equal(plain("en", "billing.channelsOverLimit", { count: 7 }), "7 channels over limit");
  assert.equal(plain("zh-cn", "billing.channelsOverLimit", { count: 7 }), "7 个频道超出额度");
});

test("the grace-period paragraph renders both branches unchanged", () => {
  assert.equal(
    plain("en", "billing.graceAllWithinLimits", { days: 1 }),
    "1 day remaining in grace period. All resources are within free limits.",
  );
  assert.equal(
    plain("en", "billing.graceAllWithinLimits", { days: 5 }),
    "5 days remaining in grace period. All resources are within free limits.",
  );
  assert.equal(
    plain("zh-cn", "billing.graceAllWithinLimits", { days: 5 }),
    "5 天宽限期剩余。所有资源均在免费额度内。",
  );
  assert.equal(
    plain("en", "billing.graceExcessWillStop", { days: 3 }),
    "3 days remaining in grace period. After the grace period, excess agents will be stopped automatically.",
  );
  assert.equal(
    plain("zh-cn", "billing.graceExcessWillStop", { days: 3 }),
    "3 天宽限期剩余。宽限期结束后，超出额度的 Agent 将自动停止。",
  );
});

test("the bold count is a movable tag and zh carries no English plural arm", () => {
  for (const id of [
    "billing.agentsOverLimit", "billing.computersOverLimit", "billing.channelsOverLimit",
    "billing.graceAllWithinLimits", "billing.graceExcessWillStop",
  ]) {
    // The <b> must live INSIDE the message; if it stayed in the JSX the count's
    // position would still be fixed by code, which is the defect being removed.
    assert.match(en[id], /<b>.*<\/b>/, `en ${id} must carry the bold span as a tag`);
    assert.match(zh[id], /<b>.*<\/b>/, `zh ${id} must carry the bold span as a tag`);
    assert.ok(!/\bone\s*\{/.test(zh[id]), `zh ${id} must not copy an English one-arm`);
  }
  // English pluralizes the NOUN, Chinese does not pluralize at all.
  assert.match(en["billing.agentsOverLimit"], /\{count, plural,/);
  assert.ok(!/plural/.test(zh["billing.agentsOverLimit"]), "zh needs no plural for a bare count");
});
