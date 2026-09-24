import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import DialogCard from "../src/components/ui/DialogCard";
import ProgressBar from "../src/components/ui/ProgressBar";
import Spinner from "../src/components/ui/Spinner";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { TestIntlProvider } from "./helpers/intl";

// ui-primitives batch (Task 8): DialogCard close, ProgressBar aria, Spinner aria.

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;

afterEach(() => {
  cleanup();
});

test("catalog pins ui-primitives MessageIds with preserved English meaning", () => {
  assert.equal(en["common.close"], "Close");
  assert.equal(en["ui.progressBar.ariaLabel"], "Progress");
  assert.equal(en["common.loadingLabel"], "Loading");
  assert.match(zh["common.close"], /\p{Script=Han}/u);
  assert.match(zh["ui.progressBar.ariaLabel"], /\p{Script=Han}/u);
  assert.match(zh["common.loadingLabel"], /\p{Script=Han}/u);
  assert.notEqual(zh["ui.progressBar.ariaLabel"], en["ui.progressBar.ariaLabel"]);
});

test("ProgressBar default aria-label uses zh-cn catalog", () => {
  render(
    <TestIntlProvider locale="zh-cn">
      <ProgressBar value={40} />
    </TestIntlProvider>,
  );
  assert.ok(screen.getByRole("progressbar", { name: zh["ui.progressBar.ariaLabel"] }));
  assert.equal(screen.queryByRole("progressbar", { name: "Progress" }), null);
});

test("Spinner default aria-label uses zh-cn catalog", () => {
  render(
    <TestIntlProvider locale="zh-cn">
      <Spinner />
    </TestIntlProvider>,
  );
  assert.ok(screen.getByRole("status", { name: zh["common.loadingLabel"] }));
  assert.equal(screen.queryByRole("status", { name: "Loading" }), null);
});

test("DialogCard renders and executes its zh-cn close control", () => {
  let closes = 0;
  render(
    <TestIntlProvider locale="zh-cn">
      <DialogCard title="Probe" onClose={() => { closes += 1; }}>
        <p>Body</p>
      </DialogCard>
    </TestIntlProvider>,
  );

  const close = screen.getByRole("button", { name: zh["common.close"] });
  assert.equal(screen.queryByRole("button", { name: "Close" }), null);
  fireEvent.click(close);
  assert.equal(closes, 1);
});
