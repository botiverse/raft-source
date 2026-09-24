import assert from "node:assert/strict";
import test from "node:test";
import { parseTraceparent } from "@botiverse/raft-shared";
import axios, { AxiosError, CanceledError } from "axios";
import type { InternalAxiosRequestConfig } from "axios";
import api from "../src/api/client";
import {
  attachWebHttpClientTrace,
  finishWebHttpClientTrace,
  forwardHttpDiagnosticAttrs,
  startWebHttpClientSpan,
} from "../src/utils/webHttpClientTrace";
import {
  __resetAuthTraceForTest,
  buildWebTraceRecord,
  flushAuthTraces,
  setAuthTraceFetchForTest,
  setAuthTracePrincipalIdGetter,
  setAuthTraceServerIdGetter,
} from "../src/utils/webAuthTrace";

function setTraceTestIdentity(): void {
  setAuthTraceServerIdGetter(() => "server-abc");
  setAuthTracePrincipalIdGetter(() => "user-a");
}

type StubStore = Record<string, string>;

function stubLocalStorage(initial: StubStore): { restore: () => void } {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const store: StubStore = { ...initial };
  const stub: Storage = {
    get length() {
      return Object.keys(store).length;
    },
    clear: () => {
      for (const key of Object.keys(store)) delete store[key];
    },
    getItem: (key: string) => store[key] ?? null,
    key: (index: number) => Object.keys(store)[index] ?? null,
    removeItem: (key: string) => {
      delete store[key];
    },
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: stub });
  return {
    restore: () => {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      else Reflect.deleteProperty(globalThis, "localStorage");
    },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function axiosError(config: InternalAxiosRequestConfig, status?: number): AxiosError {
  return new AxiosError(
    status === undefined ? "network failed" : `HTTP ${status}`,
    status === undefined ? "ERR_NETWORK" : "ERR_BAD_RESPONSE",
    config,
    undefined,
    status === undefined
      ? undefined
      : {
          data: {},
          status,
          statusText: String(status),
          headers: {},
          config,
        },
  );
}

function webHttpRecords(requests: Array<{ body: unknown }>): Array<Record<string, any>> {
  return requests.flatMap(({ body }) => {
    const records = (body as { records?: Array<Record<string, any>> } | null)?.records ?? [];
    return records.filter((record) => record.name === "web.http.client");
  });
}

test("web HTTP client span propagates its own context and uploads the completed span", async () => {
  __resetAuthTraceForTest({ traceUrl: "https://trace.example.test" });
  setTraceTestIdentity();
  const storage = stubLocalStorage({ slock_access_token: "token" });
  const requests: Array<{ url: string; body: unknown }> = [];

  try {
    setAuthTraceFetchForTest(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      return url.endsWith("/scope-attestation")
        ? jsonResponse({ attestation: "att" })
        : jsonResponse({ ok: true });
    });

    const span = startWebHttpClientSpan("post");
    const context = parseTraceparent(span.traceparent);
    assert.ok(context, "outbound traceparent must be a valid W3C context");
    span.end({ statusCode: 503 });
    span.end({ statusCode: 200 }); // duplicate completion must be ignored
    await flushAuthTraces();

    assert.equal(requests.length, 2);
    const body = requests[1]!.body as { records: Array<Record<string, any>> };
    assert.equal(body.records.length, 1);
    const [record] = body.records;
    assert.equal(record.name, "web.http.client");
    assert.equal(record.trace_id, context.traceId);
    assert.equal(record.span_id, context.spanId);
    assert.equal(record.kind, "client");
    assert.equal(record.status, "error");
    assert.equal(record.attrs.method, "POST");
    assert.equal(record.attrs.outcome, "error");
    assert.equal(record.attrs.status_bucket, "5xx");
    assert.equal(record.attrs.status_code, 503);
    assert.equal("url" in record.attrs, false);
    assert.equal("path" in record.attrs, false);
  } finally {
    storage.restore();
    setAuthTraceFetchForTest(null);
    setAuthTraceServerIdGetter(() => undefined);
    __resetAuthTraceForTest();
  }
});

test("Forward HTTP diagnostics are bounded, route-specific, and keep unknown responses distinguishable", () => {
  assert.deepEqual(forwardHttpDiagnosticAttrs({
    requestUrl: "/messages/forward",
    statusCode: 409,
    responseData: { code: "authority_changed", requestId: "must-not-escape" },
  }), {
    route_family: "message_forward",
    response_state: "received",
    stable_code: "authority_changed",
    forward_outcome: "error",
    forward_status_bucket: "4xx",
  });
  assert.deepEqual(forwardHttpDiagnosticAttrs({
    requestUrl: "/messages/forward",
    responseData: { code: "attacker-controlled-code" },
  }), {
    route_family: "message_forward",
    response_state: "not_received_unknown",
    stable_code: "network_error",
    forward_outcome: "unknown",
    forward_status_bucket: "network_error",
  });
  assert.deepEqual(forwardHttpDiagnosticAttrs({
    requestUrl: "/messages/forward/enabled",
    statusCode: 200,
  }), {});
  assert.deepEqual(forwardHttpDiagnosticAttrs({
    requestUrl: "/messages/forward",
    statusCode: 200,
    responseHeaders: { "x-raft-forward-outcome": "idempotent_replay" },
  }), {
    route_family: "message_forward",
    response_state: "received",
    stable_code: "idempotent_replay",
    forward_outcome: "idempotent_replay",
    forward_status_bucket: "2xx",
  });
});

test("Forward client span shares the propagated W3C trace and contains no raw route or identifiers", async () => {
  __resetAuthTraceForTest({ traceUrl: "https://trace.example.test" });
  setTraceTestIdentity();
  const storage = stubLocalStorage({ slock_access_token: "token" });
  const requests: Array<{ body: unknown }> = [];
  let injectedTraceparent: string | undefined;

  try {
    setAuthTraceFetchForTest(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requests.push({ body: init?.body ? JSON.parse(String(init.body)) : null });
      return url.endsWith("/scope-attestation")
        ? jsonResponse({ attestation: "att" })
        : jsonResponse({ ok: true });
    });
    await api.post("/messages/forward", { requestId: "raw-request-id" }, {
      adapter: async (config) => {
        injectedTraceparent = String(config.headers.traceparent);
        throw new AxiosError("conflict", "ERR_BAD_RESPONSE", config, undefined, {
          data: { code: "idempotency_conflict", requestId: "raw-request-id" },
          status: 409,
          statusText: "Conflict",
          headers: {},
          config,
        });
      },
    }).catch(() => undefined);
    await api.post("/messages/forward", { requestId: "raw-network-request-id" }, {
      adapter: async (config) => {
        throw new AxiosError("connection closed", "ERR_NETWORK", config);
      },
    }).catch(() => undefined);
    await flushAuthTraces();

    const [record, networkRecord] = webHttpRecords(requests);
    const context = parseTraceparent(injectedTraceparent);
    assert.ok(context);
    assert.equal(record.trace_id, context.traceId);
    assert.equal(record.attrs.route_family, "message_forward");
    assert.equal(record.attrs.stable_code, "idempotency_conflict");
    assert.equal(record.attrs.response_state, "received");
    assert.equal("route" in record.attrs, false);
    assert.equal("request_id" in record.attrs, false);
    assert.equal(JSON.stringify(record).includes("raw-request-id"), false);
    assert.equal(networkRecord.attrs.route_family, "message_forward");
    assert.equal(networkRecord.attrs.stable_code, "network_error");
    assert.equal(networkRecord.attrs.response_state, "not_received_unknown");
    assert.equal(networkRecord.attrs.forward_outcome, "unknown");
    assert.equal(JSON.stringify(networkRecord).includes("raw-network-request-id"), false);
  } finally {
    storage.restore();
    setAuthTraceFetchForTest(null);
    setAuthTraceServerIdGetter(() => undefined);
    __resetAuthTraceForTest();
  }
});

test("web HTTP client span classifies cancellation without raw request detail", async () => {
  __resetAuthTraceForTest({ traceUrl: "https://trace.example.test" });
  setTraceTestIdentity();
  const storage = stubLocalStorage({ slock_access_token: "token" });
  const requests: Array<{ body: unknown }> = [];

  try {
    setAuthTraceFetchForTest(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requests.push({ body: init?.body ? JSON.parse(String(init.body)) : null });
      return url.endsWith("/scope-attestation")
        ? jsonResponse({ attestation: "att" })
        : jsonResponse({ ok: true });
    });

    const span = startWebHttpClientSpan("get");
    span.end({ cancelled: true });
    await flushAuthTraces();

    const body = requests[1]!.body as { records: Array<Record<string, any>> };
    const [record] = body.records;
    assert.equal(record.status, "cancelled");
    assert.equal(record.attrs.outcome, "cancelled");
    assert.equal(record.attrs.status_bucket, "network_error");
    assert.equal("status_code" in record.attrs, false);
  } finally {
    storage.restore();
    setAuthTraceFetchForTest(null);
    setAuthTraceServerIdGetter(() => undefined);
    __resetAuthTraceForTest();
  }
});

test("web HTTP client span pins every status boundary and default method", async () => {
  __resetAuthTraceForTest({ traceUrl: "https://trace.example.test" });
  setTraceTestIdentity();
  const storage = stubLocalStorage({ slock_access_token: "token" });
  const requests: Array<{ body: unknown }> = [];
  const cases: Array<[number | undefined, string, string]> = [
    [undefined, "network_error", "error"],
    [199, "other", "ok"],
    [200, "2xx", "ok"],
    [299, "2xx", "ok"],
    [300, "3xx", "ok"],
    [399, "3xx", "ok"],
    [400, "4xx", "error"],
    [499, "4xx", "error"],
    [500, "5xx", "error"],
    [599, "5xx", "error"],
    [600, "other", "error"],
  ];

  try {
    setAuthTraceFetchForTest(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requests.push({ body: init?.body ? JSON.parse(String(init.body)) : null });
      return url.endsWith("/scope-attestation")
        ? jsonResponse({ attestation: "att" })
        : jsonResponse({ ok: true });
    });

    for (const [statusCode] of cases) {
      startWebHttpClientSpan(undefined).end({ statusCode });
    }
    await flushAuthTraces();

    const records = webHttpRecords(requests);
    assert.equal(records.length, cases.length);
    for (const [index, [statusCode, bucket, status]] of cases.entries()) {
      const record = records[index]!;
      assert.equal(record.name, "web.http.client");
      assert.equal(record.surface, "web");
      assert.equal(record.kind, "client");
      assert.equal(record.status, status);
      assert.equal(record.attrs.method, "GET");
      assert.equal(record.attrs.status_bucket, bucket);
      assert.equal(record.attrs.outcome, status === "ok" ? "success" : "error");
      if (statusCode === undefined) assert.equal("status_code" in record.attrs, false);
      else assert.equal(record.attrs.status_code, statusCode);
    }
  } finally {
    storage.restore();
    setAuthTraceFetchForTest(null);
    setAuthTraceServerIdGetter(() => undefined);
    __resetAuthTraceForTest();
  }
});

test("web trace record preserves an explicit parent, kind, status, and timestamps", () => {
  const record = buildWebTraceRecord("web.http.client", { method: "GET" }, {
    traceId: "1".repeat(32),
    spanId: "2".repeat(16),
    parentSpanId: "3".repeat(16),
    kind: "client",
    status: "ok",
    startTime: "2026-07-11T00:00:00.000Z",
    endTime: "2026-07-11T00:00:01.000Z",
  });

  assert.equal(record.parent_span_id, "3".repeat(16));
  assert.equal(record.kind, "client");
  assert.equal(record.status, "ok");
  assert.equal(record.start_time, "2026-07-11T00:00:00.000Z");
  assert.equal(record.end_time, "2026-07-11T00:00:01.000Z");

  const defaults = buildWebTraceRecord("web.http.client");
  assert.equal("parent_span_id" in defaults, false);
  assert.equal(defaults.kind, "internal");
  assert.equal(defaults.status, "unset");
  assert.equal(defaults.surface, "web");
  assert.match(defaults.start_time, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(defaults.end_time, defaults.start_time);
});

test("attached HTTP trace is one live span per attempt and detaches after completion", async () => {
  __resetAuthTraceForTest({ traceUrl: "https://trace.example.test" });
  setTraceTestIdentity();
  const storage = stubLocalStorage({ slock_access_token: "token" });
  const requests: Array<{ body: unknown }> = [];

  try {
    setAuthTraceFetchForTest(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requests.push({ body: init?.body ? JSON.parse(String(init.body)) : null });
      return url.endsWith("/scope-attestation")
        ? jsonResponse({ attestation: "att" })
        : jsonResponse({ ok: true });
    });

    const config = { method: "post", headers: {} as Record<string, unknown> };
    attachWebHttpClientTrace(config);
    const firstTraceparent = config.headers.traceparent;
    attachWebHttpClientTrace(config);
    assert.equal(config.headers.traceparent, firstTraceparent, "duplicate attach must keep the live attempt span");

    finishWebHttpClientTrace(config, { statusCode: 503 });
    finishWebHttpClientTrace(config, { statusCode: 200 });

    attachWebHttpClientTrace(config);
    const secondTraceparent = config.headers.traceparent;
    assert.notEqual(secondTraceparent, firstTraceparent, "a completed config reused for retry must get a new attempt span");
    finishWebHttpClientTrace(config, { statusCode: 200 });
    await flushAuthTraces();

    const records = webHttpRecords(requests);
    assert.equal(records.length, 2, "each attempt must complete exactly once");
    assert.deepEqual(records.map((record) => record.attrs.status_code), [503, 200]);
  } finally {
    storage.restore();
    setAuthTraceFetchForTest(null);
    setAuthTraceServerIdGetter(() => undefined);
    __resetAuthTraceForTest();
  }
});

test("shared web API client injects the real client-span traceparent and closes it on response", async () => {
  __resetAuthTraceForTest({ traceUrl: "https://trace.example.test" });
  setTraceTestIdentity();
  const storage = stubLocalStorage({ slock_access_token: "token" });
  const requests: Array<{ body: unknown }> = [];
  let injectedTraceparent: string | undefined;

  try {
    setAuthTraceFetchForTest(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requests.push({ body: init?.body ? JSON.parse(String(init.body)) : null });
      return url.endsWith("/scope-attestation")
        ? jsonResponse({ attestation: "att" })
        : jsonResponse({ ok: true });
    });

    await api.get("/agents", {
      adapter: async (config) => {
        injectedTraceparent = config.headers.traceparent as string | undefined;
        return {
          data: {},
          status: 200,
          statusText: "OK",
          headers: {},
          config,
        };
      },
    });
    await flushAuthTraces();

    const context = parseTraceparent(injectedTraceparent);
    assert.ok(context, "axios request must carry the real client span context");
    const body = requests[1]!.body as { records: Array<Record<string, any>> };
    const [record] = body.records;
    assert.equal(record.trace_id, context.traceId);
    assert.equal(record.span_id, context.spanId);
    assert.equal(record.status, "ok");
    assert.equal(record.attrs.status_bucket, "2xx");
    assert.equal(record.attrs.status_code, 200);
  } finally {
    storage.restore();
    setAuthTraceFetchForTest(null);
    setAuthTraceServerIdGetter(() => undefined);
    __resetAuthTraceForTest();
  }
});

test("shared web API client closes a network-error attempt and preserves the original rejection", async () => {
  __resetAuthTraceForTest({ traceUrl: "https://trace.example.test" });
  setTraceTestIdentity();
  const storage = stubLocalStorage({ slock_access_token: "token" });
  const requests: Array<{ body: unknown }> = [];
  let thrown: AxiosError | undefined;

  try {
    setAuthTraceFetchForTest(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requests.push({ body: init?.body ? JSON.parse(String(init.body)) : null });
      return url.endsWith("/scope-attestation")
        ? jsonResponse({ attestation: "att" })
        : jsonResponse({ ok: true });
    });

    await assert.rejects(
      api.get("/agents", {
        adapter: async (config) => {
          thrown = axiosError(config);
          throw thrown;
        },
      }),
      (error) => error === thrown,
    );
    await flushAuthTraces();

    const [record] = webHttpRecords(requests);
    assert.equal(record.status, "error");
    assert.equal(record.attrs.outcome, "error");
    assert.equal(record.attrs.status_bucket, "network_error");
    assert.equal("status_code" in record.attrs, false);
  } finally {
    storage.restore();
    setAuthTraceFetchForTest(null);
    setAuthTraceServerIdGetter(() => undefined);
    __resetAuthTraceForTest();
  }
});

test("shared web API client closes a cancelled attempt without converting the cancellation", async () => {
  __resetAuthTraceForTest({ traceUrl: "https://trace.example.test" });
  setTraceTestIdentity();
  const storage = stubLocalStorage({ slock_access_token: "token" });
  const requests: Array<{ body: unknown }> = [];
  let thrown: CanceledError | undefined;

  try {
    setAuthTraceFetchForTest(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requests.push({ body: init?.body ? JSON.parse(String(init.body)) : null });
      return url.endsWith("/scope-attestation")
        ? jsonResponse({ attestation: "att" })
        : jsonResponse({ ok: true });
    });

    await assert.rejects(
      api.get("/agents", {
        adapter: async (config) => {
          thrown = new CanceledError("cancelled", config);
          throw thrown;
        },
      }),
      (error) => error === thrown && axios.isCancel(error),
    );
    await flushAuthTraces();

    const [record] = webHttpRecords(requests);
    assert.equal(record.status, "cancelled");
    assert.equal(record.attrs.outcome, "cancelled");
    assert.equal(record.attrs.status_bucket, "network_error");
  } finally {
    storage.restore();
    setAuthTraceFetchForTest(null);
    setAuthTraceServerIdGetter(() => undefined);
    __resetAuthTraceForTest();
  }
});

test("401 refresh retry creates two distinct attempt spans and completes each once", async () => {
  __resetAuthTraceForTest({ traceUrl: "https://trace.example.test" });
  setTraceTestIdentity();
  const storage = stubLocalStorage({
    slock_access_token: "old-access",
    slock_refresh_token: "old-refresh",
  });
  const requests: Array<{ body: unknown }> = [];
  const traceparents: string[] = [];
  const originalAdapter = axios.defaults.adapter;
  let attempts = 0;
  let refreshCalls = 0;

  try {
    setAuthTraceFetchForTest(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requests.push({ body: init?.body ? JSON.parse(String(init.body)) : null });
      return url.endsWith("/scope-attestation")
        ? jsonResponse({ attestation: "att" })
        : jsonResponse({ ok: true });
    });
    axios.defaults.adapter = async (config) => {
      refreshCalls += 1;
      assert.equal(config.url, "/api/auth/refresh");
      return {
        data: { accessToken: "new-access", refreshToken: "new-refresh" },
        status: 200,
        statusText: "OK",
        headers: {},
        config,
      };
    };

    const response = await api.get("/agents", {
      adapter: async (config) => {
        attempts += 1;
        traceparents.push(String(config.headers.traceparent));
        if (attempts === 1) throw axiosError(config, 401);
        assert.equal(config.headers.Authorization, "Bearer new-access");
        return {
          data: { ok: true },
          status: 200,
          statusText: "OK",
          headers: {},
          config,
        };
      },
    });
    await flushAuthTraces();

    assert.deepEqual(response.data, { ok: true });
    assert.equal(attempts, 2);
    assert.equal(refreshCalls, 1);
    assert.equal(traceparents.length, 2);
    assert.notEqual(traceparents[0], traceparents[1]);
    assert.ok(parseTraceparent(traceparents[0]));
    assert.ok(parseTraceparent(traceparents[1]));
    const records = webHttpRecords(requests);
    assert.equal(records.length, 2, "401 and retry must each end exactly one client span");
    assert.deepEqual(records.map((record) => record.attrs.status_code), [401, 200]);
    assert.deepEqual(records.map((record) => record.status), ["error", "ok"]);
    assert.deepEqual(records.map((record) => record.attrs.outcome), ["error", "success"]);
    assert.deepEqual(records.map((record) => record.attrs.status_bucket), ["4xx", "2xx"]);
    assert.deepEqual(records.map((record) => record.trace_id), traceparents.map((value) => parseTraceparent(value)!.traceId));
  } finally {
    axios.defaults.adapter = originalAdapter;
    storage.restore();
    setAuthTraceFetchForTest(null);
    setAuthTraceServerIdGetter(() => undefined);
    __resetAuthTraceForTest();
  }
});

test("shared web API client preserves errors that have no Axios request config", async () => {
  const storage = stubLocalStorage({ slock_access_token: "token" });
  const original = Object.assign(new Error("adapter exploded before config was attached"), {
    config: null,
    response: { status: 401 },
  });

  try {
    await assert.rejects(
      api.get("/agents", {
        adapter: async () => {
          throw original;
        },
      }),
      (error) => error === original,
    );
  } finally {
    storage.restore();
  }
});

test("shared web API client still sends when tracing context generation fails", async () => {
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  const storage = stubLocalStorage({ slock_access_token: "token" });
  let adapterCalled = false;
  let injectedTraceparent: unknown;

  try {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
    const response = await api.get("/agents", {
      adapter: async (config) => {
        adapterCalled = true;
        injectedTraceparent = config.headers.traceparent;
        return {
          data: { ok: true },
          status: 200,
          statusText: "OK",
          headers: {},
          config,
        };
      },
    });

    assert.equal(adapterCalled, true);
    assert.deepEqual(response.data, { ok: true });
    assert.equal(injectedTraceparent, undefined);
  } finally {
    storage.restore();
    if (originalCrypto) Object.defineProperty(globalThis, "crypto", originalCrypto);
    else Reflect.deleteProperty(globalThis, "crypto");
  }
});
