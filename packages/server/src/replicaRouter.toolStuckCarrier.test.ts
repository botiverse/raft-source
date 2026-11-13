import assert from "node:assert/strict";
import { decodeActivityTypedCarriers } from "./replicaRouter";

const toolStuck = {
  toolName: "bash",
  toolDetailKind: "running_command",
  startedAtMs: 1_000,
  quietSinceMs: 1_000,
  thresholdMs: 600_000,
  queuedMessages: 2,
};

test("task #25: the mirrored toolStuck carrier is read back normalized, beside a kind carrier", () => {
  const raw = JSON.stringify({ toolStuck: { ...toolStuck, command: "pnpm dev" }, spawnFailure: { reason: "runtime_not_found" } });
  assert.deepEqual(decodeActivityTypedCarriers(raw), { spawnFailure: { reason: "runtime_not_found" }, toolStuck });
});

test("task #25: a malformed mirrored toolStuck carrier is dropped", () => {
  assert.equal(decodeActivityTypedCarriers(JSON.stringify({ toolStuck: { ...toolStuck, queuedMessages: -1 } })), undefined);
});
