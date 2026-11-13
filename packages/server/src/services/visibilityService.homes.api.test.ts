// canView for server and public homes (Workspace Artifacts, §3.1): the server
// is seen by its non-guest members and live agents only, through that server;
// public by everyone. Conversation homes are covered by visibilityService.api.test.ts.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { SERVER_GUEST_FEATURE_FLAG_KEY, asServerId } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agents, featureFlagRules, serverMembers } from "../db/schema";
import { dbTest as test } from "../test/integration/dbTest";
import { seedBoundGuest } from "../test/guestFixture";
import { createAgent } from "./agentService";
import { createChannel } from "./channelService";
import { canView, type ViewActor, type ViewHome } from "./visibilityService";

type PgliteLike = { query: (...args: unknown[]) => Promise<unknown> };

async function countQueries<T>(fn: () => Promise<T>): Promise<{ queries: number; value: T }> {
  const pg = (getDb() as unknown as { $client: PgliteLike }).$client;
  const originalQuery = pg.query.bind(pg);
  let queries = 0;
  pg.query = ((...args: unknown[]) => {
    queries += 1;
    return originalQuery(...args);
  }) as PgliteLike["query"];
  try {
    const value = await fn();
    // Read the count after the call: `{ queries, value: await fn() }` would read it before.
    return { queries, value };
  } finally {
    pg.query = originalQuery;
  }
}

test("server homes are seen by the server's non-guest members and live agents only; public homes by everyone", async ({ seed }) => {
  const db = getDb();
  const owner = await seed.human();
  const admin = await seed.human();
  const member = await seed.human();
  const guest = await seed.human();
  const stranger = await seed.human();
  const peerOwner = await seed.human();
  const server = await seed.server({ owner, members: [admin, member, guest] });
  const peer = await seed.server({ owner: peerOwner });
  await db.update(serverMembers).set({ role: "admin" }).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, admin.id)));
  await seedBoundGuest({ serverId: server.id, userId: guest.id }, db);
  await db.insert(featureFlagRules).values({ flagKey: SERVER_GUEST_FEATURE_FLAG_KEY, stage: "server", priority: 0, decision: "allow", values: [server.id] });
  const label = () => randomUUID().slice(0, 8);
  const agent = await createAgent(server.id, `homes-agent-${label()}`, { runtime: "claude", model: "sonnet" });
  const deletedAgent = await createAgent(server.id, `homes-deleted-${label()}`, { runtime: "claude", model: "sonnet" });
  await db.update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, deletedAgent.id));
  const peerAgent = await createAgent(peer.id, `homes-peer-agent-${label()}`, { runtime: "claude", model: "sonnet" });

  const serverId = asServerId(server.id);
  const peerId = asServerId(peer.id);
  const homes: ViewHome[] = [{ kind: "server", serverId }, { kind: "server", serverId: peerId }, { kind: "public" }];
  const cases: Array<[string, ViewActor, boolean[]]> = [
    ["owner", { type: "user", id: owner.id, serverId }, [true, false, true]],
    ["admin", { type: "user", id: admin.id, serverId }, [true, false, true]],
    ["member", { type: "user", id: member.id, serverId }, [true, false, true]],
    ["guest (D4)", { type: "user", id: guest.id, serverId }, [false, false, true]],
    ["agent of the server", { type: "agent", id: agent.id, serverId }, [true, false, true]],
    ["deleted agent", { type: "agent", id: deletedAgent.id, serverId }, [false, false, true]],
    ["a user of another server, through it", { type: "user", id: peerOwner.id, serverId: peerId }, [false, true, true]],
    ["a user of another server, claiming this one", { type: "user", id: peerOwner.id, serverId }, [false, false, true]],
    ["a user in no server", { type: "user", id: stranger.id, serverId }, [false, false, true]],
    ["an agent of another server, through it", { type: "agent", id: peerAgent.id, serverId: peerId }, [false, true, true]],
    ["an agent of another server, claiming this one", { type: "agent", id: peerAgent.id, serverId }, [false, false, true]],
  ];
  for (const [name, actor, expected] of cases) {
    assert.deepEqual(await canView(actor, homes), expected, name);
  }

  // Mixed batches keep input order; conversation answers are the conversation rules'.
  const pub = await createChannel(server.id, `homes-public-${label()}`);
  const priv = await createChannel(server.id, `homes-private-${label()}`, undefined, "private");
  const mixed: ViewHome[] = [{ kind: "public" }, { kind: "conversation", channelId: priv.id }, { kind: "server", serverId }, { kind: "conversation", channelId: pub.id }];
  assert.deepEqual(await canView({ type: "user", id: member.id, serverId }, mixed), [true, false, true, true]);
  assert.deepEqual(await canView({ type: "user", id: guest.id, serverId }, mixed), [true, false, false, false]);
});

test("canView answers any number of server and public homes in one query", async ({ seed }) => {
  const owner = await seed.human();
  const member = await seed.human();
  const server = await seed.server({ owner, members: [member] });
  const serverId = asServerId(server.id);
  const agent = await createAgent(server.id, `homes-count-${randomUUID().slice(0, 8)}`, { runtime: "claude", model: "sonnet" });
  const homesOf = (size: number): ViewHome[] => Array.from({ length: size }, (_, index) => index % 2 === 0 ? { kind: "server", serverId } : { kind: "public" });
  for (const actor of [{ type: "user", id: member.id, serverId }, { type: "agent", id: agent.id, serverId }] satisfies ViewActor[]) {
    const few = await countQueries(() => canView(actor, homesOf(2)));
    const many = await countQueries(() => canView(actor, homesOf(40)));
    assert.equal(few.queries, 1, `${actor.type}: one standing query`);
    assert.equal(many.queries, few.queries, `${actor.type}: ${few.queries} queries for 2 homes, ${many.queries} for 40`);
    assert.ok(many.value.every(Boolean));
    assert.equal((await countQueries(() => canView(actor, [{ kind: "public" }]))).queries, 0, "public needs no query");
  }
});
