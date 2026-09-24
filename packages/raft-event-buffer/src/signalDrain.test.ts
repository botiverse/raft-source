import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  TRACE_EVENT_ROW_V2_SCHEMA_FINGERPRINT,
  TRACE_EVENT_ROW_V2_TABLE,
} from "@botiverse/raft-shared";
import { EventBuffer, type EventBufferDrainReceipt } from "./core.js";
import { installEventBufferSignalDrain, type EventBufferSignalProcess } from "./signalDrain.js";

test("SIGTERM performs a bounded drain before exiting", async () => {
  const emitter = new EventEmitter();
  let exitCode: number | null = null;
  let resolveExit!: () => void;
  const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
  const processLike = {
    once: (signal, listener) => emitter.once(signal, listener),
    removeListener: (signal, listener) => emitter.removeListener(signal, listener),
    exit: (code) => {
      exitCode = code;
      resolveExit();
    },
  } satisfies EventBufferSignalProcess;
  const receipts: Array<EventBufferDrainReceipt & { signal: "SIGTERM" | "SIGINT" }> = [];
  const buffer = new EventBuffer({
    exporter: {
      export: async (envelope) => ({ outcome: "committed", committedRows: envelope.rows.length }),
    },
    maxQueueRows: 8,
    maxQueueBytes: 8_192,
    maxBatchRows: 4,
    maxBatchBytes: 4_096,
    maxBatchAgeMs: 10_000,
    maxQps: 3,
  });
  buffer.enqueue({
    table: TRACE_EVENT_ROW_V2_TABLE,
    schemaFingerprint: TRACE_EVENT_ROW_V2_SCHEMA_FINGERPRINT,
    rows: [{ id: 1 }],
  });
  const uninstall = installEventBufferSignalDrain(buffer, {
    process: processLike,
    timeoutMs: 1_000,
    onReceipt: (receipt) => receipts.push(receipt),
  });

  emitter.emit("SIGTERM");
  await exited;
  uninstall();

  assert.equal(exitCode, 0);
  assert.deepEqual(receipts, [{ state: "drained", pendingRows: 0, signal: "SIGTERM" }]);
  assert.equal(buffer.metrics.snapshot().committedRows, 1);
});
