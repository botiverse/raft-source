import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { validateAppConfigWithinBounds } from "../../appConfigTransport.js";
import {
  CLEANER_APP_ID,
  CLEANER_CONFIG_BOUNDS,
  CLEANER_CONFIG_CANONICAL,
  CLEANER_CONFIG_DEFAULTS,
  CLEANER_STORE_KEYS,
  SECONDS_TO_MS,
} from "./configProtocol.js";

describe("Cleaner canonical config spec", () => {
  it("pins the app id both ends bind to", () => {
    assert.equal(CLEANER_APP_ID, "system.cleaner");
  });

  it("pins the canonical server-unit window", () => {
    assert.deepEqual(CLEANER_CONFIG_CANONICAL.thresholdBytes, {
      default: 65_536,
      min: 4_096,
      max: 1_073_741_824,
    });
    assert.deepEqual(CLEANER_CONFIG_CANONICAL.intervalSeconds, {
      default: 3_600,
      min: 900,
      max: 604_800,
    });
    assert.equal(CLEANER_CONFIG_CANONICAL.enabled.default, true);
  });

  it("declares a coherent window: min below max, default inside it", () => {
    for (const key of ["thresholdBytes", "intervalSeconds"] as const) {
      const spec = CLEANER_CONFIG_CANONICAL[key];
      assert.ok(Number.isSafeInteger(spec.min), `${key}.min must be a safe integer`);
      assert.ok(Number.isSafeInteger(spec.max), `${key}.max must be a safe integer`);
      assert.ok(spec.min < spec.max, `${key}: min must be below max`);
      assert.ok(spec.default >= spec.min && spec.default <= spec.max, `${key}: default out of range`);
    }
  });
});

describe("wire spec is derived, not hand-copied", () => {
  it("carries thresholdBytes across unconverted", () => {
    assert.equal(CLEANER_CONFIG_BOUNDS.thresholdBytes.min, CLEANER_CONFIG_CANONICAL.thresholdBytes.min);
    assert.equal(CLEANER_CONFIG_BOUNDS.thresholdBytes.max, CLEANER_CONFIG_CANONICAL.thresholdBytes.max);
    assert.equal(CLEANER_CONFIG_DEFAULTS.thresholdBytes, CLEANER_CONFIG_CANONICAL.thresholdBytes.default);
  });

  it("converts the interval window to exactly x1000 milliseconds", () => {
    assert.equal(
      CLEANER_CONFIG_BOUNDS.intervalMs.min,
      CLEANER_CONFIG_CANONICAL.intervalSeconds.min * SECONDS_TO_MS,
    );
    assert.equal(
      CLEANER_CONFIG_BOUNDS.intervalMs.max,
      CLEANER_CONFIG_CANONICAL.intervalSeconds.max * SECONDS_TO_MS,
    );
    assert.equal(
      CLEANER_CONFIG_DEFAULTS.intervalMs,
      CLEANER_CONFIG_CANONICAL.intervalSeconds.default * SECONDS_TO_MS,
    );
  });

  it("keeps the 1 GiB ceiling the x2 action clamps against", () => {
    assert.equal(CLEANER_CONFIG_BOUNDS.thresholdBytes.max, 1_073_741_824);
  });

  it("rejects the 1-byte and 1ms values a >0-only check would admit", () => {
    assert.equal(
      validateAppConfigWithinBounds({ thresholdBytes: 1 }, CLEANER_CONFIG_BOUNDS).ok,
      false,
    );
    assert.equal(validateAppConfigWithinBounds({ intervalMs: 1 }, CLEANER_CONFIG_BOUNDS).ok, false);
  });

  it("keeps derived defaults inside derived bounds", () => {
    assert.deepEqual(
      validateAppConfigWithinBounds(CLEANER_CONFIG_DEFAULTS, CLEANER_CONFIG_BOUNDS),
      { ok: true },
    );
  });
});

describe("store key mapping", () => {
  it("maps every bounded wire key to a store key", () => {
    for (const wireKey of Object.keys(CLEANER_CONFIG_BOUNDS)) {
      assert.ok(
        CLEANER_STORE_KEYS[wireKey as keyof typeof CLEANER_STORE_KEYS],
        `bounded wire key "${wireKey}" has no store key`,
      );
    }
  });

  it("keeps wire defaults and store keys in lockstep", () => {
    assert.deepEqual(Object.keys(CLEANER_CONFIG_DEFAULTS).sort(), Object.keys(CLEANER_STORE_KEYS).sort());
  });

  it("names the interval store key in seconds, so the unit crossing is visible", () => {
    assert.equal(CLEANER_STORE_KEYS.intervalMs, "interval_seconds");
    assert.equal(CLEANER_STORE_KEYS.thresholdBytes, "threshold_bytes");
  });
});
