import assert from "node:assert/strict";
import test from "node:test";
import { createIntl } from "react-intl";

import {
  createWorkspaceGridDemoInitialModel,
} from "../src/components/workspace/workspaceGridDemoConfig";
import {
  resolveCanonicalPanelDisplay,
  serializeWorkspaceGridLayoutIntent,
} from "../src/components/workspace/workspaceGridUrlState";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { mergedMessages } from "../src/i18n/messages";

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;

test("catalog pins workspace-grid MessageIds", () => {
  assert.equal(en["workspace.grid.demo.pin"], "Pin");
  assert.equal(en["workspace.grid.demo.closeAll"], "Close all");
  assert.equal(en["workspace.panel.resolvedSummary"], "Resolved from the current workspace when this layout is opened.");
  assert.equal(en["workspace.grid.demo.chatTitle"], "Chat");
  assert.match(en["workspace.grid.demo.actionsFor"], /\{name\}/);
  assert.match(zh["workspace.grid.demo.pin"], /\p{Script=Han}/u);
  assert.match(zh["workspace.panel.resolvedSummary"], /\p{Script=Han}/u);
});

test("workspace-grid .ts producers accept formatMessage under zh-cn", () => {
  const zhIntl = createIntl({
    locale: "zh-cn",
    defaultLocale: "en",
    messages: mergedMessages("zh-cn"),
  });
  const formatMessage = (descriptor: { id: keyof typeof enMessages }, values?: Record<string, string | number>) =>
    String(zhIntl.formatMessage(descriptor, values));

  const display = resolveCanonicalPanelDisplay("channel", formatMessage);
  assert.equal(display.subtitle, zh["workspace.panel.channel"]);
  assert.doesNotMatch(display.summary, /Resolved from the current workspace/);

  const model = createWorkspaceGridDemoInitialModel(formatMessage);
  const primary = model.layout.children?.[0];
  assert.equal(primary?.type, "tabset");
  const tab = primary?.type === "tabset" ? primary.children?.[0] : undefined;
  assert.equal(tab?.config?.title, zh["workspace.grid.demo.chatTitle"]);
  assert.equal(tab?.config?.subtitle, zh["workspace.panel.channel"]);

  const withRef = structuredClone(model);
  const withRefPrimary = withRef.layout.children?.[0];
  assert.equal(withRefPrimary?.type, "tabset");
  const withRefTab = withRefPrimary?.type === "tabset" ? withRefPrimary.children?.[0] : undefined;
  assert.ok(withRefTab?.config);
  withRefTab.config = {
    ...withRefTab.config,
    ref: { kind: "channel", id: "channel-1" },
    title: "#renamed",
    summary: "Server-owned channel description must not be copied into the URL.",
  };
  const serialized = serializeWorkspaceGridLayoutIntent(withRef, formatMessage);
  const serializedTab = serialized.layout.children?.[0]?.type === "tabset"
    ? serialized.layout.children[0].children?.[0]
    : undefined;
  assert.equal(serializedTab?.config?.summary, zh["workspace.panel.resolvedSummary"]);
  assert.equal(serializedTab?.config?.title, zh["workspace.panel.channelTitle"]);
});
