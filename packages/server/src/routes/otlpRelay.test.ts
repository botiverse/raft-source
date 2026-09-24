import assert from "node:assert/strict";
import { test } from "vitest";
import { normalizeOtlpTracesEndpoint, otlpRelayHandler } from "./otlpRelay.js";

function createResponse() {
  const result = {
    statusCode: 200,
    body: undefined as unknown,
  };
  const res = {
    status(code: number) {
      result.statusCode = code;
      return res;
    },
    json(body: unknown) {
      result.body = body;
      return res;
    },
  };
  return { res, result };
}

function createRequest(options: { authorization?: string; contentType?: string; body?: Buffer }) {
  return {
    body: options.body ?? Buffer.from("{}"),
    get(name: string) {
      const lower = name.toLowerCase();
      if (lower === "authorization") return options.authorization;
      if (lower === "content-type") return options.contentType;
      return undefined;
    },
  };
}

test("otlp relay requires exact authorization header", async () => {
  const { res, result } = createResponse();

  await otlpRelayHandler(createRequest({ authorization: "Bearer wrong" }) as any, res as any, {
    authorization: "Bearer expected",
    targetUrl: "https://telescope.test",
  });

  assert.equal(result.statusCode, 401);
  assert.deepEqual(result.body, { error: "Unauthorized" });
});

test("otlp relay forwards raw body to configured telescope endpoint", async () => {
  const { res, result } = createResponse();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const rawBody = Buffer.from(JSON.stringify({ resourceSpans: [] }));

  await otlpRelayHandler(
    createRequest({
      authorization: "Bearer expected",
      contentType: "application/json",
      body: rawBody,
    }) as any,
    res as any,
    {
      authorization: "Bearer expected",
      targetUrl: "https://telescope.test",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response("", { status: 200 });
      },
    },
  );

  assert.equal(result.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://telescope.test/v1/traces");
  assert.equal((calls[0].init.headers as Record<string, string>)["content-type"], "application/json");
  assert.equal(Buffer.from(calls[0].init.body as Uint8Array).toString("utf8"), rawBody.toString("utf8"));
});

test("otlp relay rejects oversized bodies before forwarding", async () => {
  const { res, result } = createResponse();
  let fetchCalled = false;

  await otlpRelayHandler(
    createRequest({
      authorization: "Bearer expected",
      body: Buffer.alloc(6),
    }) as any,
    res as any,
    {
      authorization: "Bearer expected",
      targetUrl: "https://telescope.test",
      maxBytes: "5",
      fetch: async () => {
        fetchCalled = true;
        return new Response("", { status: 200 });
      },
    },
  );

  assert.equal(result.statusCode, 413);
  assert.equal(fetchCalled, false);
});

test("otlp relay maps upstream failure without leaking response body", async () => {
  const { res, result } = createResponse();

  await otlpRelayHandler(createRequest({ authorization: "Bearer expected" }) as any, res as any, {
    authorization: "Bearer expected",
    targetUrl: "https://telescope.test",
    fetch: async () => new Response("raw upstream error text", { status: 503 }),
  });

  assert.equal(result.statusCode, 502);
  assert.deepEqual(result.body, {
    error: "OTLP upstream failed",
    upstream_status: 503,
  });
});

test("normalizes OTLP HTTP traces endpoint", () => {
  assert.equal(normalizeOtlpTracesEndpoint("https://telescope.test"), "https://telescope.test/v1/traces");
  assert.equal(normalizeOtlpTracesEndpoint("https://telescope.test/v1/traces"), "https://telescope.test/v1/traces");
});
