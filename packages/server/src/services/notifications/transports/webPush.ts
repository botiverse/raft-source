/**
 * Web Push transport (docs/contracts/notifications.md §4.4): the envelope
 * with an absolute `url`, plus `title` / `body` / `tag` for older service
 * workers, sent to one browser subscription.
 *
 * Subscriptions may predate endpoint validation, so every send re-checks the
 * endpoint host and pins the connection to the vetted public address.
 *
 * Only the known browser push services are delivered to
 * (isAllowedWebPushEndpoint); a subscription on any other host is skipped
 * without being contacted (and kept), one under `.invalid` (a browser's
 * removed subscription) is deleted.
 *
 * The transport never touches the database (the dispatcher calls it inside a
 * transaction). An endpoint that is not a public HTTPS host, that the push
 * service reports gone (404 / 410), or that the push service says was created
 * for another VAPID key (a subscription left from an earlier key) throws an
 * error for which `isTerminalTargetError` is true: the caller deletes the
 * subscription (`deleteWebPushSubscription`). A DNS failure or a timeout is
 * transient.
 */
import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { Agent as HttpsAgent } from "node:https";
import { isIP } from "node:net";
import { eq } from "drizzle-orm";
import webpush from "web-push";
import { formatPushSurfaceTitle, PUSH_ENDPOINT_HASH_LENGTH } from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../../../db/index";
import { pushSubscriptions } from "../../../db/schema";
import { createAppWebhookPinnedLookup } from "../../appNotificationDeliveryService";
import { isPublicWebhookAddress } from "../../appWebhookConfigService";
import type { BuiltNotification, ExternalSendResult, WebPushSubscriptionTarget } from "../types";
import { WEB_PUSH_PAYLOAD_MAX_BYTES, jsonByteLength, shrinkTextToFit } from "./payloadBudget";

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:contact@raft.build";
const WEB_PUSH_TTL_SECONDS = 60 * 60;
/**
 * Like APNs and FCM, a push service that accepts the connection and never
 * answers must not hold the drain (and its transaction) open: the socket
 * times out and the attempt is retried as a transient failure.
 */
export const WEB_PUSH_REQUEST_TIMEOUT_MS = 5_000;

const vapidConfigured = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

if (vapidConfigured) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn("[WebPush] VAPID keys not configured — web push disabled");
}

export type WebPushResolvedAddress = { address: string; family: number };
export type WebPushLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<WebPushResolvedAddress[]>;

export type WebPushRuntime = {
  enabled: boolean;
  lookup: WebPushLookup;
  sendNotification: typeof webpush.sendNotification;
};

const defaultWebPushRuntime: WebPushRuntime = {
  enabled: vapidConfigured,
  lookup: (hostname, options) => dnsLookup(hostname, options),
  sendNotification: (subscription, payload, options) => webpush.sendNotification(subscription, payload, options),
};

let webPushRuntime: WebPushRuntime = defaultWebPushRuntime;

export function __setWebPushRuntimeForTests(runtime: Partial<WebPushRuntime>) {
  webPushRuntime = { ...defaultWebPushRuntime, ...runtime };
}

export function __resetWebPushRuntimeForTests() {
  webPushRuntime = defaultWebPushRuntime;
}

export function isWebPushEnabled(): boolean {
  return webPushRuntime.enabled;
}

export function getVapidPublicKey(): string {
  return VAPID_PUBLIC_KEY;
}

/**
 * Hostname of a Web Push endpoint the server may deliver to: an absolute,
 * credential-free `https:` URL naming a public DNS host. IP literals and
 * loopback or link-local style names are refused so a subscriber cannot point
 * the server's push egress at internal services; the resolved addresses are
 * checked again at send time. Returns null for anything else.
 */
export function webPushEndpointHostname(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!hostname || isIP(hostname)) return null;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return null;
  if (hostname.endsWith(".local") || hostname.endsWith(".internal")) return null;
  return hostname;
}

/**
 * The address the connection will be pinned to. `null`: the endpoint is
 * permanently undeliverable (not a public HTTPS host, or it resolves to a
 * private or special-use address). A lookup failure propagates so transient
 * DNS trouble is not mistaken for a bad endpoint.
 */
export async function resolvePublicWebPushAddress(endpoint: string): Promise<WebPushResolvedAddress | null> {
  const hostname = webPushEndpointHostname(endpoint);
  if (!hostname) return null;
  const addresses = await lookupWithDeadline(hostname);
  if (addresses.length === 0 || addresses.some((entry) => !isPublicWebhookAddress(entry.address))) return null;
  return addresses[0];
}

/** The stored endpoint is not a public HTTPS host (or resolves to a non-public address). */
export class WebPushEndpointRejectedError extends Error {
  readonly reason = "endpoint_not_public";

  constructor() {
    super("Web Push endpoint is not a public HTTPS host");
    this.name = "WebPushEndpointRejectedError";
  }
}

/** The push service reported the subscription gone (404 / 410). */
export class WebPushSubscriptionGoneError extends Error {
  statusCode: number;

  constructor(statusCode: number) {
    super(`Web Push subscription is gone (HTTP ${statusCode})`);
    this.name = "WebPushSubscriptionGoneError";
    this.statusCode = statusCode;
  }
}

/** The push service behind an endpoint, for diagnostics (never the endpoint itself). */
export type WebPushService = "fcm" | "mozilla" | "apple" | "wns" | "other";

/**
 * Google's push hosts, exactly (never all of google.com): FCM's production
 * endpoint, which also serves the `/wp/` Web Push and `/preprod/wp/` paths; the
 * `jmt17.google.com/fcm/send/` endpoint Chrome issues as its alternate (staging)
 * GCM endpoint (components/push_messaging/push_messaging_constants.cc,
 * kPushMessagingStagingGcmEndpoint; hundreds of live production
 * subscriptions use it); and the legacy GCM host of old subscriptions.
 */
const GOOGLE_PUSH_HOSTS: ReadonlySet<string> = new Set(["fcm.googleapis.com", "jmt17.google.com", "android.googleapis.com"]);

export function webPushService(endpoint: string): WebPushService {
  const hostname = webPushEndpointHostname(endpoint) ?? "";
  if (GOOGLE_PUSH_HOSTS.has(hostname)) return "fcm";
  if (hostname.endsWith(".push.services.mozilla.com")) return "mozilla";
  if (hostname === "web.push.apple.com") return "apple";
  if (hostname.endsWith(".notify.windows.com")) return "wns";
  return "other";
}

/**
 * True when the endpoint is on a known browser push service (FCM, Mozilla
 * autopush, Apple Web Push, Windows WNS). Only those are subscribed to and
 * delivered to: a subscription on any other host (a self-hosted or
 * third-party "push service") would receive our encrypted notification
 * payloads and make the server POST to a host of the subscriber's choosing.
 */
export function isAllowedWebPushEndpoint(endpoint: unknown): boolean {
  return typeof endpoint === "string" && webPushEndpointHostname(endpoint) !== null && webPushService(endpoint) !== "other";
}

/**
 * An endpoint under the reserved `.invalid` TLD: what a browser leaves when
 * it removed the subscription (e.g. `permanently-removed.invalid`). It can
 * never deliver: deleted like a 404 / 410.
 */
export function isRemovedWebPushEndpoint(endpoint: string): boolean {
  const hostname = webPushEndpointHostname(endpoint);
  return hostname !== null && (hostname === "invalid" || hostname.endsWith(".invalid"));
}

/** The browser marked the subscription removed (`.invalid` host): the caller deletes it. */
export class WebPushEndpointRemovedError extends Error {
  readonly reason = "endpoint_removed";

  constructor() {
    super("Web Push endpoint was removed by the browser");
    this.name = "WebPushEndpointRemovedError";
  }
}

/** Unsupported hosts already logged by this process (one line per host, not per send). */
const loggedUnsupportedHosts = new Set<string>();

/**
 * A short, content-free reason from a push service's error body: Apple's
 * JSON `reason` (e.g. `VapidPkHashMismatch`), Mozilla's JSON `errno`, or a
 * known phrase of FCM's plain-text body. Null when nothing is recognised.
 */
export function webPushFailureDetail(body: unknown): string | null {
  if (typeof body !== "string" || !body) return null;
  try {
    const parsed = JSON.parse(body) as { reason?: unknown; errno?: unknown };
    if (typeof parsed.reason === "string" && /^[A-Za-z_]{1,64}$/.test(parsed.reason)) return parsed.reason;
    if (typeof parsed.errno === "number" && Number.isInteger(parsed.errno)) return `errno_${parsed.errno}`;
  } catch {
    // FCM answers in plain text.
  }
  if (/do(?:es)? not correspond/i.test(body)) return "credentials_mismatch";
  if (/UnauthorizedRegistration/.test(body)) return "UnauthorizedRegistration";
  return null;
}

const WEB_PUSH_BODY_EXCERPT_MAX = 48;
const WEB_PUSH_HOST_LABEL_MAX = 64;

/**
 * A bounded, scrubbed excerpt of an error body nothing in
 * webPushFailureDetail recognised, so a readback can still tell an empty
 * answer from an unexpected one. HTML tags, URLs (kept as their host), email
 * addresses and every long token-like run (subscription ids, keys, JWTs) are
 * removed first; what is left is cut to a short run of plain characters.
 */
export function webPushBodyExcerpt(body: unknown): string {
  if (typeof body !== "string" || !body.trim()) return "empty_body";
  const scrubbed = body
    .slice(0, 4096)
    .replace(/<[^>]*>/g, " ")
    .replace(/[a-z][a-z0-9+.-]*:\/\/([^\s/?#"'<>]+)[^\s"'<>]*/gi, (_match, host: string) => host.replace(/^[^@]*@/, ""))
    .replace(/[^\s@]+@[^\s@]+/g, "<email>")
    .replace(/[A-Za-z0-9_+/=.-]{20,}/g, "<redacted>")
    .replace(/[^A-Za-z0-9 ._,'()<>-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, WEB_PUSH_BODY_EXCERPT_MAX)
    .trim();
  return scrubbed ? `text(${scrubbed})` : "unreadable_body";
}

/**
 * The service part of a failure reason: the known service, or for any other
 * push service its host (`other=<host>`), never the endpoint path (which is
 * the subscription's capability).
 */
export function webPushServiceLabel(endpoint: string): string {
  const service = webPushService(endpoint);
  if (service !== "other") return service;
  const hostname = webPushEndpointHostname(endpoint);
  return hostname ? `other=${hostname.slice(0, WEB_PUSH_HOST_LABEL_MAX)}` : "other";
}

/**
 * Details meaning the subscription was created with another VAPID public key
 * than the one the server signs with (it predates a key change and the
 * browser has not been reopened to subscribe again). Every send to it fails
 * the same way, so it is deleted like a 404 / 410. A 403 without such a
 * detail (an invalid JWT, a service outage) is not proof the subscription is
 * dead and leaves it alone: deleting on any 403 would wipe every subscription
 * of a service the day the server's own VAPID configuration breaks.
 */
const WEB_PUSH_KEY_MISMATCH_DETAILS: ReadonlySet<string> = new Set([
  "VapidPkHashMismatch",
  "credentials_mismatch",
  "UnauthorizedRegistration",
]);

/** The push service rejected the request (any status other than 404 / 410). */
export class WebPushRequestError extends Error {
  readonly statusCode: number;
  /**
   * `status_<code>:<service>:<detail>`, recorded as the failure reason.
   * `<service>` is the known service or `other=<host>`; `<detail>` is a
   * recognised reason, else `text(<scrubbed excerpt>)` or `empty_body`.
   */
  readonly reason: string;
  /** The subscription belongs to another VAPID key: delete it. */
  readonly subscriptionKeyMismatch: boolean;

  constructor(statusCode: number, service: string, detail: string | null, body?: unknown) {
    super(`Web Push request rejected (HTTP ${statusCode})`);
    this.name = "WebPushRequestError";
    this.statusCode = statusCode;
    this.reason = `status_${statusCode}:${service}:${detail ?? webPushBodyExcerpt(body)}`;
    this.subscriptionKeyMismatch = (statusCode === 400 || statusCode === 401 || statusCode === 403)
      && detail !== null && WEB_PUSH_KEY_MISMATCH_DETAILS.has(detail);
  }
}

/**
 * No HTTP answer (name resolution, connect, TLS, socket timeout): transient.
 * `network_<code>:<service>` names what failed without the endpoint.
 */
export class WebPushNetworkError extends Error {
  readonly reason: string;

  constructor(code: string, service: string) {
    super(`Web Push request failed before an answer (${code})`);
    this.name = "WebPushNetworkError";
    this.reason = `network_${code}:${service}`;
  }
}

function networkErrorCode(err: unknown): string {
  const candidate = err as { code?: unknown; message?: unknown } | null;
  if (typeof candidate?.code === "string" && /^[A-Z0-9_]{1,32}$/.test(candidate.code)) return candidate.code;
  if (candidate?.message === "Socket timeout") return "socket_timeout";
  return err instanceof Error && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : "unknown";
}

/**
 * Name resolution of a push host is bounded like the request itself: a
 * getaddrinfo that waits on resolver timeouts (or queues behind a busy libuv
 * thread pool on a fresh pod) would otherwise hold the drain unbounded,
 * outside the request's own socket timeout.
 */
export const WEB_PUSH_LOOKUP_TIMEOUT_MS = 2_000;

async function lookupWithDeadline(hostname: string): Promise<WebPushResolvedAddress[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("Web Push host lookup timed out"), { code: "LOOKUP_TIMEOUT" })), WEB_PUSH_LOOKUP_TIMEOUT_MS);
  });
  try {
    return await Promise.race([webPushRuntime.lookup(hostname, { all: true, verbatim: true }), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function webPushStatusCode(err: unknown): number | null {
  const statusCode = (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof statusCode === "number" ? statusCode : null;
}

/** Deletes a subscription after a terminal error (call outside any held transaction). */
export async function deleteWebPushSubscription(id: string, executor: DatabaseExecutor = getDb()): Promise<void> {
  await executor.delete(pushSubscriptions).where(eq(pushSubscriptions.id, id));
}

/**
 * What public/sw.js reads (title, body, url, tag / groupKey, seq, id, silent,
 * testId) plus the envelope identity; everything else is dropped first when
 * the payload is over budget.
 */
const WEB_PUSH_CORE_KEYS: ReadonlySet<string> = new Set([
  "v", "id", "kind", "event", "category", "priority", "title", "body", "url", "tag", "renotify", "silent",
  "groupKey", "seq", "conversationId", "serverId", "createdAt", "testId",
]);
/** Optional fields, the largest and least useful first (public/sw.js shows the English text; it does not read `localization`). */
const WEB_PUSH_DROP_FIRST = ["localization", "task", "agent", "subtitle", "sender", "target", "route", "serverName"];

/**
 * The payload within WEB_PUSH_PAYLOAD_MAX_BYTES: optional envelope fields go
 * first, then the body is cut, then the title. A push service answers 413 to
 * anything larger and the notification is lost.
 */
export function fitWebPushPayload(
  payload: Record<string, unknown>,
  maxBytes: number = WEB_PUSH_PAYLOAD_MAX_BYTES,
): Record<string, unknown> {
  if (jsonByteLength(payload) <= maxBytes) return payload;
  const fitted: Record<string, unknown> = { ...payload };
  const optional = [...WEB_PUSH_DROP_FIRST, ...Object.keys(fitted).filter((key) => !WEB_PUSH_CORE_KEYS.has(key))];
  for (const key of optional) {
    if (jsonByteLength(fitted) <= maxBytes) return fitted;
    delete fitted[key];
  }
  for (const key of ["body", "title"] as const) {
    if (typeof fitted[key] !== "string") continue;
    shrinkTextToFit(() => jsonByteLength(fitted), maxBytes, () => fitted[key] as string, (value) => { fitted[key] = value; });
  }
  return fitted;
}

/** Push text style; `tag` = the conversation group so one browser notification per conversation. */
export function webPushPayload(
  built: BuiltNotification,
  appUrl: string,
  extra: { testId?: string } = {},
): Record<string, unknown> {
  const { envelope } = built;
  return fitWebPushPayload({
    ...envelope,
    // A browser notification has no subtitle: the context (server label for a
    // receiver of 2+ servers) joins the title.
    title: built.push.subtitle ? formatPushSurfaceTitle(built.push.title, built.push.subtitle) : built.push.title,
    body: built.push.body,
    tag: envelope.groupKey,
    renotify: true,
    silent: envelope.silent,
    url: `${appUrl}${built.routeUrl}`,
    groupKey: envelope.groupKey,
    seq: envelope.seq,
    id: envelope.id,
    ...(extra.testId ? { testId: extra.testId } : {}),
  });
}

export const webPushTransport = {
  async send(subscription: WebPushSubscriptionTarget, payload: Record<string, unknown>): Promise<ExternalSendResult> {
    if (!webPushRuntime.enabled) return { status: "skipped", reason: "provider_not_configured" };
    if (isRemovedWebPushEndpoint(subscription.endpoint)) throw new WebPushEndpointRemovedError();
    // A subscription saved before the host allowlist, on a host that is not a
    // known push service: skipped (never contacted) and logged, but kept, so a
    // legitimate push host missing from the list is noticed, not wiped.
    const hostname = webPushEndpointHostname(subscription.endpoint);
    if (hostname !== null && !isAllowedWebPushEndpoint(subscription.endpoint)) {
      if (!loggedUnsupportedHosts.has(hostname)) {
        loggedUnsupportedHosts.add(hostname);
        console.warn(`[WebPush] skipping subscriptions on unsupported push host ${hostname.slice(0, 64)}`);
      }
      return { status: "skipped", reason: `unsupported_host:${hostname.slice(0, 64)}` };
    }
    let pinned: WebPushResolvedAddress | null;
    try {
      pinned = await resolvePublicWebPushAddress(subscription.endpoint);
    } catch (err: unknown) {
      throw new WebPushNetworkError(`lookup_${networkErrorCode(err)}`, webPushServiceLabel(subscription.endpoint));
    }
    if (!pinned) throw new WebPushEndpointRejectedError();
    try {
      await webPushRuntime.sendNotification(
        { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
        JSON.stringify(payload),
        {
          TTL: WEB_PUSH_TTL_SECONDS,
          timeout: WEB_PUSH_REQUEST_TIMEOUT_MS,
          agent: new HttpsAgent({ lookup: createAppWebhookPinnedLookup(pinned) as never }),
        },
      );
    } catch (err: unknown) {
      const statusCode = webPushStatusCode(err);
      if (statusCode === 404 || statusCode === 410) throw new WebPushSubscriptionGoneError(statusCode);
      const body = (err as { body?: unknown } | null)?.body;
      if (statusCode !== null) {
        throw new WebPushRequestError(statusCode, webPushServiceLabel(subscription.endpoint), webPushFailureDetail(body), body);
      }
      throw new WebPushNetworkError(networkErrorCode(err), webPushServiceLabel(subscription.endpoint));
    }
    return { status: "sent" };
  },
  /** True: the caller deletes the subscription (non-public endpoint, 404 / 410, or another VAPID key). */
  isTerminalTargetError(err: unknown): boolean {
    if (err instanceof WebPushEndpointRejectedError || err instanceof WebPushSubscriptionGoneError) return true;
    if (err instanceof WebPushEndpointRemovedError) return true;
    if (err instanceof WebPushRequestError) return err.subscriptionKeyMismatch;
    const statusCode = webPushStatusCode(err);
    return statusCode === 404 || statusCode === 410;
  },
  /** Terminal errors, and any other 4xx except 408 / 429: the same request cannot succeed. */
  isNonRetryable(err: unknown): boolean {
    if (err instanceof WebPushEndpointRejectedError || err instanceof WebPushEndpointRemovedError) return true;
    const statusCode = webPushStatusCode(err);
    return statusCode !== null && statusCode >= 400 && statusCode < 500 && statusCode !== 408 && statusCode !== 429;
  },
  isConfigured: isWebPushEnabled,
};

/**
 * The id a browser reports for its own subscription (contract §5,
 * PUSH_ENDPOINT_HASH_LENGTH): base64url SHA-256 of the endpoint, cut short.
 * The web computes the same with SubtleCrypto (presenceReport.ts).
 */
export function pushEndpointHash(endpoint: string): string {
  return createHash("sha256").update(endpoint, "utf8").digest("base64url").slice(0, PUSH_ENDPOINT_HASH_LENGTH);
}
