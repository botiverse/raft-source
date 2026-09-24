import assert from "node:assert/strict";
import { test } from "vitest";
import { stripSocketTraceMetadata } from "./index.js";

test("stripSocketTraceMetadata removes tracing envelope without mutating payload semantics", () => {
  const payload = {
    channelId: "channel-1",
    content: "hello",
    _trace: { traceparent: "00-abc-def-01", interactionId: "interaction-1" },
    nested: {
      keep: true,
      _trace: { traceparent: "00-nested-def-01" },
    },
    items: [
      { id: "item-1", _trace: { traceparent: "00-item-def-01" } },
      "plain",
    ],
  };

  assert.deepEqual(stripSocketTraceMetadata(payload), {
    channelId: "channel-1",
    content: "hello",
    nested: { keep: true },
    items: [{ id: "item-1" }, "plain"],
  });
});
