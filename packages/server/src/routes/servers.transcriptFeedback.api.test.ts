import { tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { FEEDBACK_REPORT_SESSION_RECORD_EVENT } from "@botiverse/raft-shared";
import type { FeedbackTranscriptUploadOutcome } from "@botiverse/raft-shared";
import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { serverMembers, users } from "../db/schema";
import { recordEmits } from "../test/linkCardActionFixture";
import { seedPlaywrightScenario } from "../test/seedPlaywrightScenario";
import type { createTestApp } from "../test/integration/app";
import type { AgentOrchestrator } from "../services/agentOrchestrator";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

type CollectFeedbackTranscript = AgentOrchestrator["collectFeedbackTranscript"];
type CollectionOutcome = Awaited<ReturnType<CollectFeedbackTranscript>>;

function typedOutcome(upload: Partial<FeedbackTranscriptUploadOutcome>): CollectionOutcome {
  return {
    reachable: true,
    outcomeVersion: 1,
    upload: { status: "not_attempted", reason: null, stage: null, httpStatus: null, httpClass: null, uploadId: null, contentLabel: null, ...upload },
  };
}

/** The route's continuation hangs off the collection's promise: one turn of the event loop has run it. */
const continuationRan = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Posts the request with a collection the test settles itself, so what the
 * route does before and after the agent's computer answers can be told apart.
 * The reporter is the machine's owner, or (`as: "admin"`) another member who
 * may ask: an admin who neither owns the machine nor created the agent.
 */
async function requestSessionRecord(app: Awaited<ReturnType<typeof createTestApp>>, options: { as?: "owner" | "admin" } = {}) {
  const seed = await seedPlaywrightScenario();
  const [owner] = await getDb().select({ id: users.id }).from(users).where(eq(users.email, seed.user.email));
  assert.ok(owner, "the seeded machine owner exists");
  const asAdmin = options.as === "admin";
  if (asAdmin) {
    await getDb().update(serverMembers).set({ role: "admin" })
      .where(and(eq(serverMembers.serverId, seed.server.id), eq(serverMembers.userId, seed.extraHuman.userId)));
  }
  const token = await tokenForHuman(asAdmin ? seed.extraHuman.email : seed.user.email);
  const emits = recordEmits(app.io);
  let resolveCollection!: (outcome: CollectionOutcome) => void;
  let rejectCollection!: (err: Error) => void;
  let collections = 0;
  (app.app.get("agentOrchestrator") as AgentOrchestrator).collectFeedbackTranscript = () => {
    collections += 1;
    return new Promise<CollectionOutcome>((resolve, reject) => {
      resolveCollection = resolve;
      rejectCollection = reject;
    });
  };
  const reportId = randomUUID();
  const res = await fetch(
    `${app.baseUrl}/api/servers/${seed.server.id}/machines/${seed.machine.id}/agents/${seed.agent.id}/feedback/${reportId}/transcript`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Server-Id": seed.server.id,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    },
  );
  const body = await res.json() as Record<string, unknown>;
  assert.equal(collections, 1, `the collection was started once (${res.status} ${JSON.stringify(body)})`);
  return {
    status: res.status,
    body,
    reportId,
    agentId: seed.agent.id,
    reporterId: asAdmin ? seed.extraHuman.userId : owner.id,
    machineOwnerId: owner.id,
    /** Every session record push sent so far, through the app's Socket.IO server. */
    pushes: () => emits.filter((emit) => emit.event === FEEDBACK_REPORT_SESSION_RECORD_EVENT),
    computerAnswers: async (outcome: CollectionOutcome) => {
      resolveCollection(outcome);
      await continuationRan();
    },
    collectionFails: async (err: Error) => {
      rejectCollection(err);
      await continuationRan();
    },
  };
}

/** Everything that would show the route's continuation failing after the request was answered. */
function watchForStrayErrors() {
  const errors: unknown[] = [];
  const onError = (reason: unknown) => errors.push(reason);
  process.on("unhandledRejection", onError);
  process.on("uncaughtException", onError);
  return {
    errors,
    stop: () => {
      process.off("unhandledRejection", onError);
      process.off("uncaughtException", onError);
    },
  };
}

test("POST /api/servers/:id/machines/:machineId/agents/:agentId/feedback/:reportId/transcript accepts and fire-and-forgets collection", async ({ app }) => {
  const seed = await seedPlaywrightScenario();
  const token = await tokenForHuman(seed.user.email);
  const orchestrator = app.app.get("agentOrchestrator") as AgentOrchestrator;

  const called: {
    agentId?: string;
    feedbackReportId?: string;
    reportGeneratedAt?: string;
    reportTimeSource?: string;
  } = {};
  orchestrator.collectFeedbackTranscript = async (agentId, feedbackReportId, reportWindow) => {
    called.agentId = agentId;
    called.feedbackReportId = feedbackReportId;
    called.reportGeneratedAt = reportWindow.reportGeneratedAt;
    called.reportTimeSource = reportWindow.reportTimeSource;
    return { reachable: true, traceBundleId: "test-trace-bundle-id" };
  };

  const reportId = randomUUID();
  const reportGeneratedAt = "2026-07-20T16:40:04.797Z";
  const res = await fetch(
    `${app.baseUrl}/api/servers/${seed.server.id}/machines/${seed.machine.id}/agents/${seed.agent.id}/feedback/${reportId}/transcript`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Server-Id": seed.server.id,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reportGeneratedAt }),
    },
  );

  assert.equal(res.status, 202);
  const body = await res.json() as { accepted: boolean; feedbackReportId: string; agentId: string };
  assert.equal(body.accepted, true);
  assert.equal(body.feedbackReportId, reportId);
  assert.equal(body.agentId, seed.agent.id);
  assert.equal(called.agentId, seed.agent.id);
  assert.equal(called.feedbackReportId, reportId);
  assert.equal(called.reportGeneratedAt, reportGeneratedAt);
  assert.equal(called.reportTimeSource, "web_report_bundle");
});

test("POST /feedback/:reportId/transcript rejects malformed report-window timestamps", async ({ app }) => {
  const seed = await seedPlaywrightScenario();
  const token = await tokenForHuman(seed.user.email);
  const reportId = randomUUID();
  const res = await fetch(
    `${app.baseUrl}/api/servers/${seed.server.id}/machines/${seed.machine.id}/agents/${seed.agent.id}/feedback/${reportId}/transcript`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Server-Id": seed.server.id,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reportGeneratedAt: "not-a-timestamp" }),
    },
  );
  assert.equal(res.status, 400);
});

test("POST /feedback/:reportId/transcript refuses a report id that is not a UUID before reaching the daemon", async ({ app }) => {
  const seed = await seedPlaywrightScenario();
  const token = await tokenForHuman(seed.user.email);
  for (const reportId of ["report-1", encodeURIComponent("../x")]) {
    const res = await fetch(
      `${app.baseUrl}/api/servers/${seed.server.id}/machines/${seed.machine.id}/agents/${seed.agent.id}/feedback/${reportId}/transcript`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Server-Id": seed.server.id,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      },
    );
    // guardUuidPathParams answers a uniform 404 for non-UUID path params.
    assert.equal(res.status, 404, `${reportId}: ${res.status} ${await res.text()}`);
  }
});

test("POST /feedback/:reportId/transcript rejects non-admin/non-creator members", async ({ app }) => {
  const seed = await seedPlaywrightScenario();
  const extraToken = await tokenForHuman(seed.extraHuman.email);

  const reportId = randomUUID();
  const res = await fetch(
    `${app.baseUrl}/api/servers/${seed.server.id}/machines/${seed.machine.id}/agents/${seed.agent.id}/feedback/${reportId}/transcript`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${extraToken}`,
        "X-Server-Id": seed.server.id,
      },
    },
  );

  assert.equal(res.status, 403);
});

// The route answers 202 before the agent's computer does anything. When the
// computer answers with a typed outcome, what it said about the session record
// goes to the reporter's own connections, once; anything else pushes nothing.
for (const [name, upload, sessionRecord] of [
  ["stored", { status: "stored", uploadId: "upload-1", contentLabel: "signed" }, "attached"],
  ["not attempted because the lookup read nothing", { status: "not_attempted", reason: "lookup_failed" }, "not_attached"],
  ["not attempted because no worker is configured", { status: "not_attempted", reason: "worker_not_configured" }, "not_attached"],
  ["failed", { status: "failed", reason: "upload_failed", stage: "put", httpStatus: 503, httpClass: "5xx" }, "not_attached"],
] as const satisfies ReadonlyArray<readonly [string, Partial<FeedbackTranscriptUploadOutcome>, string]>) {
  test(`POST /feedback/:reportId/transcript answers 202 at once, then pushes sessionRecord=${sessionRecord} to the reporter when the computer's upload is ${name}`, async ({ app }) => {
    const request = await requestSessionRecord(app);

    // Answered while the collection is still running: the same 202 as ever, and nothing pushed yet.
    assert.equal(request.status, 202);
    assert.deepEqual(request.body, { accepted: true, feedbackReportId: request.reportId, agentId: request.agentId });
    assert.deepEqual(request.pushes(), []);

    await request.computerAnswers(typedOutcome(upload));

    assert.deepEqual(request.pushes(), [{
      room: `user:${request.reporterId}`,
      event: FEEDBACK_REPORT_SESSION_RECORD_EVENT,
      payload: { feedbackReportId: request.reportId, sessionRecord },
    }]);
  });
}

test("POST /feedback/:reportId/transcript pushes to the member who asked, not to the machine's owner", async ({ app }) => {
  const request = await requestSessionRecord(app, { as: "admin" });
  assert.equal(request.status, 202);
  assert.notEqual(request.reporterId, request.machineOwnerId);

  await request.computerAnswers(typedOutcome({ status: "stored", uploadId: "upload-1", contentLabel: "signed" }));

  assert.deepEqual(request.pushes().map((push) => push.room), [`user:${request.reporterId}`]);
});

test("POST /feedback/:reportId/transcript pushes nothing for an untyped outcome (an older computer)", async ({ app }) => {
  const request = await requestSessionRecord(app);
  assert.equal(request.status, 202);

  await request.computerAnswers({ reachable: true, traceBundleId: "test-trace-bundle-id" });

  assert.deepEqual(request.pushes(), []);
});

test("POST /feedback/:reportId/transcript pushes nothing when the collection fails, and nothing is left unhandled", async ({ app }) => {
  const stray = watchForStrayErrors();
  try {
    const request = await requestSessionRecord(app);
    assert.equal(request.status, 202);

    await request.collectionFails(new Error("Feedback transcript request timed out"));

    assert.deepEqual(request.pushes(), []);
    assert.deepEqual(stray.errors, []);
  } finally {
    stray.stop();
  }
});

test("POST /feedback/:reportId/transcript leaves nothing unhandled when the socket server throws on the push", async ({ app }) => {
  const stray = watchForStrayErrors();
  const to = app.io.to;
  try {
    const request = await requestSessionRecord(app);
    assert.equal(request.status, 202);
    let attempts = 0;
    app.io.to = (() => {
      attempts += 1;
      throw new Error("adapter down");
    }) as typeof app.io.to;

    await request.computerAnswers(typedOutcome({ status: "stored", uploadId: "upload-1", contentLabel: "signed" }));

    assert.equal(attempts, 1, "the push was attempted");
    assert.deepEqual(stray.errors, []);
  } finally {
    app.io.to = to;
    stray.stop();
  }
});

test("POST /feedback/:reportId/transcript with no socket server on the app answers 202 and sends nothing", async ({ app }) => {
  const stray = watchForStrayErrors();
  const io = app.app.get("io");
  try {
    app.app.set("io", undefined);
    const request = await requestSessionRecord(app);
    assert.equal(request.status, 202);

    await request.computerAnswers(typedOutcome({ status: "stored", uploadId: "upload-1", contentLabel: "signed" }));

    // The recorder sits on the server the app no longer hands out: nothing reached it.
    assert.deepEqual(request.pushes(), []);
    assert.deepEqual(stray.errors, []);
  } finally {
    app.app.set("io", io);
    stray.stop();
  }
});
