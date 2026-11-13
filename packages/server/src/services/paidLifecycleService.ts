import { randomUUID } from "node:crypto";
import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { getDb, type DatabaseExecutor } from "../db/index";
import {
  paidLifecycleJourneys as journeys,
  paidLifecyclePayments as payments,
  paidLifecycleReceipts as receipts,
  serverMembers,
  servers,
  subscriptions,
  users,
} from "../db/schema";
import {
  paidCashEvidence,
  paidJourneyId,
  paidReceiptMarker,
  paidReceiptMarkerFromHtml,
  type PaidCashEvidence,
} from "./paidLifecycleContracts";
import { getActiveAppSumoGrants } from "./appSumoLicenseService";

export type PaidPaymentProjection = {
  cash: PaidCashEvidence;
  paidUntil: Date;
  canStartJourney: boolean;
  recipientUserId: string | null;
};
const RESEND_UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function providerId(value: string | { id: string } | null | undefined) {
  return typeof value === "string" ? value : value?.id;
}
export function paidLifecycleEnabled() {
  return (
    process.env.PAID_LIFECYCLE_EMAIL_MODE === "enabled" &&
    Boolean(process.env.RESEND_API_KEY) &&
    Boolean(
      process.env.PAID_LIFECYCLE_RECEIPT_MARKER_SECRET &&
        Buffer.byteLength(process.env.PAID_LIFECYCLE_RECEIPT_MARKER_SECRET) >=
          32,
    ) &&
    Number.isFinite(Date.parse(process.env.PAID_LIFECYCLE_START_AT ?? ""))
  );
}

async function invoiceCash(
  stripe: Stripe,
  invoice: Stripe.Invoice,
): Promise<PaidCashEvidence | null> {
  for await (const allocation of stripe.invoicePayments.list({
    invoice: invoice.id,
    status: "paid",
    limit: 100,
  })) {
    let chargeId: string | undefined;
    if (allocation.payment.type === "charge")
      chargeId = providerId(allocation.payment.charge);
    else if (allocation.payment.type === "payment_intent") {
      const intentId = providerId(allocation.payment.payment_intent);
      if (intentId) {
        const intent = await stripe.paymentIntents.retrieve(intentId);
        if (intent.status === "succeeded")
          chargeId = providerId(intent.latest_charge);
      }
    }
    if (!chargeId) continue;
    const evidence = paidCashEvidence(
      invoice,
      allocation,
      await stripe.charges.retrieve(chargeId),
    );
    if (evidence) return evidence;
  }
  return null;
}

async function invoiceFunding(
  stripe: Stripe,
  invoice: Stripe.Invoice,
  subscriptionId: string,
) {
  const cash = await invoiceCash(stripe, invoice);
  if (!cash) return null;
  let billedUntil = 0;
  for await (const line of stripe.invoices.listLineItems(invoice.id, {
    limit: 100,
  })) {
    const bound =
      providerId(line.subscription) ??
      line.parent?.subscription_item_details?.subscription;
    if (
      bound === subscriptionId &&
      line.amount > 0 &&
      Number.isSafeInteger(line.period.end) &&
      line.period.end > line.period.start
    )
      billedUntil = Math.max(billedUntil, line.period.end);
  }
  return billedUntil ? { cash, paidUntil: new Date(billedUntil * 1000) } : null;
}

// Admit a qualifying payment after rollout, including a historical customer's
// renewal. Do not inspect or backfill payment history: the durable User journey
// defines "first" for this campaign and dedupes subsequent payments/Servers.
export async function verifyPaidLifecyclePayment(
  stripe: Stripe,
  invoice: Stripe.Invoice,
  subscription: Stripe.Subscription,
): Promise<PaidPaymentProjection | null> {
  if (
    !paidLifecycleEnabled() ||
    invoice.created * 1000 < Date.parse(process.env.PAID_LIFECYCLE_START_AT!)
  )
    return null;
  const funding = await invoiceFunding(stripe, invoice, subscription.id);
  if (!funding) return null;
  // Verify that the qualifying invoice actually billed this subscription.
  // This evidence is for enrollment, never current subscription counts.
  const payer = subscription.metadata?.userId;
  const serverId = subscription.metadata?.serverId;
  const owners =
    serverId && RESEND_UUID.test(serverId)
      ? await getDb()
          .select({ id: serverMembers.userId })
          .from(serverMembers)
          .where(
            and(
              eq(serverMembers.serverId, serverId),
              eq(serverMembers.role, "owner"),
            ),
          )
      : [];
  const recipientUserId =
    owners.length === 1
      ? owners[0].id
      : (owners.find((owner) => owner.id === payer)?.id ?? null);
  const result = { ...funding, canStartJourney: false, recipientUserId };
  if (!recipientUserId) return result;
  const [existingJourney] = await getDb()
    .select({ id: journeys.id })
    .from(journeys)
    .where(eq(journeys.userId, recipientUserId));
  return { ...result, canStartJourney: !existingJourney };
}

// Called inside the SAME projection transaction, after subscription/server
// writes. No network call inside this transaction. No historical enrollment.
export async function recordPaidLifecycleProjection(
  tx: DatabaseExecutor,
  input: {
    serverId: string;
    payerUserId: string | null;
    stripeSubscriptionId: string;
    paidUntil: Date | null;
    payment?: PaidPaymentProjection | null;
  },
) {
  if (!input.payment || !input.paidUntil) return;
  const { cash, canStartJourney, recipientUserId } = input.payment;
  const [inserted] = await tx
    .insert(payments)
    .values({
      invoiceId: cash.invoiceId,
      serverId: input.serverId,
      payerUserId: input.payerUserId,
      stripeSubscriptionId: input.stripeSubscriptionId,
      paymentId: cash.paymentId,
      chargeId: cash.chargeId,
      amount: cash.amount,
      paidAt: cash.paidAt,
    })
    .onConflictDoNothing()
    .returning({ id: payments.invoiceId });
  if (!inserted) {
    const [old] = await tx
      .select()
      .from(payments)
      .where(eq(payments.invoiceId, cash.invoiceId));
    if (
      !old ||
      old.serverId !== input.serverId ||
      old.payerUserId !== input.payerUserId ||
      old.stripeSubscriptionId !== input.stripeSubscriptionId ||
      old.chargeId !== cash.chargeId ||
      old.paymentId !== cash.paymentId ||
      old.amount !== cash.amount ||
      old.paidAt.getTime() !== cash.paidAt.getTime()
    )
      throw new Error("PAID_INVOICE_BINDING_CONFLICT");
    return; // Old cash must not enroll a newly transferred owner.
  }
  if (!canStartJourney) return;
  const owners = await tx
    .select({ id: serverMembers.userId })
    .from(serverMembers)
    .where(
      and(
        eq(serverMembers.serverId, input.serverId),
        eq(serverMembers.role, "owner"),
      ),
    );
  const recipient =
    owners.length === 1
      ? owners[0].id
      : owners.find((owner) => owner.id === input.payerUserId)?.id;
  if (!recipient || recipient !== recipientUserId) return; // Never guess a payer or use a stale ownership decision.
  await tx
    .insert(journeys)
    .values({ userId: recipient, firstPaidAt: cash.paidAt })
    .onConflictDoNothing();
}

async function paidServers(userId: string, db: DatabaseExecutor, now: Date) {
  const candidates = await db
    .select({
      serverId: servers.id,
      periodEnd: subscriptions.currentPeriodEnd,
    })
    .from(servers)
    .innerJoin(subscriptions, eq(subscriptions.serverId, servers.id))
    .leftJoin(
      serverMembers,
      and(
        eq(serverMembers.serverId, servers.id),
        eq(serverMembers.userId, userId),
      ),
    )
    .where(
      and(
        isNull(servers.deletedAt),
        eq(servers.plan, "pro"),
        eq(subscriptions.status, "active"),
        gt(subscriptions.currentPeriodEnd, now),
        or(
          eq(serverMembers.role, "owner"),
          eq(subscriptions.createdByUserId, userId),
        ),
      ),
    );
  // Current source, not purchase history: a valid lifetime grant takes
  // precedence over a coexisting Stripe projection. Once that grant ends, a
  // qualifying subscription can participate again; never blacklist the User.
  const lifetime = await getActiveAppSumoGrants(
    db,
    candidates.map(row => row.serverId),
  );
  return candidates.filter(row => !lifetime.has(row.serverId));
}

export async function paidServerCount(
  userId: string,
  db: DatabaseExecutor = getDb(),
  now = new Date(),
): Promise<number> {
  return new Set(
    (await paidServers(userId, db, now)).map((row) => row.serverId),
  ).size;
}

type ProviderContact = { id?: string; email?: string; unsubscribed?: boolean };
type ProviderEmail = { id?: string; html?: string | null };
async function responseJson(
  response: Response,
  limit = 1_048_576,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("PAID_PROVIDER_RESPONSE");
  const read = async () => {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > limit) throw new Error("PAID_PROVIDER_RESPONSE");
      chunks.push(item.value);
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    ) as unknown;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("PAID_PROVIDER_DEADLINE")),
          10_000,
        );
      }),
    ]);
  } catch {
    throw new Error("PAID_PROVIDER_RESPONSE_INVALID");
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
}
async function providerRequest<T>(
  path: string,
  method = "GET",
  body?: object,
): Promise<T> {
  const response = await fetch(`https://api.resend.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`PAID_PROVIDER_HTTP_${response.status}`);
  // Never persist/log provider bodies, recipient addresses, signatures or keys.
  return (await responseJson(response)) as T;
}

async function contactFor(email: string) {
  try {
    return await providerRequest<ProviderContact>(
      `/contacts/${encodeURIComponent(email)}`,
    );
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "PAID_PROVIDER_HTTP_404")
      throw error;
    // Omit unsubscribed/topics completely. Existing opt-outs are never reset.
    return providerRequest<ProviderContact>("/contacts", "POST", { email });
  }
}

export async function syncPaidLifecycleUser(userId: string): Promise<void> {
  if (!paidLifecycleEnabled()) return;
  const db = getDb(),
    token = randomUUID(),
    now = new Date();
  const [job] = await db
    .update(journeys)
    .set({ leaseToken: token, leaseUntil: new Date(now.getTime() + 60_000) })
    .where(
      and(
        eq(journeys.userId, userId),
        eq(journeys.needsSync, true),
        or(isNull(journeys.leaseUntil), lt(journeys.leaseUntil, now)),
      ),
    )
    .returning();
  if (!job) return;
  const keepLease = async () => {
    const time = new Date();
    const [owned] = await db
      .update(journeys)
      .set({ leaseUntil: new Date(time.getTime() + 60_000) })
      .where(
        and(
          eq(journeys.userId, userId),
          eq(journeys.leaseToken, token),
          gt(journeys.leaseUntil, time),
          eq(journeys.revision, job.revision),
        ),
      )
      .returning({ id: journeys.id });
    return Boolean(owned);
  };
  try {
    const [user] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId));
    if (!user) return;
    if (!(await keepLease())) return;
    const active = await paidServers(userId, db, now),
      count = new Set(active.map((row) => row.serverId)).size;
    let contactId = job.contactId;
    if (contactId && job.contactEmail !== user.email) {
      // Stop the original Contact's delayed follow-up on address changes. Do
      // not enroll a replacement Contact or send a second welcome for this User.
      await providerRequest(
        `/contacts/${encodeURIComponent(contactId)}`,
        "PATCH",
        { properties: { paid_server_count: 0 } },
      );
    } else {
      if (!contactId) {
        const contact = await contactFor(user.email);
        if (!(await keepLease())) return;
        if (!contact.id || !RESEND_UUID.test(contact.id))
          throw new Error("PAID_CONTACT_INVALID");
        const [collision] = await db
          .select({ userId: journeys.userId })
          .from(journeys)
          .where(eq(journeys.contactId, contact.id));
        if (collision && collision.userId !== userId)
          throw new Error("PAID_CONTACT_COLLISION");
        contactId = contact.id;
        await db
          .update(journeys)
          .set({ contactId, contactEmail: user.email })
          .where(
            and(eq(journeys.userId, userId), eq(journeys.leaseToken, token)),
          );
      }
      if (!(await keepLease())) return;
      await providerRequest(
        `/contacts/${encodeURIComponent(contactId)}`,
        "PATCH",
        { properties: { paid_server_count: count } },
      );
      if (job.triggerState === "pending" && count > 0) {
        const [claimed] = await db
          .update(journeys)
          .set({ triggerState: "attempted" })
          .where(
            and(
              eq(journeys.userId, userId),
              eq(journeys.leaseToken, token),
              eq(journeys.revision, job.revision),
              eq(journeys.triggerState, "pending"),
            ),
          )
          .returning({ id: journeys.id });
        if (claimed) {
          // Persist attempted BEFORE the external call. An ambiguous response or
          // crash never causes an automatic duplicate event retry.
          try {
            await providerRequest("/events/send", "POST", {
              event: "raft.first_paid",
              contact_id: contactId,
              payload: {
                welcome_receipt: paidReceiptMarker(
                  process.env.PAID_LIFECYCLE_RECEIPT_MARKER_SECRET!,
                  paidJourneyId(job.id),
                  "welcome",
                ),
                checkin_receipt: paidReceiptMarker(
                  process.env.PAID_LIFECYCLE_RECEIPT_MARKER_SECRET!,
                  paidJourneyId(job.id),
                  "checkin",
                ),
              },
            });
            await db
              .update(journeys)
              .set({ triggerState: "accepted" })
              .where(
                and(
                  eq(journeys.userId, userId),
                  eq(journeys.leaseToken, token),
                ),
              );
          } catch {
            await db
              .update(journeys)
              .set({ triggerState: "unknown" })
              .where(
                and(
                  eq(journeys.userId, userId),
                  eq(journeys.leaseToken, token),
                ),
              );
            throw new Error("PAID_TRIGGER_UNKNOWN");
          }
        }
      }
    }
    await db
      .update(journeys)
      .set({ needsSync: false })
      .where(
        and(
          eq(journeys.userId, userId),
          eq(journeys.leaseToken, token),
          eq(journeys.revision, job.revision),
        ),
      );
  } finally {
    await db
      .update(journeys)
      .set({ leaseToken: null, leaseUntil: null })
      .where(and(eq(journeys.userId, userId), eq(journeys.leaseToken, token)));
  }
}

// Caller invokes this only AFTER the existing Resend signature verifier. The
// provider email ID is fetched directly; one authentic registered marker binds
// journey/step, and the durable journey supplies User identity.
export async function recordVerifiedPaidDispatch(event: {
  type?: string;
  created_at?: string;
  data?: { email_id?: string };
}): Promise<void> {
  if (!paidLifecycleEnabled() || event.type !== "email.sent") return;
  const emailId = event.data?.email_id,
    sentAt = new Date(event.created_at ?? "");
  if (
    !emailId ||
    !RESEND_UUID.test(emailId) ||
    !Number.isFinite(sentAt.getTime())
  )
    return;
  const email = await providerRequest<ProviderEmail>(`/emails/${emailId}`);
  if (email.id !== emailId) throw new Error("PAID_EMAIL_RESPONSE_INVALID");
  // Resend explicitly returns null HTML for legitimate plain-text emails.
  // They carry no paid marker and must continue the existing newsletter path.
  if (email.html === null) return;
  if (typeof email.html !== "string")
    throw new Error("PAID_EMAIL_RESPONSE_INVALID");
  const marker = paidReceiptMarkerFromHtml(
    process.env.PAID_LIFECYCLE_RECEIPT_MARKER_SECRET!,
    email.html,
  );
  if (!marker) return; // Other newsletter/transactional messages are not ours.
  const db = getDb();
  const [journey] = await db
    .select({
      id: journeys.id,
      firstPaidAt: journeys.firstPaidAt,
      state: journeys.triggerState,
    })
    .from(journeys)
    .where(eq(journeys.id, marker.journeyId));
  if (!journey) throw new Error("PAID_RECEIPT_JOURNEY_UNKNOWN");
  if (!["attempted", "accepted", "unknown"].includes(journey.state))
    throw new Error("PAID_RECEIPT_NOT_STARTED");
  if (sentAt < journey.firstPaidAt || sentAt.getTime() > Date.now() + 300_000)
    throw new Error("PAID_RECEIPT_TIME_INVALID");
  await db
    .insert(receipts)
    .values({ emailId, journeyId: journey.id, kind: marker.kind, sentAt })
    .onConflictDoNothing();
  const [stored] = await db
    .select()
    .from(receipts)
    .where(eq(receipts.emailId, emailId));
  if (
    !stored ||
    stored.journeyId !== journey.id ||
    stored.kind !== marker.kind ||
    stored.sentAt.getTime() !== sentAt.getTime()
  )
    throw new Error("PAID_RECEIPT_CONFLICT");
  await syncPaidLifecycleReceipts();
}

// Route has authenticated raw Svix bytes first. Strict decoding avoids using a
// replacement-character normalization as a second, different signed payload.
export async function handlePaidLifecycleWebhookPayload(
  raw: Buffer,
): Promise<void> {
  if (!paidLifecycleEnabled()) return;
  if (raw.byteLength > 1_048_576) throw new Error("PAID_WEBHOOK_BODY_INVALID");
  const value: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(raw),
  );
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("PAID_WEBHOOK_BODY_INVALID");
  const event = value as {
    type?: string;
    created_at?: string;
    data?: { email_id?: string };
  };
  if (
    typeof event.type !== "string" ||
    (event.created_at !== undefined && typeof event.created_at !== "string") ||
    (event.data?.email_id !== undefined &&
      typeof event.data.email_id !== "string")
  )
    throw new Error("PAID_WEBHOOK_BODY_INVALID");
  await recordVerifiedPaidDispatch(event);
}

export async function syncPaidLifecycleReceipts(): Promise<void> {
  if (
    !paidLifecycleEnabled() ||
    !process.env.OPSHUB_PAID_EMAIL_RECEIPT_URL ||
    !process.env.OPSHUB_PAID_EMAIL_RECEIPT_SECRET ||
    Buffer.byteLength(process.env.OPSHUB_PAID_EMAIL_RECEIPT_SECRET) < 32
  )
    return;
  const url = new URL(process.env.OPSHUB_PAID_EMAIL_RECEIPT_URL);
  if (
    url.origin !== "https://slock-internal-ops-hub.botiverse.dev" ||
    url.pathname !== "/api/services/paid-email-receipts" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error("PAID_RECEIPT_URL_INVALID");
  const db = getDb();
  const pending = await db
    .select({
      emailId: receipts.emailId,
      userId: journeys.userId,
      kind: receipts.kind,
      sentAt: receipts.sentAt,
    })
    .from(receipts)
    .innerJoin(journeys, eq(journeys.id, receipts.journeyId))
    .where(eq(receipts.needsSync, true))
    .limit(50);
  const { createHmac } = await import("node:crypto");
  for (const row of pending) {
    const body = JSON.stringify({
        version: 1,
        emailId: row.emailId,
        userId: row.userId,
        kind: row.kind,
        sentAt: row.sentAt.toISOString(),
      }),
      timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac(
      "sha256",
      process.env.OPSHUB_PAID_EMAIL_RECEIPT_SECRET,
    )
      .update(
        `paid-email-receipt-v1\nPOST\n/api/services/paid-email-receipts\n${timestamp}\n${body}`,
      )
      .digest("hex");
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-receipt-timestamp": timestamp,
        "x-receipt-signature": signature,
      },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    // A 2xx proxy/error page is not the sink's recording acknowledgment.
    if (
      response.ok &&
      response.headers.get("content-type")?.includes("application/json")
    ) {
      const acknowledgment = (await responseJson(response, 1024)) as {
        ok?: unknown;
        code?: unknown;
      };
      if (
        acknowledgment.ok === true &&
        acknowledgment.code === "RECEIPT_RECORDED"
      )
        await db
          .update(receipts)
          .set({ needsSync: false })
          .where(eq(receipts.emailId, row.emailId));
    }
  }
}

export async function syncPaidLifecycleForServer(
  serverId: string,
): Promise<void> {
  if (!paidLifecycleEnabled()) return;
  const related = await getDb()
    .select({ id: journeys.userId })
    .from(journeys)
    .leftJoin(
      serverMembers,
      and(
        eq(serverMembers.userId, journeys.userId),
        eq(serverMembers.serverId, serverId),
      ),
    )
    .leftJoin(subscriptions, eq(subscriptions.serverId, serverId))
    .where(
      or(
        eq(serverMembers.role, "owner"),
        eq(subscriptions.createdByUserId, journeys.userId),
      ),
    );
  for (const id of new Set(related.map((row) => row.id))) {
    try {
      await syncPaidLifecycleUser(id);
    } catch {
      // Best effort for this business event only. No scheduled retry; a later
      // eligible business event may make another attempt for this User.
    }
  }
}
