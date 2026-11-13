import assert from "node:assert/strict";
import { test as nodeTest } from "vitest";
import "../../../../tests/helpers/domSetup";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import api from "../../../api/client";
import { PlanSection } from "../billing/PlanSection";
import { useAgentStore } from "../../../store/agentStore";
import { useAuthStore } from "../../../store/authStore";
import { useServerStore } from "../../../store/serverStore";
import { useUpgradeDialogStore } from "../../../store/upgradeDialogStore";
import { noteBillingEntry } from "../../../analytics/billingEntry";
import { flushProductEvents, resetProductEventsForTest } from "../../../analytics/track";
import { TestIntlProvider } from "../../../../tests/helpers/intl";

// Mounted-DOM test of the SettingsPanel billing tab (the overview, task #13):
// which cards and banners each billing state shows, who gets which buttons, and
// what each action posts. Buying itself is the dialogs' (UpgradeDialog,
// AddSeatsDialog); here only that the page opens them with the right entry.
//
// Deliberately NOT here:
// - the exact zh wording of catalog copy (en.ts/zh-cn.ts),
// - the plan -> feature-id mapping inside billingControls.ts (pinned by
//   tests/billingPartnerPlan.behavior.test.tsx against the pure functions).

type TestFn = () => void | Promise<void>;
const test = (name: string, fn: TestFn) =>
  nodeTest(name,  fn);

const originalGet = api.get;
const originalPost = api.post;
const originalPatch = api.patch;

type BillingSeed = {
  plan: "free" | "pro" | "founder" | "partner";
  sourceConflict?: "appsumo_stripe" | null;
  appsumo?: { tier: 1 | 2 | 3 | 4; lifetime: true; maxHumans: number; maxAgents: number; maxHostedJointChannels: number; hostedJointChannels: number; monthlyUploadBytes: number };
  subscription?: {
    status: "active" | "past_due" | "canceled";
    billingInterval: "monthly" | "annual";
    cancelAtPeriodEnd?: boolean;
  } | null;
  canManageBilling?: boolean;
  stripeConfigured?: boolean;
  usage?: { humans: number; agents: number; universalSeats: number };
  provisioned?: { humans: number; agents: number; proPackQuantity: number };
  capacity?: { maxHumans: number; maxAgents: number; maxUniversalSeats: number };
  price?: {
    billingInterval: "monthly" | "annual";
    monthlyUsd: number;
    annualUsd: number;
  } | null;
  fileUploadQuota?: { month?: string; limited: boolean; usedBytes: number; remainingBytes?: number; limitBytes: number };
  serverRole?: "owner" | "admin" | "member";
  planDowngradedAt?: string | null;
};

function seedBilling(input: BillingSeed) {
  const loadUsageCalls: number[] = [];
  const loadBillingCalls: number[] = [];
  const subscription = input.subscription === undefined ? null : input.subscription;
  useAuthStore.setState({
    user: {
      id: "user-1",
      email: "u@example.com",
      name: "U",
      displayName: "U",
    } as never,
    loading: false,
    initialized: true,
  });
  useServerStore.setState({
    servers: [{ id: "server-1", slug: "billing", name: "Billing", role: input.serverRole ?? "owner" }],
    current: {
      id: "server-1",
      name: "Billing",
      avatarUrl: null,
      slug: "billing",
      ownerId: "user-1",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: input.plan,
      planDowngradedAt: input.planDowngradedAt ?? null,
      role: input.serverRole ?? "owner",
      createdAt: "2026-07-20T00:00:00.000Z",
    },
    members: [],
    loading: false,
    usage: { agents: input.usage?.agents ?? 0, machines: 0, channels: 0 },
    billing: {
      plan: input.plan,
      displayName: input.plan === "pro" ? "Pro" : "Free",
      serverPlan: input.plan,
      source: input.appsumo ? "appsumo" : subscription ? "subscription" : "server",
      appsumo: input.appsumo ?? null,
      sourceConflict: input.sourceConflict ?? null,
      capacity: input.capacity ?? { maxHumans: -1, maxAgents: -1, maxUniversalSeats: -1 },
      usage: input.usage ?? { humans: 1, agents: 2, universalSeats: 0 },
      provisioned: {
        trialFreePackQuantity: 0,
        humans: 0,
        agents: 0,
        proPackQuantity: 0,
        ...input.provisioned,
      },
      price: input.price === undefined ? null : input.price && {
        discountPercent: 12,
        baseMonthlyUsd: input.price.monthlyUsd,
        overageMonthlyUsd: 0,
        seatQuantity: input.provisioned?.proPackQuantity ?? 0,
        packQuantity: input.provisioned?.proPackQuantity ?? 0,
        humanSeatQuantity: input.provisioned?.humans ?? 0,
        agentSeatQuantity: input.provisioned?.agents ?? 0,
        agentSeatBlockQuantity: 10,
        ...input.price,
      },
      subscription: subscription && {
        currentPeriodEnd: "2026-08-20T00:00:00.000Z",
        cancelAtPeriodEnd: false,
        ...subscription,
      },
      stripeConfigured: input.stripeConfigured ?? true,
      permissions: {
        canReadBillingSummary: true,
        canManageBilling: input.canManageBilling ?? true,
      },
      ...(input.fileUploadQuota ? { fileUploadQuota: input.fileUploadQuota } : {}),
    },
    loadingUsage: false,
    loadingBilling: false,
    loadUsage: async () => {
      loadUsageCalls.push(1);
    },
    loadBilling: async () => {
      loadBillingCalls.push(1);
    },
  } as never);
  return { loadUsageCalls, loadBillingCalls };
}

function renderPlanSection() {
  return render(
    <TestIntlProvider locale="en">
      <PlanSection />
    </TestIntlProvider>,
  );
}

type SentEvent = { event: string; properties: Record<string, unknown> };

function captureProductEvents(): SentEvent[] {
  const sent: SentEvent[] = [];
  window.localStorage.setItem("slock_access_token", "token-1");
  resetProductEventsForTest(async (url, init) => {
    if (url.endsWith("/product-events/config")) return new Response(JSON.stringify({ clientEventsAllowed: true }), { status: 200 });
    for (const { event, properties } of (JSON.parse(String(init?.body)) as { events: SentEvent[] }).events) sent.push({ event, properties });
    return new Response(JSON.stringify({ accepted: 1 }), { status: 202 });
  });
  return sent;
}

// plan_billing_dialog_* (cindyz, 2026-10-30; names Nova): which dialogs the page
// opens and how they end; the owner's on these pages, from Settings.
async function dialogEvents(sent: SentEvent[]) {
  await flushProductEvents();
  return sent
    .filter((event) => event.event.startsWith("plan_billing_dialog_"))
    .map((event) => [event.event.replace("plan_billing_dialog_", ""), event.properties.dialog, event.properties.result ?? null]);
}

function seedProManageSeats() {
  seedBilling({
    plan: "pro",
    subscription: { status: "active", billingInterval: "monthly" },
    capacity: { maxHumans: 2, maxAgents: 20, maxUniversalSeats: 2 },
    usage: { humans: 1, agents: 0, universalSeats: 1 },
    provisioned: { humans: 2, agents: 20, proPackQuantity: 2 },
    price: { billingInterval: "monthly", monthlyUsd: 20, annualUsd: 211.2 },
  });
}

afterEach(() => {
  cleanup();
  api.get = originalGet;
  api.post = originalPost;
  api.patch = originalPatch;
  useServerStore.setState(useServerStore.getInitialState(), true);
  useAuthStore.setState({ user: null } as never);
  useAgentStore.setState({ agents: [] } as never);
  useUpgradeDialogStore.setState({ request: null });
});


test("Free: the plan, what is used, then what Pro adds, with Upgrade opening the upgrade dialog from Settings", () => {
  const { loadBillingCalls, loadUsageCalls } = seedBilling({
    plan: "free",
    usage: { humans: 3, agents: 14, universalSeats: 4.4 },
    fileUploadQuota: { month: "2026-10", limited: true, usedBytes: 10 * 1024 * 1024, remainingBytes: 90 * 1024 * 1024, limitBytes: 100 * 1024 * 1024 },
  });

  renderPlanSection();

  // The section loads billing state through the store hooks, not a side channel.
  assert.equal(loadBillingCalls.length, 1);
  assert.equal(loadUsageCalls.length, 1);

  const plan = screen.getByTestId("billing-current-plan-card");
  assert.ok(within(plan).getByRole("heading", { name: "Free" }));
  // The plan's facts are data in body ink, not the card's (muted) description.
  assert.equal(within(plan).getByTestId("billing-current-plan-summary").textContent, "Messages from the last 30 days · 100 MB of file uploads a month");
  assert.ok(plan.querySelector("[data-slot='card-description']") === null, "no CardDescription for plan data");

  const usage = screen.getByTestId("billing-usage-card");
  assert.ok(within(usage).getByRole("meter", { name: "File uploads this month" }));
  assert.ok(within(usage).getByText("10 MB of 100 MB used · resets Nov 1"));
  assert.ok(within(usage).getByText("Last 30 days. Older messages are hidden until the server is on Pro."));
  assert.ok(within(usage).getByText("3 people · 14 agents"));
  assert.ok(within(usage).queryByRole("meter", { name: "Seats" }) === null, "Free has no seats");

  // cindyz 2026-10-30: on Free, usage comes before Upgrade to Pro.
  const upgrade = screen.getByTestId("billing-upgrade-card");
  assert.ok(usage.compareDocumentPosition(upgrade) & Node.DOCUMENT_POSITION_FOLLOWING);
  assert.match(within(upgrade).getByTestId("billing-upgrade-price").textContent ?? "", /this server needs 5 seats today\./);
  assert.ok(upgrade.querySelector("[data-slot='card-description']") === null, "prices are body ink, not CardDescription");
  for (const feature of ["Unlimited message history", "Higher file upload limits", "Agent migration", "Use external channels"]) {
    assert.ok(within(upgrade).getByText(feature), `Upgrade to Pro lists "${feature}"`);
  }
  const compare = within(upgrade).getByRole("button", { name: "Compare plans (opens in a new tab)" });
  assert.equal(compare.getAttribute("href"), "https://raft.build/pricing");
  assert.equal(compare.getAttribute("target"), "_blank");

  // The old inline checkout form is gone: buying is the upgrade dialog's.
  assert.ok(screen.queryByRole("textbox") === null, "absent");
  assert.ok(screen.queryByText("How often do you want to be billed?") === null, "absent");

  fireEvent.click(within(upgrade).getByRole("button", { name: "Upgrade to Pro" }));
  const request = useUpgradeDialogStore.getState().request;
  assert.equal(request?.gate, "general");
  assert.equal(request?.serverId, "server-1");
  assert.equal(request?.settingsEntry, "settings", "checkout from here says it started in Settings");
});

test("a page opened from a paywall hands that paywall to the upgrade dialog's checkout", () => {
  noteBillingEntry("history_30d");
  seedBilling({ plan: "free" });
  renderPlanSection();
  fireEvent.click(screen.getByRole("button", { name: "Upgrade to Pro" }));
  assert.equal(useUpgradeDialogStore.getState().request?.settingsEntry, "history_30d");
});

test("after a downgrade the page says what Free took away; only the owner is told upgrading brings it back", () => {
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  seedBilling({ plan: "free", planDowngradedAt: twoDaysAgo });
  renderPlanSection();
  assert.ok(screen.getByText("Billing is on Free now"));
  assert.ok(screen.getByText("Messages over 30 days old are hidden. Pro features are off. Upgrade to bring them back."));

  cleanup();
  seedBilling({ plan: "free", canManageBilling: false, serverRole: "admin", planDowngradedAt: twoDaysAgo });
  renderPlanSection();
  assert.ok(screen.getByText("Messages over 30 days old are hidden. Pro features are off."));
});

test("Free admin asks an owner through the same dialog; without Stripe nothing can be bought", () => {
  seedBilling({ plan: "free", canManageBilling: false, serverRole: "admin" });
  renderPlanSection();
  const ask = screen.getByRole("button", { name: "Ask an owner to upgrade" });
  assert.equal((ask as HTMLButtonElement).disabled, false);
  assert.ok(screen.queryByRole("button", { name: "Upgrade to Pro" }) === null, "absent");
  fireEvent.click(ask);
  assert.equal(useUpgradeDialogStore.getState().request?.gate, "general");

  cleanup();
  useUpgradeDialogStore.setState({ request: null });

  seedBilling({ plan: "free", stripeConfigured: false });
  renderPlanSection();
  assert.ok((screen.getByRole("button", { name: "Upgrade to Pro" }) as HTMLButtonElement).disabled);
  assert.ok(screen.getByText("Paid plans are not available yet."));
});

test("Pro owner: price, seats and renewal on the plan card; seat meter; billing details; cancel last", () => {
  seedProManageSeats();
  renderPlanSection();

  const plan = screen.getByTestId("billing-current-plan-card");
  assert.ok(within(plan).getByRole("heading", { name: "Pro" }));
  assert.ok(within(plan).getByText("$20 a month · 2 seats · Renews Aug 20, 2026"));
  assert.ok(within(plan).getByRole("button", { name: "Add seats" }));
  assert.ok(within(plan).getByRole("button", { name: /^Manage in Stripe/ }));

  const usage = screen.getByTestId("billing-usage-card");
  assert.ok(within(usage).getByRole("meter", { name: "Seats" }));
  assert.ok(within(usage).getByText("1 of 2 used"));
  // 1 seat in use of 2 bought: one can go, from under the seat count (task #18),
  // outside the meter, whose contents are not controls.
  assert.ok(within(usage).getByRole("button", { name: "Manage seats" }));
  assert.ok(within(within(usage).getByRole("meter", { name: "Seats" })).queryByRole("button") === null);

  const details = screen.getByTestId("billing-details-card");
  assert.ok(within(details).getByText("Monthly"));
  assert.ok(within(details).getByText("Renews"));
  assert.ok(within(details).getByText("Aug 20, 2026"));
  assert.ok(within(details).getByText("2 seats", { selector: "dd" }));
  assert.ok(within(details).getByText("Invoices, receipts and the payment method are in Stripe."));

  const cancel = screen.getByTestId("billing-cancel-card");
  assert.ok(details.compareDocumentPosition(cancel) & Node.DOCUMENT_POSITION_FOLLOWING, "cancelling comes last");
  assert.ok(within(cancel).getByText(/^Pro stays until Aug 20, 2026\./));
  assert.ok(screen.queryByTestId("billing-upgrade-card") === null, "absent");
  assert.ok(screen.queryByTestId("billing-past-due") === null, "absent");
  assert.ok(screen.queryByTestId("billing-ending") === null, "absent");
});

test("Manage in Stripe posts /billing/portal, saying which button (billing_portal_opened)", async () => {
  seedProManageSeats();
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  api.post = (async (url: string, body: Record<string, unknown>) => {
    calls.push({ url, body });
    // Never resolve: the page assigns window.location.href on success,
    // which jsdom cannot perform. The call itself is the contract.
    return new Promise(() => {});
  }) as typeof api.post;

  renderPlanSection();

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /^Manage in Stripe/ }));
  });
  assert.deepEqual(calls.map(({ url, body }) => [url, body.entry, body.from]), [["/billing/portal", "settings", "plan_card"]]);
});

// Warden's v4 H (cindyz): no grace period after Pro ends, so a server in more
// than one external channel is told, in the cancel confirmation, that they all
// freeze until it is back to one; with one or none the dialog says nothing more.
test("the cancel confirmation warns a server in more than one external channel, and only then", async () => {
  for (const [count, warned] of [[4, true], [1, false]] as const) {
    seedProManageSeats();
    useServerStore.setState({ billing: { ...useServerStore.getState().billing!, externalChannelsTotal: count } });
    renderPlanSection();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel subscription" }));
    });
    const dialog = screen.getByRole("dialog");
    const line = within(dialog).queryByTestId("cancel-external-channels");
    if (warned) {
      assert.equal(line?.textContent, "Billing is in 4 external channels. Free includes 1, so when Pro ends Billing can't post in any of them until it is back to 1.");
    } else {
      assert.ok(line === null, "one external channel: no warning");
    }
    cleanup();
  }
});

test("cancel-subscription confirms in a dialog, then posts /billing/cancel", async () => {
  seedProManageSeats();
  const sent = captureProductEvents();
  const calls: Array<{ url: string; body: unknown }> = [];
  api.post = (async (url: string, body?: unknown) => {
    calls.push({ url, body });
    if (url === "/billing/cancel") {
      return { data: { status: "scheduled_period_end" } };
    }
    throw new Error(`unexpected POST ${url}`);
  }) as typeof api.post;

  renderPlanSection();

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Cancel subscription" }));
  });
  const dialog = screen.getByRole("dialog");
  assert.ok(within(dialog).getByRole("heading", { name: "Cancel subscription" }));
  // The action is itself a cancel, so its Cancel says what stays (task #148).
  assert.ok(within(dialog).getByRole("button", { name: "Keep subscription" }));
  assert.ok(within(dialog).queryByRole("button", { name: "Cancel" }) === null);
  await act(async () => {
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel subscription" }));
  });
  assert.deepEqual(calls, [{ url: "/billing/cancel", body: { entry: "settings" } }]);
  assert.ok(screen.getByText("Subscription cancellation scheduled for the end of the current billing period."));
  assert.deepEqual(await dialogEvents(sent), [["opened", "cancel_subscription", null], ["closed", "cancel_subscription", "completed"]]);
});

test("each dialog left without finishing is dismissed once, a failed cancellation too; the past-due banner's portal says so", async () => {
  seedProManageSeats();
  const sent = captureProductEvents();
  const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
  api.post = (async (url: string, body?: Record<string, unknown>) => {
    calls.push({ url, body });
    if (url === "/billing/cancel") throw Object.assign(new Error("nope"), { response: { data: { error: "Stripe is down" } } });
    return new Promise(() => {});
  }) as typeof api.post;
  renderPlanSection();

  fireEvent.click(screen.getByRole("button", { name: "Add seats" }));
  fireEvent.click(within(await screen.findByTestId("add-seats-dialog")).getByRole("button", { name: "Close" }));
  fireEvent.click(screen.getByRole("button", { name: "Manage seats" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel subscription" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Keep subscription" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel subscription" }));
  await act(async () => {
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel subscription" }));
  });
  assert.ok(screen.getByText("Stripe is down"));
  assert.deepEqual(await dialogEvents(sent), [
    ["opened", "add_seats", null], ["closed", "add_seats", "dismissed"],
    ["opened", "remove_seats", null], ["closed", "remove_seats", "dismissed"],
    ["opened", "cancel_subscription", null], ["closed", "cancel_subscription", "dismissed"],
    ["opened", "cancel_subscription", null], ["closed", "cancel_subscription", "dismissed"],
  ]);
  assert.deepEqual(sent.find((event) => event.event === "plan_billing_dialog_opened")?.properties, { dialog: "add_seats", entry: "settings", viewer_role: "owner" });

  cleanup();
  seedBilling({
    plan: "pro",
    subscription: { status: "past_due", billingInterval: "monthly" },
    capacity: { maxHumans: 2, maxAgents: 20, maxUniversalSeats: 2 },
    usage: { humans: 1, agents: 0, universalSeats: 1 },
    provisioned: { humans: 2, agents: 20, proPackQuantity: 2 },
    price: { billingInterval: "monthly", monthlyUsd: 20, annualUsd: 211.2 },
  });
  api.post = (async (url: string, body?: Record<string, unknown>) => {
    calls.push({ url, body });
    return new Promise(() => {});
  }) as typeof api.post;
  renderPlanSection();
  await act(async () => {
    fireEvent.click(within(screen.getByTestId("billing-past-due")).getByRole("button", { name: /^Update payment method/ }));
  });
  assert.deepEqual([calls.at(-1)?.url, calls.at(-1)?.body?.from], ["/billing/portal", "past_due_banner"]);
});

test("a failed payment is a banner with Update Payment Method; no seats are added meanwhile", () => {
  seedBilling({
    plan: "pro",
    subscription: { status: "past_due", billingInterval: "monthly" },
    capacity: { maxHumans: 2, maxAgents: 20, maxUniversalSeats: 2 },
    usage: { humans: 1, agents: 0, universalSeats: 1 },
    provisioned: { humans: 2, agents: 20, proPackQuantity: 2 },
    price: { billingInterval: "monthly", monthlyUsd: 20, annualUsd: 211.2 },
  });
  renderPlanSection();
  const banner = screen.getByTestId("billing-past-due");
  assert.ok(within(banner).getByText("Payment failed"));
  assert.ok(within(banner).getByRole("button", { name: /^Update payment method/ }));
  assert.ok(within(screen.getByTestId("billing-current-plan-card")).getByText("Payment failed"), "the plan card's badge says it too");
  assert.ok(screen.queryByRole("button", { name: "Add seats" }) === null, "absent");
  assert.ok(screen.queryByRole("button", { name: "Manage seats" }) === null, "absent");
});

test("a scheduled cancellation shows the end date and Keep Pro, which reactivates with the same seats", async () => {
  seedBilling({
    plan: "pro",
    subscription: { status: "active", billingInterval: "annual", cancelAtPeriodEnd: true },
    capacity: { maxHumans: 2, maxAgents: 20, maxUniversalSeats: 2 },
    usage: { humans: 1, agents: 0, universalSeats: 1 },
    provisioned: { humans: 2, agents: 20, proPackQuantity: 2 },
    price: { billingInterval: "annual", monthlyUsd: 20, annualUsd: 211.2 },
  });
  const posts: Array<{ url: string; body: unknown }> = [];
  api.post = (async (url: string, body?: unknown) => {
    posts.push({ url, body });
    return { data: { status: "reactivated" } };
  }) as typeof api.post;
  renderPlanSection();

  const banner = screen.getByTestId("billing-ending");
  assert.ok(within(banner).getByText("Pro ends on Aug 20, 2026"));
  assert.ok(within(screen.getByTestId("billing-current-plan-card")).getByText("$211.20 a year · 2 seats · Ends Aug 20, 2026"));
  assert.ok(within(screen.getByTestId("billing-details-card")).getByText("Last day of Pro"));
  // Changing seats now would quietly take the cancellation back, so neither is offered.
  assert.ok(screen.queryByRole("button", { name: "Add seats" }) === null, "absent");
  assert.ok(screen.queryByRole("button", { name: "Manage seats" }) === null, "absent");
  assert.ok(screen.queryByTestId("billing-cancel-card") === null, "absent");

  await act(async () => {
    fireEvent.click(within(banner).getByRole("button", { name: "Keep Pro" }));
  });
  assert.deepEqual(posts, [{ url: "/billing/seat-pack-quantity", body: { seatQuantity: 2, entry: "settings" } }]);
  assert.ok(screen.getByText("Subscription reactivated. Your current Pro seat capacity stays active."));
});

test("Keep Pro on a server that has outgrown its seats adds seats instead (the server keeps no fewer than are used)", async () => {
  seedBilling({
    plan: "pro",
    subscription: { status: "active", billingInterval: "monthly", cancelAtPeriodEnd: true },
    capacity: { maxHumans: 2, maxAgents: 20, maxUniversalSeats: 2 },
    usage: { humans: 3, agents: 0, universalSeats: 3 },
    provisioned: { humans: 2, agents: 20, proPackQuantity: 2 },
    price: { billingInterval: "monthly", monthlyUsd: 20, annualUsd: 211.2 },
  });
  const sent = captureProductEvents();
  const posts: string[] = [];
  api.post = (async (url: string) => {
    posts.push(url);
    return new Promise(() => {});
  }) as typeof api.post;
  renderPlanSection();
  await act(async () => {
    fireEvent.click(within(screen.getByTestId("billing-ending")).getByRole("button", { name: "Keep Pro" }));
  });
  assert.ok(await screen.findByTestId("add-seats-dialog"), "keeping Pro starts from adding the seats in use");
  assert.ok(!posts.includes("/billing/seat-pack-quantity"), "nothing is sent until the seats are priced and confirmed");
  // Counted apart from adding seats unprompted.
  fireEvent.click(within(screen.getByTestId("add-seats-dialog")).getByRole("button", { name: "Close" }));
  assert.deepEqual(await dialogEvents(sent), [["opened", "keep_pro", null], ["closed", "keep_pro", "dismissed"]]);
});

test("Pro admin reads the billing without owner controls", () => {
  seedBilling({
    plan: "pro",
    serverRole: "admin",
    canManageBilling: false,
    subscription: { status: "active", billingInterval: "monthly" },
    capacity: { maxHumans: 2, maxAgents: 20, maxUniversalSeats: 2 },
    usage: { humans: 1, agents: 0, universalSeats: 1 },
    provisioned: { humans: 2, agents: 20, proPackQuantity: 2 },
    price: { billingInterval: "monthly", monthlyUsd: 20, annualUsd: 211.2 },
  });
  renderPlanSection();
  assert.ok(screen.queryByRole("button", { name: "Add seats" }) === null, "absent");
  assert.ok(screen.queryByRole("button", { name: /Manage in Stripe/ }) === null, "absent");
  assert.ok(screen.queryByRole("button", { name: "Manage seats" }) === null, "absent");
  assert.ok(screen.queryByTestId("billing-cancel-card") === null, "absent");
  assert.ok(screen.getByText("Only server owners can change billing or see invoices."));
});

test("Manage Seats lowers the total down to what is used, without a preview", async () => {
  seedBilling({
    plan: "pro",
    subscription: { status: "active", billingInterval: "monthly" },
    capacity: { maxHumans: 5, maxAgents: 50, maxUniversalSeats: 5 },
    usage: { humans: 2, agents: 3, universalSeats: 2.3 },
    provisioned: { humans: 5, agents: 50, proPackQuantity: 5 },
    price: { billingInterval: "monthly", monthlyUsd: 50, annualUsd: 528 },
  });
  const sent = captureProductEvents();
  const posts: Array<{ url: string; body: unknown }> = [];
  api.post = (async (url: string, body?: unknown) => {
    posts.push({ url, body });
    return { data: { status: "updated" } };
  }) as typeof api.post;
  renderPlanSection();

  fireEvent.click(within(screen.getByTestId("billing-usage-card")).getByRole("button", { name: "Manage seats" }));
  const dialog = screen.getByRole("dialog");
  assert.ok(within(dialog).getByRole("heading", { name: "Manage seats" }));
  assert.ok(within(dialog).getByText("Billing has 5 seats. Its people and agents use 2.3 of them, so it needs at least 3 seats."));
  // One fewer to start, priced as billed now ($10 a seat).
  assert.equal(within(dialog).getByTestId("manage-seats-dialog-total").textContent, "4");
  assert.ok(within(dialog).getByText("$40 a month"));
  assert.ok((within(dialog).getByRole("button", { name: "One more seat" }) as HTMLButtonElement).disabled, "at least one goes");
  // 5 bought, 3 needed: at most 2 can go.
  fireEvent.click(within(dialog).getByRole("button", { name: "One fewer seat" }));
  assert.equal(within(dialog).getByTestId("manage-seats-dialog-total").textContent, "3");
  assert.ok(within(dialog).getByText("$30 a month"));
  assert.ok((within(dialog).getByRole("button", { name: "One fewer seat" }) as HTMLButtonElement).disabled);
  await act(async () => {
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove 2 seats" }));
  });
  assert.deepEqual(posts, [{ url: "/billing/seat-pack-quantity", body: { seatQuantity: 3, entry: "settings" } }]);
  assert.ok(screen.getByText("Removed 2 seats. Stripe credits the unused time on the next invoice."));
  assert.deepEqual(await dialogEvents(sent), [["opened", "remove_seats", null], ["closed", "remove_seats", "completed"]]);
});

test("Manage Seats on a yearly plan prices the new total by the year", () => {
  seedBilling({
    plan: "pro",
    subscription: { status: "active", billingInterval: "annual" },
    capacity: { maxHumans: 6, maxAgents: 60, maxUniversalSeats: 6 },
    usage: { humans: 2, agents: 0, universalSeats: 2 },
    provisioned: { humans: 6, agents: 60, proPackQuantity: 6 },
    price: { billingInterval: "annual", monthlyUsd: 52.8, annualUsd: 6 * 105.6 },
  });
  renderPlanSection();

  fireEvent.click(screen.getByRole("button", { name: "Manage seats" }));
  const dialog = screen.getByRole("dialog");
  assert.equal(within(dialog).getByTestId("manage-seats-dialog-total").textContent, "5");
  assert.ok(within(dialog).getByText("$528 a year"));
});

test("Manage Seats only shows with at least one whole seat unused", () => {
  // 4.4 of 5 used: 0.6 free, so nothing can go.
  seedBilling({
    plan: "pro",
    subscription: { status: "active", billingInterval: "monthly" },
    capacity: { maxHumans: 5, maxAgents: 50, maxUniversalSeats: 5 },
    usage: { humans: 3, agents: 14, universalSeats: 4.4 },
    provisioned: { humans: 5, agents: 50, proPackQuantity: 5 },
    price: { billingInterval: "monthly", monthlyUsd: 50, annualUsd: 528 },
  });
  renderPlanSection();
  assert.ok(within(screen.getByTestId("billing-usage-card")).getByText("4.4 of 5 used"));
  assert.ok(screen.queryByRole("button", { name: "Manage seats" }) === null, "absent");
});

test("Add Seats opens the add-seats dialog for this page: Stripe's price, a promotion code, entry settings", async () => {
  seedProManageSeats();
  const sent = captureProductEvents();
  const posts: Array<{ url: string; body: unknown }> = [];
  api.post = (async (url: string, body?: { promotionCode?: string }) => {
    posts.push({ url, body });
    if (url === "/billing/seat-pack-quantity/preview") {
      return {
        data: {
          status: "preview",
          currency: "usd",
          prorationAmount: 500,
          recurringAmount: body?.promotionCode ? 2700 : 3000,
          discountAmount: body?.promotionCode ? 300 : 0,
          promotion: body?.promotionCode ? { code: body.promotionCode } : null,
          previewToken: body?.promotionCode ? "token-promo" : "token-plain",
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        },
      };
    }
    return { data: { status: "pending_webhook" } };
  }) as typeof api.post;
  renderPlanSection();

  fireEvent.click(screen.getByRole("button", { name: "Add seats" }));
  const dialog = await screen.findByTestId("add-seats-dialog");
  assert.ok(within(dialog).getByText("Add seats to Billing"));
  assert.ok(within(dialog).getByText("Seats today"));
  assert.ok(within(dialog).queryByTestId("add-seats-dialog-overflow") === null, "nothing ran out: no overflow row");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
  assert.deepEqual(posts.at(-1), { url: "/billing/seat-pack-quantity/preview", body: { seatQuantity: 3 } });

  fireEvent.click(within(dialog).getByTestId("add-seats-dialog-promo-open"));
  fireEvent.change(within(dialog).getByTestId("add-seats-dialog-promo-input"), { target: { value: " SAVE10 " } });
  fireEvent.click(within(dialog).getByTestId("add-seats-dialog-promo-apply"));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
  assert.deepEqual(posts.at(-1), { url: "/billing/seat-pack-quantity/preview", body: { seatQuantity: 3, promotionCode: "SAVE10" } });
  assert.ok(within(dialog).getByText(/^From .+, with SAVE10: \$3\.00 off$/), "the renewal's note says the code's discount is in");

  await act(async () => {
    fireEvent.click(within(dialog).getByTestId("add-seats-dialog-commit"));
  });
  assert.deepEqual(posts.at(-1), { url: "/billing/seat-pack-quantity", body: { seatQuantity: 3, previewToken: "token-promo", entry: "settings" } });
  // Stripe charged (pending_webhook): done, though the seats count only after its webhook.
  assert.deepEqual(await dialogEvents(sent), [["opened", "add_seats", null], ["closed", "add_seats", "completed"]]);
});

test("a promotion code Stripe refuses is said beside the field, and the seats are priced without it", async () => {
  seedProManageSeats();
  const posts: Array<{ promotionCode?: string } | undefined> = [];
  api.post = (async (url: string, body?: { promotionCode?: string }) => {
    if (url !== "/billing/seat-pack-quantity/preview") throw new Error(`unexpected POST ${url}`);
    posts.push(body);
    if (body?.promotionCode) {
      const error = Object.assign(new Error("refused"), { response: { status: 400, data: { error: "This promotion code is unavailable" } } });
      throw error;
    }
    return { data: { status: "preview", currency: "usd", prorationAmount: 500, recurringAmount: 3000, previewToken: "token-plain", expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() } };
  }) as typeof api.post;
  renderPlanSection();
  fireEvent.click(screen.getByRole("button", { name: "Add seats" }));
  const dialog = await screen.findByTestId("add-seats-dialog");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
  fireEvent.click(within(dialog).getByTestId("add-seats-dialog-promo-open"));
  fireEvent.change(within(dialog).getByTestId("add-seats-dialog-promo-input"), { target: { value: "BAD" } });
  fireEvent.click(within(dialog).getByTestId("add-seats-dialog-promo-apply"));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 700));
  });
  assert.ok(within(dialog).getByTestId("add-seats-dialog-promo-error").textContent?.includes("This promotion code is unavailable"));
  assert.deepEqual(posts.slice(0, 2).map((body) => body?.promotionCode ?? null), [null, "BAD"]);
  assert.ok(within(dialog).queryByTestId("add-seats-dialog-promo-applied") === null, "the refused code isn't shown as applied");
  assert.ok(!(within(dialog).getByTestId("add-seats-dialog-commit") as HTMLButtonElement).disabled, "the seats can still be added, priced without it");

  // Apply again: Stripe is asked again, even for the same code.
  const before = posts.length;
  fireEvent.click(within(dialog).getByTestId("add-seats-dialog-promo-apply"));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
  assert.equal(posts[before]?.promotionCode, "BAD");
});

test("a promotion code isn't dropped when Stripe is only busy: the price asks for a retry and keeps the code", async () => {
  seedProManageSeats();
  const posts: Array<{ promotionCode?: string } | undefined> = [];
  let busy = true;
  api.post = (async (url: string, body?: { promotionCode?: string }) => {
    if (url !== "/billing/seat-pack-quantity/preview") throw new Error(`unexpected POST ${url}`);
    posts.push(body);
    if (body?.promotionCode && busy) {
      throw Object.assign(new Error("busy"), { response: { status: 429, data: { error: "Too many requests" } } });
    }
    return { data: { status: "preview", currency: "usd", prorationAmount: 500, recurringAmount: 2700, discountAmount: body?.promotionCode ? 300 : 0, promotion: body?.promotionCode ? { code: body.promotionCode } : null, previewToken: "t", expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() } };
  }) as typeof api.post;
  renderPlanSection();
  fireEvent.click(screen.getByRole("button", { name: "Add seats" }));
  const dialog = await screen.findByTestId("add-seats-dialog");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
  fireEvent.click(within(dialog).getByTestId("add-seats-dialog-promo-open"));
  fireEvent.change(within(dialog).getByTestId("add-seats-dialog-promo-input"), { target: { value: "SAVE10" } });
  fireEvent.click(within(dialog).getByTestId("add-seats-dialog-promo-apply"));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
  assert.ok(within(dialog).getByText(/Too many requests/));
  assert.ok((within(dialog).getByTestId("add-seats-dialog-commit") as HTMLButtonElement).disabled, "no price, no commit");
  assert.ok(within(dialog).getByTestId("add-seats-dialog-promo-applied"), "the code is kept");

  busy = false;
  fireEvent.click(within(dialog).getByTestId("add-seats-dialog-preview-retry"));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
  assert.equal(posts.at(-1)?.promotionCode, "SAVE10", "the retry prices the code again");
  assert.ok(!(within(dialog).getByTestId("add-seats-dialog-commit") as HTMLButtonElement).disabled);
});

test("billing that didn't load says so, and shows nothing it can't know", () => {
  seedBilling({ plan: "free" });
  useServerStore.setState({ billing: null } as never);
  renderPlanSection();
  assert.ok(screen.getByText("Couldn't load billing"));
  assert.ok(screen.queryByTestId("billing-upgrade-card") === null, "no buying from a plan it can't confirm");
  assert.ok(screen.queryByText("Members") === null, "no member count without billing");
  assert.ok(screen.getByText("Last 30 days. Older messages are hidden until the server is on Pro."), "the Free limits still read from the plan");
});

test("partial billing (no capacity, no permissions) renders without owner controls instead of crashing", () => {
  seedProManageSeats();
  const billing = useServerStore.getState().billing as unknown as Record<string, unknown>;
  useServerStore.setState({ billing: { ...billing, capacity: undefined, permissions: undefined } } as never);
  renderPlanSection();
  assert.ok(screen.getByTestId("billing-current-plan-card"));
  assert.ok(screen.queryByRole("button", { name: "Add seats" }) === null, "absent");
});

// The member-side boundary is routing, not this component: canOpenSettingsTab
// redirects members away from the billing tab before PlanSection ever mounts,
// which tests/settingsRuntimeContracts.behavior.test.tsx (removed in the 2026-11 web DOM test prune) pins ("member direct
// routes cannot open billing or administration settings"). The
// "Only server owners and admins can view billing" notice inside
// BillingTabContent is a defense-in-depth fallback that tab routing makes
// unreachable, so it is not asserted here.

test("AppSumo renders lifetime tier and separate allowances without Stripe controls", () => {
  seedBilling({
    plan: "pro",
    appsumo: { tier: 1, lifetime: true, maxHumans: 2, maxAgents: 10, maxHostedJointChannels: 2, hostedJointChannels: 1, monthlyUploadBytes: 1024 ** 3 },
    capacity: { maxHumans: 2, maxAgents: 10, maxUniversalSeats: -1 },
    usage: { humans: 2, agents: 10, universalSeats: 3 },
    // Without the month, the reset is left out rather than guessed.
    fileUploadQuota: { limited: true, usedBytes: 512 * 1024 ** 2, remainingBytes: 512 * 1024 ** 2, limitBytes: 1024 ** 3 },
    subscription: { status: "active", billingInterval: "monthly" },
  });
  renderPlanSection();
  assert.ok(screen.getByRole("heading", { name: "AppSumo Lifetime Pro · Tier 1" }));
  assert.ok(screen.getByText("Lifetime"));
  assert.ok(screen.getByText("2 of 2 used"));
  assert.ok(screen.getByText("10 of 10 used"));
  assert.ok(screen.getByText("1 of 2 used"));
  assert.ok(screen.getByText("512 MB of 1 GB used"));
  assert.ok(screen.queryByRole("button", { name: /Manage in Stripe/ }) === null, "absent");
  assert.ok(screen.queryByRole("button", { name: /Cancel subscription/ }) === null, "absent");
  assert.ok(screen.queryByRole("button", { name: "Add seats" }) === null, "absent");
});

test("AppSumo with an active Stripe record shows a manual billing conflict without payment controls", () => {
  seedBilling({ plan: "pro", appsumo: { tier: 1, lifetime: true, maxHumans: 2, maxAgents: 10, maxHostedJointChannels: 2, hostedJointChannels: 0, monthlyUploadBytes: 1024 ** 3 }, sourceConflict: "appsumo_stripe", subscription: { status: "active", billingInterval: "monthly" } });
  renderPlanSection();
  assert.ok(screen.getByText(/Stripe subscription also exists/));
  assert.ok(screen.getByText(/Stripe current period ends/));
  assert.ok(screen.queryByRole("button", { name: /Cancel subscription|Add seats|Manage in Stripe/ }) === null);
});

test("Pro owner's Billing card says what Stripe charges; admins and an unanswered Stripe show no row", async () => {
  seedProManageSeats();
  const gets: string[] = [];
  api.get = (async (url: string) => {
    gets.push(url);
    if (url === "/billing/payment-method") {
      return { data: { paymentMethod: { type: "card", brand: "visa", last4: "4242", expMonth: 8, expYear: 2027 } } };
    }
    throw Object.assign(new Error("not here"), { response: { status: 404 } });
  }) as typeof api.get;
  renderPlanSection();
  const row = await screen.findByText("Visa ending in 4242 · expires 08/27");
  assert.ok(within(screen.getByTestId("billing-details-card")).getByText("Payment method"));
  assert.ok(row);
  assert.ok(gets.includes("/billing/payment-method"));

  cleanup();
  api.get = (async () => { throw Object.assign(new Error("down"), { response: { status: 502 } }); }) as typeof api.get;
  seedProManageSeats();
  renderPlanSection();
  await act(async () => { await Promise.resolve(); });
  assert.ok(screen.queryByTestId("billing-payment-method") === null, "Stripe didn't answer: no row rather than a wrong one");

  cleanup();
  const adminGets: string[] = [];
  api.get = (async (url: string) => { adminGets.push(url); throw Object.assign(new Error("x"), { response: { status: 404 } }); }) as typeof api.get;
  seedBilling({
    plan: "pro",
    serverRole: "admin",
    canManageBilling: false,
    subscription: { status: "active", billingInterval: "monthly" },
    capacity: { maxHumans: 2, maxAgents: 20, maxUniversalSeats: 2 },
    usage: { humans: 1, agents: 0, universalSeats: 1 },
    provisioned: { humans: 2, agents: 20, proPackQuantity: 2 },
    price: { billingInterval: "monthly", monthlyUsd: 20, annualUsd: 211.2 },
  });
  renderPlanSection();
  assert.ok(!adminGets.includes("/billing/payment-method"), "admins don't ask for it");
  assert.ok(screen.queryByTestId("billing-payment-method") === null, "absent");
});
