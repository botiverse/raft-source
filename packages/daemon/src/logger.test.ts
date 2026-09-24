import assert from "node:assert/strict";
import { test } from "vitest";
import { logger, subscribeDaemonLogs } from "./logger.js";

test("daemon log subscribers receive structured events and can unsubscribe", () => {
  const events: Array<{ level: string; line: string; message: string }> = [];
  const unsubscribe = subscribeDaemonLogs((event) => {
    events.push(event);
  });

  logger.info("hello");
  logger.warn("careful");
  unsubscribe();
  logger.error("boom");

  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.level), ["INFO", "WARN"]);
  assert.match(events[0]?.line ?? "", /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z \[INFO\] hello$/);
  assert.equal(events[1]?.message, "careful");
});
