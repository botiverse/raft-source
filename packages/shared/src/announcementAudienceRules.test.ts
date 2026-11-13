import assert from "node:assert/strict";
import {
  announcementRuleFlagKeys,
  matchesAnnouncementRules,
  validateAnnouncementAudience,
  validateAnnouncementAudienceRules,
  type AnnouncementRuleContext,
} from "../announcement-audience";

const now = new Date("2026-11-03T12:00:00Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60_000);
function ctx(overrides: Partial<AnnouncementRuleContext> = {}): AnnouncementRuleContext {
  return {
    now,
    accountCreatedAt: daysAgo(3),
    locale: "en",
    platform: "web",
    server: { createdAt: daysAgo(40), plan: "free", role: "owner" },
    flags: new Map([["focus_v2", true]]),
    ...overrides,
  };
}
const rules = (value: unknown) => validateAnnouncementAudienceRules(value);

test("rules ride on any audience and keep omitted keys omitted", () => {
  assert.deepEqual(validateAnnouncementAudience({ type: "all" }), { type: "all" });
  const audience = validateAnnouncementAudience({ type: "all", rules: { match: "all", groups: [{ match: "all", conditions: [{ field: "server_plan", values: ["pro", "free"] }] }] } });
  // Values are stored in canonical order so stored-JSON comparisons stay stable.
  assert.deepEqual(audience.rules, { match: "all", groups: [{ match: "all", conditions: [{ field: "server_plan", values: ["free", "pro"] }] }] });
});

test("validation rejects malformed or oversized rules", () => {
  const bad: unknown[] = [
    { match: "both", groups: [{ match: "all", conditions: [{ field: "locale", values: ["en"] }] }] },
    { match: "all", groups: [] },
    { match: "all", groups: [{ match: "all", conditions: [] }] },
    { match: "all", groups: [{ match: "all", conditions: [{ field: "nope" }] }] },
    { match: "all", groups: [{ match: "all", conditions: [{ field: "server_role", values: ["guest"] }] }] },
    { match: "all", groups: [{ match: "all", conditions: [{ field: "account_created", op: "within_days", days: 0 }] }] },
    { match: "all", groups: [{ match: "all", conditions: [{ field: "account_created", op: "after", date: "2026-02-30" }] }] },
    { match: "all", groups: [{ match: "all", conditions: [{ field: "account_created", op: "after", days: 3 }] }] },
    { match: "all", groups: [{ match: "all", conditions: [{ field: "feature_flag", key: "Bad Key" }] }] },
    { match: "all", groups: [{ match: "all", conditions: [{ field: "locale", values: ["en"], negate: false }] }] },
    { match: "all", groups: [{ match: "all", conditions: [{ field: "locale", values: ["en"], extra: 1 }] }] },
    { match: "all", groups: Array.from({ length: 6 }, () => ({ match: "all", conditions: [{ field: "locale", values: ["en"] }] })) },
    { match: "all", groups: [{ match: "all", conditions: Array.from({ length: 16 }, () => ({ field: "locale", values: ["en"] })) }] },
  ];
  for (const value of bad) assert.throws(() => rules(value), Error, JSON.stringify(value));
});

test("time conditions: within / older than N days, after / before a UTC date", () => {
  const one = (condition: unknown, context = ctx()) => matchesAnnouncementRules(rules({ match: "all", groups: [{ match: "all", conditions: [condition] }] }), context);
  assert.equal(one({ field: "account_created", op: "within_days", days: 7 }), true);
  assert.equal(one({ field: "account_created", op: "older_than_days", days: 7 }), false);
  assert.equal(one({ field: "account_created", op: "after", date: "2026-10-31" }), true);
  assert.equal(one({ field: "account_created", op: "before", date: "2026-10-31" }), false);
  assert.equal(one({ field: "server_created", op: "older_than_days", days: 14 }), true);
  assert.equal(one({ field: "server_created", op: "within_days", days: 14, negate: true }), true);
});

test("and/or across groups and inside a group", () => {
  const freeAdmins = { match: "all", conditions: [{ field: "server_plan", values: ["free"] }, { field: "server_role", values: ["owner", "admin"] }] };
  const chinese = { match: "any", conditions: [{ field: "locale", values: ["zh-cn"] }, { field: "locale", values: ["zh-tw"] }] };
  assert.equal(matchesAnnouncementRules(rules({ match: "all", groups: [freeAdmins, chinese] }), ctx()), false);
  assert.equal(matchesAnnouncementRules(rules({ match: "any", groups: [freeAdmins, chinese] }), ctx()), true);
  assert.equal(matchesAnnouncementRules(rules({ match: "all", groups: [freeAdmins, chinese] }), ctx({ locale: "zh-tw" })), true);
  assert.equal(matchesAnnouncementRules(rules({ match: "all", groups: [freeAdmins] }), ctx({ server: { createdAt: daysAgo(40), plan: "free", role: "member" } })), false);
});

test("an unknown fact is false even when negated", () => {
  const notAdmin = rules({ match: "all", groups: [{ match: "all", conditions: [{ field: "server_role", values: ["admin"], negate: true }] }] });
  assert.equal(matchesAnnouncementRules(notAdmin, ctx({ server: { createdAt: daysAgo(1), plan: "pro", role: "member" } })), true);
  assert.equal(matchesAnnouncementRules(notAdmin, ctx({ server: null })), false, "outside a Server, a Server condition never matches");
  const notDesktop = rules({ match: "all", groups: [{ match: "all", conditions: [{ field: "platform", values: ["desktop"], negate: true }] }] });
  assert.equal(matchesAnnouncementRules(notDesktop, ctx()), true);
  assert.equal(matchesAnnouncementRules(notDesktop, ctx({ platform: null })), false);
  const notEnglish = rules({ match: "all", groups: [{ match: "all", conditions: [{ field: "locale", values: ["en"], negate: true }] }] });
  assert.equal(matchesAnnouncementRules(notEnglish, ctx({ locale: null })), false);
});

test("feature flags: on, off, and a key not evaluated counts as off", () => {
  const on = rules({ match: "all", groups: [{ match: "all", conditions: [{ field: "feature_flag", key: "focus_v2" }] }] });
  const off = rules({ match: "all", groups: [{ match: "all", conditions: [{ field: "feature_flag", key: "focus_v2", negate: true }] }] });
  assert.equal(matchesAnnouncementRules(on, ctx()), true);
  assert.equal(matchesAnnouncementRules(off, ctx()), false);
  assert.equal(matchesAnnouncementRules(on, ctx({ flags: new Map() })), false);
  assert.deepEqual(announcementRuleFlagKeys(rules({ match: "any", groups: [{ match: "all", conditions: [{ field: "feature_flag", key: "b" }, { field: "feature_flag", key: "a" }] }, { match: "all", conditions: [{ field: "feature_flag", key: "a" }] }] })), ["a", "b"]);
});

test("no rules narrow nothing", () => {
  assert.equal(matchesAnnouncementRules(undefined, ctx({ server: null, platform: null, locale: null })), true);
});
