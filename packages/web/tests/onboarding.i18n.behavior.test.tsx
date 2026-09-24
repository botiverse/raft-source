import "./helpers/domSetup";

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createIntl } from "react-intl";
import { cleanup, render, screen } from "@testing-library/react";

import { TestIntlProvider } from "./helpers/intl";
import ServerSetupHandoffStep from "../src/components/onboarding/ServerSetupHandoffStep";
import ServerSetupSurveyStep from "../src/components/onboarding/ServerSetupSurveyStep";
import SetupSessionFooter from "../src/components/onboarding/SetupSessionFooter";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { mergedMessages } from "../src/i18n/messages";
import { useAuthStore } from "../src/store/authStore";
import { useServerStore } from "../src/store/serverStore";

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;

afterEach(() => {
  cleanup();
  useAuthStore.setState({ user: null, loading: false, initialized: true } as never);
  useServerStore.setState(useServerStore.getInitialState(), true);
});

test("catalog pins onboarding MessageIds", () => {
  assert.equal(en["layout.onboarding.handoffTitle"], "{agentName} takes it from here");
  assert.match(en["layout.onboarding.handoffBody"], /\{agentName\}/);
  assert.equal(en["layout.onboarding.continue"], "Continue");
  assert.equal(en["layout.onboarding.switchServer"], "Switch server");
  assert.equal(en["layout.onboarding.startOverTitle"], "Start over?");
  assert.match(en["layout.onboarding.startOverMessageWithComputers"], /\{count, plural/);
  assert.match(zh["layout.onboarding.handoffTitle"], /\{agentName\}/);
  assert.match(zh["layout.onboarding.switchServer"], /\p{Script=Han}/u);
});

test("onboarding ids format under zh-cn", () => {
  const zhIntl = createIntl({
    locale: "zh-cn",
    defaultLocale: "en",
    messages: mergedMessages("zh-cn"),
  });
  assert.doesNotMatch(
    zhIntl.formatMessage({ id: "layout.onboarding.handoffTitle" }, { agentName: "Cindy" }),
    /takes it from here/,
  );
  assert.match(
    zhIntl.formatMessage(
      { id: "layout.onboarding.startOverMessageWithComputers" },
      { count: 2 },
    ),
    /\p{Script=Han}/u,
  );
});

test("mounted setup handoff renders Chinese title and switch-server chrome", () => {
  render(
    <TestIntlProvider locale="zh-cn">
      <ServerSetupHandoffStep serverId="server-1" agentName="Cindy" onDone={() => undefined} />
    </TestIntlProvider>,
  );

  assert.ok(screen.getByText(zh["layout.onboarding.handoffTitle"].replace("{agentName}", "Cindy")));
  assert.ok(screen.getByTestId("setup-switch-server"));
  assert.equal(screen.getByTestId("setup-switch-server").textContent, zh["layout.onboarding.switchServer"]);
  assert.doesNotMatch(document.body.textContent ?? "", /takes it from here/);
  assert.equal(screen.queryByText("Switch server"), null);
});

test("mounted setup survey renders Chinese continue chrome, not English residue", () => {
  useAuthStore.setState({ loading: false } as never);
  render(
    <TestIntlProvider locale="zh-cn">
      <ServerSetupSurveyStep agentName="Cindy" onDone={() => undefined} />
    </TestIntlProvider>,
  );

  assert.ok(screen.getByTestId("server-setup-survey-continue"));
  assert.equal(
    screen.getByTestId("server-setup-survey-continue").textContent,
    zh["layout.onboarding.continue"],
  );
  assert.match(document.body.textContent ?? "", /\p{Script=Han}/u);
  assert.equal(screen.queryByRole("button", { name: "Continue" }), null);
});

test("mounted setup footer switch-server control is Chinese", () => {
  render(
    <TestIntlProvider locale="zh-cn">
      <SetupSessionFooter />
    </TestIntlProvider>,
  );

  assert.equal(screen.getByTestId("setup-switch-server").textContent, zh["layout.onboarding.switchServer"]);
  assert.equal(screen.queryByText("Switch server"), null);
});
