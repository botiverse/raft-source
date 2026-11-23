import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { AgentMigrationLogEntry, AgentMigrationLogResponse } from "@botiverse/raft-shared";

import api from "../src/api/client";
import { MigrationLogPage } from "../src/components/agentMigration/log/MigrationLogPage";
import { en as enMessages } from "../src/i18n/messages/en";
import { useAgentStore } from "../src/store/agentStore";
import { useMachineStore } from "../src/store/machineStore";
import { stubDesktopWidth } from "./helpers/desktopWidth";
import "./helpers/installResizeObserver";
import { TestIntlProvider } from "./helpers/intl";

const en = enMessages as Record<string, string>;

const entry = (over: Partial<AgentMigrationLogEntry>): AgentMigrationLogEntry => ({
  migrationRef: "mig_x",
  agentId: "kirby",
  sourceMachineId: "m-a",
  sourceMachineName: "armbian-1",
  targetKind: "computer",
  targetMachineId: "m-b",
  targetMachineName: "hetzner-ex63-3",
  initiatedBy: null,
  outcome: "completed",
  startedAt: "2026-10-20T10:00:00.000Z",
  endedAt: "2026-10-20T10:01:30.000Z",
  bytes: null,
  files: null,
  failureKind: null,
  failureCode: null,
  ...over,
});

// Oldest first, as the server sends them. "old-mac" is a computer that has since left the server (its node keeps the
// logged name); m-studio is still on the server but was renamed after m5 (logged "studio-mac", now "mac-studio-2").
const LOG: AgentMigrationLogResponse = {
  truncated: false,
  migrations: [
    entry({ migrationRef: "m1", sourceMachineId: "m-old", sourceMachineName: "old-mac", targetMachineId: "m-a", targetMachineName: "armbian-1", startedAt: "2026-10-18T10:00:00.000Z", endedAt: "2026-10-18T10:00:40.000Z" }),
    entry({ migrationRef: "m2", startedAt: "2026-10-19T10:00:00.000Z", endedAt: "2026-10-19T10:02:00.000Z", outcome: "failed", failureKind: "network" }),
    entry({ migrationRef: "m3", agentId: "atlas", sourceMachineId: "m-b", sourceMachineName: "hetzner-ex63-3", targetMachineId: "m-a", targetMachineName: "armbian-1", startedAt: "2026-10-20T10:00:00.000Z", outcome: "canceled" }),
    entry({ migrationRef: "m4", startedAt: "2026-10-21T10:00:00.000Z", endedAt: "2026-10-21T10:01:30.000Z" }),
    entry({ migrationRef: "m5", agentId: "atlas", sourceMachineId: "m-studio", sourceMachineName: "studio-mac", targetMachineId: "m-b", targetMachineName: "hetzner-ex63-3", startedAt: "2026-10-22T10:00:00.000Z", endedAt: "2026-10-22T10:02:00.000Z" }),
    entry({ migrationRef: "m6", sourceMachineId: "m-b", sourceMachineName: "hetzner-ex63-3", targetMachineId: "m-a", targetMachineName: "armbian-1", startedAt: "2026-10-23T10:00:00.000Z", endedAt: null, outcome: "in_progress" }),
  ],
};

let restoreWidth: () => void = () => {};
let probe = "";

function LocationProbe() {
  probe = useLocation().search;
  return null;
}

beforeEach(() => {
  restoreWidth = stubDesktopWidth();
  vi.spyOn(api, "get").mockImplementation(async () => ({ data: LOG }) as never);
  useAgentStore.setState({ agents: [
    { id: "kirby", name: "kirby", displayName: "Kirby", avatarUrl: null, machineId: "m-b" },
    { id: "atlas", name: "atlas", displayName: "Atlas", avatarUrl: null, machineId: "m-a" },
  ] } as never);
  // m-studio was "studio-mac" when it moved Atlas, and has been renamed mac-studio-2 since.
  useMachineStore.setState({ machines: [{ id: "m-a", name: "armbian-1" }, { id: "m-b", name: "hetzner-ex63-3" }, { id: "m-studio", name: "mac-studio-2" }] } as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  restoreWidth();
  useAgentStore.setState({ agents: [] } as never);
  useMachineStore.setState({ machines: [] } as never);
});

function renderPage(search = "") {
  return render(
    <TestIntlProvider>
      <MemoryRouter initialEntries={[`/migrations${search}`]}>
        <MigrationLogPage />
        <LocationProbe />
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

const rowRefs = () => screen.queryAllByTestId("migration-log-table-row").map((row) => within(row).getByTestId("migration-log-table-route").textContent);
const rowCount = () => screen.queryAllByTestId("migration-log-table-row").length;
const outcomes = () => screen.getAllByTestId("migration-log-table-row").map((row) => within(row).getByTestId("migration-log-table-outcome").textContent);
const O = {
  ok: en["agent.migrationLog.outcome.completed"], failed: en["agent.migrationLog.outcome.failed"], canceled: en["agent.migrationLog.outcome.canceled"], running: en["agent.migrationLog.outcome.inProgress"],
};

test("the table view lists every move, newest first, with its route, result and duration; the view stays in the URL", async () => {
  renderPage();
  await waitFor(() => assert.ok(screen.getByTestId("migration-log-stats").textContent?.includes("6")));
  assert.ok(screen.queryByTestId("migration-log-table") === null, "the chart is the default view");
  assert.ok(screen.queryByTestId("migration-log-search") === null, "the search belongs to the table");
  assert.ok(screen.getByRole("radiogroup", { name: en["agent.migrationLog.view.label"] }));

  fireEvent.click(screen.getByRole("radio", { name: en["agent.migrationLog.view.table"] }));
  await waitFor(() => assert.ok(screen.getByTestId("migration-log-table")));
  assert.match(probe, /view=table/);
  assert.equal(screen.getByRole("columnheader", { name: en["agent.migrationLog.table.time"] }).getAttribute("aria-sort"), "descending");

  const rows = screen.getAllByTestId("migration-log-table-row");
  assert.equal(rows.length, 6);
  assert.deepEqual(outcomes(), [O.running, O.ok, O.ok, O.canceled, O.failed, O.ok]);
  // A move still running: its badge, and no duration yet.
  assert.equal(within(rows[0]!).getByText("—").textContent, "—");
  // From → to, by code and name; a computer renamed since also shows the name it had then, a departed one doesn't.
  assert.match(rowRefs()[1]!, /mac-studio-2.*then studio-mac → .*hetzner-ex63-3/);
  assert.equal(within(rows[1]!).getByTestId("migration-log-table-then").textContent, "then studio-mac");
  assert.match(rowRefs()[5]!, /old-mac → .*armbian-1/);
  assert.equal(within(rows[5]!).queryAllByTestId("migration-log-table-then").length, 0);
  assert.ok(within(rows[2]!).getByText("Kirby"));
  assert.ok(within(rows[2]!).getByText(/1m 30s/));

  fireEvent.click(screen.getByRole("radio", { name: en["agent.migrationLog.view.chart"] }));
  await waitFor(() => assert.ok(screen.queryByTestId("migration-log-table") === null));
  assert.doesNotMatch(probe, /view=table/);
});

test("an unknown ?view= falls back to the chart", async () => {
  renderPage("?view=grid");
  await waitFor(() => assert.ok(screen.getByTestId("migration-log-stats").textContent?.includes("6")));
  assert.ok(screen.queryByTestId("migration-log-table") === null);
  assert.equal(screen.getByRole("radio", { name: en["agent.migrationLog.view.chart"] }).getAttribute("aria-checked"), "true");
});

test("filters narrow the table, and keep it the view", async () => {
  renderPage("?view=table&outcome=failed,canceled");
  await waitFor(() => assert.equal(rowCount(), 2));
  assert.deepEqual(outcomes(), [O.canceled, O.failed]);
  fireEvent.click(screen.getByRole("button", { name: en["agent.migrationLog.filter.clearAll"] }));
  await waitFor(() => assert.equal(rowCount(), 6));
  assert.match(probe, /view=table/, "clearing the filters keeps the table");
  assert.doesNotMatch(probe, /outcome/);
});

test("the search finds a renamed computer by its old name, a departed one, an agent; clearing it returns focus to the field", async () => {
  renderPage("?view=table");
  await waitFor(() => assert.equal(rowCount(), 6));
  const search = screen.getByRole("textbox", { name: en["agent.migrationLog.table.search"] });

  // studio-mac is mac-studio-2 now: only the name the log recorded finds it.
  fireEvent.change(search, { target: { value: "Studio-Mac" } });
  await waitFor(() => assert.equal(rowCount(), 1));
  assert.match(rowRefs()[0]!, /mac-studio-2.*then studio-mac/);

  fireEvent.change(search, { target: { value: "OLD-MAC" } });
  await waitFor(() => assert.equal(rowCount(), 1));
  assert.match(rowRefs()[0]!, /old-mac/);

  fireEvent.change(search, { target: { value: "atlas" } });
  await waitFor(() => assert.equal(rowCount(), 2));
  assert.match(rowRefs()[1]!, /hetzner-ex63-3 → .*armbian-1/);

  // The field's own clear button.
  fireEvent.click(screen.getByRole("button", { name: en["agent.migrationLog.table.clearSearch"] }));
  await waitFor(() => assert.equal(rowCount(), 6));
  assert.ok(document.activeElement === search, "focus is back in the search field");

  fireEvent.change(search, { target: { value: "nowhere" } });
  await waitFor(() => assert.ok(screen.getByTestId("migration-log-table-empty")));
  assert.ok(screen.getByText("No migrations match “nowhere”"));
  search.blur();
  fireEvent.click(within(screen.getByTestId("migration-log-table-empty")).getByRole("button", { name: en["agent.migrationLog.table.clearSearch"] }));
  await waitFor(() => assert.equal(rowCount(), 6));
  assert.equal((search as HTMLInputElement).value, "");
  assert.ok(document.activeElement === search, "the empty state's Clear search focuses the field");
});

test("a long log shows 100 rows, and Show more adds the rest and focuses the first new row", async () => {
  const many: AgentMigrationLogResponse = {
    truncated: false,
    migrations: Array.from({ length: 130 }, (_, i) => entry({ migrationRef: `bulk-${i}`, startedAt: new Date(Date.UTC(2026, 8, 1) + i * 3_600_000).toISOString(), endedAt: null, outcome: "completed" })),
  };
  vi.spyOn(api, "get").mockImplementation(async () => ({ data: many }) as never);
  renderPage("?view=table");
  await waitFor(() => assert.equal(rowCount(), 100));
  const more = screen.getByTestId("migration-log-table-more");
  assert.equal(more.textContent, "Show next 30");
  fireEvent.click(more);
  await waitFor(() => assert.equal(rowCount(), 130));
  assert.ok(screen.queryByTestId("migration-log-table-more") === null, "Show more goes once every row is shown");
  const rows = screen.getAllByTestId("migration-log-table-row");
  await waitFor(() => assert.ok(document.activeElement === rows[100], "focus is on the first row Show more added"));
});

test("Show more names the rows it adds: at most one page of 100, not every row left", async () => {
  const many: AgentMigrationLogResponse = {
    truncated: false,
    migrations: Array.from({ length: 250 }, (_, i) => entry({ migrationRef: `bulk-${i}`, startedAt: new Date(Date.UTC(2026, 8, 1) + i * 3_600_000).toISOString(), endedAt: null, outcome: "completed" })),
  };
  vi.spyOn(api, "get").mockImplementation(async () => ({ data: many }) as never);
  renderPage("?view=table");
  await waitFor(() => assert.equal(rowCount(), 100));
  assert.equal(screen.getByTestId("migration-log-table-more").textContent, "Show next 100");
  fireEvent.click(screen.getByTestId("migration-log-table-more"));
  await waitFor(() => assert.equal(rowCount(), 200));
  assert.equal(screen.getByTestId("migration-log-table-more").textContent, "Show next 50");
});

test("filters that match nothing show the filtered empty state in the table view too", async () => {
  renderPage("?view=table&agent=nobody");
  await waitFor(() => assert.ok(screen.getByText(en["agent.migrationLog.empty.filteredTitle"])));
  assert.ok(screen.queryByTestId("migration-log-table") === null);
});
