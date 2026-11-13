/**
 * #wg-rbac:#57: GET /api/agents/:id and GET /api/agents give a member (not
 * the creator, no `editAgents`) an agent's runtime error as its code and fixed
 * sentence, or the generic message, never the text; the creator and owner/admin
 * get the scrubbed, capped text and the code. A row stored unscrubbed (before
 * ingest scrubbing) is scrubbed on read.
 */
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { GENERIC_RUNTIME_ERROR_MESSAGE, RUNTIME_ERROR_CODE_SENTENCES, type AgentRuntimeErrorState } from "@botiverse/raft-shared";

import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { getDb } from "../db/index";
import { agents, serverMembers, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";

const test = createApiTest();

async function seedUser(email: string, name: string) {
  const [user] = await getDb().insert(users).values({
    email, name, displayName: name, passwordHash: await fixturePasswordHash("password123"), emailVerified: true, profileSetupCompletedAt: new Date(),
  }).returning();
  return user!;
}

const RAW = "Request failed: Bearer abcdefghijklmnopqrstuvwxyz0123 at /Users/jane/raft/x.ts for jane.doe@example.com " + "q".repeat(800);
const SECRETS = ["abcdefghijklmnopqrstuvwxyz0123", "/Users/jane", "jane.doe@example.com"];

function assertScrubbed(text: unknown, label: string) {
  assert.equal(typeof text, "string", label);
  for (const secret of SECRETS) assert.ok(!(text as string).includes(secret), `${label} leaks ${secret}`);
  assert.ok((text as string).length <= 512, `${label} is capped`);
}

async function setup(
  app: { baseUrl: string; app: { get: (key: string) => unknown } },
  lastRuntimeError: AgentRuntimeErrorState,
  shown: { activity: string; activityDetailKind?: string } = { activity: "error" },
) {
  const owner = await seedUser(`scrub-rest-owner-${lastRuntimeError.message.length}@slock.test`, `scrub-rest-owner-${lastRuntimeError.message.length}`);
  const creator = await seedUser(`scrub-rest-creator-${lastRuntimeError.message.length}@slock.test`, `scrub-rest-creator-${lastRuntimeError.message.length}`);
  const member = await seedUser(`scrub-rest-member-${lastRuntimeError.message.length}@slock.test`, `scrub-rest-member-${lastRuntimeError.message.length}`);
  const server = await createServer("Scrub Rest", `scrub-rest-${lastRuntimeError.message.length}`, owner.id);
  await getDb().insert(serverMembers).values([
    { serverId: server.id, userId: creator.id, role: "member" },
    { serverId: server.id, userId: member.id, role: "member" },
  ]);
  const agent = await createAgent(server.id, `scrub-rest-${lastRuntimeError.message.length}`, { runtime: "codex", creatorType: "user", creatorId: creator.id });
  // Stored as an older server wrote it: unscrubbed.
  await getDb().update(agents).set({ lastRuntimeError }).where(eq(agents.id, agent.id));
  const orchestrator = app.app.get("agentOrchestrator") as { getActivity: (id: string) => Promise<{ activity: string; activityDetail: string; activityDetailKind?: string }> };
  orchestrator.getActivity = async () => ({ ...shown, activityDetail: lastRuntimeError.message });
  const read = async (email: string) => {
    const headers = { Authorization: `Bearer ${await tokenForHuman(email)}`, "X-Server-Id": server.id };
    const detail = await (await fetch(`${app.baseUrl}/api/agents/${agent.id}`, { headers })).json() as Record<string, any>;
    const list = await (await fetch(`${app.baseUrl}/api/agents`, { headers })).json() as Array<Record<string, any>>;
    return { detail, listed: list.find((candidate) => candidate.id === agent.id)! };
  };
  return { owner, creator, member, read };
}

test("an uncoded stored error: a member reads the generic message and no code; creator and owner the scrubbed text", async ({ app }) => {
  const { owner, creator, member, read } = await setup(app, { message: RAW, at: new Date().toISOString(), actionRequired: true });
  const asMember = await read(member.email);
  for (const [label, body] of Object.entries(asMember)) {
    assert.equal(body.lastRuntimeError.message, GENERIC_RUNTIME_ERROR_MESSAGE, `${label}: member message`);
    assert.equal(body.lastRuntimeError.code, undefined, `${label}: no code`);
    assert.equal(body.activityDetail, GENERIC_RUNTIME_ERROR_MESSAGE, `${label}: member activity detail`);
    assert.equal(body.activityErrorCode, undefined);
  }
  for (const user of [creator, owner]) {
    const asManager = await read(user.email);
    for (const [label, body] of Object.entries(asManager)) {
      assertScrubbed(body.lastRuntimeError.message, `${user.name} ${label} lastRuntimeError`);
      assert.match(body.lastRuntimeError.message, /\[REDACTED_TOKEN\]/);
      assert.equal(body.activityDetail, body.lastRuntimeError.message, `${user.name} ${label}: activity matches the record`);
    }
  }
});

test("a coded stored error: every viewer gets the code; a member reads its fixed sentence", async ({ app }) => {
  const { creator, member, read } = await setup(app, {
    message: "Codex is not logged in on this machine. token=abcdefghijklmnopqrstuvwxyz0123",
    at: new Date().toISOString(),
    actionRequired: true,
    errorClass: "AuthError",
    errorReason: "auth_failed",
    requiredAction: "user_reauth",
  });
  for (const [label, body] of Object.entries(await read(member.email))) {
    assert.equal(body.lastRuntimeError.code, "auth_required", label);
    assert.equal(body.lastRuntimeError.message, RUNTIME_ERROR_CODE_SENTENCES.auth_required, label);
    assert.equal(body.activityDetail, RUNTIME_ERROR_CODE_SENTENCES.auth_required, label);
    assert.equal(body.activityErrorCode, "auth_required", label);
    assert.equal(body.lastRuntimeError.errorClass, "AuthError", "the typed class stays");
  }
  for (const [label, body] of Object.entries(await read(creator.email))) {
    assert.equal(body.lastRuntimeError.code, "auth_required", label);
    assert.match(body.lastRuntimeError.message, /is not logged in/);
    assertScrubbed(body.lastRuntimeError.message, label);
    assert.equal(body.activityErrorCode, "auth_required", label);
  }
});

test("a crash shown on a non-error activity (offline + runtime_crashed): a member reads no text, the creator the scrubbed text", async ({ app }) => {
  const { creator, member, read } = await setup(app, { message: RAW + " crash", at: new Date().toISOString(), actionRequired: true }, { activity: "offline", activityDetailKind: "runtime_crashed" });
  for (const [label, body] of Object.entries(await read(member.email))) {
    assert.equal(body.activity, "offline");
    assert.equal(body.activityDetail, GENERIC_RUNTIME_ERROR_MESSAGE, `${label}: member reads no text`);
  }
  for (const [label, body] of Object.entries(await read(creator.email))) {
    assertScrubbed(body.activityDetail, `${label}: creator crash detail`);
    assert.match(body.activityDetail, /\[REDACTED_TOKEN\]/);
  }
});
