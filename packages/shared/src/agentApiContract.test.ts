import assert from "node:assert/strict";
import test from "node:test";

import {
  agentApiContract,
  agentApiIntegrationAppStatusResponseSchema,
  agentApiIntegrationAppPrepareBodySchema,
  agentApiIntegrationAppTransferOwnerResponseSchema,
  agentApiSendBodySchema,
  agentApiSendV2BodySchema,
  agentApiTaskCreateBodySchema,
  agentApiTaskEnvelopeSchema,
  agentApiTaskResourceReceiptBodySchema,
  buildAgentApiRouteManifest,
  getAgentApiResponseKind,
  parseAgentApiAppSourceAckReject,
  parseAgentApiResponse,
  type AgentApiRouteKey,
} from "./agentApiContract.js";
import { AGENT_API_ROUTE_MANIFEST } from "./generated/agentApiRoutes.js";

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

test("generated agent-api route manifest is fresh", () => {
  assert.deepEqual(AGENT_API_ROUTE_MANIFEST, buildAgentApiRouteManifest());
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
  const samples: Record<AgentApiRouteKey, unknown> = {
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
    wikiManifestGet: {
      configured: true,
      wikiSpaceId: "11111111-1111-4111-8111-111111111111",
      etag: null,
      manifest: null,
    },
    wikiArtifactRead: {
      configured: true,
      wikiSpaceId: "11111111-1111-4111-8111-111111111111",
      etag: "\"manifest-v1\"",
      artifact: {
        id: "22222222-2222-4222-8222-222222222222",
        artifactType: "page",
        slug: "architecture",
        title: "Architecture",
        summary: "Summary",
        currentUnderstanding: "Current understanding",
        status: "current",
        confidence: "high",
        sourcePolicy: "cached_summary",
        sourceRefs: [],
        revision: {
          id: "33333333-3333-4333-8333-333333333333",
          key: "servers/server/wiki/revisions/artifact/revision.md",
          sha256: "a".repeat(64),
          bytes: 15,
        },
        updatedAt: "2026-07-26T00:00:00.000Z",
      },
      markdown: "# Architecture\n",
    },
    wikiManifestPublish: {
      configured: true,
      wikiSpaceId: "11111111-1111-4111-8111-111111111111",
      etag: "\"manifest-v1\"",
      manifest: {},
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
    channelMembers: {
      channel: { ref: "#proj-runtime", type: "channel" },
      agents: [{ name: "Stone", status: "active" }],
      humans: [{ name: "xxchan", description: null, role: "owner" }],
    },
    resolveChannel: {
      channelId: "channel-1",
    },
    threadUnfollow: {
      ok: true,
    },
    serverUpdate: {
      id: "server-1",
      name: "Renamed Server",
      hideHumansFromMembers: true,
      avatarUrl: null,
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
    migrationBegin: {
      migration: {
        id: "migration-1",
        agentId: "agent-1",
        sourceMachineId: "machine-a",
        targetMachineId: "machine-b",
        state: "prep",
        manifestPath: null,
        manifestSha256: null,
        arrivalReportPath: null,
        arrivalReportSha256: null,
        abortReason: null,
        failureReason: null,
        prepDeadlineAt: "2026-06-27T03:05:00.000Z",
        transferDeadlineAt: "2026-06-27T03:55:00.000Z",
        arrivalDeadlineAt: "2026-06-27T04:05:00.000Z",
        readyAt: null,
        flippedAt: null,
        arrivedAt: null,
        completedAt: null,
        abortedAt: null,
        revision: 1,
        createdAt: "2026-06-27T02:55:00.000Z",
        updatedAt: "2026-06-27T02:55:00.000Z",
      },
    },
    migrationStatus: {
      migration: null,
    },
    migrationReady: {
      migration: {
        id: "migration-1",
        agentId: "agent-1",
        sourceMachineId: "machine-a",
        targetMachineId: "machine-b",
        state: "ready",
        manifestPath: "MIGRATION-MANIFEST.json",
        manifestSha256: "sha256:manifest",
        arrivalReportPath: null,
        arrivalReportSha256: null,
        abortReason: null,
        failureReason: null,
        prepDeadlineAt: "2026-06-27T03:05:00.000Z",
        transferDeadlineAt: "2026-06-27T03:55:00.000Z",
        arrivalDeadlineAt: "2026-06-27T04:05:00.000Z",
        readyAt: "2026-06-27T02:58:00.000Z",
        flippedAt: null,
        arrivedAt: null,
        completedAt: null,
        abortedAt: null,
        revision: 2,
        createdAt: "2026-06-27T02:55:00.000Z",
        updatedAt: "2026-06-27T02:58:00.000Z",
      },
    },
    migrationArrived: {
      migration: {
        id: "migration-1",
        agentId: "agent-1",
        sourceMachineId: "machine-a",
        targetMachineId: "machine-b",
        state: "completed",
        manifestPath: "MIGRATION-MANIFEST.json",
        manifestSha256: "sha256:manifest",
        arrivalReportPath: "MIGRATION-ARRIVED.json",
        arrivalReportSha256: "sha256:arrived",
        abortReason: null,
        failureReason: null,
        prepDeadlineAt: "2026-06-27T03:05:00.000Z",
        transferDeadlineAt: "2026-06-27T03:55:00.000Z",
        arrivalDeadlineAt: "2026-06-27T04:05:00.000Z",
        readyAt: "2026-06-27T02:58:00.000Z",
        flippedAt: "2026-06-27T03:00:00.000Z",
        arrivedAt: "2026-06-27T03:02:00.000Z",
        completedAt: "2026-06-27T03:02:00.000Z",
        abortedAt: null,
        revision: 4,
        createdAt: "2026-06-27T02:55:00.000Z",
        updatedAt: "2026-06-27T03:02:00.000Z",
      },
    },
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
      }],
    },
    integrationLogin: {
      status: "logged_in",
      service: {
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
  };

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
