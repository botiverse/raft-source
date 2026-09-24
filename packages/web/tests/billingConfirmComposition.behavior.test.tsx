import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";

import api from "../src/api/client";
import { PlanSection } from "../src/components/settings/SettingsPanel";
import { useServerStore } from "../src/store/serverStore";
import { renderWithIntl as render } from "./helpers/intl";

const originalPost = api.post;
const originalUrl = window.location.href;

afterEach(() => {
  api.post = originalPost;
  window.history.replaceState({}, "", originalUrl);
  cleanup();
  useServerStore.setState({
    current: null,
    usage: null,
    billing: null,
    loadingUsage: false,
    loadingBilling: false,
  });
});

function seedManageSeatsPlan() {
  useServerStore.setState({
    current: {
      id: "server-1",
      name: "Server",
      avatarUrl: null,
      slug: "server",
      ownerId: "user-1",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "pro",
      planDowngradedAt: null,
      role: "owner",
      createdAt: "2026-07-20T00:00:00.000Z",
    },
    usage: { agents: 0, machines: 0, channels: 0 },
    billing: {
      plan: "pro",
      displayName: "Pro",
      serverPlan: "pro",
      source: "subscription",
      capacity: { maxHumans: 2, maxAgents: 20, maxUniversalSeats: 2 },
      usage: { humans: 1, agents: 0, universalSeats: 1 },
      provisioned: { humans: 2, agents: 20, proPackQuantity: 2, trialFreePackQuantity: 0 },
      price: {
        billingInterval: "monthly",
        monthlyUsd: 20,
        annualUsd: 211.2,
        discountPercent: 12,
        baseMonthlyUsd: 20,
        overageMonthlyUsd: 0,
        seatQuantity: 2,
        packQuantity: 2,
        humanSeatQuantity: 2,
        agentSeatQuantity: 20,
        agentSeatBlockQuantity: 10,
      },
      subscription: {
        status: "active",
        billingInterval: "monthly",
        currentPeriodEnd: "2026-08-20T00:00:00.000Z",
        cancelAtPeriodEnd: false,
      },
      stripeConfigured: true,
      permissions: { canReadBillingSummary: true, canManageBilling: true },
    },
    loadingUsage: false,
    loadingBilling: false,
    loadUsage: async () => undefined,
    loadBilling: async () => undefined,
  } as never);
}

test("zh-CN seat update confirmation is one complete Chinese PlanSection surface", async () => {
  window.history.replaceState({}, "", "/settings/billing?lang=zh-CN");
  seedManageSeatsPlan();

  let resolveUpdate: ((value: { data: { status: string } }) => void) | undefined;
  api.post = (async (url: string) => {
    if (url === "/billing/seat-pack-quantity/preview") {
      return {
        data: {
          status: "preview",
          currentPackQuantity: 2,
          requestedPackQuantity: 3,
          currency: "usd",
          prorationAmount: 500,
          recurringAmount: 2_700,
          discountAmount: 300,
          promotion: { code: "SAVE10", name: "Seat launch", percentOff: 10, amountOff: null, currency: null },
          previewToken: "signed-zh-seat-preview-token",
          expiresAt: "2026-07-28T12:05:00.000Z",
        },
      };
    }
    return new Promise((resolve) => {
      resolveUpdate = resolve;
    });
  }) as typeof api.post;

  // This used to render with the app locale set to "en" while `?lang=zh-CN` made
  // ONLY the billing copy Chinese — billing resolved its own locale through
  // billingText/resolveBillingUiLocale, independently of the app. That split is
  // exactly what @artin approved removing, and #5759 made `?lang=` feed the app
  // locale instead. So the surface now takes ONE locale, and this test's own
  // premise — "one complete Chinese PlanSection surface" — is finally literally
  // true: the review button is Chinese too, where before it stayed English.
  render(<PlanSection />, { locale: "zh-cn" });

  const seatInput = screen.getByRole("textbox", { name: "席位总数" });
  fireEvent.change(seatInput, { target: { value: "3" } });
  fireEvent.blur(seatInput);
  fireEvent.change(screen.getByRole("textbox", { name: "优惠码（可选）" }), { target: { value: "SAVE10" } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "审核席位更新" }));
  });

  assert.ok(screen.getByRole("heading", { name: "确认席位更新" }));
  assert.ok(screen.getByText("你即将更新此 Pro 订阅。"));
  assert.ok(screen.getByText("已应用优惠: SAVE10"));
  assert.ok(screen.getByText("预计本次按比例计费: US$5.00"));
  assert.ok(screen.getByText("优惠: -US$3.00"));
  assert.ok(screen.getByText("预计下次月付总额: US$27.00"));
  assert.ok(screen.getByText("更新后的容量: 最多 3 位人类成员，或 30 个 Agent"));
  assert.ok(screen.getAllByText("$20 / 月").length > 0, "current monthly total is catalog-rendered");
  assert.ok(screen.getAllByText("$30 / 月").length > 0, "selected monthly total is catalog-rendered");
  assert.ok(screen.getByText("此 Stripe 估算 5 分钟后失效；若已失效，请重新打开确认页。"));
  const confirmButton = screen.getByRole("button", { name: "确认并更新席位" });
  assert.ok(screen.getByRole("button", { name: "取消" }));
  assert.ok(screen.getByRole("button", { name: "关闭对话框" }));
  assert.equal(screen.queryByRole("button", { name: "Cancel" }), null);
  assert.equal(screen.queryByRole("button", { name: "Confirm and update seats" }), null);
  assert.equal(screen.queryByRole("button", { name: "Review seat update" }), null,
    "the review button used to stay English under the old split; it must not now");

  await act(async () => {
    fireEvent.click(confirmButton);
  });

  await waitFor(() => assert.ok(screen.getByText("正在更新")));
  assert.ok(screen.getByRole("status", { name: "正在更新" }));
  assert.ok(screen.getByRole("button", { name: "操作进行中" }));

  await act(async () => {
    resolveUpdate?.({ data: { status: "updated" } });
  });
});

test("promotion code seat increase previews Stripe amounts and confirms with the signed preview token", async () => {
  seedManageSeatsPlan();

  const calls: Array<{ url: string; body: unknown }> = [];
  api.post = (async (url: string, body?: unknown) => {
    calls.push({ url, body });
    if (url === "/billing/seat-pack-quantity/preview") {
      return {
        data: {
          status: "preview",
          currentPackQuantity: 2,
          requestedPackQuantity: 3,
          currency: "usd",
          prorationAmount: 500,
          recurringAmount: 2_700,
          discountAmount: 300,
          promotion: {
            code: "SAVE10",
            name: "Seat launch",
            percentOff: 10,
            amountOff: null,
            currency: null,
          },
          previewToken: "signed-seat-preview-token",
          expiresAt: "2026-07-28T12:05:00.000Z",
        },
      };
    }
    if (url === "/billing/seat-pack-quantity") {
      return { data: { status: "pending_webhook", effectiveAt: "after_payment" } };
    }
    throw new Error(`unexpected POST ${url}`);
  }) as typeof api.post;

  render(<PlanSection />);

  const seatInput = screen.getByRole("textbox", { name: "Total seats" });
  fireEvent.change(seatInput, { target: { value: "3" } });
  fireEvent.blur(seatInput);
  const promotionInput = screen.getByRole("textbox", { name: "Promotion code (optional)" });
  fireEvent.change(promotionInput, { target: { value: " save10 " } });

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Review seat update" }));
  });

  await waitFor(() => assert.ok(screen.getByRole("heading", { name: "Confirm Seat Update" })));
  assert.deepEqual(calls[0], {
    url: "/billing/seat-pack-quantity/preview",
    body: {
      seatQuantity: 3,
      humanSeatQuantity: 3,
      agentSeatQuantity: 30,
      promotionCode: "save10",
    },
  });
  assert.ok(screen.getByText("Applied promotion: SAVE10"));
  assert.ok(screen.getByText("Estimated prorated charge: $5.00"));
  assert.ok(screen.getByText("Discount: -$3.00"));
  assert.ok(screen.getByText("Estimated next monthly total: $27.00"));
  assert.ok(screen.getByText("This Stripe estimate expires after 5 minutes. Reopen the review if it expires."));

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Confirm and update seats" }));
  });

  await waitFor(() => assert.equal(calls.length, 2));
  assert.deepEqual(calls[1], {
    url: "/billing/seat-pack-quantity",
    body: {
      seatQuantity: 3,
      humanSeatQuantity: 3,
      agentSeatQuantity: 30,
      previewToken: "signed-seat-preview-token",
    },
  });
});
