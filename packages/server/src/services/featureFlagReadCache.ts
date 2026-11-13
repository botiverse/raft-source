/**
 * A short per-process cache of server-scoped flag answers, for hot read paths
 * that ask the same flag for the same server on every request (Activity's
 * object rows: the inbox, mark all read, the badge; objectActivity.ts), so
 * they don't add flag queries to each request, flag off or on.
 *
 * An answer lives FLAG_READ_CACHE_TTL_MS. This replica's change notifier
 * (featureFlagChangeNotifier.ts) forgets a flag's answers as soon as it sees
 * the flag change, from FFA's cursor, a Server Labs write here or a peer
 * replica's, so the TTL only bounds a change it misses. A failed read is not
 * cached. Only for reads that may be that stale: a write deciding by a flag
 * reads it in its own transaction (platform/flags appEnabledOn).
 *
 * Off under NODE_ENV=test (tests switch flags by writing rules directly, with
 * no notifier running); its own test turns it on.
 */
export const FLAG_READ_CACHE_TTL_MS = 30_000;
/** Past this many answers the cache starts over (bounds memory; a miss is only a query). */
const MAX_ANSWERS = 50_000;

let ttlMs = process.env.NODE_ENV === "test" ? 0 : FLAG_READ_CACHE_TTL_MS;
const answers = new Map<string, Map<string, { enabled: boolean; expiresAt: number }>>();
let size = 0;
/** Moves on every forget: a read that started before one doesn't store its (maybe older) answers. */
let generation = 0;

/**
 * `flag` for each of `serverIds`, in input order: cached answers, and one
 * `readMissing` of the rest (servers in input order, deduplicated).
 */
export async function cachedServerFlagAnswers(
  serverIds: readonly string[],
  flag: string,
  readMissing: (serverIds: string[]) => Promise<boolean[]>,
): Promise<boolean[]> {
  if (ttlMs <= 0) return readMissing([...serverIds]);
  const now = Date.now();
  const known = answers.get(flag);
  const missing = [...new Set(serverIds.filter((serverId) => {
    const answer = known?.get(serverId);
    return !answer || answer.expiresAt <= now;
  }))];
  const fresh = new Map<string, boolean>();
  if (missing.length > 0) {
    const startedAt = generation;
    const read = await readMissing(missing);
    missing.forEach((serverId, index) => fresh.set(serverId, read[index] === true));
    if (generation === startedAt) store(flag, fresh);
  }
  return serverIds.map((serverId) => fresh.get(serverId) ?? known?.get(serverId)?.enabled === true);
}

function store(flag: string, fresh: ReadonlyMap<string, boolean>): void {
  if (size + fresh.size > MAX_ANSWERS) clearFlagReadCache();
  const byServer = answers.get(flag) ?? new Map<string, { enabled: boolean; expiresAt: number }>();
  answers.set(flag, byServer);
  const expiresAt = Date.now() + ttlMs;
  for (const [serverId, enabled] of fresh) {
    if (!byServer.has(serverId)) size++;
    byServer.set(serverId, { enabled, expiresAt });
  }
}

/** These flags may have changed: their next reads go to the database. */
export function forgetCachedFlags(flags: Iterable<string>): void {
  generation++;
  for (const flag of flags) {
    size -= answers.get(flag)?.size ?? 0;
    answers.delete(flag);
  }
}

export function clearFlagReadCache(): void {
  generation++;
  answers.clear();
  size = 0;
}

/** Tests: the TTL (0 = off, as under NODE_ENV=test); also empties the cache. */
export function __setFlagReadCacheTtlForTests(ms: number): void {
  ttlMs = ms;
  clearFlagReadCache();
}
