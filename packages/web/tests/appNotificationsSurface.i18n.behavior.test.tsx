import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { cleanup, render } from "@testing-library/react";

import { TestIntlProvider } from "./helpers/intl";
import {
  AppNotificationPermissionPicker,
  DeveloperAppNotifications,
} from "../src/components/settings/AppNotificationsControls";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";

// Sub-batch H2b — the remaining AppNotificationsControls surface strings, after
// H2a moved the two constant tables to MessageId.
//
// Scope note, per @artin: assert only what `typecheck` cannot. Presence of an id
// in either catalog is already a compile error if missing (zhCn is
// Record<MessageId, string>), so there are no presence assertions here. What
// survives is the wiring (does it reach the DOM in zh?) and the copy quality
// (is the zh value actually Chinese, or an untranslated paste?).

const NS = "settings.connectedApps.appNotifications";

// Deliberately English in zh — the product's own nouns, matching the existing
// catalog (cf. 引导 Agent). Listed by id so the exemption is explicit, not a
// loosened regex.
const KEEPS_ENGLISH = new Set([
  `${NS}.group.agent.label`,
  `${NS}.group.computer.label`,
  `${NS}.requiresAgentAndComputer`, // "需要 Agent + Computer" — both nouns stay
  `${NS}.appReviewPending`,         // pre-existing key, "App Review 待审核"
]);

afterEach(() => {
  cleanup();
});

test("the permission picker renders in Chinese, with no English left but the product nouns", () => {
  render(
    <TestIntlProvider locale="zh-cn">
      <AppNotificationPermissionPicker
        value={{ groups: ["server", "agent"], events: ["server.member_added"] }}
        onChange={() => {}}
      />
    </TestIntlProvider>,
  );

  const text = document.body.textContent ?? "";

  // Wiring: these are the H2b strings on this component's path.
  for (const zh of ["需要 Agent + Computer", "服务器", "成员已添加"]) {
    assert.ok(text.includes(zh), `picker should render ${zh}`);
  }

  // The DOM-dump backstop, as an assertion rather than a manual step: any run of
  // English letters that is not one of the deliberate product nouns means a
  // string escaped both scanners. This is what catches ternary-split sentences
  // and catch-block fallbacks, which no static sweep can see.
  const runs = new Set(text.match(/[A-Za-z][A-Za-z ]{6,}/g) ?? []);
  const allowed = /^(Computer|Agent)[A-Za-z ]*$/;
  const unexpected = [...runs].filter((r) => !allowed.test(r.trim()));
  assert.deepEqual(unexpected, [], `untranslated English reached the DOM: ${unexpected.join(" | ")}`);
});

test("H2b zh values are translated, not pasted from en", () => {
  const en = enMessages as Record<string, string>;
  const zh = zhMessages as Record<string, string>;

  // Presence is compiler-guaranteed; only the value matters here.
  const ids = Object.keys(en).filter(
    (k) => k.startsWith(`${NS}.`) && !k.includes(".group.") && !k.includes(".event."),
  );
  assert.ok(ids.length >= 20, `expected the H2b surface ids, found ${ids.length}`);

  for (const id of ids) {
    if (KEEPS_ENGLISH.has(id)) continue;
    assert.notEqual(zh[id], en[id], `${id} is still the English string in zh-cn.ts`);
    assert.match(zh[id], /\p{Script=Han}/u, `${id} has no Chinese characters`);
  }
});

test("the developer webhook panel renders in Chinese — the path the picker test never visited", () => {
  // WHY THIS EXISTS: the first version of this file rendered ONLY
  // AppNotificationPermissionPicker, so the DOM-dump assertion never visited
  // DeveloperAppNotifications — where the Save/Rotate/Copy ternaries and the
  // apiErrorMessage fallbacks live. Both static scanners reported 0 for the file,
  // so I claimed it complete and shipped a PR with ~20 live English strings.
  // @Wug caught it. A DOM backstop only backs up the components it mounts.
  render(
    <TestIntlProvider locale="zh-cn">
      <DeveloperAppNotifications
        clientId="client-1"
        value={{ groups: ["server"], events: ["server.member_added"] }}
        onChange={() => {}}
        state={null}
        loading={false}
        onStateChange={() => {}}
        onConfigurationOpenChange={() => {}}
        onError={() => {}}
      />
    </TestIntlProvider>,
  );

  const text = document.body.textContent ?? "";
  for (const zh of ["此应用可接收的 Raft 事件。", "投递", "启用 App 通知"]) {
    assert.ok(text.includes(zh), `developer panel should render ${zh}`);
  }

  // DECLARED GAP (NARROWED after @Wug showed the first version was too broad):
  // the Save/Rotate/Copy *buttons* need a user interaction to reach. Everything
  // reachable from state alone is now mounted — see the pending-revision test
  // below, which found a whole English sentence hiding inside the gap I had
  // originally declared. Declare gaps as narrowly as you can verify, or they
  // become the place nobody looks.
  const runs = new Set(text.match(/[A-Za-z][A-Za-z ]{6,}/g) ?? []);
  // "App Notifications" is the migrated section title — zh keeps the product name.
  // "Experimental" comes from raft-ui's <Badge.Experimental />, an EXTERNAL package
  // outside packages/web; reported to the team, not fixable in this lane.
  const allowed = /^(Computer|Agent|Webhook|HTTPS|App Review|App Notifications|Experimental)[A-Za-z ]*$/;
  const unexpected = [...runs].filter((r) => !allowed.test(r.trim()));
  assert.deepEqual(unexpected, [], `untranslated English in developer panel: ${unexpected.join(" | ")}`);
});

test("the pending-revision notice renders in Chinese (the branch the null-state dump missed)", () => {
  // @Wug's second finding on #5731. My declared gap said the endpoint form needs
  // interaction — too broad. The `configurationOpen && clientId` branch IS unit
  // renderable with webhook state, and a whole English sentence was hiding inside
  // the gap I had declared. A gap declared wider than reality becomes a hiding
  // place: you stop looking there.
  render(
    <TestIntlProvider locale="zh-cn">
      <DeveloperAppNotifications
        clientId="client-1"
        value={{ groups: ["server"], events: ["server.member_added"] }}
        onChange={() => {}}
        state={{
          webhook: { enabled: true, config_revision: 7 },
          approved_groups: ["server"],
          subscribed_events: ["server.member_added"],
          effective_events: ["server.member_added"],
          current_events: ["server.member_added"],
          pending_revision: { revision: 9 },
        } as never}
        loading={false}
        onStateChange={() => {}}
        onConfigurationOpenChange={() => {}}
        onError={() => {}}
      />
    </TestIntlProvider>,
  );

  const text = document.body.textContent ?? "";
  assert.ok(
    text.includes("修订版本 9 正在等待 App Review"),
    "pending-revision notice should render in Chinese with the revision interpolated",
  );
  assert.ok(!text.includes("is pending App Review"), "no untranslated pending-revision sentence");

  const runs = new Set(text.match(/[A-Za-z][A-Za-z ]{6,}/g) ?? []);
  const allowed = /^(Computer|Agent|Webhook|HTTPS|App Review|App Notifications|Experimental)[A-Za-z ]*$/;
  const unexpected = [...runs].filter((r) => !allowed.test(r.trim()));
  assert.deepEqual(unexpected, [], `untranslated English in pending-revision state: ${unexpected.join(" | ")}`);
});
