import assert from "node:assert/strict";
import { test } from "vitest";
import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";

import { withTraceRoot } from "../tracing/semanticTrace";
import type { SlackWebApiTransportResult } from "./slackProviderAdapter";
import { SLACK_WEB_API_REQUEST_SPAN, traceSlackWebApiRequest } from "./slackWebApiTrace";

const TOKEN = "xoxb-test-secret-token";
const CHANNEL_ID = "C0123SECRET";
const USER_ID = "U0456SECRET";
const URL_WITH_QUERY = `https://slack.com/api/conversations.members?channel=${CHANNEL_ID}`;

async function traced(method: string, result: SlackWebApiTransportResult | Error) {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  await withTraceRoot(tracer, "server.slack_bridge.lifecycle.drain", { surface: "server", kind: "internal" }, async () => {
    await traceSlackWebApiRequest(method, async () => {
      if (result instanceof Error) throw result;
      return result;
    }).catch(() => undefined);
  });
  const root = sink.getAllSpans().find((span) => span.name === "server.slack_bridge.lifecycle.drain");
  assert.ok(root, "drain root span recorded");
  const span = sink.getAllSpans().find((candidate) => candidate.name === SLACK_WEB_API_REQUEST_SPAN);
  assert.ok(span, "Slack Web API client span recorded");
  assert.equal(span.context.traceId, root.context.traceId);
  assert.equal(span.context.parentSpanId, root.context.spanId);
  assert.equal(span.kind, "client");
  return span;
}

function assertNoSensitiveContent(span: unknown) {
  const serialized = JSON.stringify(span);
  for (const secret of [TOKEN, CHANNEL_ID, USER_ID, "slack.com", "?channel=", "hello from slack"]) {
    assert.ok(!serialized.includes(secret), `span must not carry ${secret}`);
  }
}

test("a 429 records method, status, rate_limited and Retry-After, and nothing sensitive", async () => {
  const span = await traced("conversations.members", {
    kind: "response",
    status: 429,
    headers: { "Retry-After": "30", "x-slack-req-id": "req-1", authorization: `Bearer ${TOKEN}` },
    body: { ok: false, error: "ratelimited", channel: CHANNEL_ID, members: [USER_ID], url: URL_WITH_QUERY },
  });
  assert.equal(span.attrs?.slack_method, "conversations.members");
  assert.equal(span.attrs?.http_status, 429);
  assert.equal(span.attrs?.outcome, "http_error");
  assert.equal(span.attrs?.rate_limited, true);
  assert.equal(span.attrs?.retry_after_s, 30);
  assert.equal(span.attrs?.slack_error, "ratelimited");
  assert.equal(typeof span.attrs?.duration_ms, "number");
  assertNoSensitiveContent(span);
});

test("a successful call records ok without Retry-After or slack_error", async () => {
  const span = await traced("users.info", {
    kind: "response",
    status: 200,
    headers: {},
    body: { ok: true, user: { id: USER_ID, name: "hello from slack" } },
  });
  assert.equal(span.attrs?.slack_method, "users.info");
  assert.equal(span.attrs?.http_status, 200);
  assert.equal(span.attrs?.outcome, "ok");
  assert.equal(span.attrs?.rate_limited, false);
  assert.equal(span.attrs?.retry_after_s, undefined);
  assert.equal(span.attrs?.slack_error, undefined);
  assertNoSensitiveContent(span);
});

test("ok:false records Slack's error code only, collapsing anything that is not a code", async () => {
  const coded = await traced("usergroups.users.update", {
    kind: "response",
    status: 200,
    headers: {},
    body: { ok: false, error: "channel_not_found" },
  });
  assert.equal(coded.attrs?.outcome, "slack_error");
  assert.equal(coded.attrs?.slack_error, "channel_not_found");
  assert.equal(coded.attrs?.rate_limited, false);

  const prose = await traced("chat.postMessage", {
    kind: "response",
    status: 200,
    headers: {},
    body: { ok: false, error: `hello from slack ${CHANNEL_ID}` },
  });
  assert.equal(prose.attrs?.slack_error, "other");
  assertNoSensitiveContent(prose);
});

test("transport failures and non-method strings stay bounded", async () => {
  const failed = await traced("conversations.info", { kind: "transport_failure", phase: "unknown", code: "timeout" });
  assert.equal(failed.attrs?.outcome, "transport_error");
  assert.equal(failed.attrs?.error_code, "timeout");
  assert.equal(failed.attrs?.http_status, undefined);

  const thrown = await traced("conversations.info", new Error(`fetch ${URL_WITH_QUERY} with ${TOKEN}`));
  assert.equal(thrown.attrs?.outcome, "transport_error");
  assertNoSensitiveContent(thrown);

  const odd = await traced(URL_WITH_QUERY, { kind: "response", status: 200, headers: {}, body: { ok: true } });
  assert.equal(odd.attrs?.slack_method, "other");
  assertNoSensitiveContent(odd);
});
