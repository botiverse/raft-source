import assert from "node:assert/strict";
import test from "node:test";
import { createIntl } from "react-intl";

import { resolveCanonicalPanelDisplay } from "../src/components/workspace/workspaceGridUrlState";
import type { WorkspacePanelKind } from "../src/components/workspace/workspaceGridDemoConfig";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { mergedMessages } from "../src/i18n/messages";

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;

test("catalog pins workspace-panels MessageIds", () => {
  assert.equal(en["workspace.panel.channel"], "Channel panel");
  assert.equal(en["workspace.panel.directMessage"], "Direct-message panel");
  assert.equal(en["workspace.panel.agent"], "Agent panel");
  assert.equal(en["workspace.panel.taskQueue"], "Task queue panel");
  assert.equal(en["workspace.panel.activityItem"], "Activity item");
  assert.equal(en["workspace.panel.savedMessage"], "Saved message");
  assert.equal(en["search.panelThreadTitle"], "Thread {id}");
  assert.match(zh["workspace.panel.channel"], /\p{Script=Han}/u);
  assert.match(zh["workspace.panel.savedMessage"], /\p{Script=Han}/u);
});

test("workspace-panels ids format under zh-cn", () => {
  const zhIntl = createIntl({
    locale: "zh-cn",
    defaultLocale: "en",
    messages: mergedMessages("zh-cn"),
  });
  assert.doesNotMatch(
    zhIntl.formatMessage({ id: "workspace.panel.agent" }),
    /Agent panel/,
  );
  assert.match(
    zhIntl.formatMessage({ id: "search.panelThreadTitle" }, { id: "abc12345" }),
    /\p{Script=Han}|abc12345/,
  );
});

test("canonical panel producers emit zh-cn chrome without English subtitles", () => {
  const zhIntl = createIntl({
    locale: "zh-cn",
    defaultLocale: "en",
    messages: mergedMessages("zh-cn"),
  });
  const formatMessage = (
    descriptor: { id: keyof typeof enMessages },
    values?: Record<string, string | number>,
  ) => String(zhIntl.formatMessage(descriptor, values));

  const expected: Array<[WorkspacePanelKind, string]> = [
    ["channel", zh["workspace.panel.channel"]],
    ["dm", zh["workspace.panel.directMessage"]],
    ["agent", zh["workspace.panel.agent"]],
    ["tasks", zh["workspace.panel.taskQueue"]],
  ];
  for (const [kind, subtitle] of expected) {
    const display = resolveCanonicalPanelDisplay(kind, formatMessage);
    assert.equal(display.subtitle, subtitle, kind);
    assert.doesNotMatch(display.subtitle, /panel$/);
  }

  assert.match(formatMessage({ id: "workspace.panel.activityItem" }), /\p{Script=Han}/u);
  assert.match(formatMessage({ id: "workspace.panel.savedMessage" }), /\p{Script=Han}/u);
  assert.equal(
    formatMessage({ id: "search.panelThreadTitle" }, { id: "abc12345" }),
    zh["search.panelThreadTitle"].replace("{id}", "abc12345"),
  );
});
