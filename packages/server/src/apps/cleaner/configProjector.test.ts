import assert from "node:assert/strict";
import { test } from "vitest";

import {
  CLEANER_APP_ID,
  CLEANER_CONFIG_BOUNDS,
  CLEANER_CONFIG_DEFAULTS,
  CLEANER_STORE_KEYS,
} from "@botiverse/raft-shared/src/apps/cleaner/configProtocol.js";
import { normalizeAppConfigWireSnapshot } from "@botiverse/raft-shared/src/appConfigTransport.js";

import {
  CleanerConfigRangeError,
  projectCleanerConfigToWire,
} from "./configProjector.js";

/** A durable snapshot as `getRapAppConfig` returns it: product units, snake_case. */
function stored(overrides: Record<string, boolean | number> = {}) {
  return {
    ownerAgentId: "agent-1",
    revision: 7,
    effective: {
      enabled: true,
      threshold_bytes: 65_536,
      interval_seconds: 3_600,
      ...overrides,
    },
  };
}

test("projects durable config onto the wire, converting seconds to ms", () => {
  const snap = projectCleanerConfigToWire(stored());
  assert.equal(snap.appId, CLEANER_APP_ID);
  assert.equal(snap.ownerAgentId, "agent-1");
  assert.equal(snap.effective.enabled, CLEANER_CONFIG_DEFAULTS.enabled);
  assert.equal(snap.effective.thresholdBytes, CLEANER_CONFIG_DEFAULTS.thresholdBytes);
  assert.equal(snap.effective.intervalMs, 3_600 * 1000);
  assert.deepEqual(Object.keys(snap.effective).sort(), ["enabled", "intervalMs", "thresholdBytes"]);
});

test("carries the REAL stored revision, not a defaults-only zero", () => {
  assert.equal(projectCleanerConfigToWire(stored()).revision, 7);
  assert.equal(projectCleanerConfigToWire({ ...stored(), revision: 0 }).revision, 0);
});

test("stored overrides reach the wire", () => {
  const snap = projectCleanerConfigToWire(
    stored({ enabled: false, threshold_bytes: 8192, interval_seconds: 900 }),
  );
  assert.equal(snap.effective.enabled, false);
  assert.equal(snap.effective.thresholdBytes, 8192);
  assert.equal(snap.effective.intervalMs, 900_000);
});

test("the wire carries no snake_case key and no seconds value", () => {
  const snap = projectCleanerConfigToWire(stored());
  for (const key of Object.keys(snap.effective)) {
    assert.ok(!key.includes("_"), `wire key "${key}" leaked store casing`);
  }
  assert.notEqual(snap.effective.intervalMs, 3_600, "seconds leaked onto the wire unconverted");
});

test("out-of-range stored values are rejected, not clamped", () => {
  // 1ms/1-byte class: illegal at the origin schema, must not be forwarded.
  assert.throws(
    () => projectCleanerConfigToWire(stored({ interval_seconds: 1 })),
    CleanerConfigRangeError,
  );
  assert.throws(
    () => projectCleanerConfigToWire(stored({ threshold_bytes: 1 })),
    CleanerConfigRangeError,
  );
  assert.throws(
    () =>
      projectCleanerConfigToWire(
        stored({ threshold_bytes: CLEANER_CONFIG_BOUNDS.thresholdBytes.max + 1 }),
      ),
    CleanerConfigRangeError,
  );
});

test("a malformed stored value is refused rather than coerced", () => {
  assert.throws(
    () => projectCleanerConfigToWire(stored({ enabled: 1 })),
    CleanerConfigRangeError,
  );
  assert.throws(
    () => projectCleanerConfigToWire(stored({ interval_seconds: 1.5 })),
    CleanerConfigRangeError,
  );
});

test("accepts exact inclusive endpoints", () => {
  const minSeconds = CLEANER_CONFIG_BOUNDS.intervalMs.min / 1000;
  const snap = projectCleanerConfigToWire(
    stored({
      threshold_bytes: CLEANER_CONFIG_BOUNDS.thresholdBytes.max,
      interval_seconds: minSeconds,
    }),
  );
  assert.equal(snap.effective.thresholdBytes, CLEANER_CONFIG_BOUNDS.thresholdBytes.max);
  assert.equal(snap.effective.intervalMs, CLEANER_CONFIG_BOUNDS.intervalMs.min);
});

test("the projected envelope round-trips through the daemon-side parser", () => {
  const snap = projectCleanerConfigToWire(stored());
  const parsed = normalizeAppConfigWireSnapshot(
    JSON.parse(JSON.stringify(snap)),
    CLEANER_CONFIG_BOUNDS,
  );
  assert.deepEqual(parsed, snap, "config truth must survive the wire unchanged");
});

test("store keys map every bounded wire key", () => {
  for (const wireKey of Object.keys(CLEANER_CONFIG_BOUNDS)) {
    assert.ok(
      CLEANER_STORE_KEYS[wireKey as keyof typeof CLEANER_STORE_KEYS],
      `bounded wire key "${wireKey}" has no store key`,
    );
  }
});
