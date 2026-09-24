import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { cleanup, render, screen } from "@testing-library/react";

import { TestIntlProvider } from "./helpers/intl";
import { AuthBootstrapStatus } from "../src/App";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";

// Auth batch (Task 8): the single AppShell bootstrap debt literal
// "Restoring session…" must render through react-intl under zh-cn.

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;

const RESTORING_ID = "auth.bootstrap.restoringSession";

afterEach(() => {
  cleanup();
});

function renderZh(view: "loading" | "restoring") {
  return render(
    <TestIntlProvider locale="zh-cn">
      <AuthBootstrapStatus view={view} />
    </TestIntlProvider>,
  );
}

test("catalog pins auth.bootstrap.restoringSession with preserved meaning", () => {
  assert.equal(en[RESTORING_ID], "Restoring session…");
  assert.equal(zh[RESTORING_ID], "正在恢复会话…");
  assert.match(zh[RESTORING_ID], /\p{Script=Han}/u);
});

test("AuthBootstrapStatus restoring view renders zh-cn catalog copy", () => {
  renderZh("restoring");

  assert.ok(screen.getByText("正在恢复会话…"));
  assert.doesNotMatch(document.body.textContent ?? "", /Restoring session/i);
  assert.doesNotMatch(document.body.textContent ?? "", /auth\.bootstrap\./);
});

test("AuthBootstrapStatus loading view still uses common.loading", () => {
  renderZh("loading");

  assert.ok(screen.getByText("加载中…"));
  assert.doesNotMatch(document.body.textContent ?? "", /Restoring session/i);
});
