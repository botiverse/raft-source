import "./helpers/domSetup";

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createIntl } from "react-intl";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { TestIntlProvider } from "./helpers/intl";
import { ActivityThreadContentRoute } from "../src/components/layout/MainLayout";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { mergedMessages } from "../src/i18n/messages";
import { useInboxStore } from "../src/store/inboxStore";

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;

if (typeof window.matchMedia !== "function") {
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as never;
}

afterEach(() => {
  cleanup();
  useInboxStore.setState(useInboxStore.getInitialState(), true);
});

test("catalog pins main-layout MessageIds", () => {
  assert.equal(en["layout.main.loadingChannel"], "Loading channel");
  assert.equal(en["layout.main.loading"], "Loading...");
  assert.equal(en["layout.main.agentNotFound"], "Agent not found");
  assert.equal(en["layout.main.computerNotFound"], "Computer not found");
  assert.equal(en["layout.main.humanNotFound"], "Human not found");
  assert.equal(en["layout.main.threadNotInActivity"], "Thread is no longer in Activity");
  assert.equal(en["layout.main.settingsAria"], "Settings");
  assert.equal(en["layout.main.closeSettingsAria"], "Close Settings");
  assert.match(zh["layout.main.loadingChannel"], /\p{Script=Han}/u);
  assert.match(zh["layout.main.threadNotInActivity"], /\p{Script=Han}/u);
});

test("main-layout ids format under zh-cn", () => {
  const zhIntl = createIntl({
    locale: "zh-cn",
    defaultLocale: "en",
    messages: mergedMessages("zh-cn"),
  });
  assert.doesNotMatch(zhIntl.formatMessage({ id: "layout.main.agentNotFound" }), /Agent not found/);
  assert.equal(
    zhIntl.formatMessage({ id: "layout.main.closeSettingsAria" }),
    zh["layout.main.closeSettingsAria"],
  );
});

test("mounted Activity thread slot shows Chinese missing-thread copy, not English residue", () => {
  useInboxStore.setState({
    loaded: true,
    loading: false,
    items: [],
    loadInbox: async () => undefined,
  } as never);

  render(
    <MemoryRouter>
      <TestIntlProvider locale="zh-cn">
        <ActivityThreadContentRoute
          slot={{ kind: "thread", id: "missing-thread" }}
          closeSlot={() => undefined}
        />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  assert.ok(screen.getByText(zh["layout.main.threadNotInActivity"]));
  assert.equal(screen.queryByText("Thread is no longer in Activity"), null);
});
