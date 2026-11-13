// Product analytics call surface (RFC-067).
//
// Events and their properties are declared in the shared registry
// (PRODUCT_EVENT_REGISTRY in @botiverse/raft-shared), which server ingest
// also validates against. Add one only with the event-registry owner's
// sign-off, never as a side effect of feature work (RFC-067 §3.2).
//
// Sending: events queue in memory and flush in batches to
// POST /api/product-events/batch for the server they happened in. Before the
// first batch for a server, the tab asks GET /api/product-events/config
// whether this user may send there (their "share usage data" choice and the
// workspace switch); if not, events for that server are dropped here and never
// leave the browser. Nothing is retried: a failed batch is dropped. A caller
// that keeps an event until the server has taken it, and sends it again
// otherwise, asks for `onDelivery` (its own batch, judged by the answer's
// `accepted` or `duplicates`). Taken means queued for the server's writer,
// not yet stored.

import type { ProductEventName, ProductEventProperties } from "@botiverse/raft-shared";
import { RUNTIME_API_BASE } from "../runtimeEndpoints";
import { isInstalledWebApp } from "../utils/clientPlatformHint";
import { isElectronDesktopShell } from "../utils/desktopShell";
import { getDesktopBridge } from "../utils/desktopBridge";
import { WEB_APP_VERSION } from "../utils/webAppVersion";
import { isPrivacyModeOn, isPrivacyModeUnknown, subscribePrivacyMode } from "../store/privacyMode";

const FLUSH_DELAY_MS = 10_000;
const NAVIGATION_FLUSH_TIMEOUT_MS = 750;
const MAX_BATCH_EVENTS = 100;
const MAX_QUEUED_EVENTS = 500;
const TOKEN_KEY = "slock_access_token";

interface QueuedEvent {
  serverId: string;
  /** Wants to know whether the server queued it for the store (TrackEventOptions.onDelivery): sent in a batch of its own. */
  onDelivery?: (delivered: boolean) => void;
  body: {
    uuid: string;
    event: ProductEventName;
    timestamp: string;
    client_session_id: string;
    properties: Record<string, string | number | boolean>;
  };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

// This tab's product-analytics session: random per page load and deliberately
// NOT the trace tabId, so product events cannot be joined to traces (which
// carry a stable per-user id) and re-linked after the user stops sharing.
const productSessionId: string = crypto.randomUUID();

let queue: QueuedEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
// Per server: undefined = not asked yet, a promise while asking, then the answer.
const allowedByServer = new Map<string, boolean | Promise<boolean>>();
let serverIdGetter: () => string | undefined = () => undefined;
let fetchOverride: FetchLike | null = null;

/** Wired by serverStore, so this module does not import the store. */
export function setProductEventServerIdGetter(getter: () => string | undefined): void {
  serverIdGetter = getter;
}

/** Snapshot the current analytics server before an async flow can change it. */
export function getProductEventServerId(): string | undefined {
  return serverIdGetter();
}

export interface TrackEventOptions {
  /**
   * Pins the event to the server a flow started in, for flows that finish
   * later (the user may have switched servers by then). Without it the event
   * goes to the current server.
   */
  serverId?: string;
  /** The event's own uuid (one the caller may send again: ingest drops a repeat). Random by default. */
  uuid?: string;
  /**
   * For an event the caller keeps until the server has taken it (and sends
   * again otherwise): it goes in a batch of its own, and this is told `true`
   * once that batch's answer says it was accepted (or queued before on that
   * replica): queued for the writer, not yet stored. `false` when it was dropped
   * here, refused or not answered. Never told twice; maybe never (the page
   * went away first).
   */
  onDelivery?: (delivered: boolean) => void;
}

export function trackEvent<E extends ProductEventName>(
  event: E,
  ...[props, options = {}]: {} extends ProductEventProperties<E>
    ? [props?: ProductEventProperties<E>, options?: TrackEventOptions]
    : [props: ProductEventProperties<E>, options?: TrackEventOptions]
): void {
  const serverId = options.serverId ?? serverIdGetter();
  if (isPrivacyModeOn() || !serverId || allowedByServer.get(serverId) === false || queue.length >= MAX_QUEUED_EVENTS) {
    options.onDelivery?.(false);
    return;
  }
  const properties: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value !== undefined) properties[key] = value as string | number | boolean;
  }
  queue.push({
    serverId,
    ...(options.onDelivery ? { onDelivery: options.onDelivery } : {}),
    body: {
      uuid: options.uuid ?? crypto.randomUUID(),
      event,
      timestamp: new Date().toISOString(),
      client_session_id: productSessionId,
      properties,
    },
  });
  scheduleFlush();
}

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushProductEvents();
  }, FLUSH_DELAY_MS);
}

function getFetch(): FetchLike {
  return fetchOverride ?? ((input, init) => fetch(input, init));
}

// Which client sends (xxchan, 2026-10-22, task #13): the server turns this
// into the `platform` column. The desktop app reports itself as `desktop` with
// its own version, plus the web build it embeds (`web_version`); the web says
// whether it runs as an installed app (`display_mode`), and the server tells
// phone from computer by the User-Agent.
const CLIENT_VERSION = /^[0-9A-Za-z._+-]{1,64}$/;
// The desktop app's version, once its bridge has answered. Asked once at
// load; a flush never waits for it (John, Tenny): a batch sent before the
// answer goes without app_version but still says `desktop` and web_version.
let desktopAppVersionAsked = false;
let desktopAppVersion: string | undefined;

function askDesktopAppVersion(): void {
  if (desktopAppVersionAsked) return;
  desktopAppVersionAsked = true;
  try {
    void getDesktopBridge()?.getAppVersion?.()
      .then((version) => {
        if (typeof version === "string" && CLIENT_VERSION.test(version)) desktopAppVersion = version;
      })
      .catch(() => undefined);
  } catch {
    // No bridge: batches go without the desktop app's version.
  }
}

if (isElectronDesktopShell()) askDesktopAppVersion();

function webDisplayMode(): "standalone" | "browser" {
  return isInstalledWebApp() ? "standalone" : "browser";
}

function clientEnvelope(): Record<string, string> {
  if (isElectronDesktopShell()) {
    askDesktopAppVersion();
    return { source: "desktop", ...(desktopAppVersion ? { app_version: desktopAppVersion } : {}), web_version: WEB_APP_VERSION };
  }
  return { source: "web", app_version: WEB_APP_VERSION, display_mode: webDisplayMode() };
}

function headers(token: string, serverId: string): Record<string, string> {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-Server-Id": serverId };
}

async function askAllowed(serverId: string, token: string, keepalive = false): Promise<boolean> {
  try {
    const response = await getFetch()(`${RUNTIME_API_BASE}/product-events/config`, {
      headers: headers(token, serverId),
      keepalive,
    });
    if (!response.ok) return false;
    const data = (await response.json()) as { clientEventsAllowed?: unknown };
    return data.clientEventsAllowed === true;
  } catch {
    return false;
  }
}

/**
 * Sends queued events. Never throws and never touches auth state (a 401 is
 * just a dropped batch). Ordinary `onPageHide` sends only to servers already
 * known to allow events. A caller that is still in control before terminal
 * navigation may opt into one last consent lookup; both requests use
 * keepalive because the page may disappear while they finish.
 */
export async function flushProductEvents(options: { onPageHide?: boolean; allowConsentLookup?: boolean } = {}): Promise<void> {
  if (flushing && !options.onPageHide) return;
  const token = globalThis.localStorage?.getItem(TOKEN_KEY) ?? null;
  // RAFT_PRIVACY_MODE: events queued before the client config said so are dropped, unsent.
  if (!token || isPrivacyModeOn()) {
    for (const entry of queue) entry.onDelivery?.(false);
    queue = [];
    return;
  }
  // Not answered yet: keep the queue (capped by trackEvent); the answer flushes it.
  if (isPrivacyModeUnknown()) return;
  flushing = true;
  try {
    const pending = queue;
    queue = [];
    const envelope = clientEnvelope();
    const byServer = new Map<string, { events: QueuedEvent["body"][]; tracked: QueuedEvent[] }>();
    for (const entry of pending) {
      const group = byServer.get(entry.serverId) ?? { events: [], tracked: [] };
      if (entry.onDelivery) group.tracked.push(entry);
      else group.events.push(entry.body);
      byServer.set(entry.serverId, group);
    }
    for (const [serverId, { events, tracked }] of byServer) {
      let allowed = allowedByServer.get(serverId);
      if (allowed === undefined && (!options.onPageHide || options.allowConsentLookup)) {
        allowed = askAllowed(serverId, token, options.onPageHide === true);
        allowedByServer.set(serverId, allowed);
      }
      if ((await allowed) !== true) {
        if (allowed !== undefined) allowedByServer.set(serverId, false);
        for (const entry of tracked) entry.onDelivery?.(false);
        continue;
      }
      allowedByServer.set(serverId, true);
      // One batch each: the answer's `accepted` count is then this event's.
      for (const entry of tracked) {
        let delivered = false;
        try {
          const response = await getFetch()(`${RUNTIME_API_BASE}/product-events/batch`, {
            method: "POST",
            headers: headers(token, serverId),
            keepalive: options.onPageHide === true,
            body: JSON.stringify({ ...envelope, events: [entry.body] }),
          });
          const answer = response.ok ? (await response.json().catch(() => null)) as { accepted?: unknown; duplicates?: unknown } | null : null;
          // Taken now, or taken before (a repeat of the same uuid).
          delivered = (typeof answer?.accepted === "number" && answer.accepted >= 1)
            || (typeof answer?.duplicates === "number" && answer.duplicates >= 1);
        } catch {
          delivered = false;
        }
        entry.onDelivery?.(delivered);
      }
      for (let start = 0; start < events.length; start += MAX_BATCH_EVENTS) {
        await getFetch()(`${RUNTIME_API_BASE}/product-events/batch`, {
          method: "POST",
          headers: headers(token, serverId),
          keepalive: options.onPageHide === true,
          body: JSON.stringify({
            ...envelope,
            events: events.slice(start, start + MAX_BATCH_EVENTS),
          }),
        }).catch(() => undefined);
      }
    }
  } catch {
    // Failure-isolated: product analytics never breaks the app.
  } finally {
    flushing = false;
  }
}

/**
 * Give a terminal navigation one bounded chance to resolve the user's sharing
 * choice and issue a keepalive batch. Analytics must never hold checkout open:
 * a stalled config read or batch is abandoned after the deadline, while the
 * underlying keepalive request may still finish as the page unloads.
 */
export async function flushProductEventsBeforeNavigation(
  options: { timeoutMs?: number } = {},
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, options.timeoutMs ?? NAVIGATION_FLUSH_TIMEOUT_MS);
  });
  await Promise.race([
    flushProductEvents({ onPageHide: true, allowConsentLookup: true }),
    deadline,
  ]);
  if (timeout !== null) clearTimeout(timeout);
}

// RAFT_PRIVACY_MODE answered (store/privacyMode.ts): "on" drops what was held
// while it was unknown; "off" lets it go on the usual delayed batch.
subscribePrivacyMode((state) => {
  if (state === "on") {
    for (const entry of queue) entry.onDelivery?.(false);
    queue = [];
    return;
  }
  if (queue.length > 0) scheduleFlush();
});

if (typeof window !== "undefined" && typeof document !== "undefined") {
  const flushOnHide = () => {
    if (queue.length > 0) void flushProductEvents({ onPageHide: true });
  };
  window.addEventListener("pagehide", flushOnHide);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushOnHide();
  });
}

/** Test-only: reset module state and inject fetch. */
export function resetProductEventsForTest(fetchImpl: FetchLike | null = null): void {
  queue = [];
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
  flushing = false;
  allowedByServer.clear();
  fetchOverride = fetchImpl;
  desktopAppVersionAsked = false;
  desktopAppVersion = undefined;
}
