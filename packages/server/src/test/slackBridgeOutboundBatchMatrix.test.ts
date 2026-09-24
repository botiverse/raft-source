import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";
import { eq } from "drizzle-orm";

import { getDb } from "../db/index.js";
import { channels, messages } from "../db/schema.js";
import { SlackBridgeFullFlowPreflightError } from "./slackBridgeFullFlowPreflight.js";

import {
  runSlackBridgeExecutableBatchCase,
  type SlackBridgeBatchCardinality,
  type SlackBridgeBatchResult,
  type SlackBridgeBatchSendMode,
  type SlackBridgeBatchTopology,
  type SlackBridgeExecutableBatchCase,
} from "./slackBridgeOutboundBatchHarness.js";

type Safety = "continue_same_random" | "stop_prestart" | "stop_ambiguous_provider";

interface BatchCase extends SlackBridgeExecutableBatchCase {
  http: 200 | 500 | "not_started";
  phase: "frontend_payload_projection" | "frontend_socket_emit" | null;
  expected: SlackBridgeBatchCardinality;
  providerOutcome: "accepted" | "outcome_unknown" | null;
  safety: Safety;
}

const topologies: readonly SlackBridgeBatchTopology[] = [
  "ordinary_channel",
  "joint_channel",
  "ordinary_thread",
];
const sendModes: readonly SlackBridgeBatchSendMode[] = ["first", "same_random_replay"];

function frontendCardinality(topology: SlackBridgeBatchTopology): SlackBridgeBatchCardinality {
  return topology === "ordinary_channel"
    ? { messages: 1, links: 0, outbound: 1, partitions: 1, attempts: 0, providerWrites: 0 }
    : { messages: 1, links: 0, outbound: 0, partitions: 0, attempts: 0, providerWrites: 0 };
}

const frontendCases: BatchCase[] = topologies.flatMap((topology) => sendModes.flatMap((sendMode) => ([
  ["payload_failure", "frontend_payload_projection"],
  ["socket_failure", "frontend_socket_emit"],
] as const).map(([result, phase]) => ({
  id: `${topology}.${sendMode}.${result}`,
  topology,
  sendMode,
  authority: "fresh" as const,
  result,
  http: result === "socket_failure" ? 200 as const : 500 as const,
  phase: result === "socket_failure" ? null : phase,
  expected: frontendCardinality(topology),
  providerOutcome: null,
  safety: "continue_same_random" as const,
}))));

const expiredAuthorityCases: BatchCase[] = sendModes.map((sendMode) => ({
  id: `ordinary_channel.${sendMode}.authority_expired`,
  topology: "ordinary_channel",
  sendMode,
  authority: "expired" as const,
  result: "not_reached" as const,
  http: "not_started" as const,
  phase: null,
  expected: { messages: 0, links: 0, outbound: 0, partitions: 0, attempts: 0, providerWrites: 0 },
  providerOutcome: null,
  safety: "stop_prestart" as const,
}));

const providerCases: BatchCase[] = sendModes.flatMap((sendMode) => ([
  ["provider_accepted", "accepted", "continue_same_random", 1],
  ["provider_timeout", "outcome_unknown", "stop_ambiguous_provider", 1],
] as const).map(([result, providerOutcome, safety, links]) => ({
  id: `ordinary_channel.${sendMode}.${result}`,
  topology: "ordinary_channel" as const,
  sendMode,
  authority: "fresh" as const,
  result,
  http: 200 as const,
  phase: null,
  expected: { messages: 1, links, outbound: 1, partitions: 1, attempts: 1, providerWrites: 1 },
  providerOutcome,
  safety,
})));

export const SLACK_BRIDGE_OUTBOUND_BATCH_MATRIX: readonly BatchCase[] = [
  ...frontendCases,
  ...expiredAuthorityCases,
  ...providerCases,
];

export const SLACK_BRIDGE_SANDBOX_ONE_SHOT_PLAN = [{
  step: 1,
  action: "read_only_preflight",
  requires: "ordinary channel; zero joint rows; one active external binding; exact runtime build fingerprint; fresh authority",
  stopOn: "any mismatch",
}, {
  step: 2,
  action: "same_random_replay_only",
  requires: "accepted provider identity and counts messages/links/outbound/partitions/attempts/providerWrites=3/3/1/1/1/1",
  stopOn: "any cardinality growth or provider call",
}, {
  step: 3,
  action: "restart_and_same_random_readback",
  requires: "step 2 conserved every durable/provider count",
  stopOn: "any authority drift, credential access mismatch, or provider call",
}, {
  step: 4,
  action: "final_read_only_conservation",
  requires: "HTTP 200 or fixed diagnostic with topology=ordinary_channel",
  stopOn: "always stop after receipt; no new randomId",
}] as const;

async function runtimeFingerprint(): Promise<string> {
  const manifest = JSON.parse(await readFile(
    new URL("./slackBridgeRuntimeBuildManifest.json", import.meta.url),
    "utf8",
  )) as { schema: string; fingerprint: string };
  assert.equal(manifest.schema, "slack-bridge-runtime-build-manifest.v1");
  assert.match(manifest.fingerprint, /^[0-9a-f]{64}$/);
  return manifest.fingerprint;
}

test("batch matrix executes every claimed production-shaped scenario and asserts its receipt", async () => {
  assert.equal(new Set(SLACK_BRIDGE_OUTBOUND_BATCH_MATRIX.map((entry) => entry.id)).size, SLACK_BRIDGE_OUTBOUND_BATCH_MATRIX.length);
  const fingerprint = await runtimeFingerprint();
  const executed: string[] = [];

  for (const entry of SLACK_BRIDGE_OUTBOUND_BATCH_MATRIX) {
    const receipt = await runSlackBridgeExecutableBatchCase(entry, fingerprint);
    executed.push(receipt.id);
    assert.equal(receipt.topology, entry.topology, `${entry.id}: topology`);
    assert.equal(receipt.http, entry.http, `${entry.id}: HTTP`);
    assert.equal(receipt.phase, entry.phase, `${entry.id}: phase`);
    assert.deepEqual(receipt.cardinality, entry.expected, `${entry.id}: cardinality`);
    assert.equal(receipt.providerOutcome, entry.providerOutcome, `${entry.id}: provider outcome`);
  }

  assert.deepEqual(executed, SLACK_BRIDGE_OUTBOUND_BATCH_MATRIX.map((entry) => entry.id));
});

test("batch matrix is complete across topology, send mode, authority, frontend, and provider outcomes", () => {
  for (const topology of topologies) {
    for (const sendMode of sendModes) {
      for (const result of ["payload_failure", "socket_failure"] as readonly SlackBridgeBatchResult[]) {
        assert.ok(SLACK_BRIDGE_OUTBOUND_BATCH_MATRIX.some((entry) =>
          entry.topology === topology && entry.sendMode === sendMode && entry.authority === "fresh" && entry.result === result
        ));
      }
    }
  }
  for (const sendMode of sendModes) {
    assert.ok(SLACK_BRIDGE_OUTBOUND_BATCH_MATRIX.some((entry) =>
      entry.topology === "ordinary_channel" && entry.sendMode === sendMode && entry.authority === "expired"
    ));
    for (const result of ["provider_accepted", "provider_timeout"] as const) {
      assert.ok(SLACK_BRIDGE_OUTBOUND_BATCH_MATRIX.some((entry) =>
        entry.topology === "ordinary_channel" && entry.sendMode === sendMode && entry.result === result
      ));
    }
  }
  assert.equal(
    SLACK_BRIDGE_OUTBOUND_BATCH_MATRIX.filter((entry) => entry.authority === "expired").length,
    2,
    "expired Slack authority exists only on the ordinary external projection",
  );
  assert.deepEqual(SLACK_BRIDGE_SANDBOX_ONE_SHOT_PLAN.map((entry) => entry.step), [1, 2, 3, 4]);
});

test("expired authority cases derive topology and cardinality from their PGlite fixture", async () => {
  const fingerprint = await runtimeFingerprint();
  const entry = expiredAuthorityCases[0]!;
  const receipt = await runSlackBridgeExecutableBatchCase(entry, fingerprint, {
    async onDatabaseReady({ channelId, ownerId }) {
      await getDb().insert(messages).values({
        channelId,
        senderType: "user",
        senderId: ownerId,
        content: "database cardinality evidence",
      });
    },
  });
  assert.deepEqual(receipt.cardinality, {
    messages: 1,
    links: 0,
    outbound: 0,
    partitions: 0,
    attempts: 0,
    providerWrites: 0,
  });

  await assert.rejects(
    runSlackBridgeExecutableBatchCase(entry, fingerprint, {
      async onDatabaseReady({ channelId }) {
        await getDb().update(channels).set({ type: "joint" }).where(eq(channels.id, channelId));
      },
    }),
    (error) => error instanceof SlackBridgeFullFlowPreflightError && error.gate === "topology",
    "the receipt topology cannot echo matrix metadata over a drifted database row",
  );
});
