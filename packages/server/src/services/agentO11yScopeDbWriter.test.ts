import assert from "node:assert/strict";
import { test } from "vitest";

import {
  AGENT_O11Y_SCOPEDB_PERSISTENCE_TIER,
  AgentO11yWriterUnavailableError,
  SdkAgentO11yScopeDbWriter,
} from "./agentO11yScopeDbWriter.js";
import type { AgentO11yAcceptedEvent } from "./agentO11yValidation.js";

const event: AgentO11yAcceptedEvent = {
  event_kind: "turn",
  agent_id: "agent-1",
  turn_id: "turn-1",
  occurred_at: "2026-07-13T00:00:00.000Z",
  payload_tier: "T0",
  turn_trigger_hash: "sha256:trigger",
  fields: { outcome: "ok" },
};

const config = {
  endpoint: "https://scopedb.test",
  token: "test-token",
  ingestStatement: "INSERT INTO scopedb.agent.events SELECT * FROM $0",
};

test("agent o11y writer uses committed insert before acknowledging rows", async () => {
  const calls: Array<{ rows: string; statement: string }> = [];
  const writer = new SdkAgentO11yScopeDbWriter(config, {
    async insert(rows, statement) {
      calls.push({ rows, statement });
      return { num_rows_inserted: rows.split("\n").length };
    },
  });

  const result = await writer.writeEvents([event], {
    server_id: "server-1",
    computer_id: "computer-1",
    machine_id: "machine-1",
  });

  assert.equal(AGENT_O11Y_SCOPEDB_PERSISTENCE_TIER, "decision_support");
  assert.deepEqual(result, { accepted: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.statement, config.ingestStatement);
  assert.deepEqual(JSON.parse(calls[0]?.rows ?? "null"), {
    server_id: "server-1",
    computer_id: "computer-1",
    machine_id: "machine-1",
    event_kind: "turn",
    agent_id: "agent-1",
    turn_id: "turn-1",
    occurred_at: "2026-07-13T00:00:00.000Z",
    payload_mode: "hash",
    turn_trigger_hash: "sha256:trigger",
    step_input_hash: null,
    fields: { outcome: "ok" },
  });
});

test("agent o11y writer never turns a committed insert failure into accepted", async () => {
  const writer = new SdkAgentO11yScopeDbWriter(config, {
    async insert() {
      throw new Error("commit unavailable");
    },
  });

  await assert.rejects(
    writer.writeEvents([event], {
      server_id: "server-1",
      computer_id: "computer-1",
    }),
    (err: unknown) => {
      assert.ok(err instanceof AgentO11yWriterUnavailableError);
      assert.equal(err.code, "agent_o11y_writer_unavailable");
      assert.match(err.message, /commit unavailable/);
      return true;
    },
  );
});
