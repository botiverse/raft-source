import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { refusalBody } from "../lib/refusal";
import { AGENT_CHANNEL_NOT_FOUND_REFUSAL } from "./agentRouteRefusals";
import { randomUUID } from "node:crypto";


import { getDb } from "../db/index";
import { users } from "../db/schema";
import { openTestApp } from "../test/integration/app";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import {
  findOrCreateDM,
  createChannel,
  addAgent,
  addHuman,
  canAgentAccessChannel,
  getOrCreateThread,
} from "../services/channelService";
import { createMessage } from "../services/messageService";
import { mintAgentCredential } from "../services/agentCredentialService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

/**
 * `raft message read` on a thread ref must name the entity that is actually
 * missing (task #145). Reporting "Channel not found" for a channel that
 * resolves fine cost one reader 8 retries and a "the read surface is flaky"
 * verdict on a deterministic empty.
 *
 * Five states, and the point of this file is that they are five, not one:
 *
 *   A  parent channel missing or invisible  -> shared neutral body
 *   B  short id anchors nothing here        -\  byte-identical: telling these
 *   D  short id belongs to another channel  -/  apart is an existence oracle
 *   C  anchor is here, but has no replies   -> the only case we may say so
 *   E  the thread exists                    -> ordinary success
 *   F  suffix is the thread's own id        -> resolves the same as E
 *
 * F is the `threadId=` field the header prints (first 8 chars of the thread
 * channel's UUID) pasted into the `#channel:<id>` slot. Before the resolver
 * learned it, that pasted id always answered B — "not found" for a thread that
 * plainly exists. It must resolve to the SAME thread, not merely any 200.
 *
 * ⚠️ B and D use REAL fixtures on purpose. If D's id simply did not exist, the
 * B/D equality would be true by construction and no change to the lookup could
 * ever redden it — an assertion whose result comes from its own shape rather
 * than from the code under test. D's id is a real message in another channel
 * the caller CAN see; the lookup is what refuses to find it here.
 * (@Tenny's acceptance, @Kai's catch, #proj-dx:4cd28c12.)
 */

function agentHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

const shortIdOf = (messageId: string): string => messageId.slice(0, 8);

async function seedFixture() {
  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({
    email: `dx-thread-${suffix}@slock.test`,
    name: `dx-thread-${suffix}`,
    displayName: "Thread Read Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();

  const server = await createServer("Thread Read Test", `dx-thread-${suffix.slice(0, 8)}`, owner.id);
  const agent = await createAgent(server.id, "ThreadReadBot", { runtime: "claude", model: "sonnet" });

  const parent = await createChannel(server.id, "dx-parent");
  await addHuman(parent.id, owner.id);
  await addAgent(parent.id, agent.id);

  // Another channel the agent CAN see — D must stay indistinguishable from B
  // even when the caller is entitled to the other channel, so visibility here
  // is the stronger fixture, not a convenience.
  const other = await createChannel(server.id, "dx-other");
  await addHuman(other.id, owner.id);
  await addAgent(other.id, agent.id);

  // A-invisible: a real private channel with a real message, but no membership
  // for the caller. This is distinct from A-missing even though both must return
  // the same neutral body.
  const hidden = await createChannel(server.id, "dx-hidden", undefined, "private");
  await addHuman(hidden.id, owner.id);
  const hiddenAnchor = await createMessage(hidden.id, "user", owner.id, "message in a hidden channel", "chat");

  // C: a real anchor in the parent that genuinely has no replies.
  const anchorNoReplies = await createMessage(parent.id, "user", owner.id, "anchor with no replies", "chat");
  // E: a real anchor in the parent that genuinely has a thread.
  const anchorWithThread = await createMessage(parent.id, "user", owner.id, "anchor with a thread", "chat");
  const thread = await getOrCreateThread(anchorWithThread.id, owner.id, "user");
  await createMessage(thread.id, "user", owner.id, "a reply, so the thread exists", "chat");
  // D: a real message, real short id, living in the other channel.
  const elsewhere = await createMessage(other.id, "user", owner.id, "message in another channel", "chat");

  const credential = await mintAgentCredential({
    agentId: agent.id,
    scopes: ["send", "read"],
    name: "dx-thread-read",
    issuedVia: "computer",
    createdByUserId: null,
  });

  return {
    owner,
    server,
    agent,
    apiKey: credential.apiKey,
    anchorNoReplies,
    anchorWithThread,
    thread,
    elsewhere,
    hidden,
    hiddenAnchor,
  };
}

async function readTarget(baseUrl: string, apiKey: string, target: string) {
  const res = await fetch(
    `${baseUrl}/internal/agent-api/history?channel=${encodeURIComponent(target)}`,
    { headers: agentHeaders(apiKey) },
  );
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

/**
 * Pull the actual argument VALUES out of the Next action we printed.
 *
 * Strict on purpose: a parse miss throws instead of returning a default. A
 * lenient parser that fell back to something workable would let a malformed
 * command reach the executor below and still pass — reintroducing the very
 * hole this file exists to close.
 */
function parseNextAction(nextAction: unknown): { target: string; around: string } {
  const text = String(nextAction);
  const m = /raft message read --target ["']([^"']+)["'] --around (\S+)/.exec(text);
  assert.ok(m, `Next action is not a runnable 'raft message read' command: ${text}`);
  return { target: m[1], around: m[2] };
}

/**
 * EXECUTE the printed Next action rather than pattern-matching its text.
 *
 * @Kai's ruling on #145: asserting the string contains "--around" passes for an
 * implementation that prints a wrong short id, a channel missing its `#`, or a
 * full message id where a short id belongs. Only running the values it actually
 * names can tell a correct command from a plausible-looking one. `--around` is
 * the same history endpoint, so this issues exactly the request the CLI would.
 */
async function runNextAction(baseUrl: string, apiKey: string, nextAction: unknown) {
  const { target, around } = parseNextAction(nextAction);
  const res = await fetch(
    `${baseUrl}/internal/agent-api/history?channel=${encodeURIComponent(target)}`
      + `&around=${encodeURIComponent(around)}`,
    { headers: agentHeaders(apiKey) },
  );
  const body = await res.json() as Record<string, unknown>;
  const messages = Array.isArray(body.messages) ? body.messages as Array<Record<string, unknown>> : [];
  return { status: res.status, body, messages };
}

test("a thread ref reports which entity is actually missing", async ({ onTestFinished }) => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  onTestFinished(() => app.close());
  const fx = await seedFixture();
  const read = (target: string) => readTarget(app.baseUrl, fx.apiKey, target);

  // E — the control. It must genuinely succeed, or every "absent" assertion
  // below is measured against a command that never works. An earlier probe used
  // a reply-less message as its success control; that control was itself case C.
  const e = await read(`#dx-parent:${shortIdOf(fx.anchorWithThread.id)}`);
  assert.equal(e.status, 200, "a thread that exists must still read normally");
  assert.ok(Array.isArray(e.body.messages), "control returned no message window");
  assert.equal(
    e.body.target,
    `#dx-parent:${shortIdOf(fx.anchorWithThread.id)}`,
    "history must return the resolver-owned canonical thread target",
  );

  // F — the thread's own id (the `threadId=` header field) resolves the same
  // thread. Asserting on the reply content rather than "any 200" so a resolver
  // that landed on the wrong thread still fails.
  const f = await read(`#dx-parent:${fx.thread.id.slice(0, 8)}`);
  assert.equal(f.status, 200, "a threadId suffix must resolve the thread it names");
  assert.equal(
    f.body.target,
    e.body.target,
    "the thread-channel-id spelling must resolve to the same canonical evidence target",
  );
  const fMessages = Array.isArray(f.body.messages) ? f.body.messages as Array<Record<string, unknown>> : [];
  assert.ok(
    fMessages.some((m) => String(m.content).includes("a reply, so the thread exists")),
    "the threadId suffix resolved a thread that does not contain its own reply",
  );

  // F-miss — an id that is not a message short id here and not a thread id
  // either must read EXACTLY like B; distinguishing them would hand the caller
  // a "is this id a real thread?" oracle.
  const fMiss = await read("#dx-parent:cafebabe");
  assert.equal(fMiss.status, 404);
  assert.deepEqual(
    fMiss.body,
    (await read("#dx-parent:deadbeef")).body,
    "a threadId miss must be indistinguishable from a message-id miss",
  );

  // A-missing — parent channel does not exist.
  const aMissing = await read(`#dx-nonexistent:${shortIdOf(fx.anchorNoReplies.id)}`);
  assert.equal(aMissing.status, 404);
  assert.deepEqual(aMissing.body, refusalBody(AGENT_CHANNEL_NOT_FOUND_REFUSAL));

  // A-invisible — parent channel and anchor both exist, but the caller cannot
  // see the private channel. It must be byte-identical to A-missing; otherwise
  // this error becomes a channel-existence oracle.
  assert.equal(
    await canAgentAccessChannel(fx.hidden.id, fx.agent.id),
    false,
    "fixture must be a real channel that is invisible to the caller",
  );
  const aInvisible = await read(`#dx-hidden:${shortIdOf(fx.hiddenAnchor.id)}`);
  assert.equal(aInvisible.status, 404);
  assert.deepEqual(aInvisible.body, aMissing.body, "missing and invisible parents must be indistinguishable");
  assert.equal(JSON.stringify(aInvisible.body), JSON.stringify(aMissing.body));

  // C — the anchor is here and really has no replies, so we may say exactly that.
  const c = await read(`#dx-parent:${shortIdOf(fx.anchorNoReplies.id)}`);
  assert.equal(c.status, 404);
  assert.match(String(c.body.error), /has no replies yet, so there is no thread to read/i);
  assert.doesNotMatch(String(c.body.error), /channel not found/i);

  // ② The Next action must be USABLE, not merely present. Run it.
  const ran = await runNextAction(app.baseUrl, fx.apiKey, c.body.suggestedNextAction);
  assert.equal(ran.status, 200, "the Next action we printed does not actually run");
  assert.ok(ran.messages.length > 0, "the Next action ran but returned an empty window");
  // Stronger than non-empty: it must land on the message the caller asked about.
  // A command that returned *some* window while pointing somewhere else would
  // satisfy "non-empty" and still be useless advice.
  assert.ok(
    ran.messages.some((m) => m.id === fx.anchorNoReplies.id),
    "the Next action returned a window that does not contain the anchor it names",
  );

  // B — nothing anchors this id anywhere.
  const b = await read("#dx-parent:deadbeef");
  assert.equal(b.status, 404);
  assert.doesNotMatch(String(b.body.error), /channel not found/i);
  // It must not claim the message exists here and merely lacks replies.
  assert.doesNotMatch(String(b.body.error), /no replies/i);

  // D — a REAL message, in a channel this caller can see, that is simply not an
  // anchor of this target.
  const d = await read(`#dx-parent:${shortIdOf(fx.elsewhere.id)}`);
  assert.equal(d.status, 404);
  assert.doesNotMatch(String(d.body.error), /dx-other/, "must not disclose where it lives");

  // The pair, byte for byte. Two literals kept equal by discipline would drift;
  // these come from one shared body.
  assert.equal(d.status, b.status);
  assert.deepEqual(d.body, b.body, "B and D must be indistinguishable");
  assert.equal(JSON.stringify(d.body), JSON.stringify(b.body));
});

/**
 * Proves the execution assertion above is a real instrument, in BOTH directions.
 *
 * @Kai's rule on #145: "it must be able to go red, and it must be shown not to be
 * always red." Those are separate failures with the same green-looking symptom —
 * an always-green check misses a wrong command, and an always-red one reports a
 * correct build as broken. I nearly shipped the second kind today via an
 * assertion that could never match, so neither half is optional here.
 */
test("the executed Next action discriminates on the short id it names", async ({ onTestFinished }) => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  onTestFinished(() => app.close());
  const fx = await seedFixture();

  const c = await readTarget(app.baseUrl, fx.apiKey, `#dx-parent:${shortIdOf(fx.anchorNoReplies.id)}`);
  const emitted = String(c.body.suggestedNextAction);

  // NOT-ALWAYS-RED control: the runner succeeds on a command known to be good.
  // Built by hand rather than taken from the implementation, so this leg cannot
  // inherit a defect from the code under test.
  const handBuilt = `raft message read --target '#dx-parent' --around ${shortIdOf(fx.anchorWithThread.id)}`;
  const control = await runNextAction(app.baseUrl, fx.apiKey, handBuilt);
  assert.equal(control.status, 200, "control: a known-good command must run");
  assert.ok(control.messages.length > 0, "control: a known-good command must return a window");

  // CAN-GO-RED: corrupt only the short id inside the emitted command. Everything
  // else — verb, flags, quoting, channel — stays byte-identical, so a failure
  // here can only come from the id, which is the value we claim to have gotten
  // right.
  const corrupted = emitted.replace(shortIdOf(fx.anchorNoReplies.id), "deadbeef");
  assert.notEqual(corrupted, emitted, "the corruption did not change the command");
  const bad = await runNextAction(app.baseUrl, fx.apiKey, corrupted);
  const badWindowIsUseful = bad.status === 200 && bad.messages.length > 0;
  assert.equal(
    badWindowIsUseful,
    false,
    "a wrong short id still produced a usable window: this assertion cannot detect a wrong command",
  );
});


test("authorized DM history supplies consumption identity for DM and DM thread only", async ({
  onTestFinished,
}) => {
  const app = await openTestApp("pglite://", 0, {
    humanActivityMuteFlagDefaultEnabled: true,
  });
  onTestFinished(() => app.close());
  const fx = await seedFixture();
  const dm = await findOrCreateDM(fx.server.id, fx.owner.id, fx.agent.id);
  assert.ok(dm);
  const parent = await createMessage(dm.id, "user", fx.owner.id, "DM parent");
  const thread = await getOrCreateThread(parent.id, fx.owner.id, "user");
  await createMessage(thread.id, "user", fx.owner.id, "DM reply");
  for (const [target, channelId, channelType] of [
    [`dm:@${fx.owner.name}`, dm.id, "dm"],
    [`dm:@${fx.owner.name}:${parent.id.slice(0, 8)}`, thread.id, "thread"],
  ]) {
    const result = await readTarget(app.baseUrl, fx.apiKey, target);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.consumption_scope, {
      agent_id: fx.agent.id,
      channel_id: channelId,
      channel_type: channelType,
      target,
    });
    assert.ok(
      (result.body.messages as any[]).every((m) => m.channelId === channelId),
    );
  }
  const ordinary = await readTarget(app.baseUrl, fx.apiKey, "#dx-parent");
  assert.equal(ordinary.body.consumption_scope, undefined);
  const unavailable = await readTarget(
    app.baseUrl,
    fx.apiKey,
    "dm:@nonexistent-peer",
  );
  assert.equal(unavailable.status, 404);
  assert.equal(unavailable.body.consumption_scope, undefined);
});
