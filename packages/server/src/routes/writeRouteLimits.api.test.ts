// Write routes that post messages, create servers or send invite emails each
// spend a budget:
//   1. POST /api/channels/:id/threads (a thread with its first reply) spends
//      the message budget of /api/messages (app.ts messageLimiter);
//   2. /api/tasks writes spend the same budget; its reads do not;
//   3. creating a server (POST /api/servers, an external invite's
//      connect-new-server) spends a per-person hourly budget, and the name is
//      bounded as a rename is (services/serverCreateLimits.ts);
//   4. server invite emails spend a per-server and a per-inviter daily budget
//      (services/serverInviteEmailLimits.ts).
// The joint invite resend: channels.joint.api.test.ts.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach } from "vitest";
import { SERVER_NAME_MAX_LENGTH } from "@botiverse/raft-shared";
import { createApiTest } from "../test/integration/apiTest";
import { tokenForHuman } from "../test/integration/credentials";
import { createServerAsOwner } from "../services/serverCreateService";
import { RefusalError } from "../lib/refusal";
import { __setServerCreateRateLimitForTests } from "../services/serverCreateLimits";
import { __setServerInviteEmailRateLimitsForTests } from "../services/serverInviteEmailLimits";

const MESSAGE_BUDGET = 3;
const limitedTest = createApiTest({ enforceMessageRateLimit: true, messageRateLimitMax: MESSAGE_BUDGET });
const test = createApiTest();

afterEach(() => {
  __setServerCreateRateLimitForTests(null);
  __setServerInviteEmailRateLimitsForTests(null);
});

function headers(token: string, serverId?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    ...(serverId ? { "X-Server-Id": serverId } : {}),
  };
}

limitedTest("a thread's first reply and a message share one message budget", async ({ app, seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner] });
  const token = await tokenForHuman(owner.email);
  const parents = await Promise.all(Array.from({ length: MESSAGE_BUDGET + 1 }, (_, i) => seed.message({ channel, author: owner, content: `parent ${i}` })));
  const reply = (parentMessageId: string) => fetch(`${app.baseUrl}/api/channels/${channel.id}/threads`, {
    method: "POST",
    headers: headers(token, server.id),
    body: JSON.stringify({ parentMessageId, content: "first reply" }),
  });

  // Within the budget: one message, then thread replies.
  const message = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(token, server.id),
    body: JSON.stringify({ channelId: channel.id, content: "hello" }),
  });
  assert.equal(message.status, 200, await message.clone().text());
  for (let i = 0; i < MESSAGE_BUDGET - 1; i += 1) {
    const ok = await reply(parents[i]!.id);
    assert.equal(ok.status, 200, await ok.clone().text());
  }
  const over = await reply(parents[MESSAGE_BUDGET]!.id);
  assert.equal(over.status, 429);

  // Reading threads is not counted.
  const read = await fetch(`${app.baseUrl}/api/channels/${channel.id}/threads`, { headers: headers(token, server.id) });
  assert.equal(read.status, 200);
});

limitedTest("task writes spend the message budget; task reads do not", async ({ app, seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner] });
  const token = await tokenForHuman(owner.email);
  const create = (title: string) => fetch(`${app.baseUrl}/api/tasks/channel/${channel.id}`, {
    method: "POST",
    headers: headers(token, server.id),
    body: JSON.stringify({ tasks: [{ title }] }),
  });

  for (let i = 0; i < MESSAGE_BUDGET; i += 1) {
    const ok = await create(`task ${i}`);
    assert.equal(ok.status, 200, await ok.clone().text());
  }
  const over = await create("one too many");
  assert.equal(over.status, 429);

  for (let i = 0; i < MESSAGE_BUDGET + 1; i += 1) {
    const list = await fetch(`${app.baseUrl}/api/tasks/channel/${channel.id}`, { headers: headers(token, server.id) });
    assert.equal(list.status, 200, await list.clone().text());
  }
});

test("creating servers spends a per-person budget, on both create paths", async ({ app, seed }) => {
  __setServerCreateRateLimitForTests(2);
  const person = await seed.human();
  const other = await seed.human();
  const token = await tokenForHuman(person.email);
  const create = (as: string, name = "Budget server") => fetch(`${app.baseUrl}/api/servers`, {
    method: "POST",
    headers: headers(as),
    body: JSON.stringify({ name, slug: `budget-${randomUUID().slice(0, 8)}` }),
  });

  for (let i = 0; i < 2; i += 1) {
    const ok = await create(token);
    assert.equal(ok.status, 200, await ok.clone().text());
  }
  const over = await create(token);
  assert.equal(over.status, 429);
  assert.ok(Number(over.headers.get("retry-after")) > 0);
  const body = await over.json() as { code: string; error: string; retryAfterSeconds: number };
  assert.equal(body.code, "server_create_rate_limited");
  assert.match(body.error, /at most 2 servers an hour/);
  assert.ok(body.retryAfterSeconds > 0);

  // An external invite's connect-new-server creates through createServerAsOwner too.
  await assert.rejects(
    createServerAsOwner({ name: "Via invite", slug: `budget-${randomUUID().slice(0, 8)}` }, person.id),
    (err: unknown) => err instanceof RefusalError && err.status === 429 && err.refusal.code === "server_create_rate_limited",
  );

  // The budget is the person's own.
  const otherOk = await create(await tokenForHuman(other.email));
  assert.equal(otherOk.status, 200, await otherOk.clone().text());
});

test("a server name is bounded on create as on rename", async ({ app, seed }) => {
  const person = await seed.human();
  const token = await tokenForHuman(person.email);
  const create = (name: unknown) => fetch(`${app.baseUrl}/api/servers`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ name, slug: `named-${randomUUID().slice(0, 8)}` }),
  });
  const tooLong = await create("n".repeat(SERVER_NAME_MAX_LENGTH + 1));
  assert.equal(tooLong.status, 400);
  assert.match((await tooLong.json() as { error: string }).error, /100 characters or fewer/);
  assert.equal((await create({ not: "a name" })).status, 400);
  assert.equal((await create("   ")).status, 400);
  const longest = await create(` ${"n".repeat(SERVER_NAME_MAX_LENGTH)} `);
  assert.equal(longest.status, 200, await longest.clone().text());
  assert.equal((await longest.json() as { name: string }).name, "n".repeat(SERVER_NAME_MAX_LENGTH));
});

test("server invite emails spend a per-server and a per-inviter daily budget, revokes included", async ({ app, seed }) => {
  __setServerInviteEmailRateLimitsForTests({ perServer: 2, perInviter: 3 });
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const second = await seed.server({ owner });
  const token = await tokenForHuman(owner.email);
  const invite = (serverId: string, email: string) => fetch(`${app.baseUrl}/api/servers/${serverId}/invites`, {
    method: "POST",
    headers: headers(token, serverId),
    body: JSON.stringify({ email }),
  });
  const address = `invitee-${randomUUID().slice(0, 8)}@slock.test`;

  // Invite, revoke, invite the same address again: each send counts.
  const first = await invite(server.id, address);
  assert.equal(first.status, 200, await first.clone().text());
  const { id } = await first.json() as { id: string };
  const revoke = await fetch(`${app.baseUrl}/api/servers/${server.id}/invites/${id}`, { method: "DELETE", headers: headers(token, server.id) });
  assert.equal(revoke.status, 200, await revoke.clone().text());
  const again = await invite(server.id, address);
  assert.equal(again.status, 200, await again.clone().text());

  const overServer = await invite(server.id, `other-${randomUUID().slice(0, 8)}@slock.test`);
  assert.equal(overServer.status, 429);
  assert.ok(Number(overServer.headers.get("retry-after")) > 0);
  const serverBody = await overServer.json() as { code: string; error: string };
  assert.equal(serverBody.code, "server_invite_rate_limited");
  assert.match(serverBody.error, /server can send at most 2 invites a day/);

  // Another server of the same inviter: its own server budget, the inviter's shared one.
  const elsewhere = await invite(second.id, `elsewhere-${randomUUID().slice(0, 8)}@slock.test`);
  assert.equal(elsewhere.status, 200, await elsewhere.clone().text());
  const overInviter = await invite(second.id, `elsewhere-${randomUUID().slice(0, 8)}@slock.test`);
  assert.equal(overInviter.status, 429);
  const inviterBody = await overInviter.json() as { code: string; error: string };
  assert.equal(inviterBody.code, "server_invite_rate_limited");
  assert.match(inviterBody.error, /You can send at most 3 server invites a day/);
});
