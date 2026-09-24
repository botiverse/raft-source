import assert from "node:assert/strict";
import test from "node:test";

import type { RegisteredIntegrationService } from "./_format.js";
import {
  AgentManifestFetchError,
  AgentManifestResponseFormatError,
  type AgentManifestV0,
} from "./manifest.js";
import { probeIntegrationManifest, registryManifestObservation } from "./readiness.js";

const NOW = new Date("2026-07-23T01:00:00.000Z");

function service(overrides: Partial<RegisteredIntegrationService> = {}): RegisteredIntegrationService {
  return {
    id: "service-1",
    clientId: "example-service",
    name: "Example Service",
    description: null,
    homepageUrl: "https://example.test",
    returnUrl: "https://example.test/auth/callback",
    agentManifestUrl: "https://example.test/.well-known/raft-agent-manifest.json",
    agentManifestUrlSource: "explicit",
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z",
    ...overrides,
  };
}

function httpManifest(actions: AgentManifestV0["actions"] = []): AgentManifestV0 {
  return {
    schema: "slock-agent-manifest.v0",
    execution: { mode: "http_api", base_url: "https://example.test" },
    auth: { type: "login_with_raft" },
    actions,
  };
}

test("registry observation keeps list bounded and marks configured manifests unchecked", () => {
  const observation = registryManifestObservation(service(), { now: () => NOW });

  assert.deepEqual(observation, {
    service_id: "example-service",
    manifest_url: "https://example.test/.well-known/raft-agent-manifest.json",
    status: "unchecked",
    surface: "unknown",
    observed_at: NOW.toISOString(),
    source: "service_registry",
    evidence_ceiling: "registry_metadata",
    fault_domain: null,
    retryable: null,
    next_action: "Run `raft integration invoke --service \"example-service\" --list-actions` for a targeted live manifest check.",
  });
});

test("Survey-style missing manifest remains missing and never becomes web-only or valid", async () => {
  const result = await probeIntegrationManifest(service({ clientId: "slock-survey" }), {
    now: () => NOW,
    fetchManifest: async () => {
      throw new AgentManifestFetchError("manifest fetch failed with HTTP 404", 404);
    },
  });

  assert.equal(result.observation.status, "missing");
  assert.equal(result.observation.surface, "unknown");
  assert.equal(result.observation.fault_domain, "manifest_discovery");
  assert.equal(result.observation.retryable, false);
  assert.equal(result.observation.observed_at, NOW.toISOString());
});

test("Cloudflare HTML manifest response preserves content type and response fault domain", async () => {
  const result = await probeIntegrationManifest(service(), {
    now: () => NOW,
    fetchManifest: async () => {
      throw new AgentManifestResponseFormatError(
        "manifest response must be application/json (received text/html; charset=UTF-8)",
        { contentType: "text/html; charset=UTF-8" },
      );
    },
  });

  assert.equal(result.observation.status, "invalid");
  assert.equal(result.observation.surface, "unknown");
  assert.equal(result.observation.fault_domain, "manifest_response");
  assert.equal(result.observation.content_type, "text/html; charset=UTF-8");
  assert.equal(result.observation.retryable, false);
  assert.match(result.observation.next_action, /application\/json instead of an HTML/);
});

test("planned-offline HTTP 503 is unavailable with verbatim Retry-After, not unreachable", async () => {
  const result = await probeIntegrationManifest(service(), {
    now: () => NOW,
    fetchManifest: async () => {
      throw new AgentManifestFetchError(
        "manifest fetch failed with HTTP 503",
        503,
        { retryAfter: "Wed, 23 Jul 2026 02:00:00 GMT" },
      );
    },
  });

  assert.equal(result.observation.status, "unavailable");
  assert.equal(result.observation.fault_domain, "manifest_service");
  assert.equal(result.observation.retryable, true);
  assert.equal(result.observation.retry_after, "Wed, 23 Jul 2026 02:00:00 GMT");
  assert.match(result.observation.next_action, /Retry after Wed, 23 Jul 2026 02:00:00 GMT/);
});

test("valid HTTP action manifest reports manifest actions with manifest-shape ceiling", async () => {
  const result = await probeIntegrationManifest(service(), {
    now: () => NOW,
    fetchManifest: async () => httpManifest([{
      name: "read-report",
      endpoint: { method: "GET", path: "/api/report" },
    }]),
  });

  assert.equal(result.observation.status, "valid");
  assert.equal(result.observation.surface, "manifest_actions");
  assert.equal(result.observation.source, "live_manifest_probe");
  assert.equal(result.observation.evidence_ceiling, "manifest_shape");
  assert.equal(result.observation.fault_domain, null);
  assert.match(result.observation.next_action, /read\/write readiness is not proven/);
  assert.ok(result.manifest);
});

test("Web-only service without a manifest is explicit and performs no fetch", async () => {
  let fetches = 0;
  const result = await probeIntegrationManifest(service({ agentManifestUrl: null }), {
    now: () => NOW,
    fetchManifest: async () => {
      fetches += 1;
      return httpManifest();
    },
  });

  assert.equal(fetches, 0);
  assert.equal(result.observation.status, "not_configured");
  assert.equal(result.observation.surface, "web_only_no_actions");
  assert.equal(result.observation.source, "service_registry");
  assert.equal(result.observation.evidence_ceiling, "registry_metadata");
});

test("unrecognized observations fail forward to unchecked unknown", async () => {
  const result = await probeIntegrationManifest(service(), {
    now: () => NOW,
    fetchManifest: async () => {
      throw { future: "failure-shape" };
    },
  });

  assert.equal(result.observation.status, "unchecked");
  assert.equal(result.observation.surface, "unknown");
  assert.equal(result.observation.fault_domain, "manifest_observation");
  assert.equal(result.observation.retryable, null);
});
