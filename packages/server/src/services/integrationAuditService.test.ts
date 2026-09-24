import { test } from "vitest";
import assert from "node:assert/strict";
import {
  redactIntegrationAuditEventForAppAdmin,
  sanitizeIntegrationAuditDiff,
  sanitizeIntegrationAuditMetadata,
} from "./integrationAuditService.js";

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
