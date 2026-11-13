import "./helpers/domSetup";

import assert from "node:assert/strict";
import type { ReactNode } from "react";
import { cleanup, render, renderHook } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ServerRole } from "@botiverse/raft-shared";

import api from "../src/api/client";
import { resetPaywallShownForTest } from "../src/analytics/paywall";
import { flushProductEvents, resetProductEventsForTest } from "../src/analytics/track";
import { useSystemNotifications } from "../src/components/layout/useSystemNotifications";
import { DowngradeWarningCard } from "../src/features/settings/billing/DowngradeWarningCard";
import { useAgentStore } from "../src/store/agentStore";
import { useMachineStore } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";
import { useUpgradeDialogStore } from "../src/store/upgradeDialogStore";
import type { Server } from "../src/store/serverStore";
import { showsPlanDowngradeNotice } from "../src/utils/planDowngrade";
import { TestIntlProvider } from "./helpers/intl";

// Task #3 in #proj-commercial: for a week after a server goes back to Free,
// everyone on it is told what that took away (older messages, Pro features).
// Free has no agent cap, so there is no countdown and nothing "stopped"; only
// an owner, who can pay, is offered the upgrade. The Bell item clamps its body
// to two lines, so it carries the short sentence and the button does the rest.

const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function makeServer(role: ServerRole, overrides: Partial<Server> = {}): Server {
  return {
    id: "server-1",
    name: "Lumen Studio",
    avatarUrl: null,
    slug: "lumen",
    ownerId: "owner-1",
    onboardingAgentId: null,
    hideHumansFromMembers: false,
    plan: "free",
    planDowngradedAt: ago(2 * DAY),
    role,
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

// The Bell's other sources ask the server (some after the render); they have nothing here.
const originalGet = api.get;
api.get = (async (url: string) => (url === "/integrations/permission-updates"
  ? { data: { count: 0 } }
  : { data: { invites: [], notifications: [], blocks: [], announcements: [] } })) as never;
afterAll(() => {
  api.get = originalGet;
});

function downgradeNotice(server: Server, locale?: "zh-cn") {
  useServerStore.setState({ current: server, members: [] });
  useMachineStore.setState({ machines: [], latestComputerVersion: null, loading: false });
  useAgentStore.setState({ agents: [], loading: false });
  const { result } = renderHook(() => useSystemNotifications(), {
    wrapper({ children }) {
      return (
        <TestIntlProvider {...(locale ? { locale } : {})}>
          <MemoryRouter>{children}</MemoryRouter>
        </TestIntlProvider>
      );
    },
  });
  return result.current.find((notification) => notification.id === "plan-downgrade");
}

const text = (node: ReactNode) => render(<>{node}</>).container.textContent;

afterEach(() => {
  cleanup();
  resetPaywallShownForTest();
  resetProductEventsForTest();
  useUpgradeDialogStore.getState().close();
  useServerStore.getState().clearCurrent();
  useMachineStore.setState({ machines: [], loading: true });
  useAgentStore.setState({ agents: [], loading: true });
});

test("an owner is told what Free took away and offered the upgrade", () => {
  const entry = downgradeNotice(makeServer("owner"));

  assert.ok(entry);
  assert.equal(entry.kind, "warning");
  assert.equal(entry.title, "Lumen Studio is on Free now");
  assert.equal(text(entry.body), "Messages over 30 days old are hidden. Pro features are off.");
  assert.equal(entry.action?.label, "Upgrade");
});

test("the owner's Upgrade opens the upgrade dialog for this gate", () => {
  const entry = downgradeNotice(makeServer("owner"));

  entry?.action?.onClick();

  assert.equal(useUpgradeDialogStore.getState().request?.gate, "plan_downgraded");
});

test("admins, members and guests see the same notice without an Upgrade button", () => {
  for (const role of ["admin", "member", "guest"] as const) {
    const entry = downgradeNotice(makeServer(role));

    assert.ok(entry, role);
    assert.equal(entry.title, "Lumen Studio is on Free now");
    assert.equal(text(entry.body), "Messages over 30 days old are hidden. Pro features are off.", role);
    assert.equal(entry.action, undefined, role);
    cleanup();
  }
});

test("no countdown, no stopped agents, and gone after the week", () => {
  const lastDay = downgradeNotice(makeServer("owner", { planDowngradedAt: ago(7 * DAY - 60_000) }));
  assert.ok(lastDay);
  assert.doesNotMatch(`${lastDay.title} ${text(lastDay.body)}`, /days? left|grace|stopped|reduce/i);
  cleanup();

  assert.equal(downgradeNotice(makeServer("owner", { planDowngradedAt: ago(7 * DAY + 60_000) })), undefined);
  cleanup();
  assert.equal(downgradeNotice(makeServer("owner", { planDowngradedAt: null })), undefined);
  cleanup();
  // Back on Pro before the server cleared the marker.
  assert.equal(downgradeNotice(makeServer("owner", { plan: "pro" })), undefined);
});

test("a later downgrade comes back even if the last one was dismissed", () => {
  const firstAt = ago(3 * DAY);
  const laterAt = ago(DAY);
  const first = downgradeNotice(makeServer("owner", { planDowngradedAt: firstAt }));
  cleanup();
  const later = downgradeNotice(makeServer("owner", { planDowngradedAt: laterAt }));

  assert.equal(first?.dismissalKey, `plan-downgrade:${firstAt}`);
  assert.equal(later?.dismissalKey, `plan-downgrade:${laterAt}`);
});

test("only the owner's view, with its Upgrade button, counts as a paywall shown", async () => {
  const sent: Array<{ event: string; properties: Record<string, unknown> }> = [];
  window.localStorage.setItem("slock_access_token", "token-1");
  resetProductEventsForTest(async (url, init) => {
    if (url.endsWith("/product-events/config")) return new Response(JSON.stringify({ clientEventsAllowed: true }), { status: 200 });
    sent.push(...(JSON.parse(String(init?.body)) as { events: typeof sent }).events);
    return new Response(JSON.stringify({ accepted: 1 }), { status: 202 });
  });

  for (const role of ["admin", "member", "guest", "owner"] as const) {
    const entry = downgradeNotice(makeServer(role));
    render(<TestIntlProvider>{entry?.body}</TestIntlProvider>);
    cleanup();
  }
  await flushProductEvents();

  assert.deepEqual(
    sent.filter((event) => event.event === "paywall_shown").map((event) => event.properties),
    [{ gate: "plan_downgraded", viewer_role: "owner", plan: "free" }],
  );
});

test("the notice follows the app locale", () => {
  const entry = downgradeNotice(makeServer("member"), "zh-cn");

  assert.ok(entry);
  assert.equal(text(entry.body), "30 天前的消息看不到了，Pro 功能也关了。");
});

test("Plan & Billing shows the same sentence, the upgrade half only to an owner", () => {
  const server = makeServer("owner");
  const owner = render(
    <TestIntlProvider>
      <DowngradeWarningCard server={server} canManageBilling />
    </TestIntlProvider>,
  );
  assert.match(owner.container.textContent ?? "", /^Lumen Studio is on Free now/);
  assert.match(owner.container.textContent ?? "", /Messages over 30 days old are hidden\. Pro features are off\. Upgrade to bring them back\.$/);
  cleanup();

  const admin = render(
    <TestIntlProvider>
      <DowngradeWarningCard server={makeServer("admin")} canManageBilling={false} />
    </TestIntlProvider>,
  );
  assert.match(admin.container.textContent ?? "", /Pro features are off\.$/);
  cleanup();

  const later = render(
    <TestIntlProvider>
      <DowngradeWarningCard server={makeServer("owner", { planDowngradedAt: ago(8 * DAY) })} canManageBilling />
    </TestIntlProvider>,
  );
  assert.equal(later.container.textContent, "");
});

test("the week is measured from the downgrade", () => {
  const at = Date.parse("2026-11-01T00:00:00.000Z");
  const server = { plan: "free", planDowngradedAt: new Date(at).toISOString() };

  assert.equal(showsPlanDowngradeNotice(server, at), true);
  assert.equal(showsPlanDowngradeNotice(server, at + 7 * DAY - 1), true);
  assert.equal(showsPlanDowngradeNotice(server, at + 7 * DAY), false);
  assert.equal(showsPlanDowngradeNotice({ plan: "free", planDowngradedAt: "not a date" }, at), false);
});
