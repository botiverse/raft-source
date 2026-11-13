import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { messages, users } from "../db/schema";
import { openTestApp } from "../test/integration/app";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { createChannel, addAgent, addHuman } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { mintAgentCredential } from "../services/agentCredentialService";
import {
  pendingDeferredReadAdvanceCount,
  scheduleDeferredReadAdvance,
  setReadPositionSettleMsForTests,
  settledReadThroughSeq,
  type DeferredReadAdvanceOutcome,
} from "../services/readPositionSettle";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

/**
 * `raft message read --target X --unread` (#wg-ax:b365e91f): one conversation's
 * unread, starting right after the agent's read position, and moving it. The
 * point is that the agent never needs a seq: the same command, run again,
 * continues where the last one stopped — including unread that sits below an
 * earlier `--after` window, which does not move the read position.
 */

async function seedFixture() {
  const suffix = randomUUID();
  const [owner] = await getDb().insert(users).values({
    email: `ax-unread-${suffix}@slock.test`,
    name: `ax-unread-${suffix}`,
    displayName: "Unread Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer("Unread Test", `ax-unread-${suffix.slice(0, 8)}`, owner.id);
  const agent = await createAgent(server.id, "UnreadBot", { runtime: "claude", model: "sonnet" });
  const channel = await createChannel(server.id, "ax-unread");
  await addHuman(channel.id, owner.id);
  await addAgent(channel.id, agent.id);
  const credential = await mintAgentCredential({
    agentId: agent.id,
    scopes: ["send", "read"],
    name: "ax-unread",
    issuedVia: "computer",
    createdByUserId: null,
  });
  // Messages are posted already settled (older than the settle window) unless
  // a test asks for a fresh one: only settled rows may move the read position.
  // `fresh` posts it a few seconds in the future, so it stays unsettled however
  // slow the test database is; a deferred check does not look at createdAt.
  // `own` posts as the reading agent itself. createMessage does not move the
  // agent's read position, as a send with others' unread below it does not.
  const post = async (content: string, opts: { fresh?: boolean; own?: boolean } = {}) => {
    const message = opts.own
      ? await createMessage(channel.id, "agent", agent.id, content, "chat")
      : await createMessage(channel.id, "user", owner.id, content, "chat");
    await getDb().update(messages)
      .set({ createdAt: new Date(Date.now() + (opts.fresh ? 5_000 : -120_000)) })
      .where(eq(messages.id, message.id));
    return message;
  };
  return { apiKey: credential.apiKey, post };
}

async function read(baseUrl: string, apiKey: string, query: string) {
  const res = await fetch(`${baseUrl}/internal/agent-api/history?channel=${encodeURIComponent("#ax-unread")}&${query}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const body = await res.json() as Record<string, unknown>;
  const contents = Array.isArray(body.messages)
    ? (body.messages as Array<{ content: string }>).map((m) => m.content)
    : [];
  return { status: res.status, body, contents };
}

test("--unread reads from the read position and moves it, without a seq from the caller", async ({ onTestFinished }) => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  onTestFinished(() => app.close());
  const fx = await seedFixture();
  const unread = () => read(app.baseUrl, fx.apiKey, "unread=true");

  await fx.post("one");
  const two = await fx.post("two");

  const first = await unread();
  assert.equal(first.status, 200);
  assert.deepEqual(first.contents, ["one", "two"]);
  assert.equal(first.body.unread_after_seq, 0, "never read: starts from the beginning");
  assert.equal(first.body.model_seen_up_to_seq, Number(two.seq));

  // Nothing new: empty, and it says where the read position is.
  const empty = await unread();
  assert.deepEqual(empty.contents, []);
  assert.equal(empty.body.unread_after_seq, Number(two.seq));

  // Two new messages. An `--after` read of only the newest does not move the
  // read position (it would skip "three"), so `--unread` must still return both.
  const three = await fx.post("three");
  await fx.post("four");
  const afterOnly = await read(app.baseUrl, fx.apiKey, `after=${Number(three.seq)}`);
  assert.deepEqual(afterOnly.contents, ["four"]);
  const second = await unread();
  assert.deepEqual(second.contents, ["three", "four"], "unread below an --after window must not be lost");
  assert.equal(second.body.unread_after_seq, Number(two.seq));

  const drained = await unread();
  assert.deepEqual(drained.contents, []);
});

test("--unread pages: the same command continues where the last page stopped", async ({ onTestFinished }) => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  onTestFinished(() => app.close());
  const fx = await seedFixture();
  for (const content of ["a", "b", "c"]) await fx.post(content);

  const page1 = await read(app.baseUrl, fx.apiKey, "unread=true&limit=2");
  assert.deepEqual(page1.contents, ["a", "b"]);
  assert.equal(page1.body.has_newer, true);
  const page2 = await read(app.baseUrl, fx.apiKey, "unread=true&limit=2");
  assert.deepEqual(page2.contents, ["c"]);
  assert.equal(page2.body.has_newer, false);
});

// Cindy 10-30: a `--before` window always said "No newer", although the
// anchor is a message the agent stepped back from.
test("a --before window says whether messages exist at or after its anchor", async ({ onTestFinished }) => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  onTestFinished(() => app.close());
  const fx = await seedFixture();
  await fx.post("a");
  await fx.post("b");
  const c = await fx.post("c");
  const d = await fx.post("d");

  const back = await read(app.baseUrl, fx.apiKey, `before=${Number(c.seq)}&limit=1`);
  assert.deepEqual(back.contents, ["b"]);
  assert.equal(back.body.has_older, true);
  assert.equal(back.body.has_newer, true, "c and d are at or after the anchor");

  const pastTheEnd = await read(app.baseUrl, fx.apiKey, `before=${Number(d.seq) + 1000}&limit=10`);
  assert.deepEqual(pastTheEnd.contents, ["a", "b", "c", "d"]);
  assert.equal(pastTheEnd.body.has_newer, false, "nothing at or after an anchor past the last message");
});

test("--unread refuses an anchor, and plain reads do not echo unread_after_seq", async ({ onTestFinished }) => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  onTestFinished(() => app.close());
  const fx = await seedFixture();
  await fx.post("hello");

  const combined = await read(app.baseUrl, fx.apiKey, "unread=true&after=1");
  assert.equal(combined.status, 400);
  assert.equal(combined.body.errorCode, "INVALID_ARG");
  assert.equal(combined.body.suggestedNextAction, 'raft message read --target "#ax-unread" --unread');

  const plain = await read(app.baseUrl, fx.apiKey, "limit=5");
  assert.equal(plain.status, 200);
  assert.equal("unread_after_seq" in plain.body, false, "old CLIs and plain reads see no new field");
});

test("--unread leaves out the agent's own messages, as the inbox count does, and reads past them", async ({ onTestFinished }) => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  onTestFinished(() => app.close());
  const fx = await seedFixture();
  await fx.post("question");
  await fx.post("my answer", { own: true });
  await fx.post("follow-up");
  const secondAnswer = await fx.post("my second answer", { own: true });

  const first = await read(app.baseUrl, fx.apiKey, "unread=true");
  assert.deepEqual(first.contents, ["question", "follow-up"], "only others' messages are printed");
  assert.equal(first.body.read_through_seq, Number(secondAnswer.seq), "the read position moves over the own messages too");

  // A window holding only own messages prints nothing and still moves.
  const ownOnly = await fx.post("my third answer", { own: true });
  const second = await read(app.baseUrl, fx.apiKey, "unread=true");
  assert.deepEqual(second.contents, []);
  assert.equal(second.body.unread_after_seq, Number(secondAnswer.seq));
  assert.equal(second.body.read_through_seq, Number(ownOnly.seq));
  const third = await read(app.baseUrl, fx.apiKey, "unread=true");
  assert.equal(third.body.unread_after_seq, Number(ownOnly.seq), "the next --unread does not scan them again");

  // A plain read is history, not unread: it still shows everything.
  const plain = await read(app.baseUrl, fx.apiKey, "limit=10");
  assert.deepEqual(plain.contents, ["question", "my answer", "follow-up", "my second answer", "my third answer"]);
});

test("--unread: a full page followed only by own messages has no more unread", async ({ onTestFinished }) => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  onTestFinished(() => app.close());
  const fx = await seedFixture();
  await fx.post("a");
  await fx.post("b");
  await fx.post("mine", { own: true });

  const page = await read(app.baseUrl, fx.apiKey, "unread=true&limit=2");
  assert.deepEqual(page.contents, ["a", "b"]);
  assert.equal(page.body.has_newer, false, "only an own message is left: no \"more unread\" hint");

  await fx.post("c");
  const next = await read(app.baseUrl, fx.apiKey, "unread=true&limit=2");
  assert.deepEqual(next.contents, ["c"]);
});

test("the deferred check moves over an own message the read did not print", async ({ onTestFinished }) => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  onTestFinished(() => app.close());
  onTestFinished(setReadPositionSettleMsForTests(300));
  const fx = await seedFixture();
  await fx.post("settled");
  await fx.post("my reply", { own: true, fresh: true });
  const fresh = await fx.post("just committed", { fresh: true });

  const first = await read(app.baseUrl, fx.apiKey, "unread=true");
  assert.deepEqual(first.contents, ["settled", "just committed"]);

  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const after = await read(app.baseUrl, fx.apiKey, "unread=true");
  assert.deepEqual(after.contents, [], "the hidden own message counts as returned, not as a late commit");
  assert.equal(after.body.unread_after_seq, Number(fresh.seq));
});

test("a message too recent to settle is returned but does not move the read position (seq order is not commit order)", async ({ onTestFinished }) => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  onTestFinished(() => app.close());
  // A long window: the deferred check does not fire during this test.
  onTestFinished(setReadPositionSettleMsForTests(60_000));
  const fx = await seedFixture();
  const settled = await fx.post("settled");
  await fx.post("just committed", { fresh: true });

  const first = await read(app.baseUrl, fx.apiKey, "unread=true");
  assert.deepEqual(first.contents, ["settled", "just committed"]);
  assert.equal(first.body.read_through_seq, Number(settled.seq), "stops before the unsettled row");

  // A lower seq committing late would land here; the fresh row is still unread.
  const second = await read(app.baseUrl, fx.apiKey, "unread=true");
  assert.deepEqual(second.contents, ["just committed"]);
});

test("settledReadThroughSeq stops at the first row that is too new, in seq order", () => {
  const old = new Date(0);
  const fresh = new Date(10_000);
  assert.equal(settledReadThroughSeq([{ seq: 3, createdAt: old }, { seq: 1, createdAt: old }, { seq: 2, createdAt: old }], 5_000), 3);
  assert.equal(settledReadThroughSeq([{ seq: 1, createdAt: old }, { seq: 2, createdAt: fresh }, { seq: 3, createdAt: old }], 5_000), 1);
  assert.equal(settledReadThroughSeq([{ seq: 1, createdAt: fresh }], 5_000), null);
});

test("once the window passes, a deferred check moves the read position over what the read returned", async ({ onTestFinished }) => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  onTestFinished(() => app.close());
  onTestFinished(setReadPositionSettleMsForTests(300));
  const fx = await seedFixture();
  await fx.post("settled");
  const fresh = await fx.post("just committed", { fresh: true });

  const first = await read(app.baseUrl, fx.apiKey, "unread=true");
  assert.deepEqual(first.contents, ["settled", "just committed"]);
  assert.notEqual(first.body.read_through_seq, Number(fresh.seq), "not settled yet");

  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const after = await read(app.baseUrl, fx.apiKey, "unread=true");
  assert.deepEqual(after.contents, [], "the deferred check marked it read; the agent is not stuck on it");
  assert.equal(after.body.unread_after_seq, Number(fresh.seq));
});

function scheduleProbe(present: number[], returnedSeqs: number[], fromSeq = 10) {
  const outcomes: Array<{ outcome: DeferredReadAdvanceOutcome; attrs: Record<string, number | undefined> }> = [];
  const advanced: number[] = [];
  scheduleDeferredReadAdvance({
    agentId: "agent-1",
    channelId: "channel-1",
    fromSeq,
    returnedSeqs,
    listSeqs: async () => present,
    advance: async (seq) => { advanced.push(seq); },
    record: (outcome, attrs) => outcomes.push({ outcome, attrs }),
  });
  return { outcomes, advanced };
}

test("deferred check: stops before a seq the read never returned (a late commit)", async ({ onTestFinished }) => {
  onTestFinished(setReadPositionSettleMsForTests(10));
  // The read returned 11, 13, 14; 12 committed late and was never shown.
  const probe = scheduleProbe([11, 12, 13, 14], [11, 13, 14]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(probe.advanced, [11]);
  assert.deepEqual(probe.outcomes, [{ outcome: "gap_found", attrs: { from_seq: 10, to_seq: 11, gap_seq: 12 } }]);
});

test("deferred check: one per agent and conversation; a newer read replaces the older check", async ({ onTestFinished }) => {
  onTestFinished(setReadPositionSettleMsForTests(50));
  const before = pendingDeferredReadAdvanceCount();
  const older = scheduleProbe([11], [11]);
  const newer = scheduleProbe([11, 12], [11, 12]);
  assert.equal(pendingDeferredReadAdvanceCount(), before + 1);
  assert.deepEqual(older.outcomes.map((o) => o.outcome), ["skipped_newer_read"]);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(older.advanced, [], "the replaced check never runs");
  assert.deepEqual(newer.advanced, [12]);
  assert.deepEqual(newer.outcomes, [{ outcome: "advanced", attrs: { from_seq: 10, to_seq: 12 } }]);
  assert.equal(pendingDeferredReadAdvanceCount(), before);
});
