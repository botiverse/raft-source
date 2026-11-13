import assert from "node:assert/strict";
import { test } from "vitest";
import { readHandsErrorCode } from "./productFeedbackRouteBindingService";

test("readHandsErrorCode keeps an identifier-shaped `code` from a Hands error body", async () => {
  assert.equal(
    await readHandsErrorCode(Response.json({ code: "REPORTER_BACKEND_UNAVAILABLE", message: "x" }, { status: 503 })),
    "REPORTER_BACKEND_UNAVAILABLE",
  );
});

test("readHandsErrorCode returns null for anything that is not an identifier-shaped code", async () => {
  const bodies: Array<BodyInit | null> = [
    null,
    "",
    "busy",
    "<html>502 Bad gateway</html>",
    JSON.stringify({}),
    JSON.stringify({ code: 503 }),
    JSON.stringify({ code: "reporter backend unavailable" }),
    JSON.stringify({ code: "A".repeat(65) }),
    JSON.stringify({ code: "OK\nINJECTED" }),
    JSON.stringify([{ code: "ARRAY" }]),
  ];
  for (const body of bodies) {
    assert.equal(await readHandsErrorCode(new Response(body, { status: 500 })), null, String(body));
  }
});

test("readHandsErrorCode reads at most 4 KiB of the body", async () => {
  // A code pushed past the first 4 KiB is never parsed: the truncated JSON fails.
  const padded = JSON.stringify({ pad: "x".repeat(5_000), code: "LATE_CODE" });
  assert.equal(await readHandsErrorCode(new Response(padded, { status: 500 })), null);
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new Uint8Array(1_024).fill(0x20));
      if (pulled > 100) controller.close();
    },
  });
  assert.equal(await readHandsErrorCode(new Response(stream, { status: 500 })), null);
  assert.ok(pulled <= 6, `read ${pulled} chunks`);
});

test("readHandsErrorCode gives up on a stalled body after its deadline", async () => {
  const stalled = new ReadableStream<Uint8Array>({ start() { /* headers sent, body never arrives */ } });
  const started = Date.now();
  assert.equal(await readHandsErrorCode(new Response(stalled, { status: 503 }), 50), null);
  assert.ok(Date.now() - started < 1_000, "a stalled error body must not hold the failure");
});
