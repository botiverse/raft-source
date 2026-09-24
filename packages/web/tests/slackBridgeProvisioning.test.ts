import assert from "node:assert/strict";
import test from "node:test";

import {
  isSlackBridgePreflightPassed,
  projectSlackBridgeHealth,
  validateSlackBridgeChannelPairs,
} from "../src/components/settings/slackBridgeProvisioning";
import type {
  SlackBridgeChannelPair,
  SlackBridgePreflight,
  SlackBridgeRawHealth,
} from "../src/components/settings/slackBridgeProvisioning";

const healthyRaw: SlackBridgeRawHealth = {
  install: {
    state: "active",
    epochs: {
      grant: "grant-3",
      connection: "connection-4",
      scope: "scope-2",
      credential: "credential-7",
    },
  },
  credential: { state: "active" },
  bindings: [{ id: "binding-1", state: "active" }],
  audiences: [{ bindingId: "binding-1", status: "matched" }],
  lastVerifiedAt: "2032-01-02T03:04:05.000Z",
  failingSurface: null,
};

test("health projection preserves every raw install state and its corrective action", () => {
  const cases = [
    ["pending", "unverified", "finish_oauth"],
    ["active", "connected", "none"],
    ["reauth_required", "degraded", "reauthorize"],
    ["disconnected", "disconnected", "reconnect"],
    ["revoked", "disconnected", "reconnect"],
    ["quarantined", "degraded", "resolve_quarantine"],
  ] as const;

  for (const [state, health, action] of cases) {
    const result = projectSlackBridgeHealth({
      ...healthyRaw,
      install: { ...healthyRaw.install!, state },
    });
    assert.equal(result.state, health, state);
    assert.equal(result.action, action, state);
  }
});

test("unknown persistence and unavailable audience remain unverified, not healthy or mismatched", () => {
  const persistence = projectSlackBridgeHealth({
    ...healthyRaw,
    credential: { state: "persist_unknown" },
  });
  assert.deepEqual(
    { state: persistence.state, reason: persistence.reason, action: persistence.action },
    { state: "unverified", reason: "credential_persist_unknown", action: "verify_credential" },
  );

  const unavailable = projectSlackBridgeHealth({
    ...healthyRaw,
    audiences: [{ bindingId: "binding-1", status: "unavailable" }],
  });
  assert.deepEqual(
    { state: unavailable.state, reason: unavailable.reason, action: unavailable.action },
    { state: "unverified", reason: "audience_unavailable", action: "retry_verification" },
  );

  const mismatch = projectSlackBridgeHealth({
    ...healthyRaw,
    audiences: [{ bindingId: "binding-1", status: "mismatch" }],
  });
  assert.deepEqual(
    { state: mismatch.state, reason: mismatch.reason, action: mismatch.action },
    { state: "degraded", reason: "audience_mismatch", action: "repair_audience" },
  );

  const unrelated = projectSlackBridgeHealth({
    ...healthyRaw,
    audiences: [{ bindingId: "different-binding", status: "matched" }],
  });
  assert.deepEqual(
    { state: unrelated.state, reason: unrelated.reason, action: unrelated.action },
    { state: "unverified", reason: "audience_unavailable", action: "retry_verification" },
  );
});

test("binding and credential failures never collapse into connected", () => {
  const cases = [
    [{ credential: { state: "revoked" } }, "disconnected", "credential_revoked"],
    [{ bindings: [{ id: "binding-1", state: "paused" }] }, "degraded", "binding_paused"],
    [{ bindings: [{ id: "binding-1", state: "revoked" }] }, "degraded", "binding_revoked"],
    [{ bindings: [{ id: "binding-1", state: "quarantined" }] }, "degraded", "binding_quarantined"],
  ] as const;

  for (const [override, health, reason] of cases) {
    const result = projectSlackBridgeHealth({ ...healthyRaw, ...override } as SlackBridgeRawHealth);
    assert.equal(result.state, health);
    assert.equal(result.reason, reason);
  }
});

test("an explicit failing surface cannot collapse into connected", () => {
  const cases = [
    ["connection", "degraded", "connection_failed", "reconnect"],
    ["scope", "degraded", "scope_mismatch", "reauthorize"],
    ["install", "unverified", "verification_required", "retry_verification"],
  ] as const;

  for (const [failingSurface, state, reason, action] of cases) {
    const result = projectSlackBridgeHealth({ ...healthyRaw, failingSurface });
    assert.deepEqual(
      { state: result.state, reason: result.reason, action: result.action },
      { state, reason, action },
      failingSurface,
    );
  }
});

test("binding recovery precedence is stable across mixed-state permutations", () => {
  const permutations = [
    ["paused", "revoked", "quarantined"],
    ["paused", "quarantined", "revoked"],
    ["revoked", "paused", "quarantined"],
    ["revoked", "quarantined", "paused"],
    ["quarantined", "paused", "revoked"],
    ["quarantined", "revoked", "paused"],
  ] as const;

  for (const states of permutations) {
    const result = projectSlackBridgeHealth({
      ...healthyRaw,
      bindings: states.map((state, index) => ({ id: `binding-${index}`, state })),
    });
    assert.deepEqual(
      { reason: result.reason, action: result.action },
      { reason: "binding_quarantined", action: "resolve_quarantine" },
      states.join(","),
    );
  }

  for (const states of [
    ["paused", "quarantined"],
    ["quarantined", "paused"],
    ["revoked", "quarantined"],
    ["quarantined", "revoked"],
  ] as const) {
    const result = projectSlackBridgeHealth({
      ...healthyRaw,
      bindings: states.map((state, index) => ({ id: `binding-${index}`, state })),
    });
    assert.deepEqual(
      { reason: result.reason, action: result.action },
      { reason: "binding_quarantined", action: "resolve_quarantine" },
      states.join(","),
    );
  }

  for (const states of [["paused", "revoked"], ["revoked", "paused"]] as const) {
    const result = projectSlackBridgeHealth({
      ...healthyRaw,
      bindings: states.map((state, index) => ({ id: `binding-${index}`, state })),
    });
    assert.deepEqual(
      { reason: result.reason, action: result.action },
      { reason: "binding_revoked", action: "repair_binding" },
      states.join(","),
    );
  }
});

test("preflight passes only for the closed unique required-check set", () => {
  const allPassed: SlackBridgePreflight = {
    state: "passed",
    checks: [
      { id: "oauth", state: "passed" },
      { id: "endpoint", state: "passed" },
      { id: "scope", state: "passed" },
      { id: "audience", state: "passed" },
    ],
  };
  assert.equal(isSlackBridgePreflightPassed(allPassed), true);

  const cases: Array<[string, SlackBridgePreflight]> = [
    ["missing", { ...allPassed, checks: allPassed.checks.slice(0, 3) }],
    ["duplicate", { ...allPassed, checks: [...allPassed.checks.slice(0, 3), allPassed.checks[0]!] }],
    ["failed", { ...allPassed, checks: allPassed.checks.map((check) => (
      check.id === "oauth" ? { ...check, state: "failed" as const } : check
    )) }],
    ["unverified", { ...allPassed, checks: allPassed.checks.map((check) => (
      check.id === "audience" ? { ...check, state: "unverified" as const } : check
    )) }],
    ["aggregate", { ...allPassed, state: "failed" }],
  ];

  for (const [name, preflight] of cases) {
    assert.equal(isSlackBridgePreflightPassed(preflight), false, name);
  }
});

test("channel pairs are one-to-one on both Raft and Slack sides", () => {
  const valid: SlackBridgeChannelPair[] = [
    { raftChannelId: "raft-a", slackChannelId: "slack-a" },
    { raftChannelId: "raft-b", slackChannelId: "slack-b" },
  ];
  assert.deepEqual(validateSlackBridgeChannelPairs(valid), { valid: true });
  assert.deepEqual(validateSlackBridgeChannelPairs([]), { valid: false, reason: "pair_required" });
  assert.deepEqual(
    validateSlackBridgeChannelPairs([...valid, { raftChannelId: "raft-a", slackChannelId: "slack-c" }]),
    { valid: false, reason: "duplicate_raft_channel" },
  );
  assert.deepEqual(
    validateSlackBridgeChannelPairs([...valid, { raftChannelId: "raft-c", slackChannelId: "slack-a" }]),
    { valid: false, reason: "duplicate_slack_channel" },
  );
});
