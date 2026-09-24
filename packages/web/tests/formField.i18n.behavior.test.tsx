import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { cleanup, render, screen } from "@testing-library/react";

import FormField from "../src/components/ui/FormField";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { TestIntlProvider } from "./helpers/intl";

afterEach(() => {
  cleanup();
});

test("FormField optional marker is translated in both catalogs", () => {
  const en = enMessages as Record<string, string>;
  const zh = zhMessages as Record<string, string>;

  assert.equal(en["ui.formField.optional"], "(optional)");
  assert.ok(zh["ui.formField.optional"], "ui.formField.optional missing from zh-cn.ts");
  assert.notEqual(zh["ui.formField.optional"], en["ui.formField.optional"]);
  assert.match(zh["ui.formField.optional"], /\p{Script=Han}/u);
});

test("FormField renders localized zh optional marker", () => {
  render(
    <TestIntlProvider locale="zh-cn">
      <FormField label="描述" optional>
        <input aria-label="描述" />
      </FormField>
    </TestIntlProvider>,
  );

  assert.ok(screen.getByText("可选"), "optional marker in Chinese");
  assert.equal(screen.queryByText("(optional)"), null, "no untranslated optional marker");
});

test("FormField optional marker stays human-readable without an IntlProvider", () => {
  render(
    <FormField label="Description" optional>
      <input aria-label="Description" />
    </FormField>,
  );

  assert.ok(screen.getByText("(optional)"), "fallback optional marker");
});
