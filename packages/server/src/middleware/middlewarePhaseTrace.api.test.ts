import assert from "node:assert/strict";
import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";

import { createApiTest } from "../test/integration/apiTest";
import { tokenForHuman } from "../test/integration/credentials";
import { createServer, headers, seedUser } from "../routes/channels.api.fixtures";

/**
 * The time between the root `server.http.request` span's start and the
 * handler's first event explains itself: every pre-handler middleware phase
 * records `middleware.phase.finished` (only `phase` + `duration_ms`), and the
 * middleware's own reads record `db.query.finished` like handler reads do.
 */
const test = createApiTest();

test("GET /api/channels/ records each pre-handler middleware phase, in order, and its middleware queries", async ({ app }) => {
  const sink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({ sink }));

  const owner = await seedUser("mw-phase-owner@slock.test", "mw-phase-owner");
  const server = await createServer("Middleware Phase Server", "mw-phase-server", owner.id);
  const token = await tokenForHuman(owner.email);
  sink.clear();

  const res = await fetch(`${app.baseUrl}/api/channels/`, { headers: headers(token, server.id) });
  assert.equal(res.status, 200);

  const span = sink.getAllSpans().find((candidate) =>
    candidate.name === "server.http.request" && candidate.attrs?.route_pattern === "/api/channels",
  ) ?? sink.getAllSpans().find((candidate) => candidate.name === "server.http.request");
  assert.ok(span, "expected the GET /api/channels/ root span");

  const names = span.events.map((event) => event.name);
  const handlerStart = names.indexOf("channels.list.started");
  assert.ok(handlerStart > 0, `expected channels.list.started after the middleware phases: ${names.join(", ")}`);

  const phaseEvents = span.events.filter((event) => event.name === "middleware.phase.finished");
  assert.deepEqual(phaseEvents.map((event) => event.attrs?.phase), ["auth", "verified", "server_membership"]);
  for (const event of phaseEvents) {
    assert.deepEqual(Object.keys(event.attrs ?? {}).sort(), ["duration_ms", "phase"]);
    assert.equal(Number.isInteger(event.attrs?.duration_ms), true);
    assert.ok(Number(event.attrs?.duration_ms) >= 0);
  }
  // Every phase finishes before the handler starts.
  const lastPhaseIndex = names.lastIndexOf("middleware.phase.finished");
  assert.ok(lastPhaseIndex < handlerStart);

  // The middleware's two reads, each before its phase ends and the handler starts.
  const beforeHandler = span.events.slice(0, handlerStart);
  const middlewareQueries = beforeHandler.filter((event) => event.name === "db.query.finished");
  assert.deepEqual(
    middlewareQueries.map((event) => [event.attrs?.query_name, event.attrs?.phase]),
    [["auth.user_by_id", "auth"], ["server_members.membership_by_user", "server_membership"]],
  );
  for (const event of middlewareQueries) {
    assert.equal(event.attrs?.outcome, "success");
    assert.equal(event.attrs?.row_count, 1);
    assert.equal(typeof event.attrs?.duration_ms, "number");
  }
  assert.deepEqual(beforeHandler.map((event) => event.name === "db.query.finished" ? event.attrs?.query_name : event.attrs?.phase), [
    "auth.user_by_id",
    "auth",
    "verified",
    "server_members.membership_by_user",
    "server_membership",
  ]);
});

test("a request refused by the membership check records the phases that finished, and the membership read", async ({ app, seed }) => {
  const sink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({ sink }));

  const owner = await seedUser("mw-phase-refused-owner@slock.test", "mw-phase-refused-owner");
  const outsider = await seed.human();
  const server = await createServer("Middleware Phase Refused", "mw-phase-refused", owner.id);
  const token = await tokenForHuman(outsider.email);
  sink.clear();

  const res = await fetch(`${app.baseUrl}/api/channels/`, { headers: headers(token, server.id) });
  assert.equal(res.status, 403);

  const span = sink.getAllSpans().find((candidate) => candidate.name === "server.http.request");
  assert.ok(span);
  assert.deepEqual(
    span.events.filter((event) => event.name === "middleware.phase.finished").map((event) => event.attrs?.phase),
    ["auth", "verified"],
  );
  const membershipRead = span.events.find((event) =>
    event.name === "db.query.finished" && event.attrs?.query_name === "server_members.membership_by_user",
  );
  assert.equal(membershipRead?.attrs?.row_count, 0);
});
