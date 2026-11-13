/**
 * Cross-replica claim on one install's Slack mention-usergroup reconcile.
 *
 * Every replica runs the Slack Bridge lifecycle; only the claim holder may
 * write Slack usergroups. The holder renews while it works (owner-checked, so
 * a renewal never extends a claim another replica has taken over). Before
 * each write the holder calls `held()`, which refuses when a renewal was
 * refused, when the last confirmed window has elapsed (a process pause or a
 * hung renewal), or when the store no longer names this holder as owner.
 * The holder then stops issuing writes. The claim is never deleted: it
 * lapses by TTL, which also spaces out back-to-back reconciles.
 */

export interface SlackMentionReconcileClaim {
  held(): Promise<boolean>;
  /** Stops renewing; the claim lapses by TTL. */
  end(): void;
}

export interface SlackMentionReconcileClaimStore {
  /** Atomically create `key` = `token` with a TTL unless it exists. */
  acquire(key: string, token: string, ttlMs: number): Promise<boolean>;
  /** Extend `key`'s TTL only while it still holds `token`. */
  renew(key: string, token: string, ttlMs: number): Promise<boolean>;
  /** Current owner token of `key`, or null when it has lapsed. */
  owner(key: string): Promise<string | null>;
}

export interface SlackMentionReconcileClaimTimers {
  /** Monotonic milliseconds. */
  now(): number;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultTimers: SlackMentionReconcileClaimTimers = {
  now: () => performance.now(),
  setInterval: (callback, ms) => {
    const handle = setInterval(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Settles with `undefined` when `promise` does not settle within `ms`. */
function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  timers: SlackMentionReconcileClaimTimers,
): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    const timer = timers.setTimeout(() => resolve(undefined), ms);
    promise.then((value) => {
      timers.clearTimeout(timer);
      resolve(value);
    }, (error: unknown) => {
      timers.clearTimeout(timer);
      reject(error);
    });
  });
}

export async function claimSlackMentionReconcile(input: {
  store: SlackMentionReconcileClaimStore;
  key: string;
  token: string;
  ttlMs: number;
  renewEveryMs: number;
  timers?: SlackMentionReconcileClaimTimers;
  onError?(error: unknown): void;
}): Promise<SlackMentionReconcileClaim | null> {
  const timers = input.timers ?? defaultTimers;
  const acquiredAt = timers.now();
  if (!(await input.store.acquire(input.key, input.token, input.ttlMs))) return null;
  // A window counts from when its request was sent: Redis may have applied
  // it at any point before the reply arrived.
  let validUntil = acquiredAt + input.ttlMs;
  let lost = false;
  let ended = false;
  let renewing = false;
  const interval = timers.setInterval(() => {
    if (ended || lost || renewing) return;
    renewing = true;
    const sentAt = timers.now();
    // A renewal that hangs past one interval is abandoned (its late reply is
    // ignored) so the next one can be sent; `validUntil` covers the gap.
    withDeadline(
      input.store.renew(input.key, input.token, input.ttlMs),
      input.renewEveryMs,
      timers,
    ).then((renewed) => {
      if (renewed === undefined) return;
      if (renewed) validUntil = Math.max(validUntil, sentAt + input.ttlMs);
      else lost = true;
    }, (error: unknown) => {
      // An unknown renewal outcome is not a renewal; `validUntil` decides.
      input.onError?.(error);
    }).finally(() => {
      renewing = false;
    });
  }, input.renewEveryMs);
  const locallyValid = () => !ended && !lost && timers.now() < validUntil;
  return {
    held: async () => {
      if (!locallyValid()) return false;
      try {
        const owner = await withDeadline(input.store.owner(input.key), input.renewEveryMs, timers);
        if (owner !== input.token) {
          if (owner !== undefined) lost = true;
          return false;
        }
      } catch (error) {
        input.onError?.(error);
        return false;
      }
      // The owner read may itself have outlived the window.
      return locallyValid();
    },
    end: () => {
      if (ended) return;
      ended = true;
      timers.clearInterval(interval);
    },
  };
}

const RENEW_IF_OWNER = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return 0
`;

export function redisSlackMentionReconcileClaimStore(redis: {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, px: "PX", ttlMs: number, nx: "NX"): Promise<string | null>;
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
}): SlackMentionReconcileClaimStore {
  return {
    acquire: async (key, token, ttlMs) => (await redis.set(key, token, "PX", ttlMs, "NX")) === "OK",
    renew: async (key, token, ttlMs) => Number(await redis.eval(RENEW_IF_OWNER, 1, key, token, ttlMs)) === 1,
    owner: (key) => redis.get(key),
  };
}


/** Explicit owner-checked release for a completed workspace write sequence.
 * Lifecycle callers can keep the default TTL spacing by using end() alone. */
export async function releaseSlackMentionReconcileClaim(redis: {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
}, key: string, token: string): Promise<boolean> {
  return Number(await redis.eval(`
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`, 1, key, token)) === 1;
}
