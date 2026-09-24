import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import {
  AppRefreshRequiredScreen,
  AppRefreshWarningBanner,
} from "../src/components/errors/AppUpdateGate";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { TestIntlProvider } from "./helpers/intl";

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;

const IDS = [
  "app.update.refreshToContinue",
  "app.update.staleBuildBody",
  "app.update.refreshNow",
  "app.update.continueAnyway",
  "app.update.newerVersionAvailable",
  "app.update.refresh",
] as const;

afterEach(() => {
  cleanup();
});

test("catalog pins app-update MessageIds with preserved English meaning", () => {
  assert.equal(en["app.update.refreshToContinue"], "Refresh Raft to continue");
  assert.equal(
    en["app.update.staleBuildBody"],
    "This tab is running an older app build. Refresh to load the current version; unsent text or unsaved changes in this tab may be lost.",
  );
  assert.equal(en["app.update.refreshNow"], "Refresh now");
  assert.equal(en["app.update.continueAnyway"], "Continue anyway");
  assert.equal(en["app.update.newerVersionAvailable"], "A newer version of Raft is available.");
  assert.equal(en["app.update.refresh"], "Refresh");
  for (const id of IDS) {
    assert.match(zh[id], /\p{Script=Han}/u, `${id} missing Chinese`);
    assert.notEqual(zh[id], en[id], `${id} still English`);
  }
});

test("AppRefreshRequiredScreen renders zh-cn catalog copy", () => {
  let continued = 0;
  let recovered = 0;
  render(
    <TestIntlProvider locale="zh-cn">
      <AppRefreshRequiredScreen
        onContinueAnyway={() => { continued += 1; }}
        onRecoverAndRefresh={() => { recovered += 1; }}
      />
    </TestIntlProvider>,
  );
  assert.ok(screen.getByText(zh["app.update.refreshToContinue"]));
  assert.ok(screen.getByText(zh["app.update.staleBuildBody"]));
  assert.ok(screen.getByRole("button", { name: zh["app.update.refreshNow"] }));
  assert.ok(screen.getByRole("button", { name: zh["app.update.continueAnyway"] }));
  assert.doesNotMatch(document.body.textContent ?? "", /Refresh Raft to continue/);

  fireEvent.click(screen.getByRole("button", { name: zh["app.update.continueAnyway"] }));
  fireEvent.click(screen.getByRole("button", { name: zh["app.update.refreshNow"] }));
  assert.equal(continued, 1);
  assert.equal(recovered, 1);
});

test("AppRefreshWarningBanner renders zh-cn catalog copy", () => {
  let refreshed = 0;
  render(
    <TestIntlProvider locale="zh-cn">
      <AppRefreshWarningBanner onRefresh={() => { refreshed += 1; }} />
    </TestIntlProvider>,
  );
  assert.ok(screen.getByText(zh["app.update.newerVersionAvailable"]));
  assert.ok(screen.getByRole("button", { name: zh["app.update.refresh"] }));
  assert.doesNotMatch(document.body.textContent ?? "", /A newer version of Raft/);

  fireEvent.click(screen.getByRole("button", { name: zh["app.update.refresh"] }));
  assert.equal(refreshed, 1);
});
