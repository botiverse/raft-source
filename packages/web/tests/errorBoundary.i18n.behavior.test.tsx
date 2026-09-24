import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { cleanup, render, screen } from "@testing-library/react";

import RootErrorFallback from "../src/components/errors/RootErrorFallback";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { TestIntlProvider } from "./helpers/intl";

// error-boundary batch (Task 8): RootErrorFallback chrome must render via catalog.

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;

const IDS = [
  "errorBoundary.title",
  "errorBoundary.componentStack",
  "errorBoundary.reloadApp",
] as const;

afterEach(() => {
  cleanup();
});

test("catalog pins error-boundary MessageIds with preserved English meaning", () => {
  assert.equal(en["errorBoundary.title"], "Something went wrong");
  assert.equal(en["errorBoundary.componentStack"], "Component stack");
  assert.equal(en["errorBoundary.reloadApp"], "Reload app");
  for (const id of IDS) {
    assert.match(zh[id], /\p{Script=Han}/u, `${id} missing Chinese`);
    assert.notEqual(zh[id], en[id], `${id} still English`);
  }
});

test("RootErrorFallback renders zh-cn catalog copy", () => {
  render(
    <TestIntlProvider locale="zh-cn">
      <RootErrorFallback
        error={new Error("probe-failure")}
        componentStack={"\n    in Probe"}
      />
    </TestIntlProvider>,
  );

  assert.ok(screen.getByText(zh["errorBoundary.title"]));
  assert.ok(screen.getByText(zh["errorBoundary.componentStack"]));
  assert.ok(screen.getByRole("button", { name: zh["errorBoundary.reloadApp"] }));
  assert.ok(screen.getByText("probe-failure"));
  assert.doesNotMatch(document.body.textContent ?? "", /Something went wrong/);
  assert.doesNotMatch(document.body.textContent ?? "", /Reload app/);
});
