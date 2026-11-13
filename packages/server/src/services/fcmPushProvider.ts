import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { AwsClient, GoogleAuth, type AuthClient } from "google-auth-library";
import { clearClockTimeout, setClockTimeout } from "@botiverse/raft-shared";
import { recordExternalSinkInsideTransaction } from "../db/ambientTransaction";

/**
 * Android push through FCM HTTP v1.
 *
 * Credentials come from one env var, `FCM_CREDENTIALS_JSON`, holding either:
 * - a Google credential configuration for Workload Identity Federation
 *   (`"type": "external_account"`, AWS source). The server's own AWS role is
 *   exchanged for a short-lived Google token, so no long-lived key exists. On
 *   ECS the AWS credentials come from the task role through the default AWS
 *   provider chain, which the library's built-in AWS source cannot read.
 * - a service account key (`"type": "service_account"`), for local
 *   development only: with NODE_ENV=production a key is refused, so a
 *   long-lived key can never become the production credential.
 * `FCM_PROJECT_ID` names the Firebase project; a service account key carries
 * its own `project_id`, which is used when the env var is absent.
 *
 * Without both a credential and a project, `send` reports
 * `provider_not_configured` and nothing leaves the process.
 */

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const FCM_REQUEST_TIMEOUT_MS = 5_000;
const FCM_TTL_SECONDS = 60 * 60;
/** The boot prefetch waits longer than a send: nothing is held while it runs. */
const FCM_PREFETCH_TIMEOUT_MS = 30_000;

export interface FcmMessage {
  /** FCM `message.data`: string values only. */
  data: Record<string, string>;
  /** `android.priority`; absent = HIGH (callers before the unified notifications). */
  priority?: "HIGH" | "NORMAL";
}

export interface FcmDeliveryInput {
  registrationId: string;
  installationId: string;
  deviceToken: string;
  message: FcmMessage;
}

export interface FcmDeliveryResult {
  status: "sent" | "skipped";
  reason?: "provider_not_configured";
}

export interface FcmPushProvider {
  send(input: FcmDeliveryInput): Promise<FcmDeliveryResult>;
  /** False when `send` would skip with `provider_not_configured`. Absent = configured. */
  isConfigured?(): boolean;
  /** Fetches the access token ahead of the first send (boot warm-up). */
  prefetchAccessToken?(): Promise<"warmed" | "not_configured">;
}

export class FcmDeliveryError extends Error {
  statusCode?: number;
  /** FCM `errorCode` (e.g. `UNREGISTERED`) when present, else the Google RPC status. */
  reason?: string;

  constructor(message: string, opts: { statusCode?: number; reason?: string } = {}) {
    super(message);
    this.name = "FcmDeliveryError";
    this.statusCode = opts.statusCode;
    this.reason = opts.reason;
  }
}

export class FcmRequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`FCM request did not complete within ${timeoutMs}ms`);
    this.name = "FcmRequestTimeoutError";
  }
}

/** The token can never deliver again: revoke the registration. */
export function isTerminalFcmTokenError(err: unknown): boolean {
  if (!(err instanceof FcmDeliveryError)) return false;
  // A failed token exchange says nothing about the device's registration.
  if (err.reason?.startsWith("credential_exchange_failed")) return false;
  return err.reason === "UNREGISTERED" || err.reason === "SENDER_ID_MISMATCH" || err.statusCode === 404;
}

/**
 * The request itself is wrong (bad token format, oversized payload): retrying
 * the same request cannot succeed, but the token may still be valid, so the
 * push is dropped without revoking anything.
 */
export function isNonRetryableFcmError(err: unknown): boolean {
  return err instanceof FcmDeliveryError && err.reason === "INVALID_ARGUMENT";
}

export function parseFcmErrorReason(body: string): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as {
      error?: { status?: unknown; details?: Array<{ errorCode?: unknown }> };
    };
    const errorCode = parsed.error?.details?.find((detail) => typeof detail?.errorCode === "string")?.errorCode;
    if (typeof errorCode === "string") return errorCode;
    return typeof parsed.error?.status === "string" ? parsed.error.status : undefined;
  } catch {
    return undefined;
  }
}

interface FcmHttpRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

interface FcmHttpResponse {
  statusCode: number;
  body: string;
}

export type FcmHttpClient = (request: FcmHttpRequest) => Promise<FcmHttpResponse>;

/**
 * Like APNs, FCM is called from the outbox drain while the channel writer fence
 * holds a transaction, so every request is bounded.
 */
export function createFcmHttpClient(timeoutMs: number): FcmHttpClient {
  return async (request) => {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: request.body,
        signal,
      });
      return { statusCode: response.status, body: await response.text() };
    } catch (err) {
      if (signal.aborted) throw new FcmRequestTimeoutError(timeoutMs);
      throw err;
    }
  };
}

export interface FcmAccessTokenSource {
  projectId: string;
  getAccessToken(): Promise<string>;
}

interface FcmCredentialsConfig {
  type?: unknown;
  project_id?: unknown;
  credential_source?: { environment_id?: unknown };
  audience?: unknown;
  subject_token_type?: unknown;
  [key: string]: unknown;
}

function optionalString<K extends string>(key: K, value: unknown): { [P in K]?: string } {
  return (typeof value === "string" && value ? { [key]: value } : {}) as { [P in K]?: string };
}

function awsRegion(): string {
  return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "";
}

function createAuthClient(config: FcmCredentialsConfig): AuthClient | GoogleAuth {
  const environmentId = config.credential_source?.environment_id;
  if (
    config.type === "external_account"
    && typeof environmentId === "string"
    && environmentId.startsWith("aws")
    && typeof config.audience === "string"
    && typeof config.subject_token_type === "string"
  ) {
    // The default chain covers the ECS task role, env vars and instance roles,
    // and caches/refreshes the credentials itself.
    const awsCredentials = defaultProvider();
    return new AwsClient({
      audience: config.audience,
      subject_token_type: config.subject_token_type,
      ...optionalString("token_url", config.token_url),
      ...optionalString("service_account_impersonation_url", config.service_account_impersonation_url),
      ...optionalString("universe_domain", config.universe_domain),
      ...optionalString("workforce_pool_user_project", config.workforce_pool_user_project),
      scopes: [FCM_SCOPE],
      aws_security_credentials_supplier: {
        getAwsRegion: async () => {
          const region = awsRegion();
          if (!region) throw new Error("AWS_REGION is not set");
          return region;
        },
        getAwsSecurityCredentials: async () => {
          const credentials = await awsCredentials();
          return {
            accessKeyId: credentials.accessKeyId,
            secretAccessKey: credentials.secretAccessKey,
            token: credentials.sessionToken,
          };
        },
      },
    });
  }
  return new GoogleAuth({ credentials: config as never, scopes: [FCM_SCOPE] });
}

let cachedTokenSource: { raw: string; projectId: string; source: FcmAccessTokenSource | null } | null = null;

/**
 * Reads the env on every call so a configuration change (or a test) is seen,
 * but builds the auth client once per distinct configuration: the client owns
 * the access-token cache.
 */
export function fcmAccessTokenSourceFromEnv(): FcmAccessTokenSource | null {
  const raw = process.env.FCM_CREDENTIALS_JSON?.trim() || "";
  const projectIdEnv = process.env.FCM_PROJECT_ID?.trim() || "";
  if (!raw) return null;
  if (cachedTokenSource && cachedTokenSource.raw === raw && cachedTokenSource.projectId === projectIdEnv) {
    return cachedTokenSource.source;
  }

  let source: FcmAccessTokenSource | null = null;
  try {
    const config = JSON.parse(raw) as FcmCredentialsConfig;
    if (process.env.NODE_ENV === "production" && config.type !== "external_account") {
      console.warn("[FCM] production accepts only a Workload Identity Federation config (type external_account); FCM stays off");
      cachedTokenSource = { raw, projectId: projectIdEnv, source: null };
      return null;
    }
    const projectId = projectIdEnv || (typeof config.project_id === "string" ? config.project_id : "");
    if (!projectId) {
      console.warn("[FCM] FCM_CREDENTIALS_JSON is set but no project id is configured (FCM_PROJECT_ID); FCM stays off");
    } else {
      const client = createAuthClient(config);
      source = {
        projectId,
        async getAccessToken() {
          const token = await client.getAccessToken();
          const value = typeof token === "string" ? token : token?.token;
          if (!value) throw new Error("FCM access token unavailable");
          return value;
        },
      };
    }
  } catch (err) {
    console.warn(`[FCM] FCM_CREDENTIALS_JSON is not usable; FCM stays off: ${err instanceof Error ? err.name : "unknown_error"}`);
  }
  cachedTokenSource = { raw, projectId: projectIdEnv, source };
  return source;
}

export class ConfiguredFcmPushProvider implements FcmPushProvider {
  constructor(
    private readonly httpClient: () => FcmHttpClient,
    private readonly tokenSource: () => FcmAccessTokenSource | null,
  ) {}

  isConfigured(): boolean {
    return this.tokenSource() !== null;
  }

  /**
   * Boot warm-up: runs the token exchange (AWS credentials, Google STS,
   * impersonation) before the first send needs it. The auth client caches the
   * token and shares an exchange in flight, so a send during the prefetch
   * waits on it instead of starting its own.
   */
  async prefetchAccessToken(timeoutMs: number = FCM_PREFETCH_TIMEOUT_MS): Promise<"warmed" | "not_configured"> {
    const source = this.tokenSource();
    if (!source) return "not_configured";
    await withTimeout(source.getAccessToken(), timeoutMs);
    return "warmed";
  }

  async send(input: FcmDeliveryInput): Promise<FcmDeliveryResult> {
    recordExternalSinkInsideTransaction("fcm");
    const source = this.tokenSource();
    if (!source) return { status: "skipped", reason: "provider_not_configured" };

    let accessToken: string;
    try {
      accessToken = await withTimeout(source.getAccessToken(), FCM_REQUEST_TIMEOUT_MS);
    } catch (err) {
      // The Google token exchange (WIF or key) failed before FCM was called.
      // Surface it as a classified FCM error so the drop names the cause.
      throw new FcmDeliveryError("FCM credential exchange failed", {
        statusCode: credentialExchangeStatus(err),
        reason: `credential_exchange_failed:${credentialExchangeCode(err)}`,
      });
    }
    const response = await this.httpClient()({
      url: `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(source.projectId)}/messages:send`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        message: {
          // The Android app registers by Firebase Installation ID
          // (firebase_messaging_installation_id_enabled), so the stored device
          // token is an FID; HTTP v1 addresses it as `fid` (`token` is deprecated).
          fid: input.deviceToken,
          // Data-only, so the app's own handler builds the notification (and
          // can stay silent when that conversation is already on screen).
          data: input.message.data,
          android: {
            priority: input.message.priority ?? "HIGH",
            ttl: `${FCM_TTL_SECONDS}s`,
            // No collapse_key: every message reaches the device, also after it
            // was offline, and the app stacks them per conversation itself
            // (FCM keeps only ~4 collapse keys per device anyway).
          },
        },
      }),
    });

    if (response.statusCode >= 200 && response.statusCode < 300) {
      return { status: "sent" };
    }

    throw new FcmDeliveryError("FCM rejected mobile push", {
      statusCode: response.statusCode,
      reason: parseFcmErrorReason(response.body),
    });
  }
}

/** HTTP status of a failed token exchange (Gaxios-style `response.status`), if any. */
function credentialExchangeStatus(err: unknown): number | undefined {
  const status = (err as { response?: { status?: unknown } } | null)?.response?.status;
  return typeof status === "number" ? status : undefined;
}

/**
 * A short, content-free code for a failed token exchange: the OAuth `error`
 * field (e.g. `invalid_grant`) when the response carries one, else the error
 * class name. Never the message text, which can echo identities.
 */
function credentialExchangeCode(err: unknown): string {
  const data = (err as { response?: { data?: unknown } } | null)?.response?.data;
  const oauthError = data && typeof data === "object" ? (data as { error?: unknown }).error : undefined;
  if (typeof oauthError === "string" && /^[a-z_]{1,64}$/.test(oauthError)) return oauthError;
  if (err instanceof FcmRequestTimeoutError) return "timeout";
  return err instanceof Error ? err.name : "unknown_error";
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setClockTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setClockTimeout(() => reject(new FcmRequestTimeoutError(timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearClockTimeout(timer);
  }
}

let fcmHttpClient: FcmHttpClient = createFcmHttpClient(FCM_REQUEST_TIMEOUT_MS);
let fcmTokenSourceOverride: (() => FcmAccessTokenSource | null) | null = null;

export const defaultFcmPushProvider: FcmPushProvider = new ConfiguredFcmPushProvider(
  () => fcmHttpClient,
  () => (fcmTokenSourceOverride ? fcmTokenSourceOverride() : fcmAccessTokenSourceFromEnv()),
);

export function __setFcmHttpClientForTests(client: FcmHttpClient) {
  fcmHttpClient = client;
}

export function __setFcmAccessTokenSourceForTests(source: FcmAccessTokenSource | null) {
  fcmTokenSourceOverride = () => source;
}

export function __resetFcmTransportForTests() {
  fcmHttpClient = createFcmHttpClient(FCM_REQUEST_TIMEOUT_MS);
  fcmTokenSourceOverride = null;
  cachedTokenSource = null;
}

