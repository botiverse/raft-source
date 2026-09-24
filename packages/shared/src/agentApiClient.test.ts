import assert from "node:assert/strict";
import test from "node:test";

import {
  agentApiContract,
  type AgentApiRouteKey,
} from "./agentApiContract.js";
import { asChannelId, asMessageId, type ChannelId, type MessageId } from "./brandedIds.js";
import {
  createAgentApiClient,
  type AgentApiClient,
} from "./agentApiClient.js";
import type {
  AgentApiRawTransport,
  AgentApiRawTransportRequest,
} from "./agentApiRawClient.js";

const migrationResponse = {
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
    prepDeadlineAt: "2026-06-29T04:10:00.000Z",
    transferDeadlineAt: "2026-06-29T05:00:00.000Z",
    arrivalDeadlineAt: "2026-06-29T05:10:00.000Z",
    readyAt: null,
    flippedAt: null,
    arrivedAt: null,
    completedAt: null,
    abortedAt: null,
    revision: 1,
    createdAt: "2026-06-29T04:00:00.000Z",
    updatedAt: "2026-06-29T04:00:00.000Z",
  },
};

const sdkFixtures: Record<AgentApiRouteKey, {
  input: unknown[];
  response: unknown;
}> = {
  feedbackLocatorIngest: {
    input: [{
      artifact_kind: "raft-feedback-locator-v0",
      event_kind: "feedback-locator:created",
      payload: { schema_version: "raft.feedback.locator.v0" },
    }],
    response: {
      status: "accepted",
      receipt_id: "00000000-0000-4000-8000-000000000001",
      report_id: "00000000-0000-4000-8000-000000000002",
      duplicate: false,
    },
  },
  feedbackLocatorList: {
    input: [{ runtime: "codex", limit: "10" }],
    response: { locators: [] },
  },
  events: {
    input: [{ since: "latest" }],
    response: {
      events: [],
      last_seen_msgId: null,
      last_seen_seq: null,
      reply_target: null,
      pending_notice_ids: [],
      wake_reason: null,
      has_more: false,
    },
  },
  historyRead: {
    input: [{ channel: "#wg-raft-cli" }],
    response: {
      messages: [],
      has_more: false,
      has_older: false,
      has_newer: false,
    },
  },
  knowledgeGet: {
    input: [{
      topic: "index",
      intent: "Learn which Raft workflows are documented",
      reason: "Need the Manual topic catalog before answering",
    }],
    response: {
      ok: true,
      docId: "doc-1",
      topicOrPath: "index",
      docVersion: "v1",
      docState: "published",
      contentType: "text/markdown",
      content: "# Index",
    },
  },
  knowledgeSearch: {
    input: [{
      query: "preview before merge",
      scope: "recipes",
      intent: "Safely preview the user's change before merge",
      reason: "Need the recommended preview workflow right now",
    }],
    response: {
      ok: true,
      query: "preview before merge",
      scope: "recipes",
      results: [{
        slug: "recipes/technique/preview-env",
        title: "Spin up a preview environment",
        firstScreen: "# Spin up a preview environment",
      }],
    },
  },
  wikiManifestGet: {
    input: [],
    response: {
      configured: true,
      wikiSpaceId: "11111111-1111-4111-8111-111111111111",
      etag: null,
      manifest: null,
    },
  },
  wikiArtifactRead: {
    input: [{
      artifactId: "22222222-2222-4222-8222-222222222222",
    }],
    response: {
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
  },
  wikiManifestPublish: {
    input: [{ expectedEtag: null, manifest: {}, revisionBodies: [] }],
    response: {
      configured: true,
      wikiSpaceId: "11111111-1111-4111-8111-111111111111",
      etag: "\"manifest-v1\"",
      manifest: {},
    },
  },
  managedMcpTools: {
    input: [],
    response: { catalogVersion: 1, tools: [] },
  },
  managedMcpCall: {
    input: [{
      mcpServerId: "11111111-1111-4111-8111-111111111111",
      toolName: "search",
      arguments: { query: "MCP" },
      expectedConfigVersion: 1,
      expectedAssignmentVersion: 1,
    }],
    response: { content: [{ type: "text", text: "found" }], isError: false },
  },
  messageSend: {
    input: [{ target: "#wg-raft-cli", content: "hello" }],
    response: {
      ok: true,
      state: "sent",
      messageId: "msg-1",
    },
  },
  messageSendV2: {
    input: [{ target: "#wg-raft-cli", content: "hello @wenyi", mentions: [{ type: "user", id: "11111111-1111-4111-8111-111111111111", name: "wenyi" }] }],
    response: { ok: true, state: "sent", messageId: "msg-v2", unresolvedMentionHandles: [] },
  },
  messageResolve: {
    input: [{ msgId: asMessageId("msg/with space") }],
    response: {
      message: {
        message_id: "msg-1",
        timestamp: "2026-06-28T02:00:00.000Z",
      },
    },
  },
  messageSearch: {
    input: [{ q: "review status", channel: "#proj-runtime", sender: "xxchan", sort: "recent", limit: "20" }],
    response: {
      results: [],
      hasMore: false,
    },
  },
  messageReactionAdd: {
    input: [{ msgId: asMessageId("msg/with space") }, { emoji: "👀" }],
    response: {
      message_id: "msg-1",
      timestamp: "2026-06-28T02:00:00.000Z",
    },
  },
  messageReactionRemove: {
    input: [{ msgId: asMessageId("msg-1") }, { emoji: "👀" }],
    response: {
      message_id: "msg-1",
      timestamp: "2026-06-28T02:00:00.000Z",
    },
  },
  channelJoin: {
    input: [{ channelId: asChannelId("chan/with spaces") }],
    response: { ok: true },
  },
  channelLeave: {
    input: [{ channelId: asChannelId("chan-1") }],
    response: { ok: true },
  },
  channelMute: {
    input: [{ channelId: asChannelId("chan-1") }],
    response: { activityMuted: true, muteFromSeq: 42 },
  },
  channelUnmute: {
    input: [{ channelId: asChannelId("chan-1") }],
    response: { activityMuted: false, muteFromSeq: null },
  },
  channelArchive: {
    input: [{ target: "#engineering" }],
    response: { id: "chan-1", name: "engineering", type: "channel", archivedAt: "2026-07-11T00:00:00.000Z", archivedByUserId: null, archivedByAgentId: "agent-1" },
  },
  channelUnarchive: {
    input: [{ target: "#engineering" }],
    response: { id: "chan-1", name: "engineering", type: "channel", archivedAt: null, archivedByUserId: null, archivedByAgentId: null },
  },
  channelMembers: {
    input: [{ channel: "#wg-raft-cli" }],
    response: {
      channel: { ref: "#wg-raft-cli", type: "channel" },
      agents: [],
      humans: [],
    },
  },
  resolveChannel: {
    input: [{ target: "#wg-raft-cli" }],
    response: {
      channelId: "channel-1",
    },
  },
  threadUnfollow: {
    input: [{ thread: "#wg-raft-cli:abcd1234" }],
    response: { ok: true },
  },
  serverInfo: {
    input: [],
    response: {
      runtimeContext: {
        agentId: "agent-1",
        serverId: "server-1",
      },
      channels: [],
      agents: [],
      humans: [],
    },
  },
  serverUpdate: {
    input: [{ name: "Renamed Server", hideHumansFromMembers: true }],
    response: {
      id: "server-1",
      name: "Renamed Server",
      hideHumansFromMembers: true,
      avatarUrl: null,
    },
  },
  mentionActionsPending: {
    input: [{ limit: "20" }],
    response: {
      pendingMentionActions: [],
    },
  },
  mentionActionsExecute: {
    input: [{ action: "notify", resolutionIds: ["res-1"] }],
    response: {
      ok: true,
      action: "notify",
      results: [],
    },
  },
  taskClaim: {
    input: [{ channel: "#wg-raft-cli", task_numbers: [25] }],
    response: {
      results: [],
    },
  },
  taskList: {
    input: [{ channel: "#wg-raft-cli", status: "in_review" }],
    response: {
      tasks: [],
    },
  },
  taskCreate: {
    input: [{ channel: "#wg-raft-cli", tasks: [{ title: "SDK conformance" }] }],
    response: {
      tasks: [
        {
          taskNumber: 25,
          messageId: "msg-1",
          title: "SDK conformance",
          status: "todo",
          claimedByType: null,
          claimedById: null,
          claimedAt: null,
          requiresResourceReceipt: false,
        },
      ],
    },
  },
  taskUnclaim: {
    input: [{ channel: "#wg-raft-cli", task_number: 25 }],
    response: { ok: true },
  },
  taskAssign: {
    input: [
      { channel: "#wg-raft-cli", task_number: 25, assignee: "@akko" },
      { channel: "#wg-raft-cli", task_number: 25, assignee: null },
      { channel: "#wg-raft-cli", task_number: 25, assignee: "@akko", expected_revision: 3 },
    ],
    response: { ok: true, revision: 4, assignee: "@akko" },
  },
  taskUpdateStatus: {
    input: [{ channel: "#wg-raft-cli", task_number: 25, status: "in_review" }],
    response: { ok: true },
  },
  taskResourceReceipt: {
    input: [{
      channel: "#wg-raft-cli",
      task_number: 25,
      receipt: {
        object: "staging bucket",
        purpose: "verify resource receipt enforcement",
        teardown_owner: "@akko",
        security_privacy: "internal; no secrets",
        expiry: "2026-09-01T00:00:00.000Z",
        runbook: "runbooks/staging-bucket.md",
        tracking: "task #25",
      },
    }],
    response: {
      ok: true,
      taskNumber: 25,
      revision: 2,
      receipt: {
        object: "staging bucket",
        purpose: "verify resource receipt enforcement",
        teardown_owner: "@akko",
        security_privacy: "internal; no secrets",
        expiry: "2026-09-01T00:00:00.000Z",
        runbook: "runbooks/staging-bucket.md",
        tracking: "task #25",
      },
      expiryFollowup: {
        id: "11111111-2222-4333-8444-555555555555",
        ownerAgentId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        owner: "@akko",
        fireAt: "2026-09-01T00:00:00.000Z",
        msgId: "99999999-8888-4777-8666-555555555555",
        targetChannelId: "22222222-3333-4444-8555-666666666666",
      },
    },
  },
  taskDelete: {
    input: [{ channel: "#wg-raft-cli", task_number: 25 }],
    response: { ok: true },
  },
  taskConvert: {
    input: [{ channel: "#wg-raft-cli", message_id: "11111111" }],
    response: { task: { taskNumber: 26, messageId: "11111111-2222-3333-4444-555555555555", title: "Ship the assignee picker", status: "todo", claimedByType: null, claimedById: null, claimedByName: null, claimedAt: null, requiresResourceReceipt: false } },
  },
  taskAmend: {
    input: [{ channel: "#wg-raft-cli", task_number: 24, title: "Current title" }],
    response: {
      task: { taskNumber: 24, title: "Current title", description: null, revision: 2 },
      event: {
        id: "11111111-1111-4111-8111-111111111111",
        seq: 2,
        eventType: "amended",
        actorType: "agent",
        actorName: "cross",
        payload: { revision: 2, changes: { title: { from: "Old", to: "Current title" } } },
        createdAt: "2026-08-05T00:00:00.000Z",
      },
    },
  },
  taskHistory: {
    input: [{ channel: "#wg-raft-cli", task_number: 24 }],
    response: {
      task: { taskNumber: 24, title: "Current title", description: null, revision: 2 },
      events: [],
    },
  },
  migrationBegin: {
    input: [{ targetMachineId: "machine-b" }],
    response: migrationResponse,
  },
  migrationStatus: {
    input: [],
    response: migrationResponse,
  },
  migrationReady: {
    input: [{ manifestPath: "MIGRATION-MANIFEST.json", manifestSha256: "sha256:manifest" }],
    response: {
      migration: {
        ...migrationResponse.migration,
        state: "ready",
        manifestPath: "MIGRATION-MANIFEST.json",
        manifestSha256: "sha256:manifest",
        readyAt: "2026-06-29T04:02:00.000Z",
        revision: 2,
        updatedAt: "2026-06-29T04:02:00.000Z",
      },
    },
  },
  migrationArrived: {
    input: [{ reportPath: "MIGRATION-ARRIVED.json", reportSha256: "sha256:arrived" }],
    response: {
      migration: {
        ...migrationResponse.migration,
        state: "completed",
        manifestPath: "MIGRATION-MANIFEST.json",
        manifestSha256: "sha256:manifest",
        arrivalReportPath: "MIGRATION-ARRIVED.json",
        arrivalReportSha256: "sha256:arrived",
        readyAt: "2026-06-29T04:02:00.000Z",
        flippedAt: "2026-06-29T04:04:00.000Z",
        arrivedAt: "2026-06-29T04:06:00.000Z",
        completedAt: "2026-06-29T04:06:00.000Z",
        revision: 4,
        updatedAt: "2026-06-29T04:06:00.000Z",
      },
    },
  },
  reminderList: {
    input: [{ status: "scheduled,fired" }],
    response: {
      reminders: [{
        reminderId: "reminder-1",
        ownerAgentId: "agent-1",
        title: "check CI",
        fireAt: "2026-06-29T05:00:00.000Z",
        firedAt: null,
        createdAt: "2026-06-29T04:00:00.000Z",
        status: "scheduled",
        msgRef: "#wg-raft-cli:abcd1234",
        msgPermalink: null,
        recurrence: null,
      }],
    },
  },
  reminderCreate: {
    input: [{ title: "check CI", delaySeconds: 60, msgId: "abcd1234" }],
    response: {
      reminder: {
        reminderId: "reminder-1",
        ownerAgentId: "agent-1",
        title: "check CI",
        fireAt: "2026-06-29T05:00:00.000Z",
        firedAt: null,
        createdAt: "2026-06-29T04:00:00.000Z",
        status: "scheduled",
        msgRef: "#wg-raft-cli:abcd1234",
        msgPermalink: null,
        recurrence: null,
      },
    },
  },
  reminderCancel: {
    input: [{ reminderId: "reminder-1" }],
    response: {
      reminder: {
        reminderId: "reminder-1",
        ownerAgentId: "agent-1",
        title: "check CI",
        fireAt: "2026-06-29T05:00:00.000Z",
        firedAt: null,
        createdAt: "2026-06-29T04:00:00.000Z",
        status: "canceled",
        msgRef: "#wg-raft-cli:abcd1234",
        msgPermalink: null,
        recurrence: null,
      },
    },
  },
  reminderSnooze: {
    input: [{ reminderId: "reminder-1" }, { delaySeconds: 300 }],
    response: {
      reminder: {
        reminderId: "reminder-1",
        ownerAgentId: "agent-1",
        title: "check CI",
        fireAt: "2026-06-29T05:05:00.000Z",
        firedAt: "2026-06-29T05:00:00.000Z",
        createdAt: "2026-06-29T04:00:00.000Z",
        status: "scheduled",
        msgRef: "#wg-raft-cli:abcd1234",
        msgPermalink: null,
        recurrence: null,
      },
    },
  },
  reminderUpdate: {
    input: [{ reminderId: "reminder-1" }, { title: "check staging" }],
    response: {
      reminder: {
        reminderId: "reminder-1",
        ownerAgentId: "agent-1",
        title: "check staging",
        fireAt: "2026-06-29T05:00:00.000Z",
        firedAt: null,
        createdAt: "2026-06-29T04:00:00.000Z",
        status: "scheduled",
        msgRef: "#wg-raft-cli:abcd1234",
        msgPermalink: null,
        recurrence: null,
      },
    },
  },
  appSourceAck: {
    input: [{
      itemId: "source:item:1",
      appId: "system.fixture",
      notificationClass: "due",
      sourceRef: { kind: "source", id: "source-1", revision: "7" },
      ackAttemptId: "aaaaaaaa-1234-4123-8123-123456789abc",
    }],
    response: {
      ok: true,
      itemId: "source:item:1",
      appId: "system.fixture",
      notificationClass: "due",
      sourceRef: { kind: "source", id: "source-1", revision: "7" },
      sourceEventId: "bbbbbbbb-1234-4123-8123-123456789abc",
      ackAttemptId: "aaaaaaaa-1234-4123-8123-123456789abc",
      replayed: false,
    },
  },
  reminderLog: {
    input: [{ reminderId: "reminder-1" }],
    response: {
      events: [{
        eventId: "event-1",
        reminderId: "reminder-1",
        eventType: "scheduled",
        actorType: "agent",
        actorId: "agent-1",
        occurredAt: "2026-06-29T04:00:00.000Z",
        nextFireAt: "2026-06-29T05:00:00.000Z",
        metadata: null,
      }],
    },
  },
  appConfigGet: {
    input: [{ appId: "system.cleaner" }],
    response: { appId: "system.cleaner", revision: 0, schema: {}, defaults: {}, overrides: {}, effective: {} },
  },
  appConfigPatch: {
    input: [{ appId: "system.cleaner" }, { expectedRevision: 0, set: { enabled: false }, unset: [] }],
    response: { appId: "system.cleaner", revision: 1, schema: {}, defaults: {}, overrides: { enabled: false }, effective: { enabled: false } },
  },
  profileShow: {
    input: [{ target: "@HaoHao" }],
    response: {
      kind: "agent",
      id: "agent-1",
      isSelf: true,
      name: "HaoHao",
      displayName: null,
      description: null,
      avatarUrl: null,
      status: "active",
      serverRole: null,
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
      createdAt: "2026-06-29T04:00:00.000Z",
      deletedAt: null,
    },
  },
  profileUpdate: {
    input: [{ displayName: "HaoHao", description: "Runtime agent", avatarUrl: "pixel:random:HaoHao" }],
    response: {
      kind: "agent",
      id: "agent-1",
      isSelf: true,
      name: "HaoHao",
      displayName: "HaoHao",
      description: "Runtime agent",
      avatarUrl: "pixel:random:HaoHao",
      status: "active",
      serverRole: null,
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
      createdAt: "2026-06-29T04:00:00.000Z",
      deletedAt: null,
    },
  },
  profileAvatarUpdate: {
    input: [],
    response: {
      kind: "agent",
      id: "agent-1",
      isSelf: true,
      name: "HaoHao",
      displayName: "HaoHao",
      description: "Runtime agent",
      avatarUrl: "https://cdn.example/avatar.png",
      status: "active",
      serverRole: null,
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
      createdAt: "2026-06-29T04:00:00.000Z",
      deletedAt: null,
    },
  },
  integrationList: {
    input: [],
    response: {
      services: [{
        id: "client-1",
        clientId: "drive9",
        name: "Drive9",
        description: null,
        homepageUrl: null,
        returnUrl: null,
        agentManifestUrl: null,
        createdAt: "2026-06-28T02:00:00.000Z",
        updatedAt: "2026-06-28T02:00:00.000Z",
      }],
      activeLogins: [],
    },
  },
  integrationMarketplaceSearch: {
    input: [{ query: "drive", limit: "10" }],
    response: {
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
        updatedAt: "2026-06-28T02:00:00.000Z",
      }],
    },
  },
  integrationLogin: {
    input: [{ service: "drive9", scopes: ["openid", "profile"], target: "#wg-raft-cli" }],
    response: {
      status: "logged_in",
      service: {
        id: "client-1",
        clientId: "drive9",
        name: "Drive9",
        description: null,
        homepageUrl: null,
        returnUrl: null,
        agentManifestUrl: null,
        createdAt: "2026-06-28T02:00:00.000Z",
        updatedAt: "2026-06-28T02:00:00.000Z",
      },
      scopes: ["openid", "profile"],
      requestId: "request-1",
    },
  },
  integrationAppPrepare: {
    input: [{
      mode: "register",
      target: "#wg-raft-cli",
      clientKey: "drive9",
      name: "Drive9",
      returnUrl: "https://drive9.example/auth/raft/callback",
      scopes: ["openid", "profile"],
    }],
    response: {
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
  },
  integrationAppRotateSecret: {
    input: [{
      clientKey: "drive9",
    }],
    response: {
      clientId: "client-uuid-1",
      clientKey: "drive9",
      clientName: "Drive9",
      clientSecret: "raft_secret_rotated",
    },
  },
  integrationAppTransferOwner: {
    input: [{ clientKey: "drive9", targetAgent: "box" }],
    response: {
      clientId: "client-uuid-1",
      clientKey: "drive9",
      clientName: "Drive9",
      ownerAgentId: "agent-2",
      ownerAgentName: "box",
      ownershipOutcome: "transferred",
      auditEventId: "11111111-1111-4111-8111-111111111112",
    },
  },
  integrationAppUpdate: {
    input: [{ clientKey: "drive9", name: "Drive 9", category: "Infrastructure" }],
    response: {
      clientId: "client-uuid-1",
      clientKey: "drive9",
      clientName: "Drive 9",
      updatedFields: ["name", "category"],
    },
  },
  integrationAppManage: {
    input: [{ clientKey: "drive9", action: "request_publish" }],
    response: {
      action: "request_publish",
      clientId: "client-uuid-1",
      clientKey: "drive9",
      clientName: "Drive9",
      publishStatus: "publish_requested",
    },
  },
  integrationAppLogoUpdate: {
    input: [],
    response: {
      clientId: "client-uuid-1",
      clientKey: "drive9",
      clientName: "Drive9",
      logoUrl: "/api/integration-logos/client-uuid-1/hash.webp",
    },
  },
  integrationAppList: {
    input: [],
    response: { apps: [] },
  },
  integrationAppStatus: {
    input: [{ client: "drive9" }],
    response: {
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
  },
  actionPrepare: {
    input: [{
      target: "#wg-raft-cli",
      action: { type: "channel:create", name: "SDK conformance", visibility: "public" },
    }],
    response: {
      messageId: "msg-action-1",
      metadata: { kind: "action-card" },
    },
  },
  attachmentUpload: {
    input: [],
    response: {
      id: "attachment-1",
      filename: "log.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
      thumbnailUrl: null,
    },
  },
  attachmentUploadCapabilities: {
    input: [],
    response: { directUploadEnabled: true, directUploadThresholdBytes: 94371840, maxBytes: 209715200, sessionExpiresInSeconds: 900 },
  },
  attachmentUploadSessionCreate: {
    input: [{ channelId: "11111111-1111-4111-8111-111111111111", filename: "log.txt", mimeType: "text/plain", sizeBytes: 12, clientRequestId: "22222222-2222-4222-8222-222222222222" }],
    response: { uploadId: "33333333-3333-4333-8333-333333333333", attachmentId: "44444444-4444-4444-8444-444444444444", state: "pending", expiresAt: "2026-06-29T04:15:00.000Z", upload: { method: "PUT", url: "https://r2.example.test/upload", headers: { "Content-Type": "text/plain", "If-None-Match": "*" } } },
  },
  attachmentUploadSessionComplete: {
    input: [{ uploadId: "33333333-3333-4333-8333-333333333333" }],
    response: { uploadId: "33333333-3333-4333-8333-333333333333", state: "completed", attachment: { id: "44444444-4444-4444-8444-444444444444", filename: "log.txt", mimeType: "text/plain", sizeBytes: 12, thumbnailUrl: null } },
  },
  attachmentUploadSessionCancel: {
    input: [{ uploadId: "33333333-3333-4333-8333-333333333333" }],
    response: { uploadId: "33333333-3333-4333-8333-333333333333", state: "canceled", expiresAt: "2026-06-29T04:15:00.000Z", attachment: null, terminalReason: "Canceled." },
  },
  attachmentUploadSessionStatus: {
    input: [{ uploadId: "33333333-3333-4333-8333-333333333333" }],
    response: { uploadId: "33333333-3333-4333-8333-333333333333", state: "pending", expiresAt: "2026-06-29T04:15:00.000Z", attachment: null, terminalReason: null },
  },
  attachmentDownload: {
    input: [{ attachmentId: "attachment/with space" }],
    response: new Uint8Array([1, 2, 3]),
  },
  attachmentCommentsList: {
    input: [{ attachmentId: "attachment/with space" }, { limit: "25" }],
    response: {
      comments: [{
        id: "msg-comment-1",
        channelId: "thread-channel-1",
        senderId: "user-1",
        senderType: "user",
        senderName: "xxchan",
        senderAvatarUrl: null,
        senderGravatarHash: null,
        content: "looks good",
        createdAt: "2026-06-29T04:00:00.000Z",
        reactions: [{
          emoji: "✅",
          reactorType: "user",
          reactorId: "user-1",
          createdAt: "2026-06-29T04:01:00.000Z",
        }],
        anchor: { type: "lines", data: { start: 1, end: 2 } },
        resolved: true,
        resolvedBy: { reactorId: "user-1", reactorType: "user" },
        resolvedAt: "2026-06-29T04:01:00.000Z",
      }],
      threadChannelId: "thread-channel-1",
      viewer: {
        canComment: false,
        reason: "agent_descoped",
        canResolve: true,
        resolveAction: { type: "reaction", emoji: "✅" },
      },
    },
  },
};

function _agentApiSdkPathParamBrandChecks(
  client: AgentApiClient,
  messageId: MessageId,
  channelId: ChannelId,
): void {
  void client.messages.resolve({ msgId: messageId });
  void client.messages.addReaction({ msgId: messageId }, { emoji: "👀" });
  void client.channels.join({ channelId });

  // @ts-expect-error — SDK message path params require a branded MessageId, not an arbitrary string.
  void client.messages.resolve({ msgId: "msg-1" });
  // @ts-expect-error — SDK message routes must not accept a ChannelId.
  void client.messages.addReaction({ msgId: channelId }, { emoji: "👀" });
  // @ts-expect-error — SDK channel routes must not accept a MessageId.
  void client.channels.join({ channelId: messageId });
}
void _agentApiSdkPathParamBrandChecks;

function methodForRoute(client: unknown, routeKey: AgentApiRouteKey): (...args: unknown[]) => Promise<unknown> {
  const route = agentApiContract[routeKey];
  const resource = (client as Record<string, Record<string, unknown>>)[route.client.resource];
  const method = resource?.[route.client.method];
  assert.equal(typeof method, "function", `${routeKey} exposes ${route.client.resource}.${route.client.method}`);
  return method as (...args: unknown[]) => Promise<unknown>;
}

test("SDK client exposes every contract-generated method and a typed route escape hatch", async () => {
  const requests: AgentApiRawTransportRequest[] = [];
  const transport: AgentApiRawTransport = {
    request: async (input) => {
      requests.push(input);
      return {
        ok: true,
        status: 200,
        error: null,
        data: sdkFixtures[input.routeKey].response,
      };
    },
  };
  const client = createAgentApiClient(transport, { pathPrefix: "/sdk" });

  for (const routeKey of Object.keys(agentApiContract) as AgentApiRouteKey[]) {
    const result = await methodForRoute(client, routeKey)(...sdkFixtures[routeKey].input);
    assert.equal((result as { ok: boolean }).ok, true, `${routeKey} returns SDK success`);
  }

  const lowLevel = await client.request("messageResolve", { params: { msgId: asMessageId("msg/with space") } });
  assert.equal(lowLevel.ok, true);
  assert.deepEqual(
    requests.at(-1),
    {
      routeKey: "messageResolve",
      method: "GET",
      path: "/sdk/messages/msg%2Fwith%20space/resolve",
      body: undefined,
    },
  );
});

test("SDK client returns discriminated errors for transport, HTTP, and validation failures", async () => {
  const transportFailure = await createAgentApiClient({
    transport: {
      request: async () => {
        throw new Error("socket closed");
      },
    },
  }).server.info();
  assert.deepEqual({
    ok: transportFailure.ok,
    errorKind: transportFailure.ok ? null : transportFailure.error.kind,
    reason: transportFailure.ok ? null : transportFailure.error.reason,
  }, {
    ok: false,
    errorKind: "transport",
    reason: "transport_error",
  });

  const httpFailure = await createAgentApiClient({
    transport: {
      request: async () => ({
        ok: false,
        status: 403,
        data: { requiredScope: "send" },
        error: "Permission denied",
        errorCode: "SCOPE_DENIED",
        suggestedNextAction: "Ask a human to re-enable send.",
      }),
    },
  }).messages.send({ target: "#wg-raft-cli", content: "hello" });
  assert.equal(httpFailure.ok, false);
  assert.equal(httpFailure.error.kind, "http");
  assert.deepEqual({
    reason: httpFailure.error.reason,
    status: httpFailure.error.status,
    errorCode: httpFailure.error.errorCode,
    suggestedNextAction: httpFailure.error.suggestedNextAction,
  }, {
    reason: "http_error",
    status: 403,
    errorCode: "SCOPE_DENIED",
    suggestedNextAction: "Ask a human to re-enable send.",
  });

  const responseDrift = await createAgentApiClient({
    transport: {
      request: async () => ({
        ok: true,
        status: 200,
        error: null,
        data: { ok: true },
      }),
    },
  }).history.read({ channel: "#wg-raft-cli" });
  assert.deepEqual({
    ok: responseDrift.ok,
    errorKind: responseDrift.ok ? null : responseDrift.error.kind,
    reason: responseDrift.ok ? null : responseDrift.error.reason,
  }, {
    ok: false,
    errorKind: "validation",
    reason: "response_contract_mismatch",
  });
});

test("SDK fetch transport applies typed auth, throttle, and retry without CLI profile state", async () => {
  const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
  const throttledRoutes: AgentApiRouteKey[] = [];
  let attempts = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    attempts += 1;
    fetchCalls.push({ url: String(url), init: init ?? {} });
    if (attempts === 1) {
      throw new Error("transient network failure");
    }
    return new Response(JSON.stringify(sdkFixtures.serverInfo.response), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = createAgentApiClient({
    fetch: {
      baseUrl: "https://raft.example/",
      fetch: fetchImpl,
      headers: { "x-sdk": "agent-api" },
      auth: (request) => ({ authorization: `Bearer ${request.routeKey}` }),
      retry: { attempts: 2 },
      throttle: {
        beforeRequest: (request) => {
          throttledRoutes.push(request.routeKey);
        },
      },
    },
  });

  const result = await client.server.info();
  assert.equal(result.ok, true);
  assert.equal(attempts, 2);
  assert.deepEqual(throttledRoutes, ["serverInfo"]);
  assert.deepEqual(fetchCalls.map((call) => call.url), [
    "https://raft.example/internal/agent-api/server",
    "https://raft.example/internal/agent-api/server",
  ]);
  const headers = fetchCalls[1].init.headers as Record<string, string>;
  assert.equal(fetchCalls[1].init.method, "GET");
  assert.equal(fetchCalls[1].init.body, undefined);
  assert.equal(headers.accept, "application/json");
  assert.equal(headers["x-sdk"], "agent-api");
  assert.equal(headers.authorization, "Bearer serverInfo");
});

test("SDK fetch transport handles binary contract responses", async () => {
  const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init: init ?? {} });
    return new Response(new Uint8Array([4, 5, 6]), {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    });
  };
  const client = createAgentApiClient({
    fetch: {
      baseUrl: "https://raft.example",
      fetch: fetchImpl,
    },
  });

  const result = await client.attachments.download({ attachmentId: "attachment/with space" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.data : null, new Uint8Array([4, 5, 6]));
  assert.deepEqual(fetchCalls.map((call) => call.url), [
    "https://raft.example/internal/agent-api/attachments/attachment%2Fwith%20space",
  ]);
  const headers = fetchCalls[0]?.init.headers as Record<string, string>;
  assert.equal(fetchCalls[0]?.init.method, "GET");
  assert.equal(headers.accept, "*/*");
});
