import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { cleanup, render, screen } from "@testing-library/react";

import SelectionPopover from "../src/components/ui/SelectionPopover";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { TestIntlProvider } from "./helpers/intl";

const IDS = [
  "ui.selectionPopover.emptyLabel",
  "ui.selectionPopover.searchPlaceholder",
  "ui.selectionPopover.clear",
];

afterEach(() => {
  cleanup();
});

test("SelectionPopover primitive-owned copy is translated in both catalogs", () => {
  const en = enMessages as Record<string, string>;
  const zh = zhMessages as Record<string, string>;

  for (const id of IDS) {
    assert.ok(en[id], `${id} missing from en.ts`);
    assert.ok(zh[id], `${id} missing from zh-cn.ts`);
    assert.notEqual(zh[id], en[id], `${id} is still the English string in zh-cn.ts`);
    assert.match(zh[id], /\p{Script=Han}/u, `${id} has no Chinese characters`);
  }
});

test("SelectionPopover renders localized zh defaults when callers omit copy props", () => {
  render(
    <TestIntlProvider locale="zh-cn">
      <SelectionPopover
        title="t"
        searchable
        search=""
        onSearchChange={() => {}}
        showClear
        onClear={() => {}}
        options={[]}
      />
    </TestIntlProvider>,
  );

  assert.ok(screen.getByText("没有匹配项"), "empty label in Chinese");
  assert.ok(screen.getByPlaceholderText("搜索…"), "search placeholder in Chinese");
  assert.ok(screen.getByRole("button", { name: "清除" }), "clear button in Chinese");
  assert.equal(screen.queryByText("No matches"), null, "no untranslated empty label");
  assert.equal(screen.queryByPlaceholderText("Search…"), null, "no untranslated search placeholder");
  assert.equal(screen.queryByRole("button", { name: "Clear" }), null, "no untranslated clear button");
});
