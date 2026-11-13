import { assertChannelWritableInTransaction, ChannelConversionInProgressError } from "./channelConversionFenceService";
import { createHash } from "node:crypto";
import { createMessage } from "./messageService";
import { parseConversionProgress } from "./channelConversionContracts";
import { stableProgressForLedger, stableStringify } from "./channelConversionPhaseContext";
import type { ChannelConversionState } from "@botiverse/raft-shared";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { agents, channelConversionCommands, channelConversionJobs, channelConversionPhaseLedger, servers, serverMembers } from "../db/schema";
import { createAgent } from "./agentService";
import { seedUser, createServer, headers } from "../routes/channels.api.fixtures";
import { tokenForHuman } from "../test/integration/credentials";
import { enableExternalChannelsFlag } from "../test/externalInviteFixture";
import { addHuman, createChannel } from "./channelService";
import { admitConversionCommand, conversionCommandId, executeConversionCommand, runConversionCommandWorkerPass } from "./channelConversionCommandService";
import { cancelChannelConversionJob } from "./channelConversionService";
import { emitChannelConversionState, emitChannelConversionCompletion } from "../routes/channels";
import { attachLatestChannelConversionJobs, runChannelConversionJob } from "./channelConversionService";

const test = createApiTest();
// A conversion is followed (its job read, Retry, Cancel) where external_channels_v1 is on (#wg-rbac:#50).
async function fixture({ externalChannels = true }: { externalChannels?: boolean } = {}) {
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedUser(`command-${suffix}@slock.test`, `command-${suffix}`);
  const server = await createServer(`Command ${suffix}`, `command-${suffix}`, owner.id);
  await getDb().update(servers).set({ plan: "founder" }).where(eq(servers.id, server.id));
  if (externalChannels) await enableExternalChannelsFlag(server.id);
  const channel = await createChannel(server.id, "command-room", undefined, "private");
  await addHuman(channel.id, owner.id);
  return { owner, server, channel };
}

test("admission is independently discoverable before a job exists and remains channel authorized", async ({ app }) => {
  const f = await fixture();
  const id = conversionCommandId(randomUUID());
  await admitConversionCommand({ id, serverId: f.server.id, sourceChannelId: f.channel.id, requestedByUserId: f.owner.id, kind: "start" });
  assert.equal((await getDb().select().from(channelConversionJobs)).length, 0);
  const token = await tokenForHuman(f.owner.email);
  const response = await fetch(`${app.baseUrl}/api/channels/${f.channel.id}`, { headers: headers(token, f.server.id) });
  assert.equal(response.status, 200);
  const body = await response.json() as { conversionState: ChannelConversionState; conversionCommand: { id: string; status: string }; conversionJob: unknown };
  assert.equal(body.conversionCommand.id, id);
  assert.equal(body.conversionCommand.status, "pending");
  assert.equal(body.conversionJob, null);
  assert.equal(body.conversionState.status, "pending");
  assert.equal(body.conversionState.command?.id, id);
  assert.equal(body.conversionState.job, null);
  const outsider = await seedUser(`outsider-${randomUUID().slice(0, 8)}@slock.test`, `outsider-${randomUUID().slice(0, 8)}`);
  const denied = await fetch(`${app.baseUrl}/api/channels/${f.channel.id}`, { headers: headers(await tokenForHuman(outsider.email), f.server.id) });
  assert.ok([403, 404].includes(denied.status));
});

test("admission execution commits one job and duplicate execution does not repeat mutation", async ({ app }) => {
  assert.ok(app.baseUrl);
  const f = await fixture();
  const history = await createMessage(f.channel.id, "user", f.owner.id, "receipt round-trip");
  const input = { id: conversionCommandId(randomUUID()), serverId: f.server.id, sourceChannelId: f.channel.id, requestedByUserId: f.owner.id, kind: "start" as const };
  await admitConversionCommand(input);
  const first = await executeConversionCommand(input.id);
  assert.equal(first?.status, "completed");
  assert.ok(first?.jobId);
  const finished = await runChannelConversionJob(first!.jobId!);
  const decoded = parseConversionProgress(finished.progress);
  assert.equal(decoded.resources.parent?.messages?.moved, 1);
  assert.equal(decoded.resources.parent?.messages?.cursor, history.id);
  assert.ok(decoded.resources.parent?.messages?.checksum);
  const response = await fetch(`${app.baseUrl}/api/channels/conversion-jobs/${first!.jobId}`, { headers: headers(await tokenForHuman(f.owner.email), f.server.id) });
  assert.equal(response.status, 200);
  const api = await response.json() as { conversionJob: { id: string; progress: Record<string, unknown> } };
  assert.equal(api.conversionJob.id, first!.jobId);
  // The API carries only the progress the client reads; the runner's state stays on the server.
  assert.deepEqual(Object.keys(api.conversionJob.progress).filter((key) => !["canonicalCopyStarted", "uploadCount", "errorCode", "failedAt", "relockedAt", "rollbackState"].includes(key)), []);
  const [stored] = await getDb().select({ progress: channelConversionJobs.progress }).from(channelConversionJobs).where(eq(channelConversionJobs.id, first!.jobId!));
  assert.deepEqual(parseConversionProgress(stored!.progress), decoded, "production persistence must round-trip the same typed state");
  const ledger = await getDb().select().from(channelConversionPhaseLedger).where(eq(channelConversionPhaseLedger.jobId, first!.jobId!));
  const parentLedger = ledger.find(row => row.phase === "move_parent_messages" && row.batchKey === "all");
  assert.ok(parentLedger, "phase ledger must include the committed resource projection");
  const checksum = createHash("sha256").update(stableStringify({ phase: "move_parent_messages", output: { progress: stableProgressForLedger("move_parent_messages", decoded) } })).digest("hex");
  assert.equal(parentLedger.checksum, checksum, "API readback must reproduce the committed phase ledger");

  assert.equal((await admitConversionCommand(input)).id, input.id);
  const replay = await executeConversionCommand(input.id);
  assert.equal(replay?.jobId, first?.jobId);
  assert.equal((await getDb().select().from(channelConversionJobs)).length, 1);
});

test("a conversion job receipt names no agent: not a personal assistant, not any other", async ({ app }) => {
  const f = await fixture();
  const channel = await createChannel(f.server.id, "public-room", undefined, "channel");
  await addHuman(channel.id, f.owner.id);
  const assistantOwner = await seedUser(`receipt-assistant-owner-${randomUUID().slice(0, 8)}@slock.test`, "receipt-assistant-owner");
  await getDb().insert(serverMembers).values({ serverId: f.server.id, userId: assistantOwner.id, role: "member" });
  const assistant = await createAgent(f.server.id, `receiptassist${randomUUID().slice(0, 6)}`, {
    runtime: "claude", model: "sonnet", creatorType: "user", creatorId: assistantOwner.id,
    kind: "personal_assistant",
    afterInsert: async (tx, created) => {
      await tx.update(agents).set({ assistantOwnerUserId: assistantOwner.id }).where(eq(agents.id, created.id));
    },
  });
  const ordinary = await createAgent(f.server.id, `receiptagent${randomUUID().slice(0, 6)}`, {
    runtime: "claude", model: "sonnet", creatorType: "user", creatorId: f.owner.id,
  });
  const input = { id: conversionCommandId(randomUUID()), serverId: f.server.id, sourceChannelId: channel.id, requestedByUserId: f.owner.id, kind: "start" as const };
  await admitConversionCommand(input);
  const command = await executeConversionCommand(input.id);
  assert.ok(command?.jobId);
  const finished = await runChannelConversionJob(command!.jobId!);
  // The stored job lists both: a former public channel's audience was every agent on the server.
  assert.ok(parseConversionProgress(finished.progress).audienceCutover?.lostAgentIds.includes(assistant.id));

  const response = await fetch(`${app.baseUrl}/api/channels/conversion-jobs/${command!.jobId}`, {
    headers: headers(await tokenForHuman(f.owner.email), f.server.id),
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(text.includes(assistant.id), false, "a server owner never finds another person's assistant");
  assert.equal(text.includes(ordinary.id), false, "the progress view needs no agent ids at all");
  const body = JSON.parse(text) as { conversionJob: { id: string; status: string; progress: Record<string, unknown> } };
  assert.equal(body.conversionJob.id, command!.jobId);
  assert.equal(body.conversionJob.progress.audienceCutover, undefined);
});

test("with external_channels_v1 off, a conversion job is not followed: 404 channel_to_joint_conversion_disabled", async ({ app }) => {
  const f = await fixture({ externalChannels: false });
  const input = { id: conversionCommandId(randomUUID()), serverId: f.server.id, sourceChannelId: f.channel.id, requestedByUserId: f.owner.id, kind: "start" as const };
  await admitConversionCommand(input);
  const completed = await executeConversionCommand(input.id);
  assert.ok(completed?.jobId);
  const response = await fetch(`${app.baseUrl}/api/channels/conversion-jobs/${completed!.jobId}`, { headers: headers(await tokenForHuman(f.owner.email), f.server.id) });
  assert.equal(response.status, 404);
  assert.equal((await response.json() as { code?: string }).code, "channel_to_joint_conversion_disabled");
  await enableExternalChannelsFlag(f.server.id);
  const followed = await fetch(`${app.baseUrl}/api/channels/conversion-jobs/${completed!.jobId}`, { headers: headers(await tokenForHuman(f.owner.email), f.server.id) });
  assert.equal(followed.status, 200, await followed.text());
});

test("conversion job receipts remain hidden from same-server non-members", async ({ app }) => {
  const f = await fixture();
  const input = { id: conversionCommandId(randomUUID()), serverId: f.server.id, sourceChannelId: f.channel.id, requestedByUserId: f.owner.id, kind: "start" as const };
  await admitConversionCommand(input);
  const completed = await executeConversionCommand(input.id);
  assert.ok(completed?.jobId);
  const outsider = await seedUser(`receipt-outsider-${randomUUID().slice(0, 8)}@slock.test`, "receipt-outsider");
  await getDb().insert(serverMembers).values({ serverId: f.server.id, userId: outsider.id, role: "member" });
  const response = await fetch(`${app.baseUrl}/api/channels/conversion-jobs/${completed!.jobId}`, {
    headers: headers(await tokenForHuman(outsider.email), f.server.id),
  });
  assert.equal(response.status, 404, "server members without private-channel visibility must not read receipts");
  await runChannelConversionJob(completed!.jobId!);
  await addHuman(f.channel.id, outsider.id);
  const visible = await fetch(`${app.baseUrl}/api/channels/conversion-jobs/${completed!.jobId}`, {
    headers: headers(await tokenForHuman(outsider.email), f.server.id),
  });
  assert.equal(visible.status, 200, "same identity and route reach the visibility gate");
});

test("a worker resumes published admission without the original request", async ({ app }) => {
  assert.ok(app.baseUrl);
  const f = await fixture();
  const id = conversionCommandId(randomUUID());
  await admitConversionCommand({ id, serverId: f.server.id, sourceChannelId: f.channel.id, requestedByUserId: f.owner.id, kind: "start" });
  await runConversionCommandWorkerPass();
  const [command] = await getDb().select().from(channelConversionCommands).where(eq(channelConversionCommands.id, id));
  assert.equal(command.status, "completed");
  assert.ok(command.jobId);
  const [channel] = await attachLatestChannelConversionJobs([f.channel]);
  assert.equal(channel.conversionCommand?.status, "completed");
});

test("mounted clients receive admission and cancellation; progress reads clear stale pending commands", async ({ app }) => {
  const f = await fixture();
  const events: Array<{ room: string; event: string; channel: { id?: string; joined?: boolean; conversionCommand?: { status: string }; conversionJob?: { status: string }; conversionState?: ChannelConversionState } }> = [];
  const io = { to: (room: string) => ({ emit: (event: string, payload: { channel?: typeof events[number]["channel"] }) => {
    events.push({ room, event, channel: payload.channel ?? {} });
  } }) } as Parameters<typeof emitChannelConversionState>[0];
  const id = conversionCommandId(randomUUID());
  await admitConversionCommand({ id, serverId: f.server.id, sourceChannelId: f.channel.id, requestedByUserId: f.owner.id, kind: "start" });
  await emitChannelConversionState(io, f.channel.id);
  const admitted = events.at(-1)!;
  assert.equal(admitted.room, `channel:${f.channel.id}`);
  assert.equal(admitted.event, "channel:updated");
  assert.equal(admitted.channel.conversionCommand?.status, "pending");
  assert.equal(admitted.channel.conversionState?.status, "pending");
  assert.equal(admitted.channel.joined, undefined);
  await runConversionCommandWorkerPass(sourceId => emitChannelConversionState(io, sourceId));
  assert.equal(events.at(-1)!.channel.conversionCommand?.status, "completed");
  const [command] = await getDb().select().from(channelConversionCommands).where(eq(channelConversionCommands.id, id));
  const token = await tokenForHuman(f.owner.email);
  const progress = await fetch(`${app.baseUrl}/api/channels/conversion-jobs/${command.jobId}`, { headers: headers(token, f.server.id) });
  assert.equal(progress.status, 200);
  const body = await progress.json() as { channel: { conversionCommand: { status: string } } };
  assert.equal(body.channel.conversionCommand.status, "completed");
  await cancelChannelConversionJob(command.jobId!);
  await emitChannelConversionCompletion(io, command.jobId!, f.channel.id);
  const canceled = events.filter(event => event.channel.id === f.channel.id).at(-1)!;
  assert.equal(canceled.channel.conversionJob, null, "terminal receipts clear the mounted active job");
  assert.equal(canceled.channel.joined, undefined);
  assert.equal(canceled.channel.conversionState?.status, "canceled");
  assert.equal(canceled.channel.conversionState?.job?.id, command.jobId);
});

test("a fresh Start after cancellation stays pending while legacy active-job fields remain compatible", async ({ app }) => {
  const f = await fixture();
  const input = { id: conversionCommandId(randomUUID()), serverId: f.server.id, sourceChannelId: f.channel.id, requestedByUserId: f.owner.id, kind: "start" as const };
  await admitConversionCommand(input);
  const started = await executeConversionCommand(input.id);
  assert.ok(started?.jobId);
  await assert.rejects(
    getDb().transaction(tx => assertChannelWritableInTransaction(tx, f.channel.id)),
    ChannelConversionInProgressError,
    "an admitted conversion fences the actual transactional writer",
  );
  const [active] = await attachLatestChannelConversionJobs([f.channel]);
  assert.equal(active.conversionState.status, "running", "completed command still has an active job");
  assert.equal(active.conversionState.command?.status, "completed");
  assert.equal(active.conversionState.job?.id, active.conversionJob?.id);
  await cancelChannelConversionJob(started.jobId);
  await getDb().transaction(tx => assertChannelWritableInTransaction(tx, f.channel.id));
  const [canceled] = await attachLatestChannelConversionJobs([f.channel]);
  assert.equal(canceled.conversionJob, null, "old API omits terminal jobs");
  assert.equal(canceled.conversionState.status, "canceled");
  const nextId = conversionCommandId(randomUUID());
  await admitConversionCommand({ ...input, id: nextId });
  const token = await tokenForHuman(f.owner.email);
  const response = await fetch(`${app.baseUrl}/api/channels/${f.channel.id}`, { headers: headers(token, f.server.id) });
  assert.equal(response.status, 200);
  const payload = await response.json() as { conversionState: ChannelConversionState; conversionJob: unknown };
  assert.equal(payload.conversionState.status, "pending");
  assert.equal(payload.conversionState.command?.id, nextId);
  assert.equal(payload.conversionState.job?.status, "canceled", "historical terminal receipt is retained only inside the new read model");
  assert.equal(payload.conversionJob, null);
});
