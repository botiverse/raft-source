import assert from "node:assert/strict";
import { test } from "vitest";
import { planActivityHintResolutionAction } from "./agentOrchestrator.js";

test("planActivityHintResolutionAction returns the snapshot when the machine is locally reachable", () => {
  assert.equal(
    planActivityHintResolutionAction({
      hasStoppedOfflineHint: false,
      reachability: "local",
      shouldTrustRecoveredOfflineHint: false,
      source: "local-cache",
      isFreshLocalCache: false,
    }),
    "return-snapshot",
  );
});

test("planActivityHintResolutionAction returns offline when the machine is offline", () => {
  assert.equal(
    planActivityHintResolutionAction({
      hasStoppedOfflineHint: false,
      reachability: "offline",
      shouldTrustRecoveredOfflineHint: false,
      source: "redis",
      isFreshLocalCache: true,
    }),
    "return-offline",
  );
});

test("planActivityHintResolutionAction suppresses closed weak offline with a competing fact", () => {
  assert.equal(
    planActivityHintResolutionAction({
      hasStoppedOfflineHint: false,
      reachability: "offline",
      shouldTrustRecoveredOfflineHint: false,
      weakOfflineSource: "owner_missing",
      weakOfflineCompetingFact: "redis_busy_activity",
      source: "redis",
      isFreshLocalCache: false,
    }),
    "return-read-through-snapshot",
  );
});

test("planActivityHintResolutionAction returns offline when the agent has no machine", () => {
  assert.equal(
    planActivityHintResolutionAction({
      hasStoppedOfflineHint: false,
      reachability: "none",
      shouldTrustRecoveredOfflineHint: false,
      source: "local-cache",
      isFreshLocalCache: true,
    }),
    "return-offline",
  );
});

test("planActivityHintResolutionAction ignores recovered offline hints", () => {
  assert.equal(
    planActivityHintResolutionAction({
      hasStoppedOfflineHint: false,
      reachability: "remote",
      shouldTrustRecoveredOfflineHint: true,
      source: "redis",
      isFreshLocalCache: true,
    }),
    "ignore-hint",
  );
});

test("planActivityHintResolutionAction only trusts fresh local-cache hints", () => {
  assert.equal(
    planActivityHintResolutionAction({
      hasStoppedOfflineHint: false,
      reachability: "remote",
      shouldTrustRecoveredOfflineHint: false,
      source: "local-cache",
      isFreshLocalCache: true,
    }),
    "return-snapshot",
  );
  assert.equal(
    planActivityHintResolutionAction({
      hasStoppedOfflineHint: false,
      reachability: "remote",
      shouldTrustRecoveredOfflineHint: false,
      source: "local-cache",
      isFreshLocalCache: false,
    }),
    "ignore-hint",
  );
});

test("planActivityHintResolutionAction returns remote soft hints by read-through", () => {
  assert.equal(
    planActivityHintResolutionAction({
      hasStoppedOfflineHint: false,
      reachability: "remote",
      shouldTrustRecoveredOfflineHint: false,
      source: "redis",
      isFreshLocalCache: false,
    }),
    "return-read-through-snapshot",
  );
});

test("planActivityHintResolutionAction returns external-reported hints by read-through", () => {
  assert.equal(
    planActivityHintResolutionAction({
      hasStoppedOfflineHint: false,
      reachability: "external-reported",
      shouldTrustRecoveredOfflineHint: false,
      source: "redis",
      isFreshLocalCache: false,
    }),
    "return-read-through-snapshot",
  );
  assert.equal(
    planActivityHintResolutionAction({
      hasStoppedOfflineHint: false,
      reachability: "external-reported",
      shouldTrustRecoveredOfflineHint: false,
      source: "local-cache",
      isFreshLocalCache: true,
    }),
    "return-read-through-snapshot",
  );
});

test("planActivityHintResolutionAction preserves explicit stopped offline hints", () => {
  assert.equal(
    planActivityHintResolutionAction({
      hasStoppedOfflineHint: true,
      reachability: "offline",
      shouldTrustRecoveredOfflineHint: false,
      source: "redis",
      isFreshLocalCache: false,
    }),
    "return-snapshot",
  );
});
