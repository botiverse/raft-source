import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { createIntl } from "react-intl";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import SocialProviderButton from "../src/components/auth/SocialProviderButton";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { mergedMessages } from "../src/i18n/messages";
import { TestIntlProvider } from "./helpers/intl";

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;

afterEach(() => {
  cleanup();
});

test("catalog pins social continue-with MessageId", () => {
  assert.equal(en["auth.social.continueWith"], "Continue with {provider}");
  assert.match(zh["auth.social.continueWith"], /\{provider\}/);
  assert.match(zh["auth.social.continueWith"], /\p{Script=Han}/u);
});

test("social continue-with formats under zh-cn", () => {
  const zhIntl = createIntl({
    locale: "zh-cn",
    defaultLocale: "en",
    messages: mergedMessages("zh-cn"),
  });
  assert.equal(
    zhIntl.formatMessage({ id: "auth.social.continueWith" }, { provider: "Google" }),
    zh["auth.social.continueWith"].replace("{provider}", "Google"),
  );
});

test("SocialProviderButton renders and executes the zh-cn provider action", () => {
  const clicked: string[] = [];
  render(
    <TestIntlProvider locale="zh-cn">
      <SocialProviderButton
        providerId="google"
        label="Google"
        onClick={(providerId) => clicked.push(providerId)}
      />
    </TestIntlProvider>,
  );

  const expected = zh["auth.social.continueWith"].replace("{provider}", "Google");
  const button = screen.getByRole("button", { name: expected });
  assert.equal(screen.queryByRole("button", { name: "Continue with Google" }), null);
  fireEvent.click(button);
  assert.deepEqual(clicked, ["google"]);
});
