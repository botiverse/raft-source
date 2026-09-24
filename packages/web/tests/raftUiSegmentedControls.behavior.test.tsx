import assert from "node:assert/strict";
import "./helpers/domSetup";
import { TestIntlProvider } from "./helpers/intl";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ExternalSetupTabSegmentedControl } from "../src/components/agent/ExternalSetupTabSegmentedControl";
import {
  BillingIntervalSegmentedControl,
  ConnectedAppsTabSegmentedControl,
  MessageBodyFontSizeSegmentedControl,
} from "../src/components/settings/SettingsSegmentedControls";
import { getTaskFilterTabs, TaskFilterSegmentedControl } from "../src/components/task/TaskFilterSegmentedControl";

afterEach(cleanup);

const noop = () => {};

test("task filter segmented control renders every status tab with positive counts only", () => {
  assert.deepEqual(
    getTaskFilterTabs().map((tab) => tab.key),
    ["all", "todo", "in_progress", "in_review", "done", "closed"],
  );

  // Wrapped since the five status tabs now read TASK_STATUS_UI[status].labelId
  // and format at the edge (#5865). The assertions below still pin the rendered
  // WORDS, so this stays a behaviour test: it would catch a wrong id as surely
  // as it caught the missing provider.
  render(
    <TestIntlProvider>
      <TaskFilterSegmentedControl
        value="all"
        onValueChange={noop}
        counts={{
          all: 3,
          todo: 1,
          in_progress: 0,
          in_review: 2,
          done: 0,
          closed: 0,
        }}
      />
    </TestIntlProvider>,
  );

  assert.equal(screen.getByTestId("channel-task-filter-all").textContent, "All3");
  assert.equal(screen.getByTestId("channel-task-filter-todo").textContent, "Todo1");
  assert.equal(screen.getByTestId("channel-task-filter-in_progress").textContent, "In Progress");
  assert.equal(screen.getByTestId("channel-task-filter-in_review").textContent, "In Review2");
  assert.equal(screen.getByTestId("channel-task-filter-done").textContent, "Done");
  assert.equal(screen.getByTestId("channel-task-filter-closed").textContent, "Closed");
});

test("external setup segmented control renders each setup path label", () => {
  const values: string[] = [];
  const { rerender } = render(
    <TestIntlProvider locale="en">
      <ExternalSetupTabSegmentedControl value="claude-code" onValueChange={(value) => values.push(value)} />
    </TestIntlProvider>,
  );

  assert.ok(screen.getByText("Hermes"));
  assert.ok(screen.getByText("Claude Code"));
  assert.ok(screen.getByText("Other agents"));

  fireEvent.click(screen.getByText("Hermes"));
  rerender(
    <TestIntlProvider locale="en">
      <ExternalSetupTabSegmentedControl value="hermes" onValueChange={(value) => values.push(value)} />
    </TestIntlProvider>,
  );
  fireEvent.click(screen.getByText("Claude Code"));
  rerender(
    <TestIntlProvider locale="en">
      <ExternalSetupTabSegmentedControl value="claude-code" onValueChange={(value) => values.push(value)} />
    </TestIntlProvider>,
  );
  fireEvent.click(screen.getByText("Other agents"));
  assert.deepEqual(values, ["hermes", "claude-code", "other-agents"]);
});

test("billing interval segmented control keeps monthly and annual actions addressable", () => {
  // Wrapped in an EN provider now that this control reads its labels from the
  // catalog. The assertions below are DELIBERATELY UNCHANGED: the English output
  // must be byte-identical after the migration, which is the strongest available
  // check that moving these labels into the catalog did not alter the copy.
  render(
    <TestIntlProvider locale="en">
      <BillingIntervalSegmentedControl value="monthly" onValueChange={noop} />
    </TestIntlProvider>,
  );

  assert.equal(screen.getByTestId("billing-interval-monthly").textContent, "Monthly");
  assert.match(screen.getByTestId("billing-interval-annual").textContent ?? "", /Yearly/);
  assert.match(screen.getByTestId("billing-interval-annual").textContent ?? "", /Save/);
});

test("connected apps segmented control renders counts only when non-zero", () => {
  render(
    <TestIntlProvider>
      <ConnectedAppsTabSegmentedControl
        value="marketplace"
        onValueChange={noop}
        options={[
          { value: "marketplace", label: "Marketplace", count: 2, testId: "connected-apps-tab-marketplace" },
          { value: "installed", label: "Installed", count: 0, testId: "connected-apps-tab-installed" },
          { value: "myapps", label: "My apps", count: 1, testId: "connected-apps-tab-my-apps" },
        ]}
      />
    </TestIntlProvider>,
  );

  assert.equal(screen.getByTestId("connected-apps-tab-marketplace").textContent, "Marketplace2");
  assert.equal(screen.getByTestId("connected-apps-tab-installed").textContent, "Installed");
  assert.equal(screen.getByTestId("connected-apps-tab-my-apps").textContent, "My apps1");
});

test("message body font size segmented control renders all persisted options", () => {
  render(
    <TestIntlProvider>
      <MessageBodyFontSizeSegmentedControl value="md" onValueChange={noop} />
    </TestIntlProvider>,
  );

  assert.equal(screen.getByTestId("message-font-size-sm").textContent, "Small");
  assert.equal(screen.getByTestId("message-font-size-md").textContent, "Medium");
  assert.equal(screen.getByTestId("message-font-size-lg").textContent, "Large");
});
