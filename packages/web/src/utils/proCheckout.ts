import type { IntlShape } from "react-intl";
import { PRO_AGENT_SEAT_BLOCK_SIZE } from "@botiverse/raft-shared";
import type { BillingEntry, BillingInterval, CheckoutOpenedFrom, GENERAL_UPGRADE_GATE, PaywallGate, PaywallSurface, PrepaidOffer, ProPrepaidMonths, ProductEventProperties } from "@botiverse/raft-shared";
import api from "../api/client";
import {
  flushProductEventsBeforeNavigation,
  getProductEventServerId,
  trackEvent,
} from "../analytics/track";

export type ProCheckoutEntry = ProductEventProperties<"checkout_started">["entry"];

/**
 * Create a Stripe Checkout session for Pro and return its URL. The caller sends the
 * browser there, so it can do its own last step first (the setup Pro step records its
 * answer). One seat is one human or PRO_AGENT_SEAT_BLOCK_SIZE agents. Throws the API
 * error unchanged; `checkout_started` is sent only once the session exists.
 *
 * The server records `billing_checkout_started` / `_completed` itself, with
 * `billingEntry` (the paywall that opened Plan & Billing) when given, else
 * `entry`. Each attempt gets a fresh `billingTraceId` that ties its billing
 * traces together; it never goes into product events.
 */
/**
 * `billingEntry` is finer than `entry` for the server's events: which paywall
 * led here. A paywall's upgrade dialog (`paywall_panel`) must name its paywall,
 * or `general` when it was opened for no specific limit (an agent's upgrade
 * card), so the server never records the bare `paywall_panel` (agreed with Till).
 */
type ProCheckoutEntryArgs =
  | { entry: Exclude<ProCheckoutEntry, "paywall_panel">; billingEntry?: BillingEntry }
  | { entry: "paywall_panel"; billingEntry: PaywallGate | typeof GENERAL_UPGRADE_GATE };

export async function startProCheckout({
  entry,
  billingInterval,
  seatQuantity,
  promotionCode,
  returnUrl,
  cancelUrl = returnUrl,
  serverId,
  billingEntry,
  defaultSeatQuantity,
  openedFrom,
  surface,
}: ProCheckoutEntryArgs & {
  billingInterval: BillingInterval;
  seatQuantity: number;
  promotionCode?: string;
  /** Where Stripe sends them back, paid (and cancelled, unless `cancelUrl` says otherwise). */
  returnUrl: string;
  /** Where Stripe sends them back when they cancel; defaults to `returnUrl`. */
  cancelUrl?: string;
  /** The server where checkout began; defaults to the current analytics server. */
  serverId?: string;
  /** The seat count the page proposed before any edit. */
  defaultSeatQuantity?: number;
  /** What opened the upgrade dialog, when not a paywall (`checkout_started.opened_from`). */
  openedFrom?: CheckoutOpenedFrom;
  /** The surface the paywall that opened the dialog was on (`checkout_started.surface`, and the server's events). */
  surface?: PaywallSurface;
}): Promise<string> {
  // Capture before the request: the active server can change while Stripe
  // Checkout is being created.
  const checkoutServerId = serverId ?? getProductEventServerId();
  const { data } = await api.post<{ url: string }>("/billing/checkout", {
    targetPlan: "pro",
    ...(promotionCode ? { promotionCode } : {}),
    billingInterval,
    seatQuantity,
    humanSeatQuantity: seatQuantity,
    agentSeatQuantity: seatQuantity * PRO_AGENT_SEAT_BLOCK_SIZE,
    successUrl: returnUrl,
    cancelUrl,
    billingTraceId: crypto.randomUUID(),
    entry: billingEntry ?? entry,
    ...(defaultSeatQuantity !== undefined ? { defaultSeatQuantity } : {}),
    ...(openedFrom ? { openedFrom } : {}),
    ...(surface ? { surface } : {}),
  }, checkoutServerId ? { headers: { "X-Server-Id": checkoutServerId } } : undefined);
  // Queued now; the tab flushes it with keepalive as it leaves for Stripe.
  trackEvent("checkout_started", {
    entry,
    billing_interval: billingInterval,
    seat_count: seatQuantity,
    has_promotion_code: Boolean(promotionCode),
    // Not `source`: that is the event's platform column.
    ...(openedFrom ? { opened_from: openedFrom } : {}),
    ...(surface ? { surface } : {}),
  }, { serverId: checkoutServerId });
  await flushProductEventsBeforeNavigation();
  return data.url;
}

/** GET /billing/prepaid/offer (owners and admins): prices from Stripe, the seat minimum, a renewal's start. */
export async function fetchPrepaidOffer(serverId: string): Promise<PrepaidOffer> {
  const { data } = await api.get<PrepaidOffer>("/billing/prepaid/offer", { headers: { "X-Server-Id": serverId } });
  return data;
}

/**
 * Create an Alipay Checkout for 1 or 12 months of Pro, paid once (task
 * #19), and return its URL. The server prices it from Stripe and records
 * `billing_prepaid_checkout_started`; there is no web checkout event for it.
 */
export async function startPrepaidCheckout({
  months,
  seatQuantity,
  returnUrl,
  cancelUrl = returnUrl,
  serverId,
  billingEntry,
  defaultSeatQuantity,
  openedFrom,
  surface,
}: {
  months: ProPrepaidMonths;
  seatQuantity: number;
  returnUrl: string;
  cancelUrl?: string;
  serverId: string;
  /** What the server's events name as the entry (the paywall, or what opened Plan & Billing). */
  billingEntry: BillingEntry | PaywallGate | typeof GENERAL_UPGRADE_GATE;
  defaultSeatQuantity?: number;
  openedFrom?: CheckoutOpenedFrom;
  /** The surface the paywall that opened the dialog was on, for the server's events. */
  surface?: PaywallSurface;
}): Promise<string> {
  const { data } = await api.post<{ url: string }>("/billing/prepaid/checkout", {
    months,
    seatQuantity,
    successUrl: returnUrl,
    cancelUrl,
    entry: billingEntry,
    ...(defaultSeatQuantity !== undefined ? { defaultSeatQuantity } : {}),
    ...(openedFrom ? { openedFrom } : {}),
    ...(surface ? { surface } : {}),
  }, { headers: { "X-Server-Id": serverId } });
  await flushProductEventsBeforeNavigation();
  return data.url;
}

/** The API's reason a checkout could not start, for display. */
export function checkoutErrorMessage(error: unknown, formatMessage: IntlShape["formatMessage"]): string | undefined {
  const data = (error as { response?: { data?: { code?: unknown; error?: unknown } } }).response?.data;
  if (data?.code === "checkout_outcome_unknown") return formatMessage({ id: "billing.checkoutOutcomeUnknown" });
  if (data?.code === "billing_source_check_busy") return formatMessage({ id: "billing.sourceCheckBusy" });
  if (data?.code === "PREPAID_OTHER_PAID_SOURCE") return formatMessage({ id: "prepaidPro.otherPaidSource" });
  if (data?.code === "PREPAID_ACTIVE") return formatMessage({ id: "prepaidPro.activeNoSubscription" });
  if (data?.code === "seat_quantity_below_usage") return formatMessage({ id: "prepaidPro.seatsBelowUsage" });
  // Seats added to prepaid time (task #19 PR4).
  if (data?.code === "in_grace") return formatMessage({ id: "prepaidSeats.endedError" });
  if (data?.code === "not_prepaid") return formatMessage({ id: "prepaidSeats.notPrepaidError" });
  return typeof data?.error === "string" ? data.error : undefined;
}
