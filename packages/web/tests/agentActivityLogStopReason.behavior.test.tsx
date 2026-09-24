import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, render as rtlRender, screen } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });
import { MemoryRouter } from "react-router-dom";
import AgentActivityLog from "../src/components/agent/AgentActivityLog";
import { useAgentStore } from "../src/store/agentStore";
import type { TrajectoryLogEntry } from "../src/store/agentStore";
import { useChannelStore } from "../src/store/channelStore";

Element.prototype.scrollIntoView = function scrollIntoView() {};

afterEach(() => {
  cleanup();
  useAgentStore.setState({
    trajectoryLogs: {},
    loadTrajectoryLog: async () => {},
  } as never);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
});

function statusEntry(detail: string): TrajectoryLogEntry {
  return {
    timestamp: Date.UTC(2026, 0, 1, 8, 0, detail === "Computer stopped" ? 1 : 2),
    entry: {
      kind: "status",
      activity: "offline",
      activityKind: "offline",
      detail,
      detailKind: "stopped",
    },
  };
}

function getStatusRow(text: string): HTMLElement {
  return screen.getByText((_, element) => (
    element?.classList.contains("min-w-0") === true
    && element.textContent === text
  ));
}

test("activity log keeps stopped primary label while surfacing computer vs user stop reason", () => {
  useAgentStore.setState({
    trajectoryLogs: {
      "agent-stop-reason": [
        statusEntry("Computer stopped"),
        statusEntry("Agent stopped by user"),
      ],
    },
    loadTrajectoryLog: async () => {},
  } as never);

  render(
    <MemoryRouter>
      <AgentActivityLog agentId="agent-stop-reason" />
    </MemoryRouter>,
  );

  assert.equal(screen.getAllByText("Stopped").length, 2);
  assert.ok(getStatusRow("Stopped - Computer stopped"));
  assert.ok(getStatusRow("Stopped - Agent stopped by user"));
});

test("activity ref chips keep the shared line box inside clamped detail rows", () => {
  useChannelStore.setState({
    channels: [{
      id: "channel-artifacts",
      serverId: "server-1",
      name: "artifacts",
      type: "channel",
      description: null,
      archivedAt: null,
      isDefault: false,
      createdAt: "2026-07-10T00:00:00.000Z",
    }],
  } as never);
  useAgentStore.setState({
    trajectoryLogs: {
      "agent-stop-reason": [{
        timestamp: Date.UTC(2026, 6, 10, 23, 28, 3),
        entry: {
          kind: "slock_action",
          title: "Send draft held",
          text: `target: #artifacts:62b98a34\n${"unreviewed synced context ".repeat(12)}`,
        },
      }],
    },
    loadTrajectoryLog: async () => {},
  } as never);

  render(
    <MemoryRouter>
      <AgentActivityLog agentId="agent-stop-reason" />
    </MemoryRouter>,
  );

  const ref = screen.getByRole("link", { name: "#artifacts:62b98a34" });
  assert.ok(ref.classList.contains("inline-block"));
  assert.ok(ref.classList.contains("align-bottom"));
  assert.ok(ref.classList.contains("leading-[1.3em]"));
  assert.ok(ref.classList.contains("overflow-hidden"));
  assert.ok(ref.parentElement?.classList.contains("line-clamp-2"));
});
