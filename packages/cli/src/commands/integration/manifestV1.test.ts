import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_MANIFEST_SCHEMA_V1,
  RAFT_AGENT_MANIFEST_SCHEMA_V1,
  validateAgentManifestV1,
  V1_MANIFEST_LIMITS,
  V1_SCHEMA_LIMITS,
} from "./manifestV1.js";

function validManifest(): Record<string, unknown> {
  return {
    schema: RAFT_AGENT_MANIFEST_SCHEMA_V1,
    service: "survey",
    name: "Survey",
    docs_url: "https://survey.test/docs",
    app_origin: "https://survey.test",
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
            title: { type: "string", minLength: 1, maxLength: 200 },
            questions: {
              type: "array",
              maxItems: 50,
              items: {
                type: "object",
                required: ["prompt"],
                properties: {
                  prompt: { type: "string", minLength: 1 },
                },
                additionalProperties: false,
              },
            },
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
          additionalProperties: true,
        },
        idempotency: {
          mode: "key_required",
          transport: {
            location: "header",
            name: "Idempotency-Key",
          },
          scope: "actor_action",
        },
        readback: {
          mode: "action",
          action: "get_survey",
          input: {
            survey_id: { from: "response", pointer: "/id" },
          },
          assertions: [
            { pointer: "/status", operator: "equals", value: "draft" },
          ],
        },
        rollback: {
          mode: "action",
          action: "delete_survey",
          input: {
            survey_id: { from: "response", pointer: "/id" },
          },
        },
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
          additionalProperties: true,
        },
        idempotency: { mode: "safe" },
        readback: { mode: "not_applicable" },
        rollback: { mode: "not_applicable" },
      },
      {
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
          properties: {
            survey_id: { type: "string", minLength: 1 },
          },
          additionalProperties: false,
        },
        output_schema: { type: "null" },
        idempotency: { mode: "idempotent" },
        readback: { mode: "not_supported" },
        rollback: { mode: "irreversible" },
      },
    ],
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function actionAt(manifest: Record<string, unknown>, index: number): Record<string, unknown> {
  assert.ok(Array.isArray(manifest.actions));
  const action = manifest.actions[index];
  assert.ok(action && typeof action === "object" && !Array.isArray(action));
  return action as Record<string, unknown>;
}

function recordField(parent: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = parent[field];
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

test("validates and normalizes a closed manifest v1 action graph", () => {
  const manifest = validateAgentManifestV1(validManifest());
  assert.equal(manifest.schema, AGENT_MANIFEST_SCHEMA_V1);
  assert.equal(manifest.actions.length, 3);
  assert.equal(manifest.actions[0]?.idempotency.mode, "key_required");
  assert.equal(manifest.actions[1]?.readback.mode, "not_applicable");
});

test("rejects remote refs and schema work beyond the bounded depth", () => {
  const remote = clone(validManifest());
  actionAt(remote, 0).input_schema = { $ref: "https://evil.test/schema.json" };
  assert.throws(() => validateAgentManifestV1(remote), /local #\/\$defs/);

  let nested: Record<string, unknown> = { type: "string" };
  for (let index = 0; index <= V1_SCHEMA_LIMITS.maxDepth; index += 1) {
    nested = { not: nested };
  }
  const tooDeep = clone(validManifest());
  actionAt(tooDeep, 0).input_schema = {
    type: "object",
    properties: { value: nested },
  };
  assert.throws(() => validateAgentManifestV1(tooDeep), /maximum schema depth/);

  let literal: unknown = "bounded";
  for (let index = 0; index <= V1_SCHEMA_LIMITS.maxDepth; index += 1) {
    literal = [literal];
  }
  const deepLiteral = clone(validManifest());
  actionAt(deepLiteral, 0).output_schema = { enum: [literal] };
  assert.throws(() => validateAgentManifestV1(deepLiteral), /bounded JSON literal work limits/);
});

test("rejects request mapping gaps, GET bodies, and legacy action fields", () => {
  const unbound = clone(validManifest());
  recordField(actionAt(unbound, 1), "request").path = {};
  assert.throws(() => validateAgentManifestV1(unbound), /bind every endpoint placeholder exactly once/);

  const getBody = clone(validManifest());
  recordField(actionAt(getBody, 1), "request").body = { from: "" };
  assert.throws(() => validateAgentManifestV1(getBody), /forbidden for GET/);

  const legacy = clone(validManifest());
  actionAt(legacy, 0).parameters = {};
  assert.throws(() => validateAgentManifestV1(legacy), /parameters is not supported/);

  const unsafeBinding = clone(validManifest());
  recordField(actionAt(unsafeBinding, 0), "request").query =
    JSON.parse('{"__proto__":{"from":"/title"}}');
  assert.throws(() => validateAgentManifestV1(unsafeBinding), /unsafe binding name/);
});

test("rejects authority, effect, and idempotency widening", () => {
  const scopes = clone(validManifest());
  recordField(actionAt(scopes, 0), "authority").required_scopes = ["surveys:write", "surveys:read"];
  assert.throws(() => validateAgentManifestV1(scopes), /sorted and unique/);

  const effect = clone(validManifest());
  actionAt(effect, 1).effect = "update";
  assert.throws(() => validateAgentManifestV1(effect), /safe is forbidden|must be read for GET/);

  const idempotency = clone(validManifest());
  actionAt(idempotency, 0).idempotency = { mode: "safe" };
  assert.throws(() => validateAgentManifestV1(idempotency), /safe is forbidden/);

  const credentialHeader = clone(validManifest());
  recordField(recordField(actionAt(credentialHeader, 0), "idempotency"), "transport").name = "Authorization";
  assert.throws(() => validateAgentManifestV1(credentialHeader), /must not be a credential header/);
});

test("rejects invalid readback and rollback references", () => {
  const readback = clone(validManifest());
  recordField(actionAt(readback, 0), "readback").action = "delete_survey";
  assert.throws(() => validateAgentManifestV1(readback), /readback must reference another declared read action/);

  const rollback = clone(validManifest());
  recordField(actionAt(rollback, 0), "rollback").action = "get_survey";
  assert.throws(() => validateAgentManifestV1(rollback), /rollback must reference another declared mutation action/);

  const missingBinding = clone(validManifest());
  recordField(actionAt(missingBinding, 0), "readback").input = {};
  assert.throws(() => validateAgentManifestV1(missingBinding), /does not bind required target input/);
});

test("local CLI v1 remains discovery-only and cannot carry actions or a command", () => {
  const manifest = validManifest();
  manifest.execution = { mode: "local_cli" };
  manifest.actions = [];
  assert.equal(validateAgentManifestV1(manifest).execution.mode, "local_cli");

  const withAction = validManifest();
  withAction.execution = { mode: "local_cli" };
  assert.throws(() => validateAgentManifestV1(withAction), /local_cli actions must be empty/);

  const withCommand = clone(manifest);
  (withCommand.execution as Record<string, unknown>).command = "drive9";
  assert.throws(() => validateAgentManifestV1(withCommand), /execution.command is not supported/);
});

test("HTTP API base URL preserves a closed path and rejects query or fragment state", () => {
  const manifest = validateAgentManifestV1(validManifest());
  assert.equal(manifest.execution.base_url, "https://survey.test/api");

  const query = clone(validManifest());
  (query.execution as Record<string, unknown>).base_url = "https://survey.test/api?tenant=other";
  assert.throws(() => validateAgentManifestV1(query), /must not include a query or fragment/);

  const fragment = clone(validManifest());
  (fragment.execution as Record<string, unknown>).base_url = "https://survey.test/api#other";
  assert.throws(() => validateAgentManifestV1(fragment), /must not include a query or fragment/);

  const dotSegment = clone(validManifest());
  recordField(actionAt(dotSegment, 1), "endpoint").path = "/surveys/%2e%2e/admin/{survey_id}";
  assert.throws(() => validateAgentManifestV1(dotSegment), /must not contain dot segments/);

  const backslash = clone(validManifest());
  recordField(actionAt(backslash, 1), "endpoint").path = "/surveys\\admin/{survey_id}";
  assert.throws(() => validateAgentManifestV1(backslash), /must not contain control characters or backslashes/);
});

test("malformed optional fields and unsafe regex work fail closed", () => {
  const description = clone(validManifest());
  actionAt(description, 0).description = 42;
  assert.throws(() => validateAgentManifestV1(description), /description must be a non-empty string/);

  const boundary = clone(validManifest());
  boundary.credential_boundary = {
    storage: "slock_managed_token",
    forbid_user_home: "false",
  };
  assert.throws(() => validateAgentManifestV1(boundary), /forbid_user_home must be a boolean/);

  const pattern = clone(validManifest());
  actionAt(pattern, 0).input_schema = {
    type: "object",
    properties: {
      title: { type: "string", pattern: "(a+)+$" },
    },
  };
  assert.throws(() => validateAgentManifestV1(pattern), /unsafe backtracking/);
});

test("manifest action, scope, and binding collections are bounded", () => {
  const actions = clone(validManifest());
  actions.actions = Array.from(
    { length: V1_MANIFEST_LIMITS.maxActions + 1 },
    () => actionAt(validManifest(), 1),
  );
  assert.throws(() => validateAgentManifestV1(actions), /maximum action count/);

  const scopes = clone(validManifest());
  recordField(actionAt(scopes, 0), "authority").required_scopes = Array.from(
    { length: V1_MANIFEST_LIMITS.maxScopesPerAction + 1 },
    (_, index) => `scope-${String(index).padStart(3, "0")}`,
  );
  assert.throws(() => validateAgentManifestV1(scopes), /maximum scope count/);

  const bindings = clone(validManifest());
  recordField(actionAt(bindings, 0), "request").query = Object.fromEntries(
    Array.from(
      { length: V1_MANIFEST_LIMITS.maxBindingsPerMap + 1 },
      (_, index) => [`query_${index}`, { from: "/title" }],
    ),
  );
  assert.throws(() => validateAgentManifestV1(bindings), /maximum binding count/);
});
