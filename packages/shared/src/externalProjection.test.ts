import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeExternalHandle,
  resolveExternalMention,
  type ExternalAddressabilityContext,
  type ExternalAddressabilityProjection,
} from "./externalProjection.js";
import {
  AGENT_API_EXTERNAL_MESSAGE_FORBIDDEN_AUTHORITY_FIELDS,
  agentApiMessageEnvelopeSchema,
  isAgentApiExternalMessageForbiddenAuthorityField,
} from "./agentApiContract.js";

const NOW = new Date("2026-07-24T00:00:00.000Z");

test("Agent API envelope validates structured external provenance as a closed inert fact", () => {
  const provenance = {
    schema: "external-message-provenance.v1",
    provider: "slack",
    workspace_id: "T-1",
    conversation_id: "C-1",
    message_id: "1722387723.000100",
    actor_id: "U-1",
    actor_kind: "human",
    projection_id: "00000000-0000-4000-8000-000000000001",
  } as const;
  const inertEnvelope = {
    senderType: "third_party_app",
    mentioned: false,
    external_message: provenance,
  };
  assert.equal(agentApiMessageEnvelopeSchema.parse(inertEnvelope).external_message?.actor_id, "U-1");
  assert.equal(agentApiMessageEnvelopeSchema.safeParse({
    ...inertEnvelope,
    external_message: { ...provenance, command: "task #1" },
  }).success, false);
  assert.equal(agentApiMessageEnvelopeSchema.safeParse({
    ...inertEnvelope,
    mentions: [{ targetType: "agent", targetId: "raw-authority" }],
  }).success, false);
  assert.equal(agentApiMessageEnvelopeSchema.safeParse({
    ...inertEnvelope,
    taskStatus: "todo",
  }).success, false);
  const independentlyRequiredForbiddenFields = [
    "searchText",
    "searchVector",
    "agentSendKey",
    "taskClaimedAt",
    "task_claimed_at",
    "taskCompletedAt",
    "task_completed_at",
    "claimedAt",
    "claimed_at",
    "completedAt",
    "completed_at",
    "taskFutureLifecycleAt",
    "task_future_lifecycle_at",
  ] as const;
  for (const forbiddenField of new Set([
    ...AGENT_API_EXTERNAL_MESSAGE_FORBIDDEN_AUTHORITY_FIELDS,
    ...independentlyRequiredForbiddenFields,
  ])) {
    assert.equal(agentApiMessageEnvelopeSchema.safeParse({
      ...inertEnvelope,
      [forbiddenField]: null,
    }).success, false, `external envelope accepted ${forbiddenField}`);
    assert.equal(
      isAgentApiExternalMessageForbiddenAuthorityField(forbiddenField),
      true,
      `shared projector policy accepted ${forbiddenField}`,
    );
  }
  assert.equal(isAgentApiExternalMessageForbiddenAuthorityField("createdAt"), false);
  assert.equal(isAgentApiExternalMessageForbiddenAuthorityField("senderType"), false);
  assert.equal(isAgentApiExternalMessageForbiddenAuthorityField("attachments"), false);
  assert.equal(agentApiMessageEnvelopeSchema.safeParse({
    ...inertEnvelope,
    sender_type: "third_party_app",
  }).success, true);
  assert.equal(agentApiMessageEnvelopeSchema.safeParse({
    ...inertEnvelope,
    sender_type: "external_projection",
  }).success, false);
  assert.equal(agentApiMessageEnvelopeSchema.safeParse({
    ...inertEnvelope,
    senderType: "external_projection",
    sender_type: "third_party_app",
  }).success, false);
  assert.equal(agentApiMessageEnvelopeSchema.safeParse({
    ...inertEnvelope,
    senderType: "third_party_app",
    sender_type: "external_projection",
  }).success, false);
  assert.equal(agentApiMessageEnvelopeSchema.safeParse({
    mentioned: false,
    external_message: provenance,
  }).success, false);
});

const context: ExternalAddressabilityContext = {
  provider: "slack",
  appRegistrationId: "app-1",
  installId: "install-1",
  workspaceId: "T-1",
  connectionEpoch: 3,
  bindingId: "binding-1",
  bindingEpoch: 4,
  conversationId: "C-1",
  memberRevision: 7,
  contextRevision: 9,
};

function candidate(
  projectionId: string,
  externalActorId: string,
  handles: readonly string[],
  overrides: Partial<ExternalAddressabilityProjection> = {},
): ExternalAddressabilityProjection {
  return {
    actor: {
      projectionId,
      provider: context.provider,
      appRegistrationId: context.appRegistrationId,
      installId: context.installId,
      workspaceId: context.workspaceId,
      externalActorId,
      displayName: `Display ${projectionId}`,
      handles,
      state: "active",
      actorKind: "human",
      deactivated: false,
      ...overrides.actor,
    },
    context: {
      ...context,
      ...overrides.context,
    },
    state: overrides.state ?? "active",
    observedAt: overrides.observedAt ?? "2026-07-23T23:55:00.000Z",
    expiresAt: overrides.expiresAt ?? "2026-07-24T00:05:00.000Z",
  };
}

test("normalizes deterministic Slack-style handles without accepting free text", () => {
  assert.equal(normalizeExternalHandle("  @Alice.Example  "), "alice.example");
  assert.equal(normalizeExternalHandle("@@OPS_bot"), "ops_bot");
  assert.equal(normalizeExternalHandle("@"), null);
  assert.equal(normalizeExternalHandle("@alice example"), null);
});

test("structured external selection resolves stable identity even when the lexical handle collides with Raft", () => {
  const result = resolveExternalMention({
    rawHandle: "@alice",
    explicitProjectionId: "projection-1",
    raftPrincipalCollision: true,
    context,
    candidates: [candidate("projection-1", "U-1", ["alice"])],
    now: NOW,
  });

  assert.equal(result.kind, "resolved");
  if (result.kind !== "resolved") return;
  assert.deepEqual(result.fact, {
    projectionId: "projection-1",
    provider: "slack",
    appRegistrationId: "app-1",
    installId: "install-1",
    workspaceId: "T-1",
    externalActorId: "U-1",
    connectionEpoch: 3,
    bindingId: "binding-1",
    bindingEpoch: 4,
    conversationId: "C-1",
    memberRevision: 7,
    contextRevision: 9,
    freshnessObservedAt: "2026-07-23T23:55:00.000Z",
    freshnessExpiresAt: "2026-07-24T00:05:00.000Z",
    handleAtSendTime: "@alice",
    resolutionReason: "explicit_projection",
  });
});

test("stable actor identity survives rebind while old addressability context stays fenced", () => {
  const oldContextCandidate = candidate("projection-1", "U-stable", ["alice"], {
    context: {
      ...context,
      connectionEpoch: 2,
      bindingId: "binding-old",
      bindingEpoch: 3,
      conversationId: "C-old",
      memberRevision: 6,
      contextRevision: 8,
    },
  });
  const currentContextCandidate = candidate("projection-1", "U-stable", ["alice"]);

  const result = resolveExternalMention({
    rawHandle: "@alice",
    explicitProjectionId: "projection-1",
    raftPrincipalCollision: false,
    context,
    candidates: [oldContextCandidate, currentContextCandidate],
    now: NOW,
  });

  assert.equal(result.kind, "resolved");
  if (result.kind !== "resolved") return;
  assert.equal(result.fact.projectionId, "projection-1");
  assert.equal(result.fact.externalActorId, "U-stable");
  assert.equal(result.fact.connectionEpoch, 3);
  assert.equal(result.fact.bindingId, "binding-1");
  assert.equal(result.fact.memberRevision, 7);
  assert.equal(result.fact.contextRevision, 9);

  assert.deepEqual(
    resolveExternalMention({
      rawHandle: "@alice",
      explicitProjectionId: "projection-1",
      raftPrincipalCollision: false,
      context,
      candidates: [oldContextCandidate],
      now: NOW,
    }),
    { kind: "not_resolved", reason: "context_mismatch" },
  );
});

test("structured external selection fails closed when two current addressability rows claim one stable projection", () => {
  assert.deepEqual(
    resolveExternalMention({
      rawHandle: "@alice",
      explicitProjectionId: "projection-1",
      raftPrincipalCollision: false,
      context,
      candidates: [
        candidate("projection-1", "U-stable", ["alice"]),
        candidate("projection-1", "U-stable", ["alice.old"]),
      ],
      now: NOW,
    }),
    { kind: "not_resolved", reason: "projection_ambiguous" },
  );
});

test("a dangling handle resolves only one fresh current-context member projection", () => {
  const result = resolveExternalMention({
    rawHandle: "@ALICE",
    raftPrincipalCollision: false,
    context,
    candidates: [
      candidate("projection-1", "U-1", ["alice", "alice.old"]),
      candidate("projection-2", "U-2", ["bob"]),
    ],
    now: NOW,
  });

  assert.equal(result.kind, "resolved");
  if (result.kind !== "resolved") return;
  assert.equal(result.fact.externalActorId, "U-1");
  assert.equal(result.fact.resolutionReason, "unique_dangling_handle");
});

test("a Raft principal collision blocks dangling-handle translation before external matching", () => {
  assert.deepEqual(
    resolveExternalMention({
      rawHandle: "@alice",
      raftPrincipalCollision: true,
      context,
      candidates: [candidate("projection-1", "U-1", ["alice"])],
      now: NOW,
    }),
    { kind: "not_resolved", reason: "raft_principal_collision" },
  );
});

test("multiple fresh external matches fail closed", () => {
  assert.deepEqual(
    resolveExternalMention({
      rawHandle: "@alice",
      raftPrincipalCollision: false,
      context,
      candidates: [
        candidate("projection-1", "U-1", ["alice"]),
        candidate("projection-2", "U-2", ["ALICE"]),
      ],
      now: NOW,
    }),
    { kind: "not_resolved", reason: "ambiguous_external_match" },
  );
});

test("display names are not fallback identity keys", () => {
  assert.deepEqual(
    resolveExternalMention({
      rawHandle: "@alice",
      raftPrincipalCollision: false,
      context,
      candidates: [
        candidate("projection-1", "U-1", ["different"], {
          actor: {
            ...candidate("projection-1", "U-1", ["different"]).actor,
            displayName: "alice",
          },
        }),
      ],
      now: NOW,
    }),
    { kind: "not_resolved", reason: "no_external_match" },
  );
});

test("each addressability authority dimension is independently fenced", () => {
  const mismatches: Array<[keyof ExternalAddressabilityContext, string | number]> = [
    ["provider", "other-provider"],
    ["appRegistrationId", "app-other"],
    ["installId", "install-other"],
    ["workspaceId", "T-other"],
    ["connectionEpoch", 2],
    ["bindingId", "binding-old"],
    ["bindingEpoch", 3],
    ["conversationId", "C-other"],
    ["memberRevision", 6],
    ["contextRevision", 8],
  ];

  for (const [key, value] of mismatches) {
    const wrongContext = candidate("projection-1", "U-1", ["alice"], {
      context: {
        ...context,
        [key]: value,
      },
    });
    assert.deepEqual(
      resolveExternalMention({
        rawHandle: "@alice",
        raftPrincipalCollision: false,
        context,
        candidates: [wrongContext],
        now: NOW,
      }),
      { kind: "not_resolved", reason: "context_mismatch" },
      `expected ${key} mismatch to fail closed`,
    );
  }
});

test("actor identity cannot be spliced into a different addressability context", () => {
  const mismatches = [
    { provider: "other-provider" },
    { appRegistrationId: "app-other" },
    { installId: "install-other" },
    { workspaceId: "T-other" },
  ];

  for (const actorMismatch of mismatches) {
    const baseCandidate = candidate("projection-1", "U-1", ["alice"]);
    const splicedCandidate = candidate("projection-1", "U-1", ["alice"], {
      actor: {
        ...baseCandidate.actor,
        ...actorMismatch,
      },
    });
    assert.deepEqual(
      resolveExternalMention({
        rawHandle: "@alice",
        raftPrincipalCollision: false,
        context,
        candidates: [splicedCandidate],
        now: NOW,
      }),
      { kind: "not_resolved", reason: "context_mismatch" },
    );
  }
});

test("stale, removed, tombstoned, and non-human candidates fail closed", () => {
  const cases: Array<[ExternalAddressabilityProjection, string]> = [
    [candidate("stale", "U-1", ["alice"], { expiresAt: "2026-07-23T23:59:59.000Z" }), "projection_stale"],
    [candidate("removed", "U-1", ["alice"], { state: "removed" }), "membership_not_active"],
    [candidate("dead", "U-1", ["alice"], {
      actor: {
        ...candidate("dead", "U-1", ["alice"]).actor,
        state: "tombstoned",
      },
    }), "actor_not_active"],
    [candidate("guest", "U-1", ["alice"], {
      actor: {
        ...candidate("guest", "U-1", ["alice"]).actor,
        actorKind: "guest",
      },
    }), "actor_not_m0_addressable"],
  ];

  for (const [externalCandidate, expectedReason] of cases) {
    assert.deepEqual(
      resolveExternalMention({
        rawHandle: "@alice",
        raftPrincipalCollision: false,
        context,
        candidates: [externalCandidate],
        now: NOW,
      }),
      { kind: "not_resolved", reason: expectedReason },
    );
  }
});

test("worker-time callers can dispatch from the frozen stable ID without handle re-resolution", () => {
  const result = resolveExternalMention({
    rawHandle: "@alice",
    raftPrincipalCollision: false,
    context,
    candidates: [candidate("projection-1", "U-stable", ["alice"])],
    now: NOW,
  });
  assert.equal(result.kind, "resolved");
  if (result.kind !== "resolved") return;

  const persistedFact = structuredClone(result.fact);
  assert.equal(persistedFact.externalActorId, "U-stable");
  assert.equal(persistedFact.connectionEpoch, 3);
  assert.equal(persistedFact.bindingEpoch, 4);
  assert.equal(persistedFact.memberRevision, 7);
  assert.equal(persistedFact.contextRevision, 9);
  assert.equal(persistedFact.freshnessObservedAt, "2026-07-23T23:55:00.000Z");
  assert.equal(persistedFact.freshnessExpiresAt, "2026-07-24T00:05:00.000Z");
  assert.equal("displayName" in persistedFact, false);
  assert.equal("email" in persistedFact, false);
  assert.equal("memberId" in persistedFact, false);
});
