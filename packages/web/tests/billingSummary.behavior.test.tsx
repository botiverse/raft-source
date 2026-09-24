import assert from "node:assert/strict";
import { afterEach, test as nodeTest } from "node:test";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import api from "../src/api/client";
import { PlanSection } from "../src/components/settings/SettingsPanel";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useServerStore } from "../src/store/serverStore";
import { TestIntlProvider } from "./helpers/intl";

// Mounted-DOM replacement for the SettingsPanel half of
// tests/billingSummaryContract.test.ts. It checks the rendered plan card,
// features, seat usage, pricing controls, and endpoint calls for each billing state.
//
// Deliberately NOT here:
// - the exact English/zh wording of catalog copy (pinned in en.ts/zh-cn.ts
//   via tests/billingTrialAndCheckout.i18n.test.ts and
//   tests/billingPlanPresentation.i18n.test.ts),
// - the plan -> feature-id mapping inside billingControls.ts (pinned by
//   tests/billingPartnerPlan.behavior.test.tsx against the pure functions),
// - the seat-update preview/confirm flow (tests/billingConfirmComposition.behavior.test.tsx).

type TestFn = () => void | Promise<void>;
const test = (name: string, fn: TestFn) =>
  nodeTest(name, { concurrency: false }, fn);

const originalGet = api.get;
const originalPost = api.post;
const originalPatch = api.patch;

type BillingSeed = {
  plan: "free" | "pro" | "founder" | "partner";
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
  fileUploadQuota?: { limited: boolean; usedBytes: number; limitBytes: number };
  serverRole?: "owner" | "admin" | "member";
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
      planDowngradedAt: null,
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
      source: subscription ? "subscription" : "server",
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
});

function bodyText(): string {
  return document.body.textContent ?? "";
}

test("free plan renders the contract plan card with included/not-included features and usage rows", () => {
  const { loadBillingCalls, loadUsageCalls } = seedBilling({
    plan: "free",
    fileUploadQuota: { limited: true, usedBytes: 10 * 1024 * 1024, limitBytes: 100 * 1024 * 1024 },
  });

  renderPlanSection();

  // The section loads billing state through the store hooks, not a side channel.
  assert.equal(loadBillingCalls.length, 1);
  assert.equal(loadUsageCalls.length, 1);

  assert.ok(screen.getByText("Current Plan"));
  assert.ok(screen.getByText("Free"));
  assert.ok(screen.getByText("Start building with agents."));

  const included = screen.getByText("Included");
  const card = included.closest("div.border-2");
  assert.ok(card instanceof HTMLElement, "plan card container not found");
  for (const feature of [
    "Channels",
    "Tasks",
    "Agents on your own computers",
    "Agent reminders",
    "Basic observability",
    "30 days of message history",
    "100 MB file uploads/month",
    "1 free Joint Channel for a limited time",
  ]) {
    assert.ok(within(card).getByText(feature), `free plan must list "${feature}" as included`);
  }
  assert.ok(screen.getByText("Not included"));
  for (const feature of [
    "Higher file upload limits",
    "Unlimited message history",
    "Unlimited Joint Channels",
    "More professional features coming soon",
  ]) {
    assert.ok(within(card).getByText(feature), `free plan must list "${feature}" as not included`);
  }

  // Usage rows for the free plan: message history and the monthly file quota.
  assert.ok(screen.getByText("Message History"));
  assert.ok(screen.getByText("30 days"));
  assert.ok(screen.getByText("File uploads"));
  assert.ok(screen.getByText("10 MB / 100 MB this month"));
  // Seat usage is pro-only.
  assert.ok(screen.queryByText("Seat") === null, "the free plan must not render the seat usage row");

  const compare = screen.getByRole("link", { name: "See all features and compare plans" });
  assert.equal(compare.getAttribute("href"), "https://raft.build/#pricing");
  assert.ok(compare.classList.contains("btn-brutal-sm"));
  assert.ok(compare.classList.contains("bg-white"));

  // Retired copy stays retired (was doesNotMatch source regexes).
  for (const stale of [
    "active usage",
    "Free Trial Active",
    "Builder Seat Pack",
    "Team Seat Pack",
    "Universal seats",
    "Human Seat",
    "Agent Seat",
    "Subscription management",
    "Start free trial",
  ]) {
    assert.ok(
      !bodyText().toLowerCase().includes(stale.toLowerCase()),
      `billing surface must not render retired copy "${stale}"`,
    );
  }
});

test("checkout-mode pricing defaults to annual with the strike-through original, and monthly removes it", () => {
  seedBilling({ plan: "free" });
  renderPlanSection();

  // "Upgrade to Pro" is both the section heading and the checkout button.
  assert.ok(screen.getAllByText("Upgrade to Pro").length >= 2);
  assert.ok(screen.getByText("How often do you want to be billed?"));

  const monthly = screen.getByTestId("billing-interval-monthly");
  const annual = screen.getByTestId("billing-interval-annual");
  assert.ok(
    monthly.compareDocumentPosition(annual) & Node.DOCUMENT_POSITION_FOLLOWING,
    "monthly must be listed before annual",
  );
  assert.equal(monthly.textContent, "Monthly");
  assert.ok(annual.textContent?.includes("Yearly"));
  assert.ok(annual.textContent?.includes("Save 12%"), "annual option carries the discount badge");
  const annualBadge = within(annual).getByText("Save 12%");
  assert.ok(annualBadge.classList.contains("uppercase"));

  // Seat input is a numeric text field, not a spinner.
  const seatInput = screen.getByRole("textbox", { name: "Seats to buy" });
  assert.equal(seatInput.getAttribute("type"), "text");
  assert.equal(seatInput.getAttribute("inputmode"), "numeric");

  // The default interval is annual: the summary strikes through the
  // monthly-equivalent original next to the discounted yearly total.
  assert.ok(screen.getByText("Checkout summary"));
  assert.ok(screen.getByText("Total"));
  assert.ok(screen.getByText("$105.60 / year"));
  const struckOriginal = document.querySelector(".line-through");
  assert.ok(struckOriginal instanceof HTMLElement, "annual pricing strikes through the original");
  assert.equal(struckOriginal.textContent, "$120 / year");

  fireEvent.click(monthly);
  assert.ok(screen.getByText("$10 / month"));
  assert.equal(document.querySelector(".line-through"), null, "monthly pricing shows no original price");

  // Capacity summary renders humans before agents.
  const capacityRow = screen.getByText("Capacity").parentElement;
  assert.ok(capacityRow instanceof HTMLElement);
  const capacityText = capacityRow.textContent ?? "";
  assert.ok(capacityText.includes("up to 1 Human"));
  assert.ok(capacityText.includes("or 10 Agents"));
  assert.ok(
    capacityText.indexOf("up to 1 Human") < capacityText.indexOf("or 10 Agents"),
    "capacity summary renders the human capacity before the agent capacity",
  );

  // The seat-coverage help is one catalog sentence with the computed minimum.
  assert.ok(
    bodyText().includes("Each seat covers 1 human or 10 agents. Current usage requires at least 1 seat. Each seat is $10/month."),
  );
  assert.ok(screen.getByText("Enter the number of seats to buy."));
});

test("checkout confirmation states the priced summary and posts /billing/checkout", async () => {
  seedBilling({ plan: "free" });
  const calls: Array<{ url: string; body: unknown }> = [];
  api.post = (async (url: string, body?: unknown) => {
    calls.push({ url, body });
    // Never resolve: handleCheckout assigns window.location.href on success,
    // which jsdom cannot perform. The call itself is the contract.
    return new Promise(() => {});
  }) as typeof api.post;

  renderPlanSection();

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Upgrade to Pro" }));
  });

  const dialog = screen.getByRole("dialog");
  assert.ok(within(dialog).getByText("Confirm Pro Checkout"));
  assert.ok(within(dialog).getByText("You are about to start Pro checkout."));
  const dialogText = dialog.textContent ?? "";
  assert.ok(dialogText.includes("Seats: 1"), "checkout dialog states the seat count");
  assert.ok(
    dialogText.includes("up to 1 Human or 10 Agents"),
    "checkout dialog states the capacity pair",
  );
  assert.ok(dialogText.includes("Total: $105.60 / year"), "checkout dialog states the priced total");
  assert.ok(within(dialog).getByText("The next page is Stripe Checkout, where the payment amount is shown before you pay."));

  await act(async () => {
    fireEvent.click(within(dialog).getByRole("button", { name: "Continue to Stripe" }));
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/billing/checkout");
  assert.deepEqual(
    { ...(calls[0].body as Record<string, unknown>), successUrl: undefined, cancelUrl: undefined },
    {
      targetPlan: "pro",
      billingInterval: "annual",
      seatQuantity: 1,
      humanSeatQuantity: 1,
      agentSeatQuantity: 10,
      successUrl: undefined,
      cancelUrl: undefined,
    },
  );
});

test("pro plan renders seat usage, manage-seats copy, and the subscription summary", () => {
  seedBilling({
    plan: "pro",
    subscription: { status: "active", billingInterval: "monthly" },
    capacity: { maxHumans: 2, maxAgents: 20, maxUniversalSeats: 2 },
    usage: { humans: 1, agents: 5, universalSeats: 1.5 },
    provisioned: { humans: 2, agents: 20, proPackQuantity: 2 },
    price: { billingInterval: "monthly", monthlyUsd: 20, annualUsd: 211.2 },
  });

  renderPlanSection();

  assert.ok(screen.getByText("Pro"));
  assert.ok(
    screen.getByText("2 seats purchased. Each human uses 1 seat; each agent uses 0.1 seat."),
  );

  // Universal-seat usage block: seat count, stacked bar, and the two swatches.
  assert.ok(screen.getByText("Seat"));
  const usageValue = screen.getByText(
    (_content, el) => el instanceof HTMLElement && el.textContent === "1.5 / 2 used",
  );
  assert.ok(usageValue);
  const humansSwatch = screen.getByTitle("1 human using 1 seat");
  assert.ok(humansSwatch.classList.contains("bg-soft-signal"));
  const agentsSwatch = screen.getByTitle("5 agents using 0.5 seats");
  assert.ok(agentsSwatch.classList.contains("bg-brutal-pink"));
  assert.ok(screen.getByText("Humans"));
  assert.ok(screen.getByText("Agents"));
  // The free-plan usage rows stay off the pro surface.
  assert.ok(screen.queryByText("Message History") === null, "the pro plan must not render the free-plan usage rows");
  assert.ok(screen.queryByText("File uploads") === null, "the pro plan must not render the free-plan usage rows");

  // Manage-seats mode copy.
  assert.ok(screen.getByText("Manage Seats"));
  assert.ok(screen.getByText("Enter the total seats after this update."));
  const seatInput = screen.getByRole("textbox", { name: "Total seats" });
  assert.equal((seatInput as HTMLInputElement).value, "2");
  assert.ok(
    screen.getByText(
      (_content, el) => el instanceof HTMLElement && el.textContent === "Billing interval: Monthly",
    ),
  );
  assert.ok(screen.getByText("Manage seats summary"));
  assert.ok(screen.getByText("Current seats"));
  assert.ok(screen.getByText("Current monthly total"));
  assert.ok(screen.getAllByText("$20 / month").length > 0);
  assert.ok(
    bodyText().includes("Seat increases may bill immediately after Stripe confirms payment."),
  );

  // No seat change selected -> the review button is disabled until the draft moves.
  const review = screen.getByRole("button", { name: "Review seat update" });
  assert.ok((review as HTMLButtonElement).disabled);
  fireEvent.change(seatInput, { target: { value: "3" } });
  fireEvent.blur(seatInput);
  assert.ok(!(review as HTMLButtonElement).disabled);
  assert.ok(screen.getByText("Added capacity"));

  // An active subscription exposes portal + cancel, not checkout.
  assert.ok(screen.getByRole("button", { name: "Billing portal" }));
  assert.ok(screen.getByRole("button", { name: "Cancel subscription" }));
  assert.ok(screen.queryByRole("button", { name: "Upgrade to Pro" }) === null, "an active Pro subscription must not offer checkout");
});

test("the portal action posts /billing/portal", async () => {
  seedProManageSeats();
  const calls: string[] = [];
  api.post = (async (url: string) => {
    calls.push(url);
    // Never resolve: handlePortal assigns window.location.href on success,
    // which jsdom cannot perform. The call itself is the contract.
    return new Promise(() => {});
  }) as typeof api.post;

  renderPlanSection();

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Billing portal" }));
  });
  assert.deepEqual(calls, ["/billing/portal"]);
});

test("cancel-subscription confirms in a dialog, then posts /billing/cancel", async () => {
  seedProManageSeats();
  const calls: string[] = [];
  api.post = (async (url: string) => {
    calls.push(url);
    if (url === "/billing/cancel") {
      return { data: { status: "canceled" } };
    }
    throw new Error(`unexpected POST ${url}`);
  }) as typeof api.post;

  renderPlanSection();

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Cancel subscription" }));
  });
  const dialog = screen.getByRole("dialog");
  assert.ok(within(dialog).getByText("Cancel Subscription"));
  assert.ok(
    within(dialog).getByText(/Cancel the whole Pro subscription at the end of the current billing period/),
  );
  await act(async () => {
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel subscription" }));
  });
  assert.deepEqual(calls, ["/billing/cancel"]);
  assert.ok(
    screen.getByText("Subscription cancellation scheduled for the end of the current billing period."),
    "the cancellation notice renders after the server confirms",
  );
});

test("billing controls gate on the manage-billing permission and Stripe configuration", () => {
  seedBilling({ plan: "free", canManageBilling: false });
  renderPlanSection();

  const checkout = screen.getByRole("button", { name: "Upgrade to Pro" });
  assert.ok((checkout as HTMLButtonElement).disabled);
  assert.equal(checkout.getAttribute("title"), "Only server owners can change billing.");
  assert.ok(screen.getByText("Only server owners can change billing."));

  cleanup();

  seedBilling({ plan: "free", stripeConfigured: false });
  renderPlanSection();
  const checkoutNoStripe = screen.getByRole("button", { name: "Upgrade to Pro" });
  assert.ok((checkoutNoStripe as HTMLButtonElement).disabled);
  assert.ok(screen.getByText("Paid plans are not available yet."));
  assert.ok(!bodyText().includes("Stripe billing is not configured"), "retired copy stays retired");
});

// The member-side boundary is routing, not this component: canOpenSettingsTab
// redirects members away from the billing tab before PlanSection ever mounts,
// which tests/settingsRuntimeContracts.behavior.test.tsx pins ("member direct
// routes cannot open billing or administration settings"). The
// "Only server owners and admins can view billing" notice inside
// BillingTabContent is a defense-in-depth fallback that tab routing makes
// unreachable, so its source-level assertion stays in
// tests/billingSummaryContract.test.ts.
