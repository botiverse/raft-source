import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import type { ReactElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { TestIntlProvider } from "./helpers/intl";
import SettingsPanel, { OAuthScopeList, DeclaredScopesPicker } from "../src/components/settings/SettingsPanel";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import api from "../src/api/client";
import { useServerStore } from "../src/store/serverStore";
import { useTranslationStore } from "../src/store/translationStore";

// SettingsPanel residue sweep — 10 ids.
//
// WHY THIS FILE EXISTS AT ALL: I reported SettingsPanel.tsx "complete" after
// sub-batches C–G. It was not. Re-running the sweep after fixing three
// false-negative bugs in it (word-count cap, [A-Za-z]-only word class,
// prefix-only template rule) surfaced 116 candidates in this file. Classified
// by hand: 34 already localized via `billingText()`/formatMessage, 37 inline
// `locale === "zh-CN"` ternaries in the billing section (a working parallel
// mechanism, deliberately untouched — scope call is @artin's), 32 noise
// (className, type signatures, developer-facing `throw new Error`, the `Raft`
// wordmark, `"App"`/`"new-app"` data fallbacks) — and these 10, which are real
// user-visible English I missed.
//
// TWO OF THE TEN ARE EMPTY-STATE STRINGS. That is not a coincidence: an empty
// state renders only when a list is empty, so a render test seeded with data
// never reaches it, and the DOM dump stays green. Both are mounted below with
// deliberately empty input.

const originalPatch = api.patch;
const zh = zhMessages as Record<string, string>;

afterEach(() => {
  cleanup();
  api.patch = originalPatch;
  useServerStore.setState(useServerStore.getInitialState(), true);
  useTranslationStore.setState(useTranslationStore.getInitialState(), true);
});

function renderZh(node: ReactElement) {
  return render(
    <TestIntlProvider locale="zh-cn">
      <MemoryRouter>{node}</MemoryRouter>
    </TestIntlProvider>,
  );
}

function seedLanguageSettings() {
  useServerStore.setState({
    servers: [{ id: "s1", slug: "s1", name: "S1" }],
    current: { id: "s1", slug: "s1", name: "S1" },
    members: [],
    loading: false,
  } as never);
  useTranslationStore.setState({
    settings: {
      ...useTranslationStore.getInitialState().settings,
      preferredTranslationMode: "off",
    },
    settingsServerId: "s1",
    settingsLoading: false,
    settingsError: null,
  } as never);
}

test("the empty grant-scope list renders its Chinese empty state", () => {
  // Reaching the empty branch needs BOTH: `scopes: []` and
  // `defaultToDeclared={false}`. With the default `true`, the component
  // backfills the declared scope set, so `visibleScopes` is never empty and this
  // branch cannot render — an "empty" fixture that quietly isn't empty is how an
  // empty-state test passes while asserting nothing.
  renderZh(<OAuthScopeList scopes={[]} defaultToDeclared={false} />);

  const text = document.body.textContent ?? "";
  assert.ok(text.includes("此连接当前没有已记录的有效权限范围。"), "Chinese empty state");
  assert.ok(
    !text.includes("No active grant scopes"),
    "the English empty state must be gone",
  );
});

test("the declared-scopes picker renders its Chinese section headings", () => {
  // `Identity` and `Agent messaging` are <summary> text inside <details>. They
  // are in the DOM whether or not the disclosure is open, but they are only in
  // the DOM if this component is mounted — and no earlier settings test mounts it.
  renderZh(<DeclaredScopesPicker value={[]} onChange={() => {}} />);

  const text = document.body.textContent ?? "";
  assert.ok(text.includes("身份"), "identity heading");
  assert.ok(text.includes("Agent 消息"), "agent messaging heading");
  assert.equal(text.includes("Agent messaging"), false, "no untranslated heading");
});

test("every id this batch added is present and actually translated", () => {
  const en = enMessages as Record<string, string>;
  const ids = [
    "settings.language.updateFailed",
    "settings.dateTime.updateFailed",
    "settings.onboarding.reopenSetupFailed",
    "settings.connectedApps.noGrantScopes",
    "settings.connectedApps.identitySection",
    "settings.connectedApps.agentMessagingSection",
    "settings.connectedApps.regenerateSecretFailed",
    "settings.connectedApps.marketplaceReviewFailed",
    "settings.connectedApps.appNotificationsTab",
    "settings.connectedApps.noInstalledAppsMatch",
  ];
  // `App Notifications` is the product's feature name and stays English on this
  // screen — settings.connectedApps.section.appNotifications already does. A tab
  // reading 应用通知 beside a section reading App Notifications is exactly the
  // drift this lane exists to prevent, so the exemption is named, not blanket.
  const UNTRANSLATED = new Set(["settings.connectedApps.appNotificationsTab"]);
  for (const id of ids) {
    assert.ok(en[id], `${id} missing from en.ts`);
    if (UNTRANSLATED.has(id)) {
      assert.equal(zh[id], en[id], `${id} must match the untranslated sibling`);
      continue;
    }
    assert.notEqual(zh[id], en[id], `${id} is still the English string`);
    assert.match(zh[id], /\p{Script=Han}/u, `${id} has no Chinese characters`);
  }
  assert.equal(
    zh["settings.connectedApps.section.appNotifications"],
    zh["settings.connectedApps.appNotificationsTab"],
    "the tab and the section must name the feature identically",
  );
  // `Agent` stays English inside the zh value by product convention, so the
  // Han-script check above is what proves the rest of the string was translated.
  assert.ok(zh["settings.connectedApps.agentMessagingSection"].includes("Agent"), "keeps the product term");
});

test("mounted language-region save surfaces Chinese fallback when the mode patch fails", async () => {
  seedLanguageSettings();
  api.patch = (async () => {
    throw new Error("network blip");
  }) as typeof api.patch;

  renderZh(<SettingsPanel tab="language-region" />);

  fireEvent.click(await screen.findByTestId("translation-mode-manual"));
  const languageSave = screen.getAllByRole("button", { name: zh["settings.common.save"] })[0] as HTMLButtonElement;
  await waitFor(() => assert.equal(languageSave.disabled, false));
  fireEvent.click(languageSave);

  assert.ok(await screen.findByText(zh["settings.language.updateFailed"]));
  assert.doesNotMatch(document.body.textContent ?? "", /Failed to update language preferences/);
});

test("new strings reuse this screen's established terminology", () => {
  // @Wug caught `下架复审` where the screen consistently says `下架审核` (复审 means
  // RE-review — a different thing). Reviewing the rest of the batch for the same
  // CLASS rather than fixing the one instance turned up two more: a third variant
  // for "scope", and a translated feature name that is untranslated beside it.
  // These assertions pin all three so the next batch cannot re-introduce them.
  const zh = zhMessages as Record<string, string>;

  assert.ok(
    zh["settings.connectedApps.marketplaceReviewFailed"].includes("下架审核"),
    "marketplace takedown review is 下架审核, not 下架复审",
  );
  assert.ok(
    !/复审/.test(zh["settings.connectedApps.marketplaceReviewFailed"]),
    "复审 means re-review — the wrong concept",
  );
  assert.ok(
    zh["settings.connectedApps.noGrantScopes"].includes("权限范围"),
    "scopes are 权限范围 here, matching declaredScopesTitle",
  );
  assert.ok(
    zh["settings.connectedApps.declaredScopesTitle"].includes("权限范围"),
    "the term this one is anchored to must still exist",
  );
});
