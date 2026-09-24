import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
// Option C (#wg-external-agent:00fcc8f7, 2026-06-11): cross-replica wake
// signal for external agents. Fan-out publishes a content-free
// `{agentId, from}` broadcast; other replicas re-emit locally so a connected
// SSE stream flushes immediately instead of waiting for the 25s heartbeat
// durable peek (which remains the correctness floor).
//
// Pins (Stone + Kai):
// - publish fires on the external delivery path (path-fires), never for
//   transient notices;
// - per-agentId isolation: `delivered:<A>` triggers only A's stream — a
//   sibling agent's pending on the same replica must NOT be pushed by A's
//   signal (Kai's no-cross-leak family);
// - self-published signals are skipped (the local emit already ran);
// - signal carries no content and moves no cursor (flush re-audits durable).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";


import { getDb } from "../db/index.js";
import { users } from "../db/schema.js";
import { openTestApp } from "../test/integration/app.js";
import { createServer } from "../services/serverService.js";
import { createAgent } from "../services/agentService.js";
import { createChannel, addAgent, addHuman, markAgentLegacyRead } from "../services/channelService.js";
import { createMessage } from "../services/messageService.js";
import { mintAgentCredential } from "../services/agentCredentialService.js";
import { AgentOrchestrator } from "../services/agentOrchestrator.js";
import {
  REPLICA_ID,
  handleReplicaMessage,
  __setExternalWakeSignalHandlerForTests,
  __setMachinePrincipalFenceHandlerForTests,
} from "../replicaRouter.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

class PublishSpyOrchestrator extends AgentOrchestrator {
  published: string[] = [];

  protected override async publishExternalWakeSignalCrossReplica(agentId: string): Promise<void> {
    this.published.push(agentId);
  }
}

async function seedExternalFixture(label: string) {
  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({
    email: `xreplica-${label}-${suffix}@slock.test`,
    name: `xreplica-${label}-${suffix}`,
    displayName: `XReplica ${label}`,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  const server = await createServer(`XReplica ${label}`, `xreplica-${label}-${suffix}`, owner!.id);
  const agent = await createAgent(server.id, `XReplicaExt${label}`, { runtime: "external", model: "external" });
  const channel = await createChannel(server.id, `xreplica-room-${label}`);
  await addHuman(channel.id, owner!.id);
  await addAgent(channel.id, agent.id);
  const minted = await mintAgentCredential({
    agentId: agent.id,
    scopes: ["send", "read"],
    name: `xreplica-${label}`,
    createdByUserId: null,
  });
  return { ownerId: owner!.id, serverId: server.id, channelId: channel.id, channelName: channel.name, agentId: agent.id, apiKey: minted.apiKey };
}

/** Read wake-hint events from an open SSE body for up to timeoutMs. */
async function readHints(body: ReadableStream<Uint8Array>, timeoutMs: number): Promise<number[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const seqs: number[] = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const next = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), Math.max(50, deadline - Date.now()))),
    ]);
    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      if (!frame.includes("event: wake-hint")) continue;
      const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
      if (dataLine) seqs.push((JSON.parse(dataLine.slice(6)) as { seq: number }).seq);
    }
  }
  await reader.cancel().catch(() => {});
  return seqs;
}

test("external delivery publishes the cross-replica wake signal; transient notices do not", async ({ app }) => {
  const f = await seedExternalFixture("pub");
  const orchestrator = new PublishSpyOrchestrator() as any;
  app.app.set("agentOrchestrator", orchestrator);

  await orchestrator.deliverMessage(f.agentId, {
    channel_id: f.channelId,
    channel_name: f.channelName,
    channel_type: "channel",
    sender_id: f.ownerId,
    sender_name: "owner",
    sender_type: "human",
    content: "real delivery",
    timestamp: new Date().toISOString(),
    seq: 1101,
    message_id: randomUUID(),
  });
  assert.deepEqual(orchestrator.published, [f.agentId], "real delivery must broadcast the signal");

  await orchestrator.deliverMessage(f.agentId, {
    channel_id: f.channelId,
    channel_name: f.channelName,
    channel_type: "channel",
    sender_id: "system",
    sender_name: "system",
    sender_type: "system",
    content: "reminder fire",
    timestamp: new Date().toISOString(),
  }, { transient: true, intrinsic: true });
  assert.deepEqual(orchestrator.published, [f.agentId], "transient notices must not broadcast");
});

test("routed signal wakes only the target agent's stream — sibling pending stays unpushed until its own trigger", async () => {
  process.env.SLOCK_WAKE_STREAM_HEARTBEAT_MS = "60000"; // park the heartbeat floor out of the test window
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const a = await seedExternalFixture("a");
    const b = await seedExternalFixture("b");
    const orchestrator = new AgentOrchestrator() as any;
    app.app.set("agentOrchestrator", orchestrator);

    // Both agents: watermark exists, durable pending created AFTER the
    // streams connect, with no local buffer and no emit — the cross-replica
    // shape. (Connect-time rebuild must not see them.)
    for (const f of [a, b]) {
      const base = await createMessage(f.channelId, "user", f.ownerId, "seen");
      await markAgentLegacyRead(f.agentId, f.channelId, base.seq);
    }
    const resA = await fetch(`${app.baseUrl}/internal/agent-api/wake-hints/stream`, { headers: { Authorization: `Bearer ${a.apiKey}` } });
    const resB = await fetch(`${app.baseUrl}/internal/agent-api/wake-hints/stream`, { headers: { Authorization: `Bearer ${b.apiKey}` } });
    assert.equal(resA.status, 200);
    assert.equal(resB.status, 200);

    const pendingA = await createMessage(a.channelId, "user", a.ownerId, "pending for A");
    await createMessage(b.channelId, "user", b.ownerId, "pending for B");

    // What the Redis subscriber does when another replica fans out for A.
    orchestrator.handleRoutedExternalWakeSignal(a.agentId);

    const [seqsA, seqsB] = await Promise.all([
      readHints(resA.body!, 2_000),
      readHints(resB.body!, 2_000),
    ]);
    assert.deepEqual(seqsA, [pendingA.seq], "A's signal must flush A's stream immediately");
    assert.deepEqual(seqsB, [], "A's signal must not push B's pending (per-agentId isolation)");
  } finally {
    delete process.env.SLOCK_WAKE_STREAM_HEARTBEAT_MS;
    await app.close();
  }
});

test("subscriber dispatch: skips self-published signals, handles foreign ones, survives garbage", () => {
  const seen: string[] = [];
  __setExternalWakeSignalHandlerForTests((agentId) => seen.push(agentId));
  try {
    handleReplicaMessage("slock:replica:external-wake", JSON.stringify({ agentId: "agent-x", from: REPLICA_ID }));
    assert.deepEqual(seen, [], "self-published signal must be skipped (local emit already ran)");

    handleReplicaMessage("slock:replica:external-wake", JSON.stringify({ agentId: "agent-x", from: "other-replica" }));
    assert.deepEqual(seen, ["agent-x"]);

    handleReplicaMessage("slock:replica:external-wake", "not json");
    handleReplicaMessage("slock:replica:external-wake", JSON.stringify({ from: "other-replica" }));
    assert.deepEqual(seen, ["agent-x"], "garbage and agentless frames are ignored");
  } finally {
    __setExternalWakeSignalHandlerForTests(null);
  }
});

test("subscriber dispatch: machine principal fence is foreign-only, typed, and content-free", async () => {
  const seen: Array<{ machineId: string; principalKind: string }> = [];
  __setMachinePrincipalFenceHandlerForTests((machineId, principalKind) => {
    seen.push({ machineId, principalKind });
  });
  try {
    handleReplicaMessage(
      "slock:replica:machine-principal-fence",
      JSON.stringify({ machineId: "machine-1", principalKind: "legacy_machine", from: REPLICA_ID }),
    );
    assert.deepEqual(seen, [], "self-published fence must be handled only by the direct local call");

    handleReplicaMessage(
      "slock:replica:machine-principal-fence",
      JSON.stringify({ machineId: "machine-1", principalKind: "legacy_machine", from: "other-replica" }),
    );
    assert.deepEqual(seen, [{ machineId: "machine-1", principalKind: "legacy_machine" }]);

    handleReplicaMessage(
      "slock:replica:machine-principal-fence",
      JSON.stringify({ machineId: "machine-1", principalKind: "computer", from: "other-replica" }),
    );
    handleReplicaMessage("slock:replica:machine-principal-fence", "not json");
    assert.equal(seen.length, 1, "non-legacy and malformed frames must be ignored");
  } finally {
    __setMachinePrincipalFenceHandlerForTests(null);
  }
});
