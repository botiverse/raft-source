import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { eq, sql } from "drizzle-orm";
import type { Request, RequestHandler, Response } from "express";
import {
  PUBLIC_SERVER_FEATURE_FLAG_KEY,
  PUBLIC_SERVER_SEARCH_INDEX_FEATURE_FLAG_KEY,
} from "@botiverse/raft-shared";
import { openTestApp } from "../test/integration/app";
import { getDb } from "../db/index";
import { channels, featureFlagRules, featureFlags, publicSearchServiceKeys, serverPublicRoutes, servers } from "../db/schema";
import { createChannel, getOrCreateThread } from "../services/channelService";
import { createMessage } from "../services/messageService";
import {
  classifyPublicSearchRequest,
  createUncheckedTestKeySource,
  createMemoryPublicSearchBucketStore,
  createPublicSearchAccess,
  createRedisPublicSearchBucketStore,
  PUBLIC_SEARCH_BUCKET_LUA,
  PUBLIC_SEARCH_SERVICE_CLIENT_ID,
  readPublicSearchServiceLimits,
  validatePublicSearchServiceKeys,
  type PublicSearchServiceBucketStore,
} from "../lib/publicSearchServiceAccess";
import { createServer, seedUser } from "./channels.api.fixtures";

/**
 * Public server SEO, task #4 (Ark's frozen contract, #proj-public-server-seo:d1bb5998):
 * raft.build's service credential buys one dedicated, finite bucket and never
 * content; keys are read per request (removal works on the next request);
 * refused credentials never fall back to the anonymous path; an unusable key
 * set or shared bucket fails closed (503) for the service path only; secrets
 * never leak; and the index walks servers in bounded pages.
 */

function credential() {
  const token = randomBytes(32).toString("base64url");
  return { token, sha256: createHash("sha256").update(token).digest("hex") };
}

const CURRENT = credential();
const PREVIOUS = credential();
const NEXT = credential();

const service = (keyId: string, token: string) => ({ Authorization: `Raft-Service v1 ${keyId}.${token}` });

async function setFlag(key: string, on: boolean) {
  await getDb().update(featureFlags).set({ enabled: true, killSwitch: false, defaultEnabled: on }).where(eq(featureFlags.key, key));
}

async function withEnv<T>(env: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function seedPublicServer(slug: string) {
  const owner = await seedUser(`${slug}-owner@slock.test`, `${slug}-owner`);
  const server = await createServer(`Server ${slug}`, slug, owner.id);
  const open = await createChannel(server.id, "open-talk", undefined, "channel", { type: "user", id: owner.id });
  await getDb().update(channels).set({ guestVisible: true }).where(eq(channels.id, open.id));
  await getDb().update(servers).set({ publiclyVisible: true }).where(eq(servers.id, server.id));
  const parent = await createMessage(open.id, "user", owner.id, `Question in ${slug}`);
  const thread = await getOrCreateThread(parent.id, owner.id, "user");
  await createMessage(thread.id, "user", owner.id, "A reply");
  const [route] = await getDb().select({ publicId: serverPublicRoutes.publicId }).from(serverPublicRoutes).where(eq(serverPublicRoutes.serverId, server.id));
  return { server, serverPid: route!.publicId };
}

async function setKeys(rows: Array<{ keyId: string; sha256: string; expiresAt?: Date | null }>) {
  await getDb().transaction(async (tx) => {
    await tx.delete(publicSearchServiceKeys);
    if (rows.length > 0) {
      await tx.insert(publicSearchServiceKeys).values(rows.map((row) => ({ ...row, clientId: PUBLIC_SEARCH_SERVICE_CLIENT_ID, expiresAt: row.expiresAt ?? null })));
    }
  });
}

/** The test database's single connection owns every table, so the role preflight is the real-PG test's job. */
const testHarness = (bucketStore: PublicSearchServiceBucketStore) => ({
  publicSearchKeySource: createUncheckedTestKeySource(),
  publicSearchBucketStore: bucketStore,
});

test("public search service access: per-request keys, no anonymous fallback, shared finite bucket, predicate still decides, no secret leaks", async () => {
  await withEnv({ RAFT_LANDING_SERVICE_RATE_PER_MINUTE: "12", RAFT_LANDING_SERVICE_MAX_IN_FLIGHT: "4" }, async () => {
    const app = await openTestApp("pglite://", 0, {
      humanActivityMuteFlagDefaultEnabled: true,
      ...testHarness(createMemoryPublicSearchBucketStore()),
    });
    const logged: string[] = [];
    const originals = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    for (const name of Object.keys(originals) as (keyof typeof originals)[]) {
      console[name] = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
    }
    try {
      await setFlag(PUBLIC_SERVER_FEATURE_FLAG_KEY, true);
      await setFlag(PUBLIC_SERVER_SEARCH_INDEX_FEATURE_FLAG_KEY, true);
      await setKeys([
        { keyId: "k-current", sha256: CURRENT.sha256 },
        { keyId: "k-previous", sha256: PREVIOUS.sha256, expiresAt: new Date("2999-01-01T00:00:00Z") },
      ]);
      const seed = await seedPublicServer("svc-access");
      const url = `${app.baseUrl}/api/public/search/servers/${seed.serverPid}`;
      const bodies: string[] = [];
      const get = async (headers: Record<string, string> = {}) => {
        const res = await fetch(url, { headers });
        bodies.push(await res.clone().text());
        return res;
      };

      // Refused credentials: 401 every time, never the anonymous 200. (Refusals take no bucket slot.)
      assert.equal((await get()).status, 200, "anonymous control");
      for (const [name, headers] of [
        ["unknown keyId", service("k-nope", CURRENT.token)],
        ["wrong token for the key", service("k-current", PREVIOUS.token)],
        ["token of the wrong shape", service("k-current", "short")],
        ["no version", { Authorization: `Raft-Service k-current.${CURRENT.token}` }],
        ["bare scheme", { Authorization: "Raft-Service" }],
      ] as const) {
        const res = await get(headers as Record<string, string>);
        assert.equal(res.status, 401, name);
        assert.equal(res.headers.get("cache-control"), "no-store", name);
      }

      // Valid keys get the predicate's answer.                                   (bucket used: 2)
      assert.equal((await get(service("k-current", CURRENT.token))).status, 200, "current key");
      assert.equal((await get(service("k-previous", PREVIOUS.token))).status, 200, "previous key before its deadline");

      // Keys are read per request: the same running app sees every change at once. (bucket used: 3)
      await setKeys([{ keyId: "k-current", sha256: CURRENT.sha256 }]);
      assert.equal((await get(service("k-previous", PREVIOUS.token))).status, 401, "previous key removed in a transaction: refused on the next request");
      await setKeys([{ keyId: "k-next", sha256: NEXT.sha256 }]);
      assert.equal((await get(service("k-current", CURRENT.token))).status, 401, "current replaced: the old token is refused on the next request");
      assert.equal((await get(service("k-next", NEXT.token))).status, 200, "…and the new one works");
      await setKeys([{ keyId: "k-next", sha256: NEXT.sha256, expiresAt: new Date("2999-01-01T00:00:00Z") }]);
      assert.equal((await get(service("k-next", NEXT.token))).status, 503, "no current key: the service path is unavailable");
      await setKeys([]);
      assert.equal((await get(service("k-next", NEXT.token))).status, 503, "no keys at all: unavailable, not a fallback");
      assert.equal((await get()).status, 200, "the anonymous path is unaffected throughout");
      await setKeys([{ keyId: "k-next", sha256: NEXT.sha256 }]);

      // The credential does not open anything.                                   (bucket used: 6)
      await setFlag(PUBLIC_SERVER_SEARCH_INDEX_FEATURE_FLAG_KEY, false);
      assert.equal((await get(service("k-next", NEXT.token))).status, 404, "closed switch: 404 for the service too");
      const index = await (await fetch(`${app.baseUrl}/api/public/search/index`, { headers: service("k-next", NEXT.token) })).json() as { entries: unknown[] };
      assert.deepEqual(index.entries, [], "closed switch: empty index for the service too");
      await setFlag(PUBLIC_SERVER_SEARCH_INDEX_FEATURE_FLAG_KEY, true);
      await getDb().update(servers).set({ publiclyVisible: false }).where(eq(servers.id, seed.server.id));
      assert.equal((await get(service("k-next", NEXT.token))).status, 404, "server made private: 404 for the service too");
      await getDb().update(servers).set({ publiclyVisible: true }).where(eq(servers.id, seed.server.id));

      // The bucket is shared, whatever forwarding headers claim. 6 used so far; spend the rest of 12.
      const forged = { "X-Forwarded-For": "203.0.113.9, 198.51.100.1", "CloudFront-Viewer-Address": "203.0.113.10:443" };
      for (let i = 7; i <= 12; i += 1) assert.equal((await get({ ...service("k-next", NEXT.token), ...forged })).status, 200, `request ${i}`);
      const limited = await get({ ...service("k-next", NEXT.token), "X-Forwarded-For": "192.0.2.77, 198.51.100.2" });
      assert.equal(limited.status, 429, "13th request in the minute: the shared bucket is spent, other forwarded IPs or not");
      const retryAfter = Number(limited.headers.get("retry-after"));
      assert.ok(retryAfter >= 1 && retryAfter <= 60, `bounded Retry-After, got ${retryAfter}`);
      assert.equal((await get()).status, 200, "the anonymous bucket is separate and untouched");

      // Nothing secret-shaped leaves the server.
      for (const secret of [CURRENT.token, PREVIOUS.token, NEXT.token, CURRENT.sha256, PREVIOUS.sha256, NEXT.sha256, "k-current.", "k-next."]) {
        assert.ok(!bodies.some((body) => body.includes(secret)), `no response body carries ${secret.slice(0, 6)}…`);
        assert.ok(!logged.some((line) => line.includes(secret)), `no log line carries ${secret.slice(0, 6)}…`);
      }
    } finally {
      Object.assign(console, originals);
      await app.close();
    }
  });
});

test("public search service access: without an injected bucket the app refuses service traffic rather than counting it per process", async () => {
  const app = await openTestApp("pglite://", 0, {
    humanActivityMuteFlagDefaultEnabled: true,
    publicSearchKeySource: createUncheckedTestKeySource(),
  });
  try {
    await setFlag(PUBLIC_SERVER_FEATURE_FLAG_KEY, true);
    await setFlag(PUBLIC_SERVER_SEARCH_INDEX_FEATURE_FLAG_KEY, true);
    await setKeys([{ keyId: "k-current", sha256: CURRENT.sha256 }]);
    const seed = await seedPublicServer("svc-noredis");
    const url = `${app.baseUrl}/api/public/search/servers/${seed.serverPid}`;
    assert.equal((await fetch(url, { headers: service("k-current", CURRENT.token) })).status, 503, "no Redis: the shared bucket is unavailable, fail closed");
    assert.equal((await fetch(url)).status, 200, "anonymous unaffected");
  } finally {
    await app.close();
  }
});

/** A minimal Express response for gate-level tests. */
function fakeRes() {
  const res = new EventEmitter() as EventEmitter & {
    statusCode: number; headersSent: boolean; headers: Record<string, string>;
    set: (k: string, v: string) => unknown; status: (c: number) => unknown; json: () => unknown;
  };
  res.statusCode = 200;
  res.headersSent = false;
  res.headers = {};
  res.set = (key: string, value: string) => { res.headers[key.toLowerCase()] = value; return res; };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = () => { res.headersSent = true; res.emit("finish"); return res; };
  return res;
}

const passThrough: RequestHandler = (_req, _res, next) => next();
const keysNow = async () => [{ keyId: "k-current", sha256: CURRENT.sha256, expiresAt: null }];
const serviceReq = () => ({ headers: { authorization: service("k-current", CURRENT.token).Authorization } }) as unknown as Request;

async function send(access: RequestHandler, wait = 30) {
  const res = fakeRes();
  let reachedContent = false;
  access(serviceReq(), res as unknown as Response, () => { reachedContent = true; });
  await new Promise((resolve) => setTimeout(resolve, wait));
  return { res, reachedContent };
}

test("public search service access: an unavailable, failing or slow shared bucket is a 503 before any content, and takes no slot", async () => {
  const limits = readPublicSearchServiceLimits({ RAFT_LANDING_SERVICE_MAX_IN_FLIGHT: "1" });
  const healthy = createMemoryPublicSearchBucketStore();
  const stores: Record<string, PublicSearchServiceBucketStore> = {
    unavailable: createRedisPublicSearchBucketStore(() => null),
    "not ready": createRedisPublicSearchBucketStore(() => ({ status: "reconnecting", eval: async () => 1 }) as never),
    erroring: { incrementWithTtl: async () => { throw new Error("READONLY"); } },
    slow: { incrementWithTtl: () => new Promise<number>(() => {}) },
  };
  for (const [name, store] of Object.entries(stores)) {
    let healthyStore = false;
    const access = createPublicSearchAccess({
      anonymousLimiter: passThrough,
      verifyLimiter: passThrough,
      limits,
      keySource: keysNow,
      bucketDeadlineMs: 40,
      bucketStore: { incrementWithTtl: (key, ttl) => (healthyStore ? healthy : store).incrementWithTtl(key, ttl) },
    });
    const refused = await send(access, 80);
    assert.equal(refused.res.statusCode, 503, `${name}: 503`);
    assert.equal(refused.res.headers["cache-control"], "no-store", `${name}: no-store`);
    assert.equal(refused.reachedContent, false, `${name}: no content query`);
    healthyStore = true;
    const after = await send(access);
    assert.equal(after.reachedContent, true, `${name}: the slot was never taken, so a healthy request still gets it (cap 1)`);
  }
});

test("public search service access: a key lookup that never answers is a 503 within its deadline, before any content and without a slot", async () => {
  const access = createPublicSearchAccess({
    anonymousLimiter: passThrough,
    verifyLimiter: passThrough,
    keySource: () => new Promise(() => {}),
    keyLookupDeadlineMs: 40,
    bucketStore: createMemoryPublicSearchBucketStore(),
    limits: readPublicSearchServiceLimits({ RAFT_LANDING_SERVICE_MAX_IN_FLIGHT: "1" }),
  });
  const started = Date.now();
  const hung = await send(access, 120);
  assert.equal(hung.res.statusCode, 503);
  assert.equal(hung.res.headers["cache-control"], "no-store");
  assert.equal(hung.reachedContent, false);
  assert.ok(Date.now() - started < 400, "answered within the deadline, not left hanging");
});

test("public search service access: the in-flight cap holds a slot until the response ends; two gates share one injected bucket; the IP limiter runs before the key lookup", async () => {
  const store = createMemoryPublicSearchBucketStore();
  const access = createPublicSearchAccess({
    anonymousLimiter: passThrough, verifyLimiter: passThrough, keySource: keysNow, bucketStore: store,
    limits: readPublicSearchServiceLimits({ RAFT_LANDING_SERVICE_MAX_IN_FLIGHT: "1" }),
  });
  const first = await send(access);
  assert.equal(first.reachedContent, true, "first request takes the slot");
  const second = await send(access);
  assert.equal(second.reachedContent, false);
  assert.equal(second.res.statusCode, 429, "a second concurrent request is refused, not queued");
  first.res.emit("finish");
  const third = await send(access);
  assert.equal(third.reachedContent, true, "the slot is free again once the first response ended");
  third.res.emit("close");
  third.res.emit("finish");
  assert.equal((await send(access)).reachedContent, true, "close and finish release once, never twice");
  assert.equal((await send(access)).res.statusCode, 429, "…so the cap is still exactly one");

  // Two replicas, one shared store: the third request in the minute is refused whichever gate takes it.
  const shared = createMemoryPublicSearchBucketStore();
  const gate = () => createPublicSearchAccess({
    anonymousLimiter: passThrough, verifyLimiter: passThrough, keySource: keysNow, bucketStore: shared,
    limits: readPublicSearchServiceLimits({ RAFT_LANDING_SERVICE_RATE_PER_MINUTE: "2" }),
  });
  const [replicaA, replicaB] = [gate(), gate()];
  const outcomes: number[] = [];
  for (const replica of [replicaA, replicaB, replicaA]) {
    const sent = await send(replica);
    outcomes.push(sent.reachedContent ? 200 : sent.res.statusCode);
    sent.res.emit("finish");
  }
  assert.deepEqual(outcomes, [200, 200, 429]);

  let lookups = 0;
  const throttled = createPublicSearchAccess({
    anonymousLimiter: passThrough,
    verifyLimiter: (_req, res) => {
      const fake = res as unknown as ReturnType<typeof fakeRes>;
      fake.status(429);
      fake.json();
    },
    keySource: async () => { lookups += 1; return keysNow(); },
    bucketStore: store,
    limits: readPublicSearchServiceLimits({}),
  });
  const blocked = await send(throttled);
  assert.equal(blocked.res.statusCode, 429);
  assert.equal(lookups, 0, "the key table is not read once the IP limiter refuses");
});

test("public search service access: the production Redis adapter is one atomic EVAL whose script repairs a lost TTL", async () => {
  const calls: unknown[][] = [];
  const store = createRedisPublicSearchBucketStore(() => ({
    status: "ready",
    eval: async (...args: unknown[]) => { calls.push(args); return 7; },
  }) as never);
  assert.equal(await store.incrementWithTtl("raft-landing-public-seo:rate:42", 120), 7);
  assert.deepEqual(calls, [[PUBLIC_SEARCH_BUCKET_LUA, 1, "raft-landing-public-seo:rate:42", 120]], "exactly one call: the script, one key, the TTL");
  // The script increments, and sets the TTL whenever the key has none (a new key or one that lost it).
  assert.match(PUBLIC_SEARCH_BUCKET_LUA, /redis\.call\('INCR', KEYS\[1\]\)/);
  assert.match(PUBLIC_SEARCH_BUCKET_LUA, /if redis\.call\('TTL', KEYS\[1\]\) < 0 then\s+redis\.call\('EXPIRE', KEYS\[1\], tonumber\(ARGV\[1\]\)\)/);
  // A real Redis runs the script itself in publicSearchServiceBucket.realRedis.test.ts (CI: probe-concurrency job).
});

test("public search service access: key sets and limits that are not usable", () => {
  const ok = (rows: Parameters<typeof validatePublicSearchServiceKeys>[0]) => validatePublicSearchServiceKeys(rows).ok;
  assert.equal(ok([{ keyId: "a", sha256: CURRENT.sha256, expiresAt: null }]), true);
  assert.equal(ok([]), false, "no keys");
  assert.equal(ok([{ keyId: "a", sha256: CURRENT.sha256, expiresAt: "2999-01-01" }]), false, "no current key");
  assert.equal(ok([{ keyId: "a", sha256: CURRENT.sha256, expiresAt: null }, { keyId: "b", sha256: PREVIOUS.sha256, expiresAt: null }]), false, "two current keys (an injected illegal snapshot)");
  assert.equal(ok([{ keyId: "a", sha256: CURRENT.sha256, expiresAt: null }, { keyId: "a", sha256: PREVIOUS.sha256, expiresAt: "2999-01-01" }]), false, "duplicate keyId");
  assert.equal(ok([{ keyId: "a", sha256: "abc", expiresAt: null }]), false, "digest of the wrong length");
  assert.equal(readPublicSearchServiceLimits({ RAFT_LANDING_SERVICE_RATE_PER_MINUTE: "0" }).status, "invalid", "a zero bucket is not allowed");
  assert.equal(readPublicSearchServiceLimits({ RAFT_LANDING_SERVICE_MAX_IN_FLIGHT: "lots" }).status, "invalid");
  assert.equal(classifyPublicSearchRequest(undefined, [], new Date()), "anonymous");
  assert.equal(classifyPublicSearchRequest("Bearer abc", [], new Date()), "anonymous", "another scheme stays anonymous");
});

test("public search service access: invalid limits make only the service path unavailable", async () => {
  await withEnv({ RAFT_LANDING_SERVICE_RATE_PER_MINUTE: "0" }, async () => {
    const app = await openTestApp("pglite://", 0, {
      humanActivityMuteFlagDefaultEnabled: true,
      ...testHarness(createMemoryPublicSearchBucketStore()),
    });
    try {
      await setFlag(PUBLIC_SERVER_FEATURE_FLAG_KEY, true);
      await setFlag(PUBLIC_SERVER_SEARCH_INDEX_FEATURE_FLAG_KEY, true);
      await setKeys([{ keyId: "k-current", sha256: CURRENT.sha256 }]);
      const seed = await seedPublicServer("svc-badlimits");
      const url = `${app.baseUrl}/api/public/search/servers/${seed.serverPid}`;
      assert.equal((await fetch(url, { headers: service("k-current", CURRENT.token) })).status, 503);
      assert.equal((await fetch(url)).status, 200, "anonymous unaffected");
    } finally {
      await app.close();
    }
  });
});

test("public search index: bounded pages walk every searchable entry exactly once, and a closed switch reads nothing", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, skipAuthRateLimit: true });
  try {
    await setFlag(PUBLIC_SERVER_FEATURE_FLAG_KEY, true);
    await setFlag(PUBLIC_SERVER_SEARCH_INDEX_FEATURE_FLAG_KEY, false);
    const closed = await (await fetch(`${app.baseUrl}/api/public/search/index`)).json() as { entries: unknown[]; nextCursor: string | null };
    assert.deepEqual(closed, { entries: [], nextCursor: null });

    const seeds = [];
    for (let i = 0; i < 28; i += 1) seeds.push(await seedPublicServer(`svc-idx-${i}`));

    await getDb().insert(featureFlagRules).values({
      flagKey: PUBLIC_SERVER_SEARCH_INDEX_FEATURE_FLAG_KEY, stage: "server", decision: "allow", values: [seeds[3]!.server.id, seeds[17]!.server.id],
    });
    const ruled = await (await fetch(`${app.baseUrl}/api/public/search/index`)).json() as { entries: { canonicalPath: string }[] };
    const ruledServers = new Set(ruled.entries.map((entry) => entry.canonicalPath.split("/")[2]));
    assert.deepEqual([...ruledServers].sort(), [seeds[3]!.serverPid, seeds[17]!.serverPid].sort(), "only servers the rule opens");
    await getDb().delete(featureFlagRules).where(eq(featureFlagRules.flagKey, PUBLIC_SERVER_SEARCH_INDEX_FEATURE_FLAG_KEY));

    await setFlag(PUBLIC_SERVER_SEARCH_INDEX_FEATURE_FLAG_KEY, true);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const page = await (await fetch(`${app.baseUrl}/api/public/search/index${query}`)).json() as { entries: { canonicalPath: string }[]; nextCursor: string | null };
      const pageServers = new Set(page.entries.map((entry) => entry.canonicalPath.split("/")[2]));
      assert.ok(pageServers.size <= 25, `a page covers at most 25 servers with entries, got ${pageServers.size}`);
      seen.push(...page.entries.map((entry) => entry.canonicalPath));
      cursor = page.nextCursor;
      pages += 1;
      assert.ok(pages < 10, "the walk ends");
    } while (cursor);
    assert.ok(pages >= 2, "28 servers do not fit one page");
    assert.equal(new Set(seen).size, seen.length, "no entry twice");
    assert.equal(seen.length, 28 * 3, "every entry once");
  } finally {
    await app.close();
  }
});

function lpadHex(n: number) {
  return n.toString(16).padStart(32, "0");
}

test("public search index: past 500 candidates with no entries it stops with a forward cursor, and the eligible server after them appears exactly once", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, skipAuthRateLimit: true });
  try {
    const db = getDb();
    await setFlag(PUBLIC_SERVER_FEATURE_FLAG_KEY, true);
    await setFlag(PUBLIC_SERVER_SEARCH_INDEX_FEATURE_FLAG_KEY, false);
    const eligible = await seedPublicServer("svc-cap-eligible");
    const owner = await seedUser("svc-cap-owner@slock.test", "svc-cap-owner");
    // 520 public, searchable servers the master switch does not open, all ordered before the eligible one.
    await db.execute(sql`
      INSERT INTO servers (id, name, slug, owner_id, publicly_visible)
      SELECT gen_random_uuid(), 'cap ' || n, 'svc-cap-' || lpad(n::text, 4, '0'), ${owner.id}::uuid, true
      FROM generate_series(1, 520) AS n
    `);
    await db.execute(sql`
      UPDATE server_public_routes r SET public_id = lpad(to_hex(s.n), 32, '0')
      FROM (SELECT id, row_number() OVER (ORDER BY slug) AS n FROM servers WHERE slug LIKE 'svc-cap-0%') s
      WHERE r.server_id = s.id
    `);
    await db.update(serverPublicRoutes).set({ publicId: "f".repeat(32) }).where(eq(serverPublicRoutes.serverId, eligible.server.id));
    await db.insert(featureFlagRules).values({
      flagKey: PUBLIC_SERVER_SEARCH_INDEX_FEATURE_FLAG_KEY, stage: "server", decision: "allow", values: [eligible.server.id],
    });

    const pages: Array<{ entries: { canonicalPath: string }[]; nextCursor: string | null }> = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const page = await (await fetch(`${app.baseUrl}/api/public/search/index${query}`)).json() as { entries: { canonicalPath: string }[]; nextCursor: string | null };
      pages.push(page);
      cursor = page.nextCursor;
      assert.ok(pages.length < 5, "the walk ends");
    } while (cursor);

    assert.deepEqual(pages[0]!.entries, [], "the first 500 candidates produce nothing");
    assert.equal(pages[0]!.nextCursor, `${lpadHex(500)}:done`, "…and the request stops at the 500th candidate (5 × 100), with a forward cursor");
    const all = pages.flatMap((page) => page.entries.map((entry) => entry.canonicalPath));
    assert.equal(all.filter((path) => path.split("/")[2] === "f".repeat(32)).length, 3, "the eligible server's three entries, once each");
    assert.equal(all.length, 3, "nothing else");
  } finally {
    await app.close();
  }
});
