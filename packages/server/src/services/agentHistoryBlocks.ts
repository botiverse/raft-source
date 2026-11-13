// How often a Free server's agents reached for history its 30-day window hides
// (task #proj-commercial:#24, C+ step 2; design approved by Tenny): the
// upgrade dialog tells the owner "your agents ran into this N times in the
// past 7 days", which no agent says on its own (its upgrade card is for a
// person's ask, never its own work).
//
// One "time" is an agent explicitly reaching behind the window: paging back
// (`--before`) to the start of the window with older messages behind it, a
// read or lookup whose anchor, message or file is behind it, or a search whose
// window hid matches. A default page that merely touches the window is not one.
// Deduped to one per agent, conversation (or "search") and UTC day. Only the
// agent API counts; the legacy machine routes (routes/internal.ts) are left
// out on purpose, so agents on old daemons undercount.
//
// Kept in Redis (Tenny): a nudge, not billing. A set per server and UTC day,
// expiring after 8 days; the count is the sum of the last 7 days' set sizes.
// Writes are fire-and-forget. A read has its own short deadline and gives null
// on any failure or odd reply, so a slow or absent Redis costs the billing
// summary at most that deadline and never shows a wrong number (no number).

import type { Redis } from "ioredis";
import { getBoundedRedis } from "../redis";

const KEY_PREFIX = "agent-history-blocked";
const KEY_TTL_SECONDS = 8 * 24 * 60 * 60;
const WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The shared bounded client's own command timeout, when this module creates it. */
const REDIS_COMMAND_TIMEOUT_MS = 250;
/**
 * Each call's deadline here, whatever timeout the shared bounded client was
 * created with (its first caller sets it). Covers the first connect too: the
 * client is made on first use and queues nothing while it connects.
 */
export const AGENT_HISTORY_BLOCKS_DEADLINE_MS = 300;

/** Where an agent reached: the conversation (its storage channel id), or a search. */
export type AgentHistoryReach = { conversationId: string } | { search: true };

export interface AgentHistoryBlockStore {
  add(key: string, member: string, ttlSeconds: number): Promise<void>;
  /** Each key's set size, in order; throws on any failure or odd reply. */
  sizes(keys: readonly string[]): Promise<number[]>;
}

function withDeadline<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} took over ${AGENT_HISTORY_BLOCKS_DEADLINE_MS} ms`)), AGENT_HISTORY_BLOCKS_DEADLINE_MS);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/**
 * A client to use now: ready, or still making its first connection (then
 * waited for, within the caller's deadline). Reconnecting or closed fails at
 * once instead of waiting.
 */
async function connectedClient(client: Redis | null): Promise<Redis> {
  if (!client) throw new Error("Redis is not configured");
  if (client.status === "ready") return client;
  if (client.status !== "wait" && client.status !== "connecting" && client.status !== "connect") {
    throw new Error(`Redis is ${client.status}`);
  }
  if (client.status === "wait") void client.connect().catch(() => {});
  await firstConnect(client);
  return client;
}

/** One wait per client for its first connect, however many calls are waiting (one listener pair). */
const firstConnects = new WeakMap<Redis, Promise<void>>();
function firstConnect(client: Redis): Promise<void> {
  let pending = firstConnects.get(client);
  if (!pending) {
    pending = new Promise<void>((resolve, reject) => {
      const onReady = () => {
        client.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        client.off("ready", onReady);
        reject(error);
      };
      client.once("ready", onReady);
      client.once("error", onError);
    }).finally(() => firstConnects.delete(client));
    firstConnects.set(client, pending);
  }
  return pending;
}

/** The Redis store over `getClient` (the shared bounded client by default; a test's own). */
export function redisAgentHistoryBlockStore(getClient: () => Redis | null): AgentHistoryBlockStore {
  return {
    async add(key, member, ttlSeconds) {
      await withDeadline((async () => {
        const redis = await connectedClient(getClient());
        await redis.multi().sadd(key, member).expire(key, ttlSeconds).exec();
      })(), "agent history block write");
    },
    async sizes(keys) {
      return withDeadline((async () => {
        const redis = await connectedClient(getClient());
        const pipeline = redis.pipeline();
        for (const key of keys) pipeline.scard(key);
        const replies = await pipeline.exec();
        if (!replies || replies.length !== keys.length) throw new Error("Redis answered the wrong number of replies");
        return replies.map(([error, size]) => {
          if (error) throw error;
          if (typeof size !== "number" || !Number.isInteger(size) || size < 0) throw new Error("Redis answered a set size that is not a count");
          return size;
        });
      })(), "agent history block count");
    },
  };
}

const defaultStore = redisAgentHistoryBlockStore(() => getBoundedRedis(REDIS_COMMAND_TIMEOUT_MS));
let store: AgentHistoryBlockStore = defaultStore;

/** @internal Tests: an in-memory store (the default suite has no Redis). */
export function __setAgentHistoryBlockStoreForTests(next: AgentHistoryBlockStore | null): void {
  store = next ?? defaultStore;
}

function utcDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/** The set of one server's reaches on one UTC day (`YYYY-MM-DD`). */
export function agentHistoryBlockKey(serverId: string, day: string): string {
  return `${KEY_PREFIX}:${serverId}:${day}`;
}

/**
 * Notes one explicit reach behind the window. Fire-and-forget: never awaited
 * on the read path, never throws.
 */
export function noteAgentHistoryBlock(input: { serverId: string; agentId: string; reach: AgentHistoryReach; now?: number }): void {
  const where = "search" in input.reach ? "search" : input.reach.conversationId;
  const key = agentHistoryBlockKey(input.serverId, utcDay(input.now ?? Date.now()));
  void store.add(key, `${input.agentId}:${where}`, KEY_TTL_SECONDS).catch(() => {
    // A lost count only lowers a nudge.
  });
}

/**
 * How many times this server's agents reached behind the window in the last 7
 * UTC days (today included). Null when it can't be read.
 */
export async function countAgentHistoryBlocks7d(serverId: string, now: number = Date.now()): Promise<number | null> {
  const keys = Array.from({ length: WINDOW_DAYS }, (_, back) => agentHistoryBlockKey(serverId, utcDay(now - back * DAY_MS)));
  try {
    const sizes = await store.sizes(keys);
    return sizes.reduce((sum, size) => sum + size, 0);
  } catch {
    return null;
  }
}
