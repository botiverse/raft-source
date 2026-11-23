import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import { LINK_CARD_CHANGED_HINTS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import type { LinkCardObjectKeySha256, LinkCardObjectRef } from "@botiverse/raft-shared/src/appLinkPreview";
import { UUID_RE } from "../lib/messageId";
import { getBoundedRedis, isRedisAvailable } from "../redis";
import { serializeErrorForLog } from "../tracing/safeErrorLog";
import { evaluateFeatureFlags } from "./featureFlagService";
import { cachedServerFlagAnswers } from "./featureFlagReadCache";

// Who read which App object recently, for link cards that update themselves
// (docs/development/app-link-previews.md, "Telling Raft a card changed";
// linkCardChangedHints.ts sends the nudges). A read that shows a card whose App
// named its object (`object_ref`) records (viewer, Server of the read) under
// the object's key, the digest of (App id, object_ref). Nothing else: no URL,
// no label, no content.
//
// Kept in Redis, one sorted set per object scored by the read's time: 24 hours
// from the last read (the key's expiry is refreshed on each), at most 1,000
// readers (the oldest go first). The coalescing window of the App's changes
// (linkCardChangedHints.ts) lives here too, beside the readers. Without Redis
// configured the server runs as one replica, so this process's memory is the
// whole store (as fixedWindowRateLimit.ts).
//
// Recording never fails or delays a read: it runs after the answer is built,
// is never awaited by the read, each Redis call has a short deadline, and any
// failure is logged (serializeErrorForLog) and dropped. A lost record only
// means that reader's card waits for its next display, as before.

/** How long a read counts: a nudge goes to people who read the object within this. */
export const LINK_CARD_READERS_WINDOW_MS = 24 * 3600_000;
/** Readers kept per object; past it the oldest reads go first. */
export const LINK_CARD_READERS_PER_OBJECT = 1000;
/** Each store call's deadline, whatever timeout the shared bounded client was created with. */
export const LINK_CARD_READERS_DEADLINE_MS = 300;
/** The shared bounded client's own command timeout, when this module creates it. */
const REDIS_COMMAND_TIMEOUT_MS = 250;

/**
 * The key Raft gives an App's object: SHA-256 hex of the JSON array
 * `[App id, object_ref]` (an unambiguous encoding of the pair). The App id is
 * `oauth_clients.id`, the `app.id` clients see on read items, so one App's
 * label never names another App's object.
 */
export function linkCardObjectKeySha256(appId: string, objectRef: LinkCardObjectRef): LinkCardObjectKeySha256 {
  return createHash("sha256").update(JSON.stringify([appId, objectRef]), "utf8").digest("hex") as LinkCardObjectKeySha256;
}

/** One recorded reader: the viewer and the Server they read on (a guest's own Server in a joint channel). */
export type LinkCardReader = { viewerId: string; serverId: string };
const readerMember = (reader: LinkCardReader) => `${reader.viewerId}:${reader.serverId}`;
function parseReaderMember(member: string): LinkCardReader | null {
  const [viewerId, serverId, extra] = member.split(":");
  return viewerId && serverId && extra === undefined && UUID_RE.test(viewerId) && UUID_RE.test(serverId) ? { viewerId, serverId } : null;
}

/**
 * Where readers and coalescing windows live. Every method may throw (Redis
 * down, slow, an odd reply); callers catch.
 */
export interface LinkCardReaderStore {
  /** Adds `member` to each object's readers at `nowMs`, drops reads older than the window and past the cap, refreshes the expiry. */
  record(objectKeys: readonly LinkCardObjectKeySha256[], member: string, nowMs: number): Promise<void>;
  /** Each object's readers read since `sinceMs`, in order. */
  readers(objectKeys: readonly LinkCardObjectKeySha256[], sinceMs: number): Promise<string[][]>;
  /**
   * Opens the object's coalescing window for `ttlMs` under `token` (true: the
   * caller owns it and sends now), or, when one is open, marks it dirty
   * (false: its owner sends once more when it closes).
   */
  openOrMark(objectKey: LinkCardObjectKeySha256, token: string, ttlMs: number): Promise<boolean>;
  /** Closes the window `token` opened; true when it was marked dirty meanwhile. Another owner's window is left alone (false). */
  close(objectKey: LinkCardObjectKeySha256, token: string): Promise<boolean>;
}

const readersKey = (objectKey: string) => `slock:link-card:readers:${objectKey}`;
const windowKey = (objectKey: string) => `slock:link-card:changed_window:${objectKey}`;
const dirtyKey = (objectKey: string) => `slock:link-card:changed_dirty:${objectKey}`;

/** SET NX PX the window, or mark it dirty for as long. */
const OPEN_OR_MARK = `
if redis.call("SET", KEYS[1], ARGV[1], "NX", "PX", ARGV[2]) then return 1 end
redis.call("SET", KEYS[2], "1", "PX", ARGV[2])
return 0`;
/** Only the owner closes its window; the dirty mark goes with it, and says whether to send once more. */
const CLOSE = `
if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end
redis.call("DEL", KEYS[1])
return redis.call("DEL", KEYS[2])`;

function withDeadline<T>(work: () => Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} took over ${LINK_CARD_READERS_DEADLINE_MS} ms`)), LINK_CARD_READERS_DEADLINE_MS);
  });
  return Promise.race([work(), deadline]).finally(() => clearTimeout(timer));
}

/**
 * A client to use now: ready, or still making its first connection (then
 * waited for, within the caller's deadline; one wait per client however many
 * calls wait). Reconnecting or closed fails at once: the bounded client queues
 * nothing.
 */
const firstConnects = new WeakMap<Redis, Promise<void>>();
async function readyClient(client: Redis | null): Promise<Redis> {
  if (!client) throw new Error("Redis is not configured");
  if (client.status === "ready") return client;
  if (client.status !== "wait" && client.status !== "connecting" && client.status !== "connect") throw new Error(`Redis is ${client.status}`);
  if (client.status === "wait") void client.connect().catch(() => {});
  let first = firstConnects.get(client);
  if (!first) {
    first = new Promise<void>((resolve, reject) => {
      const onReady = () => { client.off("error", onError); resolve(); };
      const onError = (error: Error) => { client.off("ready", onReady); reject(error); };
      client.once("ready", onReady);
      client.once("error", onError);
    }).finally(() => firstConnects.delete(client));
    firstConnects.set(client, first);
  }
  await first;
  return client;
}

function checkReplies(replies: [Error | null, unknown][] | null, expected: number): unknown[] {
  if (!replies || replies.length !== expected) throw new Error("Redis answered the wrong number of replies");
  return replies.map(([error, value]) => { if (error) throw error; return value; });
}

/** The Redis store over `getClient` (the shared bounded client by default; a test's own). */
export function redisLinkCardReaderStore(getClient: () => Redis | null): LinkCardReaderStore {
  return {
    record: (objectKeys, member, nowMs) => withDeadline(async () => {
      const multi = (await readyClient(getClient())).multi();
      for (const objectKey of objectKeys) {
        const key = readersKey(objectKey);
        multi.zadd(key, nowMs, member)
          .zremrangebyscore(key, "-inf", nowMs - LINK_CARD_READERS_WINDOW_MS)
          .zremrangebyrank(key, 0, -(LINK_CARD_READERS_PER_OBJECT + 1))
          .pexpire(key, LINK_CARD_READERS_WINDOW_MS);
      }
      checkReplies(await multi.exec(), objectKeys.length * 4);
    }, "link card reader record"),
    readers: (objectKeys, sinceMs) => withDeadline(async () => {
      const pipeline = (await readyClient(getClient())).pipeline();
      for (const objectKey of objectKeys) pipeline.zrangebyscore(readersKey(objectKey), `(${sinceMs}`, "+inf");
      return checkReplies(await pipeline.exec(), objectKeys.length).map((members) => {
        if (!Array.isArray(members) || !members.every((member) => typeof member === "string")) throw new Error("Redis answered readers that are not a list");
        return members as string[];
      });
    }, "link card reader lookup"),
    openOrMark: (objectKey, token, ttlMs) => withDeadline(async () =>
      Number(await (await readyClient(getClient())).eval(OPEN_OR_MARK, 2, windowKey(objectKey), dirtyKey(objectKey), token, String(ttlMs))) === 1,
    "link card change window"),
    close: (objectKey, token) => withDeadline(async () =>
      Number(await (await readyClient(getClient())).eval(CLOSE, 2, windowKey(objectKey), dirtyKey(objectKey), token)) === 1,
    "link card change window close"),
  };
}

/** Past this many objects the memory store starts over (bounds memory; a lost record only waits for the next display). */
const MEMORY_MAX_OBJECTS = 50_000;

/** This process's memory as the store: the whole store for a server without Redis (one replica), and the tests'. */
export function memoryLinkCardReaderStore(): LinkCardReaderStore & { clear(): void } {
  const readers = new Map<string, Map<string, number>>();
  const windows = new Map<string, { token: string; expiresAt: number }>();
  const dirty = new Map<string, number>();
  const live = <T extends { expiresAt: number } | number>(map: Map<string, T>, key: string, now: number) => {
    const entry = map.get(key);
    const expiresAt = typeof entry === "number" ? entry : entry?.expiresAt;
    if (expiresAt !== undefined && expiresAt <= now) { map.delete(key); return undefined; }
    return entry;
  };
  return {
    async record(objectKeys, member, nowMs) {
      if (readers.size > MEMORY_MAX_OBJECTS) readers.clear();
      for (const objectKey of objectKeys) {
        const set = readers.get(objectKey) ?? new Map<string, number>();
        readers.set(objectKey, set);
        set.delete(member);
        set.set(member, nowMs);
        for (const [who, at] of set) if (at <= nowMs - LINK_CARD_READERS_WINDOW_MS) set.delete(who);
        // Insertion order is read order: the first are the oldest.
        while (set.size > LINK_CARD_READERS_PER_OBJECT) set.delete(set.keys().next().value!);
      }
    },
    async readers(objectKeys, sinceMs) {
      return objectKeys.map((objectKey) => [...(readers.get(objectKey) ?? [])].filter(([, at]) => at > sinceMs).map(([who]) => who));
    },
    async openOrMark(objectKey, token, ttlMs) {
      const now = Date.now();
      if (!live(windows, objectKey, now)) { windows.set(objectKey, { token, expiresAt: now + ttlMs }); return true; }
      dirty.set(objectKey, now + ttlMs);
      return false;
    },
    async close(objectKey, token) {
      const now = Date.now();
      if (live(windows, objectKey, now)?.token !== token) return false;
      windows.delete(objectKey);
      const marked = live(dirty, objectKey, now) !== undefined;
      dirty.delete(objectKey);
      return marked;
    },
    clear() { readers.clear(); windows.clear(); dirty.clear(); },
  };
}

const memoryStore = memoryLinkCardReaderStore();
const redisStore = redisLinkCardReaderStore(() => getBoundedRedis(REDIS_COMMAND_TIMEOUT_MS));
let testStore: LinkCardReaderStore | null = null;

/** The store in use: a test's, else Redis where it is configured, else this process's memory. */
export function linkCardReaderStore(): LinkCardReaderStore {
  return testStore ?? (isRedisAvailable() ? redisStore : memoryStore);
}

/**
 * Whether `link_card_changed_hints` is on for each Server, in order; off for
 * all on any failure (a broken flag store records and sends nothing).
 */
export async function linkCardChangedHintsOn(serverIds: readonly string[]): Promise<boolean[]> {
  try {
    return await cachedServerFlagAnswers(serverIds, LINK_CARD_CHANGED_HINTS_FEATURE_FLAG_KEY, async (missing) =>
      (await evaluateFeatureFlags(missing.map((serverId) => ({ key: LINK_CARD_CHANGED_HINTS_FEATURE_FLAG_KEY, serverId })))).map((answer) => answer.enabled));
  } catch (error) {
    console.warn("[LinkCardChanged] flag evaluation failed; reading it as off", serializeErrorForLog(error));
    return serverIds.map(() => false);
  }
}

/** Each object's readers within the window, parsed; a malformed member is skipped. */
export async function linkCardObjectReaders(objectKeys: readonly LinkCardObjectKeySha256[], nowMs: number): Promise<LinkCardReader[][]> {
  const members = await linkCardReaderStore().readers(objectKeys, nowMs - LINK_CARD_READERS_WINDOW_MS);
  return members.map((list) => list.flatMap((member) => parseReaderMember(member) ?? []));
}

const pending = new Set<Promise<void>>();
/** Keeps background work countable for the tests (__settleLinkCardReadersForTests); never rejects. */
export function trackLinkCardChangedWork(work: Promise<void>): void {
  pending.add(work);
  void work.finally(() => pending.delete(work));
}

/**
 * Records that `viewerId` was shown cards of these objects on `serverId`, in
 * the background: the caller never waits, and nothing it does can fail the
 * read. Only where `link_card_changed_hints` is on for that Server. Logs the
 * failure, never the keys.
 */
export function recordLinkCardReaders(input: { serverId: string; viewerId: string; objectKeys: readonly LinkCardObjectKeySha256[] }): void {
  const objectKeys = [...new Set(input.objectKeys)];
  if (!objectKeys.length) return;
  trackLinkCardChangedWork((async () => {
    try {
      const [on] = await linkCardChangedHintsOn([input.serverId]);
      if (!on) return;
      await linkCardReaderStore().record(objectKeys, readerMember(input), Date.now());
    } catch (error) {
      console.warn("[LinkCardChanged] reader record failed", { objects: objectKeys.length, error: serializeErrorForLog(error) });
    }
  })());
}

/** @internal Tests: the store to use (null: the default), with this process's memory emptied. */
export function __setLinkCardReaderStoreForTests(store: LinkCardReaderStore | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Link card reader hooks are test-only");
  testStore = store;
  memoryStore.clear();
}
/** @internal Tests: waits for every background record, change and send started so far (and those they start). */
export async function __settleLinkCardReadersForTests(): Promise<void> {
  while (pending.size) await Promise.all([...pending]);
}
