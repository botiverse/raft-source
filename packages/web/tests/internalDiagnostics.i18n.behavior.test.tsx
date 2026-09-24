import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import type { ReactElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { useIntl } from "react-intl";

import { TestIntlProvider } from "./helpers/intl";
import { MockPanel } from "../src/components/workspace/WorkspaceGridRealPanel";
import { getEnvironmentLabelMessageId } from "../src/utils/devMode";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import type { WorkspacePanelConfig } from "../src/components/workspace/workspaceGridDemoConfig";

// Internal diagnostics (Task 6): nine reviewed findings migrate off baseline debt
// into catalog MessageIds. Workspace MockPanel chrome + environment badge labels
// must render through intl — deployment env *identifiers* (slockdev / staging /
// web-preview) stay untranslated.

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;

const DIAGNOSTIC_IDS = [
  "workspace.grid.mock.tasksPanelSummary",
  "workspace.grid.mock.replacementRuleReplaceable",
  "workspace.grid.mock.panelKindLabel",
  "workspace.grid.mock.pinnedBadge",
  "workspace.grid.mock.replacementRuleLabel",
  "workspace.grid.mock.lockedBy",
  "env.badge.webPreview",
  "env.badge.dev",
  "env.badge.staging",
] as const;

const EN_VALUES: Record<(typeof DIAGNOSTIC_IDS)[number], string> = {
  "workspace.grid.mock.tasksPanelSummary":
    "Server-wide TasksPanel hosted inside the workspace primary navigation pane.",
  "workspace.grid.mock.replacementRuleReplaceable":
    "May be replaced by explicit open-in-panel",
  "workspace.grid.mock.panelKindLabel": "Panel kind",
  "workspace.grid.mock.pinnedBadge": "Pinned",
  "workspace.grid.mock.replacementRuleLabel": "Replacement rule",
  "workspace.grid.mock.lockedBy": "Locked by {lockedBy}",
  "env.badge.webPreview": "Web Preview",
  "env.badge.dev": "Dev",
  "env.badge.staging": "Staging",
};

afterEach(() => {
  cleanup();
});

function renderZh(node: ReactElement) {
  return render(<TestIntlProvider locale="zh-cn">{node}</TestIntlProvider>);
}

const pinnedMockConfig: WorkspacePanelConfig = {
  kind: "tasks",
  title: "Tasks",
  subtitle: "Task queue panel",
  summary: "diagnostic-summary-probe",
  accent: "lime",
  pinned: true,
  lockedBy: "probe-lock",
};

test("catalog pins the nine diagnostic MessageIds with preserved English meaning", () => {
  for (const id of DIAGNOSTIC_IDS) {
    assert.equal(en[id], EN_VALUES[id], `${id} English source drifted`);
    assert.ok(zh[id], `${id} missing from zh-cn`);
    assert.notEqual(zh[id], en[id], `${id} is still English in zh-cn`);
    assert.match(zh[id], /\p{Script=Han}/u, `${id} has no Chinese characters`);
  }
  assert.match(en["workspace.grid.mock.lockedBy"], /\{lockedBy\}/);
  assert.match(zh["workspace.grid.mock.lockedBy"], /\{lockedBy\}/);
});

test("MockPanel renders diagnostic chrome through MessageIds under zh-cn", () => {
  renderZh(<MockPanel config={pinnedMockConfig} />);

  const text = document.body.textContent ?? "";
  assert.ok(text.includes(zh["workspace.grid.mock.panelKindLabel"]), "panel kind label");
  assert.ok(text.includes(zh["workspace.grid.mock.replacementRuleLabel"]), "replacement rule label");
  assert.ok(text.includes(zh["workspace.grid.mock.pinnedBadge"]), "pinned badge");
  assert.ok(
    text.includes(zh["workspace.grid.mock.lockedBy"].replace("{lockedBy}", "probe-lock")),
    "locked-by interpolation",
  );
  assert.ok(!text.includes("Panel kind"), "English panel kind leaked");
  assert.ok(!text.includes("Replacement rule"), "English replacement rule leaked");
  assert.ok(!text.includes("Pinned"), "English pinned badge leaked");
  assert.ok(!text.includes("Locked by"), "English locked-by leaked");
});

test("MockPanel replaceable rule uses the catalog under zh-cn", () => {
  renderZh(
    <MockPanel
      config={{
        ...pinnedMockConfig,
        pinned: false,
        lockedBy: undefined,
      }}
    />,
  );

  const text = document.body.textContent ?? "";
  assert.ok(
    text.includes(zh["workspace.grid.mock.replacementRuleReplaceable"]),
    "replaceable rule body",
  );
  assert.ok(
    !text.includes("May be replaced by explicit open-in-panel"),
    "English replaceable rule leaked",
  );
});

function EnvironmentBadgeProbe({ env }: { env: string }) {
  const { formatMessage } = useIntl();
  const id = getEnvironmentLabelMessageId(env);
  if (!id) return <span data-testid="env-badge">none</span>;
  return <span data-testid="env-badge">{formatMessage({ id })}</span>;
}

test("environment badges resolve slockdev/staging/web-preview through MessageIds", () => {
  assert.equal(getEnvironmentLabelMessageId("slockdev"), "env.badge.dev");
  assert.equal(getEnvironmentLabelMessageId("staging"), "env.badge.staging");
  assert.equal(getEnvironmentLabelMessageId("web-preview"), "env.badge.webPreview");
  assert.equal(getEnvironmentLabelMessageId("production"), null);
  assert.equal(getEnvironmentLabelMessageId(undefined), null);

  const cases = [
    ["slockdev", "env.badge.dev"],
    ["staging", "env.badge.staging"],
    ["web-preview", "env.badge.webPreview"],
  ] as const;

  for (const [env, id] of cases) {
    cleanup();
    const { getByTestId } = renderZh(<EnvironmentBadgeProbe env={env} />);
    assert.equal(getByTestId("env-badge").textContent, zh[id], `${env} badge`);
    assert.notEqual(getByTestId("env-badge").textContent, en[id], `${env} still English`);
  }
});
