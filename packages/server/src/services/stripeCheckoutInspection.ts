import type Stripe from "stripe";
import { isPrepaidCheckoutSession } from "./prepaidProContracts";

export type StripeCheckoutSafety = "safe" | "conflict" | "unavailable";
const MAX_CHECKOUT_PAGES = 500;
const REQUEST_OPTIONS = { timeout: 10_000, maxNetworkRetries: 0 } as const;
const SCAN_BUDGET_MS = 90_000;

function objectId(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (value && typeof value === "object" && "id" in value && typeof value.id === "string" && value.id.trim()) return value.id;
  return null;
}

/**
 * Stripe has no server-ID filter for Checkout sessions. Check every page,
 * including historical sessions, and separately retrieve known sessions so a
 * newly-created session missing from a list index cannot be overlooked.
 * Incomplete or malformed provider evidence never means "no checkout".
 */
export async function inspectStripeCheckouts(input: {
  stripe: Stripe;
  serverId: string;
  knownCustomerId: string | null;
  knownSubscriptionId: string | null;
  knownSessionIds: readonly string[];
  /** Prepaid Pro Checkouts already recorded in prepaid_pro_purchases (task #19). */
  recordedPrepaidSessions?: ReadonlySet<string>;
}): Promise<StripeCheckoutSafety> {
  const checked = new Set<string>();
  const listed = new Set<string>();
  const deadline = performance.now() + SCAN_BUDGET_MS;
  const checkBudget = () => { if (performance.now() >= deadline) throw new Error("Stripe inspection exceeded its budget"); };
  const canceled = new Map<string, boolean>();
  const clearedInvoices = new Map<string, boolean>();
  const subscriptionCustomers = new Map<string, string>();
  const clearCustomers = new Set<string>();
  // Older subscriptions need not have a discoverable Checkout session. Check
  // all invoices and unbilled items for every known customer, conservatively
  // holding even an item whose original subscription cannot be determined.
  const customerIsClear = async (customer: string): Promise<boolean> => {
    if (clearCustomers.has(customer)) return true;
    checkBudget();
    const result = await input.stripe.invoiceItems.list({ customer, pending: true, limit: 1 }, REQUEST_OPTIONS);
    checkBudget();
    if (!result || !Array.isArray(result.data) || typeof result.has_more !== "boolean"
      || (!result.data.length && result.has_more)) throw new Error("Invalid pending invoice-item scan");
    if (result.data.length) {
      if (result.data.some(item => !item || typeof item.id !== "string" || !item.id.trim())) throw new Error("Invalid pending invoice item");
      return false;
    }
    let cursor: string | undefined;
    const seen = new Set<string>();
    let complete = false;
    for (let page = 0; page < MAX_CHECKOUT_PAGES; page += 1) {
      checkBudget();
      const invoices = await input.stripe.invoices.list({ customer, limit: 100,
        ...(cursor ? { starting_after: cursor } : {}) }, REQUEST_OPTIONS);
      checkBudget();
      if (!invoices || !Array.isArray(invoices.data) || typeof invoices.has_more !== "boolean") throw new Error("Invalid customer invoice scan");
      for (const invoice of invoices.data) {
        if (!invoice || typeof invoice.id !== "string" || !invoice.id.trim() || seen.has(invoice.id)) throw new Error("Invalid customer invoice page");
        seen.add(invoice.id);
        if (invoice.status !== "paid" && invoice.status !== "void") return false;
      }
      if (!invoices.has_more) { complete = true; break; }
      const last = invoices.data.at(-1)?.id;
      if (!last || last === cursor) throw new Error("Invalid customer invoice pagination");
      cursor = last;
    }
    if (!complete) throw new Error("Incomplete customer invoice scan");
    clearCustomers.add(customer);
    return true;
  };
  const matches = (session: Stripe.Checkout.Session) => {
    const metadataServer = session.metadata?.serverId;
    const reference = session.client_reference_id;
    const customer = objectId(session.customer);
    return metadataServer === input.serverId || reference === input.serverId
      || (!!input.knownCustomerId && customer === input.knownCustomerId);
  };
  const unattributed = (session: Stripe.Checkout.Session) => {
    const metadataServer = session.metadata?.serverId;
    const reference = session.client_reference_id;
    return !(typeof metadataServer === "string" && metadataServer.trim())
      && !(typeof reference === "string" && reference.trim());
  };
  const subscriptionIsClear = async (subscriptionId: string, expectedCustomer: string | null): Promise<boolean> => {
    if (!canceled.has(subscriptionId)) {
      checkBudget();
      const subscription = await input.stripe.subscriptions.retrieve(subscriptionId, {}, REQUEST_OPTIONS);
      checkBudget();
      if (!subscription || subscription.id !== subscriptionId || subscription.pending_update === undefined) throw new Error("Invalid subscription evidence");
      canceled.set(subscriptionId, subscription.status === "canceled" && subscription.pending_update === null);
      const customer = objectId(subscription.customer);
      if (customer) subscriptionCustomers.set(subscriptionId, customer);
    }
    if (canceled.get(subscriptionId) !== true) return false;
    const customer = subscriptionCustomers.get(subscriptionId);
    if (!customer || (expectedCustomer && expectedCustomer !== customer)) throw new Error("Subscription customer could not be verified");
    if (!await customerIsClear(customer)) return false;
    // Cancellation alone does not settle finalized invoices. An open, draft,
    // uncollectible or otherwise unknown invoice could still be paid later.
    if (!clearedInvoices.has(subscriptionId)) {
      let cursor: string | undefined;
      let complete = false;
      for (let page = 0; page < MAX_CHECKOUT_PAGES; page += 1) {
        checkBudget();
        const invoices = await input.stripe.invoices.list({ subscription: subscriptionId, limit: 100,
          ...(cursor ? { starting_after: cursor } : {}) }, REQUEST_OPTIONS);
        checkBudget();
        if (!invoices || !Array.isArray(invoices.data) || typeof invoices.has_more !== "boolean") throw new Error("Invalid invoice scan");
        if (invoices.data.some(invoice => !invoice || typeof invoice.id !== "string" || !invoice.id.trim()
          || (invoice.status !== "paid" && invoice.status !== "void"))) return false;
        if (!invoices.has_more) { complete = true; break; }
        const last = invoices.data.at(-1)?.id;
        if (!last || last === cursor) throw new Error("Invalid invoice pagination");
        cursor = last;
      }
      if (!complete) throw new Error("Incomplete invoice scan");
      clearedInvoices.set(subscriptionId, true);
    }
    return true;
  };
  const safeSession = async (session: Stripe.Checkout.Session): Promise<boolean> => {
    // Prepaid Pro (paid once): unpaid and expired is harmless; paid is safe once
    // the webhook recorded it, because its grant or refund lives in Raft's
    // table. Paid and not yet recorded still holds the Server.
    if (isPrepaidCheckoutSession(session)) {
      if (session.status === "expired" && session.payment_status === "unpaid") return true;
      return session.status === "complete" && session.payment_status === "paid" && Boolean(input.recordedPrepaidSessions?.has(session.id));
    }
    if (session.mode !== "subscription") return false;
    if (session.status === "expired" && session.payment_status === "unpaid") {
      const customer = objectId(session.customer);
      return !customer || await customerIsClear(customer);
    }
    if (session.status !== "complete" || (session.payment_status !== "paid" && session.payment_status !== "no_payment_required")) return false;
    const subscriptionId = objectId(session.subscription);
    if (!subscriptionId) return false;
    return subscriptionIsClear(subscriptionId, objectId(session.customer));
  };
  try {
    if (input.knownCustomerId && !await customerIsClear(input.knownCustomerId)) return "conflict";
    if (input.knownSubscriptionId && !await subscriptionIsClear(input.knownSubscriptionId, input.knownCustomerId)) return "conflict";
    for (const id of new Set(input.knownSessionIds)) {
      if (!id || id.length > 255) return "unavailable";
      checkBudget();
      const session = await input.stripe.checkout.sessions.retrieve(id, {}, REQUEST_OPTIONS);
      checkBudget();
      if (session.id !== id || !matches(session)) return "unavailable";
      if (!await safeSession(session)) return "conflict";
      checked.add(id);
    }
    let cursor: string | undefined;
    for (let page = 0; page < MAX_CHECKOUT_PAGES; page += 1) {
      checkBudget();
      const result = await input.stripe.checkout.sessions.list({ limit: 100, ...(cursor ? { starting_after: cursor } : {}) }, REQUEST_OPTIONS);
      checkBudget();
      if (!result || !Array.isArray(result.data) || typeof result.has_more !== "boolean") return "unavailable";
      for (const session of result.data) {
        if (!session || typeof session.id !== "string" || !session.id.trim()) return "unavailable";
        if (listed.has(session.id)) return "unavailable";
        listed.add(session.id);
        if (!checked.has(session.id)) {
          if (matches(session) && !await safeSession(session)) return "conflict";
          // A legacy checkout without either source identifier cannot be
          // assigned safely. A terminal one is harmless; an unsettled one
          // makes the scan incomplete rather than proving this server clear.
          if (!matches(session) && unattributed(session) && !await safeSession(session)) return "unavailable";
        }
        checked.add(session.id);
      }
      if (!result.has_more) return "safe";
      const last = result.data.at(-1)?.id;
      if (!last || last === cursor) return "unavailable";
      cursor = last;
    }
    return "unavailable";
  } catch {
    return "unavailable";
  }
}
