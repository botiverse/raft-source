import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  agentApiSenderMentionDeliveryRowSchema,
  agentApiContract,
  agentApiIntegrationListResponseSchema,
  agentApiIntegrationMarketplaceResponseSchema,
  agentApiIntegrationAppStatusResponseSchema,
  agentApiIntegrationAppPrepareBodySchema,
  agentApiIntegrationAppTransferOwnerResponseSchema,
  agentApiSendBodySchema,
  agentApiSendResponseSchema,
  agentApiSendV2BodySchema,
  agentApiTaskCreateBodySchema,
  agentApiTaskEnvelopeSchema,
  agentApiAssistantSendAsOwnerBodySchema,
  agentApiTaskResourceReceiptBodySchema,
  buildAgentApiRouteManifest,
  computeAgentApiManifestVersion,
  getAgentApiResponseKind,
  parseAgentApiAppSourceAckReject,
  parseAgentApiResponse,
  type AgentApiRouteKey,
} from "./agentApiContract";
import { AGENT_API_MANIFEST_VERSION, AGENT_API_ROUTE_MANIFEST } from "./generated/agentApiRoutes";
import { AGENT_API_ROUTE_META, getAgentApiRetryPolicy, toAgentApiToolAnnotations } from "./agentApiRouteMeta";
import { AGENT_API_DESCRIPTION_SCHEMA, buildAgentApiDescription } from "./agentApiDescription";
import type { CoreAgentApiRouteKey } from "./agentApiContract";
import { firstPartyAppAgentApiSamples } from "./apps/agentApiSamples";

test("agent-api v1 remains passthrough while v2 validates typed mention identity", () => {
  const mention = {
    type: "agent" as const,
    id: "11111111-1111-4111-8111-111111111111",
    name: "same_handle",
  };
  assert.deepEqual(agentApiSendBodySchema.parse({
    target: "#proj-message",
    content: "hello @same_handle",
    mentions: [mention],
  }).mentions, [mention]);
  assert.deepEqual(agentApiSendV2BodySchema.parse({
    target: "#proj-message",
    content: "hello @same_handle",
    mentions: [mention],
  }).mentions, [mention]);
  assert.throws(
    () => agentApiSendV2BodySchema.parse({
      target: "#proj-message",
      content: "hello @same_handle",
      mentions: [{ ...mention, id: "not-an-actor-id" }],
    }),
    { name: "ZodError" },
  );
});

test("integration discovery defaults new official metadata closed for older servers", () => {
  const service = {
    id: "client-1",
    clientId: "drive9",
    name: "Drive9",
    description: null,
    homepageUrl: null,
    returnUrl: null,
    agentManifestUrl: null,
    createdAt: "2026-06-27T02:55:01.000Z",
    updatedAt: "2026-06-27T02:55:01.000Z",
  };
  const list = agentApiIntegrationListResponseSchema.parse({ services: [service], activeLogins: [] });
  assert.equal(list.services[0]?.official, false);
  assert.equal(list.services[0]?.purpose, "");

  const marketplace = agentApiIntegrationMarketplaceResponseSchema.parse({
    surface: "public_marketplace",
    metadataTrust: "untrusted_app_supplied",
    query: null,
    limit: 10,
    apps: [{
      ...service,
      category: "Storage",
      dataAccessSummary: null,
      allowedScopes: [],
      logoUrl: null,
      installedOnServer: false,
      agentManifestUrlSource: null,
    }],
  });
  assert.equal(marketplace.apps[0]?.official, false);
  assert.equal(marketplace.apps[0]?.purpose, "");
});

test("agent-api send contract supports effect-free idempotency reconciliation", () => {
  assert.deepEqual(agentApiSendV2BodySchema.parse({
    target: "#proj-message",
    idempotencyKey: "send-identity",
    reconcileOnly: true,
  }), {
    target: "#proj-message",
    idempotencyKey: "send-identity",
    reconcileOnly: true,
  });
  assert.deepEqual(agentApiSendResponseSchema.parse({
    ok: true,
    state: "not_found",
    reconciliation: true,
  }), {
    ok: true,
    state: "not_found",
    reconciliation: true,
  });
  assert.deepEqual(agentApiSendResponseSchema.parse({
    ok: true,
    state: "committed",
    messageId: "message-1",
    messageSeq: 42,
    reconciliation: true,
    receiptComplete: false,
  }), {
    ok: true,
    state: "committed",
    messageId: "message-1",
    messageSeq: 42,
    reconciliation: true,
    receiptComplete: false,
  });
});

test("generated agent-api route manifest is fresh", () => {
  assert.deepEqual(AGENT_API_ROUTE_MANIFEST, buildAgentApiRouteManifest());
  assert.equal(AGENT_API_MANIFEST_VERSION, computeAgentApiManifestVersion(buildAgentApiRouteManifest()));
  assert.match(AGENT_API_MANIFEST_VERSION, /^[0-9a-f]{16}$/);
});

test("checked-in language-neutral agent-api description is fresh and complete", () => {
  const checkedIn = JSON.parse(readFileSync(resolve(import.meta.dirname, "../agent-api/agent-api.v1.json"), "utf8")) as unknown;
  const built = buildAgentApiDescription();
  assert.deepEqual(checkedIn, JSON.parse(JSON.stringify(built)));
  assert.equal(built.schema, AGENT_API_DESCRIPTION_SCHEMA);
  assert.equal(built.manifestVersion, AGENT_API_MANIFEST_VERSION);
  assert.deepEqual(built.routes.map((route) => route.key), AGENT_API_ROUTE_MANIFEST.map((route) => route.key));
  for (const route of built.routes) {
    const contract = agentApiContract[route.key];
    assert.equal(route.request.body !== null, "body" in contract.request && Boolean(contract.request.body), `${route.key} body schema presence`);
    assert.equal(route.response.body !== null, "body" in contract.response && Boolean(contract.response.body), `${route.key} response schema presence`);
    if (route.request.body) {
      const body = route.request.body as { type?: unknown; anyOf?: unknown; oneOf?: unknown };
      assert.ok(body.type === "object" || Array.isArray(body.anyOf) || Array.isArray(body.oneOf), `${route.key} body schema is an object or union schema`);
    }
  }
});

test("agent-api manifest carries operating metadata that is not inferred from the HTTP method", () => {
  for (const entry of AGENT_API_ROUTE_MANIFEST) {
    assert.deepEqual(
      { sideEffect: entry.sideEffect, idempotency: entry.idempotency, destructive: entry.destructive, audience: entry.audience },
      AGENT_API_ROUTE_META[entry.key],
      `${entry.key} operating metadata`,
    );
  }
  // GET /events consumes inbox rows under the default ack mode.
  assert.equal(AGENT_API_ROUTE_META.events.sideEffect, "destructive_read");
  assert.equal(getAgentApiRetryPolicy(AGENT_API_ROUTE_META.events), "single_attempt");
  // POST /resolve-channel changes nothing.
  assert.equal(AGENT_API_ROUTE_META.resolveChannel.sideEffect, "read");
  assert.equal(getAgentApiRetryPolicy(AGENT_API_ROUTE_META.resolveChannel), "retry");
  // Keyed writes retry only with a key; unkeyed writes never retry.
  assert.equal(getAgentApiRetryPolicy(AGENT_API_ROUTE_META.messageSend), "retry_when_keyed");
  assert.equal(getAgentApiRetryPolicy(AGENT_API_ROUTE_META.taskClaim), "single_attempt");
  // MCP destructiveHint: additive writes are not destructive; removals, archives, rotations, and overwrites are.
  assert.deepEqual(toAgentApiToolAnnotations(AGENT_API_ROUTE_META.channelJoin), {
    readOnlyHint: false, destructiveHint: false, idempotentHint: true,
  });
  for (const key of ["messageSend", "messageReactionAdd", "taskCreate", "taskClaim", "channelJoin", "channelMute"] as const) {
    assert.equal(AGENT_API_ROUTE_META[key].destructive, false, `${key} is an additive write`);
  }
  for (const key of ["taskDelete", "channelArchive", "channelLeave", "integrationAppRotateSecret", "integrationAppTransferOwner", "reminderCancel", "pushWebhookDelete", "taskUpdateStatus", "profileUpdate"] as const) {
    assert.equal(AGENT_API_ROUTE_META[key].destructive, true, `${key} removes or overwrites shared state`);
  }
  assert.equal(AGENT_API_ROUTE_META.events.destructive, true);
  const destructiveCount = Object.values(AGENT_API_ROUTE_META).filter((meta) => meta.destructive).length;
  assert.ok(destructiveCount < Object.keys(AGENT_API_ROUTE_META).length / 2, "destructive must stay the minority signal");
  // External Agents get a typed refusal on managed-only routes.
  assert.equal(AGENT_API_ROUTE_META.reminderCreate.audience, "managed");
});

test("app-source ACK reject parser accepts only closed Server terminal responses", () => {
  assert.deepEqual(
    parseAgentApiAppSourceAckReject(409, {
      error: "Source revision is stale; refresh Inbox and retry",
      code: "stale_source_revision",
      latestFiredSourceVersion: 10,
    }),
    {
      error: "Source revision is stale; refresh Inbox and retry",
      code: "stale_source_revision",
      latestFiredSourceVersion: 10,
    },
  );
  assert.equal(
    parseAgentApiAppSourceAckReject(409, {
      error: "edge rewrote the response",
      code: "unknown_app_source_ack_code",
    }),
    null,
  );
  assert.equal(
    parseAgentApiAppSourceAckReject(400, {
      error: "Source revision is stale; refresh Inbox and retry",
      code: "stale_source_revision",
    }),
    null,
  );
  assert.equal(parseAgentApiAppSourceAckReject(409, "Source revision is stale"), null);
});

test("integration app prepare register can omit client key", () => {
  assert.deepEqual(agentApiIntegrationAppPrepareBodySchema.parse({
    mode: "register",
    target: " #proj-auth ",
    name: " Generated App ",
    returnUrl: " https://generated.example/auth/raft/callback ",
  }), {
    mode: "register",
    target: "#proj-auth",
    name: "Generated App",
    returnUrl: "https://generated.example/auth/raft/callback",
  });
});

test("integration app prepare update requires client key", () => {
  assert.deepEqual(agentApiIntegrationAppPrepareBodySchema.parse({
    mode: "update",
    target: " #proj-auth ",
    clientKey: " demo-app ",
    name: " Demo App ",
  }), {
    mode: "update",
    target: "#proj-auth",
    clientKey: "demo-app",
    name: "Demo App",
  });

  assert.throws(
    () => agentApiIntegrationAppPrepareBodySchema.parse({
      mode: "update",
      target: "#proj-auth",
    }),
    { name: "ZodError" },
  );
});

test("integration login contract preserves typed Marketplace install guidance", () => {
  const parsed = parseAgentApiResponse("integrationLogin", {
    status: "install_required",
    nextAction: "install_from_marketplace",
    service: {
      id: "client-1",
      clientId: "me-build",
      appType: "third_party_global",
      official: false,
      purpose: "",
      name: "Me Build",
      description: null,
      homepageUrl: "https://me.build",
      returnUrl: "https://me.build/callback",
      agentManifestUrl: null,
      createdAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:00.000Z",
    },
    scopes: ["openid"],
    installation: {
      serverSlug: "botiverse",
      serverName: "Botiverse",
      marketplaceUrl: "https://raft.build/s/botiverse/settings/applications?marketplace_app=client-1",
      target: null,
      actionCardMessageId: null,
    },
  });
  assert.equal(parsed.status, "install_required");
  assert.equal(parsed.nextAction, "install_from_marketplace");
  assert.equal(parsed.installation?.serverName, "Botiverse");
});

test("integration app status strips secret-shaped and internal fields at the response contract boundary", () => {
  const parsed = agentApiIntegrationAppStatusResponseSchema.parse({
    app: {
      state: "committed",
      card: null,
      name: "Demo",
      clientKey: "demo",
      createdAt: "2026-07-21T00:00:00.000Z",
      callbackUrl: null,
      scopes: [],
      category: "Other",
      recoveryCommand: "raft integration app rotate-secret --client demo --output <new-private-path>",
      clientSecret: "raft_secret_must_never_cross",
      secretHash: "internal-hash",
      ownerAgentId: "internal-owner",
    },
    token: "internal-token",
  });
  assert.deepEqual(Object.keys(parsed), ["app"]);
  assert.equal("clientSecret" in parsed.app, false);
  assert.equal("secretHash" in parsed.app, false);
  assert.equal("ownerAgentId" in parsed.app, false);
});

test("integration app transfer response requires an outcome and bindable audit event", () => {
  const parsed = agentApiIntegrationAppTransferOwnerResponseSchema.parse({
    clientId: "client-1",
    clientKey: "demo-app",
    clientName: "Demo App",
    ownerAgentId: "agent-2",
    ownerAgentName: "box",
    ownershipOutcome: "already_owner",
    auditEventId: "11111111-1111-4111-8111-111111111112",
  });
  assert.equal(parsed.ownershipOutcome, "already_owner");
  assert.equal(parsed.auditEventId, "11111111-1111-4111-8111-111111111112");

  assert.throws(
    () => agentApiIntegrationAppTransferOwnerResponseSchema.parse({
      clientId: "client-1",
      clientKey: "demo-app",
      clientName: "Demo App",
      ownerAgentId: "agent-2",
      ownerAgentName: "box",
      ownershipOutcome: "unknown",
      auditEventId: "not-an-audit-id",
    }),
    { name: "ZodError" },
  );
});

test("task-create contract accepts only canonical @handle assignees", () => {
  assert.deepEqual(agentApiTaskCreateBodySchema.parse({
    channel: " #proj-runtime ",
    tasks: [{ title: " Atomic dispatch " }],
    assignee: " @ApplePI ",
  }), {
    channel: "#proj-runtime",
    tasks: [{ title: "Atomic dispatch" }],
    assignee: "@ApplePI",
  });

  for (const assignee of ["ApplePI", "@", "   "]) {
    assert.throws(
      () => agentApiTaskCreateBodySchema.parse({
        channel: "#proj-runtime",
        tasks: [{ title: "Atomic dispatch" }],
        assignee,
      }),
      { name: "ZodError" },
    );
  }
});

test("assistant send-as-owner takes a channelId or a dmWith handle (the Server enforces exactly one)", () => {
  assert.deepEqual(agentApiAssistantSendAsOwnerBodySchema.parse({ dmWith: " @alice~human ", content: "hi" }), { dmWith: "@alice~human", content: "hi" });
  const channelId = "55555555-5555-4555-8555-555555555555";
  assert.deepEqual(agentApiAssistantSendAsOwnerBodySchema.parse({ channelId, content: "hi" }), { channelId, content: "hi" });
  assert.throws(() => agentApiAssistantSendAsOwnerBodySchema.parse({ dmWith: "   ", content: "hi" }), { name: "ZodError" });
  assert.throws(() => agentApiAssistantSendAsOwnerBodySchema.parse({ dmWith: "@alice" }), { name: "ZodError" });
});

test("task-create response requires authoritative persisted state, including omitted-assignee nulls", () => {
  const unassigned = {
    tasks: [{
      taskNumber: 1,
      messageId: "message-1",
      title: "Unassigned work",
      status: "todo",
      claimedByType: null,
      claimedById: null,
      claimedAt: null,
      requiresResourceReceipt: false,
    }],
  };
  assert.deepEqual(parseAgentApiResponse("taskCreate", unassigned), unassigned);

  for (const missingField of ["status", "claimedByType", "claimedById", "claimedAt", "requiresResourceReceipt"] as const) {
    const task = { ...unassigned.tasks[0] } as Record<string, unknown>;
    delete task[missingField];
    assert.throws(
      () => parseAgentApiResponse("taskCreate", { tasks: [task] }),
      { name: "ZodError" },
      `${missingField} must be required`,
    );
  }
});

test("task-list creator membership accepts only server membership states", () => {
  assert.equal(
    agentApiTaskEnvelopeSchema.parse({
      taskNumber: 1,
      createdByName: "departed_creator",
      createdByMembershipStatus: "removed",
    }).createdByMembershipStatus,
    "removed",
  );
  assert.throws(() => agentApiTaskEnvelopeSchema.parse({
    taskNumber: 1,
    createdByName: "departed_creator",
    createdByMembershipStatus: "departed",
  }));
});

test("task resource receipt requires every structured field to be nonblank", () => {
  const valid = {
    channel: "#proj-runtime",
    task_number: 17,
    receipt: {
      object: "staging bucket",
      purpose: "restore acceptance",
      teardown_owner: "@akko",
      security_privacy: "internal; no secrets",
      expiry: "2026-09-01T00:00:00.000Z",
      runbook: "runbooks/staging-bucket.md",
      tracking: "task #17",
    },
  };
  assert.deepEqual(agentApiTaskResourceReceiptBodySchema.parse(valid), valid);
  for (const field of [
    "object",
    "purpose",
    "teardown_owner",
    "security_privacy",
    "expiry",
    "runbook",
    "tracking",
  ] as const) {
    assert.throws(
      () => agentApiTaskResourceReceiptBodySchema.parse({
        ...valid,
        receipt: { ...valid.receipt, [field]: "   " },
      }),
      { name: "ZodError" },
      `${field} must reject whitespace-only values`,
    );
  }
});

test("agent-api manifest records request and response contract presence", () => {
  for (const entry of AGENT_API_ROUTE_MANIFEST) {
    const route = agentApiContract[entry.key];
    assert.deepEqual(entry.client, route.client, `${entry.key} client binding`);
    assert.equal(entry.request.params, "params" in route.request && Boolean(route.request.params), `${entry.key} params contract presence`);
    assert.equal(entry.request.query, "query" in route.request && Boolean(route.request.query), `${entry.key} query contract presence`);
    assert.equal(entry.request.body, "body" in route.request && Boolean(route.request.body), `${entry.key} body contract presence`);
    assert.equal(entry.response.kind, getAgentApiResponseKind(route.response), `${entry.key} response kind`);
    assert.equal(entry.response.body, "body" in route.response && Boolean(route.response.body), `${entry.key} response contract presence`);
  }
});

test("agent-api response contracts parse representative envelopes", () => {
  const coverage = { from: "2026-10-17T00:00:00Z", to: "2026-10-18T00:00:00Z", fetchedMessages: 0, exhausted: true, stopReason: "window_end", notRead: [] };
  const coreSamples: Record<CoreAgentApiRouteKey, unknown> = {
    raftbenchFindings: { revision: 1, findings: [], total: 0, nextCursor: null, coverage: { historyFrom: null, scannedThroughAt: null, note: "Synthetic coverage" } },
    raftbenchContext: { runId: "00000000-0000-4000-8000-000000000001", revision: 1, sourceText: "Synthetic source", sources: [], coverage, nextCursor: null },
    raftbenchSubmit: { runId: "00000000-0000-4000-8000-000000000001", revision: 1, status: "complete", receiptId: "00000000-0000-4000-8000-000000000002", coverage },
    feedbackLocatorIngest: {
      status: "accepted",
      receipt_id: "00000000-0000-4000-8000-000000000001",
      report_id: "00000000-0000-4000-8000-000000000002",
      duplicate: false,
    },
    feedbackLocatorList: { locators: [] },
    events: {
      events: [{
        seq: 1,
        content: "hello",
        createdAt: "2026-06-27T02:55:00.000Z",
        timestamp: "2026-06-27T02:55:01.000Z",
      }],
      last_seen_msgId: "msg-1",
      last_seen_seq: 1,
      reply_target: "channelId:chan-1",
      pending_notice_ids: [],
      wake_reason: null,
      has_more: false,
    },
    historyRead: {
      messages: [{
        seq: 1,
        content: "hello",
        createdAt: "2026-06-27T02:55:00.000Z",
        timestamp: "2026-06-27T02:55:01.000Z",
      }],
      has_more: false,
      has_older: false,
      has_newer: false,
      last_read_seq: 1,
    },
    knowledgeGet: {
      ok: true,
      docId: "doc-1",
      topicOrPath: "index",
      docVersion: "v1",
      docState: "published",
      contentType: "text/markdown",
      content: "# Index",
    },
    contextSearch: { ok: true, runtime: "claude", model: null, entryCount: 3, answer: { kind: "search", total: 0, matches: [] } },
    contextRead: { ok: true, runtime: "claude", model: null, entryCount: 3, answer: { kind: "read", found: false } },
    knowledgeSearch: {
      ok: true,
      query: "preview before merge",
      scope: "recipes",
      results: [{
        slug: "recipes/technique/preview-env",
        title: "Spin up a preview environment",
        firstScreen: "# Spin up a preview environment",
      }],
    },
    managedMcpTools: {
      catalogVersion: 1,
      tools: [{
        mcpServerId: "11111111-1111-4111-8111-111111111111",
        serverName: "Docs",
        toolName: "search",
        runtimeName: "mcp_11111111_search_deadbeef",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
        configVersion: 1,
        assignmentVersion: 1,
      }],
    },
    managedMcpCall: {
      content: [{ type: "text", text: "found" }],
      isError: false,
    },
    messageSend: {
      ok: true,
      state: "sent",
      messageId: "msg-1",
      messageSeq: 1,
      unresolvedMentionHandles: ["@wenyi"],
    },
    messageSendV2: {
      ok: true,
      state: "sent",
      messageId: "msg-v2",
      messageSeq: 2,
      unresolvedMentionHandles: [],
    },
    messageResolve: {
      message: {
        message_id: "msg-1",
        channel_type: "channel",
        channel_name: "proj-runtime",
        timestamp: "2026-06-27T02:55:01.000Z",
        sender_type: "human",
        sender_name: "xxchan",
        content: "hello",
      },
    },
    messageSearch: {
      results: [{
        id: "msg-1",
        seq: 1,
        channelId: "channel-1",
        threadId: null,
        parentMessageId: null,
        parentMessageContent: null,
        parentChannelId: "channel-1",
        parentChannelName: "proj-runtime",
        parentChannelType: "channel",
        parentChannelArchivedAt: null,
        senderId: "user-1",
        senderType: "human",
        senderName: "xxchan",
        channelName: "proj-runtime",
        channelType: "channel",
        channelArchivedAt: null,
        content: "hello",
        snippet: "hello",
        createdAt: "2026-06-27T02:55:01.000Z",
      }],
      hasMore: false,
    },
    messageReactionAdd: {
      message_id: "msg-1",
      channel_type: "channel",
      channel_name: "proj-runtime",
      timestamp: "2026-06-27T02:55:01.000Z",
      sender_type: "human",
      sender_name: "xxchan",
      content: "hello",
      reactions: [{ emoji: "👀", count: 1 }],
    },
    messageReactionRemove: {
      message_id: "msg-1",
      channel_type: "channel",
      channel_name: "proj-runtime",
      timestamp: "2026-06-27T02:55:01.000Z",
      sender_type: "human",
      sender_name: "xxchan",
      content: "hello",
      reactions: [],
    },
    messageCardUpdate: { ok: true, messageId: "msg-1", revision: 2, updatedAt: "2026-11-03T12:03:00.000Z", unnotifiedMentionHandles: [], notice: "Updating notifies no one. To tell someone, send a new message." },
    channelJoin: {
      ok: true,
    },
    channelLeave: {
      ok: true,
      attention: {
        state: "left",
        stillArrives: ["If #proj-runtime is public, followed threads still notify until you unfollow them."],
        threadBoundary: "Leaving a channel does not unfollow existing thread follows. Private channel/thread content still requires current parent access.",
        manageCommand: `raft thread unfollow --target "#proj-runtime:<thread-short-id>"`,
        manageApi: "POST /internal/agent-api/threads/unfollow",
      },
    },
    channelMute: {
      activityMuted: true,
      muteFromSeq: 42,
      attention: {
        state: "muted",
        unmuteCommand: "raft channel unmute #proj-runtime",
      },
    },
    channelUnmute: {
      activityMuted: false,
      muteFromSeq: null,
      attention: {
        state: "unmuted",
        muteCommand: "raft channel mute #proj-runtime",
      },
    },
    channelArchive: {
      id: "channel-1",
      name: "proj-runtime",
      type: "channel",
      archivedAt: "2026-07-11T00:00:00.000Z",
      archivedByUserId: null,
      archivedByAgentId: "agent-1",
    },
    channelUnarchive: {
      id: "channel-1",
      name: "proj-runtime",
      type: "channel",
      archivedAt: null,
      archivedByUserId: null,
      archivedByAgentId: null,
    },
    channelCreate: { id: "chan-2", name: "design", type: "private", description: "Design reviews" },
    channelUpdate: { id: "chan-2", name: "design", type: "private", description: "Design reviews" },
    channelMemberAdd: { ok: true, alreadyMember: false, channelId: "chan-2", member: { type: "agent", id: "agent-2", name: "Kirby" } },
    channelMemberRemove: { ok: true, wasMember: true, channelId: "chan-2", member: { type: "agent", id: "agent-2", name: "Kirby" } },
    channelMembers: {
      channel: { ref: "#proj-runtime", type: "channel" },
      agents: [{ name: "Stone", status: "active" }],
      humans: [{ name: "xxchan", description: null, role: "owner" }],
    },
    resolveChannel: {
      channelId: "channel-1",
    },
    threadFollow: { ok: true, following: true, changed: false },
    threadUnfollow: {
      ok: true,
    },
    threadList: {
      threads: [{
        target: "#proj-runtime:abcd1234",
        threadChannelId: "11111111-1111-4111-8111-111111111111",
        parentChannelRef: "#proj-runtime",
        parentMessageId: "22222222-2222-4222-8222-222222222222",
        parentMessageShortId: "abcd1234",
        followedAt: "2026-09-10T12:00:00.000Z",
        reason: "mentioned",
        doneAt: null,
      }],
    },
    assistantOwnerInbox: {
      owner: { userId: "33333333-3333-4333-8333-333333333333" },
      filter: "unread",
      items: [{
        kind: "thread",
        channelId: "44444444-4444-4444-8444-444444444444",
        channelName: "proj-runtime",
        channelType: "channel",
        parentChannelId: "55555555-5555-4555-8555-555555555555",
        parentMessageId: "22222222-2222-4222-8222-222222222222",
        unread: 2,
        hasMention: true,
        latestAt: "2026-09-10T12:00:00.000Z",
        latestSenderName: "richard",
        latestPreview: "ship it",
        firstUnreadMessageId: "66666666-6666-4666-8666-666666666666",
      }],
      hasMore: false,
      nextOffset: null,
    },
    assistantOwnerMessages: {
      owner: { userId: "33333333-3333-4333-8333-333333333333" },
      channelId: "55555555-5555-4555-8555-555555555555",
      messages: [],
      hasMore: false,
      hasOlder: false,
      hasNewer: false,
    },
    assistantOwnerArtifact: { owner: { userId: "33333333-3333-4333-8333-333333333333" }, artifact: { id: "pt_abc12345", url: "https://app.raft.build/artifacts/pt_abc12345", title: "Plan", description: null, home: { kind: "conversation", conversation: { id: "55555555-5555-4555-8555-555555555555", type: "channel", target: "#design" } }, author: { type: "user", name: "ada" }, version: 1, latestVersion: 1, commentCount: 0, position: 3, createdAt: "2026-11-12T00:00:00.000Z", updatedAt: "2026-11-12T00:00:00.000Z" }, versions: [], files: [{ path: "index.html", kind: "html", sizeBytes: 12, entry: true }], file: { kind: "text", path: "index.html", entry: true, contentType: "text/html", sizeBytes: 12, content: "<h1>Plan</h1>", truncated: false }, comments: { items: [], olderCursor: null, newestPosition: 3 } },
    assistantOwnerArtifactPublish: { artifact: { id: "pt_abc12345", url: "https://app.raft.build/artifacts/pt_abc12345", version: 1, unchanged: false, homeConversationId: "55555555-5555-4555-8555-555555555555" } },
    assistantOwnerActivity: { owner: { userId: "33333333-3333-4333-8333-333333333333" }, items: [], hasMore: false, nextSince: null },
    assistantOwnerResolve: { id: "88888888-8888-4888-8888-888888888888", type: "human", name: "ada" },
    assistantCheckStateImport: { briefToday: "due" },
    assistantNotify: { outcome: "sent", shown: 1, more: 0, dropped: [] },
    assistantContactRules: { rules: [{ id: "99999999-9999-4999-8999-999999999999", effect: "mute", subject: { kind: "dms" }, anytime: false, until: null, note: null, createdAt: "2026-10-21T00:00:00.000Z", line: "99999999 · mute your DMs" }], settings: { quiet: { from: "22:00", to: "08:00" }, brief: { at: "08:00" }, timezone: "UTC" }, lines: { quiet: "quiet 22:00-08:00 UTC", brief: "morning brief at 08:00 UTC", defaults: "By default…" } },
    assistantContactRuleAdd: { rule: { id: "99999999-9999-4999-8999-999999999999", effect: "mute", subject: { kind: "dms" }, anytime: false, until: null, note: null, createdAt: "2026-10-21T00:00:00.000Z", line: "99999999 · mute your DMs" }, confirmation: "I won't tell you about your DMs anymore.", updated: false },
    assistantContactRuleRemove: { confirmation: "Removed: mute your DMs." },
    assistantContactSettings: { settings: { quiet: null }, confirmation: "Quiet hours are off (UTC)." },
    assistantOwnerSettings: { settings: { theme: "space", storedTheme: "space", themeDecor: true, themeDecorShown: true, displayLanguage: "en", preferredTimezone: "Europe/Berlin" } },
    assistantOwnerSettingsUpdate: { settings: { theme: "space", storedTheme: "space", themeDecor: true, themeDecorShown: true, displayLanguage: "en", preferredTimezone: "Europe/Berlin" }, changed: ["preferredTimezone"] },
    assistantContactRulesImport: { imported: 1, updated: 0, skipped: 0, legacy: 0 },
    assistantToldRecord: { recorded: 1, skipped: 0 },
    assistantToldList: { items: [], hasMore: false, nextCursor: null },
    assistantSendAsOwner: { messageId: "77777777-7777-4777-8777-777777777777", channelId: "55555555-5555-4555-8555-555555555555" },
    assistantForwardAsOwner: { results: [{ to: "#design", channelId: "55555555-5555-4555-8555-555555555555", status: "sent", messageId: "77777777-7777-4777-8777-777777777777" }, { to: "#ops", channelId: "66666666-6666-4666-8666-666666666666", status: "failed", code: "retracted_by_owner", error: "Your owner retracted the message this forward sent here; do not send it again unless your owner asks you to." }] },
    assistantSearchForwardTargets: { targets: [{ label: "#design", to: "#design" }], omitted: "assistant_reads_dms_off", omittedReason: "Your owner has not let you read their DMs, so people, agents and DMs (and threads in DMs) are left out of these results." },
    inboxList: {
      view: "unread",
      items: [{
        target: "dm:@richard",
        kind: "dm",
        unread: 3,
        mentions: 0,
        lastReadSeq: 1199,
        activitySeq: 1203,
        latestSenderName: "richard",
        latestAt: "2026-09-10T12:00:00.000Z",
      }],
      hasMore: false,
      nextBeforeSeq: null,
      totals: { conversations: 1, dms: 1, mentions: 0 },
    },
    inboxRead: { target: "app:stamp/pr-13754", kind: "app", entries: [{ id: "77777777-7777-4777-8777-777777777777", senderType: "third_party_app", senderName: "Stamp", content: "checks failed", mentioned: false }], unreadBefore: 3, remaining: 2, remainingCapped: false, consumed: false, nextCursor: null, app: { key: "stamp", name: "Stamp" }, related: { target: "#proj-workspace:#232" } },
    inboxDismiss: { dismissed: 2, conversations: 1, appItems: 1, skippedNeedsAck: 1, earliestActivityAt: "2026-11-01T00:00:00.000Z", remaining: 0 },
    serverUpdate: {
      id: "server-1",
      name: "Renamed Server",
      hideHumansFromMembers: true,
      avatarUrl: null,
    },
    serverLabs: { serverId: "server-1", accessEnabled: true, version: 3, canManageAccess: false, canManageEnrollments: true, labs: [{ labKey: "agent-panel-v2", name: "Agent panel v2", description: "The new Agent panel", state: "open", enrolled: false, effective: false, updatedAt: null }] },
    serverLabsAccess: { applied: true, auditEventId: "audit-1", serverId: "server-1", accessEnabled: true, version: 4, canManageAccess: false, canManageEnrollments: true, labs: [{ labKey: "agent-panel-v2", name: "Agent panel v2", description: "The new Agent panel", state: "open", enrolled: true, effective: true, updatedAt: "2026-10-11T09:30:00.000Z" }] },
    serverLabEnrollment: { applied: true, auditEventId: "audit-1", serverId: "server-1", accessEnabled: true, version: 4, canManageAccess: false, canManageEnrollments: true, labs: [{ labKey: "agent-panel-v2", name: "Agent panel v2", description: "The new Agent panel", state: "open", enrolled: true, effective: true, updatedAt: "2026-10-11T09:30:00.000Z" }] },
    agentContext: {
      agent: { id: "agent-1", name: "alice", displayName: "Alice", description: "Reviewer", runtime: "external", external: true },
      server: { id: "server-1", slug: "acme", name: "Acme" },
      credential: { capabilities: ["read", "send"] },
      prompt: { audience: "self-hosted-runner", text: "# Raft CLI operating guide" },
    },
    serverInfo: {
      runtimeContext: {
        agentId: "agent-1",
        runtime: "codex",
        model: "gpt-5-codex",
        reasoningEffort: "high",
        serverId: "server-1",
        workspacePath: null,
      },
      serverRole: "member",
      serverCapabilities: { canManageChannels: false },
      channels: [{ id: "channel-1", name: "proj-runtime", joined: true }],
      agents: [{ name: "HaoHao", status: "active", role: "admin" }],
      humans: [{ name: "xxchan", role: "owner" }],
    },
    userChannels: {
      user: { name: "HaoHao", status: "active", role: "admin" },
      kind: "agent",
      memberships: [{ id: "channel-1", name: "proj-runtime", joined: true }],
      uncheckedCount: 0,
      page: { total: 1, offset: 0, limit: 50 },
    },
    senderMentionDeliveries: {
      messageId: "11111111-1111-4111-8111-111111111111",
      deliveries: [{ targetHandle: "@Noel", outcome: "lost", reasonCategory: "quota" }],
    },
    mentionActionsPending: {
      pendingMentionActions: [{ resolutionId: "res-1", targetHandle: "@Noel" }],
      has_more: false,
    },
    mentionActionsExecute: {
      ok: true,
      action: "notify",
      results: [{ resolutionId: "res-1", status: "queued" }],
    },
    taskClaim: {
      results: [{ taskNumber: 1, messageId: "msg-1", success: true }],
    },
    taskList: {
      tasks: [{
        taskNumber: 1,
        status: "in_progress",
        title: "Ship typed surface",
        claimedByName: "Hao",
        createdByName: "xxchan",
        messageId: "msg-1",
      }],
    },
    taskCreate: {
      tasks: [{
        taskNumber: 2,
        messageId: "msg-2",
        title: "Add drift tests",
        status: "todo",
        claimedByType: "agent",
        claimedById: "agent-2",
        claimedAt: null,
        requiresResourceReceipt: false,
      }],
      assignmentReceipt: {
        messageId: "receipt-2",
        content: "📌 Assigned @Hao to task #2 \"Add drift tests\"",
        assignee: "@Hao",
        state: "assigned",
      },
    },
    taskUnclaim: {
      ok: true,
    },
    taskAssign: {
      ok: true,
      revision: 4,
      assignee: "@akko",
    },
    taskUpdateStatus: {
      ok: true,
    },
    taskResourceReceipt: {
      ok: true,
      taskNumber: 2,
      revision: 2,
      receipt: {
        object: "staging bucket",
        purpose: "verify resource receipt enforcement",
        teardown_owner: "@Hao",
        security_privacy: "internal; no secrets",
        expiry: "2026-09-01T00:00:00.000Z",
        runbook: "runbooks/staging-bucket.md",
        tracking: "task #2",
      },
      expiryFollowup: {
        id: "11111111-2222-4333-8444-555555555555",
        ownerAgentId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        owner: "@Hao",
        fireAt: "2026-09-01T00:00:00.000Z",
        msgId: "99999999-8888-4777-8666-555555555555",
        targetChannelId: "22222222-3333-4444-8555-666666666666",
      },
    },
    taskDelete: {
      ok: true,
    },
    taskConvert: {
      task: { taskNumber: 26, messageId: "11111111-2222-3333-4444-555555555555", title: "Ship the assignee picker", status: "todo", claimedByType: null, claimedById: null, claimedByName: null, claimedAt: null, requiresResourceReceipt: false },
    },
    taskAmend: {
      task: { taskNumber: 24, title: "Current title", description: "Current criteria", revision: 2 },
      event: {
        id: "11111111-1111-4111-8111-111111111111",
        seq: 2,
        eventType: "amended",
        actorType: "agent",
        actorName: "cross",
        payload: { revision: 2, changes: { description: { from: null, to: "Current criteria" } } },
        createdAt: "2026-08-05T00:00:00.000Z",
      },
    },
    taskHistory: {
      task: { taskNumber: 24, title: "Current title", description: "Current criteria", revision: 2 },
      events: [],
    },
    taskFollowing: { tasks: [{ taskRef: "#wg-raft-cli:#24", taskNumber: 24, title: "Current title", status: "todo", unread: 2, followedAt: "2026-08-05T00:00:00.000Z", reason: "authored" }] },
    taskView: {
      taskRef: "#wg-raft-cli:#24",
      task: { taskNumber: 24, status: "todo", title: "Current title", conversationAnchored: true },
      following: true,
      followReason: "authored",
      conversation: { exists: true, replyCount: 0 },
      sourceMessage: null,
      earlierDiscussion: null,
      recentMessages: [],
      hasOlder: false,
    },
    taskRead: { target: "#wg-raft-cli:#24", messages: [], has_more: false, has_older: false, has_newer: false },
    taskReply: { ok: true, state: "sent", messageId: "11111111-1111-4111-8111-111111111111", messageSeq: 3 },
    taskFollow: { ok: true, taskRef: "#wg-raft-cli:#24", following: true, changed: true },
    taskUnfollow: { ok: true, taskRef: "#wg-raft-cli:#24", following: false, changed: false },
    taskIdleNudge: { send: true, items: [{ ref: "#wg-raft-cli:#24", taskNumber: 24, channel: "#wg-raft-cli", title: "Current title", status: "todo", reason: "newly_assigned", why: "newly yours (assigned by @akko)" }], backlog: [], text: "[Raft task notice: 1 task is waiting on you.]" },
    migrationRetry: { migrationId: "11111111-1111-4111-8111-111111111111", supportRef: "mig_retry", targetMachineName: "studio-mac", note: "The source will stop you once you are idle, then move you." },
    reminderList: {
      reminders: [{
        reminderId: "reminder-1",
        ownerAgentId: "agent-1",
        title: "check CI",
        fireAt: "2026-06-27T03:55:00.000Z",
        firedAt: null,
        createdAt: "2026-06-27T02:55:00.000Z",
        status: "scheduled",
        msgRef: "#wg-raft-cli:abcd1234",
        msgPermalink: "https://raft.example/messages/abcd1234",
        recurrence: null,
      }],
    },
    reminderCreate: {
      reminder: {
        reminderId: "reminder-1",
        ownerAgentId: "agent-1",
        title: "check CI",
        fireAt: "2026-06-27T03:55:00.000Z",
        firedAt: null,
        createdAt: "2026-06-27T02:55:00.000Z",
        status: "scheduled",
        msgRef: "#wg-raft-cli:abcd1234",
        msgPermalink: "https://raft.example/messages/abcd1234",
        recurrence: { kind: "interval", description: "every 15 minutes" },
      },
      warning: "fireAt is in the near future",
    },
    reminderCancel: {
      reminder: {
        reminderId: "reminder-1",
        ownerAgentId: "agent-1",
        title: "check CI",
        fireAt: "2026-06-27T03:55:00.000Z",
        firedAt: null,
        createdAt: "2026-06-27T02:55:00.000Z",
        status: "canceled",
        msgRef: "#wg-raft-cli:abcd1234",
        msgPermalink: "https://raft.example/messages/abcd1234",
        recurrence: null,
      },
    },
    reminderSnooze: {
      reminder: {
        reminderId: "reminder-1",
        ownerAgentId: "agent-1",
        title: "check CI",
        fireAt: "2026-06-27T04:25:00.000Z",
        firedAt: "2026-06-27T03:55:00.000Z",
        createdAt: "2026-06-27T02:55:00.000Z",
        status: "scheduled",
        msgRef: "#wg-raft-cli:abcd1234",
        msgPermalink: "https://raft.example/messages/abcd1234",
        recurrence: null,
      },
    },
    reminderUpdate: {
      reminder: {
        reminderId: "reminder-1",
        ownerAgentId: "agent-1",
        title: "check staging",
        fireAt: "2026-06-27T03:55:00.000Z",
        firedAt: null,
        createdAt: "2026-06-27T02:55:00.000Z",
        status: "scheduled",
        msgRef: "#wg-raft-cli:abcd1234",
        msgPermalink: "https://raft.example/messages/abcd1234",
        recurrence: null,
      },
    },
    appSourceAck: {
      ok: true,
      itemId: "source:item:1",
      appId: "system.fixture",
      notificationClass: "due",
      sourceRef: { kind: "source", id: "source-1", revision: "7" },
      sourceEventId: "bbbbbbbb-1234-4123-8123-123456789abc",
      ackAttemptId: "aaaaaaaa-1234-4123-8123-123456789abc",
      replayed: false,
    },
    reminderLog: {
      events: [{
        eventId: "event-1",
        reminderId: "reminder-1",
        eventType: "scheduled",
        actorType: "agent",
        actorId: "agent-1",
        occurredAt: "2026-06-27T02:55:00.000Z",
        nextFireAt: "2026-06-27T03:55:00.000Z",
        metadata: { title: "check CI" },
      }],
    },
    appConfigGet: {
      appId: "system.cleaner",
      revision: 0,
      schema: {},
      defaults: {},
      overrides: {},
      effective: {},
    },
    appConfigPatch: {
      appId: "system.cleaner",
      revision: 1,
      schema: {},
      defaults: {},
      overrides: { enabled: false },
      effective: { enabled: false },
    },
    profileShow: {
      kind: "human",
      id: "user-1",
      isSelf: false,
      name: "xxchan",
      displayName: "xxchan",
      description: null,
      avatarUrl: null,
      email: null,
      role: "owner",
      joinedAt: "2026-06-27T02:55:00.000Z",
      membershipStatus: "active",
      createdAgents: [],
    },
    profileUpdate: {
      kind: "agent",
      id: "agent-1",
      isSelf: true,
      name: "HaoHao",
      displayName: "HaoHao",
      description: "Runtime agent",
      avatarUrl: null,
      status: "active",
      serverRole: "member",
      runtime: "claude",
      model: "sonnet",
      reasoningEffort: null,
      executionMode: null,
      computerId: null,
      computerName: null,
      computerHostname: null,
      daemonVersion: null,
      creator: null,
      createdAgents: [],
      createdAt: "2026-06-27T02:55:00.000Z",
      deletedAt: null,
    },
    profileAvatarUpdate: {
      kind: "agent",
      id: "agent-1",
      isSelf: true,
      name: "HaoHao",
      displayName: "HaoHao",
      description: "Runtime agent",
      avatarUrl: "https://cdn.example/avatar.png",
      status: "active",
      serverRole: "member",
      runtime: "claude",
      model: "sonnet",
      reasoningEffort: null,
      executionMode: null,
      computerId: null,
      computerName: null,
      computerHostname: null,
      daemonVersion: null,
      creator: null,
      createdAgents: [],
      createdAt: "2026-06-27T02:55:00.000Z",
      deletedAt: null,
    },
    integrationList: {
      services: [{
        id: "client-1",
        clientId: "drive9",
        appType: "third_party_global",
        name: "Drive9",
        description: null,
        homepageUrl: "https://drive9.example",
        returnUrl: "https://drive9.example/auth/raft/callback",
        agentManifestUrl: "https://drive9.example/.well-known/slock-agent-manifest.json",
        agentManifestUrlSource: "explicit",
        createdAt: "2026-06-27T02:55:01.000Z",
        updatedAt: "2026-06-27T02:55:01.000Z",
        official: true,
        purpose: "Publish and retrieve durable Raft artifacts.",
      }],
      activeLogins: [{
        id: "grant-1",
        serviceId: "client-1",
        clientId: "drive9",
        appType: "third_party_global",
        name: "Drive9",
        description: null,
        homepageUrl: "https://drive9.example",
        returnUrl: "https://drive9.example/auth/raft/callback",
        agentManifestUrl: "https://drive9.example/.well-known/slock-agent-manifest.json",
        agentManifestUrlSource: "explicit",
        scopes: ["openid", "profile"],
        createdAt: "2026-06-27T02:55:01.000Z",
      }],
    },
    integrationMarketplaceSearch: {
      surface: "public_marketplace",
      metadataTrust: "untrusted_app_supplied",
      query: "drive",
      limit: 10,
      apps: [{
        id: "client-1",
        clientId: "drive9",
        name: "Drive9",
        description: null,
        category: "Storage",
        dataAccessSummary: null,
        homepageUrl: "https://drive9.example",
        agentManifestUrl: "https://drive9.example/.well-known/raft-agent-manifest.json",
        agentManifestUrlSource: "well_known",
        allowedScopes: ["openid", "profile"],
        logoUrl: null,
        installedOnServer: false,
        updatedAt: "2026-06-27T02:55:01.000Z",
        official: false,
        purpose: "",
      }],
    },
    integrationToken: { access_token: "fixture.jwt.token", token_type: "Bearer", audience: "drive9", expires_in: 300, expires_at: "2026-10-05T00:05:00.000Z" },
    integrationLogin: {
      status: "logged_in",
      service: {
        id: "client-1",
        clientId: "drive9",
        appType: "third_party_global",
        official: false,
        purpose: "",
        name: "Drive9",
        description: null,
        homepageUrl: "https://drive9.example",
        returnUrl: "https://drive9.example/auth/raft/callback",
        agentManifestUrl: "https://drive9.example/.well-known/slock-agent-manifest.json",
        agentManifestUrlSource: "explicit",
        createdAt: "2026-06-27T02:55:01.000Z",
        updatedAt: "2026-06-27T02:55:01.000Z",
      },
      scopes: ["openid", "profile"],
      requestId: "request-1",
    },
    integrationAppPrepare: {
      status: "prepared",
      mode: "register",
      target: "#wg-raft-cli",
      actionCardMessageId: "msg-action-1",
      action: {
        type: "integration:register_app",
        name: "Drive9",
        clientKey: "drive9",
        returnUrl: "https://drive9.example/auth/raft/callback",
        scopes: ["openid", "profile"],
      },
    },
    integrationAppRotateSecret: {
      clientId: "client-uuid-1",
      clientKey: "drive9",
      clientName: "Drive9",
      clientSecret: "raft_secret_rotated",
    },
    integrationAppTransferOwner: {
      clientId: "client-uuid-1",
      clientKey: "drive9",
      clientName: "Drive9",
      ownerAgentId: "agent-2",
      ownerAgentName: "box",
      ownershipOutcome: "transferred",
      auditEventId: "11111111-1111-4111-8111-111111111112",
    },
    integrationAppUpdate: {
      clientId: "client-uuid-1",
      clientKey: "drive9",
      clientName: "Drive 9",
      updatedFields: ["name", "category"],
    },
    integrationAppManage: {
      action: "request_publish",
      clientId: "client-uuid-1",
      clientKey: "drive9",
      clientName: "Drive9",
      publishStatus: "publish_requested",
    },
    integrationAppLogoUpdate: {
      clientId: "client-uuid-1",
      clientKey: "drive9",
      clientName: "Drive9",
      logoUrl: "/api/integration-logos/client-uuid-1/hash.webp",
    },
    integrationAppList: { apps: [] },
    integrationAppStatus: {
      app: {
        state: "committed",
        card: null,
        name: "Drive9",
        clientKey: "drive9",
        createdAt: "2026-06-27T02:55:01.000Z",
        callbackUrl: "https://drive9.example/auth/raft/callback",
        scopes: ["openid", "profile"],
        category: "Developer Tools",
        recoveryCommand: "raft integration app rotate-secret --client drive9 --output <new-private-path>",
      },
    },
    actionPrepare: {
      messageId: "msg-action-1",
      metadata: { kind: "action-card", state: "prepared" },
    },
    actionWithdraw: {
      messageId: "msg-action-1",
      metadata: { kind: "action-card", state: "withdrawn" },
    },
    attachmentUpload: {
      id: "attachment-1",
      filename: "log.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
      thumbnailUrl: null,
    },
    attachmentUploadCapabilities: { directUploadEnabled: true, directUploadThresholdBytes: 94371840, maxBytes: 209715200, sessionExpiresInSeconds: 900 },
    attachmentUploadSessionCreate: { uploadId: "33333333-3333-4333-8333-333333333333", attachmentId: "44444444-4444-4444-8444-444444444444", state: "pending", expiresAt: "2026-06-29T04:15:00.000Z", upload: { method: "PUT", url: "https://r2.example.test/upload", headers: { "Content-Type": "text/plain", "If-None-Match": "*" } } },
    attachmentUploadSessionComplete: { uploadId: "33333333-3333-4333-8333-333333333333", state: "completed", attachment: { id: "44444444-4444-4444-8444-444444444444", filename: "log.txt", mimeType: "text/plain", sizeBytes: 12, thumbnailUrl: null } },
    attachmentUploadSessionCancel: { uploadId: "33333333-3333-4333-8333-333333333333", state: "canceled", expiresAt: "2026-06-29T04:15:00.000Z", attachment: null, terminalReason: "Canceled." },
    attachmentUploadSessionStatus: { uploadId: "33333333-3333-4333-8333-333333333333", state: "pending", expiresAt: "2026-06-29T04:15:00.000Z", attachment: null, terminalReason: null },
    attachmentDownload: new Uint8Array([1, 2, 3]),
    attachmentDownloadUrl: { url: "https://objects.example.test/a?X-Amz-Signature=sig", expiresAt: "2026-10-04T08:00:00.000Z", filename: "report.pdf", mimeType: "application/pdf" },
    attachmentCommentsList: {
      comments: [{
        id: "msg-comment-1",
        channelId: "thread-channel-1",
        senderId: "user-1",
        senderType: "user",
        senderName: "xxchan",
        senderAvatarUrl: null,
        senderGravatarHash: null,
        content: "looks good",
        createdAt: "2026-06-27T02:55:00.000Z",
        reactions: [{
          emoji: "✅",
          reactorType: "user",
          reactorId: "user-1",
          createdAt: "2026-06-27T02:56:00.000Z",
        }],
        anchor: { type: "lines", data: { start: 1, end: 2 } },
        resolved: true,
        resolvedBy: { reactorId: "user-1", reactorType: "user" },
        resolvedAt: "2026-06-27T02:56:00.000Z",
      }],
      threadChannelId: "thread-channel-1",
      viewer: {
        canComment: false,
        reason: "agent_descoped",
        canResolve: true,
        resolveAction: { type: "reaction", emoji: "✅" },
      },
    },
    pushWebhookStatus: { registered: true, url: "https://hooks.example.test/raft", enabled: true, disabledReason: null, disabledAt: null, lastAttemptAt: null, lastDeliveryAt: "2026-06-29T04:00:00.000Z", lastError: null, consecutiveFailures: 0, nextAttemptAt: null },
    pushWebhookRegister: { registered: true, url: "https://hooks.example.test/raft", enabled: true, disabledReason: null, disabledAt: null, lastAttemptAt: null, lastDeliveryAt: "2026-06-29T04:00:00.000Z", lastError: null, consecutiveFailures: 0, nextAttemptAt: null },
    pushWebhookDelete: null,
    mentionsList: { mentions: [], has_more: false },
  };
  // Core's samples, then each app's (apps/agentApiSamples.ts).
  const samples = {
    ...coreSamples,
    ...Object.fromEntries(Object.entries(firstPartyAppAgentApiSamples).map(([key, sample]) => [key, sample.response])),
  } as Record<AgentApiRouteKey, unknown>;

  for (const key of Object.keys(samples) as AgentApiRouteKey[]) {
    assert.deepEqual(parseAgentApiResponse(key, samples[key]), samples[key]);
  }
});

test("channel lifecycle response contracts enforce the requested terminal state", () => {
  assert.throws(
    () => parseAgentApiResponse("channelArchive", {
      id: "channel-1",
      name: "proj-runtime",
      type: "channel",
      archivedAt: null,
      archivedByUserId: null,
      archivedByAgentId: null,
    }),
    /archivedAt/,
  );
  assert.throws(
    () => parseAgentApiResponse("channelUnarchive", {
      id: "channel-1",
      name: "proj-runtime",
      type: "channel",
      archivedAt: "2026-07-11T00:00:00.000Z",
      archivedByUserId: null,
      archivedByAgentId: "agent-1",
    }),
    /archivedAt/,
  );
});

test("agent-api binary responses require Uint8Array bytes", () => {
  assert.throws(
    () => parseAgentApiResponse("attachmentDownload", "not-bytes"),
    {
      name: "TypeError",
      message: "Agent API attachmentDownload response did not contain binary bytes",
    },
  );
});

test("agent-api human profiles accept a voluntary leave status", () => {
  const profile = {
    kind: "human",
    id: "user-1",
    isSelf: false,
    name: "alice",
    displayName: "Alice",
    description: null,
    avatarUrl: null,
    email: null,
    role: null,
    joinedAt: null,
    membershipStatus: "left",
    createdAgents: [],
  };

  assert.deepEqual(parseAgentApiResponse("profileShow", profile), profile);
});

test("agent-api message envelopes require wire timestamp strings", () => {
  const createdAt = new Date("2026-06-27T02:55:00.000Z");
  const timestamp = new Date("2026-06-27T02:55:01.000Z");

  assert.throws(
    () => parseAgentApiResponse("historyRead", {
      messages: [{
        seq: 1,
        content: "hello",
        createdAt,
        timestamp,
      }],
      has_more: false,
      has_older: false,
      has_newer: false,
      last_read_seq: null,
    }),
    { name: "ZodError" },
  );
});

test("agent-api message envelopes require ISO UTC timestamp strings", () => {
  for (const createdAt of [
    "2026-06-27 02:55:00",
    "2026-06-27T11:55:00.000+09:00",
  ]) {
    assert.throws(
      () => parseAgentApiResponse("historyRead", {
        messages: [{
          seq: 1,
          content: "hello",
          createdAt,
        }],
        has_more: false,
        has_older: false,
        has_newer: false,
        last_read_seq: null,
      }),
      { name: "ZodError" },
      `expected ${createdAt} to fail the UTC wire timestamp contract`,
    );
  }
});

test("agent-api message envelopes accept toISOString timestamp strings", () => {
  const parsed = parseAgentApiResponse("historyRead", {
    messages: [{
      seq: 1,
      content: "hello",
      createdAt: new Date("2026-06-27T02:55:00.000Z").toISOString(),
    }],
    has_more: false,
    has_older: false,
    has_newer: false,
    last_read_seq: null,
  });

  assert.deepEqual(parsed, {
    messages: [{
      seq: 1,
      content: "hello",
      createdAt: "2026-06-27T02:55:00.000Z",
    }],
    has_more: false,
    has_older: false,
    has_newer: false,
    last_read_seq: null,
  });
});

test("task #153 @Stone finding 2: the delivery row shape fails closed per outcome", () => {
  const ok = agentApiSenderMentionDeliveryRowSchema.safeParse({
    targetHandle: "@bob", outcome: "lost", reasonCategory: "quota",
  });
  assert.equal(ok.success, true, "lost + category must be accepted");

  // `lost` without a category would make ABSENCE mean "unknown" again — the
  // exact shape the ruling removed.
  const lostNoCategory = agentApiSenderMentionDeliveryRowSchema.safeParse({
    targetHandle: "@bob", outcome: "lost",
  });
  assert.equal(lostNoCategory.success, false, "lost without a category must be rejected");

  // A cause-of-failure label on an outcome that did not fail is a claim we
  // cannot support; `unknown` especially must not carry one.
  for (const outcome of ["delivered", "pending", "unknown"] as const) {
    const withCategory = agentApiSenderMentionDeliveryRowSchema.safeParse({
      targetHandle: "@bob", outcome, reasonCategory: "quota",
    });
    assert.equal(withCategory.success, false, `${outcome} must not carry a reasonCategory`);
    const bare = agentApiSenderMentionDeliveryRowSchema.safeParse({ targetHandle: "@bob", outcome });
    assert.equal(bare.success, true, `${outcome} without a category must be accepted`);
  }
});

test("history DM consumption scope preserves typed identity and is optional for old servers", () => {
  const body = {
    messages: [],
    has_more: false,
    has_older: false,
    has_newer: false,
  };
  const scope = {
    agent_id: "11111111-1111-4111-8111-111111111111",
    channel_id: "22222222-2222-4222-8222-222222222222",
    channel_type: "dm",
    target: "dm:@peer",
  };
  const schema = agentApiContract.historyRead.response.body;
  assert.deepEqual(
    schema.parse({ ...body, consumption_scope: scope }).consumption_scope,
    scope,
  );
  assert.equal(schema.parse(body).consumption_scope, undefined);
  assert.equal(
    schema.safeParse({
      ...body,
      consumption_scope: { ...scope, channel_id: "not-an-id" },
    }).success,
    false,
  );
  assert.equal(
    schema.safeParse({
      ...body,
      consumption_scope: { ...scope, channel_type: "channel" },
    }).success,
    false,
  );
});


test("audience JWT issuance rejects identity overrides and is never automatically retried", () => {
  const body = agentApiContract.integrationToken.request.body;
  assert.equal(body.safeParse({ service: "test-rp" }).success, true);
  assert.equal(body.safeParse({ service: "test-rp", agentId: "override" }).success, false);
  assert.equal(getAgentApiRetryPolicy(AGENT_API_ROUTE_META.integrationToken), "single_attempt");
  assert.equal(toAgentApiToolAnnotations(AGENT_API_ROUTE_META.integrationToken).idempotentHint, false);
});
