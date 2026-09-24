import { createHash, timingSafeEqual } from "node:crypto";
import { currentTimeMs } from "@botiverse/raft-shared";
import { eq } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index.js";
import { integrationSecretCommitments } from "../db/schema.js";
import { productFeedbackReporterId } from "./productFeedbackService.js";
import {
  feedbackRouteTuple,
  mintProductFeedbackRouteSubject,
  ProductFeedbackRouteSubjectError,
} from "./productFeedbackRouteSubject.js";

const COMMITMENT_LABEL = "hands-feedback-route-subject:v1";
const CACHE_MAX = 10_000;
const CACHE_TTL_MS = 5 * 60_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class ProductFeedbackRouteBindingError extends Error {
  constructor() {
    super("feedback integration unavailable");
    this.name = "ProductFeedbackRouteBindingError";
  }
}

export type ProductFeedbackRouteConfig = {
  baseUrl: string;
  appId: string;
  appToken: string;
  credentialRevision: string;
  reporterIntegrationId: string;
  keyId: "v1";
  root: string;
  reporterIdSecret: string;
};

const successes = new Map<string, number>();

export function resetProductFeedbackRouteBindingCacheForTest(): void {
  successes.clear();
}

export function readProductFeedbackRouteConfig(env: NodeJS.ProcessEnv = process.env): ProductFeedbackRouteConfig {
  const baseUrl = env.HANDS_FEEDBACK_BASE_URL?.trim();
  const appId = env.HANDS_FEEDBACK_APP_ID?.trim();
  const appToken = env.HANDS_FEEDBACK_CONVERSATION_APP_TOKEN?.trim();
  const credentialRevision = env.HANDS_FEEDBACK_CONVERSATION_CREDENTIAL_REVISION?.trim();
  const reporterIntegrationId = env.HANDS_FEEDBACK_REPORTER_INTEGRATION_ID?.trim();
  const keyId = env.HANDS_FEEDBACK_ROUTE_SUBJECT_KEY_ID?.trim();
  const root = env.HANDS_FEEDBACK_ROUTE_SUBJECT_ROOT?.trim();
  const reporterIdSecret = env.HANDS_FEEDBACK_REPORTER_ID_SECRET?.trim();
  if (
    !baseUrl || !appId || !appToken || !credentialRevision || !reporterIntegrationId
    || keyId !== "v1" || !root || !reporterIdSecret
    || !UUID_RE.test(appId)
    || (!UUID_RE.test(reporterIntegrationId) && reporterIntegrationId !== `legacy-feedback:${appId}`)
  ) throw new ProductFeedbackRouteBindingError();
  try {
    const decoded = Buffer.from(root, "base64url");
    if (!/^[A-Za-z0-9_-]{43}$/.test(root) || decoded.length !== 32 || decoded.toString("base64url") !== root) throw new Error();
  } catch {
    throw new ProductFeedbackRouteBindingError();
  }
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""), appId, appToken, credentialRevision,
    reporterIntegrationId, keyId, root, reporterIdSecret,
  };
}

export function isProductFeedbackRouteConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    readProductFeedbackRouteConfig(env);
    return true;
  } catch {
    return false;
  }
}

export function productFeedbackRouteRootCommitment(root: string): Buffer {
  return createHash("sha256").update(feedbackRouteTuple(COMMITMENT_LABEL, Buffer.from(root, "base64url"))).digest();
}

export async function assertProductFeedbackRouteRootCommitment(
  config: ProductFeedbackRouteConfig,
  executor: DatabaseExecutor = getDb(),
): Promise<Buffer> {
  const commitment = productFeedbackRouteRootCommitment(config.root);
  await executor.insert(integrationSecretCommitments).values({
    label: COMMITMENT_LABEL,
    commitment,
  }).onConflictDoNothing();
  const [row] = await executor.select({ commitment: integrationSecretCommitments.commitment })
    .from(integrationSecretCommitments)
    .where(eq(integrationSecretCommitments.label, COMMITMENT_LABEL));
  if (!row || row.commitment.length !== commitment.length || !timingSafeEqual(row.commitment, commitment)) {
    throw new ProductFeedbackRouteBindingError();
  }
  return commitment;
}

function remember(key: string, expiresAt: number): void {
  if (successes.size >= CACHE_MAX && !successes.has(key)) {
    const oldest = successes.keys().next().value as string | undefined;
    if (oldest) successes.delete(oldest);
  }
  successes.delete(key);
  successes.set(key, expiresAt);
}

export async function ensureProductFeedbackRouteBinding(input: {
  userId: string;
  reporterId?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  nowMs?: number;
  executor?: DatabaseExecutor;
}): Promise<{ reporterId: string }> {
  try {
    const config = readProductFeedbackRouteConfig(input.env);
    if (!UUID_RE.test(input.userId)) throw new Error();
    const reporterId = input.reporterId ?? productFeedbackReporterId(input.userId, config.reporterIdSecret);
    const commitment = await assertProductFeedbackRouteRootCommitment(config, input.executor);
    const cacheKey = feedbackRouteTuple(
      config.credentialRevision, config.keyId, commitment, config.appId,
      config.reporterIntegrationId, reporterId,
    ).toString("base64url");
    const now = input.nowMs ?? currentTimeMs();
    if ((successes.get(cacheKey) ?? 0) > now) return { reporterId };
    successes.delete(cacheKey);
    const subject = mintProductFeedbackRouteSubject({
      root: config.root,
      userId: input.userId,
      coordinate: { appId: config.appId, reporterIntegrationId: config.reporterIntegrationId, reporterId },
    });
    const response = await (input.fetchImpl ?? globalThis.fetch)(
      `${config.baseUrl}/api/apps/${encodeURIComponent(config.appId)}/reporter-feedback/route-subject`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${config.appToken}`,
          "Content-Type": "application/json",
          "X-Hands-Reporter-Id": reporterId,
        },
        body: JSON.stringify({ route_subject: subject }),
      },
    );
    if (response.status !== 200 && response.status !== 201) throw new Error();
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || Object.keys(body).sort().join("\0") !== "changed\0subject_version"
      || typeof body.changed !== "boolean" || body.subject_version !== "v1"
      || (response.status === 201) !== body.changed) throw new Error();
    remember(cacheKey, now + CACHE_TTL_MS);
    return { reporterId };
  } catch (error) {
    if (error instanceof ProductFeedbackRouteBindingError) throw error;
    if (error instanceof ProductFeedbackRouteSubjectError) throw new ProductFeedbackRouteBindingError();
    throw new ProductFeedbackRouteBindingError();
  }
}
