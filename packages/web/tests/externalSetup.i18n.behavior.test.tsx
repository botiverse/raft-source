import assert from "node:assert/strict";
import test from "node:test";
import "./helpers/domSetup";
import { cleanup, render, screen } from "@testing-library/react";

import { ExternalSetupTabSegmentedControl } from "../src/components/agent/ExternalSetupTabSegmentedControl";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { TestIntlProvider } from "./helpers/intl";

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;

test("catalog pins external-setup other-agents MessageId", () => {
  assert.equal(en["agent.externalSetup.otherAgents"], "Other agents");
  assert.match(zh["agent.externalSetup.otherAgents"], /\p{Script=Han}/u);
});

test("external setup segmented control renders the zh-cn other-agents option", () => {
  render(
    <TestIntlProvider locale="zh-cn">
      <ExternalSetupTabSegmentedControl value="claude-code" onValueChange={() => {}} />
    </TestIntlProvider>,
  );
  assert.ok(screen.getByText(zh["agent.externalSetup.otherAgents"]));
  assert.equal(screen.queryByText("Other agents"), null);
  cleanup();
});
