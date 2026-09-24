import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { cleanup, render, screen } from "@testing-library/react";
import { createIntl } from "react-intl";

import LegacyTaskPanel from "../src/components/task/LegacyTaskPanel";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { mergedMessages } from "../src/i18n/messages";
import { useLegacyTaskPanelStore } from "../src/store/legacyTaskPanelStore";
import { TestIntlProvider } from "./helpers/intl";

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;

if (typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

afterEach(() => {
  cleanup();
  useLegacyTaskPanelStore.setState({ task: null });
});

test("catalog pins legacy-task MessageIds with Chinese and ICU", () => {
  assert.equal(en["task.legacyPanel.taskNumberLegacy"], "Task #{taskNumber} · LEGACY");
  assert.equal(en["task.legacyPanel.unknownChannel"], "unknown");
  assert.equal(en["task.legacyPanel.noDescription"], "No description");
  assert.equal(en["task.legacyPanel.notDone"], "Not done");
  assert.equal(en["task.legacyPanel.unknown"], "Unknown");
  assert.equal(
    en["task.legacyPanel.metadataOnlyHint"],
    "Legacy tasks do not map to a message thread. This panel shows task metadata only, and posting is disabled.",
  );
  assert.match(en["task.legacyPanel.taskNumberLegacy"], /\{taskNumber\}/);
  assert.match(zh["task.legacyPanel.taskNumberLegacy"], /\{taskNumber\}/);
  assert.match(zh["task.legacyPanel.notDone"], /\p{Script=Han}/u);
  assert.match(zh["task.legacyPanel.metadataOnlyHint"], /\p{Script=Han}/u);
  assert.notEqual(zh["task.legacyPanel.metadataOnlyHint"], en["task.legacyPanel.metadataOnlyHint"]);
});

test("legacy-task ids format under zh-cn", () => {
  const zhIntl = createIntl({
    locale: "zh-cn",
    defaultLocale: "en",
    messages: mergedMessages("zh-cn"),
  });
  assert.equal(
    zhIntl.formatMessage({ id: "task.legacyPanel.taskNumberLegacy" }, { taskNumber: 12 }),
    zh["task.legacyPanel.taskNumberLegacy"].replace("{taskNumber}", "12"),
  );
  assert.equal(zhIntl.formatMessage({ id: "task.legacyPanel.notDone" }), zh["task.legacyPanel.notDone"]);
  assert.doesNotMatch(
    zhIntl.formatMessage({ id: "task.legacyPanel.metadataOnlyHint" }),
    /Legacy tasks do not map/,
  );
});

test("LegacyTaskPanel renders missing legacy metadata through the zh-cn catalog", () => {
  useLegacyTaskPanelStore.setState({
    task: {
      id: "legacy-1",
      messageId: "legacy-1",
      channelId: "channel-1",
      channelName: null,
      taskNumber: 12,
      title: "Probe task",
      description: null,
      status: "todo",
      claimedByName: null,
      completedAt: null,
      createdById: "user-1",
      createdByType: "user",
      createdByName: null,
      createdAt: "2026-08-19T00:00:00.000Z",
      updatedAt: "2026-08-19T00:00:00.000Z",
      isLegacy: true,
    },
  });

  render(
    <TestIntlProvider locale="zh-cn">
      <LegacyTaskPanel presentation="modal" />
    </TestIntlProvider>,
  );

  assert.ok(screen.getByRole("heading", { name: "#未知" }));
  assert.ok(screen.getByText("任务 #12 · LEGACY"));
  assert.ok(screen.getByText("暂无描述"));
  assert.ok(screen.getByText("未分配"));
  assert.ok(screen.getByText("未完成"));
  assert.ok(screen.getByText("只读面板"));
  assert.ok(screen.getByText(zh["task.legacyPanel.metadataOnlyHint"]));

  const text = document.body.textContent ?? "";
  for (const english of [
    "No description",
    "Not done",
    "Unassigned",
    "Legacy tasks do not map to a message thread",
  ]) {
    assert.equal(text.includes(english), false, `English leaked: ${english}`);
  }
});
