import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { getDb } from "../db/index";
import { serverMembers, users } from "../db/schema";
import { openTestApp } from "../test/integration/app";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { findOrCreateAgentDM, findOrCreateDM, getOrCreateThread } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { mintAgentCredential } from "../services/agentCredentialService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

/**
 * The agent read path for a name shared by a human and an agent (task #3):
 * `dm:@Twin~agent` / `dm:@Twin~human` must select the DM, and neither an
 * `--around` anchor nor a thread suffix may carry the read into the other
 * Twin's conversation. Every negative below has a positive control on the
 * same fixture, so a lookup that finds nothing at all cannot pass.
 */

function agentHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

async function seedFixture() {
  const db = getDb();
  const suffix = randomUUID();
  const [owner, humanTwin] = await db.insert(users).values([
    {
      email: `dm-kind-owner-${suffix}@slock.test`,
      name: `dm-kind-owner-${suffix}`,
      passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    },
    {
      email: `dm-kind-twin-${suffix}@slock.test`,
      name: "Twin",
      passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    },
  ]).returning();

  const server = await createServer("DM Peer Kind", `dm-kind-${suffix.slice(0, 8)}`, owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: humanTwin.id, role: "member" });
  const grace = await createAgent(server.id, "Grace", { runtime: "claude", model: "sonnet" });
  const agentTwin = await createAgent(server.id, "Twin", { runtime: "claude", model: "sonnet" });

  const humanDm = await findOrCreateDM(server.id, humanTwin.id, grace.id);
  const agentDm = await findOrCreateAgentDM(server.id, grace.id, agentTwin.id);
  assert.ok(humanDm && agentDm);

  const humanMsg = await createMessage(humanDm.id, "user", humanTwin.id, "from the human Twin", "chat");
  const agentMsg = await createMessage(agentDm.id, "agent", agentTwin.id, "from the agent Twin", "chat");
  const agentThread = await getOrCreateThread(agentMsg.id, agentTwin.id, "agent");
  await createMessage(agentThread.id, "agent", agentTwin.id, "a reply in the agent Twin thread", "chat");

  const credential = await mintAgentCredential({
    agentId: grace.id,
    scopes: ["send", "read"],
    name: "dm-peer-kind",
    issuedVia: "computer",
    createdByUserId: null,
  });
  return { apiKey: credential.apiKey, serverId: server.id, humanMsg, agentMsg, agentThread };
}

async function read(baseUrl: string, apiKey: string, target: string, around?: string) {
  const query = `channel=${encodeURIComponent(target)}${around ? `&around=${encodeURIComponent(around)}` : ""}`;
  const res = await fetch(`${baseUrl}/internal/agent-api/history?${query}`, { headers: agentHeaders(apiKey) });
  const body = await res.json() as Record<string, unknown>;
  const contents = Array.isArray(body.messages)
    ? (body.messages as Array<Record<string, unknown>>).map((m) => String(m.content))
    : [];
  return { status: res.status, body, contents };
}

test("reading a shared name needs the kind, and the kind selects the conversation", async ({ onTestFinished }) => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  onTestFinished(() => app.close());
  const fx = await seedFixture();

  const bare = await read(app.baseUrl, fx.apiKey, "dm:@Twin");
  assert.equal(bare.status, 409);
  assert.equal(bare.body.code, "DM_TARGET_AMBIGUOUS");

  const agent = await read(app.baseUrl, fx.apiKey, "dm:@Twin~agent");
  assert.equal(agent.status, 200);
  assert.ok(agent.contents.includes("from the agent Twin"));
  assert.ok(!agent.contents.includes("from the human Twin"));

  const human = await read(app.baseUrl, fx.apiKey, "dm:@Twin~human");
  assert.equal(human.status, 200);
  assert.ok(human.contents.includes("from the human Twin"));
  assert.ok(!human.contents.includes("from the agent Twin"));
});

test("--around never carries a kind-pinned read into the other Twin's DM", async ({ onTestFinished }) => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  onTestFinished(() => app.close());
  const fx = await seedFixture();
  const agentAnchor = fx.agentMsg.id.slice(0, 8);

  // Control: the anchor is real and readable through the DM it lives in.
  const control = await read(app.baseUrl, fx.apiKey, "dm:@Twin~agent", agentAnchor);
  assert.equal(control.status, 200);
  assert.ok(control.contents.includes("from the agent Twin"));

  const crossed = await read(app.baseUrl, fx.apiKey, "dm:@Twin~human", agentAnchor);
  assert.notEqual(crossed.status, 200, "an anchor from the agent DM must not resolve in the human DM");
  assert.ok(!crossed.contents.includes("from the agent Twin"));
});

test("a DM thread suffix must live under the DM the kind names", async ({ onTestFinished }) => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  onTestFinished(() => app.close());
  const fx = await seedFixture();

  for (const suffix of [fx.agentMsg.id.slice(0, 8), fx.agentThread.id.slice(0, 8)]) {
    const right = await read(app.baseUrl, fx.apiKey, `dm:@Twin~agent:${suffix}`);
    assert.equal(right.status, 200, `control dm:@Twin~agent:${suffix}`);
    assert.ok(right.contents.includes("a reply in the agent Twin thread"));

    const wrong = await read(app.baseUrl, fx.apiKey, `dm:@Twin~human:${suffix}`);
    assert.notEqual(wrong.status, 200, `dm:@Twin~human:${suffix} must not open the agent Twin thread`);
    assert.ok(!wrong.contents.includes("a reply in the agent Twin thread"));
  }
});

async function send(baseUrl: string, apiKey: string, path: "send" | "v2/send", target: string) {
  const res = await fetch(`${baseUrl}/internal/agent-api/${path}`, {
    method: "POST",
    headers: agentHeaders(apiKey),
    body: JSON.stringify({ target, content: `hello ${target}`, idempotencyKey: randomUUID() }),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

test("sending to a shared name answers 409 with the fix, never a 500 (send and v2/send)", async ({ onTestFinished }) => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  onTestFinished(() => app.close());
  const fx = await seedFixture();

  for (const path of ["send", "v2/send"] as const) {
    // Existing DMs with both Twins: the resolver refuses the bare name.
    const bare = await send(app.baseUrl, fx.apiKey, path, "dm:@Twin");
    assert.equal(bare.status, 409, `${path} dm:@Twin`);
    assert.equal(bare.body.code, "DM_TARGET_AMBIGUOUS");
    assert.match(String(bare.body.error), /dm:@Twin~agent/);
    assert.match(String(bare.body.suggestedNextAction), /dm:@Twin~agent.*dm:@Twin~human/);

    const badKind = await send(app.baseUrl, fx.apiKey, path, "dm:@Twin~bot");
    assert.equal(badKind.status, 400, `${path} dm:@Twin~bot`);
    assert.equal(badKind.body.code, "DM_TARGET_INVALID_PEER_KIND");
    assert.equal(typeof badKind.body.suggestedNextAction, "string");

    // Positive control on the same fixture: the kind-pinned target sends.
    const pinned = await send(app.baseUrl, fx.apiKey, path, "dm:@Twin~agent");
    assert.equal(pinned.status, 200, `${path} dm:@Twin~agent`);
  }
});

test("opening a first DM to a shared name answers 409, not a 500", async ({ onTestFinished }) => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  onTestFinished(() => app.close());
  const fx = await seedFixture();
  // A fresh agent with no DM yet reaches the create-DM branch of target resolution.
  const newcomer = await createAgent(fx.serverId, `Newcomer${randomUUID().slice(0, 6)}`, { runtime: "claude", model: "sonnet" });
  const credential = await mintAgentCredential({
    agentId: newcomer.id,
    scopes: ["send", "read"],
    name: "dm-peer-kind-newcomer",
    issuedVia: "computer",
    createdByUserId: null,
  });

  const bare = await send(app.baseUrl, credential.apiKey, "v2/send", "dm:@Twin");
  assert.equal(bare.status, 409);
  assert.equal(bare.body.code, "DM_TARGET_AMBIGUOUS");
  assert.match(String(bare.body.suggestedNextAction), /dm:@Twin~human/);

  const unknown = await send(app.baseUrl, credential.apiKey, "v2/send", "dm:@NobodyByThisName");
  assert.equal(unknown.status, 404);

  const pinned = await send(app.baseUrl, credential.apiKey, "v2/send", "dm:@Twin~human");
  assert.equal(pinned.status, 200);
});
