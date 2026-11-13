// #proj-runtime:#53: reading a gateway's model limits, against the public
// contract docs.raft.build/developers/gateway-model-limits.
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fetch as undiciFetch } from "undici";
import { readFileSync } from "node:fs";
import {
  CLIPROXYAPI_PI_MODEL_LIST_READER,
  GATEWAY_MODEL_LIMITS_CACHE_MS,
  GENERIC_MODEL_LIST_READER,
  gatewayClientVersionCatalogUrl,
  gatewayModelListUrl,
  parseGatewayModelEntryLimits,
  parseGatewayModelList,
  readGatewayModelLimits,
  resetGatewayModelLimitsCacheForTests,
} from "./gatewayModelLimits";

const realFetch = undiciFetch as unknown as typeof globalThis.fetch;

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

async function withServer(handler: Handler, run: (baseUrl: string, requests: http.IncomingMessage[]) => Promise<void>): Promise<void> {
  const requests: http.IncomingMessage[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req);
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}/v1`, requests);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function json(res: http.ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

beforeEach(() => resetGatewayModelLimitsCacheForTests());

test("each field name the page lists is read, in the page's order, first valid value wins", () => {
  const openai = (entry: Record<string, unknown>) => parseGatewayModelEntryLimits(entry, "openai-compatible");
  assert.deepEqual(openai({ context_length: 262144, max_completion_tokens: 64000 }), { contextWindow: 262144, maxTokens: 64000 });
  assert.deepEqual(openai({ context_window: 1 }), { contextWindow: 1 });
  assert.deepEqual(openai({ max_model_len: 32768 }), { contextWindow: 32768 }, "vLLM");
  assert.deepEqual(openai({ top_provider: { context_length: 128000, max_completion_tokens: 16384 } }), { contextWindow: 128000, maxTokens: 16384 }, "OpenRouter");
  assert.deepEqual(openai({ max_input_tokens: 200000 }), { contextWindow: 200000 }, "input-only limit used as the context window");
  assert.deepEqual(openai({ input_token_limit: 1048576, output_token_limit: 65536 }), { contextWindow: 1048576, maxTokens: 65536 }, "Gemini");
  assert.deepEqual(openai({ max_output_tokens: 8000 }), { maxTokens: 8000 });

  assert.deepEqual(openai({ context_length: 100, context_window: 200, max_model_len: 300 }), { contextWindow: 100 }, "context_length first");
  assert.deepEqual(openai({ context_window: 200, max_input_tokens: 150 }), { contextWindow: 200 }, "a total wins over an input-only limit");
  assert.deepEqual(openai({ max_completion_tokens: 10, max_output_tokens: 20 }), { maxTokens: 10 }, "max_completion_tokens first");
  assert.deepEqual(openai({ context_length: 0, context_window: 4096 }), { contextWindow: 4096 }, "an invalid value falls to the next name");
});

test("a value is a positive whole number of tokens, context up to 10,000,000 and output up to 1,000,000; anything else is ignored", () => {
  const context = (value: unknown) => parseGatewayModelEntryLimits({ context_length: value }, "openai-compatible");
  const output = (value: unknown) => parseGatewayModelEntryLimits({ max_completion_tokens: value }, "openai-compatible");
  assert.deepEqual(context(10_000_000), { contextWindow: 10_000_000 });
  assert.equal(context(10_000_001), null);
  assert.deepEqual(output(1_000_000), { maxTokens: 1_000_000 });
  assert.equal(output(1_000_001), null, "the output cap is lower than the context cap");
  for (const bad of [0, -1, 1.5, "262144", null, true, Number.NaN, Number.POSITIVE_INFINITY, {}]) {
    assert.equal(context(bad), null, `ignored: ${String(bad)}`);
    assert.equal(output(bad), null, `ignored: ${String(bad)}`);
  }
});

test("max_tokens counts as max output only on Anthropic-compatible gateways", () => {
  assert.equal(parseGatewayModelEntryLimits({ max_tokens: 64000 }, "openai-compatible"), null);
  assert.deepEqual(parseGatewayModelEntryLimits({ max_tokens: 64000, max_input_tokens: 200000 }, "anthropic-compatible"), { contextWindow: 200000, maxTokens: 64000 });
  assert.deepEqual(parseGatewayModelEntryLimits({ max_tokens: 1, max_completion_tokens: 2 }, "anthropic-compatible"), { maxTokens: 2 }, "the common names still come first");
});

test("the list is a data array keyed by exact, case-sensitive id; models without valid limits are left out", () => {
  const list = parseGatewayModelList({
    object: "list",
    data: [
      { id: "swe-2-flash", object: "model", context_length: 262144, max_completion_tokens: 64000 },
      { id: "SWE-2-FLASH", context_length: 1 },
      { id: "swe-2-flash", context_length: 999 },
      { id: "no-limits", object: "model" },
      { context_length: 5 },
      "not-an-object",
    ],
  }, "openai-compatible");
  assert.ok(list);
  assert.deepEqual([...list.keys()], ["swe-2-flash", "SWE-2-FLASH"]);
  assert.deepEqual(list.get("swe-2-flash"), { contextWindow: 262144, maxTokens: 64000 }, "a repeated id keeps its first entry");
  assert.equal(parseGatewayModelList({ models: [] }, "openai-compatible"), null);
  assert.equal(parseGatewayModelList([], "openai-compatible"), null);
});

test("the list URL is <Base URL>/models, or <Base URL>/v1/models?limit=1000 for Anthropic-compatible", () => {
  assert.equal(gatewayModelListUrl("https://gw.example/v1/", "openai-compatible"), "https://gw.example/v1/models");
  assert.equal(gatewayModelListUrl("https://gw.example/anthropic", "anthropic-compatible"), "https://gw.example/anthropic/v1/models?limit=1000");
});

test("an OpenAI-compatible read sends the key as a Bearer token to <Base URL>/models and finds the model", async () => {
  await withServer((_req, res) => json(res, { data: [{ id: "m", context_length: 128000, max_completion_tokens: 16000 }] }), async (baseUrl, requests) => {
    const result = await readGatewayModelLimits({ kind: "openai-compatible", baseUrl, apiKey: "sk-test", modelId: "m", fetch: realFetch });
    assert.deepEqual(result, { limits: { contextWindow: 128000, maxTokens: 16000 }, outcome: "ok", cached: false, format: "generic", fallbackRead: false });
    assert.equal(requests[0]?.url, "/v1/models");
    assert.equal(requests[0]?.headers.authorization, "Bearer sk-test");
    assert.equal(requests[0]?.headers["x-api-key"], undefined);
  });
});

test("an Anthropic-compatible read sends x-api-key and anthropic-version to <Base URL>/v1/models?limit=1000, one page only", async () => {
  await withServer((_req, res) => json(res, { data: [{ id: "claude-x", max_input_tokens: 200000, max_tokens: 64000 }], has_more: true, last_id: "claude-x" }), async (baseUrl, requests) => {
    const result = await readGatewayModelLimits({ kind: "anthropic-compatible", baseUrl: baseUrl.replace(/\/v1$/, "/anthropic"), apiKey: "ak-test", modelId: "claude-x", fetch: realFetch });
    assert.deepEqual(result.limits, { contextWindow: 200000, maxTokens: 64000 });
    assert.equal(requests[0]?.url, "/anthropic/v1/models?limit=1000");
    assert.equal(requests.length, 1, "no further pages");
    assert.equal(requests[0]?.headers["x-api-key"], "ak-test");
    assert.equal(requests[0]?.headers["anthropic-version"], "2023-06-01");
    assert.equal(requests[0]?.headers.authorization, undefined);
  });
});

test("a model the list carries without a valid limit is no_limits, not not_listed", async () => {
  await withServer((_req, res) => json(res, { data: [{ id: "m" }, { id: "n", context_length: "big" }, { id: "other", context_length: 1000 }] }), async (baseUrl) => {
    for (const modelId of ["m", "n"]) {
      const result = await readGatewayModelLimits({ kind: "openai-compatible", baseUrl, apiKey: "k", modelId, fetch: realFetch });
      assert.equal(result.outcome, "no_limits", modelId);
      assert.equal(result.limits, null);
    }
    const absent = await readGatewayModelLimits({ kind: "openai-compatible", baseUrl, apiKey: "k", modelId: "M", fetch: realFetch });
    assert.equal(absent.outcome, "not_listed", "ids match exactly, case-sensitive");
    assert.equal(absent.cached, true);
  });
});

test("a model the list does not carry is not_listed; a 4xx/5xx, non-JSON or wrong shape is a failure with its class", async () => {
  await withServer((_req, res) => json(res, { data: [{ id: "other", context_length: 1000 }] }), async (baseUrl) => {
    assert.deepEqual(await readGatewayModelLimits({ kind: "openai-compatible", baseUrl, apiKey: "k", modelId: "m", fetch: realFetch }), { limits: null, outcome: "not_listed", cached: false, fallbackRead: false });
  });
  for (const [handler, outcome] of [
    [(_req: http.IncomingMessage, res: http.ServerResponse) => json(res, { error: "no" }, 401), "failed:http_status"],
    [(_req: http.IncomingMessage, res: http.ServerResponse) => { res.writeHead(200); res.end("<html>"); }, "failed:invalid_json"],
    [(_req: http.IncomingMessage, res: http.ServerResponse) => json(res, { models: [] }), "failed:invalid_shape"],
  ] as const) {
    resetGatewayModelLimitsCacheForTests();
    await withServer(handler, async (baseUrl) => {
      const result = await readGatewayModelLimits({ kind: "openai-compatible", baseUrl, apiKey: "k", modelId: "m", fetch: realFetch });
      assert.equal(result.outcome, outcome);
      assert.equal(result.limits, null);
    });
  }
});

test("a redirect is refused and not followed, so the key reaches only the Base URL", async () => {
  let elsewhereRequests = 0;
  await withServer((_req, res) => { elsewhereRequests += 1; json(res, { data: [{ id: "m", context_length: 1 }] }); }, async (elsewhere) => {
    await withServer((_req, res) => { res.writeHead(302, { location: `${elsewhere}/models` }); res.end(); }, async (baseUrl) => {
      const result = await readGatewayModelLimits({ kind: "openai-compatible", baseUrl, apiKey: "k", modelId: "m", fetch: realFetch });
      assert.equal(result.outcome, "failed:redirect");
      assert.equal(elsewhereRequests, 0, "the redirect target never saw a request (or the key)");
    });
  });
});

test("a response past the size cap, or slower than the timeout, fails without waiting for the rest", async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write(`{"data":[${"0,".repeat(600)}`);
    // Never ends: the cap must stop reading on its own.
  }, async (baseUrl) => {
    const result = await readGatewayModelLimits({ kind: "openai-compatible", baseUrl, apiKey: "k", modelId: "m", fetch: realFetch, maxBytes: 1_000, timeoutMs: 2_000 });
    assert.equal(result.outcome, "failed:too_large");
  });
  resetGatewayModelLimitsCacheForTests();
  await withServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json", "content-length": "5000" });
    res.end();
  }, async (baseUrl) => {
    const result = await readGatewayModelLimits({ kind: "openai-compatible", baseUrl, apiKey: "k", modelId: "m", fetch: realFetch, maxBytes: 1_000 });
    assert.equal(result.outcome, "failed:too_large", "a declared length past the cap is refused before reading");
  });
  resetGatewayModelLimitsCacheForTests();
  await withServer(() => { /* never answers */ }, async (baseUrl) => {
    const result = await readGatewayModelLimits({ kind: "openai-compatible", baseUrl, apiKey: "k", modelId: "m", fetch: realFetch, timeoutMs: 50 });
    assert.equal(result.outcome, "failed:timeout");
  });
});

test("one read per Base URL and key per hour, failures included; concurrent reads share one request; another key reads again", async () => {
  await withServer((_req, res) => setTimeout(() => json(res, { data: [{ id: "a", context_length: 1000 }, { id: "b", max_completion_tokens: 50 }] }), 20), async (baseUrl, requests) => {
    let now = 1_000_000;
    const read = (modelId: string, apiKey = "k1") => readGatewayModelLimits({ kind: "openai-compatible", baseUrl, apiKey, modelId, fetch: realFetch, nowMs: () => now });
    const [first, second] = await Promise.all([read("a"), read("b")]);
    assert.equal(requests.length, 1, "concurrent reads share one request");
    assert.deepEqual(first, { limits: { contextWindow: 1000 }, outcome: "ok", cached: false, format: "generic", fallbackRead: false });
    assert.deepEqual(second, { limits: { maxTokens: 50 }, outcome: "ok", cached: true, format: "generic", fallbackRead: false });
    assert.deepEqual(await read("a"), { limits: { contextWindow: 1000 }, outcome: "ok", cached: true, format: "generic", fallbackRead: false });
    assert.equal(requests.length, 1, "served from the cache");
    await read("a", "k2");
    assert.equal(requests.length, 2, "another key is another cache entry");
    now += GATEWAY_MODEL_LIMITS_CACHE_MS + 1;
    await read("a");
    assert.equal(requests.length, 3, "read again after an hour");
  });
  resetGatewayModelLimitsCacheForTests();
  await withServer((_req, res) => json(res, {}, 500), async (baseUrl, requests) => {
    const read = () => readGatewayModelLimits({ kind: "openai-compatible", baseUrl, apiKey: "k", modelId: "m", fetch: realFetch });
    assert.equal((await read()).outcome, "failed:http_status");
    assert.deepEqual(await read(), { limits: null, outcome: "failed:http_status", cached: true, fallbackRead: false });
    assert.equal(requests.length, 1, "a failure is cached for the hour too");
  });
});

test("a Base URL that is not a URL fails without a request", async () => {
  let calls = 0;
  const fetchSpy = (async () => { calls += 1; throw new Error("unexpected"); }) as unknown as typeof globalThis.fetch;
  const result = await readGatewayModelLimits({ kind: "openai-compatible", baseUrl: "not a url", apiKey: "k", modelId: "m", fetch: fetchSpy });
  assert.equal(result.outcome, "failed:network");
  assert.equal(calls, 0);
});

// A stock CLIProxyAPI (github.com/router-for-me/CLIProxyAPI, v8.0.61): its plain
// GET /v1/models keeps only id/object/created/owned_by
// (sdk/api/handlers/openai/openai_handlers.go OpenAIModels); with
// `?client_version=` it serves the Codex-client catalog
// (internal/client/codex/models BuildResponseForClientWithToolCapabilities).
// The fixture's first entry is upstream's internal/registry/models/codex_client_models.json
// first template (long prose shortened); the second is a non-template model as
// applyCodexClientModelMetadata + applyCodexClientMaxTokens build it; the third
// carries no limit.
const CPA_CATALOG = JSON.parse(readFileSync(new URL("./fixtures/gatewayModelLists/cliproxyapi-client-version-pi.json", import.meta.url), "utf8")) as unknown;
const CPA_PLAIN_LIST = {
  object: "list",
  data: [
    { id: "gpt-6.1-sol", object: "model", created: 1, owned_by: "openai" },
    { id: "glm-5.2", object: "model", created: 1, owned_by: "zhipu" },
  ],
};

test("the CLIProxyAPI reader reads the client_version catalog by slug, context_window first, like CLIProxyAPI's own Pi plugin", () => {
  const read = CLIPROXYAPI_PI_MODEL_LIST_READER.read(CPA_CATALOG, "openai-compatible");
  assert.ok(read);
  assert.deepEqual([...read.ids], ["gpt-6.1-sol", "glm-5.2", "limitless"]);
  assert.deepEqual(read.models.get("gpt-6.1-sol"), { limits: { contextWindow: 500000 }, format: "cliproxyapi_pi" }, "context_window, not the larger max_context_window");
  assert.deepEqual(read.models.get("glm-5.2"), { limits: { contextWindow: 202752, maxTokens: 131072 }, format: "cliproxyapi_pi" });
  assert.equal(read.models.has("limitless"), false);

  const one = (entry: Record<string, unknown>) => CLIPROXYAPI_PI_MODEL_LIST_READER.read({ models: [entry] }, "openai-compatible")?.models.get("m")?.limits ?? null;
  assert.deepEqual(one({ slug: "m", max_context_window: 400000, max_output_tokens: 9000 }), { contextWindow: 400000, maxTokens: 9000 });
  assert.deepEqual(one({ id: "m", context_window: 0, max_context_window: 1000, max_completion_tokens: 10 }), { contextWindow: 1000, maxTokens: 10 }, "id when no slug; an invalid value falls through");
  assert.equal(one({ slug: "m", context_window: 20_000_000, max_tokens: 1.5 }), null, "the same value rules as the generic reader");
  assert.equal(CLIPROXYAPI_PI_MODEL_LIST_READER.read({ data: [{ slug: "m", context_window: 1 }] }, "openai-compatible")?.models.get("m")?.limits.contextWindow, 1, "a data array, as the plugin accepts");
  assert.equal(CLIPROXYAPI_PI_MODEL_LIST_READER.read({ object: "list" }, "openai-compatible"), null);

  assert.equal(GENERIC_MODEL_LIST_READER.read(CPA_CATALOG, "openai-compatible"), null, "the generic reader does not claim the catalog");
  assert.equal(GENERIC_MODEL_LIST_READER.read(CPA_PLAIN_LIST, "openai-compatible")?.models.size, 0, "the plain list carries no limits");
});

test("the generic reader names OpenRouter's top_provider shape as its own format", () => {
  const read = GENERIC_MODEL_LIST_READER.read({ data: [{ id: "a", context_length: 1 }, { id: "b", context_length: 2, top_provider: { max_completion_tokens: 3 } }] }, "openai-compatible");
  assert.equal(read?.models.get("a")?.format, "generic");
  assert.equal(read?.models.get("b")?.format, "openrouter");
});

test("the catalog URL is the list URL's path with ?client_version=pi", () => {
  assert.equal(gatewayClientVersionCatalogUrl("https://gw.example/v1/", "openai-compatible"), "https://gw.example/v1/models?client_version=pi");
  assert.equal(gatewayClientVersionCatalogUrl("https://gw.example", "anthropic-compatible"), "https://gw.example/v1/models?client_version=pi");
});

function cpaServer(catalog: (res: http.ServerResponse) => void): Handler {
  return (req, res) => {
    if (req.url === "/v1/models?client_version=pi") catalog(res);
    else if (req.url === "/v1/models") json(res, CPA_PLAIN_LIST);
    else json(res, {}, 404);
  };
}

test("a plain list without limits is followed by one client_version=pi read with the same key, and its limits are used", async () => {
  await withServer(cpaServer((res) => json(res, CPA_CATALOG)), async (baseUrl, requests) => {
    const read = (modelId: string) => readGatewayModelLimits({ kind: "openai-compatible", baseUrl, apiKey: "sk-cpa", modelId, fetch: realFetch, clientVersionCatalog: true });
    assert.deepEqual(await read("glm-5.2"), { limits: { contextWindow: 202752, maxTokens: 131072 }, outcome: "ok", cached: false, format: "cliproxyapi_pi", fallbackRead: true });
    assert.deepEqual(requests.map((req) => req.url), ["/v1/models", "/v1/models?client_version=pi"]);
    assert.equal(requests[1]?.headers.authorization, "Bearer sk-cpa");
    assert.deepEqual(await read("gpt-6.1-sol"), { limits: { contextWindow: 500000 }, outcome: "ok", cached: true, format: "cliproxyapi_pi", fallbackRead: true });
    assert.equal(requests.length, 2, "both URL variants are cached");
    assert.deepEqual(await read("limitless"), { limits: null, outcome: "not_listed", cached: true, fallbackRead: true }, "no valid limit in the catalog: the plain list's outcome stands");
    assert.equal((await read("absent")).outcome, "not_listed");
  });
});

test("a failing client_version read keeps the plain list's outcome, and is cached like any read", async () => {
  for (const catalog of [
    (res: http.ServerResponse) => json(res, { error: "unknown" }, 400),
    (res: http.ServerResponse) => { res.writeHead(302, { location: "http://127.0.0.1:1/" }); res.end(); },
    (res: http.ServerResponse) => { res.writeHead(200); res.end("<html>"); },
    (res: http.ServerResponse) => json(res, { object: "list", data: [] }),
  ]) {
    resetGatewayModelLimitsCacheForTests();
    await withServer(cpaServer(catalog), async (baseUrl, requests) => {
      const read = () => readGatewayModelLimits({ kind: "openai-compatible", baseUrl, apiKey: "k", modelId: "glm-5.2", fetch: realFetch, clientVersionCatalog: true });
      assert.deepEqual(await read(), { limits: null, outcome: "no_limits", cached: false, fallbackRead: true });
      assert.deepEqual(await read(), { limits: null, outcome: "no_limits", cached: true, fallbackRead: true });
      assert.equal(requests.length, 2);
    });
  }
});

test("no client_version read when the plain list has the limits, when the plain read failed, or when not asked for", async () => {
  await withServer((_req, res) => json(res, { data: [{ id: "m", context_length: 1000 }] }), async (baseUrl, requests) => {
    const result = await readGatewayModelLimits({ kind: "openai-compatible", baseUrl, apiKey: "k", modelId: "m", fetch: realFetch, clientVersionCatalog: true });
    assert.deepEqual(result, { limits: { contextWindow: 1000 }, outcome: "ok", cached: false, format: "generic", fallbackRead: false });
    assert.deepEqual(requests.map((req) => req.url), ["/v1/models"]);
  });
  resetGatewayModelLimitsCacheForTests();
  await withServer((_req, res) => json(res, {}, 401), async (baseUrl, requests) => {
    const result = await readGatewayModelLimits({ kind: "openai-compatible", baseUrl, apiKey: "k", modelId: "m", fetch: realFetch, clientVersionCatalog: true });
    assert.equal(result.outcome, "failed:http_status");
    assert.equal(result.fallbackRead, false);
    assert.equal(requests.length, 1);
  });
  resetGatewayModelLimitsCacheForTests();
  await withServer(cpaServer((res) => json(res, CPA_CATALOG)), async (baseUrl, requests) => {
    const result = await readGatewayModelLimits({ kind: "openai-compatible", baseUrl, apiKey: "k", modelId: "glm-5.2", fetch: realFetch });
    assert.equal(result.outcome, "no_limits");
    assert.deepEqual(requests.map((req) => req.url), ["/v1/models"], "a reader that did not opt in (OpenRouter) reads the plain list only");
  });
});

test("an Anthropic-compatible gateway reads the catalog at <Base URL>/v1/models?client_version=pi with its Anthropic headers", async () => {
  await withServer((req, res) => {
    if (req.url === "/v1/models?client_version=pi") json(res, CPA_CATALOG);
    else json(res, { data: [{ id: "glm-5.2", type: "model" }] });
  }, async (baseUrl, requests) => {
    const result = await readGatewayModelLimits({ kind: "anthropic-compatible", baseUrl: baseUrl.replace(/\/v1$/, ""), apiKey: "ak", modelId: "glm-5.2", fetch: realFetch, clientVersionCatalog: true });
    assert.equal(result.format, "cliproxyapi_pi");
    assert.deepEqual(requests.map((req) => req.url), ["/v1/models?limit=1000", "/v1/models?client_version=pi"]);
    assert.equal(requests[1]?.headers["x-api-key"], "ak");
  });
});
