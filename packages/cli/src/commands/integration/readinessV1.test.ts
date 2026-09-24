import assert from "node:assert/strict";
import test from "node:test";

import { validateAgentManifestV1, type AgentManifestV1 } from "./manifestV1.js";
import { buildIntegrationReadinessV1, formatIntegrationReadinessV1 } from "./readinessV1.js";
import type { ManifestObservation } from "./readiness.js";

function observation(
  status: ManifestObservation["status"],
  surface: ManifestObservation["surface"],
  nextAction = "Inspect the manifest observation.",
): ManifestObservation {
  return {
    service_id: "survey",
    status,
    surface,
    manifest_url: status === "not_configured" ? null : "https://survey.test/.well-known/raft-agent-manifest.json",
    http_status: undefined,
    content_type: undefined,
    schema_path: undefined,
    retry_after: undefined,
    detail: undefined,
    observed_at: "2026-07-23T00:00:00.000Z",
    source: status === "not_configured" ? "service_registry" : "live_manifest_probe",
    evidence_ceiling: status === "valid" ? "manifest_shape" : "registry_metadata",
    fault_domain: status === "valid" || status === "not_configured" ? null : "manifest_schema",
    retryable: status === "unavailable" || status === "unreachable",
    next_action: nextAction,
  };
}

function httpManifest(): AgentManifestV1 {
  return validateAgentManifestV1({
    schema: "raft-agent-manifest.v1",
    execution: {
      mode: "http_api",
      base_url: "https://survey.test/api",
    },
    auth: { type: "login_with_raft" },
    actions: [{
      name: "get_survey",
      endpoint: { method: "GET", path: "/surveys/{id}" },
      request: { path: { id: { from: "/id" } } },
      authority: {
        principal: "agent_session",
        required_scopes: ["surveys:read"],
      },
      effect: "read",
      input_schema: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
        additionalProperties: false,
      },
      output_schema: { type: "object" },
      idempotency: { mode: "safe" },
      readback: { mode: "not_applicable" },
      rollback: { mode: "not_applicable" },
    }],
  });
}

test("web-only not-configured is an intentional actor-relative steady state", () => {
  const readiness = buildIntegrationReadinessV1({
    actorId: "agent-123",
    observation: observation(
      "not_configured",
      "web_only_no_actions",
      "Ask the owner to repair the manifest.",
    ),
    manifest: null,
    actionName: "get_survey",
    sessionPresent: true,
  });

  assert.equal(readiness.overall, "web_only_not_configured");
  assert.equal(readiness.invoke.status, "blocked");
  assert.equal(readiness.authority.status, "unknown");
  assert.match(readiness.next_action, /Use the app on the Web/);
  assert.doesNotMatch(readiness.next_action, /repair|configure|retry/i);
  assert.doesNotMatch(
    formatIntegrationReadinessV1(readiness),
    /repair the manifest|configure a manifest|retry the manifest/i,
  );
});

test("valid action readiness never promotes session presence to authority", () => {
  const manifest = httpManifest();
  const withoutSession = buildIntegrationReadinessV1({
    actorId: "agent-123",
    observation: observation("valid", "manifest_actions"),
    manifest,
    actionName: "get_survey",
    sessionPresent: false,
  });
  assert.equal(withoutSession.overall, "auth_not_ready");
  assert.equal(withoutSession.invoke.status, "blocked");
  assert.equal(withoutSession.authority.status, "unknown");

  const withSession = buildIntegrationReadinessV1({
    actorId: "agent-123",
    observation: observation("valid", "manifest_actions"),
    manifest,
    actionName: "get_survey",
    sessionPresent: true,
  });
  assert.equal(withSession.overall, "attemptable_unverified");
  assert.equal(withSession.invoke.status, "attemptable");
  assert.equal(withSession.auth.status, "session_present");
  assert.equal(withSession.authority.status, "unknown");
});

test("local CLI v1 stays design-blocked even when a session exists", () => {
  const manifest = validateAgentManifestV1({
    schema: "raft-agent-manifest.v1",
    execution: { mode: "local_cli" },
    actions: [],
  });
  const readiness = buildIntegrationReadinessV1({
    actorId: "agent-123",
    observation: observation("valid", "local_cli"),
    manifest,
    sessionPresent: true,
  });

  assert.equal(readiness.overall, "local_cli_design_blocked");
  assert.equal(readiness.invoke.status, "blocked");
  assert.equal(readiness.authority.status, "unknown");
  assert.equal(readiness.transport.status, "not_attempted");
  assert.match(readiness.next_action, /design-blocked/);
});
