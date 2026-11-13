// task #1357 item 1: the Raft-defaults signal. Pure derivation from the
// stored per-instance rows and the agent row: shown only for a raft_default
// row of the current Computer, revision and session; never "confirmed".
import assert from "node:assert/strict";

import { RUNTIME_CONFIG_VERSION, type ModelLimits, type RuntimeConfig } from "@botiverse/raft-shared";
import {
  deriveAgentModelLimitsWarning,
  isBuiltInGatewayCustomModelConfig,
  parseAgentModelLimitsFrame,
  type StoredAgentModelLimitsReport,
} from "./agentModelLimitsService";

const DEFAULTS: ModelLimits = { contextWindow: { value: 200_000, source: "raft_default" }, maxTokens: { value: 8192, source: "raft_default" } };
const CATALOG: ModelLimits = { contextWindow: { value: 1_000_000, source: "catalog" }, maxTokens: { value: 131_072, source: "catalog" } };
const MIXED: ModelLimits = { contextWindow: { value: 64_000, source: "catalog" }, maxTokens: { value: 8192, source: "raft_default" } };

const AGENT: { machineId: string | null; configRevision: number; sessionId: string | null } = { machineId: "machine-a", configRevision: 4, sessionId: "session-1" };

function report(overrides: Partial<StoredAgentModelLimitsReport> = {}): StoredAgentModelLimitsReport {
  return {
    machineId: "machine-a",
    daemonInstanceId: "inst-1",
    launchId: "launch-1",
    sessionId: "session-1",
    configRevision: 4,
    seq: 1,
    observedAt: new Date("2026-11-07T00:00:00.000Z"),
    receivedAt: new Date("2026-11-07T00:00:01.000Z"),
    runtime: "builtin",
    modelLimits: DEFAULTS,
    ...overrides,
  };
}

const shown = (reports: StoredAgentModelLimitsReport[], agent = AGENT) => deriveAgentModelLimitsWarning({ agent, reports }).defaultsReported;

test("shown: a raft_default row of the current Computer, revision and session; one default field is enough", () => {
  assert.equal(shown([report()]), true);
  assert.equal(shown([report({ modelLimits: MIXED })]), true);
});

test("not shown: no row, a catalog-only row (never 'confirmed', just nothing)", () => {
  assert.equal(shown([]), false);
  assert.equal(shown([report({ modelLimits: CATALOG })]), false);
});

test("each scope condition: another revision, another Computer, another session, no session known", () => {
  assert.equal(shown([report({ configRevision: 3 })]), false, "older revision (another model or config)");
  assert.equal(shown([report({ machineId: "machine-b" })]), false, "another Computer");
  assert.equal(shown([report({ sessionId: "session-0" })]), false, "another session");
  assert.equal(shown([report()], { ...AGENT, sessionId: null }), false, "no session known");
  assert.equal(shown([report()], { ...AGENT, machineId: null }), false, "no Computer");
});

test("mixed instances: one catalog, one default for the same scope -> shown, whatever the order", () => {
  const a = report({ daemonInstanceId: "inst-1", modelLimits: CATALOG });
  const b = report({ daemonInstanceId: "inst-2", modelLimits: DEFAULTS });
  assert.equal(shown([a, b]), true);
  assert.equal(shown([b, a]), true);
});

test("only a Built-in custom model reached through a gateway gets a signal", () => {
  const gateway = {
    version: RUNTIME_CONFIG_VERSION,
    runtime: "builtin",
    provider: { kind: "gateway", providerId: "openai-compatible", baseUrl: "https://gateway.example.test/v1", apiKey: "k" },
    hostUserState: "forbidden",
    model: { kind: "custom", name: "m" },
    mode: { kind: "default" },
  } as unknown as RuntimeConfig;
  assert.equal(isBuiltInGatewayCustomModelConfig(gateway, null), true);
  const connection = { ...gateway, provider: { kind: "connection", connectionId: "c" } } as unknown as RuntimeConfig;
  assert.equal(isBuiltInGatewayCustomModelConfig(connection, { providerId: "anthropic-compatible", endpointUrl: "https://gw.example.test" }), true);
  assert.equal(isBuiltInGatewayCustomModelConfig(connection, { providerId: "anthropic-compatible", endpointUrl: null }), false, "no endpoint: the daemon does not resolve it to a gateway");
  assert.equal(isBuiltInGatewayCustomModelConfig(connection, { providerId: "anthropic-compatible", endpointUrl: "" }), false);
  assert.equal(isBuiltInGatewayCustomModelConfig(connection, { providerId: "deepseek", endpointUrl: "https://api.deepseek.com" }), false, "a preset provider connection");
  assert.equal(isBuiltInGatewayCustomModelConfig(connection, null), false);
  assert.equal(isBuiltInGatewayCustomModelConfig({ ...gateway, model: { kind: "preset", id: "x/y" } } as unknown as RuntimeConfig, null), false);
  assert.equal(isBuiltInGatewayCustomModelConfig({ ...gateway, runtime: "pi" } as unknown as RuntimeConfig, null), false);
  assert.equal(isBuiltInGatewayCustomModelConfig(null, null), false);
});

test("parseAgentModelLimitsFrame accepts the daemon's frame and rejects malformed fields", () => {
  const frame = {
    type: "agent:model_limits", v: 1, agentId: "a", launchId: "l", sessionId: "s", configRevision: 2, daemonInstanceId: "inst-1", seq: 3, observedAtMs: 1_700_000_000_000, runtime: "builtin", modelLimits: MIXED,
  };
  assert.deepEqual(parseAgentModelLimitsFrame(frame), frame);
  const { launchId: _launchId, ...withoutLaunch } = frame;
  assert.deepEqual(parseAgentModelLimitsFrame(withoutLaunch), withoutLaunch);
  for (const bad of [
    { ...frame, v: 2 },
    { ...frame, configRevision: -1 },
    { ...frame, configRevision: 1.5 },
    { ...frame, seq: "3" },
    { ...frame, sessionId: "" },
    { ...frame, observedAtMs: Number.NaN },
    { ...frame, modelLimits: { contextWindow: MIXED.contextWindow } },
    { ...frame, launchId: 7 },
    { ...frame, daemonInstanceId: "" },
    { ...frame, daemonInstanceId: undefined },
  ]) {
    assert.equal(parseAgentModelLimitsFrame(bad), null, JSON.stringify(bad));
  }
});


