// The agent API's write budgets (services/agentApiWriteLimits.ts, routes/
// internalAgentApi.ts AGENT_API_WRITE_BUDGET_ROUTES): per class, a per-agent
// and a per-Server budget a minute; past either, 429 RATE_LIMITED with
// Retry-After before the route runs. Normal use passes, and another agent or
// another Server keeps its own budget. Each class is tried on one route.
import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash } from "../test/integration/credentials";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach } from "vitest";
import { AGENT_API_RATE_LIMITED_CODE, parseAgentApiRateLimitedBody } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { addAgent, addHuman, createChannel } from "../services/channelService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createMessage } from "../services/messageService";
import {
  __setAgentApiWriteBudgetsForTests,
  AGENT_API_WRITE_BUDGETS,
  AGENT_API_WRITE_WINDOW_SECONDS,
  type AgentApiWriteBudgetClass,
} from "../services/agentApiWriteLimits";

const test = createApiTest();

afterEach(() => __setAgentApiWriteBudgetsForTests(null));

async function seedServer(label: string) {
  const suffix = randomUUID().slice(0, 8);
  const [owner] = await getDb().insert(users).values({
    email: `${label}-${suffix}@slock.test`,
    name: `${label}${suffix}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer("Write Budgets", `write-budgets-${suffix}`, owner!.id);
  const channel = await createChannel(server.id, `budgets-${suffix}`);
  await addHuman(channel.id, owner!.id);
  const agent = async (name: string) => {
    const row = await createAgent(server.id, `${name}${suffix}`, { runtime: "claude", model: "sonnet" });
    await addAgent(channel.id, row.id);
    const { apiKey } = await mintAgentCredential({
      agentId: row.id,
      scopes: ["send", "read", "mentions", "tasks", "reactions", "channels"],
      name: "write-budgets-test",
      issuedVia: "computer",
      createdByUserId: null,
    });
    return { id: row.id, key: apiKey };
  };
  const [a, b] = [await agent("BudgetA"), await agent("BudgetB")];
  const message = await createMessage(channel.id, "user", owner!.id, "something to react to");
  return { serverId: server.id, channel, a, b, messageId: message.id as string };
}
type Seeded = Awaited<ReturnType<typeof seedServer>>;

async function call(baseUrl: string, apiKey: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/internal/agent-api${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, retryAfter: res.headers.get("retry-after"), body: await res.json() as any };
}

type Write = (baseUrl: string, seeded: Seeded, key: string) => Promise<{ status: number; retryAfter: string | null; body: any }>;

/** One write per class, with the status a normal (admitted) one answers; `units` is what one write spends. */
const CLASSES: Array<{ kind: AgentApiWriteBudgetClass; operation: string; ok: number; units: number; write: Write }> = [
  {
    kind: "messages", operation: "messageSendV2", ok: 200, units: 1,
    write: (baseUrl, s, key) => call(baseUrl, key, "POST", "/v2/send", { target: `#${s.channel.name}`, content: `hello ${randomUUID()}` }),
  },
  {
    kind: "reactions", operation: "messageReactionAdd", ok: 200, units: 1,
    write: (baseUrl, s, key) => call(baseUrl, key, "POST", `/messages/${s.messageId}/reactions`, { emoji: "👍" }),
  },
  {
    // Two resolution ids: two units. Unknown ids are answered per id, not refused.
    kind: "mentionActions", operation: "mentionActionsExecute", ok: 200, units: 2,
    write: (baseUrl, _s, key) => call(baseUrl, key, "POST", "/mention-actions/execute", { action: "notify", resolutionIds: [randomUUID(), randomUUID()] }),
  },
  {
    // A batch of two tasks: two units.
    kind: "taskWrites", operation: "taskCreate", ok: 200, units: 2,
    write: (baseUrl, s, key) => call(baseUrl, key, "POST", "/tasks", { channel: `#${s.channel.name}`, tasks: [{ title: "one" }, { title: "two" }] }),
  },
  {
    kind: "channelWrites", operation: "channelCreate", ok: 200, units: 1,
    write: (baseUrl, _s, key) => call(baseUrl, key, "POST", "/channels", { name: `made-${randomUUID().slice(0, 8)}` }),
  },
];

function assertRateLimited(result: { status: number; retryAfter: string | null; body: any }, operation: string, limit: number) {
  assert.equal(result.status, 429, JSON.stringify(result.body));
  assert.equal(result.body.code, AGENT_API_RATE_LIMITED_CODE);
  const parsed = parseAgentApiRateLimitedBody(result.body);
  assert.ok(parsed, "the body older clients parse");
  assert.equal(parsed.details.operation, operation);
  assert.equal(parsed.details.limit, limit);
  assert.equal(parsed.details.windowSeconds, AGENT_API_WRITE_WINDOW_SECONDS);
  assert.ok(Number(result.retryAfter) >= 1 && Number(result.retryAfter) <= AGENT_API_WRITE_WINDOW_SECONDS);
  assert.equal(Number(result.retryAfter), parsed.details.retryAfterSeconds);
}

for (const { kind, operation, ok, units, write } of CLASSES) {
  test(`${kind}: the agent's budget trips at its limit; another agent and another server are unaffected`, async ({ app }) => {
    const [s, other] = [await seedServer("budget-owner"), await seedServer("budget-other")];
    const perAgent = 2 * units;
    __setAgentApiWriteBudgetsForTests({ [kind]: { perAgent, perServer: 100 } });
    for (let i = 0; i < 2; i += 1) {
      const passed = await write(app.baseUrl, s, s.a.key);
      assert.equal(passed.status, ok, `write ${i}: ${JSON.stringify(passed.body)}`);
    }
    const refused = await write(app.baseUrl, s, s.a.key);
    assertRateLimited(refused, operation, perAgent);
    assert.match(refused.body.error, /^This agent made too many /);
    assert.equal((await write(app.baseUrl, s, s.b.key)).status, ok, "another agent of the server");
    assert.equal((await write(app.baseUrl, other, other.a.key)).status, ok, "an agent of another server");
  });

  test(`${kind}: the server's budget trips across two agents; another server is unaffected`, async ({ app }) => {
    const [s, other] = [await seedServer("budget-owner"), await seedServer("budget-other")];
    const perServer = 3 * units;
    __setAgentApiWriteBudgetsForTests({ [kind]: { perAgent: 100, perServer } });
    assert.equal((await write(app.baseUrl, s, s.a.key)).status, ok);
    assert.equal((await write(app.baseUrl, s, s.a.key)).status, ok);
    assert.equal((await write(app.baseUrl, s, s.b.key)).status, ok);
    const refused = await write(app.baseUrl, s, s.b.key);
    assertRateLimited(refused, operation, perServer);
    assert.match(refused.body.error, /for the whole server/);
    assert.equal((await write(app.baseUrl, other, other.b.key)).status, ok, "an agent of another server");
  });
}

test("otherWrites: thread follows and attachment comments count against one budget", async ({ app }) => {
  const s = await seedServer("budget-owner");
  __setAgentApiWriteBudgetsForTests({ otherWrites: { perAgent: 2, perServer: 100 } });
  // Unknown targets: answered (not 429) and still counted.
  const follow = await call(app.baseUrl, s.a.key, "POST", "/threads/follow", { thread: `#${s.channel.name}:deadbeef` });
  assert.notEqual(follow.status, 429, JSON.stringify(follow.body));
  const comment = await call(app.baseUrl, s.a.key, "POST", `/attachments/${randomUUID()}/comments`, { content: "nice" });
  assert.notEqual(comment.status, 429, JSON.stringify(comment.body));
  assertRateLimited(await call(app.baseUrl, s.a.key, "POST", "/threads/follow", { thread: `#${s.channel.name}:deadbeef` }), "threadFollow", 2);
  assertRateLimited(await call(app.baseUrl, s.a.key, "POST", `/attachments/${randomUUID()}/comments`, { content: "nice" }), "attachmentCommentCreate", 2);
  assert.notEqual((await call(app.baseUrl, s.b.key, "POST", "/threads/follow", { thread: `#${s.channel.name}:deadbeef` })).status, 429, "another agent");
});

test("reads and unlisted writes spend no budget, and the harness skips the budgets unless a test sets them", async ({ app }) => {
  const s = await seedServer("budget-owner");
  __setAgentApiWriteBudgetsForTests({ messages: { perAgent: 1, perServer: 1 } });
  for (let i = 0; i < 3; i += 1) assert.equal((await call(app.baseUrl, s.a.key, "GET", "/tasks?channel=" + encodeURIComponent(`#${s.channel.name}`))).status, 200);
  assert.equal((await call(app.baseUrl, s.a.key, "POST", `/messages/${s.messageId}/reactions`, { emoji: "👍" })).status, 200, "reactions not set: skipped");
  assert.equal((await call(app.baseUrl, s.a.key, "POST", "/v2/send", { target: `#${s.channel.name}`, content: "one" })).status, 200);
  assertRateLimited(await call(app.baseUrl, s.a.key, "POST", "/send", { target: `#${s.channel.name}`, content: "two" }), "messageSend", 1);
  __setAgentApiWriteBudgetsForTests(null);
  assert.equal((await call(app.baseUrl, s.a.key, "POST", "/v2/send", { target: `#${s.channel.name}`, content: "three" })).status, 200, "defaults skipped in the pglite harness");
});

test("a request larger than a whole budget is refused outright, never charged at the limit", async ({ app }) => {
  const s = await seedServer("budget-size");
  const create = (count: number) => call(app.baseUrl, s.a.key, "POST", "/tasks", {
    channel: `#${s.channel.name}`,
    tasks: Array.from({ length: count }, (_, i) => ({ title: `t${i}` })),
  });
  __setAgentApiWriteBudgetsForTests({ taskWrites: { perAgent: 5, perServer: 100 } });
  const tooLarge = await create(6);
  assert.equal(tooLarge.status, 400, JSON.stringify(tooLarge.body));
  assert.equal(tooLarge.body.code, "agent_api_write_too_large");
  assert.equal((await create(5)).status, 200, "the refused request spent nothing");
  // The server's budget bounds it too.
  __setAgentApiWriteBudgetsForTests({ taskWrites: { perAgent: 100, perServer: 3 } });
  assert.equal((await create(4)).body.code, "agent_api_write_too_large");
  // Task create's own batch cap (50) stays below the real per-agent budget.
  __setAgentApiWriteBudgetsForTests({ taskWrites: { perAgent: 1000, perServer: 1000 } });
  assert.equal((await create(51)).status, 400);
  assert.ok(AGENT_API_WRITE_BUDGETS.taskWrites.perAgent >= 50 && AGENT_API_WRITE_BUDGETS.mentionActions.perAgent >= 100);
});

test("a send's reconcileOnly lookup spends its own budget: it answers past the messages limit and is bounded by its own", async ({ app }) => {
  const s = await seedServer("budget-reconcile");
  __setAgentApiWriteBudgetsForTests({ messages: { perAgent: 1, perServer: 100 }, reconcile: { perAgent: 4, perServer: 100 } });
  const key = `reconcile-${randomUUID()}`;
  const sent = await call(app.baseUrl, s.a.key, "POST", "/v2/send", { target: `#${s.channel.name}`, content: "first", idempotencyKey: key });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));

  const refused = await call(app.baseUrl, s.a.key, "POST", "/v2/send", { target: `#${s.channel.name}`, content: "second", idempotencyKey: `other-${randomUUID()}` });
  assertRateLimited(refused, "messageSendV2", 1);

  for (let i = 0; i < 3; i += 1) {
    const committed = await call(app.baseUrl, s.a.key, "POST", "/v2/send", { target: `#${s.channel.name}`, idempotencyKey: key, reconcileOnly: true });
    assert.equal(committed.status, 200, JSON.stringify(committed.body));
    assert.equal(committed.body.state, "committed");
    assert.equal(committed.body.reconciliation, true);
  }
  const missing = await call(app.baseUrl, s.a.key, "POST", "/v2/send", { target: `#${s.channel.name}`, idempotencyKey: `never-${randomUUID()}`, reconcileOnly: true });
  assert.equal(missing.status, 200, JSON.stringify(missing.body));
  assert.equal(missing.body.state, "not_found");

  // Its own budget (4) is spent: a lookup loop is bounded.
  const looped = await call(app.baseUrl, s.a.key, "POST", "/v2/send", { target: `#${s.channel.name}`, idempotencyKey: key, reconcileOnly: true });
  assertRateLimited(looped, "messageSendV2", 4);
  assert.match(looped.body.error, /send status checks/);
  // Another agent's lookups are its own.
  const otherAgent = await call(app.baseUrl, s.b.key, "POST", "/v2/send", { target: `#${s.channel.name}`, idempotencyKey: key, reconcileOnly: true });
  assert.equal(otherAgent.status, 200, JSON.stringify(otherAgent.body));
  assert.equal(otherAgent.body.state, "not_found", "another agent's key space");

  // Only a boolean true is a lookup; anything else is a send, charged as one.
  const stringFlag = await call(app.baseUrl, s.a.key, "POST", "/v2/send", { target: `#${s.channel.name}`, content: "third", idempotencyKey: `y-${randomUUID()}`, reconcileOnly: "true" });
  assertRateLimited(stringFlag, "messageSendV2", 1);
});
