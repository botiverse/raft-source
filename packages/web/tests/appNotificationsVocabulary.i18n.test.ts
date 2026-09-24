import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";

import { AppNotificationPermissionPicker } from "../src/components/settings/AppNotificationsControls";
import { en as enMessages } from "../src/i18n/messages/en";
import { mergedMessages } from "../src/i18n/messages";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";

// Sub-batch H2a vocabulary — ONLY the properties the type system cannot enforce.
//
// @artin challenged whether this file was needed at all. Checked by mutation
// rather than argued, and most of the first draft was indeed redundant:
//
//   display text back in GROUP_META / EVENT_LABEL_ID → TS2322 (MessageId is a
//     literal union, so "Server" is not assignable)
//   a deleted event row                              → TS2741 (Record<> totality)
//   an id missing from en.ts / zh-cn.ts              → zhCn is Record<MessageId, string>
//
// All three of those assertions were deleted. What survives is what typecheck
// returns 0 errors for:
//
//   a zh value left as the English string  (verified: 0 typecheck errors)
//   the {group} argument dropped from the message
//   the English "events" suffix re-hardcoded at the call site
//
// If you add to this file, apply the same test: mutate it, and if `typecheck`
// already fails, don't write the assertion.

const NS = "settings.connectedApps.appNotifications";

test("zh vocabulary is actually translated, not copied from en", () => {
  const en = enMessages as Record<string, string>;
  const zh = zhMessages as Record<string, string>;

  // Presence is compiler-guaranteed; this only checks the values differ and are
  // really Chinese — the failure that typecheck cannot see.
  const ids = Object.keys(en).filter(
    (k) => k.startsWith(`${NS}.group.`) || k.startsWith(`${NS}.event.`),
  );
  assert.ok(ids.length >= 30, `expected the H2a vocabulary, found ${ids.length}`);

  for (const id of ids) {
    // "Agent" stays English in zh — the product's own term (cf. 引导 Agent).
    //
    // "Computer" USED to be exempt here on the same reasoning. @AngLee's
    // 2026-08-01 vocabulary ruling supersedes that: app UI standardises on
    // 计算机, and only the "Raft Computer" BRAND name may stay English in
    // marketing/landing copy. This is a settings label, so it translates.
    // Left as an explicit two-case split rather than deleting the exemption, so
    // the next person can see that Computer was considered and reclassified
    // rather than simply forgotten.
    if (id === `${NS}.group.agent.label`) {
      assert.equal(zh[id], en[id], `${id} should deliberately stay the English term`);
      continue;
    }
    if (id === `${NS}.group.computer.label`) {
      assert.equal(zh[id], "计算机", `${id} follows the 计算机 vocabulary ruling`);
      continue;
    }
    assert.notEqual(zh[id], en[id], `${id} is still the English string in zh-cn.ts`);
    assert.match(zh[id], /\p{Script=Han}/u, `${id} has no Chinese characters`);
  }
});

test("the group-events summary keeps its {group} argument and no English suffix", () => {
  const en = enMessages as Record<string, string>;
  const zh = zhMessages as Record<string, string>;

  // Dropping {group} does not fail typecheck — formatMessage just renders the
  // message without the argument.
  assert.match(en[`${NS}.groupEventsSummary`], /\{group\}/, "en must interpolate {group}");
  assert.match(zh[`${NS}.groupEventsSummary`], /\{group\}/, "zh must interpolate {group}");

  const markup = renderToStaticMarkup(
    createElement(
      IntlProvider,
      { locale: "zh-cn", defaultLocale: "en", messages: mergedMessages("zh-cn") },
      createElement(AppNotificationPermissionPicker, {
        value: { groups: ["server"], events: [] },
        onChange: () => undefined,
      }),
    ),
  );
  assert.match(markup, /服务器 事件/);
  assert.doesNotMatch(markup, /Server events|服务器 events/);
});
