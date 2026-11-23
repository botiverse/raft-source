import { parseSlackAttachmentFallbackDeployment } from "./slackAttachmentFallbackDeployment";
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { and, eq, sql } from "drizzle-orm";
import {
  attachmentObjects,
  attachments,
  externalAppCredentials,
  externalAttachmentTransferJobs,
  externalOutboundDeliveries,
  slackAttachmentFallbackPlans,
  slackAttachmentPlanRollout,
  messages,
  serverMembers,
  users,
} from "../db/schema";
import { createSlackBridgeDatabaseOutboundRuntime } from "./slackBridgeDatabaseOutboundRuntime";
import { processExternalDeliveryPartitionHead, __setExternalDeliveryAttemptRowLockHookForTests } from "./externalDeliveryWorkerService";
import { enqueueSlackBridgeOutboundDelivery, mintSlackBridgeReconciliationMarker } from "./externalDeliveryOutboxService";
import { createSlackBridgeProviderRuntime } from "./slackBridgeProviderRuntime";
import { createSlackBridgeEnvCredentialCipher } from "./slackBridgeEnvSecrets";
import { __setStorageForTests, resetStorageForTests } from "./storageService";
import { NOW, fixture, reauthorizeSamePair, resolveCurrentOutboundAuthorityOrNull, waitForControlState } from "./slackBridgeDatabaseRuntimeAuthority.testkit";

afterEach(async () => {
  __setExternalDeliveryAttemptRowLockHookForTests(null);
  resetStorageForTests();
  await closeTestDatabase();
});

for (const scenario of [
  { missingCount: 0, hashless: false, unknown: false, deploymentRepair: true },
  { missingCount: 0, hashless: false, unknown: false, planningOff: true, resetUploadOnce: true },
  { missingCount: 0, hashless: false, unknown: false, planningOff: true, slowRead: true },
  { missingCount: 0, hashless: false, unknown: false, planningOff: true, slowUpload: true },
  { missingCount: 0, hashless: false, unknown: false, slowUpload: true },
  { missingCount: 0, hashless: false, unknown: false, corruptSource: true },
  { missingCount: 0, hashless: false, unknown: false },
  { missingCount: 0, hashless: false, unknown: false, ticketDeniedOnce: true },
  { missingCount: 0, hashless: false, unknown: false, emptyBody: true },
  { missingCount: 2, hashless: false, unknown: false, emptyBody: true },
  { missingCount: 1, hashless: false, unknown: false, transient: false, missingLast: false },
  { missingCount: 1, hashless: false, unknown: false, transient: true, missingLast: false },
  { missingCount: 1, hashless: false, unknown: false, transient: false, missingLast: true },
  { missingCount: 2, hashless: false, unknown: false },
  { missingCount: 1, hashless: true, unknown: false },
  { missingCount: 2, hashless: true, unknown: true },
  { missingCount: 1, hashless: false, unknown: true },
  { missingCount: 1, hashless: false, unknown: true, rebind: true, senderLeft: true },
]) test(`W3 actual runtime preserves body and fixed transport ${JSON.stringify(scenario)}`, async () => {
  const surface = await fixture("public");
  let author = surface.owner;
  if (scenario.senderLeft) {
    const [member] = await surface.db.insert(users).values({ email: `w3-sender-${randomUUID()}@test.invalid`,
      name: `w3-sender-${randomUUID()}`, passwordHash: "synthetic" }).returning();
    author = member!;
    await surface.db.insert(serverMembers).values({ serverId: surface.server.id, userId: author.id, role: "member" });
  }
  let clock = new Date();
  const cipher = createSlackBridgeEnvCredentialCipher({ key: Buffer.alloc(32, 31) });
  const sealed = await cipher.sealer.seal({ serverId: surface.server.id, accessToken: "synthetic-token",
    tokenType: "bot", providerAppId: surface.install.providerAppId, providerTeamId: surface.install.providerTeamId!,
    botUserId: surface.install.botUserId!, now: clock });
  await surface.db.update(externalAppCredentials).set({ encryptedMaterial: sealed.encryptedMaterial,
    envelopeKeyId: sealed.envelopeKeyId, aadVersion: sealed.aadVersion }).where(eq(externalAppCredentials.installId, surface.install.id));
  const [priorRollout] = await surface.db.select().from(slackAttachmentPlanRollout);
  const configGeneration = (priorRollout?.configGeneration ?? 0) + 1;
  let deploymentConfig = parseSlackAttachmentFallbackDeployment({ SLACK_BRIDGE_ATTACHMENT_FALLBACK_ENABLED: scenario.planningOff ? "false" : "true",
    SLACK_BRIDGE_ATTACHMENT_FALLBACK_CONFIG_GENERATION: String(configGeneration), SLACK_BRIDGE_ATTACHMENT_FALLBACK_VERIFIED_RELEASE: "a".repeat(40), SLACK_BRIDGE_ATTACHMENT_FALLBACK_VERIFIED_BY: "@test-verifier" });
  assert.ok(deploymentConfig);
  if (scenario.deploymentRepair) await surface.db.execute(sql`alter table external_attachment_transfer_jobs disable trigger slack_attachment_plan_job_write_fence`);
  const [message, following] = await surface.db.insert(messages).values([
    { channelId: surface.channel.id, senderType: "user", senderId: author.id, content: scenario.emptyBody ? "" : "caption & <preserve>", messageType: "chat" },
    { channelId: surface.channel.id, senderType: "user", senderId: author.id, content: "following continues", messageType: "chat" },
  ]).returning();
  const bodies = [Buffer.from("missing-or-first"), Buffer.from("second-file")];
  const missing = new Set<string>();
  for (const [position, body] of bodies.entries()) {
    const [object] = await surface.db.insert(attachmentObjects).values({ originServerId: surface.server.id,
      uploaderId: surface.owner.id, uploaderType: "user", storageKey: `${surface.server.id}/w3-${position}`,
      contentHash: scenario.hashless ? null : createHash("sha256").update(body).digest("hex"),
      mimeType: "text/plain", sizeBytes: body.length }).returning();
    if (scenario.missingLast ? position === 1 : position < scenario.missingCount) missing.add(object.storageKey);
    await surface.db.insert(attachments).values({ objectId: object.id, messageId: message!.id, messagePosition: position,
      channelId: surface.channel.id, uploaderId: surface.owner.id, uploaderType: "user", filename: `w3-${position}.txt` });
  }
  let unavailable = scenario.transient ?? false;
  let sourceReadsAfterFirstPublication = 0;
  let published = false;
  let delayedSource = false;
  let corruptSource = scenario.corruptSource ?? false;
  __setStorageForTests({ async put() {}, async delete() {},
    async get(key) {
      if (published) sourceReadsAfterFirstPublication++;
      if (unavailable || missing.has(key)) throw new Error("synthetic source unavailable");
      const body = bodies[key.endsWith("-0") ? 0 : 1]!;
      if (corruptSource) return Readable.from(Buffer.alloc(body.length, 1));
      if (!delayedSource && (scenario.slowRead || scenario.slowUpload)) {
        delayedSource = true;
        if (scenario.slowRead) clock = new Date(clock.getTime() + 61_000);
        else return Readable.from((async function* () {
          const start = clock.getTime();
          clock = new Date(start + 4 * 60_000);
          yield body.subarray(0, 1);
          // Do not move the injected clock until the consumer has actually
          // processed the first chunk; Readable may prefetch the next chunk.
          await waitForControlState(async () => (await surface.db.select().from(externalAttachmentTransferJobs))
            .some(job => job.leaseExpiresAt && job.leaseExpiresAt.getTime() > start + 5 * 60_000));
          clock = new Date(start + 6 * 60_000);
          yield body.subarray(1);
        })(), { highWaterMark: 1 });
      }
      return Readable.from(body);
    },
    async probeObjectPresence(key) { if (unavailable) throw new Error("temporary failure"); return missing.has(key) ? "missing" : "present"; },
  });
  const active = await resolveCurrentOutboundAuthorityOrNull({ executor: surface.db, bindingId: surface.binding.id,
    expectedConnectionEpoch: surface.binding.connectionEpoch, expectedBindingEpoch: surface.binding.bindingEpoch,
    senderType: "user", senderId: author.id, now: clock, registrationId: surface.registration.id });
  assert.ok(active);
  const queued: Awaited<ReturnType<typeof enqueueSlackBridgeOutboundDelivery>>[] = [];
  for (const source of [message!, following!]) queued.push(await surface.db.transaction(executor => enqueueSlackBridgeOutboundDelivery({
    executor, message: source, activeRuntime: { level: "top_level", authorityConversationId: surface.channel.id,
      runtimePredicateRevision: active.runtimeRevision, bindingAuthority: active.neutral }, canonicalConversationId: surface.channel.id,
    senderType: "user", senderId: author.id, authorName: author.name, sanitizedText: source.content,
    mintReconciliationMarker: ({ deliveryId }) => mintSlackBridgeReconciliationMarker("w3-actual-runtime", deliveryId),
  })));
  clock = new Date(Date.now() + 1_000); // All inserted jobs must be due at the first tick.
  const expectedCaption = scenario.missingCount === 0 ? (scenario.emptyBody ? "" : "caption &amp; &lt;preserve&gt;")
    : scenario.emptyBody ? "[One or more attachments unavailable]" : "caption &amp; &lt;preserve&gt;\n\n[One or more attachments unavailable]";
  const sentTexts: string[] = [];
  const completedFileSets: string[][] = [];
  let lastTextBody: Record<string, unknown> | undefined;
  let firstFileHistory = true;
  let publications = 0;
  let deniedTicket = false;
  let uploads = 0;
  let publicationTs = "";
  const provider = createSlackBridgeProviderRuntime({ db: surface.db, credentialCipher: cipher, now: () => clock,
    fetch: (async (urlInput, init) => {
      const url = new URL(String(urlInput));
      let response: Record<string, unknown>;
      if (url.hostname === "files.slack.com") {
        uploads++; await new Response(init?.body).arrayBuffer();
        if (scenario.resetUploadOnce && uploads === 1) throw new Error("synthetic upload connection reset");
        return new Response("OK");
      }
      const method = url.pathname.split("/").at(-1);
      if (method === "files.getUploadURLExternal") {
        if (scenario.ticketDeniedOnce && !deniedTicket) {
          deniedTicket = true;
          const [before] = await surface.db.select().from(externalOutboundDeliveries).where(eq(externalOutboundDeliveries.id, queued[0]!.delivery.id));
          assert.equal(before.providerAttempts, 0, "private permission failures do not spend publication attempts");
          return new Response(JSON.stringify({ ok: false, error: "missing_scope" }));
        }
        const filename = url.searchParams.get("filename") ?? (JSON.parse(String(init?.body)) as { filename: string }).filename;
        response = { ok: true, file_id: `F_${filename.replace(/[^A-Za-z0-9]/g, "")}`,
          upload_url: "https://files.slack.com/upload/synthetic" };
      } else if (method === "files.completeUploadExternal") {
        const body = JSON.parse(String(init?.body)) as { files: Array<{ id: string }>; initial_comment: string };
        assert.equal(body.initial_comment ?? "", expectedCaption);
        completedFileSets.push(body.files.map(file => file.id)); publications++; published = true;
        publicationTs = (clock.getTime() / 1000).toFixed(6);
        response = { ok: true, files: body.files };
      } else if (method === "chat.postMessage") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        sentTexts.push(String(body.text));
        if (sentTexts.length === 1 && scenario.missingCount === 2) {
          assert.equal(body.text, expectedCaption); publications++; published = true; lastTextBody = body;
          publicationTs = (clock.getTime() / 1000).toFixed(6);
          if (scenario.unknown) { unavailable = true; throw new Error("response lost after accepted"); }
        }
        response = { ok: true, channel: "C_RUNTIME_TEST", ts: body.text === expectedCaption ? publicationTs : (clock.getTime() / 1000).toFixed(6) };
      } else if (method === "conversations.history") {
        if (scenario.missingCount === 2) {
          response = { ok: true, has_more: false, messages: lastTextBody ? [{ ts: publicationTs, user: "U_RUNTIME_BOT",
            bot_id: "B_RUNTIME_BOT", app_id: "A_RUNTIME_TEST", metadata: lastTextBody.metadata }] : [] };
        } else {
          const pending = scenario.unknown && firstFileHistory; firstFileHistory = false;
          if (pending) unavailable = true;
          response = { ok: true, has_more: false, messages: pending ? [] : [{ ts: publicationTs, subtype: "file_share",
            files: completedFileSets[0]!.map(id => ({ id })) }] };
        }
      } else throw new Error(`unexpected method ${method}`);
      return new Response(JSON.stringify(response), { headers: { "Content-Type": "application/json" } });
    }) as typeof fetch,
  });
  let firstInput!: Parameters<typeof processExternalDeliveryPartitionHead>[0];
  let observedTicks = 0;
  const errors: unknown[] = [];
  const recoveries: unknown[][] = [];
  const originalInfo = console.info;
  if (scenario.deploymentRepair) console.info = (...args: unknown[]) => {
    if (args[0] === "[SlackBridge] attachment deployment configuration recovered") recoveries.push(args);
    else originalInfo(...args);
  };
  let runtime: ReturnType<typeof createSlackBridgeDatabaseOutboundRuntime>;
  const startRuntime = async (restarted: boolean) => {
    let captured = false;
    runtime = createSlackBridgeDatabaseOutboundRuntime({ db: surface.db, provider, reconciliationKey: "w3-actual-runtime",
      attachmentFallbackDeployment: deploymentConfig,
      workerLeaseOwner: restarted ? "restarted-w3-worker" : "first-w3-worker",
      registrationId: surface.registration.id, now: () => clock, workerIntervalMs: scenario.deploymentRepair ? 20 : 60_000, onError: error => errors.push(error),
      async runWorkerOnce(input) {
        if (input.bindingId === queued[0]!.delivery.bindingId && input.bindingEpoch === queued[0]!.delivery.bindingEpoch) {
          firstInput = input; captured = true; observedTicks++;
        }
        return { kind: "empty" };
      },
    });
    runtime.start(); await waitForControlState(async () => captured);
  };
  try {
    await startRuntime(false);
    if (scenario.deploymentRepair) {
      await waitForControlState(async () => observedTicks >= 3);
      assert.equal(errors.length, 1, "persistent control failure is reported once while normal ticks continue");
      clock = new Date(clock.getTime() + 60_001);
      await waitForControlState(async () => errors.length === 2);
      await surface.db.execute(sql`CREATE FUNCTION test_reject_attachment_control() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'synthetic rollout denied'; END $$`);
      await surface.db.execute(sql`CREATE TRIGGER test_reject_attachment_control BEFORE UPDATE ON slack_attachment_plan_rollout
        FOR EACH ROW EXECUTE FUNCTION test_reject_attachment_control()`);
      await waitForControlState(async () => errors.length === 3);
      const before = observedTicks;
      clock = new Date(clock.getTime() + 1); // Outer query parameters change; the underlying failure stays the same.
      await waitForControlState(async () => observedTicks >= before + 2);
      assert.equal(errors.length, 3, "a new failure reports immediately but timestamped wrapper changes do not spam");
    }
    const originalPrepare = firstInput.dependencies!.prepareProvider!;
    firstInput.dependencies!.prepareProvider = async request => {
      try { return await originalPrepare(request); }
      catch (error) { errors.push(error); throw error; }
    };
    let accepted = false;
    let restarted = false;
    const steps: unknown[] = [];
    for (let turn = 0; turn < 80; turn++) {
      const step = await processExternalDeliveryPartitionHead(firstInput);
      if (steps.length < 12) steps.push(step);
      if (scenario.deploymentRepair && turn === 0) {
        assert.ok(errors.length >= 1, "the failed control update is reported");
        assert.equal((await surface.db.select().from(slackAttachmentPlanRollout)).length, 0, "the failed activation rolled back");
        assert.ok(publications >= 1, "ordinary publication continues before the control is repaired");
        await surface.db.execute(sql`DROP TRIGGER test_reject_attachment_control ON slack_attachment_plan_rollout`);
        await surface.db.execute(sql`DROP FUNCTION test_reject_attachment_control()`);
        await surface.db.execute(sql`alter table external_attachment_transfer_jobs enable trigger slack_attachment_plan_job_write_fence`);
        await waitForControlState(async () => (await surface.db.select().from(slackAttachmentPlanRollout))[0]?.enabled === true);
        await waitForControlState(async () => recoveries.length === 1);
        assert.deepEqual(recoveries[0], ["[SlackBridge] attachment deployment configuration recovered", { generation: configGeneration, outcome: "applied" }]);
      }
      if (scenario.unknown && !restarted && step.kind === "attempted" && step.deliveryState === "outcome_unknown") {
        await runtime!.stop();
        if (scenario.rebind) await reauthorizeSamePair(surface);
        if (scenario.senderLeft) await surface.db.delete(serverMembers).where(and(
          eq(serverMembers.serverId, surface.server.id), eq(serverMembers.userId, author.id),
        ));
        deploymentConfig = parseSlackAttachmentFallbackDeployment({ SLACK_BRIDGE_ATTACHMENT_FALLBACK_ENABLED: "false",
          SLACK_BRIDGE_ATTACHMENT_FALLBACK_CONFIG_GENERATION: String(configGeneration + 1) });
        assert.ok(deploymentConfig);
        __setStorageForTests(null); // Receipt recovery must not require even a configured source backend.
        await startRuntime(true); restarted = true;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
      if (scenario.slowUpload || scenario.corruptSource) {
        await waitForControlState(async () => (await surface.db.select().from(externalAttachmentTransferJobs))
          .every(job => job.state !== "leased"));
      }
      clock = new Date(clock.getTime() + 31_000);
      if (scenario.corruptSource && turn === 3) {
        const [held] = await surface.db.select().from(externalOutboundDeliveries).where(eq(externalOutboundDeliveries.id, queued[0]!.delivery.id));
        assert.equal(uploads, 0, "known digest mismatch is detected before any private upload");
        assert.equal(held.providerAttempts, 0);
        assert.equal(held.stateReason, "attachment_source_digest_mismatch");
        const [job] = await surface.db.select().from(externalAttachmentTransferJobs)
          .where(eq(externalAttachmentTransferJobs.outboundDeliveryId, held.id)).orderBy(externalAttachmentTransferJobs.createdAt);
        assert.ok(job.attempts >= 2);
        assert.ok(job.nextAttemptAt.getTime() - job.updatedAt.getTime() >= 60_000, "repeated private failures back off");
        corruptSource = false;
      }
      if (scenario.transient && unavailable && turn >= 3) {
        const [held] = await surface.db.select().from(externalOutboundDeliveries).where(eq(externalOutboundDeliveries.id, queued[0]!.delivery.id));
        assert.equal(held.providerAttempts, 0, "temporary storage errors cannot spend publication budget");
        assert.equal((await surface.db.select().from(slackAttachmentFallbackPlans)).length, 0, "temporary failures prove no omission");
        // Filesystem staging is asynchronous: restore storage only after the
        // actual queue head exposes the warning, never after a fixed sleep.
        if (held.stateReason === "attachment_source_read_failed") unavailable = false;
      }
      const rows = await surface.db.select().from(externalOutboundDeliveries)
        .where(eq(externalOutboundDeliveries.bindingId, surface.binding.id));
      if (rows.length === 2 && rows.every(row => row.state === "accepted")) { accepted = true; break; }
    }
    if (scenario.deploymentRepair) assert.ok(errors.every(error => error instanceof Error && (/database protocol/.test(error.message)
      || (error.cause instanceof Error && error.cause.message === "synthetic rollout denied"))));
    else assert.deepEqual(errors.map(error => error instanceof Error ? error.message : String(error)), []);
    assert.equal(accepted, true, `both messages must be accepted: ${JSON.stringify({steps,jobs:await surface.db.select().from(externalAttachmentTransferJobs),plans:await surface.db.select().from(slackAttachmentFallbackPlans)})}`);
    assert.equal(restarted, scenario.unknown);
    assert.equal(deniedTicket, scenario.ticketDeniedOnce ?? false);
    assert.equal(publications, 1, "a missing response or restart must not publish a second message");
    assert.equal(sourceReadsAfterFirstPublication, 0, "reconciliation never reads vanished sources");
    assert.equal(completedFileSets.length, scenario.missingCount === 2 ? 0 : 1);
    if (completedFileSets.length) assert.equal(completedFileSets[0]!.length, 2 - scenario.missingCount);
    assert.equal(uploads, 2 - scenario.missingCount, "retained private uploads are reused across plan creation and recovery");
    assert.equal(sentTexts.at(-1), "following continues");
    const [delivery] = await surface.db.select().from(externalOutboundDeliveries).where(eq(externalOutboundDeliveries.id, queued[0]!.delivery.id));
    assert.equal(delivery.providerAttempts, scenario.resetUploadOnce ? 2 : 1, "private preparation/source failures do not consume publication attempts");
    assert.deepEqual(delivery.renderSnapshot, queued[0]!.delivery.renderSnapshot, "original snapshot stays immutable");
    const transferJobs = await surface.db.select().from(externalAttachmentTransferJobs).where(eq(externalAttachmentTransferJobs.outboundDeliveryId, delivery.id));
    assert.equal(transferJobs.filter(job => job.state === "failed" && job.lastErrorClass === "attachment_source_missing_omitted").length, scenario.missingCount);
    assert.equal(transferJobs.filter(job => job.state === "completed").length, 2 - scenario.missingCount);
  } finally {
    try { await runtime!.stop(); }
    finally { console.info = originalInfo; }
  }
});

test("W3 planning is default-off and requires durable fleet evidence and both writer fences", async () => {
  const surface = await fixture("public");
  const { isSlackAttachmentPlanningEnabled } = await import("./slackAttachmentFallbackProtocol");
  assert.equal(await isSlackAttachmentPlanningEnabled(surface.db), false);
  await assert.rejects(surface.db.insert(slackAttachmentPlanRollout).values({ id: "slack-attachment-plan-v1",
    enabled: true, minimumWriterVersion: 1, verifiedAt: NOW }), "null release/operator cannot attest a fleet");
  await surface.db.insert(slackAttachmentPlanRollout).values({ id: "slack-attachment-plan-v1", enabled: true,
    minimumWriterVersion: 1, verifiedRelease: "a".repeat(40), verifiedBy: "synthetic-operator", verifiedAt: NOW });
  assert.equal(await isSlackAttachmentPlanningEnabled(surface.db), true);
  await surface.db.execute(sql`alter table external_attachment_transfer_jobs disable trigger slack_attachment_plan_job_write_fence`);
  assert.equal(await isSlackAttachmentPlanningEnabled(surface.db), false, "a named control cannot replace the actual old-writer barrier");
  await surface.db.execute(sql`alter table external_attachment_transfer_jobs enable trigger slack_attachment_plan_job_write_fence`);
  assert.equal(await isSlackAttachmentPlanningEnabled(surface.db), true);
  await surface.db.update(slackAttachmentPlanRollout).set({ enabled: false });
  assert.equal(await isSlackAttachmentPlanningEnabled(surface.db), false);
  await assert.rejects(surface.db.update(slackAttachmentPlanRollout).set({ minimumWriterVersion: 0 }));
  await assert.rejects(surface.db.delete(slackAttachmentPlanRollout), "pause does not release the rollback floor");
});
