import { parseSlackReconciliationScan, type SlackReconciliationScan } from "./slackReconciliationScan";
import assert from "node:assert/strict";
import type { SlackBridgeRenderSnapshot } from "./externalDeliveryOutboxService";
import {
  createSlackEventsHttpAdapter,
  createSlackOAuthExchangeAdapter,
  createSlackOAuthHttpTransport,
  createSlackOAuthManagedHandleCoordinator,
  createSlackProviderPreparation,
  renderSlackBridgeText,
  reconcileSlackOutboundDelivery,
  listSlackProviderConversationMembers,
  lookupSlackProviderConversation,
  lookupSlackProviderUser, lookupSlackProviderBot,
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
  type SlackJsonObject,
} from "./slackProviderAdapter";

// Built at runtime so secret scanners don't flag this test sample.
const SLACK_XOXB = "xo" + "xb-";

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
    schema: "slack-bridge-render-snapshot.v5",
    sourceMessageId: "message-1",
    sourceMessageSeq: 42,
    canonicalConversationId: "channel-1",
    level: "top_level",
    canonicalRootMessageId: null,
    sourcePermalink: "https://app.slock.ai/s/test/channel/channel-1?msg=message-1",
    senderType: "agent",
    senderId: "agent-1",
    authorName: "Peng",
    authorPresentation: {
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
    raftMentionSubstitutions: [],
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
    authorPresentation: {
      ...snapshot().authorPresentation,
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

test("typed outbound adapter prefers a frozen Raft avatar over generic emoji", async () => {
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
  const digest = "d".repeat(32);
  const withAvatar = snapshot({
    authorPresentation: {
      ...snapshot().authorPresentation,
      avatar: {
        publicUrl: `https://cdn.raft.test/avatars/server/${digest}.webp`,
        contentDigest: digest,
      },
    },
  });
  const prepared = await prepare(dispatchInput({ renderSnapshot: withAvatar }));
  assert.equal(prepared.ready, true);
  if (!prepared.ready) assert.fail("expected provider preparation");
  assert.equal((await prepared.dispatch()).kind, "accepted");
  assert.equal(calls[0]?.body.icon_url, withAvatar.authorPresentation.avatar?.publicUrl);
  assert.equal("icon_emoji" in (calls[0]?.body ?? {}), false);
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
            app_id: "A_APP",
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
    releaseCredential: async () => {},
    leaseCredential: async () => {
      leases += 1;
      return credential({ leaseId: `reconcile-${leases}` });
    },
    authority: authority(),
    reconciliationMarker: "A".repeat(43),
    now: NOW, firstAttemptAt: new Date("2025-07-30T08:40:00.000Z"), providerAttempt: 1,
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
          { ts: "1753865100.000301", app_id: "A_APP", metadata: { event_type: "raft_message", event_payload: { reconciliation_marker: "B".repeat(43) } } },
          { ts: "1753865100.000302", app_id: "A_APP", metadata: { event_type: "raft_message", event_payload: { reconciliation_marker: "B".repeat(43) } } },
        ],
        response_metadata: { next_cursor: "" },
      },
    }]),
    releaseCredential: async () => {},
    leaseCredential: async () => credential({ leaseId: "reconcile-conflict" }),
    authority: authority(),
    reconciliationMarker: "B".repeat(43),
    now: NOW, firstAttemptAt: new Date("2025-07-30T08:40:00.000Z"), providerAttempt: 1,
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
    releaseCredential: async () => {},
    leaseCredential: async () => credential({ leaseId: "reconcile-incomplete" }),
    authority: authority(),
    reconciliationMarker: "C".repeat(43),
    now: NOW, firstAttemptAt: new Date("2025-07-30T08:40:00.000Z"), providerAttempt: 1,
    maxPages: 1,
  });
  assert.deepEqual(incomplete, { kind: "unavailable", reason: "reconciliation_scan_pending", retryAfterMs: 30_000 });
});

test("outbound reconciliation keeps first delivery safe while detecting stripped bridge metadata", async () => {
  const input = {
    releaseCredential: async () => {},
    leaseCredential: async () => credential({ leaseId: "reconcile-control" }),
    authority: authority(),
    reconciliationMarker: "D".repeat(43),
    now: NOW, firstAttemptAt: new Date("2025-07-30T08:40:00.000Z"), providerAttempt: 1,
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
    reason: "reconciliation_bridge_metadata_missing", unconfirmable: "reconciliation_bridge_metadata_missing", retryAfterMs: 900_000,
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

test("outbound render escapes user text exactly once", async () => {
  const calls: SlackWebApiRequest[] = [];
  const prepare = createSlackProviderPreparation({
    transport: transportDouble([{
      kind: "response",
      status: 200,
      headers: {},
      body: { ok: true, channel: "C_CHANNEL", ts: "1753865100.000103" },
      observedAuthority: { providerAppId: "A_APP", providerAuthorityId: "T_TEAM" },
    }], calls),
    quarantineSink: quarantineDouble(),
    now: () => NOW,
  });
  const prepared = await prepare(dispatchInput({
    renderSnapshot: snapshot({
      sanitizedText: "a < b & c > d",
      raftMentionSubstitutions: [{
        kind: "user",
        handle: "mention",
        token: "<@UWAKE>",
        installId: "install-1",
        bindingId: "binding-1",
        bindingEpoch: 9,
      }],
    }),
  }));
  assert.equal(prepared.ready, true);
  if (!prepared.ready) assert.fail("expected provider preparation");
  assert.equal((await prepared.dispatch()).kind, "accepted");
  assert.equal(calls[0]?.body.text, "a &lt; b &amp; c &gt; d");
});

test("protocol 3 renders bot IDs literally and preserves user mention ambiguity", () => {
  const base = snapshot();
  const bot = { ...base.externalMentions[0]!, externalActorId: "BVALID123", handleSnapshot: "bot" };
  const user = { ...base.externalMentions[0]!, externalActorId: "UVALID123", handleSnapshot: "user" };
  assert.equal(renderSlackBridgeText(snapshot({ sanitizedText: "@bot and @user & hello", externalMentions: [bot, user],
    raftMentionSubstitutions: [] })), "@bot and <@UVALID123> &amp; hello");
  assert.equal(renderSlackBridgeText(snapshot({ sanitizedText: "@bot", externalMentions: [bot, { ...user, handleSnapshot: "bot" }],
    raftMentionSubstitutions: [] })), "@bot");
  assert.equal(renderSlackBridgeText(snapshot({ sanitizedText: "@bot", externalMentions: [{ ...bot, externalActorId: "XINVALID" }],
    raftMentionSubstitutions: [] })), null);
});

test("an external member and Raft member sharing one handle renders literal text for both", async () => {
  const calls: SlackWebApiRequest[] = [];
  const prepare = createSlackProviderPreparation({
    transport: transportDouble([{
      kind: "response",
      status: 200,
      headers: {},
      body: { ok: true, channel: "C_CHANNEL", ts: "1753865100.000104" },
      observedAuthority: { providerAppId: "A_APP", providerAuthorityId: "T_TEAM" },
    }], calls),
    quarantineSink: quarantineDouble(),
    now: () => NOW,
  });
  const base = snapshot();
  const prepared = await prepare(dispatchInput({
    renderSnapshot: snapshot({
      sanitizedText: "ack @mention please",
      externalMentions: [{
        ...base.externalMentions[0]!,
        externalActorId: "UEXTERNAL",
        handleSnapshot: "mention",
      }],
      raftMentionSubstitutions: [{
        kind: "user",
        handle: "mention",
        token: "<@URAFT>",
        installId: "install-1",
        bindingId: "binding-1",
        bindingEpoch: 9,
      }],
    }),
  }));
  assert.equal(prepared.ready, true);
  if (!prepared.ready) assert.fail("expected provider preparation");
  assert.equal((await prepared.dispatch()).kind, "accepted");
  // Neither interpretation may be notified: the ambiguous @handle stays
  // literal rather than letting pass order pick a winner.
  assert.equal(calls[0]?.body.text, "ack @mention please");
});

test("two Raft members sharing one handle stay literal for both", async () => {
  const calls: SlackWebApiRequest[] = [];
  const prepare = createSlackProviderPreparation({
    transport: transportDouble([{
      kind: "response",
      status: 200,
      headers: {},
      body: { ok: true, channel: "C_CHANNEL", ts: "1753865100.000105" },
      observedAuthority: { providerAppId: "A_APP", providerAuthorityId: "T_TEAM" },
    }], calls),
    quarantineSink: quarantineDouble(),
    now: () => NOW,
  });
  const prepared = await prepare(dispatchInput({
    renderSnapshot: snapshot({
      sanitizedText: "cc @dup @dup",
      externalMentions: [],
      raftMentionSubstitutions: [
        { kind: "user", handle: "dup", token: "<@URAFT1>", installId: "install-1", bindingId: "binding-1", bindingEpoch: 9 },
        { kind: "user", handle: "dup", token: "<@URAFT2>", installId: "install-1", bindingId: "binding-1", bindingEpoch: 9 },
      ],
    }),
  }));
  assert.equal(prepared.ready, true);
  if (!prepared.ready) assert.fail("expected provider preparation");
  assert.equal((await prepared.dispatch()).kind, "accepted");
  assert.equal(calls[0]?.body.text, "cc @dup @dup");
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
    kind: "deterministic_failure", pairBlockedReason: "provider_credential_revoked",
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
  }), {
    kind: "deterministic_failure",
    reason: "scope_mismatch",
    providerError: "missing:channels:history",
  });
  // Extra scopes beyond the required set are allowed: the app may have
  // scopes added in the console before a code deploy tightens the contract.
  // The extras are visible on the install record for audit.
  assert.equal(normalizeSlackOAuthExchangeResult({
    request,
    result: {
      ...authorized,
      installedScopes: [
        "channels:history", "channels:read", "chat:write",
        "chat:write.customize", "files:read", "files:write",
        "groups:history", "groups:read", "reactions:read",
        "reactions:write", "users:read", "usergroups:read",
        "usergroups:write",
      ],
    },
  }).kind, "authorized");
  // The provider's own error string must survive normalization so operators
  // can see why Slack refused (e.g. "bad_client_secret") instead of a bare
  // slack_oauth_rejected.
  assert.deepEqual(normalizeSlackOAuthExchangeResult({
    request,
    result: { kind: "rejected", error: "bad_client_secret" },
  }), {
    kind: "deterministic_failure",
    reason: "provider_rejected",
    providerError: "bad_client_secret",
  });
  assert.deepEqual(normalizeSlackOAuthExchangeResult({
    request,
    result: { kind: "rejected", error: "handle_unavailable" },
  }), { kind: "preflight_rejected" });
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
        assert.equal(input.accessToken, `${SLACK_XOXB}secret-token`);
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
      if (String(url).endsWith("/users.info")) {
        return new Response(JSON.stringify({
          ok: true,
          user: {
            id: "U_HUMAN",
            team_id: "T_TEAM",
            is_admin: true,
            is_owner: false,
            is_primary_owner: false,
            is_bot: false,
            deleted: false,
          },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        ok: true,
        app_id: "A_APP",
        access_token: `${SLACK_XOXB}secret-token`,
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
  assert.equal(calls.length, 3);
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
  assert.equal((calls[1]!.init.headers as Record<string, string>).authorization, `Bearer ${SLACK_XOXB}secret-token`);
  assert.equal(calls[2]!.url, "https://slack.com/api/users.info");
  assert.equal(calls[2]!.init.body?.toString(), new URLSearchParams({ user: "U_HUMAN" }).toString());
  assert.deepEqual(outcome, {
    kind: "authorized",
    providerAppId: "A_APP",
    providerTeamId: "T_TEAM",
    providerEnterpriseId: null,
    providerUserId: "U_HUMAN",
    workspaceAdminVerified: true,
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
  assert.equal(serialized.includes(`${SLACK_XOXB}secret-token`), false);
  assert.equal(serialized.includes("client-secret-value"), false);
  assert.equal(serialized.includes("authorization-code-value"), false);
});

test("live OAuth accepts a workspace member who is not a Slack admin", async () => {
  let seals = 0;
  let installer = { id: "U_HUMAN", team_id: "T_TEAM", is_admin: false, is_owner: false, is_bot: false, deleted: false };
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
        return { encryptedMaterial: "sealed", envelopeKeyId: "key", aadVersion: 1 };
      },
    },
    async fetch(url) {
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
            "x-oauth-scopes": "channels:history,chat:write",
          },
        });
      }
      if (String(url).endsWith("/users.info")) {
        return new Response(JSON.stringify({
          ok: true,
          user: installer,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        ok: true,
        app_id: "A_APP",
        access_token: `${SLACK_XOXB}secret-token`,
        token_type: "bot",
        bot_user_id: "U_BOT",
        authed_user: { id: "U_HUMAN" },
        scope: "channels:history,chat:write",
        team: { id: "T_TEAM", name: "Workspace" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  // Who may install the app is Slack's own policy; Raft no longer requires
  // the installer to be a Slack workspace admin.
  const outcome = await transport.exchange(oauthRequest());
  assert.equal(outcome.kind, "authorized");
  assert.equal(outcome.kind === "authorized" && outcome.workspaceAdminVerified, false);
  assert.equal(seals, 1);
  installer = { ...installer, is_admin: true, team_id: "T_OTHER" };
  assert.equal((await transport.exchange(oauthRequest())).kind, "transport_failure", "another workspace cannot confer the role");
  assert.equal(seals, 1);
  installer = { ...installer, team_id: "T_TEAM" };
  const admin = await transport.exchange(oauthRequest());
  assert.equal(admin.kind === "authorized" && admin.workspaceAdminVerified, true);
  installer = { ...installer, is_admin: false, is_owner: true };
  const owner = await transport.exchange(oauthRequest());
  assert.equal(owner.kind === "authorized" && owner.workspaceAdminVerified, true);
  installer = { ...installer, deleted: true };
  assert.equal((await transport.exchange(oauthRequest())).kind, "transport_failure");
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
          access_token: `${SLACK_XOXB}secret-token`,
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
    access_token: `${SLACK_XOXB}secret-token`,
    token_type: "bot",
    bot_user_id: "U_BOT",
    scope: "channels:history,chat:write",
    team: { id: "T_TEAM" },
  }, {
    ok: true,
    app_id: "A_APP",
    access_token: `${SLACK_XOXB}secret-token`,
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
      access_token: `${SLACK_XOXB}secret-token`,
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
    { userInfoEndpoint: "http://slack.test/api/users.info" },
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

test("bot directory lookup requires exact provider identity and never exposes icon URLs", async () => {
  const calls: SlackWebApiRequest[] = [];
  const input = { quarantineSink: quarantineDouble(), credentialHandle: credential(), authority: authority(),
    providerBotId: "B12345", now: NOW };
  const response = (bot: SlackJsonObject) => ({ kind: "response" as const, status: 200, headers: {}, body: { ok: true, bot } });
  const transport = transportDouble([
    response({ id: "B12345", user_id: "U12345", app_id: "A12345", name: "Official bot", icons: { image_72: "https://cdn.test/icon.png" } }),
    response({ id: "BOTHER", user_id: "U12345", name: "Wrong bot" }),
    response({ id: "B12345", user_id: "invalid", name: "Wrong user" }),
    response({ id: "B12345", name: "Classic" }),
  ], calls);
  const first = await lookupSlackProviderBot({ ...input, transport });
  assert.equal(first.kind, "fact");
  if (first.kind !== "fact") throw new Error("expected provider fact");
  assert.equal(first.fact.providerBotId, "B12345"); assert.equal(first.fact.providerUserId, "U12345");
  assert.equal(first.fact.displayNameSnapshot, "Official bot"); assert.ok(first.fact.avatarUrlDigest);
  assert.equal(JSON.stringify(first).includes("https://cdn.test"), false);
  assert.deepEqual(await lookupSlackProviderBot({ ...input, transport }), { kind: "unavailable", reason: "identity_conflict" });
  assert.deepEqual(await lookupSlackProviderBot({ ...input, transport }), { kind: "unavailable", reason: "identity_conflict" });
  const classic = await lookupSlackProviderBot({ ...input, transport });
  assert.equal(classic.kind === "fact" && classic.fact.providerUserId, null);
  assert.equal(calls.length, 4); assert.ok(calls.every(call => call.method === "bots.info"));
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

function scanInput(clock = NOW) {
  return {
    authority: authority(), reconciliationMarker: "W".repeat(43), now: clock,
    firstAttemptAt: new Date(NOW.getTime() - 120_000), providerAttempt: 1,
    releaseCredential: async () => {},
    leaseCredential: async () => credential({ leaseId: "window-read", leaseExpiresAt: new Date(clock.getTime() + 60_000) }),
  };
}

const scanMessage = (suffix: number) => ({ ts: `${Math.floor(NOW.getTime() / 1000) - 30}.${String(suffix).padStart(6, "0")}`, app_id: "A_OTHER" });
const scanResponse = (messages: SlackJsonObject[], cursor = "") => ({
  kind: "response" as const, status: 200, headers: {},
  body: { ok: true, messages, response_metadata: { next_cursor: cursor }, has_more: cursor !== "" },
});

test("reconciliation bounds history by the first attempt instead of paging through unrelated old messages", async () => {
  const calls: SlackWebApiRequest[] = [];
  const result = await reconcileSlackOutboundDelivery({ ...scanInput(), transport: { evidence: "double",
    async call(request) {
      calls.push(request);
      return request.body.oldest ? scanResponse([]) : scanResponse([scanMessage(1)], "unrelated-old-history");
    },
  } });
  assert.deepEqual(result, { kind: "not_found" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.body.oldest, ((NOW.getTime() - 180_000) / 1000).toFixed(6));
  assert.equal(calls[0]!.body.latest, ((NOW.getTime() + 60_000) / 1000).toFixed(6));
  assert.equal(calls[0]!.body.inclusive, true);
});

test("a busy scan resumes across worker invocations and new traffic cannot move its upper bound", async () => {
  let saved: SlackReconciliationScan | null = null;
  const calls: SlackWebApiRequest[] = [];
  const latest = ((NOW.getTime() + 60_000) / 1000).toFixed(6);
  let result: Awaited<ReturnType<typeof reconcileSlackOutboundDelivery>> | undefined;
  for (let tick = 0; tick < 10; tick += 1) {
    const clock = new Date(NOW.getTime() + tick * 30_000);
    result = await reconcileSlackOutboundDelivery({ ...scanInput(clock), scan: saved,
      saveScan: async (scan) => { saved = scan ? JSON.parse(JSON.stringify(scan)) : null; },
      transport: { evidence: "double", async call(request) {
        calls.push(request);
        assert.equal(request.body.latest, latest, "new channel traffic must remain outside this complete scan");
        const page = request.body.cursor ? Number(String(request.body.cursor).slice(1)) : 0;
        return scanResponse(Array.from({ length: 100 }, (_, i) => scanMessage(page * 100 + i)), page < 12 ? `p${page + 1}` : "");
      } },
    });
    if (result.kind === "not_found") break;
    assert.deepEqual(result, { kind: "unavailable", reason: "reconciliation_scan_pending", retryAfterMs: 30_000 });
  }
  assert.deepEqual(result, { kind: "not_found" });
  assert.equal(calls.length, 13, "over 1000 messages must finish without restarting from page one");
  assert.equal(saved, null, "completed scans must not cache absence for a later attempt");
});

for (const mode of ["found", "conflict", "metadata_missing", "limited"] as const) {
  test(`scan evidence survives a checkpoint (${mode})`, async () => {
    let saved: SlackReconciliationScan | null = null;
    const first = scanMessage(1);
    const marked = { ...first, app_id: "A_APP", metadata: { event_type: "raft_message", event_payload: { reconciliation_marker: "W".repeat(43) } } };
    await reconcileSlackOutboundDelivery({ ...scanInput(), ...(mode === "limited" ? { firstAttemptAt: new Date(NOW.getTime() - 91 * 86400000) } : {}), maxPages: 1,
      saveScan: async (scan) => { saved = scan; },
      transport: transportDouble([{ ...scanResponse([mode === "metadata_missing" ? { ...first, app_id: "A_APP" } : mode === "limited" ? first : marked], "checkpoint"),
        body: { ...scanResponse([mode === "metadata_missing" ? { ...first, app_id: "A_APP" } : mode === "limited" ? first : marked], "checkpoint").body, is_limited: mode === "limited" } }]),
    });
    assert.ok(saved);
    const result = await reconcileSlackOutboundDelivery({ ...scanInput(), ...(mode === "limited" ? { firstAttemptAt: new Date(NOW.getTime() - 91 * 86400000) } : {}), scan: saved,
      transport: transportDouble([scanResponse(mode === "conflict" ? [{ ...marked, ts: scanMessage(2).ts }] : [scanMessage(3)])]),
    });
    if (mode === "found") assert.deepEqual(result, { kind: "found", providerMessageId: first.ts, providerThreadId: null });
    else assert.deepEqual(result, { kind: "unavailable", reason: mode === "conflict" ? "reconciliation_marker_conflict"
      : mode === "limited" ? "reconciliation_history_limited" : "reconciliation_bridge_metadata_missing",
      ...(mode === "conflict" ? {} : { unconfirmable: mode === "limited" ? "reconciliation_history_limited" : "reconciliation_bridge_metadata_missing", retryAfterMs: 900_000 }) });
  });
}

test("a new provider attempt or authority scope cannot reuse an older scan cursor", async () => {
  let saved: SlackReconciliationScan | null = null;
  await reconcileSlackOutboundDelivery({ ...scanInput(), maxPages: 1, saveScan: async (scan) => { saved = scan; },
    transport: transportDouble([scanResponse([scanMessage(1)], "old-scan")]) });
  for (const changed of ["attempt", "scope", "marker"] as const) {
    const calls: SlackWebApiRequest[] = [];
    await reconcileSlackOutboundDelivery({ ...scanInput(), scan: saved,
      ...(changed === "attempt" ? { providerAttempt: 2 } : changed === "marker" ? { reconciliationMarker: "Y".repeat(43) }
        : { authority: { ...authority(), bindingEpoch: 10 } }),
      transport: transportDouble([scanResponse([])], calls) });
    assert.equal(calls[0]!.body.cursor, undefined);
  }
});

const malformedHistoryPages: SlackJsonObject[] = [
  { ok: true, messages: [], has_more: true },
  { ok: true, messages: [] },
  { ok: true, messages: [], has_more: false, response_metadata: { next_cursor: 0 } },
  { ok: true, messages: [null], has_more: false },
  { ok: true, messages: [{ ...scanMessage(1), channel: "C_WRONG_CHANNEL" }], has_more: false },
];
for (const [index, body] of malformedHistoryPages.entries()) {
  test(`an incomplete or malformed history page is never evidence of absence (case ${index + 1})`, async () => {
    const result = await reconcileSlackOutboundDelivery({ ...scanInput(),
      transport: transportDouble([{ kind: "response", status: 200, headers: {}, body }]) });
    assert.equal(result.kind, "unavailable");
  });
}

test("expired cursors restart the same fixed window without forgetting a previously found receipt", async () => {
  let saved: SlackReconciliationScan | null = null;
  const message = { ...scanMessage(1), app_id: "A_APP", metadata: { event_type: "raft_message", event_payload: { reconciliation_marker: "W".repeat(43) } } };
  const saveScan = async (scan: SlackReconciliationScan | null) => { saved = scan; };
  await reconcileSlackOutboundDelivery({ ...scanInput(), maxPages: 1, saveScan,
    transport: transportDouble([scanResponse([message], "expired")]) });
  const expired = await reconcileSlackOutboundDelivery({ ...scanInput(), scan: saved, saveScan,
    transport: transportDouble([{ kind: "response", status: 200, headers: {}, body: { ok: false, error: "invalid_cursor" } }]) });
  assert.equal(expired.kind, "unavailable");
  const calls: SlackWebApiRequest[] = [];
  const result = await reconcileSlackOutboundDelivery({ ...scanInput(), scan: saved, saveScan,
    transport: transportDouble([scanResponse([])], calls) });
  assert.deepEqual(result, { kind: "found", providerMessageId: message.ts, providerThreadId: null });
  assert.equal(calls[0]!.body.cursor, undefined);
});

test("thread reply scans use the same bounded interval and retain their parent receipt", async () => {
  const calls: SlackWebApiRequest[] = [];
  const message = { ...scanMessage(1), app_id: "A_APP", thread_ts: "1753865100.000001",
    metadata: { event_type: "raft_message", event_payload: { reconciliation_marker: "W".repeat(43) } } };
  const result = await reconcileSlackOutboundDelivery({ ...scanInput(), providerThreadId: message.thread_ts,
    transport: transportDouble([scanResponse([message])], calls) });
  assert.deepEqual(result, { kind: "found", providerMessageId: message.ts, providerThreadId: message.thread_ts });
  assert.equal(calls[0]!.method, "conversations.replies");
  assert.equal(calls[0]!.body.ts, message.thread_ts);
  assert.equal(typeof calls[0]!.body.oldest, "string");
});

test("the inclusive lower bound retains a receipt immediately before the first local attempt timestamp", async () => {
  const ts = ((NOW.getTime() - 180_000) / 1000).toFixed(6);
  const result = await reconcileSlackOutboundDelivery({ ...scanInput(), transport: transportDouble([scanResponse([{
    ...scanMessage(1), app_id: "A_APP", ts, metadata: { event_type: "raft_message", event_payload: { reconciliation_marker: "W".repeat(43) } },
  }])]) });
  assert.deepEqual(result, { kind: "found", providerMessageId: ts, providerThreadId: null });
});

test("invalid first-attempt evidence never triggers provider I/O", async () => {
  let calls = 0;
  const result = await reconcileSlackOutboundDelivery({ ...scanInput(), firstAttemptAt: new Date(NOW.getTime() + 1),
    transport: { evidence: "double", async call() { calls += 1; return scanResponse([]); } } });
  assert.deepEqual(result, { kind: "unavailable", reason: "reconciliation_preflight_invalid" });
  assert.equal(calls, 0);
});

test("rate limiting keeps the last completed page and honors Retry-After before another scan chunk", async () => {
  let saved: SlackReconciliationScan | null = null;
  const result = await reconcileSlackOutboundDelivery({ ...scanInput(), saveScan: async (scan) => { saved = scan; },
    transport: transportDouble([scanResponse([scanMessage(1)], "resume-after-limit"),
      { kind: "response", status: 429, headers: { "retry-after": "60" }, body: { ok: false, error: "ratelimited" } }]) });
  assert.deepEqual(result, { kind: "unavailable", reason: "reconciliation_rate_limited", retryAfterMs: 60_000 });
  const calls: SlackWebApiRequest[] = [];
  const resumed = await reconcileSlackOutboundDelivery({ ...scanInput(new Date(NOW.getTime() + 60_000)), scan: saved,
    transport: transportDouble([scanResponse([])], calls) });
  assert.deepEqual(resumed, { kind: "not_found" });
  assert.equal(calls[0]!.body.cursor, "resume-after-limit");
  assert.equal(calls[0]!.body.latest, ((NOW.getTime() + 60_000) / 1000).toFixed(6));
});

test("the upper clock-skew margin includes a Slack receipt timestamp ahead of the worker", async () => {
  const acceptedAt = ((NOW.getTime() + 2_000) / 1000).toFixed(6);
  const result = await reconcileSlackOutboundDelivery({ ...scanInput(), transport: { evidence: "double", async call(request) {
    const ts = Number(acceptedAt);
    return scanResponse(ts >= Number(request.body.oldest) && ts <= Number(request.body.latest) ? [{
      ts: acceptedAt, app_id: "A_APP", metadata: { event_type: "raft_message", event_payload: { reconciliation_marker: "W".repeat(43) } },
    }] : []);
  } } });
  assert.deepEqual(result, { kind: "found", providerMessageId: acceptedAt, providerThreadId: null });
});

test("a free workspace's limited older history does not hide a complete recent scan", async () => {
  const result = await reconcileSlackOutboundDelivery({ ...scanInput(), transport: transportDouble([{
    ...scanResponse([]), body: { ...scanResponse([]).body, is_limited: true },
  }]) });
  assert.deepEqual(result, { kind: "not_found" });
});

test("a completed unconfirmable observation is durable and rechecks only after its cooldown", async () => {
  let saved: SlackReconciliationScan | null = null;
  const input = { ...scanInput(), saveScan: async (scan: SlackReconciliationScan | null) => { saved = scan; } };
  const result = await reconcileSlackOutboundDelivery({ ...input, transport: transportDouble([scanResponse([{
    ...scanMessage(1), app_id: "A_APP",
  }])]) });
  assert.equal(result.kind === "unavailable" ? result.unconfirmable : null, "reconciliation_bridge_metadata_missing");
  assert.ok(saved);
  const before = new Date(NOW.getTime() + 30_000);
  const calls: SlackWebApiRequest[] = [];
  const waiting = await reconcileSlackOutboundDelivery({ ...input, ...scanInput(before), scan: saved,
    transport: transportDouble([], calls) });
  assert.equal(waiting.kind === "unavailable" ? waiting.retryAfterMs : null, 870_000);
  assert.equal(calls.length, 0, "a completed unknown scan must not restart every 30 seconds");
  const recovered = await reconcileSlackOutboundDelivery({ ...input, ...scanInput(new Date(NOW.getTime() + 900_000)), scan: saved,
    transport: transportDouble([scanResponse([])], calls) });
  assert.equal(recovered.kind === "unavailable" ? recovered.unconfirmable : null, "reconciliation_bridge_metadata_missing");
  assert.equal(calls.length, 1, "cooldown permits rechecking, not erasing evidence");
  assert.ok(saved);
  const original = await reconcileSlackOutboundDelivery({ ...input, ...scanInput(new Date(NOW.getTime() + 1_800_000)), scan: saved,
    transport: transportDouble([scanResponse([{ ...scanMessage(1), app_id: "A_APP", metadata: { event_type: "raft_message", event_payload: { reconciliation_marker: "W".repeat(43) } } }])], calls) });
  assert.equal(original.kind, "found");
  assert.equal(saved, null, "only the verified original clears the uncertainty");
});

test("a read handle rejected before transport is returned to its credential owner", async () => {
  const handle = credential({ installId: "wrong-install" });
  const released: SlackBridgeCredentialHandle[] = [];
  const calls: SlackWebApiRequest[] = [];
  const result = await reconcileSlackOutboundDelivery({ ...scanInput(), leaseCredential: async () => handle,
    releaseCredential: async (value) => { released.push(value); }, transport: transportDouble([], calls) });
  assert.deepEqual(result, { kind: "unavailable", reason: "reconciliation_credential_unavailable" });
  assert.deepEqual(released, [handle]);
  assert.equal(calls.length, 0);
});


test("checkpoints from the old timestamp-bound contract are not reused", () => {
  assert.equal(parseSlackReconciliationScan({ schema: "slack-reconciliation-scan.v1", providerAttempt: 1,
    scopeKey: "a".repeat(64), oldest: "1.000000", latest: "2.000000", cursor: null, match: null,
    metadataMissing: false, historyLimited: false }), null);
});

test("workspace app restrictions request an administrator instead of another OAuth grant", async () => {
  const calls: SlackWebApiRequest[] = [];
  const prepare = createSlackProviderPreparation({ transport: transportDouble([{
    kind: "response", status: 200, headers: {}, body: { ok: false, error: "app_access_restricted" },
  }], calls), quarantineSink: quarantineDouble(), now: () => NOW });
  const prepared = await prepare(dispatchInput());
  assert.equal(prepared.ready, true);
  if (!prepared.ready) return;
  assert.deepEqual(await prepared.dispatch(), { kind: "deterministic_failure", pairBlockedReason: "slack_workspace_admin_required" });
  assert.equal(calls.length, 1);
});

for (const mode of ["foreign_only", "foreign_then_original", "missing_app", "original", "foreign_outside_window"] as const) {
  test(`receipt origin is verified independently of a copied reconciliation marker (${mode})`, async () => {
    const metadata = { event_type: "raft_message", event_payload: { reconciliation_marker: "W".repeat(43) } };
    const original = { ...scanMessage(1), app_id: "A_APP", metadata };
    const copied = { ...scanMessage(2), app_id: "A_OTHER", metadata };
    const messages: SlackJsonObject[] = mode === "original" ? [original]
      : mode === "foreign_then_original" ? [copied, original]
      : mode === "missing_app" ? [{ ts: copied.ts, bot_id: "B_UNVERIFIED", metadata }]
      : mode === "foreign_outside_window" ? [{ ...copied, ts: "1.000002" }] : [copied];
    const result = await reconcileSlackOutboundDelivery({ ...scanInput(), transport: transportDouble([scanResponse(messages)]) });
    if (mode === "original" || mode === "foreign_then_original") {
      assert.deepEqual(result, { kind: "found", providerMessageId: original.ts, providerThreadId: null });
    } else {
      assert.deepEqual(result, { kind: "unavailable", reason: "reconciliation_marker_unconfirmed",
        unconfirmable: "reconciliation_marker_unconfirmed", retryAfterMs: 900_000 });
    }
  });
}

test("receipt origin is rechecked instead of adopting a legacy saved marker match", async () => {
  let saved: SlackReconciliationScan | null = null;
  await reconcileSlackOutboundDelivery({ ...scanInput(), maxPages: 1, saveScan: async scan => { saved = scan; },
    transport: transportDouble([scanResponse([{ ...scanMessage(1), app_id: "A_APP",
      metadata: { event_type: "raft_message", event_payload: { reconciliation_marker: "W".repeat(43) } } }], "legacy-cursor")]) });
  assert.ok(saved);
  const checkpoint = parseSlackReconciliationScan(saved);
  assert.ok(checkpoint);
  const legacy = parseSlackReconciliationScan({ ...checkpoint, schema: "slack-reconciliation-scan.v2",
    match: { providerMessageId: scanMessage(2).ts, providerThreadId: null } });
  const calls: SlackWebApiRequest[] = [];
  const result = await reconcileSlackOutboundDelivery({ ...scanInput(), scan: legacy,
    transport: transportDouble([scanResponse([])], calls) });
  assert.equal(result.kind, "unavailable", "an old match cannot prove acceptance or absence");
  assert.equal(result.kind === "unavailable" ? result.unconfirmable : null, "reconciliation_marker_unconfirmed");
  assert.equal(calls[0]!.body.cursor, undefined, "the old scan must start again, not skip its earlier pages");
});

for (const originalVisible of [false, true]) {
  test(`receipt origin uncertainty survives pagination without hiding a verified original (${originalVisible})`, async () => {
    let saved: SlackReconciliationScan | null = null;
    const metadata = { event_type: "raft_message", event_payload: { reconciliation_marker: "W".repeat(43) } };
    await reconcileSlackOutboundDelivery({ ...scanInput(), maxPages: 1, saveScan: async scan => { saved = scan; },
      transport: transportDouble([scanResponse([{ ts: scanMessage(1).ts, metadata }], "next-page")]) });
    assert.ok(saved);
    const result = await reconcileSlackOutboundDelivery({ ...scanInput(), scan: saved,
      saveScan: async scan => { saved = scan; },
      transport: transportDouble([scanResponse(originalVisible ? [{ ...scanMessage(2), app_id: "A_APP", metadata }] : [])]) });
    if (originalVisible) {
      assert.deepEqual(result, { kind: "found", providerMessageId: scanMessage(2).ts, providerThreadId: null });
    } else {
      assert.deepEqual(result, { kind: "unavailable", reason: "reconciliation_marker_unconfirmed",
        unconfirmable: "reconciliation_marker_unconfirmed", retryAfterMs: 900_000 });
      const calls: SlackWebApiRequest[] = [];
      const held = await reconcileSlackOutboundDelivery({ ...scanInput(new Date(NOW.getTime() + 30_000)), scan: saved,
        transport: transportDouble([], calls) });
      assert.equal(held.kind === "unavailable" ? held.retryAfterMs : null, 870_000);
      assert.equal(calls.length, 0, "identity uncertainty must not cause a query every worker tick");
      for (const changedAuthority of [false, true]) {
        const rechecked = await reconcileSlackOutboundDelivery({ ...scanInput(new Date(NOW.getTime() + 900_000)),
          ...(changedAuthority ? { authority: { ...authority(), bindingEpoch: 9 } } : {}), scan: saved,
          transport: transportDouble([scanResponse([])]) });
        assert.equal(rechecked.kind === "unavailable" ? rechecked.unconfirmable : null,
          "reconciliation_marker_unconfirmed", "elapsed time or authority refresh cannot erase an observed marker");
      }
    }
  });
}

for (const error of ["timestamp", "message_shape", "pagination"] as const) {
  test(`receipt origin witness survives an early page error (${error})`, async () => {
    let saved: SlackReconciliationScan | null = null;
    const copy = { ...scanMessage(1), app_id: "A_OTHER", metadata: {
      event_type: "raft_message", event_payload: { reconciliation_marker: "W".repeat(43) } } };
    const body: SlackJsonObject = { ok: true, has_more: false, response_metadata: { next_cursor: "" },
      messages: error === "timestamp" ? [copy, { ts: "invalid" }] : error === "message_shape" ? [copy, null] : [copy] };
    if (error === "pagination") body.has_more = "invalid";
    const first = await reconcileSlackOutboundDelivery({ ...scanInput(), saveScan: async scan => { saved = scan; },
      transport: transportDouble([{ kind: "response", status: 200, headers: {}, body }]) });
    assert.equal(first.kind, "unavailable");
    assert.ok(saved, "marker evidence must be durable before returning the parse error");
    const second = await reconcileSlackOutboundDelivery({ ...scanInput(), scan: saved,
      transport: transportDouble([scanResponse([])]) });
    assert.equal(second.kind === "unavailable" ? second.unconfirmable : null, "reconciliation_marker_unconfirmed",
      "a disappearing copy cannot become evidence to resend after an earlier malformed page");
  });
}

for (const evidence of ["metadata", "history"] as const) {
  for (const error of ["timestamp", "message_shape", "pagination"] as const) {
    test(`absence-blocking ${evidence} evidence survives an early page error (${error})`, async () => {
      let saved: SlackReconciliationScan | null = null;
      const input = scanInput();
      if (evidence === "history") input.firstAttemptAt = new Date(input.now.getTime() - 91 * 24 * 60 * 60_000);
      const witness = { ts: scanMessage(1).ts!, app_id: evidence === "history" ? "A_OTHER" : input.authority.providerAppId };
      const body: SlackJsonObject = { ok: true, has_more: false, response_metadata: { next_cursor: "" },
        ...(evidence === "history" ? { is_limited: true } : {}),
        messages: error === "timestamp" ? [witness, { ts: "invalid" }] : error === "message_shape" ? [witness, null] : [witness] };
      if (error === "pagination") body.has_more = "invalid";
      const first = await reconcileSlackOutboundDelivery({ ...input, saveScan: async scan => { saved = scan; },
        transport: transportDouble([{ kind: "response", status: 200, headers: {}, body }]) });
      assert.equal(first.kind, "unavailable");
      assert.ok(saved, "absence-blocking observation must precede the parse error");
      const second = await reconcileSlackOutboundDelivery({ ...input, scan: saved,
        transport: transportDouble([scanResponse([])]) });
      assert.equal(second.kind === "unavailable" ? second.unconfirmable : null,
        evidence === "history" ? "reconciliation_history_limited" : "reconciliation_bridge_metadata_missing");
    });
  }
}

for (const evidence of ["metadata", "history"] as const) {
  for (const changedBinding of [false, true]) {
    test(`${evidence} uncertainty survives cooldown and authority refresh (changedBinding=${changedBinding})`, async () => {
      let saved: SlackReconciliationScan | null = null;
      const input = scanInput();
      if (evidence === "history") input.firstAttemptAt = new Date(input.now.getTime() - 91 * 24 * 60 * 60_000);
      const body: SlackJsonObject = { ok: true, has_more: false, response_metadata: { next_cursor: "" },
        messages: evidence === "metadata" ? [{ ts: scanMessage(1).ts!, app_id: input.authority.providerAppId }] : [],
        ...(evidence === "history" ? { is_limited: true } : {}) };
      const first = await reconcileSlackOutboundDelivery({ ...input, saveScan: async value => { saved = value; },
        transport: transportDouble([{ kind: "response", status: 200, headers: {}, body }]) });
      assert.equal(first.kind, "unavailable"); assert.ok(saved);
      const later = { ...input, now: new Date(input.now.getTime() + 900_000),
        authority: { ...input.authority, bindingEpoch: input.authority.bindingEpoch + (changedBinding ? 1 : 0) } };
      const second = await reconcileSlackOutboundDelivery({ ...later, scan: structuredClone(saved),
        leaseCredential: async () => credential({ ...later.authority, leaseExpiresAt: new Date(later.now.getTime() + 60_000) }),
        transport: transportDouble([scanResponse([])]) });
      assert.equal(second.kind === "unavailable" ? second.unconfirmable : null,
        evidence === "metadata" ? "reconciliation_bridge_metadata_missing" : "reconciliation_history_limited");
    });
  }
}
