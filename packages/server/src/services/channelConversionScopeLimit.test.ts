import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { agents, channelConversionJobs, channels, messages, servers as serversTable, users } from "../db/schema";
import { fixturePasswordHash } from "../test/integration/credentials";
import { createServer as createServerService } from "./serverService";
import { addAgent, addHuman, createChannel, getOrCreateThread } from "./channelService";
import { createMessage } from "./messageService";
import { mintAgentCredential } from "./agentCredentialService";
import { conversionCommandId, runConversionCommand } from "./channelConversionCommandService";
import {
  CHANNEL_CONVERSION_MAX_MESSAGES,
  CHANNEL_CONVERSION_MAX_SUBCONVERSATIONS,
  ChannelConversionError,
  measureConversionScope,
  startChannelToJointConversion,
} from "./channelConversionService";
import { ChannelConversionInProgressError } from "./channelConversionFenceService";
import { RefusalError } from "../lib/refusal";

const test = createApiTest();

async function seedUser(email: string, name: string) {
  const [user] = await getDb().insert(users).values({
    email, name, displayName: name, passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true, profileSetupCompletedAt: new Date(),
  }).returning();
  return user!;
}

/** Founder plan, so the shared-channel limits do not refuse first. */
async function createFounderServer(name: string, slug: string, ownerId: string) {
  const server = await createServerService(name, slug, ownerId);
  await getDb().update(serversTable).set({ plan: "founder" }).where(eq(serversTable.id, server.id));
  return server;
}

async function seedChannelWithThreads(prefix: string, threadCount: number) {
  const owner = await seedUser(`${prefix}-owner@slock.test`, `${prefix}-owner`);
  const server = await createFounderServer(`${prefix} host`, `${prefix}-host`, owner.id);
  const [agent] = await getDb().insert(agents).values({ serverId: server.id, name: `${prefix}-agent`, runtime: "codex" }).returning();
  const channel = await createChannel(server.id, `${prefix}-room`, "convert me", "channel");
  await addHuman(channel.id, owner.id);
  await addAgent(channel.id, agent!.id);
  const threads: string[] = [];
  for (let i = 0; i < threadCount; i += 1) {
    const parent = await createMessage(channel.id, "user", owner.id, `parent ${i}`);
    threads.push((await getOrCreateThread(parent.id, owner.id, "user")).id);
  }
  return { owner, server, agent: agent!, channel, threads };
}

// slock issue 15637: a channel whose threads and task conversations are over
// the limit is refused before anything is fenced or frozen.
test("a conversion over the thread/task-conversation limit is refused before anything is fenced", async ({ app: _app }) => {
  const prefix = `scope-limit-${randomUUID().slice(0, 8)}`;
  const f = await seedChannelWithThreads(prefix, CHANNEL_CONVERSION_MAX_SUBCONVERSATIONS + 1);
  assert.equal((await measureConversionScope(getDb(), f.channel.id)).subconversations, CHANNEL_CONVERSION_MAX_SUBCONVERSATIONS + 1);

  await assert.rejects(
    runConversionCommand({ id: conversionCommandId(undefined), serverId: f.server.id, sourceChannelId: f.channel.id, requestedByUserId: f.owner.id, kind: "start" }),
    (error: unknown) => error instanceof ChannelConversionError
      && error.code === "channel_conversion_too_large"
      && /more than 100 threads and task conversations/.test(error.message)
      && /Nothing was changed/.test(error.message),
  );
  assert.deepEqual(await getDb().select().from(channelConversionJobs).where(eq(channelConversionJobs.sourceChannelId, f.channel.id)), [], "no job, so no fence");
  const [row] = await getDb().select({ type: channels.type }).from(channels).where(eq(channels.id, f.channel.id));
  assert.equal(row?.type, "channel");
  await createMessage(f.channel.id, "user", f.owner.id, "still writable");

  // At the limit it is allowed: one thread deleted leaves exactly the limit
  // (its parent message stays: 102 messages, under the message limit).
  await getDb().update(channels).set({ deletedAt: new Date() }).where(eq(channels.id, f.threads[0]!));
  assert.equal((await measureConversionScope(getDb(), f.channel.id)).subconversations, CHANNEL_CONVERSION_MAX_SUBCONVERSATIONS);
  const started = await startChannelToJointConversion({ serverId: f.server.id, sourceChannelId: f.channel.id, createdByUserId: f.owner.id });
  assert.equal(started.status, "pending");
});

// The rollback moves every message back, two row triggers each: the
// messages in the channel and its threads and task conversations are bounded too.
test("a conversion over the message limit is refused, counting thread messages, and names that limit", async ({ app: _app }) => {
  const prefix = `scope-messages-${randomUUID().slice(0, 8)}`;
  const f = await seedChannelWithThreads(prefix, 1);
  // One parent message plus the rest in the thread: one past the limit.
  for (let i = 1; i < CHANNEL_CONVERSION_MAX_MESSAGES + 1; i += 1) {
    await createMessage(f.threads[0]!, "user", f.owner.id, `reply ${i}`);
  }
  assert.deepEqual(await measureConversionScope(getDb(), f.channel.id), { subconversations: 1, messages: CHANNEL_CONVERSION_MAX_MESSAGES + 1 });
  await assert.rejects(
    runConversionCommand({ id: conversionCommandId(undefined), serverId: f.server.id, sourceChannelId: f.channel.id, requestedByUserId: f.owner.id, kind: "start" }),
    (error: unknown) => error instanceof ChannelConversionError
      && error.code === "channel_conversion_too_large"
      && error.message === "This channel has more than 150 messages, which is more than can be moved to a shared channel right now. Nothing was changed. Start a new shared channel instead.",
  );
  assert.deepEqual(await getDb().select().from(channelConversionJobs).where(eq(channelConversionJobs.sourceChannelId, f.channel.id)), []);

  // Exactly at the limit: allowed.
  const [last] = await getDb().select({ id: messages.id }).from(messages).where(eq(messages.channelId, f.threads[0]!)).orderBy(desc(messages.seq)).limit(1);
  await getDb().delete(messages).where(eq(messages.id, last!.id));
  assert.equal((await measureConversionScope(getDb(), f.channel.id)).messages, CHANNEL_CONVERSION_MAX_MESSAGES);
  assert.equal((await startChannelToJointConversion({ serverId: f.server.id, sourceChannelId: f.channel.id, createdByUserId: f.owner.id })).status, "pending");
});

test("a channel whose own messages are over the limit is refused without reading its threads", async ({ app: _app }) => {
  const prefix = `scope-own-${randomUUID().slice(0, 8)}`;
  const f = await seedChannelWithThreads(prefix, 0);
  for (let i = 0; i < CHANNEL_CONVERSION_MAX_MESSAGES + 1; i += 1) await createMessage(f.channel.id, "user", f.owner.id, `m ${i}`);
  assert.deepEqual(await measureConversionScope(getDb(), f.channel.id), { subconversations: 0, messages: CHANNEL_CONVERSION_MAX_MESSAGES + 1 });
  await assert.rejects(
    startChannelToJointConversion({ serverId: f.server.id, sourceChannelId: f.channel.id, createdByUserId: f.owner.id }),
    (error: unknown) => error instanceof ChannelConversionError && /more than 150 messages/.test(error.message),
  );
});

// slock issue 15637 item 4: an agent's send to a channel under a conversion
// fence was a 500; it is the fence's 409.
test("an agent's send to a channel being converted answers 409, not 500", async ({ app }) => {
  const prefix = `scope-fence-${randomUUID().slice(0, 8)}`;
  const f = await seedChannelWithThreads(prefix, 0);
  await startChannelToJointConversion({ serverId: f.server.id, sourceChannelId: f.channel.id, createdByUserId: f.owner.id });
  const credential = await mintAgentCredential({ agentId: f.agent.id, scopes: ["read", "send"], name: "fence-send", issuedVia: "computer", createdByUserId: null });
  const response = await fetch(`${app.baseUrl}/internal/agent-api/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${credential.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ target: `#${f.channel.name}`, content: "during the freeze" }),
  });
  const text = await response.text();
  assert.equal(response.status, 409, text);
  const body = JSON.parse(text) as { code: string; error: string };
  assert.equal(body.code, "channel_conversion_in_progress");
  assert.equal(body.error, "This channel is being converted. Try again when the conversion has finished.");
});

test("the conversion fence's error is a refusal, so a generic catch answers its 409", () => {
  const error = new ChannelConversionInProgressError("source", "epoch");
  assert.ok(error instanceof RefusalError);
  assert.equal(error.status, 409);
  assert.deepEqual(error.refusal, { code: "channel_conversion_in_progress", error: "This channel is being converted. Try again when the conversion has finished." });
});
