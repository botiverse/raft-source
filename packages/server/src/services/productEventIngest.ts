// Client product-event ingest (RFC-067 §6).
//
// Web, desktop and the native apps send registered interaction events in
// batches. Each batch is for one server (the request's X-Server-Id, membership
// already checked) and one signed-in user. The user's Raft id never reaches the store: rows carry
// the analytics id from productAnalyticsGate, and only when the user and the
// workspace allow client events. Anything outside the registry is rejected
// and counted, never stored.

import type { Application } from "express";
import { z } from "zod";
import {
  type ClientPlatform,
  PRODUCT_EVENT_STRING_TOKEN,
  validateProductEvent,
  type AnalyticsId,
  type ProductEventRejection,
  type ServerId,
} from "@botiverse/raft-shared";
import { productEventIngestTotal } from "../metrics";
import { noteProductEventOutcome } from "./productEventIngestSummary";
import {
  createProductEventSinkFromEnv,
  createPublicVisitorSinkFromEnv,
  type ProductEventRow,
  type ProductEventSink,
  type PublicVisitorSink,
} from "./productEventScopeDbWriter";
import type { ProductEventContext } from "./productEventContext";
import { isPrivacyModeOn } from "../config/privacyMode";

export const PRODUCT_EVENT_SINK_APP_KEY = "productEventSink";
export const PUBLIC_VISITOR_SINK_APP_KEY = "publicVisitorSink";

export const MAX_CLIENT_EVENTS_PER_BATCH = 100;
// Client clocks drift and batches wait in a queue; anything outside this
// window is a broken clock or a replay, not an event worth keeping.
const MAX_EVENT_AGE_MS = 24 * 60 * 60_000;
const MAX_EVENT_FUTURE_MS = 5 * 60_000;

const shortToken = z.string().max(64).regex(PRODUCT_EVENT_STRING_TOKEN);
const propertyValue = z.union([z.string().max(256), z.number(), z.boolean()]);

export const clientEventBatchSchema = z.object({
  // Native apps send only events whose registry `sources` name them.
  source: z.enum(["web", "desktop", "ios", "android", "harmonyos"]),
  app_version: z.string().max(64).regex(/^[0-9A-Za-z._+-]+$/).optional(),
  // Ignored: the server derives `platform` (clientPlatform below). Kept so a
  // client that sends it is not refused.
  platform: shortToken.optional(),
  /** Desktop app: the web build it embeds (its own version is app_version). */
  web_version: z.string().max(64).regex(/^[0-9A-Za-z._+-]+$/).optional(),
  /** Web: running as an installed app (`standalone`) or in a browser tab. */
  display_mode: z.enum(["browser", "standalone"]).optional(),
  /** Native apps: phone or tablet, as the app knows it (their User-Agent may not say). */
  device_class: z.enum(["phone", "tablet"]).optional(),
  events: z.array(z.object({
    uuid: z.uuid(),
    event: z.string().max(64),
    timestamp: z.iso.datetime({ offset: true }),
    client_session_id: z.uuid().optional(),
    properties: z.record(z.string().max(64), propertyValue).optional(),
  }).strict()).min(1).max(MAX_CLIENT_EVENTS_PER_BATCH),
}).strict();

export type ClientEventBatch = z.infer<typeof clientEventBatchSchema>;

type IngestRejection = ProductEventRejection | "timestamp_out_of_range" | "duplicate";

// replica-local: best-effort dedup only. Most clients never retry a batch, so
// duplicates are rare; readers still dedupe by uuid across replicas. Only an
// event this replica queued is remembered: one refused (registry, timestamp)
// is not, so sending it again is judged again, never answered as a duplicate
// (meichen, 2026-11-09: Desktop's migration reports treat `duplicates` as
// taken). Remembered means queued for the writer, not written. Public visits
// share this set (publicVisitCounts.ts) and remember a uuid before their own
// daily cap; their uuids never meet client events'.
const RECENT_UUID_LIMIT = 50_000;
const recentUuids = new Set<string>();

/** True when this replica has queued `uuid` recently. */
function queuedRecently(uuid: string): boolean {
  return recentUuids.has(uuid);
}

/** True the first time this replica sees `uuid` (within the recent window). */
export function rememberEventUuid(uuid: string): boolean {
  if (queuedRecently(uuid)) return false;
  recentUuids.add(uuid);
  if (recentUuids.size > RECENT_UUID_LIMIT) {
    // Sets iterate in insertion order: drop the oldest.
    const oldest = recentUuids.values().next().value;
    if (oldest !== undefined) recentUuids.delete(oldest);
  }
  return true;
}

const NATIVE_SOURCES = new Set(["ios", "android", "harmonyos"]);

/**
 * The client a batch came from (task #13). Native apps are themselves; the
 * desktop app is `desktop_app`; the web is `pwa` when installed, else
 * `mobile_web` on a phone or tablet (by `$device_type`) and `web` on a
 * computer.
 */
export function clientPlatform(batch: Pick<ClientEventBatch, "source" | "display_mode">, deviceType: string | undefined): ClientPlatform {
  switch (batch.source) {
    case "ios":
    case "android":
    case "harmonyos":
      return batch.source;
    case "desktop":
      return "desktop_app";
    case "web":
      if (batch.display_mode === "standalone") return "pwa";
      return deviceType === "mobile" || deviceType === "tablet" ? "mobile_web" : "web";
  }
}

export interface ClientEventRowsResult {
  rows: ProductEventRow[];
  rejected: Partial<Record<IngestRejection, number>>;
}

export function buildClientEventRows(input: {
  batch: ClientEventBatch;
  analyticsId: AnalyticsId;
  serverId: ServerId;
  receivedAt: Date;
  /** `$` properties derived from the request (productEventContext.ts), added after validation. */
  context?: ProductEventContext;
}): ClientEventRowsResult {
  const rows: ProductEventRow[] = [];
  const rejected: Partial<Record<IngestRejection, number>> = {};
  const reject = (reason: IngestRejection) => {
    rejected[reason] = (rejected[reason] ?? 0) + 1;
  };
  const now = input.receivedAt.getTime();
  // A native app's own phone/tablet claim wins over its User-Agent.
  const nativeDeviceType = NATIVE_SOURCES.has(input.batch.source) && input.batch.device_class
    ? (input.batch.device_class === "phone" ? "mobile" : "tablet")
    : undefined;
  const context: Record<string, string | number> = {
    ...input.context,
    ...(nativeDeviceType ? { $device_type: nativeDeviceType } : {}),
    ...(input.batch.source === "desktop" && input.batch.web_version ? { $web_version: input.batch.web_version } : {}),
  };
  const platform = clientPlatform(input.batch, typeof context.$device_type === "string" ? context.$device_type : undefined);
  for (const event of input.batch.events) {
    if (queuedRecently(event.uuid)) {
      reject("duplicate");
      continue;
    }
    const properties = event.properties ?? {};
    const validation = validateProductEvent(event.event, properties, input.batch.source);
    if (!validation.ok) {
      reject(validation.reason);
      continue;
    }
    const occurredAt = Date.parse(event.timestamp);
    if (occurredAt < now - MAX_EVENT_AGE_MS || occurredAt > now + MAX_EVENT_FUTURE_MS) {
      reject("timestamp_out_of_range");
      continue;
    }
    // Remembered only now that it is queued (and so a repeat later in this batch is a duplicate).
    rememberEventUuid(event.uuid);
    rows.push({
      uuid: event.uuid,
      event: validation.event,
      source: input.batch.source,
      timestamp: new Date(occurredAt).toISOString(),
      received_at: input.receivedAt.toISOString(),
      analytics_id: input.analyticsId,
      server_id: input.serverId,
      client_session_id: event.client_session_id ?? null,
      app_version: input.batch.app_version ?? null,
      platform,
      properties: { ...properties, ...context },
    });
  }
  return { rows, rejected };
}

export function getProductEventSink(app: Application): ProductEventSink | null {
  // RAFT_PRIVACY_MODE: unconfigured, so nothing is written to ScopeDB.
  if (isPrivacyModeOn()) return null;
  if (app.get(PRODUCT_EVENT_SINK_APP_KEY) === undefined) {
    app.set(PRODUCT_EVENT_SINK_APP_KEY, createProductEventSinkFromEnv());
  }
  return app.get(PRODUCT_EVENT_SINK_APP_KEY) as ProductEventSink | null;
}

export function getPublicVisitorSink(app: Application): PublicVisitorSink | null {
  if (isPrivacyModeOn()) return null;
  if (app.get(PUBLIC_VISITOR_SINK_APP_KEY) === undefined) {
    app.set(PUBLIC_VISITOR_SINK_APP_KEY, createPublicVisitorSinkFromEnv());
  }
  return app.get(PUBLIC_VISITOR_SINK_APP_KEY) as PublicVisitorSink | null;
}

export type IngestOutcome =
  | "written"
  | "gated"
  | "unconfigured"
  | "lost"
  | "rejected_malformed"
  | `rejected_${IngestRejection}`
  // Public Server visits (publicVisitCounts.ts), all answered 204: past the
  // per-server daily cap, throttled per IP, not sent from the app's own site,
  // no public server by that slug, its flags off, its analytics switch off,
  // or a channel or thread that is not public.
  | "public_visit_capped"
  | "public_visit_rate_limited"
  | "public_visit_not_same_site"
  | "public_visit_no_target"
  | "public_visit_flag_off"
  | "public_visit_workspace_off"
  | "public_visit_bad_channel";

export function countIngest(outcome: IngestOutcome, count: number): void {
  if (count > 0) productEventIngestTotal.inc({ outcome }, count);
  noteProductEventOutcome(outcome, count);
}
