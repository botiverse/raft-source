// The `paywall_hit`s a test app records, in memory: routes record them without
// awaiting (routes/paywallHit.ts), so a test waits for them to land.
import assert from "node:assert/strict";
import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";
import { PRODUCT_EVENT_SINK_APP_KEY } from "../../services/productEventIngest";
import type { ProductEventRow, ProductEventSink } from "../../services/productEventScopeDbWriter";
import { resetPaywallHitsForTest } from "../../services/serverProductEvents";

export interface CapturedPaywallHits {
  /** Each recorded hit: its properties, analytics_id and server_id. */
  hits(): Array<{ properties: ProductEventRow["properties"]; analyticsId: string | null; serverId: string | null }>;
  /** Wait (up to two seconds) until `count` hits are recorded, then a little longer, and assert exactly that many. */
  expect(count: number, label: string): Promise<void>;
}

/** Records the app's product events from here on, and forgets the hits already counted today (each test starts fresh). */
export function capturePaywallHits(app: { app: { set(key: string, value: unknown): unknown } }): CapturedPaywallHits {
  resetPaywallHitsForTest();
  const rows: ProductEventRow[] = [];
  const sink: ProductEventSink = { enqueue: (batch) => { rows.push(...batch); }, flush: async () => {} };
  app.app.set(PRODUCT_EVENT_SINK_APP_KEY, sink);
  const hits = () => rows.filter((row) => row.event === "paywall_hit")
    .map((row) => ({ properties: row.properties, analyticsId: row.analytics_id, serverId: row.server_id }));
  return {
    hits,
    async expect(count, label) {
      const until = Date.now() + 2000;
      while (hits().length < count && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
      // Give a late duplicate the time to land too.
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(hits().length, count, `${label}: ${JSON.stringify(hits())}`);
    },
  };
}

export interface CapturedProductEvents {
  /** Each recorded row of the event, in the order recorded. */
  rows(): ProductEventRow[];
  /** Wait (up to two seconds) until `count` rows are recorded, then a little longer, and assert exactly that many. */
  expect(count: number, label: string): Promise<ProductEventRow[]>;
}

/**
 * Records the app's product events from here on and reads one event's rows
 * (routes record without awaiting, so a test waits for them to land). Forgets
 * the once-a-day keys this process already counted, as capturePaywallHits.
 */
export function captureProductEvents(app: { app: { set(key: string, value: unknown): unknown } }, event: string): CapturedProductEvents {
  resetPaywallHitsForTest();
  const all: ProductEventRow[] = [];
  const sink: ProductEventSink = { enqueue: (batch) => { all.push(...batch); }, flush: async () => {} };
  app.app.set(PRODUCT_EVENT_SINK_APP_KEY, sink);
  const rows = () => all.filter((row) => row.event === event);
  return {
    rows,
    async expect(count, label) {
      const until = Date.now() + 2000;
      while (rows().length < count && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
      // Give a late or unwanted row the time to land too.
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(rows().length, count, `${label}: ${JSON.stringify(rows().map((row) => row.properties))}`);
      return rows();
    },
  };
}

/** What a refused request's `server.http.request` span says of the refusal. */
export interface RefusalSpan {
  status: unknown;
  errorCode: unknown;
  /** `limit_side`; null when the span has none. */
  limitSide: unknown;
}

export interface CapturedRefusalSpans {
  /** Forget the spans so far. */
  clear(): void;
  /** Wait (up to two seconds) for `count` request spans with an error_code, and return exactly those. */
  expect(count: number, label: string): Promise<RefusalSpan[]>;
}

/** Records the app's request spans from here on, to read the error_code and limit_side a refusal left on its span. */
export function captureRefusalSpans(app: { app: { set(key: string, value: unknown): unknown } }): CapturedRefusalSpans {
  const sink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({ sink }));
  const refusals = () => sink.getAllSpans()
    .filter((span) => span.name === "server.http.request" && typeof span.attrs?.error_code === "string")
    .map((span) => ({ status: span.attrs?.status_code, errorCode: span.attrs?.error_code, limitSide: span.attrs?.limit_side ?? null }));
  return {
    clear: () => sink.clear(),
    async expect(count, label) {
      // A span ends after its response does, so the caller may get here first.
      const until = Date.now() + 2000;
      while (refusals().length < count && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(refusals().length, count, `${label}: ${JSON.stringify(refusals())}`);
      return refusals();
    },
  };
}
