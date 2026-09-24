import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { TestIntlProvider } from "./helpers/intl";
import { OnboardingSessionFooter } from "../src/components/auth/OnboardingCreateShell";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { useAuthStore } from "../src/store/authStore";

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;

afterEach(() => {
  cleanup();
  useAuthStore.setState({ user: null, loading: false } as never);
});

test("onboarding session footer renders and executes the localized log-out action", () => {
  assert.equal(en["pages.serverSelector.logOut"], "Log out");
  assert.match(zh["pages.serverSelector.logOut"], /\p{Script=Han}/u);
  let logoutCalls = 0;
  useAuthStore.setState({
    user: {
      id: "user-1",
      email: "cindy@example.com",
      name: "Cindy",
    },
    loading: false,
    logout: () => {
      logoutCalls += 1;
    },
  } as never);

  render(
    <TestIntlProvider locale="zh-cn">
      <OnboardingSessionFooter />
    </TestIntlProvider>,
  );

  const action = screen.getByRole("button", { name: "退出登录" });
  assert.match(screen.getByTestId("onboarding-session-footer").textContent ?? "", /cindy@example\.com/);
  assert.equal(screen.queryByText("Log out"), null);
  fireEvent.click(action);
  assert.equal(logoutCalls, 1);
});
