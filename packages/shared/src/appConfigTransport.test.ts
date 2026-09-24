import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isAppConfigValue,
  normalizeAppConfigWireSnapshot,
  validateAppConfigWithinBounds,
} from "./appConfigTransport.js";

/** Synthetic bounds: this file must stay free of any real app's values. */
const TEST_BOUNDS = {
  thresholdBytes: { min: 4_096, max: 1_073_741_824 },
  intervalMs: { min: 60_000, max: 86_400_000 },
} as const;

const validEnvelope = {
  appId: "x.alpha",
  ownerAgentId: "agent-1",
  revision: 3,
  effective: { enabled: true, thresholdBytes: 65_536, intervalMs: 3_600_000 },
};

describe("app config wire envelope", () => {
  it("accepts a well-formed envelope and trims identifiers", () => {
    const out = normalizeAppConfigWireSnapshot({
      ...validEnvelope,
      appId: "  x.alpha  ",
      ownerAgentId: " agent-1 ",
    });
    assert.deepEqual(out, { ...validEnvelope, appId: "x.alpha", ownerAgentId: "agent-1" });
  });

  it("rejects non-object, array, and null payloads", () => {
    for (const raw of [null, undefined, 42, "x", [], [validEnvelope]]) {
      assert.equal(normalizeAppConfigWireSnapshot(raw), null, `expected null for ${String(raw)}`);
    }
  });

  it("rejects blank or missing identifiers", () => {
    assert.equal(normalizeAppConfigWireSnapshot({ ...validEnvelope, appId: "   " }), null);
    assert.equal(normalizeAppConfigWireSnapshot({ ...validEnvelope, ownerAgentId: "" }), null);
    const { appId: _drop, ...noAppId } = validEnvelope;
    assert.equal(normalizeAppConfigWireSnapshot(noAppId), null);
  });

  it("rejects a negative, fractional, or non-numeric revision", () => {
    for (const revision of [-1, 1.5, "3", Number.NaN]) {
      assert.equal(normalizeAppConfigWireSnapshot({ ...validEnvelope, revision }), null);
    }
  });

  it("rejects non-scalar and fractional config values", () => {
    for (const value of [null, {}, [], "on", 1.5, Number.NaN]) {
      assert.equal(
        normalizeAppConfigWireSnapshot({ ...validEnvelope, effective: { thresholdBytes: value } }),
        null,
        `expected null for effective value ${JSON.stringify(value)}`,
      );
    }
  });

  it("classifies booleans and safe integers as config values", () => {
    assert.ok(isAppConfigValue(true));
    assert.ok(isAppConfigValue(0));
    assert.ok(!isAppConfigValue(1.5));
    assert.ok(!isAppConfigValue("1"));
  });
});

describe("bounds machinery", () => {
  it("rejects the 1-byte and 1ms envelopes a >0-only check would admit", () => {
    const oneByte = validateAppConfigWithinBounds({ thresholdBytes: 1 }, TEST_BOUNDS);
    assert.equal(oneByte.ok, false);

    const oneMs = validateAppConfigWithinBounds({ intervalMs: 1 }, TEST_BOUNDS);
    assert.equal(oneMs.ok, false);
  });

  it("rejects values above both maxima", () => {
    const check = validateAppConfigWithinBounds(
      { thresholdBytes: 1_073_741_825, intervalMs: 86_400_001 },
      TEST_BOUNDS,
    );
    assert.equal(check.ok, false);
    assert.equal(check.ok === false && check.errors.length, 2);
  });

  it("accepts exact inclusive endpoints", () => {
    for (const [key, bound] of Object.entries(TEST_BOUNDS)) {
      for (const edge of [bound.min, bound.max]) {
        const check = validateAppConfigWithinBounds({ [key]: edge }, TEST_BOUNDS);
        assert.deepEqual(check, { ok: true }, `${key}=${edge} must be legal`);
      }
    }
  });

  it("does not range-check absent keys or undeclared keys", () => {
    assert.deepEqual(validateAppConfigWithinBounds({}, TEST_BOUNDS), { ok: true });
    assert.deepEqual(validateAppConfigWithinBounds({ enabled: true }, TEST_BOUNDS), {
      ok: true,
    });
  });

  it("flags a boolean supplied where a bounded number is declared", () => {
    const check = validateAppConfigWithinBounds(
      { thresholdBytes: true },
      TEST_BOUNDS,
    );
    assert.equal(check.ok, false);
  });
});

describe("bounds-aware envelope parsing", () => {
  it("rejects a structurally valid envelope whose values are out of range", () => {
    const raw = { ...validEnvelope, effective: { thresholdBytes: 1, intervalMs: 1 } };
    assert.notEqual(normalizeAppConfigWireSnapshot(raw), null, "structurally valid without bounds");
    assert.equal(normalizeAppConfigWireSnapshot(raw, TEST_BOUNDS), null);
  });

  it("accepts an in-range envelope when bounds are supplied", () => {
    const out = normalizeAppConfigWireSnapshot(validEnvelope, TEST_BOUNDS);
    assert.deepEqual(out, validEnvelope);
  });
});
