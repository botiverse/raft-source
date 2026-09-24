import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { afterEach } from "vitest";
import { getDb } from "../db/index.js";
import { agents, channels, productFeedbackLocators, servers, users } from "../db/schema.js";
import {
  FEEDBACK_LOCATOR_ARTIFACT_KIND,
  FEEDBACK_LOCATOR_EVENT_KIND,
  FeedbackLocatorIngestError,
  ingestFeedbackLocator,
  parseFeedbackLocatorEnvelope,
  queryFeedbackLocators,
} from "./productFeedbackLocatorService.js";


const OWNER_ID = "00000000-0000-4000-8000-000000000001";
const SERVER_ID = "00000000-0000-4000-8000-000000000002";
const AGENT_ID = "00000000-0000-4000-8000-000000000003";
const REPORT_ID = "00000000-0000-4000-8000-000000000004";
const SESSION_ID = "00000000-0000-4000-8000-000000000005";
const INVOCATION_ID = "00000000-0000-4000-8000-000000000006";
const SHAPE_SHA = "a".repeat(64);
const SERVED_SHA = "b".repeat(64);

// Deliberately declared here rather than imported from producer/shared code.
// This fixture is the consumer-side compatibility oracle for the frozen wire
// contract.
function consumerFixture(reportId = REPORT_ID): Record<string, unknown> {
  return {
    schema_version: "raft.feedback.locator.v0",
    report_id: reportId,
    captured_at: "2026-08-09T02:30:00.000Z",
    producer: {
      surface: "raft_cli",
      server_id: SERVER_ID,
      agent_id: AGENT_ID,
    },
    capture_invocation: {
      invocation_id: INVOCATION_ID,
      command_family: "feedback",
      arguments: [{ name: "did", type: "string", shape: "scalar" }],
      canonical_shape_sha256: SHAPE_SHA,
    },
    locators: {
      l0: {
        runtime: "codex",
        identity: { status: "present", session_id: SESSION_ID },
        native: {
          status: "unreachable",
          lookup_method: "codex_jsonl",
          locator_kind: "file",
          reason_code: "not_found",
        },
        handoff: { status: "present" },
      },
      l1: {
        turn: { status: "unsupported", reason_code: "runtime_turn_contract_unavailable" },
        trace: { status: "unsupported", reason_code: "runtime_trace_contract_unavailable" },
      },
      l2: {
        subject_call: { status: "unavailable", reason_code: "subject_call_anchor_missing" },
      },
    },
    exacts: [{
      surface: "manual",
      status: "retained",
      provenance: "served",
      sha256: SERVED_SHA,
      as_of: "2026-08-09T02:29:00.000Z",
      retest_trigger: "served_bytes_changed",
    }],
    route: {
      resolution: {
        status: "resolved",
        target: { kind: "public_channel", ref: "#proj-feedback" },
        basis: "configured_project_channel",
      },
      delivery: {
        status: "dispatched_unconfirmed",
        reason_code: "fire_and_forget_no_receipt",
      },
    },
    transport: {
      artifact_kind: FEEDBACK_LOCATOR_ARTIFACT_KIND,
      event_kind: FEEDBACK_LOCATOR_EVENT_KIND,
    },
  };
}

function envelope(payload: unknown = consumerFixture()) {
  return {
    artifact_kind: FEEDBACK_LOCATOR_ARTIFACT_KIND,
    event_kind: FEEDBACK_LOCATOR_EVENT_KIND,
    payload,
  };
}

function rejectionReason(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    assert.ok(error instanceof FeedbackLocatorIngestError);
    return error.reasonCode;
  }
}

afterEach(async () => {
  await closeTestDatabase();
});

test("independent consumer schema accepts the frozen locator-only fixture", () => {
  const parsed = parseFeedbackLocatorEnvelope(envelope());
  assert.equal(parsed.report_id, REPORT_ID);
  assert.equal(parsed.locators.l0.runtime, "codex");
});

test("independent consumer accepts the final producer exact byte shape", () => {
  const payload = {
    schema_version: "raft.feedback.locator.v0",
    report_id: "11111111-1111-4111-8111-111111111111",
    captured_at: "2026-08-09T02:00:00.000Z",
    producer: {
      surface: "raft_cli",
      server_id: "server-1",
      agent_id: "agent-1",
      machine_id: "machine-1",
      launch_id: "launch-1",
    },
    capture_invocation: {
      invocation_id: "invocation-1",
      command_family: "feedback",
      arguments: [{ name: "route", type: "string", shape: "scalar" }],
      canonical_shape_sha256: SHAPE_SHA,
    },
    locators: {
      l0: {
        runtime: "claude",
        identity: { status: "unavailable", reason_code: "session_identity_unavailable" },
        native: { status: "not_attempted", reason_code: "session_identity_unavailable" },
        handoff: { status: "not_attempted", reason_code: "session_identity_unavailable" },
      },
      l1: {
        turn: { status: "unsupported", reason_code: "runtime_turn_contract_unavailable" },
        trace: { status: "unsupported", reason_code: "runtime_trace_contract_unavailable" },
      },
      l2: {
        subject_call: {
          status: "available",
          provenance: "reporter_declared",
          command_family: "message-send",
          arguments: [{ name: "target", type: "string", shape: "scalar" }],
          canonical_shape_sha256: SHAPE_SHA,
        },
      },
    },
    exacts: [{ surface: "manual", status: "not_applicable" }],
    route: {
      resolution: {
        status: "resolved",
        target: { kind: "public_channel", ref: "#proj-feedback" },
        basis: "configured_project_channel",
      },
      delivery: { status: "dispatched_unconfirmed", reason_code: "fire_and_forget_no_receipt" },
    },
    transport: {
      artifact_kind: "raft-feedback-locator-v0",
      event_kind: "feedback-locator:created",
    },
  };
  assert.deepEqual(parseFeedbackLocatorEnvelope(envelope(payload)), payload);
});

test("consumer fails closed with typed version, forbidden-field, private-ref, and discriminant reasons", () => {
  assert.equal(rejectionReason(() => parseFeedbackLocatorEnvelope({
    ...envelope(), artifact_kind: "raft-feedback-locator-v1",
  })), "unknown_artifact_kind");
  assert.equal(rejectionReason(() => parseFeedbackLocatorEnvelope({
    ...envelope(), event_kind: "feedback-locator:updated",
  })), "unknown_event_kind");

  const unknownVersion = structuredClone(consumerFixture());
  unknownVersion.schema_version = "raft.feedback.locator.v999";
  assert.equal(rejectionReason(() => parseFeedbackLocatorEnvelope(envelope(unknownVersion))), "unknown_schema_version");

  const forbidden = structuredClone(consumerFixture()) as any;
  forbidden.locators.l2.subject_call.value = "secret body";
  assert.equal(rejectionReason(() => parseFeedbackLocatorEnvelope(envelope(forbidden))), "forbidden_field");

  const privateRef = structuredClone(consumerFixture()) as any;
  privateRef.route.resolution.target = { kind: "private_channel", ref: "#private" };
  assert.equal(rejectionReason(() => parseFeedbackLocatorEnvelope(envelope(privateRef))), "invalid_route_ref");

  const unconfiguredPublicRef = structuredClone(consumerFixture()) as any;
  unconfiguredPublicRef.route.resolution.target.ref = "#other-public";
  unconfiguredPublicRef.route.resolution.basis = "explicit_public_channel";
  assert.equal(
    rejectionReason(() => parseFeedbackLocatorEnvelope(envelope(unconfiguredPublicRef))),
    "invalid_route_ref",
  );

  const impossibleL0 = structuredClone(consumerFixture()) as any;
  impossibleL0.locators.l0.identity = {
    status: "unavailable",
    reason_code: "session_identity_unavailable",
  };
  assert.equal(rejectionReason(() => parseFeedbackLocatorEnvelope(envelope(impossibleL0))), "invalid_payload");
});

test("ingest binds producer identity to the credential and rejects post-receipt delivery states", async () => {
  const mismatchedProducer = structuredClone(consumerFixture()) as any;
  mismatchedProducer.producer.agent_id = "00000000-0000-4000-8000-000000000099";
  await assert.rejects(
    ingestFeedbackLocator({
      serverId: SERVER_ID,
      agentId: AGENT_ID,
      artifactKind: FEEDBACK_LOCATOR_ARTIFACT_KIND,
      eventKind: FEEDBACK_LOCATOR_EVENT_KIND,
      payload: mismatchedProducer,
    }),
    (error: unknown) => error instanceof FeedbackLocatorIngestError
      && error.reasonCode === "invalid_payload",
  );

  for (const delivery of [
    { status: "accepted", receipt_id: "00000000-0000-4000-8000-000000000077" },
    { status: "failed", reason_code: "api_rejected" },
  ]) {
    const postReceipt = structuredClone(consumerFixture()) as any;
    postReceipt.route.delivery = delivery;
    await assert.rejects(
      ingestFeedbackLocator({
        serverId: SERVER_ID,
        agentId: AGENT_ID,
        artifactKind: FEEDBACK_LOCATOR_ARTIFACT_KIND,
        eventKind: FEEDBACK_LOCATOR_EVENT_KIND,
        payload: postReceipt,
      }),
      (error: unknown) => error instanceof FeedbackLocatorIngestError
        && error.reasonCode === "invalid_payload",
    );
  }
});

async function seedDatabase(publicConfiguredRoute = true): Promise<void> {
  await openTestDatabase("pglite://");
  const db = getDb();
  await db.insert(users).values({
    id: OWNER_ID,
    email: "feedback-locator-owner@example.test",
    name: "feedback_locator_owner",
    passwordHash: "test",
  });
  await db.insert(servers).values({
    id: SERVER_ID,
    name: "Feedback Locator Test",
    slug: "feedback-locator-test",
    ownerId: OWNER_ID,
  });
  await db.insert(agents).values({
    id: AGENT_ID,
    serverId: SERVER_ID,
    name: "FeedbackLocatorAgent",
  });
  await db.insert(channels).values({
    serverId: SERVER_ID,
    name: "proj-feedback",
    type: publicConfiguredRoute ? "channel" : "private",
  });
  await db.insert(channels).values({
    serverId: SERVER_ID,
    name: "secret-feedback",
    type: "private",
  });
}

test("configured route must resolve to a live public channel in the credential server", async () => {
  await seedDatabase(false);
  await assert.rejects(
    ingestFeedbackLocator({
      serverId: SERVER_ID,
      agentId: AGENT_ID,
      artifactKind: FEEDBACK_LOCATOR_ARTIFACT_KIND,
      eventKind: FEEDBACK_LOCATOR_EVENT_KIND,
      payload: consumerFixture(),
    }),
    (error: unknown) => error instanceof FeedbackLocatorIngestError
      && error.reasonCode === "invalid_route_ref",
  );
  const rows = await getDb().select().from(productFeedbackLocators);
  assert.equal(rows.length, 0);
});

test("index and acceptance receipt commit atomically, duplicates reuse the receipt, and conflicts fail", async () => {
  await seedDatabase();
  const first = await ingestFeedbackLocator({
    serverId: SERVER_ID,
    agentId: AGENT_ID,
    artifactKind: FEEDBACK_LOCATOR_ARTIFACT_KIND,
    eventKind: FEEDBACK_LOCATOR_EVENT_KIND,
    payload: consumerFixture(),
  });
  assert.equal(first.status, "accepted");
  assert.equal(first.report_id, REPORT_ID);
  assert.equal(first.duplicate, false);

  const duplicate = await ingestFeedbackLocator({
    serverId: SERVER_ID,
    agentId: AGENT_ID,
    artifactKind: FEEDBACK_LOCATOR_ARTIFACT_KIND,
    eventKind: FEEDBACK_LOCATOR_EVENT_KIND,
    payload: consumerFixture(),
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.receipt_id, first.receipt_id);

  const indexed = await queryFeedbackLocators({
    serverId: SERVER_ID,
    reportId: REPORT_ID,
    runtime: "codex",
    nativeStatus: "unreachable",
    nativeLookupMethod: "codex_jsonl",
    hasServedExact: true,
    servedExactSha256: SERVED_SHA,
    routeBasis: "configured_project_channel",
  });
  assert.equal(indexed.length, 1);
  assert.equal(indexed[0]?.receiptId, first.receipt_id);

  const conflicting = consumerFixture();
  conflicting.captured_at = "2026-08-09T02:31:00.000Z";
  await assert.rejects(
    ingestFeedbackLocator({
      serverId: SERVER_ID,
      agentId: AGENT_ID,
      artifactKind: FEEDBACK_LOCATOR_ARTIFACT_KIND,
      eventKind: FEEDBACK_LOCATOR_EVENT_KIND,
      payload: conflicting,
    }),
    (error: unknown) => error instanceof FeedbackLocatorIngestError
      && error.reasonCode === "report_identity_conflict",
  );

  const disguisedPrivate = consumerFixture("00000000-0000-4000-8000-000000000088") as any;
  disguisedPrivate.route.resolution.target.ref = "#secret-feedback";
  await assert.rejects(
    ingestFeedbackLocator({
      serverId: SERVER_ID,
      agentId: AGENT_ID,
      artifactKind: FEEDBACK_LOCATOR_ARTIFACT_KIND,
      eventKind: FEEDBACK_LOCATOR_EVENT_KIND,
      payload: disguisedPrivate,
    }),
    (error: unknown) => error instanceof FeedbackLocatorIngestError
      && error.reasonCode === "invalid_route_ref",
  );
});

test("forced pre-commit failure returns storage_failed and leaves no index or receipt", async () => {
  await seedDatabase();
  const reportId = "00000000-0000-4000-8000-000000000099";
  await assert.rejects(
    ingestFeedbackLocator({
      serverId: SERVER_ID,
      agentId: AGENT_ID,
      artifactKind: FEEDBACK_LOCATOR_ARTIFACT_KIND,
      eventKind: FEEDBACK_LOCATOR_EVENT_KIND,
      payload: consumerFixture(reportId),
    }, {
      beforeCommit: () => { throw new Error("forced failure"); },
    }),
    (error: unknown) => error instanceof FeedbackLocatorIngestError
      && error.reasonCode === "storage_failed",
  );
  const rows = await getDb().select().from(productFeedbackLocators);
  assert.equal(rows.length, 0);
});
