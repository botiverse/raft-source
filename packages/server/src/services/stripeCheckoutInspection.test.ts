import assert from "node:assert/strict";
import type Stripe from "stripe";
import { inspectStripeCheckouts } from "./stripeCheckoutInspection";

function session(input: Record<string, unknown> = {}) {
  return { id: "cs_1", mode: "subscription", status: "open", payment_status: "unpaid",
    metadata: { serverId: "server-a" }, client_reference_id: "server-a", customer: null,
    subscription: null, ...input } as unknown as Stripe.Checkout.Session;
}
function provider(input: {
  pages: Array<{ data: Stripe.Checkout.Session[]; has_more: boolean }>;
  retrieved?: Record<string, Stripe.Checkout.Session>;
  subscriptionStatus?: string;
  subscriptionCustomer?: string | null;
  pendingUpdate?: object | null;
  invoiceStatuses?: string[];
  pendingItems?: string[];
  pendingFailure?: boolean;
}) {
  const cursors: Array<string | undefined> = [];
  const stripe = {
    checkout: { sessions: {
      list: async (params: { starting_after?: string }) => { cursors.push(params.starting_after); return input.pages[cursors.length - 1]; },
      retrieve: async (id: string) => input.retrieved?.[id],
    } },
    subscriptions: { retrieve: async (id: string) => ({ id, status: input.subscriptionStatus ?? "active", customer: input.subscriptionCustomer === undefined ? "cus_test" : input.subscriptionCustomer, pending_update: input.pendingUpdate ?? null }) },
    invoices: { list: async () => ({ data: (input.invoiceStatuses ?? []).map((status, index) => ({ id: `in_${index}`, status })), has_more: false }) },
    invoiceItems: { list: async () => { if (input.pendingFailure) throw new Error("forbidden"); return { data: (input.pendingItems ?? []).map(id => ({ id })), has_more: false }; } },
  } as unknown as Stripe;
  return { stripe, cursors };
}
const target = { serverId: "server-a", knownCustomerId: null, knownSubscriptionId: null, knownSessionIds: [] };

test("all pages are checked for untracked legacy and current checkout sessions", async () => {
  const fake = provider({ pages: [
    { data: [session({ id: "cs_other", metadata: { serverId: "other" }, client_reference_id: "other" })], has_more: true },
    { data: [session({ id: "cs_legacy", client_reference_id: null })], has_more: false },
  ] });
  assert.equal(await inspectStripeCheckouts({ ...target, stripe: fake.stripe }), "conflict");
  assert.deepEqual(fake.cursors, [undefined, "cs_other"]);
});

test("only expired unpaid or completed paid and canceled sessions are safe", async () => {
  const expired = session({ status: "expired", payment_status: "unpaid" });
  const paid = session({ id: "cs_paid", status: "complete", payment_status: "paid", subscription: "sub_1" });
  for (const [candidate, status, expected] of [
    [expired, "active", "safe"], [paid, "canceled", "safe"], [paid, "active", "conflict"],
    [session({ status: "complete", payment_status: "unpaid", subscription: "sub_1" }), "canceled", "conflict"],
    [session({ status: "expired", payment_status: "paid" }), "canceled", "conflict"],
  ] as const) {
    const fake = provider({ pages: [{ data: [candidate], has_more: false }], subscriptionStatus: status });
    assert.equal(await inspectStripeCheckouts({ ...target, stripe: fake.stripe }), expected);
  }
  const outstanding = provider({ pages: [{ data: [paid], has_more: false }], subscriptionStatus: "canceled", invoiceStatuses: ["open"] });
  assert.equal(await inspectStripeCheckouts({ ...target, stripe: outstanding.stripe }), "conflict", "canceled subscription can still have an unpaid invoice");
});

test("known sessions are retrieved even when the global list misses them", async () => {
  const known = session();
  const fake = provider({ pages: [{ data: [], has_more: false }], retrieved: { cs_1: known } });
  assert.equal(await inspectStripeCheckouts({ ...target, stripe: fake.stripe, knownSessionIds: ["cs_1"] }), "conflict");
});

test("incomplete, cyclic or conflicting provider evidence never passes", async () => {
  const missing = provider({ pages: [{ data: [], has_more: true }] });
  assert.equal(await inspectStripeCheckouts({ ...target, stripe: missing.stripe }), "unavailable");
  const repeated = provider({ pages: [
    { data: [session({ id: "cs_repeat", metadata: { serverId: "other" }, client_reference_id: "other" })], has_more: true },
    { data: [session({ id: "cs_repeat", status: "open" })], has_more: false },
  ] });
  assert.equal(await inspectStripeCheckouts({ ...target, stripe: repeated.stripe }), "unavailable");
  const wrong = provider({ pages: [{ data: [], has_more: false }], retrieved: { cs_1: session({ metadata: { serverId: "other" }, client_reference_id: "other" }) } });
  assert.equal(await inspectStripeCheckouts({ ...target, stripe: wrong.stripe, knownSessionIds: ["cs_1"] }), "unavailable");
  const broken = { checkout: { sessions: { list: async () => { throw new Error("provider unavailable"); } } } } as unknown as Stripe;
  assert.equal(await inspectStripeCheckouts({ ...target, stripe: broken }), "unavailable");
  const unattributed = provider({ pages: [{ data: [session({ metadata: {}, client_reference_id: null })], has_more: false }] });
  assert.equal(await inspectStripeCheckouts({ ...target, stripe: unattributed.stripe }), "unavailable");
  const paid = session({ id: "cs_paid", status: "complete", payment_status: "paid", subscription: "sub_1" });
  const incompleteInvoices = {
    checkout: { sessions: { list: async () => ({ data: [paid], has_more: false }) } },
    subscriptions: { retrieve: async (id: string) => ({ id, status: "canceled", customer: "cus_test", pending_update: null }) },
    invoices: { list: async () => ({ data: [{ id: "in_repeat", status: "paid" }], has_more: true }) },
    invoiceItems: { list: async () => ({ data: [], has_more: false }) },
  } as unknown as Stripe;
  assert.equal(await inspectStripeCheckouts({ ...target, stripe: incompleteInvoices }), "unavailable");
});

test("known subscriptions are checked even when no Checkout session is discoverable", async () => {
  const pages = [{ data: [], has_more: false }];
  const live = provider({ pages, subscriptionStatus: "active" });
  assert.equal(await inspectStripeCheckouts({ ...target, stripe: live.stripe, knownSubscriptionId: "sub_known", knownCustomerId: "cus_test" }), "conflict");
  const pending = provider({ pages, subscriptionStatus: "canceled", pendingUpdate: { expires_at: 1 } });
  assert.equal(await inspectStripeCheckouts({ ...target, stripe: pending.stripe, knownSubscriptionId: "sub_known", knownCustomerId: "cus_test" }), "conflict");
  const settled = provider({ pages, subscriptionStatus: "canceled", invoiceStatuses: ["paid"] });
  assert.equal(await inspectStripeCheckouts({ ...target, stripe: settled.stripe, knownSubscriptionId: "sub_known", knownCustomerId: "cus_test" }), "safe");
  const wrongCustomer = provider({ pages, subscriptionStatus: "canceled", subscriptionCustomer: "cus_other" });
  assert.equal(await inspectStripeCheckouts({ ...target, stripe: wrongCustomer.stripe, knownSubscriptionId: "sub_known", knownCustomerId: "cus_test" }), "unavailable");
});

test("pending invoice items block even when canceled subscription invoices are settled", async () => {
  const paid = session({ id: "cs_paid", status: "complete", payment_status: "paid", subscription: "sub_1", customer: "cus_test" });
  const fake = provider({ pages: [{ data: [paid], has_more: false }], subscriptionStatus: "canceled", invoiceStatuses: ["paid"], pendingItems: ["ii_pending"] });
  assert.equal(await inspectStripeCheckouts({ ...target, stripe: fake.stripe }), "conflict");
  const noSessions = provider({ pages: [{ data: [], has_more: false }], pendingItems: ["ii_pending"] });
  assert.equal(await inspectStripeCheckouts({ ...target, stripe: noSessions.stripe, knownCustomerId: "cus_test" }), "conflict");
  const denied = provider({ pages: [{ data: [paid], has_more: false }], subscriptionStatus: "canceled", pendingFailure: true });
  assert.equal(await inspectStripeCheckouts({ ...target, stripe: denied.stripe }), "unavailable");
  const missingCustomer = provider({ pages: [{ data: [paid], has_more: false }], subscriptionStatus: "canceled", subscriptionCustomer: null });
  assert.equal(await inspectStripeCheckouts({ ...target, stripe: missingCustomer.stripe }), "unavailable");
  const mismatchedCustomer = provider({ pages: [{ data: [paid], has_more: false }], subscriptionStatus: "canceled", subscriptionCustomer: "cus_other" });
  assert.equal(await inspectStripeCheckouts({ ...target, stripe: mismatchedCustomer.stripe }), "unavailable");
});

test("known customer invoices are checked even when no Checkout session is discoverable", async () => {
  const cursors: Array<string | undefined> = [];
  const fake = {
    checkout: { sessions: { list: async () => ({ data: [], has_more: false }) } },
    invoiceItems: { list: async () => ({ data: [], has_more: false }) },
    invoices: { list: async (params: { customer?: string; starting_after?: string }) => {
      assert.equal(params.customer, "cus_test");
      cursors.push(params.starting_after);
      return cursors.length === 1 ? { data: [{ id: "in_paid", status: "paid" }], has_more: true }
        : { data: [{ id: "in_open", status: "open" }], has_more: false };
    } },
  } as unknown as Stripe;
  assert.equal(await inspectStripeCheckouts({ ...target, stripe: fake, knownCustomerId: "cus_test" }), "conflict");
  assert.deepEqual(cursors, [undefined, "in_paid"]);
  const denied = { ...fake, invoices: { list: async () => { throw new Error("forbidden"); } } } as unknown as Stripe;
  assert.equal(await inspectStripeCheckouts({ ...target, stripe: denied, knownCustomerId: "cus_test" }), "unavailable");
});

test("a prepaid Pro Checkout is safe when expired unpaid or once the webhook recorded it paid; open or unrecorded holds the Server", async () => {
  const prepaid = (input: Record<string, unknown>) => session({ id: "cs_prepaid", mode: "payment", metadata: { serverId: "server-a", pricingContract: "raft-pro-prepaid-v1" }, ...input });
  const recorded = new Set(["cs_prepaid"]);
  for (const [candidate, recordedPrepaidSessions, expected] of [
    [prepaid({ status: "expired", payment_status: "unpaid" }), undefined, "safe"],
    [prepaid({ status: "complete", payment_status: "paid" }), recorded, "safe"],
    [prepaid({ status: "complete", payment_status: "paid" }), undefined, "conflict"],
    [prepaid({ status: "open", payment_status: "unpaid" }), recorded, "conflict"],
    [session({ id: "cs_other_payment", mode: "payment", status: "complete", payment_status: "paid" }), recorded, "conflict"],
  ] as const) {
    const fake = provider({ pages: [{ data: [candidate], has_more: false }] });
    assert.equal(await inspectStripeCheckouts({ ...target, stripe: fake.stripe, recordedPrepaidSessions }), expected);
  }
});
