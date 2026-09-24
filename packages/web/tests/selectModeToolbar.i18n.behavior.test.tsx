import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import type { ComponentProps } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import SelectModeToolbar from "../src/components/message/SelectModeToolbar";
import { useSelectionStore } from "../src/store/selectionStore";
import { TestIntlProvider } from "./helpers/intl";

if (typeof ResizeObserver === "undefined") {
  (globalThis as typeof globalThis & { ResizeObserver: typeof ResizeObserver }).ResizeObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  };
}

afterEach(() => {
  cleanup();
  useSelectionStore.getState().exit();
});

function renderZhToolbar(overrides: Partial<ComponentProps<typeof SelectModeToolbar>> = {}) {
  useSelectionStore.getState().enter("channel-select-toolbar-i18n", ["m1", "m2"]);
  return render(
    <TestIntlProvider locale="zh-cn">
      <SelectModeToolbar
        channelId="channel-select-toolbar-i18n"
        onSavePic={() => {}}
        onShareX={() => {}}
        onCopyMd={() => {}}
        onForward={() => {}}
        onCopyLinks={() => {}}
        onSelectAll={() => {}}
        {...overrides}
      />
    </TestIntlProvider>,
  );
}

test("SelectModeToolbar renders selected-message chrome from the zh-cn catalog", () => {
  renderZhToolbar();

  assert.equal(screen.getByTestId("select-mode-count").textContent?.trim(), "已选 2 条");
  assert.equal(screen.getByTestId("select-mode-select-all").textContent?.trim(), "全选");
  assert.equal(screen.getByTestId("select-mode-cancel").textContent?.trim(), "取消");
  assert.equal(screen.getByTestId("select-mode-forward").textContent?.trim(), "转发");
  assert.equal(screen.getByTestId("select-mode-copy-link").textContent?.trim(), "复制链接");

  const more = screen.getByTestId("select-mode-more");
  assert.equal(more.getAttribute("aria-label"), "更多已选消息操作");
  assert.equal(more.getAttribute("title"), "更多");
  fireEvent.click(more);
  assert.equal(screen.getByTestId("select-mode-share-open").textContent?.trim(), "生成图片");
  assert.equal(screen.getByTestId("select-mode-copy-md").textContent?.trim(), "复制 Markdown");

  const body = document.body.textContent ?? "";
  for (const english of ["selected", "Select All", "Cancel", "Forward", "Copy link", "Generate image", "Copy MD"]) {
    assert.doesNotMatch(body, new RegExp(english), `English toolbar copy leaked: ${english}`);
  }
});

test("SelectModeToolbar renders zh-cn progress and copied states", () => {
  renderZhToolbar({ capturing: true, copied: true });

  assert.equal(screen.getByTestId("select-mode-copy-link").textContent?.trim(), "已复制");
  fireEvent.click(screen.getByTestId("select-mode-more"));
  assert.equal(screen.getByTestId("select-mode-share-open").textContent?.trim(), "正在生成…");
  assert.equal(screen.getByTestId("select-mode-copy-md").textContent?.trim(), "已复制 Markdown");
  assert.doesNotMatch(document.body.textContent ?? "", /Rendering|Copied MD|Copy MD|Copied/);
});
