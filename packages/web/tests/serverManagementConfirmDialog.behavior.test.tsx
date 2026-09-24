import assert from "node:assert/strict";
import { afterEach, test as nodeTest } from "node:test";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import api from "../src/api/client";
import ConfirmDialog from "../src/components/ConfirmDialog";
import ResetAgentDialog from "../src/components/agent/ResetAgentDialog";
import MachineDetailPanel from "../src/components/machine/MachineDetailPanel";
import SettingsPanel from "../src/components/settings/SettingsPanel";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMachineStore } from "../src/store/machineStore";
import { useMessageStore } from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";
import { useTranslationStore } from "../src/store/translationStore";
import { TestIntlProvider, renderWithIntl } from "./helpers/intl";

// Mounted-DOM replacement for the surface half of
// tests/serverManagementConfirmDialogContract.test.ts.
// The regexes pinned which confirmation each surface renders by matching JSX
// spelling; here the same contracts are asserted by opening the real dialog
// and reading the rendered chrome. The shared ConfirmDialog markers that a
// hand-rolled Modal cannot fake are: role="dialog" + aria-modal, the
// catalog-driven close button ("Close dialog"), and the Cancel/confirm action
// pair (or its deliberate hideCancel absence).
//
// What stays in the source file: the logout-wording catalog scan (copy is the
// contract) and the tree-wide raw-Modal count ratchet (a per-file baseline is
// inherently a source reading).

type TestFn = () => void | Promise<void>;
const test = (name: string, fn: TestFn) =>
  nodeTest(name, { concurrency: false }, fn);

const originalGet = api.get;
const originalPost = api.post;
const originalPatch = api.patch;

if (typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as never;
}

globalThis.IntersectionObserver = globalThis.IntersectionObserver ?? class {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
} as typeof IntersectionObserver;

afterEach(() => {
  cleanup();
  api.get = originalGet;
  api.post = originalPost;
  api.patch = originalPatch;
  window.localStorage.clear();
  useServerStore.setState(useServerStore.getInitialState(), true);
  useAuthStore.setState({ user: null, loading: false, initialized: true } as never);
  useAgentStore.setState({ agents: [], agentActivities: {}, loading: true } as never);
  useChannelStore.setState({ channels: [], dmChannels: [], channelActivity: {}, loading: true } as never);
  useMachineStore.setState({ machines: [], loading: true } as never);
  useMessageStore.setState({ unreadCounts: {}, drafts: {}, mentionFlags: {} } as never);
  useTranslationStore.setState(useTranslationStore.getInitialState(), true);
});

function installApiStub() {
  api.get = (async (url: string) => {
    if (url === "/channels/inbox") {
      return { data: { items: [], hasMore: false, totalCount: 0, totalUnreadCount: 0 } };
    }
    return { data: [] };
  }) as typeof api.get;
  api.post = (async () => ({ data: {} })) as typeof api.post;
  api.patch = (async () => ({ data: {} })) as typeof api.patch;
}

function seedOwner() {
  useAuthStore.setState({
    user: { id: "user-1", email: "u@example.com", name: "U", displayName: "U" } as never,
    loading: false,
    initialized: true,
  });
  useServerStore.setState({
    servers: [{ id: "server-1", slug: "acme", name: "Acme", role: "owner" }],
    current: {
      id: "server-1",
      name: "Acme",
      avatarUrl: null,
      slug: "acme",
      ownerId: "user-1",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "pro",
      planDowngradedAt: null,
      role: "owner",
      createdAt: "2026-07-12T00:00:00.000Z",
    },
    members: [],
    loading: false,
  } as never);
  useTranslationStore.setState({
    settings: {
      ...useTranslationStore.getInitialState().settings,
      preferredTranslationMode: "off",
      preferredTimeFormat: "24h",
      effectiveTimeFormat: "24h",
    },
    settingsServerId: "server-1",
    settingsLoading: false,
    settingsError: null,
  } as never);
}

function seedSidebarStores({ withAgentOnMachine }: { withAgentOnMachine: boolean }) {
  useServerStore.setState({
    sidebarOrder: {
      channelOrder: [],
      agentOrder: [],
      dmOrder: [],
      channelSortMode: "manual",
      jointChannelSortMode: "manual",
      dmSortMode: "manual",
      pinnedSortMode: "manual",
      pinnedChannelIds: [],
      pinnedAgentIds: [],
      pinnedOrder: [],
      hiddenDmIds: [],
      channelPanelTabOrder: [],
      agentPanelTabOrder: [],
      customSections: [],
      sectionOrder: ["system:pinned", "system:joint", "system:channels", "system:dms"],
      sectionPlacements: [],
      sectionsVersion: 0,
      pinnedVersion: 0,
    },
  } as never);
  useChannelStore.setState({ channels: [], dmChannels: [], channelActivity: {}, loading: false } as never);
  useMachineStore.setState({
    machines: [{ id: "machine-1", name: "Lab Mac", description: null, status: "online", statusVersion: 1, apiKeyPrefix: null, runtimes: [], hostname: "lab.local", os: "darwin", daemonVersion: "0.72.6", lastHeartbeat: "2026-07-12T00:00:00.000Z", createdAt: "2026-07-12T00:00:00.000Z" }],
    loading: false,
  } as never);
  useAgentStore.setState({
    agents: withAgentOnMachine
      ? [{ id: "agent-1", name: "resident", machineId: "machine-1", serverId: "server-1", runtime: "claude", createdAt: "2026-07-12T00:00:00.000Z" }]
      : [],
    agentActivities: {},
    loading: false,
  } as never);
}

/** Shared-ConfirmDialog chrome that a hand-rolled Modal does not render. */
function assertSharedDialogChrome(dialog: HTMLElement) {
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  assert.ok(dialog.getAttribute("aria-labelledby"), "the title must label the dialog");
  assert.ok(
    within(dialog).getByRole("button", { name: "Close dialog" }),
    "the shared ConfirmDialog chrome owns the close button",
  );
}

test("Delete Server opens the shared slug-gated confirmation, not a hand-rolled modal", async () => {
  installApiStub();
  seedOwner();
  render(
    <TestIntlProvider locale="en">
      <MemoryRouter initialEntries={["/s/acme/settings/server"]}>
        <SettingsPanel tab="server" />
      </MemoryRouter>
    </TestIntlProvider>,
  );

  await waitFor(() => assert.ok(screen.getByTestId("server-danger-delete-button")));
  fireEvent.click(screen.getByTestId("server-danger-delete-button"));

  const dialog = screen.getByRole("dialog");
  assertSharedDialogChrome(dialog);
  assert.ok(within(dialog).getByRole("heading", { name: "Delete Server" }));
  assert.ok(dialog.textContent?.includes("This will permanently delete"));
  assert.ok(dialog.textContent?.includes("This cannot be undone."));

  const confirm = within(dialog).getByTestId("server-delete-confirm-button");
  assert.ok((confirm as HTMLButtonElement).disabled, "confirm stays disabled until the slug matches");
  fireEvent.change(within(dialog).getByTestId("server-delete-slug-input"), { target: { value: "not-acme" } });
  assert.ok((confirm as HTMLButtonElement).disabled, "a wrong slug must not enable deletion");
  fireEvent.change(within(dialog).getByTestId("server-delete-slug-input"), { target: { value: "acme" } });
  assert.ok(!(confirm as HTMLButtonElement).disabled, "typing the server slug enables the destructive confirm");
  assert.ok(within(dialog).getByRole("button", { name: "Cancel" }));
});

test("machine detail blocked delete is a single-action shared confirmation", async () => {
  installApiStub();
  seedOwner();
  seedSidebarStores({ withAgentOnMachine: true });
  useMachineStore.setState({
    machines: [{
      id: "machine-1",
      name: "Lab Mac",
      description: null,
      status: "online",
      statusVersion: 1,
      apiKeyPrefix: null,
      runtimes: ["claude"],
      hostname: "lab.local",
      os: "darwin",
      daemonVersion: "0.72.6",
      isComputer: true,
      computerAttachedByCurrentUser: true,
      computerVersion: "0.72.6",
      computerUpgradeAvailable: false,
      lastHeartbeat: "2026-07-12T00:00:00.000Z",
      createdAt: "2026-07-12T00:00:00.000Z",
    }],
    loading: false,
  } as never);

  renderWithIntl(
    <MemoryRouter initialEntries={["/s/acme/settings/computers/machine-1"]}>
      <MachineDetailPanel machine={useMachineStore.getState().machines[0]!} workspaceEmbedded />
    </MemoryRouter>,
  );

  const deleteButtons = await waitFor(() => screen.getAllByRole("button", { name: "Delete Computer" }));
  fireEvent.click(deleteButtons[deleteButtons.length - 1]);

  const dialog = screen.getByRole("dialog");
  assertSharedDialogChrome(dialog);
  assert.ok(within(dialog).getByText("Cannot Delete Computer"));
  assert.ok(within(dialog).getByText(/1 agent/i));
  assert.ok(within(dialog).getByRole("button", { name: "OK" }), "blocked delete offers a single OK action");
  // NOTE: assert.ok(x === null), never assert.equal(node, null) — a failing
  // assert.equal tries to util.inspect the jsdom element for its diff, which
  // is pathological and kills the test process with no diagnostics.
  assert.ok(
    within(dialog).queryByRole("button", { name: "Cancel" }) === null,
    "blocked delete hides Cancel — there is nothing to cancel",
  );
});

test("Reset Agent keeps the shared confirmation frame around its frameless mode picker", () => {
  const resets: Array<{ agentId: string; mode: string }> = [];
  useAgentStore.setState({
    agents: [],
    resetAgent: async (agentId: string, mode: string) => {
      resets.push({ agentId, mode });
    },
  } as never);

  renderWithIntl(
    <ResetAgentDialog agentId="agent-1" agentName="VPS-ADMIN" canFullReset onClose={() => undefined} />,
  );

  const dialog = screen.getByRole("dialog");
  assertSharedDialogChrome(dialog);
  assert.ok(within(dialog).getByText("Restart VPS-ADMIN"));

  // The mode picker is plain content: the shared content slot keeps its bare
  // layout class and gains neither the compact-text treatment nor a frame.
  const contentSlot = within(dialog).getByText("Reset Session & Restart").closest('[data-slot="confirm-dialog-content"]')!;
  assert.equal(contentSlot.className, "mb-5", "the mode picker must keep its own layout (plainMessage)");
  const picker = within(dialog).getByText("Reset Session & Restart").closest("button")!.parentElement!;
  assert.doesNotMatch(picker.className, /border-2|bg-brutal-orange/);

  // The confirm action labels itself with the selected mode.
  assert.ok(within(dialog).getByRole("button", { name: "Restart" }));
  fireEvent.click(within(dialog).getByText("Full Reset & Restart"));
  const confirm = within(dialog).getByRole("button", { name: "Full Reset & Restart" });
  assert.match(confirm.className, /\bbg-brutal-red\b/, "full reset is the destructive red action");
  assert.ok(within(dialog).getByText(/permanently delete all workspace files/i));
  assert.ok(within(dialog).getByRole("button", { name: "Cancel" }));

  fireEvent.click(confirm);
  assert.deepEqual(resets, [{ agentId: "agent-1", mode: "full" }]);
});

test("a hand-rolled Modal look-alike fails this file's chrome oracle", () => {
  // Meta-pin: the markers assertSharedDialogChrome requires are absent from a
  // minimal hand-rolled dialog, which is exactly the regression shape the
  // converted contract guards against.
  render(
    <TestIntlProvider locale="en">
      <div role="dialog">
        <h2>Cannot Delete Computer</h2>
        <button type="button">OK</button>
      </div>
    </TestIntlProvider>,
  );
  const lookalike = screen.getByRole("dialog");
  assert.equal(lookalike.getAttribute("aria-modal"), null);
  assert.ok(within(lookalike).queryByRole("button", { name: "Close dialog" }) === null);

  cleanup();

  renderWithIntl(
    <ConfirmDialog
      title="Cannot Delete Computer"
      message="Blocked."
      confirmLabel="OK"
      confirmColor="bg-white"
      hideCancel
      onConfirm={() => undefined}
      onClose={() => undefined}
    />,
  );
  assertSharedDialogChrome(screen.getByRole("dialog"));
});
