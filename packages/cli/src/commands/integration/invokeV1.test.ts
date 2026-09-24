import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { AgentContext } from "../../auth/env.js";
import type { RegisteredIntegrationService } from "./_format.js";
import {
  buildV1RequestPlan,
  effectiveContractDigest,
  resolveRegisteredActionBaseUrl,
} from "./actionV1.js";
import { IntegrationV1Error, invokeManifestActionV1 } from "./invokeV1.js";
import { validateAgentManifestV1, type AgentManifestV1 } from "./manifestV1.js";

const actorContext: AgentContext = {
  agentId: "agent-123",
  serverId: "server-456",
  serverUrl: "https://raft.test",
  token: "agent-secret",
  clientMode: "self-hosted-runner",
  secretSource: "profile-credential-file",
  activeCapabilities: null,
};

const service: RegisteredIntegrationService = {
  id: "integration-789",
  clientId: "survey",
  name: "Survey",
  description: null,
  homepageUrl: "https://survey.test",
  returnUrl: "https://survey.test/login/raft/callback",
  agentManifestUrl: "https://survey.test/.well-known/raft-agent-manifest.json",
  createdAt: "2026-07-23T00:00:00.000Z",
  updatedAt: "2026-07-23T00:00:00.000Z",
};

function manifest(readback: "action" | "not_supported" = "action"): AgentManifestV1 {
  return validateAgentManifestV1({
    schema: "raft-agent-manifest.v1",
    service: "survey",
    execution: {
      mode: "http_api",
      base_url: "https://survey.test/api",
    },
    auth: {
      type: "login_with_raft",
    },
    credential_boundary: {
      storage: "slock_managed_token",
    },
    actions: [
      {
        name: "create_survey",
        endpoint: { method: "POST", path: "/surveys" },
        request: { body: { from: "" } },
        authority: {
          principal: "agent_session",
          required_scopes: ["surveys:write"],
        },
        effect: "create",
        input_schema: {
          type: "object",
          required: ["title"],
          properties: {
            title: { type: "string", minLength: 1 },
          },
          additionalProperties: false,
        },
        output_schema: {
          type: "object",
          required: ["id", "status"],
          properties: {
            id: { type: "string", minLength: 1 },
            status: { const: "draft" },
          },
          additionalProperties: false,
        },
        idempotency: {
          mode: "key_required",
          transport: {
            location: "header",
            name: "Idempotency-Key",
          },
          scope: "actor_action",
        },
        readback: readback === "action"
          ? {
              mode: "action",
              action: "get_survey",
              input: {
                survey_id: { from: "response", pointer: "/id" },
              },
              assertions: [
                { pointer: "/status", operator: "equals", value: "draft" },
              ],
            }
          : { mode: "not_supported" },
        rollback: { mode: "irreversible" },
      },
      {
        name: "get_survey",
        endpoint: { method: "GET", path: "/surveys/{survey_id}" },
        request: {
          path: {
            survey_id: { from: "/survey_id" },
          },
        },
        authority: {
          principal: "agent_session",
          required_scopes: ["surveys:read"],
        },
        effect: "read",
        input_schema: {
          type: "object",
          required: ["survey_id"],
          properties: {
            survey_id: { type: "string", minLength: 1 },
          },
          additionalProperties: false,
        },
        output_schema: {
          type: "object",
          required: ["id", "status"],
          properties: {
            id: { type: "string" },
            status: { type: "string" },
          },
          additionalProperties: false,
        },
        idempotency: { mode: "safe" },
        readback: { mode: "not_applicable" },
        rollback: { mode: "not_applicable" },
      },
    ],
  });
}

function profile(): { env: NodeJS.ProcessEnv; context: AgentContext; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "raft-v1-invoke-"));
  return {
    root,
    env: { HOME: root },
    context: {
      ...actorContext,
      profileCredentialPath: path.join(root, "credential.json"),
    },
  };
}

function cookies() {
  return [{
    pair: "survey-session=session-secret",
    host: "survey.test",
    path: "/",
    secure: true,
  }];
}

test("v1 mutation receipt is verified only after an independent readback receipt", async () => {
  const state = profile();
  const contract = manifest();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const result = await invokeManifestActionV1({
    actorContext: state.context,
    env: state.env,
    service,
    manifest: contract,
    action: contract.actions[0]!,
    payload: { title: "Quarterly survey" },
    cookies: cookies(),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return new Response(JSON.stringify({ id: "survey-1", status: "draft" }), {
          status: 201,
          headers: {
            "content-type": "application/json",
            "x-request-id": "request-create",
          },
        });
      }
      return new Response(JSON.stringify({ id: "survey-1", status: "draft" }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-request-id": "request-read",
        },
      });
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.url, "https://survey.test/api/surveys");
  assert.equal(calls[1]?.url, "https://survey.test/api/surveys/survey-1");
  const createHeaders = calls[0]?.init?.headers as Record<string, string>;
  const readHeaders = calls[1]?.init?.headers as Record<string, string>;
  assert.ok(createHeaders["Idempotency-Key"]);
  assert.equal(readHeaders["Idempotency-Key"], undefined);
  assert.equal(result.receipt.operation.status, "verified");
  assert.equal(result.receipt.readback.status, "passed");
  assert.equal(result.receipt.authority.status, "authorized");
  assert.ok(result.readbackReceipt);
  assert.equal(result.readbackReceipt?.action.effect, "read");
  assert.equal(result.readbackReceipt?.operation.status, "verified");
  assert.notEqual(result.receipt.receipt_id, result.readbackReceipt?.receipt_id);
  assert.notEqual(result.receipt.invocation.id, result.readbackReceipt?.invocation.id);

  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("session-secret"));
  assert.ok(!serialized.includes(createHeaders["Idempotency-Key"]!));
  const invocationFiles = fs.readdirSync(path.join(state.root, "integration-invocations-v1"))
    .filter((name) => name.endsWith(".json"));
  assert.equal(invocationFiles.length, 2);
  for (const name of invocationFiles) {
    assert.equal(fs.statSync(path.join(state.root, "integration-invocations-v1", name)).mode & 0o777, 0o600);
  }
});

test("receipt target uses the durable canonical server binding", async () => {
  const state = profile();
  const contract = manifest("not_supported");
  const canonicalServerId = "server-456";
  const result = await invokeManifestActionV1({
    actorContext: {
      ...state.context,
      serverId: ` ${canonicalServerId} `,
    },
    env: state.env,
    service,
    manifest: contract,
    action: contract.actions[0]!,
    payload: { title: "Canonical target" },
    cookies: cookies(),
    fetchImpl: async () => new Response(
      JSON.stringify({ id: "survey-canonical", status: "draft" }),
      {
        status: 201,
        headers: { "content-type": "application/json" },
      },
    ),
  });

  const recordPath = path.join(
    state.root,
    "integration-invocations-v1",
    `${result.receipt.invocation.id}.json`,
  );
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8")) as {
    serverId: string;
    effectiveContractSha256: string;
  };
  const expectedContractSha256 = effectiveContractDigest({
    actorServerId: canonicalServerId,
    service,
    manifest: contract,
    action: contract.actions[0]!,
    registeredBaseUrl: resolveRegisteredActionBaseUrl({ service, manifest: contract }),
  });

  assert.equal(record.serverId, canonicalServerId);
  assert.equal(record.effectiveContractSha256, expectedContractSha256);
  assert.equal(result.receipt.target.server_id, canonicalServerId);
  assert.equal(
    result.receipt.target.effective_contract_sha256,
    expectedContractSha256,
  );
});

test("key_required timeout is indeterminate and retry reuses the invocation and key", async () => {
  const state = profile();
  const contract = manifest("not_supported");
  const keys: string[] = [];
  let firstError: IntegrationV1Error | null = null;
  try {
    await invokeManifestActionV1({
      actorContext: state.context,
      env: state.env,
      service,
      manifest: contract,
      action: contract.actions[0]!,
      payload: { title: "Retry me" },
      cookies: cookies(),
      fetchImpl: async (_url, init) => {
        keys.push((init?.headers as Record<string, string>)["Idempotency-Key"]!);
        throw new TypeError("network reset with secret body that must not escape");
      },
    });
  } catch (error) {
    assert.ok(error instanceof IntegrationV1Error);
    firstError = error;
  }
  assert.ok(firstError?.receipt);
  assert.equal(firstError?.receipt?.operation.status, "indeterminate");
  assert.equal(firstError?.receipt?.authority.status, "unknown");
  assert.equal(firstError?.receipt?.retryable, true);
  const invocationId = firstError!.receipt!.invocation.id;

  const retried = await invokeManifestActionV1({
    actorContext: state.context,
    env: state.env,
    service,
    manifest: contract,
    action: contract.actions[0]!,
    payload: { title: "Retry me" },
    cookies: cookies(),
    retryInvocationId: invocationId,
    fetchImpl: async (_url, init) => {
      keys.push((init?.headers as Record<string, string>)["Idempotency-Key"]!);
      return new Response(JSON.stringify({ id: "survey-2", status: "draft" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.deepEqual(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  assert.equal(retried.receipt.invocation.id, invocationId);
  assert.equal(retried.receipt.invocation.attempt, 2);
  assert.equal(retried.receipt.invocation.retry_of_receipt_id, firstError?.receipt?.receipt_id);
  assert.equal(retried.receipt.operation.status, "accepted_unverified");

  let dispatched = false;
  await assert.rejects(
    invokeManifestActionV1({
      actorContext: state.context,
      env: state.env,
      service,
      manifest: contract,
      action: contract.actions[0]!,
      payload: { title: "Changed payload" },
      cookies: cookies(),
      retryInvocationId: invocationId,
      fetchImpl: async () => {
        dispatched = true;
        return new Response(null, { status: 500 });
      },
    }),
    (error: unknown) =>
      error instanceof IntegrationV1Error
      && error.envelope.code === "INTEGRATION_RETRY_BINDING_MISMATCH",
  );
  assert.equal(dispatched, false);
});

test("5xx leaves authority unknown and output-schema failure prevents readback", async () => {
  const failedState = profile();
  const contract = manifest();
  let calls = 0;
  await assert.rejects(
    invokeManifestActionV1({
      actorContext: failedState.context,
      env: failedState.env,
      service,
      manifest: contract,
      action: contract.actions[0]!,
      payload: { title: "Server failure" },
      cookies: cookies(),
      fetchImpl: async () => {
        calls += 1;
        return new Response("untrusted service body secret", { status: 503 });
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof IntegrationV1Error);
      assert.equal(error.envelope.code, "INTEGRATION_SERVICE_REJECTED");
      assert.equal(error.envelope.evidence.authority, "unknown");
      assert.equal(error.receipt?.authority.status, "unknown");
      assert.ok(!JSON.stringify(error.machinePayload).includes("untrusted service body secret"));
      return true;
    },
  );
  assert.equal(calls, 1);

  const invalidState = profile();
  calls = 0;
  await assert.rejects(
    invokeManifestActionV1({
      actorContext: invalidState.context,
      env: invalidState.env,
      service,
      manifest: contract,
      action: contract.actions[0]!,
      payload: { title: "Bad output" },
      cookies: cookies(),
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({ id: "survey-3", status: "published" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      },
    }),
    (error: unknown) =>
      error instanceof IntegrationV1Error
      && error.envelope.code === "INTEGRATION_OUTPUT_INVALID"
      && error.receipt?.response_schema.status === "failed"
      && error.receipt.readback.status === "not_run",
  );
  assert.equal(calls, 1);
});

test("action response streaming stops at the byte limit before buffering the remainder", async () => {
  const state = profile();
  const contract = manifest("not_supported");
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(new Uint8Array(1024 * 1024));
          return;
        }
        if (pulls === 2) {
          controller.enqueue(new Uint8Array([1]));
          return;
        }
        throw new Error("the bounded reader consumed beyond the size violation");
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );

  await assert.rejects(
    invokeManifestActionV1({
      actorContext: state.context,
      env: state.env,
      service,
      manifest: contract,
      action: contract.actions[0]!,
      payload: { title: "Bounded response" },
      cookies: cookies(),
      fetchImpl: async () =>
        new Response(body, {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    }),
    (error: unknown) =>
      error instanceof IntegrationV1Error
      && error.envelope.code === "INTEGRATION_OUTPUT_INVALID"
      && error.receipt?.response_schema.status === "failed",
  );
  assert.equal(pulls, 2);
  assert.equal(cancelled, true);
});

test("input and request mapping fail before dispatch and dot segments cannot traverse", async () => {
  const state = profile();
  const contract = manifest();
  let dispatched = false;
  await assert.rejects(
    invokeManifestActionV1({
      actorContext: state.context,
      env: state.env,
      service,
      manifest: contract,
      action: contract.actions[0]!,
      payload: { title: "" },
      cookies: cookies(),
      fetchImpl: async () => {
        dispatched = true;
        return new Response(null, { status: 204 });
      },
    }),
    (error: unknown) =>
      error instanceof IntegrationV1Error
      && error.envelope.code === "INTEGRATION_INPUT_INVALID",
  );
  assert.equal(dispatched, false);
  assert.equal(fs.existsSync(path.join(state.root, "integration-invocations-v1")), false);

  const readAction = contract.actions[1]!;
  assert.throws(
    () => buildV1RequestPlan({
      service,
      manifest: contract,
      action: readAction,
      payload: { survey_id: ".." },
    }),
    /dot segment/,
  );
  const encoded = buildV1RequestPlan({
    service,
    manifest: contract,
    action: readAction,
    payload: { survey_id: "../nested?x=1" },
  });
  assert.equal(encoded.url.toString(), "https://survey.test/api/surveys/..%2Fnested%3Fx%3D1");

  const escaped = structuredClone(contract);
  escaped.actions[1]!.endpoint.path = "/../admin/{survey_id}";
  assert.throws(
    () => buildV1RequestPlan({
      service,
      manifest: escaped,
      action: escaped.actions[1]!,
      payload: { survey_id: "survey-1" },
    }),
    /escaped the registered action base/,
  );
});

test("a missing optional request pointer is a pre-dispatch input error", async () => {
  const state = profile();
  const base = structuredClone(manifest("not_supported"));
  const action = base.actions[0]!;
  action.request.query = {
    filter: { from: "/filter" },
  };
  const properties = action.input_schema.properties as Record<string, unknown>;
  properties.filter = { type: "string" };
  const contract = validateAgentManifestV1(base);
  let dispatched = false;
  await assert.rejects(
    invokeManifestActionV1({
      actorContext: state.context,
      env: state.env,
      service,
      manifest: contract,
      action: contract.actions[0]!,
      payload: { title: "No filter" },
      cookies: cookies(),
      fetchImpl: async () => {
        dispatched = true;
        return new Response(null, { status: 500 });
      },
    }),
    (error: unknown) =>
      error instanceof IntegrationV1Error
      && error.envelope.code === "INTEGRATION_INPUT_INVALID"
      && error.envelope.fault_domain === "input_schema"
      && error.envelope.evidence.transport === "not_attempted",
  );
  assert.equal(dispatched, false);
  assert.equal(fs.existsSync(path.join(state.root, "integration-invocations-v1")), false);
});

test("manifest v1 base URL cannot move action authority to another origin", () => {
  const contract = manifest();
  const moved = {
    ...contract,
    execution: {
      ...contract.execution,
      base_url: "https://attacker.test/api",
    },
  } as AgentManifestV1;
  assert.throws(
    () => buildV1RequestPlan({
      service,
      manifest: moved,
      action: moved.actions[0]!,
      payload: { title: "No redirect" },
    }),
    /not authorized by the registered service URLs/,
  );
});

test("bounded input depth and persistence failure both prevent dispatch", async () => {
  const deepState = profile();
  const contract = manifest("not_supported");
  let deep: Record<string, unknown> = { title: "bounded" };
  for (let index = 0; index < 30; index += 1) deep = { nested: deep };
  let dispatched = false;
  await assert.rejects(
    invokeManifestActionV1({
      actorContext: deepState.context,
      env: deepState.env,
      service,
      manifest: contract,
      action: contract.actions[0]!,
      payload: deep,
      cookies: cookies(),
      fetchImpl: async () => {
        dispatched = true;
        return new Response(null, { status: 204 });
      },
    }),
    (error: unknown) =>
      error instanceof IntegrationV1Error
      && error.envelope.code === "INTEGRATION_INPUT_INVALID",
  );
  assert.equal(dispatched, false);

  const blockedState = profile();
  const blockedParent = path.join(blockedState.root, "blocked");
  fs.writeFileSync(blockedParent, "not a directory", { mode: 0o600 });
  blockedState.context.profileCredentialPath = path.join(blockedParent, "credential.json");
  await assert.rejects(
    invokeManifestActionV1({
      actorContext: blockedState.context,
      env: blockedState.env,
      service,
      manifest: contract,
      action: contract.actions[0]!,
      payload: { title: "never dispatched" },
      cookies: cookies(),
      fetchImpl: async () => {
        dispatched = true;
        return new Response(null, { status: 204 });
      },
    }),
    (error: unknown) =>
      error instanceof IntegrationV1Error
      && error.envelope.code === "INTEGRATION_RETRY_PERSISTENCE_REQUIRED"
      && error.envelope.evidence.transport === "not_sent",
  );
  assert.equal(dispatched, false);
});

test("a dispatching invocation cannot be retried concurrently", async () => {
  const state = profile();
  const contract = manifest("not_supported");
  let release!: () => void;
  let started!: () => void;
  const releasePromise = new Promise<void>((resolve) => { release = resolve; });
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  const first = invokeManifestActionV1({
    actorContext: state.context,
    env: state.env,
    service,
    manifest: contract,
    action: contract.actions[0]!,
    payload: { title: "single dispatch" },
    cookies: cookies(),
    fetchImpl: async () => {
      started();
      await releasePromise;
      return new Response(JSON.stringify({ id: "survey-4", status: "draft" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    },
  });
  await startedPromise;

  const invocationDirectory = path.join(state.root, "integration-invocations-v1");
  const recordName = fs.readdirSync(invocationDirectory).find((name) => name.endsWith(".json"));
  assert.ok(recordName);
  const invocationId = recordName!.slice(0, -".json".length);
  let retryDispatched = false;
  await assert.rejects(
    invokeManifestActionV1({
      actorContext: state.context,
      env: state.env,
      service,
      manifest: contract,
      action: contract.actions[0]!,
      payload: { title: "single dispatch" },
      cookies: cookies(),
      retryInvocationId: invocationId,
      fetchImpl: async () => {
        retryDispatched = true;
        return new Response(null, { status: 500 });
      },
    }),
    (error: unknown) =>
      error instanceof IntegrationV1Error
      && error.envelope.code === "INTEGRATION_RETRY_PERSISTENCE_REQUIRED",
  );
  assert.equal(retryDispatched, false);
  release();
  const result = await first;
  assert.equal(result.receipt.invocation.attempt, 1);
});

test("tampered invocation identity or idempotency key digest cannot be retried", async () => {
  for (const field of ["invocationId", "keySha256"] as const) {
    const state = profile();
    const contract = manifest("not_supported");
    let firstError: IntegrationV1Error | null = null;
    try {
      await invokeManifestActionV1({
        actorContext: state.context,
        env: state.env,
        service,
        manifest: contract,
        action: contract.actions[0]!,
        payload: { title: `Tamper ${field}` },
        cookies: cookies(),
        fetchImpl: async () => {
          throw new TypeError("connection lost");
        },
      });
    } catch (error) {
      assert.ok(error instanceof IntegrationV1Error);
      firstError = error;
    }

    const invocationId = firstError!.receipt!.invocation.id;
    const recordPath = path.join(state.root, "integration-invocations-v1", `${invocationId}.json`);
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    record[field] = field === "invocationId"
      ? "11111111-1111-4111-8111-111111111111"
      : "0".repeat(64);
    fs.writeFileSync(recordPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    let dispatched = false;
    await assert.rejects(
      invokeManifestActionV1({
        actorContext: state.context,
        env: state.env,
        service,
        manifest: contract,
        action: contract.actions[0]!,
        payload: { title: `Tamper ${field}` },
        cookies: cookies(),
        retryInvocationId: invocationId,
        fetchImpl: async () => {
          dispatched = true;
          return new Response(null, { status: 500 });
        },
      }),
      (error: unknown) =>
        error instanceof IntegrationV1Error
        && error.envelope.code === "INTEGRATION_RETRY_BINDING_MISMATCH",
    );
    assert.equal(dispatched, false);
  }
});

test("post-dispatch invocation finalization failure remains typed and fail-closed", async () => {
  const state = profile();
  const contract = manifest("not_supported");
  await assert.rejects(
    invokeManifestActionV1({
      actorContext: state.context,
      env: state.env,
      service,
      manifest: contract,
      action: contract.actions[0]!,
      payload: { title: "finalize receipt" },
      cookies: cookies(),
      fetchImpl: async () => {
        const directory = path.join(state.root, "integration-invocations-v1");
        const recordName = fs.readdirSync(directory).find((name) => name.endsWith(".json"));
        assert.ok(recordName);
        fs.chmodSync(path.join(directory, recordName!), 0o644);
        return new Response(JSON.stringify({ id: "survey-5", status: "draft" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof IntegrationV1Error);
      assert.equal(error.envelope.fault_domain, "operation");
      assert.equal(error.envelope.evidence.transport, "response_received");
      assert.equal(error.receipt?.operation.status, "accepted_unverified");
      assert.ok(!JSON.stringify(error.machinePayload).includes("session-secret"));
      return true;
    },
  );
});

test("effective contract digest binds every canonical target and contract dimension", () => {
  const contract = manifest("not_supported");
  const action = contract.actions[0]!;
  const registeredBaseUrl = resolveRegisteredActionBaseUrl({ service, manifest: contract });
  const digest = (overrides: {
    actorServerId?: string;
    service?: RegisteredIntegrationService;
    manifest?: AgentManifestV1;
    action?: typeof action;
    registeredBaseUrl?: URL;
  } = {}) =>
    effectiveContractDigest({
      actorServerId: overrides.actorServerId ?? actorContext.serverId!,
      service: overrides.service ?? service,
      manifest: overrides.manifest ?? contract,
      action: overrides.action ?? action,
      registeredBaseUrl: overrides.registeredBaseUrl ?? registeredBaseUrl,
    });

  const changedManifest = {
    ...contract,
    credential_boundary: {
      storage: "per_agent_home" as const,
      forbid_user_home: true,
    },
  };
  const changedAction = { ...action, description: "Changed contract" };
  const variants = new Set([
    digest(),
    digest({ actorServerId: "server-other" }),
    digest({ service: { ...service, id: "integration-other" } }),
    digest({ service: { ...service, clientId: "survey-other" } }),
    digest({ manifest: changedManifest }),
    digest({ action: changedAction }),
    digest({ registeredBaseUrl: new URL("https://survey.test/api-v2") }),
  ]);
  assert.equal(variants.size, 7);
});

test("403 denial is tuple-relative and unsafe request ids are not emitted", async () => {
  const state = profile();
  const contract = manifest("not_supported");
  await assert.rejects(
    invokeManifestActionV1({
      actorContext: state.context,
      env: state.env,
      service,
      manifest: contract,
      action: contract.actions[0]!,
      payload: { title: "Denied" },
      cookies: cookies(),
      fetchImpl: async () =>
        new Response("untrusted denial body", {
          status: 403,
          headers: { "x-request-id": "Bearer secret-value" },
        }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof IntegrationV1Error);
      assert.equal(error.envelope.code, "INTEGRATION_AUTHORITY_DENIED");
      assert.equal(error.envelope.evidence.authority, "denied");
      assert.equal(error.receipt?.authority.status, "denied");
      assert.equal(error.receipt?.transport.request_id, null);
      assert.match(error.envelope.next_action, /actor\/action\/resource tuple/);
      assert.doesNotMatch(JSON.stringify(error.machinePayload), /untrusted denial body|secret-value/);
      return true;
    },
  );
});

test("429 retry guidance preserves the same invocation binding", async () => {
  const state = profile();
  const contract = manifest("not_supported");
  await assert.rejects(
    invokeManifestActionV1({
      actorContext: state.context,
      env: state.env,
      service,
      manifest: contract,
      action: contract.actions[0]!,
      payload: { title: "Rate limited" },
      cookies: cookies(),
      fetchImpl: async () =>
        new Response(null, {
          status: 429,
          headers: { "retry-after": "120" },
        }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof IntegrationV1Error);
      assert.equal(error.receipt?.retryable, true);
      assert.equal(error.receipt?.authority.status, "unknown");
      assert.match(
        error.receipt?.next_action ?? "",
        new RegExp(`invocation ${error.receipt?.invocation.id} after Retry-After 120`),
      );
      return true;
    },
  );
});

test("non-idempotent timeout is indeterminate and cannot be retried", async () => {
  const state = profile();
  const base = manifest("not_supported");
  const contract = {
    ...base,
    actions: [
      { ...base.actions[0]!, idempotency: { mode: "non_idempotent" as const } },
      ...base.actions.slice(1),
    ],
  };
  let firstError: IntegrationV1Error | null = null;
  try {
    await invokeManifestActionV1({
      actorContext: state.context,
      env: state.env,
      service,
      manifest: contract,
      action: contract.actions[0]!,
      payload: { title: "Send once" },
      cookies: cookies(),
      fetchImpl: async () => {
        throw new TypeError("connection lost");
      },
    });
  } catch (error) {
    assert.ok(error instanceof IntegrationV1Error);
    firstError = error;
  }
  assert.equal(firstError?.receipt?.operation.status, "indeterminate");
  assert.equal(firstError?.receipt?.retryable, false);

  let dispatched = false;
  await assert.rejects(
    invokeManifestActionV1({
      actorContext: state.context,
      env: state.env,
      service,
      manifest: contract,
      action: contract.actions[0]!,
      payload: { title: "Send once" },
      cookies: cookies(),
      retryInvocationId: firstError!.receipt!.invocation.id,
      fetchImpl: async () => {
        dispatched = true;
        return new Response(null, { status: 500 });
      },
    }),
    (error: unknown) =>
      error instanceof IntegrationV1Error
      && error.envelope.code === "INTEGRATION_RETRY_BINDING_MISMATCH",
  );
  assert.equal(dispatched, false);
});

test("failed readback never verifies a mutation", async () => {
  const state = profile();
  const contract = manifest();
  let calls = 0;
  await assert.rejects(
    invokeManifestActionV1({
      actorContext: state.context,
      env: state.env,
      service,
      manifest: contract,
      action: contract.actions[0]!,
      payload: { title: "Read back" },
      cookies: cookies(),
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify(
          calls === 1
            ? { id: "survey-6", status: "draft" }
            : { id: "survey-6", status: "published" },
        ), {
          status: calls === 1 ? 201 : 200,
          headers: { "content-type": "application/json" },
        });
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof IntegrationV1Error);
      assert.equal(error.envelope.code, "INTEGRATION_READBACK_FAILED");
      assert.equal(error.receipt?.readback.status, "failed");
      assert.notEqual(error.receipt?.operation.status, "verified");
      return true;
    },
  );
  assert.equal(calls, 2);
});

test("rollback is never implicit and an explicit rollback action receives a fresh receipt", async () => {
  const state = profile();
  const base = structuredClone(manifest("not_supported")) as unknown as Record<string, unknown>;
  const actions = base.actions as Array<Record<string, unknown>>;
  actions[0]!.rollback = {
    mode: "action",
    action: "delete_survey",
    input: {
      survey_id: { from: "response", pointer: "/id" },
    },
  };
  actions.push({
    name: "delete_survey",
    endpoint: { method: "DELETE", path: "/surveys/{survey_id}" },
    request: {
      path: {
        survey_id: { from: "/survey_id" },
      },
    },
    authority: {
      principal: "agent_session",
      required_scopes: ["surveys:write"],
    },
    effect: "delete",
    input_schema: {
      type: "object",
      required: ["survey_id"],
      properties: { survey_id: { type: "string" } },
      additionalProperties: false,
    },
    output_schema: { type: "null" },
    idempotency: { mode: "idempotent" },
    readback: { mode: "not_supported" },
    rollback: { mode: "irreversible" },
  });
  const contract = validateAgentManifestV1(base);
  const calls: string[] = [];
  const created = await invokeManifestActionV1({
    actorContext: state.context,
    env: state.env,
    service,
    manifest: contract,
    action: contract.actions[0]!,
    payload: { title: "Rollback explicitly" },
    cookies: cookies(),
    fetchImpl: async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ id: "survey-7", status: "draft" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.deepEqual(calls, ["https://survey.test/api/surveys"]);
  assert.equal(created.receipt.rollback.status, "not_run");

  const rolledBack = await invokeManifestActionV1({
    actorContext: state.context,
    env: state.env,
    service,
    manifest: contract,
    action: contract.actions[2]!,
    payload: { survey_id: "survey-7" },
    cookies: cookies(),
    fetchImpl: async (url) => {
      calls.push(String(url));
      return new Response(null, { status: 204 });
    },
  });
  assert.equal(calls[1], "https://survey.test/api/surveys/survey-7");
  assert.notEqual(rolledBack.receipt.receipt_id, created.receipt.receipt_id);
  assert.notEqual(rolledBack.receipt.invocation.id, created.receipt.invocation.id);
  assert.equal(rolledBack.receipt.action.name, "delete_survey");
  assert.equal(rolledBack.receipt.authority.status, "authorized");
});

test("missing canonical server context fails before dispatch", async () => {
  const state = profile();
  const contract = manifest("not_supported");
  let dispatched = false;
  await assert.rejects(
    invokeManifestActionV1({
      actorContext: { ...state.context, serverId: null },
      env: state.env,
      service,
      manifest: contract,
      action: contract.actions[0]!,
      payload: { title: "No target" },
      cookies: cookies(),
      fetchImpl: async () => {
        dispatched = true;
        return new Response(null, { status: 500 });
      },
    }),
    (error: unknown) =>
      error instanceof IntegrationV1Error
      && error.envelope.code === "INTEGRATION_TARGET_INVALID"
      && error.envelope.evidence.transport === "not_sent",
  );
  assert.equal(dispatched, false);
});
