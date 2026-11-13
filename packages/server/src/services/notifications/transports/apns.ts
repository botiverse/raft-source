/**
 * APNs transport (docs/contracts/notifications.md §4.2): pure serializers of
 * a BuiltNotification / background push into an APNs request, and the HTTP/2
 * provider that sends one request to one registration. Retry, revocation and
 * counting belong to the dispatcher; this module only sends and classifies.
 */
import http2 from "node:http2";
import { createHash } from "node:crypto";
import jwt from "jsonwebtoken";
import { clearClockTimeout, currentTimeMs, setClockTimeout } from "@botiverse/raft-shared";
import { recordExternalSinkInsideTransaction } from "../../../db/ambientTransaction";
import type {
  BuiltNotification,
  ExternalSendResult,
  MobileBackgroundPush,
  MobileRegistrationTarget,
} from "../types";
import { localizationInKeySet } from "./localizationKeys";
import { APNS_PAYLOAD_MAX_BYTES, jsonByteLength, shrinkTextToFit } from "./payloadBudget";

const APNS_REQUEST_TIMEOUT_MS = 5_000;
/**
 * A pooled connection idle this long is closed: a NAT gateway drops idle TCP
 * flows silently (350 s on AWS), and a request on such a flow would only fail
 * on its timeout. Under that, so the next request reconnects instead.
 */
const APNS_SESSION_IDLE_MS = 4 * 60 * 1000;
/** Apple accepts a provider token for an hour and rejects refreshing it more than every 20 minutes. */
const APNS_PROVIDER_TOKEN_REFRESH_S = 50 * 60;
export const APNS_PRODUCTION_AUTHORITY = "https://api.push.apple.com";
export const APNS_SANDBOX_AUTHORITY = "https://api.sandbox.push.apple.com";
const APNS_TTL_SECONDS = 60 * 60;
const APNS_COLLAPSE_ID_MAX_BYTES = 64;

export interface ApnsRequest {
  pushType: "alert" | "background";
  priority: "10" | "5";
  collapseId?: string;
  body: Record<string, unknown>;
}

export interface ApnsDeliveryInput {
  registrationId: string;
  installationId: string;
  deviceToken: string;
  topic: string;
  env: "sandbox" | "production";
  request: ApnsRequest;
}

export interface ApnsPushProvider {
  send(input: ApnsDeliveryInput): Promise<ExternalSendResult>;
}

/**
 * `apns-collapse-id` is at most 64 bytes. Message ids fit; longer ids
 * (reminders: `reminder:<uuid>:<ISO time>`) are replaced by a stable hash, so
 * a resend of the same notification still replaces the earlier one.
 */
export function apnsCollapseId(id: string): string {
  if (Buffer.byteLength(id, "utf8") <= APNS_COLLAPSE_ID_MAX_BYTES) return id;
  return `h:${createHash("sha256").update(id).digest("base64url")}`.slice(0, APNS_COLLAPSE_ID_MAX_BYTES);
}

/**
 * The alert's collapse key. Ordinary channel chatter (category `channel`, an
 * `all`-level message) collapses per conversation: a newer one replaces the
 * older on the phone instead of stacking. Everything personal or eventful (a
 * mention, a DM, a task, a reminder, ...) keeps its own id, so later chatter
 * never replaces it; a resend still replaces itself.
 */
export function apnsCollapseKey(envelope: Pick<BuiltNotification["envelope"], "id" | "category" | "conversationId" | "groupKey">): string {
  return envelope.category === "channel" && envelope.conversationId ? envelope.groupKey : envelope.id;
}

/**
 * `aps.alert`: the English text, plus `title-loc-key` / `subtitle-loc-key` /
 * `loc-key` (and their args) for the keys in the registration's preview key
 * set (localizationKeys.ts). A key set 1 / 2 app gets exactly the keys it got
 * before key set 3: the redacted-preview ones.
 */
function apnsAlert(built: BuiltNotification, previewKeySet: number) {
  const keys = localizationInKeySet(built.push.localization, previewKeySet);
  return {
    title: built.push.title,
    ...(built.push.subtitle ? { subtitle: built.push.subtitle } : {}),
    body: built.push.body,
    ...(keys?.titleKey ? { "title-loc-key": keys.titleKey } : {}),
    ...(keys?.titleKey && keys.titleArgs?.length ? { "title-loc-args": keys.titleArgs } : {}),
    ...(keys?.subtitleKey ? { "subtitle-loc-key": keys.subtitleKey } : {}),
    ...(keys?.subtitleKey && keys.subtitleArgs?.length ? { "subtitle-loc-args": keys.subtitleArgs } : {}),
    ...(keys?.bodyKey ? { "loc-key": keys.bodyKey } : {}),
    ...(keys?.bodyKey && keys.bodyArgs?.length ? { "loc-args": keys.bodyArgs } : {}),
  };
}

/** The identity keys older iOS apps read (absent / null ones are omitted). */
function apnsIdentity(mobile: BuiltNotification["mobile"]): Record<string, unknown> {
  return {
    serverId: mobile.serverId,
    ...(mobile.channelId ? { channelId: mobile.channelId } : {}),
    ...(mobile.threadId ? { threadId: mobile.threadId } : {}),
    ...(mobile.parentChannelId ? { parentChannelId: mobile.parentChannelId } : {}),
    ...(mobile.parentMessageId ? { parentMessageId: mobile.parentMessageId } : {}),
    ...(mobile.messageId ? { messageId: mobile.messageId } : {}),
    ...(mobile.taskId ? { taskId: mobile.taskId } : {}),
    ...(mobile.taskConversationChannelId ? { taskConversationChannelId: mobile.taskConversationChannelId } : {}),
    ...(mobile.taskMessageId ? { taskMessageId: mobile.taskMessageId } : {}),
    // Null for events without a message (contract §4.1).
    kind: mobile.kind,
  };
}

/** The request body within APNS_PAYLOAD_MAX_BYTES: the alert body is cut first, then the subtitle, then the title. */
function fitApnsBody(body: Record<string, unknown>): Record<string, unknown> {
  if (jsonByteLength(body) <= APNS_PAYLOAD_MAX_BYTES) return body;
  const alert = (body.aps as { alert: Record<string, unknown> }).alert;
  for (const key of ["body", "subtitle", "title"] as const) {
    if (typeof alert[key] !== "string") continue;
    shrinkTextToFit(() => jsonByteLength(body), APNS_PAYLOAD_MAX_BYTES, () => alert[key] as string, (value) => { alert[key] = value; });
  }
  return body;
}

export function apnsAlertRequest(
  built: BuiltNotification,
  badge: number | undefined,
  extra: { testId?: string; serverBadge?: number; previewKeySet?: number } = {},
): ApnsRequest {
  const { envelope } = built;
  return {
    pushType: "alert",
    priority: "10",
    collapseId: apnsCollapseId(apnsCollapseKey(envelope)),
    body: fitApnsBody({
      aps: {
        alert: apnsAlert(built, extra.previewKeySet ?? 1),
        ...(badge !== undefined ? { badge } : {}),
        ...(envelope.silent ? {} : { sound: "default" }),
        // One stack per conversation (a thread reply: its thread; envelope.ts).
        // Retraction matches `groupKey`, not this.
        "thread-id": built.mobile.threadIdentifier,
        category: "RAFT_MESSAGE",
      },
      ...(extra.serverBadge !== undefined ? { serverBadge: extra.serverBadge } : {}),
      ...apnsIdentity(built.mobile),
      ...(built.mobile.kind === null ? { messageId: null, channelId: null, threadId: null, parentChannelId: null, parentMessageId: null } : {}),
      type: "alert",
      id: envelope.id,
      raftCategory: envelope.category,
      groupKey: envelope.groupKey,
      conversationId: envelope.conversationId,
      seq: envelope.seq,
      route: built.route,
      routeUrl: built.routeUrl,
      priority: envelope.priority,
      ...(extra.testId ? { testId: extra.testId } : {}),
    }),
  };
}

export function apnsBackgroundRequest(push: MobileBackgroundPush): ApnsRequest {
  const badge = {
    ...(push.badge !== undefined ? { badge: push.badge } : {}),
    ...(push.serverBadge !== undefined ? { serverBadge: push.serverBadge } : {}),
  };
  const body: Record<string, unknown> = push.type === "sync"
    ? { aps: { "content-available": 1 }, type: "sync", ...badge }
    : {
      aps: { "content-available": 1 },
      type: "retract",
      ...badge,
      serverId: push.serverId,
      groupKey: push.groupKey,
      conversationId: push.conversationId,
      throughSeq: push.throughSeq,
    };
  return { pushType: "background", priority: "5", body };
}

export interface ApnsHttpRequest {
  authority: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface ApnsHttpResponse {
  statusCode: number;
  body: string;
}

export type ApnsHttpClient = (request: ApnsHttpRequest) => Promise<ApnsHttpResponse>;

export class ApnsDeliveryError extends Error {
  statusCode?: number;
  reason?: string;

  constructor(message: string, opts: { statusCode?: number; reason?: string } = {}) {
    super(message);
    this.name = "ApnsDeliveryError";
    this.statusCode = opts.statusCode;
    this.reason = opts.reason;
  }
}

export class ApnsRequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`APNs request did not complete within ${timeoutMs}ms`);
    this.name = "ApnsRequestTimeoutError";
  }
}

export function parseApnsErrorReason(body: string): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { reason?: unknown };
    return typeof parsed.reason === "string" ? parsed.reason : undefined;
  } catch {
    return undefined;
  }
}

/** The default APNs topic allowlist: the bundle id of the Raft iOS app (every build and environment). */
export const DEFAULT_APNS_ALLOWED_TOPICS: readonly string[] = ["build.raft.app"];

/**
 * The APNs topics (bundle ids) this server pushes to: `APNS_ALLOWED_TOPICS`
 * (comma-separated) or DEFAULT_APNS_ALLOWED_TOPICS. Our provider key can only
 * push to our own apps; a registration from any other build (a fork or a
 * third-party app pointed at this server) would only ever get
 * TopicDisallowed, so it is refused at registration and revoked at send.
 */
export function apnsAllowedTopics(): readonly string[] {
  const configured = (process.env.APNS_ALLOWED_TOPICS ?? "")
    .split(",")
    .map((topic) => topic.trim())
    .filter(Boolean);
  return configured.length > 0 ? configured : DEFAULT_APNS_ALLOWED_TOPICS;
}

export function isAllowedApnsTopic(topic: string): boolean {
  return apnsAllowedTopics().includes(topic);
}

/** The registration's topic is not one this server pushes to: revoked without contacting Apple. */
export class ApnsTopicNotAllowedError extends Error {
  readonly reason = "topic_not_allowed";

  constructor() {
    super("APNs topic is not allowed on this server");
    this.name = "ApnsTopicNotAllowedError";
  }
}

/**
 * The registration can never deliver again: revoke it. 410 / BadDeviceToken
 * (the token is gone), DeviceTokenNotForTopic (the token belongs to another
 * app), and a topic outside the allowlist.
 *
 * TopicDisallowed / BadTopic for an allowlisted topic are not terminal: they
 * mean our provider key cannot push to our own app (a configuration error),
 * and revoking on them would wipe every iOS registration at once. They are
 * not retried either (isNonRetryableApnsError).
 */
export function isTerminalApnsTokenError(err: unknown): boolean {
  if (err instanceof ApnsTopicNotAllowedError) return true;
  if (!err || typeof err !== "object") return false;
  const candidate = err as { statusCode?: unknown; reason?: unknown };
  return candidate.statusCode === 410 || candidate.reason === "BadDeviceToken" || candidate.reason === "DeviceTokenNotForTopic";
}

/** The request itself was rejected (400 / 413): the same request cannot succeed. */
export function isNonRetryableApnsError(err: unknown): boolean {
  if (!(err instanceof ApnsDeliveryError)) return false;
  return err.statusCode === 400 || err.statusCode === 413;
}

export function isApnsConfigured(): boolean {
  return Boolean(process.env.APNS_KEY_ID && process.env.APNS_TEAM_ID && process.env.APNS_PRIVATE_KEY);
}

function apnsPrivateKey(): string {
  return process.env.APNS_PRIVATE_KEY!.replace(/\\n/g, "\n");
}

/**
 * One HTTP/2 connection per APNs host, reused by every request (Apple's
 * guidance; a TLS handshake per notification also made each send pay the
 * connect time). A connection that errors, is closed, receives GOAWAY or sat
 * idle for APNS_SESSION_IDLE_MS is forgotten, and the next request opens a
 * new one.
 */
const apnsSessions = new Map<string, http2.ClientHttp2Session>();

function forgetApnsSession(authority: string, session: http2.ClientHttp2Session): void {
  if (apnsSessions.get(authority) === session) apnsSessions.delete(authority);
}

function apnsSession(authority: string): http2.ClientHttp2Session {
  const existing = apnsSessions.get(authority);
  if (existing && !existing.closed && !existing.destroyed) return existing;
  const session = http2.connect(authority);
  apnsSessions.set(authority, session);
  const forget = () => forgetApnsSession(authority, session);
  // A session error rejects the requests on it (below); without a listener it would crash the process.
  session.on("error", forget);
  session.once("goaway", forget);
  session.once("close", forget);
  session.setTimeout(APNS_SESSION_IDLE_MS, () => {
    forget();
    session.close();
  });
  // An idle pooled connection never keeps the process alive.
  session.unref();
  return session;
}

/** Drops a connection that misbehaved (a request on it timed out). */
function discardApnsSession(authority: string, session: http2.ClientHttp2Session): void {
  forgetApnsSession(authority, session);
  session.destroy();
}

/**
 * Opens (or reuses) the connection to `authority` and resolves once it is
 * connected, so the first notification after a start does not pay DNS, TCP
 * and TLS. Bounded by `timeoutMs`; a failure leaves nothing pooled.
 */
export function warmApnsSession(authority: string, timeoutMs: number = APNS_REQUEST_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const session = apnsSession(authority);
    if (!session.connecting) {
      resolve();
      return;
    }
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearClockTimeout(timer);
      session.off("connect", onConnect);
      session.off("error", onError);
      if (error) {
        discardApnsSession(authority, session);
        reject(error);
      } else {
        resolve();
      }
    };
    const onConnect = () => finish();
    const onError = (error: Error) => finish(error);
    const timer = setClockTimeout(() => finish(new ApnsRequestTimeoutError(timeoutMs)), timeoutMs);
    session.once("connect", onConnect);
    session.once("error", onError);
  });
}

/** Closes every pooled APNs connection (tests, shutdown). */
export function closeApnsSessions(): void {
  for (const [authority, session] of [...apnsSessions]) discardApnsSession(authority, session);
}

/**
 * Every APNs request ends within a bounded time: the dispatcher may call it
 * while a transaction is open, and an unanswered connect or stream would
 * otherwise hold it until Postgres kills it. A timeout is a transient failure,
 * and the connection it happened on is dropped so a retry reconnects.
 *
 * @internal Exported so the timeout can be verified against a local HTTP/2 server.
 */
export function createApnsHttpClient(timeoutMs: number): ApnsHttpClient {
  return (request) => new Promise((resolve, reject) => {
    let session: http2.ClientHttp2Session;
    try {
      session = apnsSession(request.authority);
    } catch (err) {
      reject(err);
      return;
    }
    let statusCode = 0;
    const chunks: Buffer[] = [];
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearClockTimeout(timer);
      fn();
    };

    const timer = setClockTimeout(() => {
      if (settled) return;
      settled = true;
      discardApnsSession(request.authority, session);
      reject(new ApnsRequestTimeoutError(timeoutMs));
    }, timeoutMs);

    // A session that fails or closes destroys its streams with the error, so
    // the stream's own events settle every request on it.
    let stream: http2.ClientHttp2Stream;
    try {
      stream = session.request({
        ":method": "POST",
        ":path": request.path,
        ...request.headers,
      });
    } catch (err) {
      // The session closed between the pool lookup and the request.
      forgetApnsSession(request.authority, session);
      finish(() => reject(err));
      return;
    }

    stream.once("response", (headers) => {
      const headerStatus = headers[":status"];
      statusCode = typeof headerStatus === "number" ? headerStatus : Number(headerStatus ?? 0);
    });
    stream.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.once("error", (err) => finish(() => reject(err)));
    stream.once("end", () => finish(() => resolve({
      statusCode,
      body: Buffer.concat(chunks).toString("utf8"),
    })));
    // Closed without a complete response (the session went away mid-request).
    stream.once("close", () => finish(() => reject(new ApnsDeliveryError("APNs stream closed before a response"))));
    stream.end(JSON.stringify(request.body));
  });
}

let cachedProviderToken: { key: string; token: string; issuedAt: number } | null = null;

/**
 * The provider JWT, minted once and reused for APNS_PROVIDER_TOKEN_REFRESH_S
 * (Apple answers TooManyProviderTokenUpdates to a new token per request).
 */
function apnsProviderToken(nowSeconds: number): string {
  const teamId = process.env.APNS_TEAM_ID!;
  const keyId = process.env.APNS_KEY_ID!;
  const privateKey = apnsPrivateKey();
  const key = `${teamId}\0${keyId}\0${privateKey}`;
  const cached = cachedProviderToken;
  if (cached && cached.key === key && nowSeconds >= cached.issuedAt && nowSeconds - cached.issuedAt < APNS_PROVIDER_TOKEN_REFRESH_S) {
    return cached.token;
  }
  const token = jwt.sign(
    { iss: teamId, iat: nowSeconds },
    privateKey,
    { algorithm: "ES256", header: { alg: "ES256", kid: keyId } },
  );
  cachedProviderToken = { key, token, issuedAt: nowSeconds };
  return token;
}

/**
 * Boot warm-up: mints the provider token and opens the production
 * connection, so the first notifications after a start skip both. Does
 * nothing when APNs is not configured; rejects when the connection fails
 * (warmNotificationTransports logs it and the first send connects itself).
 */
export async function warmApnsTransport(timeoutMs: number = APNS_REQUEST_TIMEOUT_MS): Promise<"warmed" | "not_configured"> {
  if (!isApnsConfigured()) return "not_configured";
  apnsProviderToken(Math.floor(currentTimeMs() / 1000));
  await warmApnsSession(APNS_PRODUCTION_AUTHORITY, timeoutMs);
  return "warmed";
}

let apnsHttpClient: ApnsHttpClient = createApnsHttpClient(APNS_REQUEST_TIMEOUT_MS);

class ConfiguredApnsPushProvider implements ApnsPushProvider {
  async send(input: ApnsDeliveryInput): Promise<ExternalSendResult> {
    // An external HTTP/2 round-trip; reported so the transaction audit sees it.
    recordExternalSinkInsideTransaction("apns");
    if (!isApnsConfigured()) return { status: "skipped", reason: "provider_not_configured" };

    const nowSeconds = Math.floor(currentTimeMs() / 1000);
    const token = apnsProviderToken(nowSeconds);
    const authority = input.env === "sandbox" ? APNS_SANDBOX_AUTHORITY : APNS_PRODUCTION_AUTHORITY;
    const response = await apnsHttpClient({
      authority,
      path: `/3/device/${input.deviceToken}`,
      headers: {
        authorization: `bearer ${token}`,
        "content-type": "application/json",
        "apns-expiration": String(nowSeconds + APNS_TTL_SECONDS),
        "apns-priority": input.request.priority,
        "apns-push-type": input.request.pushType,
        "apns-topic": input.topic,
        ...(input.request.collapseId ? { "apns-collapse-id": input.request.collapseId } : {}),
      },
      body: input.request.body,
    });

    if (response.statusCode >= 200 && response.statusCode < 300) return { status: "sent" };

    const reason = parseApnsErrorReason(response.body);
    // A rejected provider token is minted again on the retry.
    if (reason === "ExpiredProviderToken" || reason === "InvalidProviderToken") cachedProviderToken = null;
    throw new ApnsDeliveryError("APNs rejected mobile push", {
      statusCode: response.statusCode,
      reason,
    });
  }
}

let apnsPushProvider: ApnsPushProvider = new ConfiguredApnsPushProvider();

export const apnsTransport = {
  async send(target: MobileRegistrationTarget, request: ApnsRequest): Promise<ExternalSendResult> {
    if (!isAllowedApnsTopic(target.topic)) throw new ApnsTopicNotAllowedError();
    return apnsPushProvider.send({
      registrationId: target.id,
      installationId: target.installationId,
      deviceToken: target.deviceToken,
      topic: target.topic,
      env: target.env,
      request,
    });
  },
  /** 410, BadDeviceToken, DeviceTokenNotForTopic or a topic outside the allowlist: revoke the registration. */
  isTerminalTargetError: isTerminalApnsTokenError,
  /**
   * A 400 (TopicDisallowed, BadTopic, DeviceTokenNotForTopic, MissingTopic,
   * BadPriority, ...) or 413 describes the request itself: the same request
   * fails the same way, so it is not retried (a retry only held the drain for
   * its back-off). Every other failure (403 token trouble, 429, 5xx,
   * timeouts, a dropped connection) may be retried.
   */
  isNonRetryable: isNonRetryableApnsError,
  isConfigured: isApnsConfigured,
};

export function __setApnsPushProviderForTests(provider: ApnsPushProvider) {
  apnsPushProvider = provider;
}

export function __resetApnsPushProviderForTests() {
  apnsPushProvider = new ConfiguredApnsPushProvider();
  cachedProviderToken = null;
}

export function __setApnsHttpClientForTests(client: ApnsHttpClient) {
  apnsHttpClient = client;
}

export function __resetApnsHttpClientForTests() {
  apnsHttpClient = createApnsHttpClient(APNS_REQUEST_TIMEOUT_MS);
}
