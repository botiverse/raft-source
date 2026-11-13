import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";

import { getDb } from "../db/index";
import { users } from "../db/schema";
import { createServer as createServerService } from "../services/serverService";
import { createChannel as createChannelService, addHuman } from "../services/channelService";
import { createMessage } from "../services/messageService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

// task #17 (staging load speed): the thread panel needs only the parent
// message, but GET /api/messages/context/:id always returned 15 messages on
// each side (~100KB on busy channels, ~1s on the thread-open path). Callers
// can now size the window with before/after (clamped to the default of 15).

async function seedUser(email: string, name: string) {
  const db = getDb();
  const [user] = await db.insert(users).values({
    email,
    name,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

type ContextBody = { messages: Array<{ id: string }> };

test("message context window is sized by before/after and defaults to 15 per side", async ({ app }) => {
  const owner = await seedUser("context-window@slock.test", "context-window");
  const server = await createServerService("Context Window", "context-window", owner.id);
  const channel = await createChannelService(server.id, "context-window", "test channel");
  await addHuman(channel.id, owner.id);

  const ids: string[] = [];
  for (let i = 0; i < 40; i += 1) {
    ids.push((await createMessage(channel.id, "user", owner.id, `message ${i}`)).id);
  }
  const target = ids[20];

  const token = await tokenForHuman(owner.email);
  const context = async (query: string) => {
    const res = await fetch(`${app.baseUrl}/api/messages/context/${target}?channelId=${channel.id}${query}`, {
      headers: { Authorization: `Bearer ${token}`, "X-Server-Id": server.id },
    });
    assert.equal(res.status, 200);
    return (await res.json() as ContextBody).messages.map((message) => message.id);
  };

  assert.deepEqual(await context("&before=0&after=0"), [target], "0/0 returns only the target");
  assert.deepEqual(await context("&before=2&after=1"), ids.slice(18, 22), "explicit sides are honored");
  assert.deepEqual(await context(""), ids.slice(5, 36), "absent params keep the 15/15 default");
  assert.deepEqual(await context("&before=500&after=-3"), ids.slice(5, 36), "out-of-range values cannot widen past the default");
});
