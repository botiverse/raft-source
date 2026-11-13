import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { eq, inArray, sql } from "drizzle-orm";
import pg from "pg";
import {
  PUBLIC_SERVER_FEATURE_FLAG_KEY,
  PUBLIC_SERVER_SEARCH_INDEX_FEATURE_FLAG_KEY,
} from "@botiverse/raft-shared";
import { openTestApp } from "../test/integration/app";
import { migrateRealPgTestDatabase } from "../test/integration/realPgMigrate";
import { getDb } from "../db/index";
import { channelPublicRoutes, channels, featureFlags, messages, serverPublicRoutes, servers } from "../db/schema";
import { createChannel, getOrCreateThread } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { addMember } from "../services/serverService";
import { tokenForHuman } from "../test/integration/credentials";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createAgent } from "../services/agentService";
import { addAgent } from "../services/channelService";
import { agentApiClientFor } from "./internalAgentApi.userChannels.testkit";
import { createServer, headers, seedUser } from "./channels.api.fixtures";
import { publicThreadTitle, slugifyForPublicPath } from "./publicSearch";

/**
 * Public server SEO, step 1 (#proj-public-server-seo): the search API's
 * predicate. Every cell drives the SAME running app before and after a single
 * column/flag change, so a cached decision would stay green and fail here.
 * Each cell must remove the resource from every search exit (server, channel,
 * thread, index) and nothing else.
 */

/**
 * PGlite by default. Set PUBLIC_SEARCH_REAL_PG_URL to an EMPTY PostgreSQL
 * database to run the same cells on native PostgreSQL (slugs and emails are
 * fixed, so a reused database collides). Manual: no CI job sets it yet.
 */
const REAL_PG_URL = process.env.PUBLIC_SEARCH_REAL_PG_URL;

async function openApp() {
  if (REAL_PG_URL) {
    const pool = new pg.Pool({ connectionString: REAL_PG_URL, max: 2 });
    try {
      await migrateRealPgTestDatabase(pool, fileURLToPath(new URL("../../drizzle", import.meta.url)));
    } finally {
      await pool.end();
    }
  }
  return openTestApp(REAL_PG_URL ?? "pglite://", 0, {
    humanActivityMuteFlagDefaultEnabled: true,
  });
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

async function setFlag(key: string, on: boolean) {
  await getDb().update(featureFlags)
    .set({ enabled: true, killSwitch: false, defaultEnabled: on })
    .where(eq(featureFlags.key, key));
}

async function publicIdOf(table: "servers" | "channels", id: string): Promise<string> {
  const db = getDb();
  const [row] = table === "servers"
    ? await db.select({ publicId: serverPublicRoutes.publicId }).from(serverPublicRoutes).where(eq(serverPublicRoutes.serverId, id))
    : await db.select({ publicId: channelPublicRoutes.publicId }).from(channelPublicRoutes).where(eq(channelPublicRoutes.channelId, id));
  assert.match(row?.publicId ?? "", /^[0-9a-f]{32}$/, `${table} ${id} has a 128-bit public id`);
  return row!.publicId;
}

async function seedSearchableServer(slug: string) {
  const db = getDb();
  const owner = await seedUser(`${slug}-owner@slock.test`, `${slug}-owner`);
  const server = await createServer(`Server ${slug}`, slug, owner.id);
  const open = await createChannel(server.id, "open-talk", "Open to guests", "channel", { type: "user", id: owner.id });
  const hidden = await createChannel(server.id, "members-only", undefined, "channel", { type: "user", id: owner.id });
  await db.update(channels).set({ guestVisible: true }).where(eq(channels.id, open.id));
  await db.update(servers).set({ publiclyVisible: true }).where(eq(servers.id, server.id));

  const parent = await createMessage(open.id, "user", owner.id, "# How do I set up agents?\nSecond line");
  const thread = await getOrCreateThread(parent.id, owner.id, "user");
  await createMessage(thread.id, "user", owner.id, "First reply");
  const hiddenParent = await createMessage(hidden.id, "user", owner.id, "Members only question");
  const hiddenThread = await getOrCreateThread(hiddenParent.id, owner.id, "user");
  await createMessage(hiddenThread.id, "user", owner.id, "Members only reply");

  return {
    owner,
    server,
    open,
    hidden,
    thread,
    hiddenThread,
    serverPid: await publicIdOf("servers", server.id),
    openPid: await publicIdOf("channels", open.id),
    hiddenPid: await publicIdOf("channels", hidden.id),
    threadPid: await publicIdOf("channels", thread.id),
    hiddenThreadPid: await publicIdOf("channels", hiddenThread.id),
  };
}

type Seed = Awaited<ReturnType<typeof seedSearchableServer>>;

/** Status of every search exit for the seeded resources, plus what the index lists. */
async function exits(baseUrl: string, seed: Seed) {
  const base = `${baseUrl}/api/public/search`;
  const [server, channel, thread, index] = await Promise.all([
    fetch(`${base}/servers/${seed.serverPid}`),
    fetch(`${base}/servers/${seed.serverPid}/channels/${seed.openPid}`),
    fetch(`${base}/servers/${seed.serverPid}/threads/${seed.threadPid}`),
    fetch(`${base}/index`),
  ]);
  for (const response of [server, channel, thread, index]) {
    assert.equal(response.headers.get("cache-control"), "no-store", response.url);
  }
  const indexBody = await index.json() as { entries: { type: string; canonicalPath: string }[] };
  const indexed = indexBody.entries.map((entry) => entry.canonicalPath)
    .filter((path) => path.includes(seed.serverPid));
  return { server: server.status, channel: channel.status, thread: thread.status, indexed };
}

test("public search: each predicate cell removes the resource from every exit on the same running app", async () => {
  const app = await openApp();
  try {
    const db = getDb();
    await setFlag(PUBLIC_SERVER_FEATURE_FLAG_KEY, true);
    const seed = await seedSearchableServer("seo-cells");

    // The master switch ships closed: nothing is searchable yet.
    const closed = await exits(app.baseUrl, seed);
    assert.deepEqual(closed, { server: 404, channel: 404, thread: 404, indexed: [] }, "migration leaves the master switch closed");

    await setFlag(PUBLIC_SERVER_SEARCH_INDEX_FEATURE_FLAG_KEY, true);
    const open = await exits(app.baseUrl, seed);
    assert.deepEqual(
      { server: open.server, channel: open.channel, thread: open.thread },
      { server: 200, channel: 200, thread: 200 },
    );
    assert.equal(open.indexed.length, 3, `server + open channel + its thread, got ${JSON.stringify(open.indexed)}`);
    assert.ok(!open.indexed.some((path) => path.includes(seed.hiddenPid) || path.includes(seed.hiddenThreadPid)), "members-only content is never indexed");

    // Each cell: break one condition, expect every exit gone, restore, expect it back.
    const cells: { name: string; channelOnly?: boolean; apply: () => Promise<unknown>; restore: () => Promise<unknown> }[] = [
      {
        name: "master switch off",
        apply: () => setFlag(PUBLIC_SERVER_SEARCH_INDEX_FEATURE_FLAG_KEY, false),
        restore: () => setFlag(PUBLIC_SERVER_SEARCH_INDEX_FEATURE_FLAG_KEY, true),
      },
      {
        name: "public server rollout off",
        apply: () => setFlag(PUBLIC_SERVER_FEATURE_FLAG_KEY, false),
        restore: () => setFlag(PUBLIC_SERVER_FEATURE_FLAG_KEY, true),
      },
      {
        name: "server not public",
        apply: () => db.update(servers).set({ publiclyVisible: false }).where(eq(servers.id, seed.server.id)),
        restore: () => db.update(servers).set({ publiclyVisible: true }).where(eq(servers.id, seed.server.id)),
      },
      {
        name: "search off",
        apply: () => db.update(servers).set({ publicSearchEnabled: false }).where(eq(servers.id, seed.server.id)),
        restore: () => db.update(servers).set({ publicSearchEnabled: true }).where(eq(servers.id, seed.server.id)),
      },
      {
        name: "server deleted",
        apply: () => db.update(servers).set({ deletedAt: new Date() }).where(eq(servers.id, seed.server.id)),
        restore: () => db.update(servers).set({ deletedAt: null }).where(eq(servers.id, seed.server.id)),
      },
      {
        name: "channel not guest-visible",
        channelOnly: true,
        apply: () => db.update(channels).set({ guestVisible: false }).where(eq(channels.id, seed.open.id)),
        restore: () => db.update(channels).set({ guestVisible: true }).where(eq(channels.id, seed.open.id)),
      },
      {
        name: "channel archived",
        channelOnly: true,
        apply: () => db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, seed.open.id)),
        restore: () => db.update(channels).set({ archivedAt: null }).where(eq(channels.id, seed.open.id)),
      },
      {
        name: "channel deleted",
        channelOnly: true,
        apply: () => db.update(channels).set({ deletedAt: new Date() }).where(eq(channels.id, seed.open.id)),
        restore: () => db.update(channels).set({ deletedAt: null }).where(eq(channels.id, seed.open.id)),
      },
      {
        name: "channel made private",
        channelOnly: true,
        apply: () => db.update(channels).set({ type: "private" }).where(eq(channels.id, seed.open.id)),
        restore: () => db.update(channels).set({ type: "channel" }).where(eq(channels.id, seed.open.id)),
      },
    ];
    for (const cell of cells) {
      await cell.apply();
      const off = await exits(app.baseUrl, seed);
      if (cell.channelOnly) {
        assert.equal(off.server, 200, `${cell.name}: the server page stays`);
        assert.deepEqual([off.channel, off.thread], [404, 404], `${cell.name}: channel and thread pages`);
        assert.equal(off.indexed.length, 1, `${cell.name}: only the server stays indexed, got ${JSON.stringify(off.indexed)}`);
        const serverBody = await (await fetch(`${app.baseUrl}/api/public/search/servers/${seed.serverPid}`)).json() as { channels: unknown[] };
        assert.deepEqual(serverBody.channels, [], `${cell.name}: the server page no longer links the channel`);
      } else {
        assert.deepEqual(off, { server: 404, channel: 404, thread: 404, indexed: [] }, cell.name);
      }
      await cell.restore();
      const back = await exits(app.baseUrl, seed);
      assert.deepEqual([back.server, back.channel, back.thread, back.indexed.length], [200, 200, 200, 3], `${cell.name}: restored`);
    }
  } finally {
    await app.close();
  }
});

test("public search: search off keeps the guest view readable; a thread is only reachable under its own server", async () => {
  const app = await openApp();
  try {
    const db = getDb();
    await setFlag(PUBLIC_SERVER_FEATURE_FLAG_KEY, true);
    await setFlag(PUBLIC_SERVER_SEARCH_INDEX_FEATURE_FLAG_KEY, true);
    const a = await seedSearchableServer("seo-a");
    const b = await seedSearchableServer("seo-b");
    const base = `${app.baseUrl}/api/public/search`;

    // Readable vs searchable are separate (Ark): search off is a search 404, not a read 404.
    await db.update(servers).set({ publicSearchEnabled: false }).where(eq(servers.id, a.server.id));
    assert.equal((await fetch(`${base}/servers/${a.serverPid}`)).status, 404);
    assert.equal((await fetch(`${app.baseUrl}/api/public/servers/seo-a`)).status, 200, "the guest view does not read the search switch");
    await db.update(servers).set({ publicSearchEnabled: true }).where(eq(servers.id, a.server.id));

    // Cross-server and cross-kind lookups: a valid public id in the wrong place is a 404.
    assert.equal((await fetch(`${base}/servers/${a.serverPid}/threads/${b.threadPid}`)).status, 404, "B's thread under A");
    assert.equal((await fetch(`${base}/servers/${a.serverPid}/channels/${b.openPid}`)).status, 404, "B's channel under A");
    assert.equal((await fetch(`${base}/servers/${a.serverPid}/threads/${a.openPid}`)).status, 404, "a channel id is not a thread id");
    assert.equal((await fetch(`${base}/servers/${a.serverPid}/channels/${a.threadPid}`)).status, 404, "a thread id is not a channel id");
    assert.equal((await fetch(`${base}/servers/${a.serverPid}/threads/${a.hiddenThreadPid}`)).status, 404, "a thread under a members-only channel");
    assert.equal((await fetch(`${base}/servers/${a.server.id}`)).status, 404, "the internal id is not a lookup key");
    assert.equal((await fetch(`${base}/servers/${a.serverPid}/channels/${a.openPid}?cursor=x`)).status, 404, "malformed cursor");
    assert.equal((await fetch(`${base}/index?cursor=thread:nope`)).status, 404, "malformed index cursor");
  } finally {
    await app.close();
  }
});

test("public search: responses carry public ids and display fields only", async () => {
  const app = await openApp();
  try {
    await setFlag(PUBLIC_SERVER_FEATURE_FLAG_KEY, true);
    await setFlag(PUBLIC_SERVER_SEARCH_INDEX_FEATURE_FLAG_KEY, true);
    const seed = await seedSearchableServer("seo-dto");
    const base = `${app.baseUrl}/api/public/search`;
    const bodies = await Promise.all([
      fetch(`${base}/servers/${seed.serverPid}`),
      fetch(`${base}/servers/${seed.serverPid}/channels/${seed.openPid}`),
      fetch(`${base}/servers/${seed.serverPid}/threads/${seed.threadPid}`),
      fetch(`${base}/index`),
    ].map(async (pending) => (await pending).text()));
    for (const body of bodies) {
      assert.doesNotMatch(body, UUID_RE, `no internal database id may appear: ${body.slice(0, 200)}`);
      assert.ok(!body.includes(seed.owner.email), "no email");
    }

    const [server, channel, thread] = bodies.map((body) => JSON.parse(body));
    assert.equal(server.server.canonicalPath, `/servers/${seed.serverPid}/seo-dto`);
    assert.deepEqual(server.channels.map((c: { publicId: string }) => c.publicId), [seed.openPid]);
    assert.equal(channel.threads.length, 1);
    assert.equal(channel.threads[0].title, "How do I set up agents?");
    assert.equal(channel.threads[0].replyCount, 1);
    assert.equal(
      channel.threads[0].canonicalPath,
      `/servers/${seed.serverPid}/seo-dto/${seed.openPid}/open-talk/${seed.threadPid}/how-do-i-set-up-agents`,
    );
    assert.equal(thread.thread.parent.sender.displayName, "seo-dto-owner");
    assert.deepEqual(Object.keys(thread.thread.parent.sender).sort(), ["avatarUrl", "displayName", "type"]);
    assert.deepEqual(thread.thread.replies.map((r: { content: string }) => r.content), ["First reply"]);
    assert.equal(thread.thread.truncated, false);
  } finally {
    await app.close();
  }
});

test("public search: a long thread is truncated and says so", async () => {
  const app = await openApp();
  try {
    await setFlag(PUBLIC_SERVER_FEATURE_FLAG_KEY, true);
    await setFlag(PUBLIC_SERVER_SEARCH_INDEX_FEATURE_FLAG_KEY, true);
    const seed = await seedSearchableServer("seo-long");
    for (let index = 2; index <= 52; index += 1) {
      await createMessage(seed.thread.id, "user", seed.owner.id, `Reply ${index}`);
    }
    const body = await (await fetch(`${app.baseUrl}/api/public/search/servers/${seed.serverPid}/threads/${seed.threadPid}`)).json() as {
      thread: { replies: { content: string }[]; replyCount: number; truncated: boolean };
    };
    assert.equal(body.thread.replyCount, 52);
    assert.equal(body.thread.replies.length, 50);
    assert.equal(body.thread.replies[0]!.content, "First reply", "the first replies, oldest first");
    assert.equal(body.thread.truncated, true);
  } finally {
    await app.close();
  }
});

test("public search settings: owner-only switch, and going public gives older rows public ids", async () => {
  const app = await openApp();
  try {
    const db = getDb();
    await setFlag(PUBLIC_SERVER_FEATURE_FLAG_KEY, true);
    await setFlag(PUBLIC_SERVER_SEARCH_INDEX_FEATURE_FLAG_KEY, true);
    const owner = await seedUser("seo-settings-owner@slock.test", "seo-settings-owner");
    const admin = await seedUser("seo-settings-admin@slock.test", "seo-settings-admin");
    const server = await createServer("Settings", "seo-settings", owner.id);
    await addMember(server.id, admin.id, "admin");
    const channel = await createChannel(server.id, "older", undefined, "channel", { type: "user", id: owner.id });
    const parent = await createMessage(channel.id, "user", owner.id, "Older question");
    const thread = await getOrCreateThread(parent.id, owner.id, "user");
    // Rows from before migration 0347 on a server that was private then.
    await db.delete(channelPublicRoutes).where(inArray(channelPublicRoutes.channelId, [channel.id, thread.id]));

    const ownerHeaders = headers(await tokenForHuman(owner.email), server.id);
    const adminHeaders = headers(await tokenForHuman(admin.email), server.id);
    const settingsUrl = `${app.baseUrl}/api/servers/${server.id}`;

    const goPublic = await fetch(`${settingsUrl}/public-visibility`, {
      method: "PATCH", headers: ownerHeaders, body: JSON.stringify({ publiclyVisible: true }),
    });
    assert.equal(goPublic.status, 200, await goPublic.clone().text());
    assert.equal((await goPublic.json()).publicSearchEnabled, true, "search is on by default, as the settings action states");
    const filled = await db.select({ id: channelPublicRoutes.channelId, publicId: channelPublicRoutes.publicId })
      .from(channelPublicRoutes).where(inArray(channelPublicRoutes.channelId, [channel.id, thread.id]));
    assert.equal(filled.length, 2, "the channel and its thread got route rows when the server went public");
    for (const row of filled) assert.match(row.publicId, /^[0-9a-f]{32}$/);

    const adminWrite = await fetch(`${settingsUrl}/public-search`, {
      method: "PATCH", headers: adminHeaders, body: JSON.stringify({ publicSearchEnabled: false }),
    });
    assert.equal(adminWrite.status, 403, "admins cannot change the owner's search decision");
    const badBody = await fetch(`${settingsUrl}/public-search`, {
      method: "PATCH", headers: ownerHeaders, body: JSON.stringify({ publicSearchEnabled: "no" }),
    });
    assert.equal(badBody.status, 400);
    const ownerWrite = await fetch(`${settingsUrl}/public-search`, {
      method: "PATCH", headers: ownerHeaders, body: JSON.stringify({ publicSearchEnabled: false }),
    });
    assert.equal(ownerWrite.status, 200);
    const read = await (await fetch(`${settingsUrl}/public-visibility`, { headers: ownerHeaders })).json();
    assert.equal(read.publicSearchEnabled, false);

    await setFlag(PUBLIC_SERVER_FEATURE_FLAG_KEY, false);
    const gated = await fetch(`${settingsUrl}/public-search`, {
      method: "PATCH", headers: ownerHeaders, body: JSON.stringify({ publicSearchEnabled: true }),
    });
    assert.equal(gated.status, 404, "the owner write fails closed while the public server rollout is off");
  } finally {
    await app.close();
  }
});

test("public search: thread titles and path slugs", () => {
  assert.equal(publicThreadTitle("## Hello world\nmore"), "Hello world");
  assert.equal(publicThreadTitle("\n\n> quoted first\n"), "quoted first");
  assert.equal(publicThreadTitle(""), "Discussion");
  assert.equal(publicThreadTitle("   \n  "), "Discussion");
  assert.equal([...publicThreadTitle("x".repeat(200))].length, 80);
  assert.equal(slugifyForPublicPath("How do I set up agents?", "discussion"), "how-do-i-set-up-agents");
  assert.equal(slugifyForPublicPath("如何 配置 Agent", "discussion"), "如何-配置-agent");
  assert.equal(slugifyForPublicPath("???", "discussion"), "discussion");
});

test("public search: GET and HEAD only; every other method is 405 before any lookup", async () => {
  const app = await openApp();
  try {
    await setFlag(PUBLIC_SERVER_FEATURE_FLAG_KEY, true);
    await setFlag(PUBLIC_SERVER_SEARCH_INDEX_FEATURE_FLAG_KEY, true);
    const seed = await seedSearchableServer("seo-methods");
    const url = `${app.baseUrl}/api/public/search/servers/${seed.serverPid}`;
    assert.equal((await fetch(url)).status, 200);
    const head = await fetch(url, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("cache-control"), "no-store");
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const refused = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: "{}" });
      assert.equal(refused.status, 405, method);
      assert.equal(refused.headers.get("allow"), "GET, HEAD", method);
      assert.equal(refused.headers.get("cache-control"), "no-store", method);
    }
    assert.equal((await fetch(`${app.baseUrl}/api/public/search/index`, { method: "POST" })).status, 405, "unknown or known path alike");
  } finally {
    await app.close();
  }
});

async function lastmods(baseUrl: string, seed: Seed) {
  const index = await (await fetch(`${baseUrl}/api/public/search/index`)).json() as {
    entries: { type: string; canonicalPath: string; lastmod: string }[];
  };
  const of = (type: string, pid: string) => {
    const entry = index.entries.find((e) => e.type === type && e.canonicalPath.includes(pid));
    assert.ok(entry, `${type} ${pid} indexed`);
    return Date.parse(entry.lastmod);
  };
  return {
    server: of("server", seed.serverPid),
    channel: of("channel", seed.openPid),
    thread: of("thread", seed.threadPid),
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 15));

test("public search lastmod: moves with every change a page renders, and not with private edits", async () => {
  const app = await openApp();
  try {
    const db = getDb();
    await setFlag(PUBLIC_SERVER_FEATURE_FLAG_KEY, true);
    await setFlag(PUBLIC_SERVER_SEARCH_INDEX_FEATURE_FLAG_KEY, true);
    const seed = await seedSearchableServer("seo-lastmod");
    const [parent] = await db.select({ id: messages.id }).from(messages).where(eq(messages.channelId, seed.open.id));
    const [reply] = await db.select({ id: messages.id }).from(messages).where(eq(messages.channelId, seed.thread.id));

    // Each step: one change, then which index entries must move (strictly later) and which must not.
    const steps: { name: string; apply: () => Promise<unknown>; moves: ("server" | "channel" | "thread")[] }[] = [
      { name: "channel renamed", apply: () => db.update(channels).set({ name: "open-talk-2" }).where(eq(channels.id, seed.open.id)), moves: ["server", "channel", "thread"] },
      { name: "channel description edited", apply: () => db.update(channels).set({ description: "New words" }).where(eq(channels.id, seed.open.id)), moves: ["server", "channel", "thread"] },
      { name: "parent message edited (thread title)", apply: () => db.update(messages).set({ content: "# Agents, set up\nSecond line" }).where(eq(messages.id, parent!.id)), moves: ["channel", "thread"] },
      { name: "reply edited", apply: () => db.update(messages).set({ content: "First reply, edited" }).where(eq(messages.id, reply!.id)), moves: ["thread"] },
      { name: "new reply", apply: () => createMessage(seed.thread.id, "user", seed.owner.id, "Second reply"), moves: ["channel", "thread"] },
      { name: "server renamed", apply: () => db.update(servers).set({ name: "Renamed" }).where(eq(servers.id, seed.server.id)), moves: ["server", "channel", "thread"] },
      { name: "private channel renamed", apply: () => db.update(channels).set({ name: "members-only-2" }).where(eq(channels.id, seed.hidden.id)), moves: [] },
    ];
    for (const step of steps) {
      const before = await lastmods(app.baseUrl, seed);
      await tick();
      await step.apply();
      const after = await lastmods(app.baseUrl, seed);
      for (const kind of ["server", "channel", "thread"] as const) {
        if (step.moves.includes(kind)) assert.ok(after[kind] > before[kind], `${step.name}: ${kind} lastmod moves`);
        else assert.equal(after[kind], before[kind], `${step.name}: ${kind} lastmod stays`);
      }
    }
  } finally {
    await app.close();
  }
});

test("public ids leave the server only through the search API: agent server info, user info and the member channel list carry none", async () => {
  const app = await openApp();
  try {
    await setFlag(PUBLIC_SERVER_FEATURE_FLAG_KEY, true);
    await setFlag(PUBLIC_SERVER_SEARCH_INDEX_FEATURE_FLAG_KEY, true);
    const seed = await seedSearchableServer("seo-noleak");
    const agent = await createAgent(seed.server.id, "SeoNoLeakBot", { runtime: "claude", model: "sonnet" });
    await addAgent(seed.open.id, agent.id);
    await addAgent(seed.hidden.id, agent.id);
    const { apiKey } = await mintAgentCredential({ agentId: agent.id, scopes: ["read", "channels"], name: "seo-noleak", issuedVia: "computer", createdByUserId: null });
    const routeIds = (await getDb().select({ publicId: channelPublicRoutes.publicId }).from(channelPublicRoutes))
      .map((row) => row.publicId)
      .concat(seed.serverPid);

    const info = await agentApiClientFor(app.baseUrl, apiKey).client.server.info();
    assert.ok(info.ok, JSON.stringify(info));
    const userInfo = await fetch(`${app.baseUrl}/internal/agent-api/users/${encodeURIComponent("SeoNoLeakBot")}/channels`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    assert.equal(userInfo.status, 200, await userInfo.clone().text());
    const memberList = await fetch(`${app.baseUrl}/api/channels`, {
      headers: headers(await tokenForHuman(seed.owner.email), seed.server.id),
    });
    assert.equal(memberList.status, 200, await memberList.clone().text());

    const bodies = [
      ["agent server info", JSON.stringify(info.data)],
      ["agent user info", await userInfo.text()],
      ["member channel list", await memberList.text()],
    ] as const;
    for (const [name, body] of bodies) {
      assert.ok(body.includes("members-only"), `${name} lists the private channel (the fixture is real)`);
      assert.doesNotMatch(body, /publicId|publicChangedAt|public_id/, `${name} has no public route field`);
      for (const id of routeIds) assert.ok(!body.includes(id), `${name} leaks public id ${id}`);
    }
  } finally {
    await app.close();
  }
});

test("public search lastmod: a thread moving to another public channel moves both channel pages; deleting it moves its channel page", async () => {
  const app = await openApp();
  try {
    const db = getDb();
    await setFlag(PUBLIC_SERVER_FEATURE_FLAG_KEY, true);
    await setFlag(PUBLIC_SERVER_SEARCH_INDEX_FEATURE_FLAG_KEY, true);
    const seed = await seedSearchableServer("seo-thread-move");
    const other = await createChannel(seed.server.id, "other-talk", undefined, "channel", { type: "user", id: seed.owner.id });
    await db.update(channels).set({ guestVisible: true }).where(eq(channels.id, other.id));
    const otherPid = await publicIdOf("channels", other.id);
    const [parent] = await db.select({ id: messages.id }).from(messages).where(eq(messages.channelId, seed.open.id));

    const channelLastmods = async () => {
      const index = await (await fetch(`${app.baseUrl}/api/public/search/index`)).json() as {
        entries: { type: string; canonicalPath: string; lastmod: string }[];
      };
      const of = (pid: string) => {
        const entry = index.entries.find((e) => e.type === "channel" && e.canonicalPath.includes(`/${pid}/`) && !e.canonicalPath.includes(seed.threadPid));
        assert.ok(entry, `channel ${pid} indexed`);
        return Date.parse(entry.lastmod);
      };
      const threadPaths = index.entries.filter((e) => e.type === "thread" && e.canonicalPath.includes(seed.threadPid)).map((e) => e.canonicalPath);
      return { a: of(seed.openPid), b: of(otherPid), threadPaths };
    };

    const start = await channelLastmods();
    assert.ok(start.threadPaths[0]?.includes(`/${seed.openPid}/`), "the thread starts under channel A");

    await tick();
    await db.update(messages).set({ channelId: other.id }).where(eq(messages.id, parent!.id));
    const moved = await channelLastmods();
    assert.ok(moved.a > start.a, "A lost a rendered thread: its lastmod moves");
    assert.ok(moved.b > start.b, "B gained a rendered thread: its lastmod moves");
    assert.ok(moved.threadPaths[0]?.includes(`/${otherPid}/`), "the thread is now listed under B");

    await tick();
    await db.update(channels).set({ deletedAt: new Date() }).where(eq(channels.id, seed.thread.id));
    const deleted = await channelLastmods();
    assert.ok(deleted.b > moved.b, "B lost a rendered thread: its lastmod moves");
    assert.equal(deleted.a, moved.a, "A did not change");
    assert.deepEqual(deleted.threadPaths, [], "the deleted thread left the index");
  } finally {
    await app.close();
  }
});

test("public route rows: a public id collision fails the insert instead of leaving the row without a route", async () => {
  const app = await openApp();
  try {
    const db = getDb();
    const owner = await seedUser("seo-collide-owner@slock.test", "seo-collide-owner");
    const server = await createServer("Collide", "seo-collide", owner.id);
    // Force every new route id to the same value for this test only.
    await db.execute(sql`ALTER TABLE channel_public_routes ALTER COLUMN public_id SET DEFAULT 'c0111de0c0111de0c0111de0c0111de0'`);
    try {
      await createChannel(server.id, "first-collide", undefined, "channel", { type: "user", id: owner.id });
      await assert.rejects(
        createChannel(server.id, "second-collide", undefined, "channel", { type: "user", id: owner.id }),
        "a collision on public_id must not be swallowed as 'already issued'",
      );
      const orphans = await db.execute(sql`
        SELECT c.id FROM channels c LEFT JOIN channel_public_routes r ON r.channel_id = c.id
        WHERE c.server_id = ${server.id}::uuid AND c.type IN ('channel', 'thread') AND r.channel_id IS NULL
      `);
      assert.equal(orphans.rows.length, 0, "no channel exists without a route row");
    } finally {
      await db.execute(sql`ALTER TABLE channel_public_routes ALTER COLUMN public_id SET DEFAULT replace(gen_random_uuid()::text, '-', '')`);
    }
  } finally {
    await app.close();
  }
});
