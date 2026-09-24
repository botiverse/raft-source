import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import type { DatabaseExecutor } from "../db/index.js";
import { newsletterAudienceContacts, newsletterWebhookEvents, users } from "../db/schema.js";
import { suppressScheduledComputerMobileAppEmailJourneys } from "./computerMobileAppEmailJourneyService.js";
import { normalizeEmail } from "./emailNormalization.js";

type NewsletterStatus = "synced" | "sync_failed" | "unsubscribed" | "bounced" | "complained";
type OptOutStatus = Extract<NewsletterStatus, "unsubscribed" | "bounced" | "complained">;

const OPT_OUT_STATUSES: OptOutStatus[] = ["unsubscribed", "bounced", "complained"];
const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_RESEND_MIN_INTERVAL_MS = 550;
const DEFAULT_RESEND_MAX_RETRIES = 3;
const DEFAULT_RESEND_RETRY_BASE_MS = 1000;

type NewsletterUser = {
  id: string;
  email: string;
  name: string;
  displayName?: string | null;
};

type ContactSyncInput = {
  segmentId: string;
  email: string;
  firstName?: string;
  unsubscribed: boolean;
};

type ContactCreateResult = {
  id: string | null;
};

type ContactSyncOptions = {
  rateLimited?: boolean;
};

type NewsletterContactClient = {
  syncContact(input: ContactSyncInput, options?: ContactSyncOptions): Promise<ContactCreateResult>;
};

type SignupSyncResult =
  | { status: "skipped"; reason: "not_configured" | "opted_out" }
  | { status: "synced"; contactId: string | null }
  | { status: "failed"; error: string };

type SignupSyncOptions = {
  rateLimited?: boolean;
};

type BackfillOptions = {
  dryRun?: boolean;
  batchSize?: number;
  limit?: number | null;
};

type BackfillResult = {
  dryRun: boolean;
  scanned: number;
  synced: number;
  failed: number;
  skipped: number;
  sample: Array<{ id: string; email: string }>;
};

type ResendWebhookHeaders = {
  id?: string | string[];
  timestamp?: string | string[];
  signature?: string | string[];
};

type ResendWebhookEvent = {
  type?: string;
  data?: unknown;
};

let testContactClient: NewsletterContactClient | null = null;
let testConfig: {
  apiKey?: string;
  segmentId?: string;
  audienceId?: string;
  webhookSecret?: string;
  resendMinIntervalMs?: number;
  resendMaxRetries?: number;
  resendRetryBaseMs?: number;
} | null = null;
let resendRateLimitQueue: Promise<void> = Promise.resolve();
let lastResendRequestAt = 0;

function getSingleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function getNewsletterConfig() {
  const legacyAudienceId = process.env.RESEND_NEWSLETTER_AUDIENCE_ID ?? process.env.RESEND_AUDIENCE_ID;
  const resendMinIntervalMs = Number(
    testConfig?.resendMinIntervalMs ?? process.env.RESEND_NEWSLETTER_MIN_INTERVAL_MS ?? DEFAULT_RESEND_MIN_INTERVAL_MS,
  );
  const resendMaxRetries = Number(
    testConfig?.resendMaxRetries ?? process.env.RESEND_NEWSLETTER_MAX_RETRIES ?? DEFAULT_RESEND_MAX_RETRIES,
  );
  const resendRetryBaseMs = Number(
    testConfig?.resendRetryBaseMs ?? process.env.RESEND_NEWSLETTER_RETRY_BASE_MS ?? DEFAULT_RESEND_RETRY_BASE_MS,
  );
  return {
    apiKey: testConfig?.apiKey ?? process.env.RESEND_API_KEY,
    segmentId: testConfig?.segmentId ?? testConfig?.audienceId ?? process.env.RESEND_NEWSLETTER_SEGMENT_ID ?? legacyAudienceId,
    webhookSecret: testConfig?.webhookSecret ?? process.env.RESEND_NEWSLETTER_WEBHOOK_SECRET ?? process.env.RESEND_WEBHOOK_SECRET,
    resendMinIntervalMs: Number.isFinite(resendMinIntervalMs) ? Math.max(0, resendMinIntervalMs) : DEFAULT_RESEND_MIN_INTERVAL_MS,
    resendMaxRetries: Number.isFinite(resendMaxRetries) ? Math.max(0, resendMaxRetries) : DEFAULT_RESEND_MAX_RETRIES,
    resendRetryBaseMs: Number.isFinite(resendRetryBaseMs) ? Math.max(0, resendRetryBaseMs) : DEFAULT_RESEND_RETRY_BASE_MS,
  };
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitForResendRateLimit(minIntervalMs: number) {
  if (minIntervalMs <= 0) return;
  const waitTurn = resendRateLimitQueue.then(async () => {
    const elapsed = Date.now() - lastResendRequestAt;
    const waitMs = Math.max(0, minIntervalMs - elapsed);
    if (waitMs > 0) await sleep(waitMs);
    lastResendRequestAt = Date.now();
  });
  resendRateLimitQueue = waitTurn.catch(() => {});
  await waitTurn;
}

function parseRetryAfterMs(value: string | null) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const timestamp = Date.parse(value);
  if (Number.isFinite(timestamp)) return Math.max(0, timestamp - Date.now());
  return null;
}

function isRetryableResendStatus(status: number | undefined) {
  return status === 429 || (typeof status === "number" && status >= 500);
}

function parseResendError(body: unknown): string {
  if (!body || typeof body !== "object") return "Resend request failed";
  const record = body as Record<string, unknown>;
  const message = record.message ?? record.error;
  return typeof message === "string" ? message : "Resend request failed";
}

async function resendJson(path: string, method: "POST" | "PATCH", apiKey: string, body?: unknown, options?: ContactSyncOptions) {
  const config = getNewsletterConfig();
  let attempt = 0;
  for (;;) {
    if (options?.rateLimited) {
      await waitForResendRateLimit(config.resendMinIntervalMs);
    }
    const res = await fetch(`https://api.resend.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (res.ok) return json as { id?: string; data?: { id?: string } };

    const err = new Error(parseResendError(json)) as Error & { status?: number };
    err.status = res.status;
    if (!options?.rateLimited || !isRetryableResendStatus(res.status) || attempt >= config.resendMaxRetries) throw err;
    attempt++;
    const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
    const backoffMs = retryAfterMs ?? config.resendRetryBaseMs * 2 ** (attempt - 1);
    await sleep(backoffMs);
  }
}

function encodeContactPathSegment(email: string) {
  return encodeURIComponent(email);
}

async function createResendContact(input: ContactSyncInput, apiKey: string, options?: ContactSyncOptions): Promise<ContactCreateResult> {
  const payload = {
    email: input.email,
    firstName: input.firstName,
    unsubscribed: input.unsubscribed,
    segments: [{ id: input.segmentId }],
  };
  try {
    const json = await resendJson("/contacts", "POST", apiKey, payload, options);
    return { id: json.id ?? json.data?.id ?? null };
  } catch (err) {
    if ((err as { status?: number }).status !== 409) throw err;
    const json = await resendJson(
      `/contacts/${encodeContactPathSegment(input.email)}`,
      "PATCH",
      apiKey,
      { unsubscribed: input.unsubscribed },
      options,
    );
    const id = json.id ?? json.data?.id ?? null;
    await addResendContactToSegment(input.email, input.segmentId, apiKey, options);
    return { id };
  }
}

async function addResendContactToSegment(email: string, segmentId: string, apiKey: string, options?: ContactSyncOptions) {
  try {
    await resendJson(
      `/contacts/${encodeContactPathSegment(email)}/segments/${encodeURIComponent(segmentId)}`,
      "POST",
      apiKey,
      undefined,
      options,
    );
  } catch (err) {
    if ((err as { status?: number }).status !== 409) throw err;
  }
}

function defaultContactClient(apiKey: string): NewsletterContactClient {
  return {
    syncContact: (input, options) => createResendContact(input, apiKey, options),
  };
}

function summarizeError(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500);
}

async function findAudienceContact(database: DatabaseExecutor, audienceId: string, email: string) {
  const [row] = await database
    .select()
    .from(newsletterAudienceContacts)
    .where(and(
      eq(newsletterAudienceContacts.audienceId, audienceId),
      eq(newsletterAudienceContacts.email, email),
    ));
  return row ?? null;
}

async function upsertAudienceContact(
  database: DatabaseExecutor,
  values: {
    userId: string | null;
    email: string;
    audienceId: string;
    status: NewsletterStatus;
    resendContactId?: string | null;
    lastSyncError?: string | null;
    optedOutAt?: Date | null;
    lastSyncedAt?: Date | null;
  },
) {
  const set: Partial<typeof newsletterAudienceContacts.$inferInsert> = {
    userId: values.userId,
    status: values.status,
    updatedAt: new Date(),
  };
  if (values.resendContactId !== undefined) set.resendContactId = values.resendContactId;
  if (values.lastSyncError !== undefined) set.lastSyncError = values.lastSyncError;
  if (values.optedOutAt !== undefined) set.optedOutAt = values.optedOutAt;
  if (values.lastSyncedAt !== undefined) set.lastSyncedAt = values.lastSyncedAt;

  await database.insert(newsletterAudienceContacts).values({
    userId: values.userId,
    email: values.email,
    audienceId: values.audienceId,
    status: values.status,
    resendContactId: values.resendContactId ?? null,
    lastSyncError: values.lastSyncError ?? null,
    optedOutAt: values.optedOutAt ?? null,
    lastSyncedAt: values.lastSyncedAt ?? null,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: [newsletterAudienceContacts.audienceId, newsletterAudienceContacts.email],
    set,
  });
}

export function isNewsletterSyncConfigured() {
  const config = getNewsletterConfig();
  return Boolean(config.apiKey && config.segmentId);
}

export async function syncNewsletterSignup(user: NewsletterUser, options: SignupSyncOptions = {}): Promise<SignupSyncResult> {
  const config = getNewsletterConfig();
  if (!config.apiKey || !config.segmentId) {
    return { status: "skipped", reason: "not_configured" };
  }

  const db = getDb();
  const email = normalizeEmail(user.email);
  const existing = await findAudienceContact(db, config.segmentId, email);
  if (existing && OPT_OUT_STATUSES.includes(existing.status as OptOutStatus)) {
    if (!existing.userId) {
      await db.update(newsletterAudienceContacts)
        .set({ userId: user.id, updatedAt: new Date() })
        .where(eq(newsletterAudienceContacts.id, existing.id));
    }
    return { status: "skipped", reason: "opted_out" };
  }

  const client = testContactClient ?? defaultContactClient(config.apiKey);
  try {
    const result = await client.syncContact(
      {
        segmentId: config.segmentId,
        email,
        firstName: user.displayName?.trim() || user.name,
        unsubscribed: false,
      },
      { rateLimited: options.rateLimited },
    );
    await upsertAudienceContact(db, {
      userId: user.id,
      email,
      audienceId: config.segmentId,
      status: "synced",
      resendContactId: result.id,
      lastSyncError: null,
      optedOutAt: null,
      lastSyncedAt: new Date(),
    });
    return { status: "synced", contactId: result.id };
  } catch (err) {
    const message = summarizeError(err);
    await upsertAudienceContact(db, {
      userId: user.id,
      email,
      audienceId: config.segmentId,
      status: "sync_failed",
      lastSyncError: message,
    });
    console.warn(`[Newsletter] Signup contact sync failed for ${email}: ${message}`);
    return { status: "failed", error: message };
  }
}

function decodeSvixSecret(secret: string): Buffer {
  const encoded = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  return Buffer.from(encoded, "base64");
}

function safeEqual(a: Buffer, b: Buffer) {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyResendWebhookSignature(payload: Buffer, headers: ResendWebhookHeaders, secret: string): void {
  const id = getSingleHeader(headers.id);
  const timestamp = getSingleHeader(headers.timestamp);
  const signature = getSingleHeader(headers.signature);
  if (!id || !timestamp || !signature) {
    throw new Error("Missing Resend webhook signature headers");
  }

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    throw new Error("Invalid Resend webhook timestamp");
  }
  const maxSkewSeconds = 5 * 60;
  if (Math.abs(Date.now() / 1000 - timestampSeconds) > maxSkewSeconds) {
    throw new Error("Stale Resend webhook timestamp");
  }

  const signedPayload = `${id}.${timestamp}.${payload.toString("utf8")}`;
  const expected = createHmac("sha256", decodeSvixSecret(secret)).update(signedPayload).digest();
  const valid = signature
    .split(" ")
    .some((part) => {
      const [version, encoded] = part.split(",", 2);
      if (version !== "v1" || !encoded) return false;
      try {
        return safeEqual(expected, Buffer.from(encoded, "base64"));
      } catch {
        return false;
      }
    });

  if (!valid) {
    throw new Error("Invalid Resend webhook signature");
  }
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function pickEmail(value: unknown): string | null {
  if (typeof value === "string" && value.includes("@")) return normalizeEmail(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const email = pickEmail(item);
      if (email) return email;
    }
  }
  const record = getRecord(value);
  if (record) {
    for (const key of ["email", "recipient", "to"]) {
      const email = pickEmail(record[key]);
      if (email) return email;
    }
  }
  return null;
}

function classifyOptOutEvent(event: ResendWebhookEvent): OptOutStatus | null {
  const type = event.type ?? "";
  const data = getRecord(event.data);
  if (type === "email.bounced") return "bounced";
  if (type === "email.complained") return "complained";
  if (type === "email.suppressed") return "unsubscribed";
  if (type === "contact.deleted") return "unsubscribed";
  if (type === "contact.updated" && data?.unsubscribed === true) return "unsubscribed";
  return null;
}

export async function handleNewsletterWebhookPayload(payload: Buffer, headers: ResendWebhookHeaders) {
  const config = getNewsletterConfig();
  if (!config.webhookSecret) {
    throw new Error("Resend newsletter webhook secret is not configured");
  }
  if (!config.segmentId) {
    throw new Error("Resend newsletter segment id is not configured");
  }
  verifyResendWebhookSignature(payload, headers, config.webhookSecret);

  const event = JSON.parse(payload.toString("utf8")) as ResendWebhookEvent;
  const id = getSingleHeader(headers.id)!;
  const type = event.type ?? "unknown";
  const email = pickEmail(event.data);
  const status = classifyOptOutEvent(event);
  const db = getDb();

  const [existingEvent] = await db
    .select({ id: newsletterWebhookEvents.id })
    .from(newsletterWebhookEvents)
    .where(eq(newsletterWebhookEvents.id, id));
  if (existingEvent) {
    return { processed: false, duplicate: true, type, email, status };
  }

  if (status && email) {
    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    await upsertAudienceContact(db, {
      userId: user?.id ?? null,
      email,
      audienceId: config.segmentId,
      status,
      optedOutAt: new Date(),
    });
    await suppressScheduledComputerMobileAppEmailJourneys({
      userId: user?.id ?? null,
      email,
      status,
    });
  }

  await db.insert(newsletterWebhookEvents).values({
    id,
    type,
    email,
  }).onConflictDoNothing();

  return { processed: true, duplicate: false, type, email, status };
}

async function listBackfillCandidates(batchSize: number, afterEmail: string | null) {
  const db = getDb();
  const config = getNewsletterConfig();
  if (!config.segmentId) return [];

  const rows = await db.execute<{ id: string; email: string; name: string; displayName: string | null }>(sql`
    SELECT u.id, u.email, u.name, u.display_name AS "displayName"
    FROM users u
    LEFT JOIN newsletter_audience_contacts nac
      ON nac.audience_id = ${config.segmentId}
      AND nac.email = lower(trim(u.email))
    WHERE (${afterEmail}::text IS NULL OR lower(trim(u.email)) > ${afterEmail})
      AND (
        nac.id IS NULL
        OR nac.status = 'sync_failed'
      )
    ORDER BY lower(trim(u.email)) ASC
    LIMIT ${batchSize}
  `);

  return rows.rows;
}

export async function backfillNewsletterAudience(options: BackfillOptions = {}): Promise<BackfillResult> {
  const config = getNewsletterConfig();
  if (!config.apiKey || !config.segmentId) {
    throw new Error("RESEND_API_KEY and RESEND_NEWSLETTER_SEGMENT_ID are required");
  }

  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const limit = options.limit == null ? Number.POSITIVE_INFINITY : Math.max(1, options.limit);
  const result: BackfillResult = { dryRun: Boolean(options.dryRun), scanned: 0, synced: 0, failed: 0, skipped: 0, sample: [] };
  let afterEmail: string | null = null;

  while (result.scanned < limit) {
    const candidates = await listBackfillCandidates(Math.min(batchSize, limit - result.scanned), afterEmail);
    if (candidates.length === 0) break;

    for (const candidate of candidates) {
      if (result.scanned >= limit) break;
      result.scanned++;
      if (result.sample.length < 10) {
        result.sample.push({ id: candidate.id, email: candidate.email });
      }
      afterEmail = normalizeEmail(candidate.email);
      if (options.dryRun) continue;
      const sync = await syncNewsletterSignup({
        id: candidate.id,
        email: candidate.email,
        name: candidate.name,
        displayName: candidate.displayName,
      }, { rateLimited: true });
      if (sync.status === "synced") result.synced++;
      else if (sync.status === "failed") result.failed++;
      else result.skipped++;
    }

    if (candidates.length < batchSize) break;
  }

  return result;
}

export function setNewsletterContactClientForTest(client: NewsletterContactClient | null) {
  testContactClient = client;
}

export function setNewsletterConfigForTest(config: {
  apiKey?: string;
  segmentId?: string;
  audienceId?: string;
  webhookSecret?: string;
  resendMinIntervalMs?: number;
  resendMaxRetries?: number;
  resendRetryBaseMs?: number;
} | null) {
  testConfig = config;
}

export function resetNewsletterTestOverrides() {
  testContactClient = null;
  testConfig = null;
  resendRateLimitQueue = Promise.resolve();
  lastResendRequestAt = 0;
}
