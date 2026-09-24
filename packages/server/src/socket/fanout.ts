import type { Server } from "socket.io";
import { getRedisPub, isRedisAvailable } from "../redis.js";

/** Upper bound on one cross-replica acknowledged emit. The adapter's own
 * request timeout only starts after its `serverCount()` round trip, which
 * never resolves while the publisher is reconnecting. */
export const FANOUT_TIMEOUT_MS = 10_000;

/** Acknowledged emit to every other replica through the Redis adapter.
 * Resolves `[]` on single-node deployments. Fails fast when the publisher is
 * not connected and never waits longer than `FANOUT_TIMEOUT_MS`: callers run
 * after a DB commit and must surface a retryable error, not hang the request. */
export async function fanoutWithAck<T>(io: Server, event: string, payload: unknown): Promise<T[]> {
  if (!isRedisAvailable()) return [];
  const status = getRedisPub().status;
  if (status !== "ready") {
    throw new Error(`${event} fanout unavailable: Redis publisher is ${status}`);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${event} fanout timed out after ${FANOUT_TIMEOUT_MS}ms`)), FANOUT_TIMEOUT_MS);
  });
  try {
    return await Promise.race([io.serverSideEmitWithAck(event, payload) as Promise<T[]>, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
