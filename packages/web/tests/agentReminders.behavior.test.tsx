import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReminderSummary } from "@botiverse/raft-shared";
import AgentRemindersSection from "../src/components/agent/AgentRemindersSection";
import { TestIntlProvider } from "./helpers/intl";

afterEach(cleanup);

function makeReminder(): ReminderSummary {
  return {
    reminderId: "reminder-1",
    ownerAgentId: "agent-1",
    title: "Review the source-proxy ledger",
    fireAt: "2026-08-21T09:00:00.000Z",
    firedAt: null,
    createdAt: "2026-08-20T09:00:00.000Z",
    status: "scheduled",
    msgRef: "#proj-uiux:4bcb253d",
    msgPermalink: "https://app.raft.ai/s/botiverse/channel/uiux?msg=4bcb253d",
    recurrence: null,
  };
}

test("reminder message refs stay keyboard-reachable links with app-chrome cursor semantics", () => {
  const opened: string[] = [];
  render(
    <TestIntlProvider>
      <AgentRemindersSection
        reminders={[makeReminder()]}
        loading={false}
        error={null}
        onOpenMsgRef={(permalink) => opened.push(permalink)}
      />
    </TestIntlProvider>,
  );

  const link = screen.getByRole("link", { name: "#proj-uiux:4bcb253d" });
  assert.equal(link.getAttribute("href"), "https://app.raft.ai/s/botiverse/channel/uiux?msg=4bcb253d");
  assert.ok(link.classList.contains("cursor-default"));
  assert.equal(link.classList.contains("cursor-pointer"), false);

  link.focus();
  assert.equal(document.activeElement, link, "the app-chrome cursor does not remove keyboard reachability");
  fireEvent.click(link);
  assert.deepEqual(opened, ["https://app.raft.ai/s/botiverse/channel/uiux?msg=4bcb253d"]);
});
