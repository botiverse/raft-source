import assert from "node:assert/strict";
import test from "node:test";

import { formatRelativeTime, formatRelativeTimeParts } from "../src/utils/relativeTime.js";

test("shared relative-time formatter follows the app locale passed by the caller", () => {
  const fixedNow = Date.parse("2026-08-02T12:00:00.000Z");
  const realNow = Date.now;
  Date.now = () => fixedNow;
  try {
    const value = new Date(fixedNow - 3 * 60 * 60_000).toISOString();
    const zh = formatRelativeTime(value, "zh-cn");

    assert.match(zh ?? "", /3\s*小时前/, "zh app locale should render Chinese relative time");
    assert.doesNotMatch(zh ?? "", /hours?\s+ago/i, "relative time must not fall back to browser-locale English");
  } finally {
    Date.now = realNow;
  }
});

test("zh relative time separates digits from CJK units (盘古之白, task #61)", () => {
  const fixedNow = Date.parse("2026-08-02T12:00:00.000Z");
  const realNow = Date.now;
  Date.now = () => fixedNow;
  try {
    const threeHoursAgo = new Date(fixedNow - 3 * 60 * 60_000).toISOString();
    const fiveMinutesAhead = new Date(fixedNow + 5 * 60_000).toISOString();
    // CLDR renders these "3小时前"/"5分钟后"; the zh spacing pass must separate
    // the digit from the unit. Mutation (drop the zhMixedScriptSpacing pass)
    // turns these RED — receipts in PR #….
    assert.equal(formatRelativeTime(threeHoursAgo, "zh-cn"), "3 小时前");
    assert.equal(formatRelativeTime(fiveMinutesAhead, "zh-cn"), "5 分钟后");
    // en output is untouched by the zh spacing pass.
    assert.equal(formatRelativeTime(threeHoursAgo, "en"), "3 hours ago");
    assert.equal(formatRelativeTime(fiveMinutesAhead, "en"), "in 5 minutes");
  } finally {
    Date.now = realNow;
  }
});

test("parts formatter (react-intl replacement) applies zh spacing (盘古之白, task #61)", () => {
  // The four direct react-intl consumers (ThreadsInbox / MessageSearchPage /
  // AgentDMConversationList / AgentRemindersSection) now route through this —
  // reproduce react-intl's zh output and prove the spacing pass lands on it.
  // Mutation (drop the zhMixedScriptSpacing pass) -> RED.
  assert.equal(formatRelativeTimeParts(-3, "hour", "zh-cn"), "3 小时前");
  assert.equal(formatRelativeTimeParts(5, "minute", "zh-cn"), "5 分钟后");
  // en output is untouched by the zh spacing pass.
  assert.equal(formatRelativeTimeParts(-3, "hour", "en"), "3 hours ago");
  assert.equal(formatRelativeTimeParts(5, "minute", "en"), "in 5 minutes");
});

test("same (locale, options) constructs Intl.RelativeTimeFormat once; other locales stay isolated", () => {
  // @铁根 patrol 2026-08-04: both shared entry points constructed a fresh
  // Intl.RelativeTimeFormat per call; Activity/Inbox rows are unvirtualized, so
  // render cost grows with row count. Spy the constructor: same locale+options
  // must construct once, a different locale must construct its own.
  const RealRTF = Intl.RelativeTimeFormat;
  let constructions = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Intl as any).RelativeTimeFormat = class extends (RealRTF as any) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(locale: any, options?: any) {
      super(locale, options);
      constructions += 1;
    }
  };
  const fixedNow = Date.parse("2026-08-02T12:00:00.000Z");
  const realNow = Date.now;
  Date.now = () => fixedNow;
  try {
    const value = new Date(fixedNow - 3 * 60 * 60_000).toISOString();
    // de-DE / fr-FR are never warmed by other tests in this file.
    assert.equal(formatRelativeTime(value, "de-DE"), "vor 3 Stunden");
    assert.equal(formatRelativeTime(value, "de-DE"), "vor 3 Stunden");
    assert.equal(constructions, 1, "same locale+options must construct exactly once");
    assert.equal(formatRelativeTime(value, "fr-FR"), "il y a 3 heures");
    assert.equal(constructions, 2, "a different locale must construct its own formatter");
  } finally {
    Date.now = realNow;
    Intl.RelativeTimeFormat = RealRTF;
  }
});

test("shared relative-time formatter keeps absent and invalid inputs quiet", () => {
  assert.equal(formatRelativeTime(null, "zh-cn"), null);
  assert.equal(formatRelativeTime(undefined, "zh-cn"), null);
  assert.equal(formatRelativeTime("not-a-date", "zh-cn"), null);
});
