import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "vitest";

const source = readFileSync(new URL("./channelService.ts", import.meta.url), "utf8");
const risingWaveSource = readFileSync(new URL("../db/risingwave.ts", import.meta.url), "utf8");
const risingWaveTraceSource = readFileSync(new URL("../tracing/risingWaveInboxTrace.ts", import.meta.url), "utf8");

test("RisingWave inbox routes inject typed failure context into db.query.failed", () => {
  for (const route of ["opts.filter", "\"channel_unread\"", "\"sidebar_summary\""]) {
    assert.match(
      source,
      new RegExp(`risingWaveInboxFailureAttrs\\(\\{[\\s\\S]*route: ${route}[\\s\\S]*queryName:`),
      `missing typed failure attrs for ${route}`,
    );
  }
});

test("RW inbox-item query errors fail soft while legacy count-route query errors remain terminal", () => {
  assert.match(source, /const connectionFailure = isRisingWaveInboxFailSoftError\(error\)/);
  assert.match(
    source,
    /const canFailSoft = connectionFailure\s*\|\| route === "all"\s*\|\| route === "unread"\s*\|\| route === "mentions"\s*\|\| route === "unread_mentions"/,
  );
  assert.match(
    source,
    /const failSoftReason:[\s\S]*connectionFailure\s*\? "connection_acquire_error"\s*: "query_error"/,
  );
  assert.match(
    source,
    /recordInboxBackendFailed\("rw_mv", route, error, contractVersion, canFailSoft \? undefined : 500\)/,
  );
  assert.match(source, /if \(!canFailSoft\) \{\s*risingWaveInboxBreaker\.halfOpenProbeInFlight = false;\s*throw error;/);
});

test("RW pool timeout and trace timeout use the same bounded getter", () => {
  assert.match(risingWaveSource, /export function getRisingWaveConnectionTimeoutMillis/);
  assert.match(risingWaveSource, /connectionTimeoutMillis: getRisingWaveConnectionTimeoutMillis\(\)/);
  assert.match(risingWaveTraceSource, /timeout_ms: getRisingWaveConnectionTimeoutMillis\(\)/);
  assert.doesNotMatch(source, /timeoutMs:/);
  assert.doesNotMatch(source, /RISINGWAVE_CONNECTION_TIMEOUT_MS/);
});
