import assert from "node:assert/strict";
import test from "node:test";

import { agentApiContract } from "./agentApiContract.js";
import { daemonApiContract } from "./daemonApiContract.js";
import { createDaemonApiFetchTransport } from "./daemonApiClient.js";
import {
  buildDaemonApiRawRoutePath,
  createDaemonApiRawClient,
  requestDaemonApiRawRoute,
  type DaemonApiRawTransport,
  type DaemonApiRawTransportRequest,
} from "./daemonApiRawClient.js";

test("daemon-api routes stay out of the server-registered agent-api contract", () => {
  const agentApiFullPaths = new Set(Object.values(agentApiContract).map((route) => route.fullPath));
  for (const route of Object.values(daemonApiContract)) {
    assert.equal(
      agentApiFullPaths.has(route.fullPath),
      false,
      `${route.key} must not be registered through agentApiContract`,
    );
  }
});

test("buildDaemonApiRawRoutePath builds daemon-bound id-less paths", () => {
  assert.equal(
    buildDaemonApiRawRoutePath("runtimeVersion"),
    "/internal/agent-api/runtime-version",
  );
  assert.equal(
    buildDaemonApiRawRoutePath("inboxCheck"),
    "/internal/agent-api/inbox",
  );
  assert.equal(
    buildDaemonApiRawRoutePath("wakeHintsFetch", { query: { since: 42, limit: 10 } }),
    "/internal/agent-api/wake-hints?since=42&limit=10",
  );
  assert.equal(
    buildDaemonApiRawRoutePath("activityForward"),
    "/internal/agent-api/activity",
  );
});

test("createDaemonApiRawClient validates requests and responses", async () => {
  const requests: DaemonApiRawTransportRequest[] = [];
  const transport: DaemonApiRawTransport = {
    async request(input) {
      requests.push(input);
      if (input.routeKey === "runtimeVersion") {
        return {
          ok: true,
          status: 200,
          data: {
            daemonVersion: "1.2.3",
            computerVersion: "4.5.6",
            observation: "live_daemon_process",
          },
          error: null,
        };
      }
      if (input.routeKey === "inboxCheck") {
        return { ok: true, status: 200, data: { rows: [] }, error: null };
      }
      if (input.routeKey === "wakeHintsFetch") {
        return {
          ok: true,
          status: 200,
          data: {
            wake_hints: [{ seq: 43, message_id: "msg-1", target: "#wg-raft-cli" }],
            last_hint_seq: 43,
            has_more: false,
          },
          error: null,
        };
      }
      return {
        ok: true,
        status: 200,
        data: { ok: true, acceptedCount: 1, rejectedCount: 0, droppedCount: 0 },
        error: null,
      };
    },
  };

  const client = createDaemonApiRawClient(transport);
  assert.deepEqual(await client.runtime.version(), {
    ok: true,
    routeKey: "runtimeVersion",
    status: 200,
    data: {
      daemonVersion: "1.2.3",
      computerVersion: "4.5.6",
      observation: "live_daemon_process",
    },
  });
  assert.deepEqual(await client.inbox.check(), {
    ok: true,
    routeKey: "inboxCheck",
    status: 200,
    data: { rows: [] },
  });
  assert.equal((await client.wakeHints.fetch({ since: "latest" })).ok, true);
  assert.equal((await client.activity.forward({
    schema: "raft-agent-activity-ingest.v1",
    events: [{ hookEventName: "Stop" }],
  })).ok, true);

  assert.deepEqual(
    requests.map((request) => [request.method, request.path, request.body]),
    [
      ["GET", "/internal/agent-api/runtime-version", undefined],
      ["GET", "/internal/agent-api/inbox", undefined],
      ["GET", "/internal/agent-api/wake-hints?since=latest", undefined],
      ["POST", "/internal/agent-api/activity", {
        schema: "raft-agent-activity-ingest.v1",
        events: [{ hookEventName: "Stop" }],
      }],
    ],
  );
});

test("createDaemonApiRawClient rejects invalid activity ingest bodies before transport", async () => {
  let called = false;
  const client = createDaemonApiRawClient({
    async request() {
      called = true;
      return { ok: true, status: 200, data: { ok: true }, error: null };
    },
  });

  const result = await client.activity.forward({
    schema: "raft-activity.v1",
    events: [],
  } as never);

  assert.equal(called, false);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "request_contract_mismatch");
  }
});

test("createDaemonApiRawClient localizes response contract mismatches without response payloads", async () => {
  const client = createDaemonApiRawClient({
    async request() {
      return {
        ok: true,
        status: 200,
        data: {
          daemonVersion: 42,
          computerVersion: "4.5.6",
          observation: "live_daemon_process",
          secret_value: "sk_daemon_should_not_escape",
        },
        error: null,
      };
    },
  });

  const result = await client.runtime.version();

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "response_contract_mismatch");
    assert.deepEqual(result.contractRejection, {
      cause: "wrong_type",
      path: "daemonVersion",
      expected_kind: "string",
      actual_kind: "integer",
    });
    assert.equal("response" in result, false);
    assert.doesNotMatch(JSON.stringify(result), /sk_daemon_should_not_escape|secret_value/);
  }
});

test("createDaemonApiRawClient emits missing-field and invalid-json-syntax diagnostics", async () => {
  const missingClient = createDaemonApiRawClient({
    async request() {
      return {
        ok: true,
        status: 200,
        data: {
          daemonVersion: "1.2.3",
          computerVersion: "4.5.6",
        },
        error: null,
      };
    },
  });
  const missing = await missingClient.runtime.version();
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.reason, "response_contract_mismatch");
    assert.deepEqual(missing.contractRejection, {
      cause: "missing_field",
      path: "observation",
      expected_kind: "literal",
      actual_kind: "undefined",
    });
  }

  const syntaxClient = createDaemonApiRawClient({
    async request() {
      return {
        ok: false,
        status: 200,
        data: null,
        error: "Invalid JSON response from server/proxy (HTTP 200)",
        errorCode: "INVALID_JSON_RESPONSE",
      };
    },
  });
  const syntax = await syntaxClient.runtime.version();
  assert.equal(syntax.ok, false);
  if (!syntax.ok) {
    assert.equal(syntax.reason, "response_contract_mismatch");
    assert.deepEqual(syntax.contractRejection, {
      cause: "invalid_json_syntax",
      path: "<unavailable>",
      expected_kind: "unavailable",
      actual_kind: "unavailable",
    });
  }
});

test("daemon-api transports converge malformed response bodies to syntax diagnostics", async () => {
  const fetchResult = await requestDaemonApiRawRoute(
    createDaemonApiFetchTransport({
      baseUrl: "https://daemon.example.test",
      fetch: (async () =>
        new Response("{not-json", {
          status: 200,
        })) as typeof fetch,
    }),
    "runtimeVersion",
  );
  const rawResult = await createDaemonApiRawClient({
    async request() {
      return {
        ok: true,
        status: 200,
        data: null,
        error: null,
      };
    },
  }).runtime.version();

  for (const result of [fetchResult, rawResult]) {
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "response_contract_mismatch");
      assert.deepEqual(result.contractRejection, {
        cause: "invalid_json_syntax",
        path: "<unavailable>",
        expected_kind: "unavailable",
        actual_kind: "unavailable",
      });
      assert.doesNotMatch(JSON.stringify(result), /not-json/);
    }
  }
});

test("createDaemonApiFetchTransport reports JSON content-type syntax failures as contract syntax diagnostics", async () => {
  const result = await requestDaemonApiRawRoute(
    createDaemonApiFetchTransport({
      baseUrl: "https://daemon.example.test",
      fetch: (async () =>
        new Response("{not-json", {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    }),
    "runtimeVersion",
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "response_contract_mismatch");
    assert.deepEqual(result.contractRejection, {
      cause: "invalid_json_syntax",
      path: "<unavailable>",
      expected_kind: "unavailable",
      actual_kind: "unavailable",
    });
    assert.doesNotMatch(JSON.stringify(result), /not-json/);
  }
});

test("createDaemonApiRawClient sanitizes unknown keys and version mismatches", async () => {
  let called = false;
  const client = createDaemonApiRawClient({
    async request() {
      called = true;
      return { ok: true, status: 200, data: { ok: true }, error: null };
    },
  });

  const unknown = await client.inbox.ack({
    itemId: "item-1",
    "sk_live_attacker_key": "sk_live_attacker_value",
  } as never);

  assert.equal(called, false);
  assert.equal(unknown.ok, false);
  if (!unknown.ok) {
    assert.equal(unknown.reason, "request_contract_mismatch");
    assert.deepEqual(unknown.contractRejection, {
      cause: "unknown_field",
      path: "<unknown-key>",
      expected_kind: "absent",
      actual_kind: "unknown_field",
    });
    assert.doesNotMatch(JSON.stringify(unknown), /sk_live_attacker_key|sk_live_attacker_value/);
  }

  const version = await client.activity.forward({
    schema: "raft-agent-activity-ingest.vNEXT",
    events: [],
  } as never);
  assert.equal(version.ok, false);
  if (!version.ok) {
    assert.equal(version.reason, "request_contract_mismatch");
    assert.deepEqual(version.contractRejection, {
      cause: "unsupported_contract_version",
      path: "schema",
      expected_kind: "literal",
      actual_kind: "string",
    });
  }
});
