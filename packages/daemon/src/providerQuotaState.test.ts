import assert from "node:assert/strict";
import {
  NEAR_EXHAUSTED_UTILIZATION,
  PROVIDER_QUOTA_READING_TTL_MS,
  ProviderQuotaState,
  providerQuotaLevel,
} from "./providerQuotaState";

const T0 = 1_791_800_000_000;

function makeStore() {
  let nowMs = T0;
  const events: Array<{ name: string; attrs: Record<string, string | number> }> = [];
  const store = new ProviderQuotaState({ now: () => nowMs, recordEvent: (name, attrs) => events.push({ name, attrs }) });
  return { store, events, advance: (ms: number) => { nowMs += ms; } };
}

test("provider quota: status maps to ok / warning / near_exhausted / exhausted", () => {
  assert.equal(providerQuotaLevel({ status: "allowed", utilization: 0.95 }), "ok");
  assert.equal(providerQuotaLevel({ status: "allowed_warning", utilization: 0.8 }), "warning");
  assert.equal(providerQuotaLevel({ status: "allowed_warning" }), "warning");
  assert.equal(providerQuotaLevel({ status: "allowed_warning", utilization: NEAR_EXHAUSTED_UTILIZATION }), "near_exhausted");
  assert.equal(providerQuotaLevel({ status: "allowed_warning", surpassedThreshold: 0.9 }), "near_exhausted", "a passed threshold bounds utilization from below");
  assert.equal(providerQuotaLevel({ status: "rejected" }), "exhausted");
});

test("provider quota: quotaFor returns the most severe reading across rate-limit windows", () => {
  const { store } = makeStore();
  assert.equal(store.quotaFor("agent-1"), undefined);
  store.observe("agent-1", "claude", { status: "allowed_warning", utilization: 0.82, rateLimitType: "seven_day", resetsAtMs: T0 + 3 * 86_400_000 });
  store.observe("agent-1", "claude", { status: "allowed", utilization: 0.1, rateLimitType: "five_hour", resetsAtMs: T0 + 3_600_000 });
  assert.deepEqual(store.quotaFor("agent-1"), { state: "warning", utilization: 0.82 });
  assert.equal(store.reading("agent-1")?.rateLimitType, "seven_day");
  assert.equal(store.reading("agent-1")?.resetsAt, new Date(T0 + 3 * 86_400_000).toISOString());
  assert.equal(store.quotaFor("agent-2"), undefined, "readings are per agent");
});

test("provider quota: a later non-rejected reading lifts an exhausted window, not a warning", () => {
  const { store } = makeStore();
  store.observe("agent-1", "claude", { status: "rejected", rateLimitType: "five_hour", resetsAtMs: T0 + 3_600_000 });
  assert.deepEqual(store.quotaFor("agent-1"), { state: "exhausted" });
  store.observe("agent-1", "claude", { status: "allowed_warning", utilization: 0.7, rateLimitType: "seven_day", resetsAtMs: T0 + 86_400_000 });
  assert.deepEqual(store.quotaFor("agent-1"), { state: "warning", utilization: 0.7 });
  store.observe("agent-1", "claude", { status: "allowed", utilization: 0.2, rateLimitType: "five_hour", resetsAtMs: T0 + 3_600_000 });
  assert.deepEqual(store.quotaFor("agent-1"), { state: "warning", utilization: 0.7 });
});

test("provider quota: readings expire at their reset, or after 6h without one", () => {
  const { store, advance } = makeStore();
  store.observe("agent-1", "claude", { status: "rejected", rateLimitType: "five_hour", resetsAtMs: T0 + 60_000 });
  store.observe("agent-2", "claude", { status: "allowed_warning", utilization: 0.5 });
  advance(60_000);
  assert.equal(store.quotaFor("agent-1"), undefined, "expired at resetsAt");
  assert.deepEqual(store.quotaFor("agent-2"), { state: "warning", utilization: 0.5 });
  advance(PROVIDER_QUOTA_READING_TTL_MS - 60_000);
  assert.equal(store.quotaFor("agent-2"), undefined, "expired after the 6h default");
});

test("provider quota: traces only state changes, with bounded attrs", () => {
  const { store, events, advance } = makeStore();
  store.observe("agent-1", "claude", { status: "allowed", utilization: 0.3, rateLimitType: "five_hour", resetsAtMs: T0 + 3_600_000 });
  store.observe("agent-1", "claude", { status: "allowed", utilization: 0.4, rateLimitType: "five_hour", resetsAtMs: T0 + 3_600_000 });
  store.observe("agent-1", "claude", { status: "allowed_warning", utilization: 0.81234, rateLimitType: "five_hour", resetsAtMs: T0 + 3_600_000 });
  store.observe("agent-1", "claude", { status: "allowed_warning", utilization: 0.85, rateLimitType: "five_hour", resetsAtMs: T0 + 3_600_000 });
  store.observe("agent-1", "claude", { status: "allowed_warning", utilization: 0.934, rateLimitType: "five_hour", resetsAtMs: T0 + 3_600_000 });
  advance(3_600_000);
  store.observe("agent-1", "claude", { status: "allowed", utilization: 0.01, rateLimitType: "five_hour", resetsAtMs: T0 + 7_200_000 });
  assert.deepEqual(events, [
    { name: "daemon.provider_quota.changed", attrs: { agent_id: "agent-1", runtime: "claude", state: "ok", previous_state: "none", utilization: 0.3, rate_limit_type: "five_hour" } },
    { name: "daemon.provider_quota.changed", attrs: { agent_id: "agent-1", runtime: "claude", state: "warning", previous_state: "ok", utilization: 0.81, rate_limit_type: "five_hour" } },
    { name: "daemon.provider_quota.changed", attrs: { agent_id: "agent-1", runtime: "claude", state: "near_exhausted", previous_state: "warning", utilization: 0.93, rate_limit_type: "five_hour" } },
    { name: "daemon.provider_quota.changed", attrs: { agent_id: "agent-1", runtime: "claude", state: "ok", previous_state: "none", utilization: 0.01, rate_limit_type: "five_hour" } },
  ]);
});

test("provider quota: an implausible reset never throws and falls back to the 6h TTL", () => {
  const { store, events, advance } = makeStore();
  for (const [agentId, resetsAtMs] of [
    ["agent-huge", 1e20 * 1000],
    ["agent-ms-scale", T0 * 1000],
    ["agent-nan", Number.NaN],
  ] as const) {
    assert.doesNotThrow(() => store.observe(agentId, "claude", { status: "rejected", rateLimitType: "five_hour", resetsAtMs }), agentId);
    assert.deepEqual(store.quotaFor(agentId), { state: "exhausted" }, agentId);
    assert.equal(store.reading(agentId)?.resetsAt, undefined, agentId);
  }
  assert.equal(events.length, 3);
  advance(PROVIDER_QUOTA_READING_TTL_MS);
  for (const agentId of ["agent-huge", "agent-ms-scale", "agent-nan"]) {
    assert.equal(store.quotaFor(agentId), undefined, `${agentId} expires after the TTL`);
  }
});

test("provider quota: a rejected reading whose reset already passed is not used-up evidence", () => {
  const { store } = makeStore();
  assert.doesNotThrow(() => store.observe("agent-past", "claude", { status: "rejected", rateLimitType: "five_hour", resetsAtMs: T0 - 60_000 }));
  assert.equal(store.quotaFor("agent-past"), undefined, "that window has already reset");
});

test("provider quota: forget drops only that agent's readings", () => {
  const { store } = makeStore();
  store.observe("agent-1", "claude", { status: "allowed_warning", utilization: 0.8, rateLimitType: "five_hour" });
  store.observe("agent-2", "claude", { status: "allowed_warning", utilization: 0.6, rateLimitType: "five_hour" });
  store.forget("agent-1");
  assert.equal(store.quotaFor("agent-1"), undefined);
  assert.deepEqual(store.quotaFor("agent-2"), { state: "warning", utilization: 0.6 });
});
