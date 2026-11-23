import assert from "node:assert/strict";
import {
  isProbeCarrierFactLive,
  parseProbeCarrierMeta,
  PROBE_CARRIER_FACT_MAX_AGE_MS,
} from "./probeCarrierFact";

const NOW = Date.parse("2026-09-15T00:00:00.000Z");

function meta(overrides: Record<string, string | null> = {}) {
  return {
    probeCapabilities: JSON.stringify(["provider-probe:v1"]),
    probeConnectionEpochId: "epoch-1",
    probeReplicaGeneration: "gen-1",
    probeObservedAt: new Date(NOW).toISOString(),
    probeRuntimeVersions: JSON.stringify({ builtin: "pi-1" }),
    daemonVersion: "daemon-1",
    computerVersion: "computer-1",
    ...overrides,
  };
}

test("parseProbeCarrierMeta projects capabilities and runtime versions", () => {
  const snapshot = parseProbeCarrierMeta(meta());
  assert.ok(snapshot);
  assert.deepEqual(snapshot?.capabilities, ["provider-probe:v1"]);
  assert.deepEqual(snapshot?.runtimeVersions, { builtin: "pi-1" });
  assert.equal(snapshot?.connectionEpochId, "epoch-1");
  // fallback to the legacy runtimeVersions field when the probe field is absent
  const legacy = parseProbeCarrierMeta(meta({ probeRuntimeVersions: null, runtimeVersions: JSON.stringify({ claude: "c-1" }) }));
  assert.deepEqual(legacy?.runtimeVersions, { claude: "c-1" });
  // missing authority or unparseable observation time yields no fact at all
  assert.equal(parseProbeCarrierMeta(meta({ probeConnectionEpochId: null })), null);
  assert.equal(parseProbeCarrierMeta(meta({ probeObservedAt: "not-a-date" })), null);
  const noCap = parseProbeCarrierMeta(meta({ probeCapabilities: "[]" }));
  assert.deepEqual(noCap?.capabilities, []);
});

test("fact freshness rejects future and stale observations", () => {
  const fresh = parseProbeCarrierMeta(meta());
  assert.equal(isProbeCarrierFactLive(fresh!, NOW), true);
  assert.equal(isProbeCarrierFactLive(fresh!, NOW + PROBE_CARRIER_FACT_MAX_AGE_MS), true);
  const stale = parseProbeCarrierMeta(meta({ probeObservedAt: new Date(NOW - PROBE_CARRIER_FACT_MAX_AGE_MS - 1).toISOString() }));
  assert.equal(isProbeCarrierFactLive(stale!, NOW), false, "stale facts must not authorize a dispatch");
  const future = parseProbeCarrierMeta(meta({ probeObservedAt: new Date(NOW + 1_000).toISOString() }));
  assert.equal(isProbeCarrierFactLive(future!, NOW), false, "future-dated facts must not authorize a dispatch");
});
