import "./helpers/domSetup";

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { cleanup, render, screen } from "@testing-library/react";
import { useIntl } from "react-intl";

import { useLocale } from "../src/i18n/LocaleProvider";
import { zhCn } from "../src/i18n/messages/zh-cn";
import { VisualTestingRoot } from "../visual-testing/VisualTestingRoot";

window.matchMedia = window.matchMedia ?? (() => ({
  matches: false,
  media: "",
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
}));

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function LocaleProbe() {
  const { locale } = useLocale();
  const { formatMessage } = useIntl();
  return (
    <output data-testid="visual-locale">
      {locale}|{formatMessage({ id: "common.loading" })}
    </output>
  );
}

test("the visual render host gives its cases the active locale and matching intl catalog", () => {
  window.localStorage.setItem("slock.displayLanguage", "zh-cn");

  render(
    <VisualTestingRoot defaultTheme="brutal">
      <LocaleProbe />
    </VisualTestingRoot>,
  );

  assert.equal(
    screen.getByTestId("visual-locale").textContent,
    `zh-cn|${zhCn["common.loading"]}`,
  );
});
