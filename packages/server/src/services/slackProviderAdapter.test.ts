import assert from "node:assert/strict";
import { test } from "vitest";
import type { SlackBridgeRenderSnapshot } from "./externalDeliveryOutboxService.js";
import {
  createSlackEventsHttpAdapter,
  createSlackOAuthExchangeAdapter,
  createSlackOAuthHttpTransport,
  createSlackOAuthManagedHandleCoordinator,
  createSlackProviderPreparation,
  reconcileSlackOutboundDelivery,
  listSlackProviderConversationMembers,
  lookupSlackProviderConversation,
  lookupSlackProviderUser,
  normalizeSlackOAuthExchangeResult,
  SLACK_EVENTS_CONSUMED_HEADER_NAMES,
  SLACK_EVENTS_REQUIRED_HEADER_NAMES,
  SLACK_OAUTH_APP_CREDENTIAL_HANDLE_SCHEMA,
  SLACK_OAUTH_CODE_HANDLE_SCHEMA,
  SLACK_BRIDGE_CREDENTIAL_LEASE_SCHEMA,
  type SlackBridgeCredentialHandle,
  type SlackBridgeProviderDispatchInput,
  type SlackOAuthExchangeRequest,
  type SlackProviderAuthorityFence,
  type SlackProviderAuthorityQuarantineSink,
  type SlackWebApiRequest,
  type SlackWebApiTransport,
  type SlackWebApiTransportResult,
} from "./slackProviderAdapter.js";

const NOW = new Date("2026-07-30T08:45:00.000Z");

const WORKER_FORWARDED_HEADER_NAMES = new Set([
  "content-type",
  "x-slack-signature",
  "x-slack-request-timestamp",
  "x-slack-retry-num",
  "x-slack-retry-reason",
]);

function oauthRequest(): SlackOAuthExchangeRequest {
  return {
    serverId: "11111111-1111-4111-8111-111111111111",
    authorizationCode: {
      schema: SLACK_OAUTH_CODE_HANDLE_SCHEMA,
      handleId: "code-handle-1",
      expiresAt: new Date(NOW.getTime() + 60_000),
    },
    appCredential: {
      schema: SLACK_OAUTH_APP_CREDENTIAL_HANDLE_SCHEMA,
      handleId: "app-credential-handle-1",
      providerAppId: "A_APP",
      environment: "test",
    },
    redirectUri: "https://raft.test/slack/callback",
    expectedProviderAppId: "A_APP",
    expectedScopes: ["chat:write", "channels:history"],
    now: NOW,
  };
}

function snapshot(
  overrides: Partial<SlackBridgeRenderSnapshot> = {},
): SlackBridgeRenderSnapshot {
  return {
    schema: "slack-bridge-render-snapshot.v2",
    sourceMessageId: "message-1",
    sourceMessageSeq: 42,
    canonicalConversationId: "channel-1",
    level: "top_level",
    canonicalRootMessageId: null,
    sourcePermalink: "https://app.slock.ai/s/test/channel/channel-1?msg=message-1",
    senderType: "agent",
    senderId: "agent-1",
    authorName: "Peng",
    authorAvatarDigest: null,
    authorPolicy: {
      policyId: "policy-1",
      serverId: "server-1",
      consentRevision: 7,
      displayName: "Peng",
      fallbackKind: "agent",
      avatar: null,
    },
    sanitizedText: "provider-safe text",
    externalMentions: [{
      projectionId: "projection-1",
      provider: "slack",
      appRegistrationId: "registration-1",
      installId: "install-1",
      workspaceId: "T_TEAM",
      externalActorId: "UMENTION",
      connectionEpoch: 5,
      bindingId: "binding-1",
      bindingEpoch: 9,
      conversationId: "C_CHANNEL",
      memberRevision: 3,
      contextRevision: 4,
      freshnessObservedAt: "2026-07-30T08:44:00.000Z",
      freshnessExpiresAt: "2026-07-30T09:45:00.000Z",
      handleSnapshot: "mention",
      resolutionReason: "explicit_projection",
    }],
    attachments: [],
    bindingAuthority: {
      provider: "slack",
      environment: "test",
      appRegistrationId: "registration-1",
      installId: "install-1",
      workspaceId: "T_TEAM",
      connectionEpoch: 5,
      bindingId: "binding-1",
      bindingEpoch: 9,
      memberRevision: 3,
      contextRevision: 4,
      consentRevision: 7,
      privacyClass: "public",
      raftChannelId: "channel-1",
      providerAuthorityId: "T_TEAM",
      providerConversationId: "C_CHANNEL",
    },
    enqueueRuntimeRevision: "runtime-revision-1",
    ...overrides,
  };
}

function credential(
  overrides: Partial<SlackBridgeCredentialHandle> = {},
): SlackBridgeCredentialHandle {
  return {
    schema: SLACK_BRIDGE_CREDENTIAL_LEASE_SCHEMA,
    leaseId: "lease-1",
    installId: "install-1",
    providerAppId: "A_APP",
    providerAuthorityId: "T_TEAM",
    connectionEpoch: 5,
    credentialRevision: 7,
    leaseExpiresAt: new Date(NOW.getTime() + 60_000),
    ...overrides,
  };
}

function dispatchInput(
  overrides: Partial<SlackBridgeProviderDispatchInput> = {},
): SlackBridgeProviderDispatchInput {
  return {
    deliveryId: "delivery-1",
    reconciliationMarker: "A".repeat(43),
    renderSnapshot: snapshot(),
    credentialHandle: credential(),
    ...overrides,
  };
}

function authority(): SlackProviderAuthorityFence {
  const binding = snapshot().bindingAuthority;
  return {
    installId: binding.installId,
    providerAppId: "A_APP",
    providerAuthorityId: binding.providerAuthorityId,
    providerConversationId: binding.providerConversationId,
    connectionEpoch: binding.connectionEpoch,
    credentialRevision: 7,
    bindingId: binding.bindingId,
    bindingEpoch: binding.bindingEpoch,
  };
}

function transportDouble(
  outcomes: SlackWebApiTransportResult[],
  calls: SlackWebApiRequest[] = [],
): SlackWebApiTransport {
  return {
    evidence: "double",
    async call(request) {
      calls.push(request);
      const outcome = outcomes.shift();
      if (!outcome) throw new Error("double outcome missing");
      return outcome;
    },
  };
}

function quarantineDouble(input: {
  result?: "applied" | "already_fenced" | "fence_mismatch";
  calls?: Parameters<SlackProviderAuthorityQuarantineSink["quarantine"]>[0][];
} = {}): SlackProviderAuthorityQuarantineSink {
  return {
    async quarantine(fence) {
      input.calls?.push(fence);
      return input.result ?? "applied";
    },
  };
}

test("typed outbound adapter maps one frozen attempt to one memoized chat.postMessage call", async () => {
  const calls: SlackWebApiRequest[] = [];
  const prepare = createSlackProviderPreparation({
    transport: transportDouble([{
      kind: "response",
      status: 200,
      headers: {},
      body: { ok: true, channel: "C_CHANNEL", ts: "1753865100.000100" },
      observedAuthority: {
        providerAppId: "A_APP",
        providerAuthorityId: "T_TEAM",
      },
    }], calls),
    quarantineSink: quarantineDouble(),
    now: () => NOW,
  });

  const humanSnapshot = snapshot({
    senderType: "user",
    authorName: "august",
    authorPolicy: {
      ...snapshot().authorPolicy,
      displayName: "august",
      fallbackKind: "human",
    },
  });
  const prepared = await prepare(dispatchInput({ renderSnapshot: humanSnapshot }));
  assert.equal(prepared.ready, true);
  if (!prepared.ready) assert.fail("expected provider preparation");
  assert.deepEqual(await prepared.dispatch(), {
    kind: "accepted",
    providerMessageId: "1753865100.000100",
    providerThreadId: null,
  });
  assert.deepEqual(await prepared.dispatch(), {
    kind: "accepted",
    providerMessageId: "1753865100.000100",
    providerThreadId: null,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, "chat.postMessage");
  assert.deepEqual(calls[0]?.body, {
    channel: "C_CHANNEL",
    text: "provider-safe text",
    mrkdwn: true,
    unfurl_links: false,
    unfurl_media: false,
    username: "august from Raft",
    icon_emoji: ":bust_in_silhouette:",
    metadata: {
      event_type: "raft_message",
      event_payload: {
        delivery_id: "delivery-1",
        reconciliation_marker: "A".repeat(43),
        source_message_id: "message-1",
        source_permalink: "https://app.slock.ai/s/test/channel/channel-1?msg=message-1",
        source_sender_type: "user",
        connection_epoch: 5,
        binding_epoch: 9,
      },
    },
  });
  assert.doesNotMatch(String(calls[0]?.body.text), /View in Raft|Raft Human/);
  assert.equal(JSON.stringify(calls[0]?.body).includes("token"), false);
  assert.equal(JSON.stringify(calls[0]?.body).includes("secret"), false);
});

test("outbound reconciliation finds exactly one Slack metadata marker", async () => {
  const calls: SlackWebApiRequest[] = [];
  let leases = 0;
  const result = await reconcileSlackOutboundDelivery({
    transport: transportDouble([{
      kind: "response",
      status: 200,
      headers: {},
      body: {
        ok: true,
        messages: [
          {
            channel: "C_CHANNEL",
            ts: "1753865100.000300",
            metadata: {
              event_type: "raft_message",
              event_payload: { reconciliation_marker: "A".repeat(43) },
            },
          },
        ],
        response_metadata: { next_cursor: "" },
      },
    }], calls),
    leaseCredential: async () => {
      leases += 1;
      return credential({ leaseId: `reconcile-${leases}` });
    },
    authority: authority(),
    reconciliationMarker: "A".repeat(43),
    now: NOW,
  });
  assert.deepEqual(result, {
    kind: "found",
    providerMessageId: "1753865100.000300",
    providerThreadId: null,
  });
  assert.equal(leases, 1);
  assert.equal(calls[0]?.method, "conversations.history");
  assert.equal(calls[0]?.body.include_all_metadata, true);
  assert.equal(calls[0]?.body.channel, "C_CHANNEL");
});

test("outbound reconciliation treats marker conflicts and incomplete scans as unsafe", async () => {
  const conflict = await reconcileSlackOutboundDelivery({
    transport: transportDouble([{
      kind: "response",
      status: 200,
      headers: {},
      body: {
        ok: true,
        messages: [
          { ts: "1753865100.000301", metadata: { event_type: "raft_message", event_payload: { reconciliation_marker: "B".repeat(43) } } },
          { ts: "1753865100.000302", metadata: { event_type: "raft_message", event_payload: { reconciliation_marker: "B".repeat(43) } } },
        ],
        response_metadata: { next_cursor: "" },
      },
    }]),
    leaseCredential: async () => credential({ leaseId: "reconcile-conflict" }),
    authority: authority(),
    reconciliationMarker: "B".repeat(43),
    now: NOW,
  });
  assert.deepEqual(conflict, { kind: "unavailable", reason: "reconciliation_marker_conflict" });

  const incomplete = await reconcileSlackOutboundDelivery({
    transport: transportDouble([{
      kind: "response",
      status: 200,
      headers: {},
      body: {
        ok: true,
        messages: [],
        response_metadata: { next_cursor: "still-more" },
      },
    }]),
    leaseCredential: async () => credential({ leaseId: "reconcile-incomplete" }),
    authority: authority(),
    reconciliationMarker: "C".repeat(43),
    now: NOW,
    maxPages: 1,
  });
  assert.deepEqual(incomplete, { kind: "unavailable", reason: "reconciliation_page_limit_exceeded" });
});

test("outbound reconciliation keeps first delivery safe while detecting stripped bridge metadata", async () => {
  const input = {
    leaseCredential: async () => credential({ leaseId: "reconcile-control" }),
    authority: authority(),
    reconciliationMarker: "D".repeat(43),
    now: NOW,
  } as const;

  const firstDelivery = await reconcileSlackOutboundDelivery({
    ...input,
    transport: transportDouble([{
      kind: "response",
      status: 200,
      headers: {},
      body: { ok: true, messages: [], response_metadata: { next_cursor: "" } },
    }]),
  });
  assert.deepEqual(firstDelivery, { kind: "not_found" });

  const humanOnly = await reconcileSlackOutboundDelivery({
    ...input,
    transport: transportDouble([{
      kind: "response",
      status: 200,
      headers: {},
      body: {
        ok: true,
        messages: [{ app_id: "A_OTHER", ts: "1753865100.000400", text: "human-visible message" }],
        response_metadata: { next_cursor: "" },
      },
    }]),
  });
  assert.deepEqual(humanOnly, { kind: "not_found" });

  const strippedMetadata = await reconcileSlackOutboundDelivery({
    ...input,
    transport: transportDouble([{
      kind: "response",
      status: 200,
      headers: {},
      body: {
        ok: true,
        messages: [{ app_id: "A_APP", ts: "1753865100.000401", text: "bridge message" }],
        response_metadata: { next_cursor: "" },
      },
    }]),
  });
  assert.deepEqual(strippedMetadata, {
    kind: "unavailable",
    reason: "reconciliation_bridge_metadata_missing",
  });

  const attachmentFileShare = await reconcileSlackOutboundDelivery({
    ...input,
    transport: transportDouble([{
      kind: "response",
      status: 200,
      headers: {},
      body: {
        ok: true,
        messages: [{
          app_id: "A_APP",
          subtype: "file_share",
          ts: "1753865100.000402",
          files: [{ id: "F_ATTACHMENT" }],
        }],
        response_metadata: { next_cursor: "" },
      },
    }]),
  });
  assert.deepEqual(attachmentFileShare, { kind: "not_found" });
});

test("typed outbound text uses only the frozen controlled avatar URL when one is present", async () => {
  const calls: SlackWebApiRequest[] = [];
  const prepare = createSlackProviderPreparation({
    transport: transportDouble([{
      kind: "response",
      status: 200,
      headers: {},
      body: { ok: true, channel: "C_CHANNEL", ts: "1753865100.000101" },
      observedAuthority: { providerAppId: "A_APP", providerAuthorityId: "T_TEAM" },
    }], calls),
    quarantineSink: quarantineDouble(),
    now: () => NOW,
  });
  const avatarUrl = "https://api.raft.test/api/external-avatars/11111111-1111-4111-8111-111111111111.webp";
  const frozen = snapshot({
    authorAvatarDigest: "b".repeat(64),
    authorPolicy: {
      ...snapshot().authorPolicy,
      avatar: {
        artifactId: "11111111-1111-4111-8111-111111111111",
        publicUrl: avatarUrl,
        sourceDigest: "b".repeat(64),
        artifactRevision: 2,
      },
    },
  });
  const prepared = await prepare(dispatchInput({ renderSnapshot: frozen }));
  assert.equal(prepared.ready, true);
  if (!prepared.ready) return;
  await prepared.dispatch();
  assert.equal(calls[0]?.body.icon_url, avatarUrl);
  assert.equal("icon_emoji" in (calls[0]?.body ?? {}), false);
});

test("outbound attachment snapshots append the fixed marker without exposing file metadata", async () => {
  const calls: SlackWebApiRequest[] = [];
  const prepare = createSlackProviderPreparation({
    transport: transportDouble([{
      kind: "response",
      status: 200,
      headers: {},
      body: { ok: true, channel: "C_CHANNEL", ts: "1753865100.000101" },
      observedAuthority: { providerAppId: "A_APP", providerAuthorityId: "T_TEAM" },
    }, {
      kind: "response",
      status: 200,
      headers: {},
      body: { ok: true, channel: "C_CHANNEL", ts: "1753865100.000102" },
      observedAuthority: { providerAppId: "A_APP", providerAuthorityId: "T_TEAM" },
    }], calls),
    quarantineSink: quarantineDouble(),
    now: () => NOW,
  });
  for (const [index, sanitizedText] of [
    "caption from Raft\n\n[Attachment not synced]",
    "[Attachment not synced]",
  ].entries()) {
    const prepared = await prepare(dispatchInput({
      deliveryId: `delivery-attachment-${index}`,
      renderSnapshot: snapshot({ sanitizedText }),
    }));
    assert.equal(prepared.ready, true);
    if (!prepared.ready) assert.fail("expected attachment provider preparation");
    assert.equal((await prepared.dispatch()).kind, "accepted");
  }
  assert.equal(calls.length, 2);
  assert.equal(
    calls[0]?.body.text,
    "caption from Raft\n\n[Attachment not synced]",
  );
  assert.equal(
    calls[1]?.body.text,
    "[Attachment not synced]",
  );
  assert.doesNotMatch(JSON.stringify(calls), /filename|mimeType|storageKey|private_url/);
});

test("missing or drifted preflight receipts make zero transport calls", async () => {
  const calls: SlackWebApiRequest[] = [];
  const prepare = createSlackProviderPreparation({
    transport: transportDouble([], calls),
    quarantineSink: quarantineDouble(),
    now: () => NOW,
  });

  const missingMarker = await prepare(dispatchInput({
    reconciliationMarker: "",
  }));
  assert.deepEqual(missingMarker, {
    ready: false,
    reason: "provider_preflight_receipt_invalid",
  });
  const epochDrift = await prepare(dispatchInput({
    credentialHandle: credential({ connectionEpoch: 6 }),
  }));
  assert.deepEqual(epochDrift, {
    ready: false,
    reason: "provider_preflight_receipt_invalid",
  });
  const expired = await prepare(dispatchInput({
    credentialHandle: credential({ leaseExpiresAt: NOW }),
  }));
  assert.deepEqual(expired, {
    ready: false,
    reason: "provider_preflight_receipt_invalid",
  });
  assert.equal(calls.length, 0);
});

test("thread dispatch requires an exact root-link receipt before provider I/O", async () => {
  const calls: SlackWebApiRequest[] = [];
  const threadSnapshot = snapshot({
    level: "thread",
    canonicalRootMessageId: "root-message-1",
  });
  const withoutReceipt = createSlackProviderPreparation({
    transport: transportDouble([], calls),
    quarantineSink: quarantineDouble(),
    now: () => NOW,
  });
  assert.deepEqual(await withoutReceipt(dispatchInput({
    renderSnapshot: threadSnapshot,
  })), {
    ready: false,
    reason: "provider_thread_receipt_missing",
  });
  assert.equal(calls.length, 0);

  const withReceipt = createSlackProviderPreparation({
    transport: transportDouble([{
      kind: "response",
      status: 200,
      headers: {},
      body: { ok: true, channel: "C_CHANNEL", ts: "1753865100.000200" },
    }], calls),
    quarantineSink: quarantineDouble(),
    now: () => NOW,
    threadAuthority: {
      async resolve() {
        return {
          active: true,
          fact: {
            providerThreadId: "1753865000.000001",
            rootLinkRevision: 2,
            installId: "install-1",
            providerAuthorityId: "T_TEAM",
            providerConversationId: "C_CHANNEL",
            connectionEpoch: 5,
            bindingId: "binding-1",
            bindingEpoch: 9,
          },
        };
      },
    },
  });
  const prepared = await withReceipt(dispatchInput({
    renderSnapshot: threadSnapshot,
  }));
  assert.equal(prepared.ready, true);
  if (!prepared.ready) assert.fail("expected thread provider preparation");
  assert.deepEqual(await prepared.dispatch(), {
    kind: "accepted",
    providerMessageId: "1753865100.000200",
    providerThreadId: "1753865000.000001",
  });
  assert.equal(calls[0]?.body.thread_ts, "1753865000.000001");
});

test("429 is a closed rate-limit outcome and after-send timeout is unknown", async () => {
  const ratePrepare = createSlackProviderPreparation({
    transport: transportDouble([{
      kind: "response",
      status: 429,
      headers: { "Retry-After": "30" },
      body: { ok: false, error: "ratelimited" },
    }]),
    quarantineSink: quarantineDouble(),
    now: () => NOW,
  });
  const rateLimited = await ratePrepare(dispatchInput());
  assert.equal(rateLimited.ready, true);
  if (!rateLimited.ready) assert.fail("expected rate-limit preparation");
  assert.deepEqual(await rateLimited.dispatch(), {
    kind: "rate_limited",
    retryAfterMs: 30_000,
  });

  const timeoutPrepare = createSlackProviderPreparation({
    transport: transportDouble([{
      kind: "transport_failure",
      phase: "after_send",
      code: "timeout",
    }]),
    quarantineSink: quarantineDouble(),
    now: () => NOW,
  });
  const timeout = await timeoutPrepare(dispatchInput());
  assert.equal(timeout.ready, true);
  if (!timeout.ready) assert.fail("expected timeout preparation");
  assert.deepEqual(await timeout.dispatch(), { kind: "outcome_unknown" });
});

test("before-send failure is retryable without being an ambiguous provider outcome", async () => {
  const prepare = createSlackProviderPreparation({
    transport: transportDouble([{
      kind: "transport_failure",
      phase: "before_send",
      code: "dns",
    }]),
    quarantineSink: quarantineDouble(),
    now: () => NOW,
  });
  const prepared = await prepare(dispatchInput());
  assert.equal(prepared.ready, true);
  if (!prepared.ready) assert.fail("expected preparation");
  assert.deepEqual(await prepared.dispatch(), {
    kind: "transient_failure",
    baseDelayMs: 1_000,
  });
});

test("revoked credentials and provider identity substitution fence authority before terminal failure", async () => {
  const quarantineCalls:
    Parameters<SlackProviderAuthorityQuarantineSink["quarantine"]>[0][] = [];
  const revoked = createSlackProviderPreparation({
    transport: transportDouble([{
      kind: "response",
      status: 200,
      headers: {},
      body: { ok: false, error: "token_revoked" },
    }]),
    quarantineSink: quarantineDouble({ calls: quarantineCalls }),
    now: () => NOW,
  });
  const revokedPrepared = await revoked(dispatchInput());
  assert.equal(revokedPrepared.ready, true);
  if (!revokedPrepared.ready) assert.fail("expected revoked preparation");
  assert.deepEqual(await revokedPrepared.dispatch(), {
    kind: "deterministic_failure",
  });
  assert.equal(quarantineCalls.length, 1);
  assert.equal(quarantineCalls[0]?.reason, "provider_credential_revoked");
  assert.equal(quarantineCalls[0]?.connectionEpoch, 5);

  const substituted = createSlackProviderPreparation({
    transport: transportDouble([{
      kind: "response",
      status: 200,
      headers: {},
      body: { ok: true, channel: "C_OTHER", ts: "1753865100.000300" },
    }]),
    quarantineSink: quarantineDouble({
      result: "fence_mismatch",
      calls: quarantineCalls,
    }),
    now: () => NOW,
  });
  const substitutedPrepared = await substituted(dispatchInput());
  assert.equal(substitutedPrepared.ready, true);
  if (!substitutedPrepared.ready) assert.fail("expected substituted preparation");
  assert.deepEqual(await substitutedPrepared.dispatch(), {
    kind: "outcome_unknown",
  });
  assert.equal(
    quarantineCalls.at(-1)?.reason,
    "provider_conversation_identity_conflict",
  );
});

test("OAuth mapping exposes sealed authority only and fails closed on scope or identity drift", async () => {
  const request = oauthRequest();
  const authorized = {
    kind: "authorized" as const,
    providerAppId: "A_APP",
    providerTeamId: "T_TEAM",
    providerEnterpriseId: null,
    providerUserId: "U_HUMAN",
    botUserId: "U_BOT",
    providerBotId: "B_BOT",
    workspaceName: "Isolated Test",
    installedScopes: ["channels:history", "chat:write"],
    sealedCredential: {
      encryptedMaterial: "sealed-material",
      envelopeKeyId: "key-1",
      aadVersion: 1,
    },
  };
  assert.deepEqual(normalizeSlackOAuthExchangeResult({
    request,
    result: authorized,
  }), authorized);
  assert.deepEqual(normalizeSlackOAuthExchangeResult({
    request,
    result: { ...authorized, providerAppId: "A_OTHER" },
  }), { kind: "identity_conflict", reason: "app" });
  assert.deepEqual(normalizeSlackOAuthExchangeResult({
    request,
    result: { ...authorized, installedScopes: ["chat:write"] },
  }), { kind: "deterministic_failure", reason: "scope_mismatch" });
  assert.deepEqual(normalizeSlackOAuthExchangeResult({
    request,
    result: { ...authorized, providerUserId: "U_BOT" },
  }), { kind: "outcome_unknown" });
  assert.deepEqual(normalizeSlackOAuthExchangeResult({
    request,
    result: {
      kind: "transport_failure",
      phase: "before_send",
    },
  }), { kind: "transient_failure", retryAfterMs: 1_000 });
  assert.deepEqual(normalizeSlackOAuthExchangeResult({
    request,
    result: {
      kind: "transport_failure",
      phase: "after_send",
    },
  }), { kind: "outcome_unknown" });

  let exchangeCalls = 0;
  const exchange = createSlackOAuthExchangeAdapter({
    transport: {
      evidence: "double",
      async exchange() {
        exchangeCalls += 1;
        return authorized;
      },
    },
  });
  assert.deepEqual(await exchange({
    ...request,
    authorizationCode: {
      ...request.authorizationCode,
      expiresAt: NOW,
    },
  }), { kind: "preflight_rejected" });
  assert.equal(exchangeCalls, 0);
  assert.deepEqual(await exchange(request), authorized);
  assert.equal(exchangeCalls, 1);
  assert.equal(JSON.stringify(authorized).includes("xox"), false);
});

test("live OAuth HTTP transport consumes handles once and exposes only sealed credential material", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let consumeCalls = 0;
  let sealCalls = 0;
  const transport = createSlackOAuthHttpTransport({
    endpoint: "https://slack.test/api/oauth.v2.access",
    handles: {
      async consume(input) {
        consumeCalls += 1;
        assert.equal(input.authorizationCode.handleId, "code-handle-1");
        assert.equal(input.appCredential.handleId, "app-credential-handle-1");
        assert.equal(input.expectedProviderAppId, "A_APP");
        assert.equal(input.now, NOW);
        return {
          providerOAuthClientId: "client-1",
          clientSecret: "client-secret-value",
          authorizationCode: "authorization-code-value",
        };
      },
    },
    credentialSealer: {
      async seal(input) {
        sealCalls += 1;
        assert.equal(input.accessToken, "xoxb-secret-token");
        assert.equal(input.tokenType, "bot");
        assert.equal(input.providerAppId, "A_APP");
        assert.equal(input.providerTeamId, "T_TEAM");
        assert.equal(input.botUserId, "U_BOT");
        assert.equal(input.now, NOW);
        return {
          encryptedMaterial: "sealed-credential",
          envelopeKeyId: "kms-key-1",
          aadVersion: 1,
        };
      },
    },
    async fetch(url, init) {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).endsWith("/auth.test")) {
        return new Response(JSON.stringify({
          ok: true,
          team_id: "T_TEAM",
          user_id: "U_BOT",
          bot_id: "B_BOT",
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-oauth-scopes": " chat:write, channels:history, chat:write ",
            "x-accepted-oauth-scopes": "admin",
          },
        });
      }
      return new Response(JSON.stringify({
        ok: true,
        app_id: "A_APP",
        access_token: "xoxb-secret-token",
        token_type: "bot",
        bot_user_id: "U_BOT",
        bot_id: "B_BOT",
        authed_user: { id: "U_HUMAN" },
        scope: "chat:write,channels:history,chat:write",
        team: { id: "T_TEAM", name: "Workspace" },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const outcome = await transport.exchange(oauthRequest());
  assert.equal(consumeCalls, 1);
  assert.equal(sealCalls, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, "https://slack.test/api/oauth.v2.access");
  assert.equal(calls[0]!.init.method, "POST");
  assert.equal(calls[0]!.init.redirect, "error");
  assert.equal(calls[0]!.init.body?.toString(), new URLSearchParams({
    client_id: "client-1",
    client_secret: "client-secret-value",
    code: "authorization-code-value",
    redirect_uri: "https://raft.test/slack/callback",
  }).toString());
  assert.equal(calls[1]!.url, "https://slack.com/api/auth.test");
  assert.equal(calls[1]!.init.method, "POST");
  assert.equal((calls[1]!.init.headers as Record<string, string>).authorization, "Bearer xoxb-secret-token");
  assert.deepEqual(outcome, {
    kind: "authorized",
    providerAppId: "A_APP",
    providerTeamId: "T_TEAM",
    providerEnterpriseId: null,
    providerUserId: "U_HUMAN",
    botUserId: "U_BOT",
    providerBotId: "B_BOT",
    workspaceName: "Workspace",
    installedScopes: ["channels:history", "chat:write"],
    sealedCredential: {
      encryptedMaterial: "sealed-credential",
      envelopeKeyId: "kms-key-1",
      aadVersion: 1,
    },
  });
  const serialized = JSON.stringify(outcome);
  assert.equal(serialized.includes("xoxb-secret-token"), false);
  assert.equal(serialized.includes("client-secret-value"), false);
  assert.equal(serialized.includes("authorization-code-value"), false);
});

test("live OAuth HTTP transport rejects missing or accepted-only scope headers before sealing", async () => {
  const headerSets: Array<Record<string, string>> = [
    { "content-type": "application/json" },
    { "content-type": "application/json", "x-accepted-oauth-scopes": "channels:history,chat:write" },
  ];
  for (const headers of headerSets) {
    let calls = 0;
    let seals = 0;
    const transport = createSlackOAuthHttpTransport({
      endpoint: "https://slack.test/api/oauth.v2.access",
      handles: {
        async consume() {
          return {
            providerOAuthClientId: "client-1",
            clientSecret: "client-secret-value",
            authorizationCode: "authorization-code-value",
          };
        },
      },
      credentialSealer: {
        async seal() {
          seals += 1;
          return { encryptedMaterial: "never", envelopeKeyId: "never", aadVersion: 1 };
        },
      },
      async fetch(url) {
        calls += 1;
        if (String(url).endsWith("/auth.test")) {
          return new Response(JSON.stringify({
            ok: true,
            team_id: "T_TEAM",
            user_id: "U_BOT",
            bot_id: "B_BOT",
          }), { status: 200, headers });
        }
        return new Response(JSON.stringify({
          ok: true,
          app_id: "A_APP",
          access_token: "xoxb-secret-token",
          token_type: "bot",
          bot_user_id: "U_BOT",
          authed_user: { id: "U_HUMAN" },
          scope: "channels:history,chat:write",
          team: { id: "T_TEAM" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    assert.deepEqual(await transport.exchange(oauthRequest()), {
      kind: "transport_failure",
      phase: "after_send",
    });
    assert.equal(calls, 2);
    assert.equal(seals, 0);
  }
});

test("live OAuth HTTP transport requires a distinct Slack human identity receipt", async () => {
  const bodies = [{
    ok: true,
    app_id: "A_APP",
    access_token: "xoxb-secret-token",
    token_type: "bot",
    bot_user_id: "U_BOT",
    scope: "channels:history,chat:write",
    team: { id: "T_TEAM" },
  }, {
    ok: true,
    app_id: "A_APP",
    access_token: "xoxb-secret-token",
    token_type: "bot",
    bot_user_id: "U_BOT",
    authed_user: { id: "U_BOT" },
    scope: "channels:history,chat:write",
    team: { id: "T_TEAM" },
  }];
  for (const body of bodies) {
    let sealCalls = 0;
    const transport = createSlackOAuthHttpTransport({
      endpoint: "https://slack.test/api/oauth.v2.access",
      handles: {
        async consume() {
          return {
            providerOAuthClientId: "client-1",
            clientSecret: "client-secret-value",
            authorizationCode: "authorization-code-value",
          };
        },
      },
      credentialSealer: {
        async seal() {
          sealCalls += 1;
          return {
            encryptedMaterial: "never",
            envelopeKeyId: "never",
            aadVersion: 1,
          };
        },
      },
      async fetch() {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    assert.deepEqual(await transport.exchange(oauthRequest()), {
      kind: "transport_failure",
      phase: "after_send",
    });
    assert.equal(sealCalls, 0);
  }
});

test("managed OAuth handle coordinator binds one-use app and code material without exposing plaintext", async () => {
  const ids = ["app-1", "code-1"];
  let secretLeaseCalls = 0;
  const coordinator = createSlackOAuthManagedHandleCoordinator({
    handleTtlMs: 30_000,
    randomHandleId: () => ids.shift() ?? assert.fail("unexpected handle request"),
    appSecrets: {
      async lease(input) {
        secretLeaseCalls += 1;
        assert.equal(input.registrationId, "registration-1");
        assert.equal(input.attemptId, "attempt-1");
        return {
          providerOAuthClientId: input.providerOAuthClientId,
          clientSecret: "managed-client-secret",
          expiresAt: new Date(input.now.getTime() + 120_000),
        };
      },
    },
  });
  const app = await coordinator.leaseAppCredential({
    registrationId: "registration-1",
    providerAppId: "A_APP",
    providerOAuthClientId: "client-1",
    environment: "test",
    audience: "slack-oauth-exchange",
    attemptId: "attempt-1",
    now: NOW,
  });
  assert.ok(app);
  assert.equal(app.leaseExpiresAt.toISOString(), "2026-07-30T08:45:30.000Z");
  const code = await coordinator.captureAuthorizationCode({
    attemptId: "attempt-1",
    providerOAuthClientId: "client-1",
    authorizationCode: "managed-authorization-code",
    now: NOW,
  });
  assert.equal(JSON.stringify({ app, code }).includes("managed-client-secret"), false);
  assert.equal(JSON.stringify({ app, code }).includes("managed-authorization-code"), false);
  assert.deepEqual(await coordinator.handles.consume({
    authorizationCode: code,
    appCredential: app.handle,
    expectedProviderAppId: "A_APP",
    now: NOW,
  }), {
    providerOAuthClientId: "client-1",
    clientSecret: "managed-client-secret",
    authorizationCode: "managed-authorization-code",
  });
  assert.equal(await coordinator.handles.consume({
    authorizationCode: code,
    appCredential: app.handle,
    expectedProviderAppId: "A_APP",
    now: NOW,
  }), null);
  assert.equal(secretLeaseCalls, 1);
});

test("managed OAuth handle coordinator consumes substituted pairs before rejecting them", async () => {
  const ids = ["app-1", "code-1", "app-2", "code-2"];
  const coordinator = createSlackOAuthManagedHandleCoordinator({
    randomHandleId: () => ids.shift() ?? assert.fail("unexpected handle request"),
    appSecrets: {
      async lease(input) {
        return {
          providerOAuthClientId: input.providerOAuthClientId,
          clientSecret: `secret:${input.attemptId}`,
          expiresAt: new Date(input.now.getTime() + 60_000),
        };
      },
    },
  });
  const lease = async (attemptId: string) => {
    const app = await coordinator.leaseAppCredential({
      registrationId: "registration-1",
      providerAppId: "A_APP",
      providerOAuthClientId: "client-1",
      environment: "test",
      audience: "slack-oauth-exchange",
      attemptId,
      now: NOW,
    });
    assert.ok(app);
    const code = await coordinator.captureAuthorizationCode({
      attemptId,
      providerOAuthClientId: "client-1",
      authorizationCode: `code:${attemptId}`,
      now: NOW,
    });
    return { app, code };
  };
  const first = await lease("attempt-1");
  const second = await lease("attempt-2");
  assert.equal(await coordinator.handles.consume({
    authorizationCode: second.code,
    appCredential: first.app.handle,
    expectedProviderAppId: "A_APP",
    now: NOW,
  }), null);
  assert.equal(await coordinator.handles.consume({
    authorizationCode: first.code,
    appCredential: first.app.handle,
    expectedProviderAppId: "A_APP",
    now: NOW,
  }), null);
  assert.equal(await coordinator.handles.consume({
    authorizationCode: second.code,
    appCredential: second.app.handle,
    expectedProviderAppId: "A_APP",
    now: NOW,
  }), null);
});

test("managed OAuth handle coordinator rejects duplicate, expired, and stopped material", async () => {
  let ids = 0;
  const coordinator = createSlackOAuthManagedHandleCoordinator({
    handleTtlMs: 1_000,
    randomHandleId: () => String(++ids),
    appSecrets: {
      async lease(input) {
        return {
          providerOAuthClientId: input.providerOAuthClientId,
          clientSecret: "secret",
          expiresAt: new Date(input.now.getTime() + 60_000),
        };
      },
    },
  });
  const request = {
    registrationId: "registration-1",
    providerAppId: "A_APP",
    providerOAuthClientId: "client-1",
    environment: "test" as const,
    audience: "slack-oauth-exchange" as const,
    attemptId: "attempt-1",
    now: NOW,
  };
  const app = await coordinator.leaseAppCredential(request);
  assert.ok(app);
  assert.equal(await coordinator.leaseAppCredential(request), null);
  await assert.rejects(coordinator.captureAuthorizationCode({
    attemptId: "attempt-1",
    providerOAuthClientId: "other-client",
    authorizationCode: "code",
    now: NOW,
  }), /capture rejected/);
  const code = await coordinator.captureAuthorizationCode({
    attemptId: "attempt-1",
    providerOAuthClientId: "client-1",
    authorizationCode: "code",
    now: NOW,
  });
  assert.equal(await coordinator.handles.consume({
    authorizationCode: code,
    appCredential: app.handle,
    expectedProviderAppId: "A_APP",
    now: new Date(NOW.getTime() + 1_001),
  }), null);
  coordinator.stop();
  assert.equal(await coordinator.leaseAppCredential({
    ...request,
    attemptId: "attempt-2",
  }), null);
});

test("live OAuth HTTP transport fails before provider I/O when handle consumption fails", async () => {
  let fetchCalls = 0;
  let sealCalls = 0;
  const transport = createSlackOAuthHttpTransport({
    endpoint: "https://slack.test/api/oauth.v2.access",
    handles: { async consume() { return null; } },
    credentialSealer: {
      async seal() {
        sealCalls += 1;
        return {
          encryptedMaterial: "never",
          envelopeKeyId: "never",
          aadVersion: 1,
        };
      },
    },
    async fetch() {
      fetchCalls += 1;
      return new Response("never");
    },
  });
  assert.deepEqual(await transport.exchange(oauthRequest()), {
    kind: "rejected",
    error: "handle_unavailable",
  });
  assert.equal(fetchCalls, 0);
  assert.equal(sealCalls, 0);
});

test("live OAuth HTTP transport treats post-consumption 429, provider 5xx, oversized bodies, and sealing failure as unknown", async () => {
  const responses = [
    new Response("rate limited", { status: 429 }),
    new Response(JSON.stringify({ ok: false, error: "temporarily_unavailable" }), { status: 503 }),
    new Response("x".repeat(33), { status: 200 }),
    new Response(JSON.stringify({
      ok: true,
      app_id: "A_APP",
      access_token: "xoxb-secret-token",
      token_type: "bot",
      bot_user_id: "U_BOT",
      authed_user: { id: "U_HUMAN" },
      scope: "channels:history,chat:write",
      team: { id: "T_TEAM" },
    }), { status: 200 }),
  ];
  let consumeCalls = 0;
  let fetchCalls = 0;
  const transport = createSlackOAuthHttpTransport({
    endpoint: "https://slack.test/api/oauth.v2.access",
    maxResponseBytes: 32,
    handles: {
      async consume() {
        consumeCalls += 1;
        return {
          providerOAuthClientId: "client-1",
          clientSecret: "client-secret-value",
          authorizationCode: "authorization-code-value",
        };
      },
    },
    credentialSealer: {
      async seal() {
        throw new Error("sealer unavailable");
      },
    },
    async fetch() {
      return responses[fetchCalls++]!;
    },
  });
  for (let index = 0; index < responses.length; index += 1) {
    assert.deepEqual(await transport.exchange(oauthRequest()), {
      kind: "transport_failure",
      phase: "after_send",
    });
  }
  assert.equal(consumeCalls, 4);
  assert.equal(fetchCalls, 4);
});

test("live OAuth HTTP transport rejects insecure endpoints at construction", () => {
  for (const endpoints of [
    { endpoint: "http://slack.test/api/oauth.v2.access" },
    { authTestEndpoint: "http://slack.test/api/auth.test" },
  ]) {
    assert.throws(() => createSlackOAuthHttpTransport({
      ...endpoints,
      handles: { async consume() { return null; } },
      credentialSealer: {
        async seal() {
          return {
            encryptedMaterial: "never",
            envelopeKeyId: "never",
            aadVersion: 1,
          };
        },
      },
    }), /configuration is invalid/);
  }
});

test("HTTP Events adapter preserves raw bytes and maps duplicate admission without parsing first", async () => {
  const rawBody = Buffer.from("{not-json-but-still-raw", "utf8");
  let admitCalls = 0;
  const adapter = createSlackEventsHttpAdapter({
    async admit(input) {
      admitCalls += 1;
      assert.equal(input.requestUrl, "https://raft.test/slack/events");
      assert.equal(input.rawBody, rawBody);
      assert.equal(input.timestampHeader, "1753865100");
      assert.equal(input.signatureHeader, `v0=${"a".repeat(64)}`);
      assert.equal(input.slackRetryNumHeader, "3");
      assert.equal(input.slackRetryReasonHeader, "http_error");
      return {
        kind: "event",
        eventInboxId: "event-1",
        duplicate: false,
        status: "unsupported",
        reason: "provider_loop_suppressed",
        authority: null,
      };
    },
  });
  const secretResolver = {
    async resolveSigningSecret() {
      return "unused-by-injected-admission";
    },
  };
  const payloadSealer = {
    async sealNormalizedPayload() {
      return {
        encryptedPayload: "unused",
        envelopeKeyId: "unused",
        aadVersion: 1,
      };
    },
  };
  assert.deepEqual(await adapter({
    requestUrl: "https://raft.test/slack/events",
    environment: "test",
    rawBody,
    headers: {
      host: "attacker-controlled.example.test",
      "content-type": "application/json",
      "X-Slack-Request-Timestamp": "1753865100",
      "x-slack-signature": `v0=${"a".repeat(64)}`,
      "X-Slack-Retry-Num": "3",
      "x-slack-retry-reason": "http_error",
    },
    secretResolver,
    payloadSealer,
    now: NOW,
  }), {
    statusCode: 200,
    body: {
      kind: "event",
      eventInboxId: "event-1",
      duplicate: false,
      status: "unsupported",
    },
  });
  assert.equal(admitCalls, 1);
  for (const missingHeader of SLACK_EVENTS_REQUIRED_HEADER_NAMES) {
    const headers: Record<string, string> = {
      "x-slack-request-timestamp": "1753865100",
      "x-slack-signature": `v0=${"a".repeat(64)}`,
    };
    delete headers[missingHeader];
    await assert.rejects(adapter({
      requestUrl: "https://raft.test/slack/events",
      environment: "test",
      rawBody,
      headers,
      secretResolver,
      payloadSealer,
      now: NOW,
    }), (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "external_ingress_signature_invalid");
  }
  assert.equal(admitCalls, 1);
});

test("HTTP Events adapter consumes only the Worker-forwarded header contract and never Host authority", () => {
  assert.deepEqual(
    [...SLACK_EVENTS_CONSUMED_HEADER_NAMES].sort(),
    [
      "x-slack-request-timestamp",
      "x-slack-retry-num",
      "x-slack-retry-reason",
      "x-slack-signature",
    ].sort(),
  );
  for (const headerName of SLACK_EVENTS_CONSUMED_HEADER_NAMES) {
    assert.equal(WORKER_FORWARDED_HEADER_NAMES.has(headerName), true, headerName);
  }
  assert.equal(SLACK_EVENTS_CONSUMED_HEADER_NAMES.includes("host" as never), false);
});

test("directory adapters return stable provider IDs with display and avatar as snapshots only", async () => {
  const calls: SlackWebApiRequest[] = [];
  const transport = transportDouble([
    {
      kind: "response",
      status: 200,
      headers: {},
      body: {
        ok: true,
        user: {
          id: "U_USER",
          name: "mutable-handle",
          is_bot: false,
          deleted: false,
          profile: {
            display_name: "Mutable Name",
            image_72: "https://cdn.test/avatar.png",
          },
        },
      },
    },
    {
      kind: "response",
      status: 200,
      headers: {},
      body: {
        ok: true,
        channel: {
          id: "C_CHANNEL",
          name: "mutable-channel-name",
          is_private: true,
          is_archived: false,
          is_member: true,
        },
      },
    },
  ], calls);
  const user = await lookupSlackProviderUser({
    transport,
    quarantineSink: quarantineDouble(),
    credentialHandle: credential(),
    authority: authority(),
    providerUserId: "U_USER",
    now: NOW,
  });
  assert.equal(user.kind, "fact");
  if (user.kind !== "fact") assert.fail("expected user fact");
  assert.equal(user.fact.providerUserId, "U_USER");
  assert.equal(user.fact.handleSnapshot, "mutable-handle");
  assert.equal(user.fact.avatarUrlDigest?.length, 64);
  assert.equal(JSON.stringify(user).includes("https://cdn.test/avatar.png"), false);

  const conversation = await lookupSlackProviderConversation({
    transport,
    quarantineSink: quarantineDouble(),
    credentialHandle: credential(),
    authority: authority(),
    providerConversationId: "C_CHANNEL",
    now: NOW,
  });
  assert.deepEqual(conversation, {
    kind: "fact",
    fact: {
      providerConversationId: "C_CHANNEL",
      providerAuthorityId: "T_TEAM",
      nameSnapshot: "mutable-channel-name",
      privacyClass: "private",
      isArchived: false,
      isMemberObserved: true,
      observedAt: NOW,
    },
  });
  assert.deepEqual(calls.map((call) => call.method), [
    "users.info",
    "conversations.info",
  ]);

  assert.deepEqual(await lookupSlackProviderConversation({
    transport,
    quarantineSink: quarantineDouble(),
    credentialHandle: {
      ...credential(),
      credentialRevision: 9,
    },
    authority: authority(),
    providerConversationId: "C_CHANNEL",
    now: NOW,
  }), { kind: "unavailable", reason: "deterministic" });
  assert.equal(calls.length, 2);
});

test("conversation member observation consumes every page and rejects a repeated cursor", async () => {
  const calls: SlackWebApiRequest[] = [];
  let pageLease = 0;
  const observed = await listSlackProviderConversationMembers({
    transport: transportDouble([
      {
        kind: "response",
        status: 200,
        headers: {},
        body: {
          ok: true,
          members: ["U_B", "U_A"],
          response_metadata: { next_cursor: "cursor-2" },
        },
      },
      {
        kind: "response",
        status: 200,
        headers: {},
        body: {
          ok: true,
          members: ["U_C", "U_A"],
          response_metadata: { next_cursor: "" },
        },
      },
    ], calls),
    quarantineSink: quarantineDouble(),
    credentialHandleForPage: async () => credential({
      leaseId: `lease-page-${pageLease += 1}`,
    }),
    authority: authority(),
    providerConversationId: "C_CHANNEL",
    now: NOW,
  });
  assert.deepEqual(observed, {
    kind: "fact",
    fact: {
      providerConversationId: "C_CHANNEL",
      providerAuthorityId: "T_TEAM",
      providerMemberIds: ["U_A", "U_B", "U_C"],
      observedAt: NOW,
    },
  });
  assert.deepEqual(calls.map((call) => ({
    method: call.method,
    leaseId: call.credentialHandle.leaseId,
    body: call.body,
  })), [
    {
      method: "conversations.members",
      leaseId: "lease-page-1",
      body: { channel: "C_CHANNEL", limit: 200 },
    },
    {
      method: "conversations.members",
      leaseId: "lease-page-2",
      body: { channel: "C_CHANNEL", limit: 200, cursor: "cursor-2" },
    },
  ]);

  assert.deepEqual(await listSlackProviderConversationMembers({
    transport: transportDouble([
      {
        kind: "response",
        status: 200,
        headers: {},
        body: {
          ok: true,
          members: ["U_A"],
          response_metadata: { next_cursor: "same" },
        },
      },
      {
        kind: "response",
        status: 200,
        headers: {},
        body: {
          ok: true,
          members: ["U_B"],
          response_metadata: { next_cursor: "same" },
        },
      },
    ]),
    quarantineSink: quarantineDouble(),
    credentialHandleForPage: async () => credential(),
    authority: authority(),
    providerConversationId: "C_CHANNEL",
    now: NOW,
  }), { kind: "unavailable", reason: "outcome_unknown" });

  assert.deepEqual(await listSlackProviderConversationMembers({
    transport: transportDouble([{
      kind: "response",
      status: 200,
      headers: {},
      body: { ok: true, members: ["U_A"] },
    }]),
    quarantineSink: quarantineDouble(),
    credentialHandleForPage: async () => credential(),
    authority: authority(),
    providerConversationId: "C_CHANNEL",
    now: NOW,
  }), { kind: "unavailable", reason: "outcome_unknown" });
});
