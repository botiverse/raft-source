import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import express from "express";
import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";
import { runWithTraceSpan } from "../tracing/semanticTrace";
import { guardUuidPathParams, pathParamShape } from "./uuidPathParams";

test("pathParamShape keeps only length and character classes, never the value", () => {
  assert.deepEqual(pathParamShape("temp-1731"), { value_length: 9, value_shape: "aaaa-9999" });
  assert.deepEqual(pathParamShape("频道"), { value_length: 2, value_shape: "??" });
  assert.equal(pathParamShape("x".repeat(60)).value_shape.length, 48);
  assert.equal(pathParamShape("x".repeat(60)).value_length, 60);
});

test("a non-UUID path param is refused with a path_param.rejected event on the request span", async () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  const router = express.Router();
  guardUuidPathParams(router, { id: "Channel", messageId: "Message" });
  let reachedHandler = false;
  router.get("/:id/threads/:messageId", (_req, res) => {
    reachedHandler = true;
    res.json({ ok: true });
  });
  const app = express();
  app.use((req, res, next) => {
    const span = tracer.startSpan("server.http.request", { surface: "server" });
    res.on("finish", () => span.end("ok"));
    runWithTraceSpan(span, next, tracer);
  });
  app.use("/api/channels", router);
  const server = app.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/api/channels/00000000-0000-4000-8000-000000000001/threads/temp-1731`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "Message not found" });
    assert.equal(reachedHandler, false);
    await new Promise((resolve) => setImmediate(resolve));
    const span = sink.getAllSpans().find((s) => s.name === "server.http.request");
    const event = span?.events.find((e) => e.name === "path_param.rejected");
    assert.deepEqual(event?.attrs, { param: "messageId", value_length: 9, value_shape: "aaaa-9999" });
  } finally {
    server.close();
  }
});
