import { createHmac } from "node:crypto";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { isPrivacyModeOn } from "../config/privacyMode";

/**
 * Per-client Hands apps for product feedback (#raft-mobile-reconcile:6f867e95).
 *
 * Web uses the single-app configuration (`HANDS_FEEDBACK_*`), field for field.
 * Each mobile source reads its own app from one SecureString JSON in SSM,
 * named by `HANDS_FEEDBACK_APPS_SSM_PARAMETER` (the deployment sets it together
 * with the read grant). It is read at runtime
 * and cached for five minutes, so a missing
 * parameter never blocks task start and a rotation needs no redeploy:
 *
 *   { "shared": { reporter_id_secret, route_subject_root, cursor_secret },
 *     "<source>": { app_slug, app_id, reporter_integration_id,
 *                   credential_revision, client_key, token }, ... }
 *
 * The shared secrets are never the legacy ones. The result is an env view in
 * the legacy variable names, so the submit, conversation and route-binding
 * services stay unchanged. A mobile source whose entry is missing or
 * incomplete is unavailable (503) and never falls back to the legacy app.
 *
 * Web never reads a `web` entry: web reporters would get a new reporter id and
 * route root, so their existing tickets would disappear from the web list.
 * Moving web needs a migration. The parameter uses the AWS-managed `aws/ssm` key; a customer
 * managed key also needs `kms:Decrypt` on the task role.
 */
export const PRODUCT_FEEDBACK_SOURCES = ["web", "ios", "android", "ohos"] as const;
export type ProductFeedbackSource = (typeof PRODUCT_FEEDBACK_SOURCES)[number];

export const PRODUCT_FEEDBACK_MULTI_COMMITMENT_SCOPE = "multi";

export class ProductFeedbackSourceUnavailableError extends Error {
  constructor(readonly source: ProductFeedbackSource, readonly reason: string = "unknown") {
    super("feedback integration unavailable");
    this.name = "ProductFeedbackSourceUnavailableError";
  }
}

const SOURCE_ENTRY_FIELDS = ["app_slug", "app_id", "reporter_integration_id", "credential_revision", "client_key", "token"] as const;
const SHARED_FIELDS = ["reporter_id_secret", "route_subject_root", "cursor_secret"] as const;

/**
 * Why `productFeedbackEnvForSource` returned null, for the operator log only:
 * a fixed code plus the names of missing fields, never a value. (10-10: the
 * staging parameter had been pasted with terminal line wraps and did not
 * parse; the log said only "source unavailable", which took a manual
 * structure readback to diagnose.)
 */
export function productFeedbackUnavailableReason(
  source: ProductFeedbackSource,
  appsJson: string | null,
  env: NodeJS.ProcessEnv,
): string {
  if (!env.HANDS_FEEDBACK_BASE_URL?.trim()) return "base_url_missing";
  // Not configured (no or malformed Terraform-injected name) vs. configured but
  // unreadable (the reader already logged the AWS error name).
  if (appsJson === null) return productFeedbackAppsParameterName(env) ? "apps_parameter_unread" : "apps_parameter_not_configured";
  let apps: unknown;
  try {
    apps = JSON.parse(appsJson);
  } catch {
    return "apps_json_invalid";
  }
  if (!apps || typeof apps !== "object" || Array.isArray(apps)) return "apps_json_not_object";
  const record = apps as Record<string, unknown>;
  if (!(source in record)) return "source_entry_missing";
  const missingEntry = SOURCE_ENTRY_FIELDS.filter((field) => !stringField(record[source], field));
  if (missingEntry.length) return `source_fields_missing:${missingEntry.join(",")}`;
  const missingShared = SHARED_FIELDS.filter((field) => !stringField(record.shared, field));
  if (missingShared.length) return `shared_fields_missing:${missingShared.join(",")}`;
  return "unknown";
}

export function isProductFeedbackSource(value: unknown): value is ProductFeedbackSource {
  return typeof value === "string" && (PRODUCT_FEEDBACK_SOURCES as readonly string[]).includes(value);
}

function stringField(record: unknown, key: string): string | undefined {
  if (!record || typeof record !== "object" || Array.isArray(record)) return undefined;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * The env view for one source's app, or null when its entry (or a shared
 * secret) is missing or the JSON does not parse. Each source gets its own
 * cursor key (derived from the shared secret and its app id), so a cursor
 * minted for one app does not verify on another.
 */
export function productFeedbackEnvForSource(
  source: ProductFeedbackSource,
  appsJson: string | null,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv | null {
  const baseUrl = env.HANDS_FEEDBACK_BASE_URL?.trim();
  let apps: unknown;
  try {
    apps = JSON.parse(appsJson ?? "");
  } catch {
    return null;
  }
  if (!apps || typeof apps !== "object" || Array.isArray(apps)) return null;
  const shared = (apps as Record<string, unknown>).shared;
  const entry = (apps as Record<string, unknown>)[source];
  const appSlug = stringField(entry, "app_slug");
  const appId = stringField(entry, "app_id");
  const reporterIntegrationId = stringField(entry, "reporter_integration_id");
  const credentialRevision = stringField(entry, "credential_revision");
  const clientKey = stringField(entry, "client_key");
  const token = stringField(entry, "token");
  const reporterIdSecret = stringField(shared, "reporter_id_secret");
  const routeSubjectRoot = stringField(shared, "route_subject_root");
  const cursorSecret = stringField(shared, "cursor_secret");
  if (
    !baseUrl || !appSlug || !appId || !reporterIntegrationId || !credentialRevision
    || !clientKey || !token || !reporterIdSecret || !routeSubjectRoot || !cursorSecret
  ) return null;
  return {
    HANDS_FEEDBACK_BASE_URL: baseUrl,
    HANDS_FEEDBACK_APP_SLUG: appSlug,
    HANDS_FEEDBACK_APP_ID: appId,
    HANDS_FEEDBACK_CLIENT_KEY: clientKey,
    // One reporter-integration deploy token (feedback:write/read/comment/route)
    // serves submit, route binding and the conversation calls.
    HANDS_FEEDBACK_APP_TOKEN: token,
    HANDS_FEEDBACK_CONVERSATION_APP_TOKEN: token,
    HANDS_FEEDBACK_CONVERSATION_CREDENTIAL_REVISION: credentialRevision,
    HANDS_FEEDBACK_REPORTER_INTEGRATION_ID: reporterIntegrationId,
    HANDS_FEEDBACK_CONVERSATION_SESSION_ENABLED: env.HANDS_FEEDBACK_CONVERSATION_SESSION_ENABLED,
    HANDS_FEEDBACK_REPORTER_ID_SECRET: reporterIdSecret,
    HANDS_FEEDBACK_ROUTE_SUBJECT_KEY_ID: "v1",
    HANDS_FEEDBACK_ROUTE_SUBJECT_ROOT: routeSubjectRoot,
    HANDS_FEEDBACK_ROUTE_SUBJECT_COMMITMENT_SCOPE: PRODUCT_FEEDBACK_MULTI_COMMITMENT_SCOPE,
    HANDS_FEEDBACK_CURSOR_SECRET: createHmac("sha256", cursorSecret)
      .update(`feedback-cursor-app:${appId}`, "utf8")
      .digest("base64url"),
  };
}

/** Pick the configuration a feedback request for `source` uses. */
export function selectProductFeedbackEnv(input: {
  source: ProductFeedbackSource;
  appsJson: string | null;
  env?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const env = input.env ?? process.env;
  if (input.source === "web") return env;
  const sourceEnv = productFeedbackEnvForSource(input.source, input.appsJson, env);
  if (sourceEnv) return sourceEnv;
  throw new ProductFeedbackSourceUnavailableError(
    input.source,
    productFeedbackUnavailableReason(input.source, input.appsJson, env),
  );
}

export type ProductFeedbackAppsReader = (parameterName: string) => Promise<string | null>;

const APPS_CACHE_TTL_MS = 5 * 60 * 1000;
// A failed read is retried sooner, so an SSM blip does not keep mobile
// sources on the native fallback for a whole window.
const APPS_FAILURE_CACHE_TTL_MS = 30 * 1000;

export function productFeedbackAppsParameterName(env: NodeJS.ProcessEnv = process.env): string | null {
  const name = env.HANDS_FEEDBACK_APPS_SSM_PARAMETER?.trim();
  return name && /^\/slock\/[a-z]+\/HANDS_FEEDBACK_APPS$/.test(name) ? name : null;
}

export function createAwsProductFeedbackAppsReader(env: NodeJS.ProcessEnv = process.env): ProductFeedbackAppsReader {
  const client = new SSMClient({ region: env.AWS_REGION?.trim() || undefined });
  return async (parameterName) => {
    const response = await client.send(new GetParameterCommand({ Name: parameterName, WithDecryption: true }));
    return response.Parameter?.Value ?? null;
  };
}

/**
 * The apps JSON, cached for five minutes. A failed read is cached too (as
 * null) for 30 seconds, so an SSM outage costs one call per 30 seconds and
 * mobile sources answer 503 meanwhile; it is logged without any value.
 */
export class CachedProductFeedbackApps {
  private cached?: { json: string | null; expiresAt: number };
  private inFlight?: Promise<string | null>;

  constructor(
    private readonly reader: ProductFeedbackAppsReader,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly ttlMs = APPS_CACHE_TTL_MS,
    private readonly now: () => number = Date.now,
    private readonly failureTtlMs = APPS_FAILURE_CACHE_TTL_MS,
  ) {}

  async get(): Promise<string | null> {
    if (this.cached && this.cached.expiresAt > this.now()) return this.cached.json;
    if (this.inFlight) return this.inFlight;
    const parameterName = productFeedbackAppsParameterName(this.env);
    this.inFlight = (parameterName ? this.reader(parameterName) : Promise.resolve(null))
      .catch((error: unknown) => {
        const name = error instanceof Error ? error.name : "UnknownError";
        console.warn(`[product-feedback] apps parameter unavailable (${name})`);
        return null;
      })
      .then((json) => {
        this.cached = { json, expiresAt: this.now() + (json === null ? this.failureTtlMs : this.ttlMs) };
        return json;
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }
}

let defaultApps: CachedProductFeedbackApps | null = null;

function productFeedbackApps(): CachedProductFeedbackApps {
  defaultApps ??= new CachedProductFeedbackApps(createAwsProductFeedbackAppsReader());
  return defaultApps;
}

export function setProductFeedbackAppsForTest(apps: CachedProductFeedbackApps | null): void {
  defaultApps = apps;
}

/**
 * The apps JSON as cached now (null: unread or not configured), for a caller
 * that selects several sources from one read (selectProductFeedbackEnv).
 */
export function readProductFeedbackAppsJson(apps: CachedProductFeedbackApps = productFeedbackApps()): Promise<string | null> {
  return apps.get();
}

type ResolveProductFeedbackEnvInput = {
  source: ProductFeedbackSource;
  env?: NodeJS.ProcessEnv;
  apps?: CachedProductFeedbackApps;
};

/**
 * The configuration a feedback request for `source` uses, and whose Hands
 * app that is (`app`, always `source`): web's is the legacy app, a mobile
 * source's its own. A ticket lives in the app it was filed into and is read
 * only through it.
 */
export async function resolveProductFeedbackApp(input: ResolveProductFeedbackEnvInput): Promise<{ env: NodeJS.ProcessEnv; app: ProductFeedbackSource }> {
  if (input.source === "web") return { env: input.env ?? process.env, app: "web" };
  // RAFT_PRIVACY_MODE: no SSM read; the caller's configuration check refuses.
  if (isPrivacyModeOn()) return { env: input.env ?? process.env, app: input.source };
  const env = selectProductFeedbackEnv({
    source: input.source,
    appsJson: await (input.apps ?? productFeedbackApps()).get(),
    env: input.env,
  });
  return { env, app: input.source };
}

export async function resolveProductFeedbackEnv(input: ResolveProductFeedbackEnvInput): Promise<NodeJS.ProcessEnv> {
  return (await resolveProductFeedbackApp(input)).env;
}
