// Raft voice (#wg-runtime-form:#22): POST /api/oauth/agents/:agentId/voice/status
// and /voice/ask, asked as the signed-in person with `agent:voice`. Behind
// agent_voice_v1. Status: a non-guest member who can view agents (an
// assistant: its owner). Question: View Context (creator, owner/admin; an
// assistant: its owner). Every refusal past the token is the unknown-agent 404.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AGENT_VOICE_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash, signInForTest, tokenForHuman } from "../test/integration/credentials";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { agents, featureFlagRules, featureFlags, serverMembers, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { createOAuthClient, issueHumanAuthorizationCode, requestAgentAccess } from "../services/oauthService";
import { AGENT_VOICE_QUESTION_TOTAL_LIMIT, AGENT_VOICE_RATE_LIMITS, askAgentByVoice, resetAgentVoiceRateLimitForTests } from "../services/agentVoiceService";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import { seedBoundGuest } from "../test/guestFixture";

const test = createApiTest();

async function seedUser(label: string) {
  const suffix = randomUUID();
  const [user] = await getDb().insert(users).values({
    email: `${label}-${suffix}@raft.test`,
    name: `${label}-${suffix.slice(0, 8)}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user!;
}

async function enableFlag(serverId: string) {
  await getDb().insert(featureFlags)
    .values({ key: AGENT_VOICE_FEATURE_FLAG_KEY, randomizationUnit: "server", salt: "test", defaultEnabled: false })
    .onConflictDoNothing();
  await getDb().insert(featureFlagRules).values({
    id: randomUUID(), flagKey: AGENT_VOICE_FEATURE_FLAG_KEY, stage: "server", priority: 0, decision: "allow", values: [serverId],
  });
}

async function seedAgent(serverId: string, values: Partial<typeof agents.$inferInsert> = {}) {
  const [agent] = await getDb().insert(agents).values({
    serverId, name: `voice${randomUUID().slice(0, 6)}`, status: "active", runtime: "claude", model: "sonnet",
    executionMode: "byoc", ...values,
  }).returning();
  return agent!;
}

/** Owner, a member who created the agent, another member; flag on unless asked otherwise. */
async function seed(options: { flag?: boolean } = {}) {
  resetAgentVoiceRateLimitForTests();
  const owner = await seedUser("voice-owner");
  const creator = await seedUser("voice-creator");
  const member = await seedUser("voice-member");
  const server = await createServer("Voice", `voice-${randomUUID().slice(0, 8)}`, owner.id);
  const other = await createServer("Other", `voice-other-${randomUUID().slice(0, 8)}`, owner.id);
  await getDb().insert(serverMembers).values([
    { serverId: server.id, userId: creator.id, role: "member" },
    { serverId: server.id, userId: member.id, role: "member" },
  ]);
  const agent = await seedAgent(server.id, { creatorType: "user", creatorId: creator.id });
  const foreign = await seedAgent(other.id, { creatorType: "user", creatorId: owner.id });
  if (options.flag !== false) await enableFlag(server.id);
  const { client, clientSecret } = await createOAuthClient({
    serverId: server.id, createdByUserId: owner.id, clientId: `voice-${randomUUID().slice(0, 8)}`,
    name: "Voice", returnUrl: "https://voice.example.test/callback",
    allowedScopes: ["openid", "profile", "agent:voice"],
  });
  return { owner, creator, member, server, other, agent, foreign, client, clientSecret };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

async function exchange(baseUrl: string, f: Seeded, code: string) {
  const response = await fetch(`${baseUrl}/api/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${Buffer.from(`${f.client.clientId}:${f.clientSecret}`).toString("base64")}` },
    body: JSON.stringify({ grant_type: "authorization_code", code, redirect_uri: f.client.returnUrl }),
  });
  const body = await response.json() as { access_token: string };
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.access_token;
}

async function humanToken(baseUrl: string, f: Seeded, userId: string, scopes = ["openid", "profile", "agent:voice"]) {
  const { code } = await issueHumanAuthorizationCode({
    clientKey: f.client.clientId, userId, serverId: f.server.id, returnUrl: f.client.returnUrl!, scopes,
    approverSessionFamilyId: (await signInForTest(userId)).familyId,
  });
  return await exchange(baseUrl, f, code);
}

type SideAskCall = Parameters<AgentOrchestrator["sideAskAgent"]>;

function fakeOrchestrator() {
  const calls: SideAskCall[] = [];
  const orchestrator = {
    async sideAskAgent(...args: SideAskCall) {
      calls.push(args);
      return args[2].kind === "status"
        ? { outcome: "answered" as const, text: "Now: working: Running tests." }
        : { outcome: "answered" as const, text: "The deploy is green." };
    },
  };
  return { calls, orchestrator };
}

function ask(baseUrl: string, bearer: string, agentId: string, kind: "status" | "ask", body: unknown = {}) {
  return fetch(`${baseUrl}/api/oauth/agents/${agentId}/voice/${kind}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("the agent's creator asks a question: the daemon gets it with Raft's record of who asks", async ({ app }) => {
  const f = await seed();
  const fake = fakeOrchestrator();
  app.app.set("agentOrchestrator", fake.orchestrator);
  const bearer = await humanToken(app.baseUrl, f, f.creator.id);

  const answer = await ask(app.baseUrl, bearer, f.agent.id, "ask", { question: "  Is the deploy green?  " });
  assert.equal(answer.status, 200);
  assert.equal(answer.headers.get("cache-control"), "no-store");
  assert.deepEqual(await answer.json(), { outcome: "answered", text: "The deploy is green." });
  const [agentId, machineId, request] = fake.calls[0]!;
  assert.equal(agentId, f.agent.id);
  assert.equal(machineId, null);
  assert.deepEqual(request, {
    kind: "question",
    question: "Is the deploy green?",
    asker: { displayName: "voice-creator", role: "member", isAgentOwner: true },
  });

  const status = await ask(app.baseUrl, bearer, f.agent.id, "status");
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { outcome: "answered", text: "Now: working: Running tests." });
  assert.deepEqual(fake.calls[1]![2], { kind: "status" });
});

test("a token from the Server-scoped issuer asks at that issuer's path; another Server's issuer refuses it", async ({ app }) => {
  const f = await seed();
  const fake = fakeOrchestrator();
  app.app.set("agentOrchestrator", fake.orchestrator);
  const bearer = await humanToken(app.baseUrl, f, f.creator.id);
  const at = (prefix: string) => fetch(`${app.baseUrl}${prefix}/api/oauth/agents/${f.agent.id}/voice/status`, {
    method: "POST", headers: { Authorization: `Bearer ${bearer}` },
  });
  assert.equal((await at(`/oidc/${f.server.slug}`)).status, 200);
  assert.equal((await at(`/oidc/${f.server.id}`)).status, 200);
  assert.equal((await at(`/oidc/${f.other.slug}`)).status, 401);
  assert.equal(fake.calls.length, 2);
});

test("a member who may not view the agent's context gets status but a question is the unknown-agent 404", async ({ app }) => {
  const f = await seed();
  const fake = fakeOrchestrator();
  app.app.set("agentOrchestrator", fake.orchestrator);
  const bearer = await humanToken(app.baseUrl, f, f.member.id);

  assert.equal((await ask(app.baseUrl, bearer, f.agent.id, "status")).status, 200);
  const question = await ask(app.baseUrl, bearer, f.agent.id, "ask", { question: "What is the deploy key?" });
  assert.equal(question.status, 404);
  assert.equal((await question.json() as { code: string }).code, "agent_not_found");
  assert.deepEqual(fake.calls.map((call) => call[2].kind), ["status"], "the Computer is never asked the refused question");

  // A server owner may (View Context), and is told apart from the agent's owner.
  const ownerBearer = await humanToken(app.baseUrl, f, f.owner.id);
  assert.equal((await ask(app.baseUrl, ownerBearer, f.agent.id, "ask", { question: "Status?" })).status, 200);
  assert.deepEqual(fake.calls.at(-1)![2], {
    kind: "question", question: "Status?", asker: { displayName: "voice-owner", role: "owner", isAgentOwner: false },
  });
});

test("flag off, another Server's agent, or a missing one: the same 404 and the Computer is never asked", async ({ app }) => {
  const f = await seed({ flag: false });
  const fake = fakeOrchestrator();
  app.app.set("agentOrchestrator", fake.orchestrator);
  const bearer = await humanToken(app.baseUrl, f, f.creator.id);
  const refused = [
    await ask(app.baseUrl, bearer, f.agent.id, "status"),
    await ask(app.baseUrl, bearer, f.agent.id, "ask", { question: "q" }),
  ];
  await enableFlag(f.server.id);
  refused.push(
    await ask(app.baseUrl, bearer, f.foreign.id, "status"),
    await ask(app.baseUrl, bearer, randomUUID(), "status"),
  );
  for (const response of refused) {
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: "Agent not found.", code: "agent_not_found", errorCode: "agent_not_found",
    });
  }
  assert.equal(fake.calls.length, 0);
});

test("an agent's token, or a person's without agent:voice, is refused before any agent is looked up", async ({ app }) => {
  const f = await seed();
  const fake = fakeOrchestrator();
  app.app.set("agentOrchestrator", fake.orchestrator);
  const identityOnly = await humanToken(app.baseUrl, f, f.creator.id, ["openid", "profile"]);
  assert.equal((await ask(app.baseUrl, identityOnly, f.agent.id, "status")).status, 403);
  // An agent with its own sign-in (a server member, as createAgent makes it).
  const signedIn = await createAgent(f.server.id, `voiceapp${randomUUID().slice(0, 6)}`, { runtime: "external", model: "external" });
  const agentCode = (await requestAgentAccess({
    clientId: f.client.id, serverSlug: f.server.slug, agentName: signedIn.name, scopes: ["openid", "profile", "agent:voice"],
  })).request.id;
  const agentBearer = await exchange(app.baseUrl, f, agentCode);
  assert.equal((await ask(app.baseUrl, agentBearer, f.agent.id, "status")).status, 403);
  assert.equal((await ask(app.baseUrl, "not-a-token", f.agent.id, "status")).status, 401);
  assert.equal(fake.calls.length, 0);
});

test("a personal assistant answers its owner only; a server owner gets the unknown-agent 404", async ({ app }) => {
  const f = await seed();
  const fake = fakeOrchestrator();
  app.app.set("agentOrchestrator", fake.orchestrator);
  const assistant = await seedAgent(f.server.id, {
    creatorType: "user", creatorId: f.member.id, assistantOwnerUserId: f.member.id,
  });
  const ownerBearer = await humanToken(app.baseUrl, f, f.owner.id);
  assert.equal((await ask(app.baseUrl, ownerBearer, assistant.id, "status")).status, 404);
  assert.equal((await ask(app.baseUrl, ownerBearer, assistant.id, "ask", { question: "q" })).status, 404);
  const memberBearer = await humanToken(app.baseUrl, f, f.member.id);
  assert.equal((await ask(app.baseUrl, memberBearer, assistant.id, "status")).status, 200);
  assert.equal((await ask(app.baseUrl, memberBearer, assistant.id, "ask", { question: "q" })).status, 200);
  assert.deepEqual(fake.calls.at(-1)![2], {
    kind: "question", question: "q", asker: { displayName: "voice-member", role: "member", isAgentOwner: true },
  });
});

test("a guest may ask nothing, even as the agent's recorded creator", async ({ app }) => {
  const f = await seed();
  const fake = fakeOrchestrator();
  const guest = await seedUser("voice-guest");
  await seedBoundGuest({ serverId: f.server.id, userId: guest.id, member: true });
  const theirs = await seedAgent(f.server.id, { creatorType: "user", creatorId: guest.id });
  for (const kind of ["status", "question"] as const) {
    const result = await askAgentByVoice({
      orchestrator: fake.orchestrator as unknown as AgentOrchestrator,
      serverId: f.server.id, userId: guest.id, agentId: theirs.id,
      ask: kind === "status" ? { kind } : { kind, question: "q" },
    });
    assert.deepEqual(result, { ok: false, code: "not_found" });
  }
  assert.equal(fake.calls.length, 0);
  void app;
});

test("questions are budgeted per person and agent; past it a 429 with Retry-After", async ({ app }) => {
  const f = await seed();
  const fake = fakeOrchestrator();
  app.app.set("agentOrchestrator", fake.orchestrator);
  const bearer = await humanToken(app.baseUrl, f, f.creator.id);
  for (let i = 0; i < AGENT_VOICE_RATE_LIMITS.question.max; i += 1) {
    assert.equal((await ask(app.baseUrl, bearer, f.agent.id, "ask", { question: `q${i}` })).status, 200);
  }
  const limited = await ask(app.baseUrl, bearer, f.agent.id, "ask", { question: "one more" });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  assert.equal((await limited.json() as { code: string }).code, "voice_rate_limited");
  assert.equal(fake.calls.length, AGENT_VOICE_RATE_LIMITS.question.max);
  // Status has its own budget.
  assert.equal((await ask(app.baseUrl, bearer, f.agent.id, "status")).status, 200);
});

test("an empty or over-long question is a 400 before anything else", async ({ app }) => {
  const f = await seed();
  const fake = fakeOrchestrator();
  app.app.set("agentOrchestrator", fake.orchestrator);
  const bearer = await humanToken(app.baseUrl, f, f.creator.id);
  for (const body of [{}, { question: "   " }, { question: 7 }, { question: "x".repeat(2_001) }]) {
    const response = await ask(app.baseUrl, bearer, f.agent.id, "ask", body);
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { code: string }).code, "invalid_question");
  }
  assert.equal(fake.calls.length, 0);
});

async function listQuestions(baseUrl: string, serverId: string, email: string, agentId: string) {
  const response = await fetch(`${baseUrl}/api/agents/${agentId}/voice-questions`, {
    headers: { Authorization: `Bearer ${await tokenForHuman(email)}`, "X-Server-Id": serverId },
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

test("every question is recorded before it is asked and listed to those who may ask; never the question", async ({ app }) => {
  const f = await seed();
  const fake = fakeOrchestrator();
  app.app.set("agentOrchestrator", fake.orchestrator);
  const bearer = await humanToken(app.baseUrl, f, f.creator.id);
  assert.equal((await ask(app.baseUrl, bearer, f.agent.id, "ask", { question: "What is in the private channel?" })).status, 200);
  assert.equal((await ask(app.baseUrl, bearer, f.agent.id, "status")).status, 200);

  const listed = await listQuestions(app.baseUrl, f.server.id, f.creator.email, f.agent.id);
  assert.equal(listed.status, 200);
  const questions = listed.body.questions as Array<Record<string, unknown>>;
  assert.equal(questions.length, 1, "a status read is not recorded");
  assert.deepEqual(questions[0]!.asker, { id: f.creator.id, name: "voice-creator" });
  assert.deepEqual(questions[0]!.app, { name: "Voice" });
  assert.equal(typeof questions[0]!.at, "string");
  assert.doesNotMatch(JSON.stringify(listed.body), /private channel/);
  // The server owner may ask, so may see it; a member who may only read status may not.
  assert.equal((await listQuestions(app.baseUrl, f.server.id, f.owner.email, f.agent.id)).status, 200);
  const member = await listQuestions(app.baseUrl, f.server.id, f.member.email, f.agent.id);
  assert.equal(member.status, 404);
  assert.equal(member.body.code, "agent_not_found");
});

test("with the flag off the list is the unknown-agent 404, for the creator too", async ({ app }) => {
  const f = await seed({ flag: false });
  assert.equal((await listQuestions(app.baseUrl, f.server.id, f.creator.email, f.agent.id)).status, 404);
});

test("one person's questions across every agent have their own hourly ceiling", async ({ app }) => {
  const f = await seed();
  const fake = fakeOrchestrator();
  app.app.set("agentOrchestrator", fake.orchestrator);
  const perAgent = AGENT_VOICE_RATE_LIMITS.question.max;
  const agentsNeeded = Math.ceil(AGENT_VOICE_QUESTION_TOTAL_LIMIT.max / perAgent) + 1;
  const owned = [];
  for (let i = 0; i < agentsNeeded; i += 1) owned.push(await seedAgent(f.server.id, { creatorType: "user", creatorId: f.owner.id }));
  const bearer = await humanToken(app.baseUrl, f, f.owner.id);
  let answered = 0;
  let limited: Response | null = null;
  for (const agent of owned) {
    for (let i = 0; i < perAgent && !limited; i += 1) {
      const response = await ask(app.baseUrl, bearer, agent.id, "ask", { question: `q${i}` });
      if (response.status === 429) limited = response;
      else answered += 1;
    }
  }
  assert.equal(answered, AGENT_VOICE_QUESTION_TOTAL_LIMIT.max);
  assert.ok(limited, "past the total, a question to a fresh agent is refused");
  assert.equal((await limited.json() as { code: string }).code, "voice_rate_limited");
  assert.equal(fake.calls.length, AGENT_VOICE_QUESTION_TOTAL_LIMIT.max);
});

// #otter-lounge:#1: a side question waits up to a minute; the edge closes a
// request silent for 30 s. With respondAsync the ask answers 202 once its
// checks (and the question's record) are done, and the answer is read back.
test("respondAsync: a question answers 202 after its checks and record; the answer is read back by the same person only", async ({ app }) => {
  const f = await seed();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const calls: unknown[] = [];
  app.app.set("agentOrchestrator", {
    async sideAskAgent(...args: unknown[]) {
      calls.push(args);
      await held;
      return { outcome: "answered", text: "Green." };
    },
  });
  const creator = await humanToken(app.baseUrl, f, f.creator.id);
  const started = await ask(app.baseUrl, creator, f.agent.id, "ask", { question: "Deploy?", respondAsync: true });
  assert.equal(started.status, 202);
  const { operationId } = await started.json() as { operationId: string };
  const listed = await listQuestions(app.baseUrl, f.server.id, f.creator.email, f.agent.id);
  assert.equal((listed.body.questions as unknown[]).length, 1, "recorded before the 202");

  const read = (token: string, prefix = "") => fetch(`${app.baseUrl}${prefix}/api/oauth/agents/${f.agent.id}/voice/operations/${operationId}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.deepEqual(await (await read(creator)).json(), { state: "pending" });
  const owner = await humanToken(app.baseUrl, f, f.owner.id);
  assert.equal((await read(owner)).status, 404, "another person's token");

  release();
  let view: { state: string; status?: number; body?: unknown } = { state: "pending" };
  for (let i = 0; i < 50 && view.state === "pending"; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    view = await (await read(creator, `/oidc/${f.server.slug}`)).json() as typeof view;
  }
  assert.deepEqual(view, { state: "done", status: 200, body: { outcome: "answered", text: "Green." } });

  // Tenny's 1.28.0 review: the kept answer is the agent's (another agent's
  // path does not find it), and is shown only while the right to ask holds.
  const otherAgentRead = await fetch(`${app.baseUrl}/api/oauth/agents/${randomUUID()}/voice/operations/${operationId}`, { headers: { Authorization: `Bearer ${creator}` } });
  assert.equal(otherAgentRead.status, 404, "bound to the agent it was asked of");
  await getDb().update(agents).set({ voiceAskable: false }).where(eq(agents.id, f.agent.id));
  assert.equal((await read(creator)).status, 404, "asking turned off since: the kept answer is not shown");
  await getDb().update(agents).set({ voiceAskable: true }).where(eq(agents.id, f.agent.id));

  // A refusal still answers at once, never as an operation.
  const member = await humanToken(app.baseUrl, f, f.member.id);
  const refused = await ask(app.baseUrl, member, f.agent.id, "ask", { question: "q", respondAsync: true });
  assert.equal(refused.status, 404);
  assert.equal(calls.length, 1);
});

test("a voice operation is not readable from the web, even by the same person", async ({ app }) => {
  const f = await seed();
  app.app.set("agentOrchestrator", { async sideAskAgent() { return { outcome: "answered", text: "ok" }; } });
  const bearer = await humanToken(app.baseUrl, f, f.creator.id);
  const started = await ask(app.baseUrl, bearer, f.agent.id, "status", { respondAsync: true });
  assert.equal(started.status, 202);
  const { operationId } = await started.json() as { operationId: string };
  const web = await fetch(`${app.baseUrl}/api/servers/${f.server.id}/machine-operations/${operationId}`, {
    headers: { Authorization: `Bearer ${await tokenForHuman(f.creator.email)}`, "X-Server-Id": f.server.id },
  });
  assert.equal(web.status, 404);
});

async function voiceSettings(baseUrl: string, serverId: string, email: string, agentId: string, change?: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/api/agents/${agentId}/voice-settings`, {
    method: change ? "PUT" : "GET",
    headers: { Authorization: `Bearer ${await tokenForHuman(email)}`, "X-Server-Id": serverId, "Content-Type": "application/json" },
    ...(change ? { body: JSON.stringify(change) } : {}),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

test("the agent's editors turn asking off; then every ask is the unknown-agent 404 and the Computer is never asked", async ({ app }) => {
  const f = await seed();
  const fake = fakeOrchestrator();
  app.app.set("agentOrchestrator", fake.orchestrator);
  assert.deepEqual((await voiceSettings(app.baseUrl, f.server.id, f.creator.email, f.agent.id)).body, { askable: true, callable: true });
  // Someone who may not edit the agent sees nothing and changes nothing.
  assert.equal((await voiceSettings(app.baseUrl, f.server.id, f.member.email, f.agent.id)).status, 404);
  assert.equal((await voiceSettings(app.baseUrl, f.server.id, f.member.email, f.agent.id, { askable: false })).status, 404);
  assert.equal((await voiceSettings(app.baseUrl, f.server.id, f.creator.email, f.agent.id, { askable: "no" })).status, 400);

  const off = await voiceSettings(app.baseUrl, f.server.id, f.creator.email, f.agent.id, { askable: false });
  assert.deepEqual(off.body, { askable: false, callable: true });
  const bearer = await humanToken(app.baseUrl, f, f.creator.id);
  assert.equal((await ask(app.baseUrl, bearer, f.agent.id, "status")).status, 404);
  assert.equal((await ask(app.baseUrl, bearer, f.agent.id, "ask", { question: "q" })).status, 404);
  assert.equal(fake.calls.length, 0);

  // A server owner may edit it too, and turn it back on.
  assert.deepEqual((await voiceSettings(app.baseUrl, f.server.id, f.owner.email, f.agent.id, { askable: true })).body, { askable: true, callable: true });
  assert.equal((await ask(app.baseUrl, bearer, f.agent.id, "status")).status, 200);
});

test("with the flag off the voice settings are the unknown-agent 404", async ({ app }) => {
  const f = await seed({ flag: false });
  assert.equal((await voiceSettings(app.baseUrl, f.server.id, f.creator.email, f.agent.id)).status, 404);
});
