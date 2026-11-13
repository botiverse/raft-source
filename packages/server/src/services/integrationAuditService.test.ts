import assert from "node:assert/strict";
import {
  INTEGRATION_AUDIT_EVENT_TYPES,
  parseServerAuditEventFilters,
  redactIntegrationAuditEventForAppAdmin,
  sanitizeIntegrationAuditDiff,
  sanitizeIntegrationAuditMetadata,
} from "./integrationAuditService";

test("integration audit metadata keeps only event allowlist fields and drops credential-shaped data", () => {
  const sanitized = sanitizeIntegrationAuditMetadata("oauth.token_exchange_failed", {
    clientKey: "demo-client",
    grantType: "authorization_code",
    errorCode: "access_denied",
    token: "sk_agent_secret",
    clientSecret: "raft_secret_abcd",
    cookie: "session=secret",
    nested: { bearer: "Bearer abc.def.ghi" },
    arbitrary: "not allowed",
  });

  assert.deepEqual(sanitized, {
    clientKey: "demo-client",
    grantType: "authorization_code",
    errorCode: "access_denied",
  });
});

test("managed MCP usage audit keeps only the invoked tool identity", () => {
  const sanitized = sanitizeIntegrationAuditMetadata("managed_mcp.tool_invocation_admitted", {
    toolName: "search",
    arguments: { query: "private prompt" },
    result: "private response",
    authorization: "Bearer abc.def.ghi",
  });

  assert.deepEqual(sanitized, { toolName: "search" });
});

test("OAuth lifecycle metadata persists only typed credential-free stages and outcomes", () => {
  const sanitized = sanitizeIntegrationAuditMetadata("oauth.lifecycle", {
    clientKey: "demo-client",
    stage: "token_exchange",
    result: "request_already_consumed",
    grantType: "authorization_code",
    principalType: "human",
    errorClass: "request_already_consumed",
    requestId: "11111111-1111-4111-8111-111111111111",
    code: "one-time-code",
    state: "callback-state",
    token: "slock_at_plaintext",
    exception: "password=do-not-store",
  });

  assert.deepEqual(sanitized, {
    clientKey: "demo-client",
    stage: "token_exchange",
    result: "request_already_consumed",
    grantType: "authorization_code",
    principalType: "human",
    errorClass: "request_already_consumed",
  });
});

test("OAuth lifecycle metadata allows expired-code result without request fingerprints", () => {
  const sanitized = sanitizeIntegrationAuditMetadata("oauth.lifecycle", {
    clientKey: "demo-client",
    stage: "token_exchange",
    result: "authorization_code_expired",
    grantType: "authorization_code",
    principalType: "human",
    errorClass: "authorization_code_expired",
    requestIdHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });

  assert.deepEqual(sanitized, {
    clientKey: "demo-client",
    stage: "token_exchange",
    result: "authorization_code_expired",
    grantType: "authorization_code",
    principalType: "human",
    errorClass: "authorization_code_expired",
  });
});

test("App Admin audit reader redacts legacy token exchange request fingerprints", () => {
  const redacted = redactIntegrationAuditEventForAppAdmin({
    eventType: "oauth.token_exchange_failed",
    correlationId: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    requestId: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    metadata: {
      clientKey: "demo-client",
      grantType: "authorization_code",
      errorCode: "authorization_code_expired",
      requestIdHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
  });

  assert.deepEqual(redacted, {
    eventType: "oauth.token_exchange_failed",
    correlationId: null,
    requestId: null,
    metadata: {
      clientKey: "demo-client",
      grantType: "authorization_code",
      errorCode: "authorization_code_expired",
    },
  });
});

test("integration audit diff keeps only non-sensitive app fields", () => {
  const sanitized = sanitizeIntegrationAuditDiff({
    name: { before: "Old", after: "New" },
    returnUrl: { before: "https://old.example/callback", after: "https://new.example/callback" },
    clientSecret: { before: null, after: "raft_secret_abcd" },
    token: "eyJhbGciOi.fake.fake",
    randomField: "not allowed",
  });

  assert.deepEqual(sanitized, {
    name: { before: "Old", after: "New" },
    returnUrl: { before: "https://old.example/callback", after: "https://new.example/callback" },
  });
});

test("marketplace lifecycle metadata keeps counts and drops credentials", () => {
  const sanitized = sanitizeIntegrationAuditMetadata("marketplace.uninstalled", {
    clientKey: "demo-client",
    targetServerId: "11111111-1111-4111-8111-111111111111",
    revokedGrantCount: 2,
    revokedTokenCount: 3,
    deniedPendingRequestCount: 1,
    clientSecret: "raft_secret_abcd",
    token: "sk_agent_secret",
  });

  assert.deepEqual(sanitized, {
    clientKey: "demo-client",
    targetServerId: "11111111-1111-4111-8111-111111111111",
    revokedGrantCount: 2,
    revokedTokenCount: 3,
    deniedPendingRequestCount: 1,
  });
});

test("app ownership audit keeps capability attribution and drops secrets", () => {
  const sanitized = sanitizeIntegrationAuditMetadata("app.owner_transferred", {
    clientKey: "demo-client",
    previousOwnerType: "agent",
    previousOwnerId: "agent-1",
    nextOwnerType: "agent",
    nextOwnerId: "agent-2",
    recovery: false,
    ownershipOutcome: "already_owner",
    actorAuthority: "displaced_owner_replay",
    clientSecret: "raft_secret_abcd",
    token: "sk_agent_secret",
  });

  assert.deepEqual(sanitized, {
    clientKey: "demo-client",
    previousOwnerType: "agent",
    previousOwnerId: "agent-1",
    nextOwnerType: "agent",
    nextOwnerId: "agent-2",
    recovery: false,
    ownershipOutcome: "already_owner",
    actorAuthority: "displaced_owner_replay",
  });
});

test("webhook audit records only origin and revision metadata", () => {
  const sanitized = sanitizeIntegrationAuditMetadata("webhook.configured", {
    clientKey: "demo-client",
    configRevision: 4,
    endpointOrigin: "https://hooks.example.com",
    endpointUrl: "https://hooks.example.com/private/path?token=secret",
    signingSecret: "raft_webhook_secret_hidden",
    ciphertext: "encrypted-secret",
  });

  assert.deepEqual(sanitized, {
    clientKey: "demo-client",
    configRevision: 4,
    endpointOrigin: "https://hooks.example.com",
  });
});

test("every server-wide audit type keeps actorRole and operationId; integration types drop actorRole", () => {
  const serverWide = new Set(["server.profile_updated", "channel.visitor_visibility_changed", "membership.role_changed", "membership.agent_role_changed", "membership.removed",
    "channel.member_left", "channel.member_removed", "channel.server_disconnected", "channel.server_connected", "channel.source_readmitted",
    "agent.context_view_granted", "agent.context_view_grant_revoked",
    "agent_credential.issued", "agent_credential.revoked", "agent_credential.bootstrap_token_issued",
    "computer.removed", "computer.agent_assigned", "computer.key_rotated", "computer.key_revoked", "computer.revoke_unbound_others_agents", "computer.owner_changed", "computer.legacy_adopted_by_other",
    "sso.connection_saved", "sso.connection_deleted", "sso.rules_updated",
    "sso.domain_added", "sso.domain_verified", "sso.domain_unverified", "sso.domain_removed",
    "sso.identity_linked", "sso.signed_in", "sso.sign_in_refused", "sso.connection_tested",
    "sso.domain_lookup_failing_notice", "sso.domain_unverified_notice"]);
  const operationId = "11111111-1111-4111-8111-111111111111";
  for (const eventType of INTEGRATION_AUDIT_EVENT_TYPES) {
    const sanitized = sanitizeIntegrationAuditMetadata(eventType, { actorRole: "admin", operationId });
    if (serverWide.has(eventType)) assert.deepEqual(sanitized, { actorRole: "admin", operationId }, eventType);
    // link_card.operation_resolved_manually has its own, unrelated operationId.
    else assert.equal(sanitized.actorRole, undefined, eventType);
  }
});

test("server audit filters parse the read route's query and refuse malformed values", () => {
  const actorId = "11111111-1111-4111-8111-111111111111";
  assert.deepEqual(parseServerAuditEventFilters({}), { ok: true, filters: {} });
  assert.deepEqual(parseServerAuditEventFilters({
    category: ["membership,computer", "agent_credential"],
    actorType: "agent",
    actorId: actorId.toUpperCase(),
    since: "2026-01-01T00:00:00Z",
    until: "2026-02-01T00:00:00.123456+08:00",
  }), {
    ok: true,
    filters: {
      categories: ["membership", "computer", "agent_credential"],
      actorType: "agent",
      actorId,
      since: "2026-01-01T00:00:00Z",
      until: "2026-02-01T00:00:00.123456+08:00",
    },
  });
  for (const query of [
    { category: "registration" },
    { category: "" },
    { category: { nested: "membership" } },
    { actorType: "bot" },
    { actorId },
    { actorType: "system", actorId },
    { actorType: "human", actorId: "nope" },
    { since: "2026-01-01" },
    { since: "2026-01-01T00:00:00" },
    { until: "2026-02-29T00:00:00Z" },
    { until: ["2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"] },
  ]) {
    assert.equal(parseServerAuditEventFilters(query).ok, false, JSON.stringify(query));
  }
});

test("an agent's View Context search keeps what it asked in the audit, so Viewed by can show it", () => {
  const asked = { agentId: "a1", messageId: "m1", machineId: "mc1", viewerType: "agent", mode: "search", query: "deploy", matches: 3, secret: "x" };
  assert.deepEqual(sanitizeIntegrationAuditMetadata("agent.context_view_requested", asked), {
    agentId: "a1", messageId: "m1", machineId: "mc1", viewerType: "agent", mode: "search", query: "deploy", matches: 3,
  });
  const read = sanitizeIntegrationAuditMetadata("agent.context_viewed", { agentId: "a1", outcome: "ok", mode: "read", around: "m4.p0" });
  assert.deepEqual(read, { agentId: "a1", outcome: "ok", mode: "read", around: "m4.p0" });
});
