// Core's search across first-party apps (routes/search.ts) with test-only
// apps added to the registry (vi.mock; no app module is imported): each app
// runs in a transaction of its own under `SET LOCAL statement_timeout`; a
// statement cut off answers that app's group `{ error: "timeout" }` and any
// other failure `{ error: "failed" }` while every other group (the real
// registered apps' included) still answers; an app switched off for the
// server has no group; every app gets the viewer, the checked query and the
// visible-homes condition, which names the reader's server.
//
// PGlite runs no statement timer, so the slow app here raises what Postgres
// raises when the timer cuts a statement off (SQLSTATE 57014, after reading
// the timeout it runs under); search.realPg.test.ts lets a real Postgres cut
// a pg_sleep off.
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { asServerId, webSearchPath, type ServerId } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { featureFlagRules } from "../db/schema";
import { accessTokenForTest } from "../test/integration/credentials";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../services/featureFlagService";
import { addMember } from "../services/serverService";
import { visibleRootChannelIds } from "../services/visibilityService";
import { createApiTest } from "../test/integration/apiTest";
import type { createSeed } from "../test/integration/seed";
import type { AppSearchInput, FirstPartyApp } from "../platform/apps";
import { APP_SEARCH_STATEMENT_TIMEOUT_MS } from "./search";
import { __answerFlagForTests } from "../services/deploymentAnsweredFlags";

const seen = vi.hoisted(() => ({
  timeouts: [] as string[],
  inputs: [] as Array<{ app: string; userId: string; serverId: string; q: string; limit: number; cursor: string | null; visibleChannels: number }>,
}));

vi.mock("../apps/firstPartyApps", async (importOriginal) => {
  const real = await importOriginal<typeof import("../apps/firstPartyApps")>();
  const { sql: q } = await import("drizzle-orm");
  const { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY: on } = await import("@botiverse/raft-shared");
  const record = async (app: string, input: AppSearchInput) => {
    // The condition core hands over, on a table with home columns (channels as conversation homes of the server).
    const visible = input.visibleHomesSql({ serverId: q.raw("c.server_id"), homeKind: q.raw("'conversation'"), homeChannelId: q.raw("c.id") });
    const [row] = (await input.executor.execute(q`SELECT count(*)::int AS n FROM channels c WHERE ${visible}`)).rows as Array<{ n: number }>;
    seen.inputs.push({ app, userId: input.viewer.userId, serverId: input.viewer.serverId, q: input.q, limit: input.limit, cursor: input.cursor, visibleChannels: row!.n });
  };
  const testApp = (id: string, flag: string, search: FirstPartyApp["search"]): FirstPartyApp => ({ id, flag, objectKinds: [], systemApp: `system.${id}`, search });
  const extra: FirstPartyApp[] = [
    testApp("slowpoke", on, async (input) => {
      const [row] = (await input.executor.execute(q`SELECT current_setting('statement_timeout') AS timeout`)).rows as Array<{ timeout: string }>;
      seen.timeouts.push(row!.timeout);
      await input.executor.execute(q.raw(`DO $$ BEGIN RAISE EXCEPTION 'canceling statement due to statement timeout' USING ERRCODE = 'query_canceled'; END $$`));
      return { kind: "page", items: [], nextCursor: null };
    }),
    testApp("steady", on, async (input) => {
      await record("steady", input);
      return { kind: "page", items: [], nextCursor: null };
    }),
    testApp("broken", on, async () => {
      throw new Error("an app's own bug");
    }),
    testApp("dormant", "first_party_search_test_flag_never_defined", async (input) => {
      await record("dormant", input);
      return { kind: "page", items: [], nextCursor: null };
    }),
  ];
  return { ...real, firstPartyApps: () => [...real.firstPartyApps(), ...extra] };
});

const test = createApiTest();

beforeEach(() => {
  seen.timeouts.length = 0;
  seen.inputs.length = 0;
});

async function get(app: { baseUrl: string }, path: string, who: { token: string; serverId: string }) {
  const res = await fetch(`${app.baseUrl}${path}`, { headers: { Authorization: `Bearer ${who.token}`, "X-Server-Id": who.serverId } });
  return { status: res.status, headers: res.headers, body: await res.json() as any };
}

async function world(seed: ReturnType<typeof createSeed>) {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const serverId: ServerId = asServerId(server.id);
  const other = await seed.server({ owner: await seed.human() });
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  const mine = await seed.channel({ server, members: [owner], visibility: "private" });
  await addMember(other.id, owner.id);
  await seed.channel({ server: other, members: [owner], visibility: "private" });
  return { owner, server, serverId, mine, who: { token: await accessTokenForTest(owner.id), serverId: server.id } };
}

test("a timed-out app's group says so and a failing one's says failed; every other group answers; the timeout is local to each app's transaction", async ({ app, seed }) => {
  const w = await world(seed);
  const reply = await get(app, webSearchPath({ q: "  plans  " }), w.who);
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(reply.headers.get("cache-control"), "private, no-store");
  // Every enabled app in registry order (the real ones first); the dormant one (flag off) has no group.
  const groups = reply.body.groups as Array<{ app: string }>;
  const testApps = new Set(["slowpoke", "steady", "broken", "dormant"]);
  const testGroups = groups.filter((group) => testApps.has(group.app));
  assert.deepEqual(testGroups, [
    { app: "slowpoke", error: "timeout" },
    { app: "steady", items: [], nextCursor: null },
    { app: "broken", error: "failed" },
  ]);
  assert.ok(groups.length > testGroups.length, "the registered apps answer too");
  for (const group of groups.filter((entry) => !testApps.has(entry.app))) {
    assert.ok("items" in group, `the registered app ${group.app} answered beside the failing ones`);
  }
  assert.deepEqual(seen.timeouts, [`${APP_SEARCH_STATEMENT_TIMEOUT_MS}ms`], "the app's statements run under the search timeout");
  // SET LOCAL: the connection the search ran on is back to its own timeout.
  const [after] = (await getDb().execute(sql`SELECT current_setting('statement_timeout') AS timeout`)).rows as Array<{ timeout: string }>;
  assert.notEqual(after!.timeout, `${APP_SEARCH_STATEMENT_TIMEOUT_MS}ms`);
  // The app got the viewer, the trimmed query, the default limit, and the reader's visible homes in its
  // server (the same top-level conversations visibilityService lists; never the other server's channel).
  const roots = await visibleRootChannelIds({ type: "user", id: w.owner.id, serverId: w.serverId }, { includeThreads: false });
  assert.ok(roots.roots.some((root) => root.id === w.mine.id));
  assert.deepEqual(seen.inputs, [{ app: "steady", userId: w.owner.id, serverId: w.server.id, q: "plans", limit: 20, cursor: null, visibleChannels: roots.roots.length }]);
});

test("with `app`: that app's group only, its cursor passed through; a switched-off app is 404 APP_NOT_FOUND, as an unknown one", async ({ app, seed }) => {
  const w = await world(seed);
  const slow = await get(app, webSearchPath({ q: "plans", app: "slowpoke" as "artifacts" }), w.who);
  assert.equal(slow.status, 200);
  assert.deepEqual(slow.body, { groups: [{ app: "slowpoke", error: "timeout" }] });
  const steady = await get(app, `/api/search?q=plans&app=steady&cursor=opaque-to-core&limit=3`, w.who);
  assert.deepEqual(steady.body, { groups: [{ app: "steady", items: [], nextCursor: null }] });
  assert.equal(seen.inputs[0]!.cursor, "opaque-to-core");
  assert.equal(seen.inputs[0]!.limit, 3);
  for (const id of ["dormant", "nope"]) {
    const reply = await get(app, `/api/search?q=plans&app=${id}`, w.who);
    assert.equal(reply.status, 404, id);
    assert.equal(reply.body.code, "APP_NOT_FOUND");
  }
  assert.equal(seen.inputs.filter((input) => input.app === "dormant").length, 0, "a switched-off app is never asked");
});
