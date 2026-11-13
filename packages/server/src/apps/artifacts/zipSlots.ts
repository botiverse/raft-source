// How many `download.zip` archives this process builds at once, in two
// pools of their own: the signed-out route's (publicRoutes.ts, `public`) and
// the signed-in web route's (webViewer.ts, `web`), so visitors of a public
// Artifact never keep members from their own downloads, nor the reverse.
// The per-address limit sees only the CDN's edge addresses, so many
// visitors behind one could each start a 100 MB archive; this caps them for
// the whole process (Tenny, before production). Members are limited per
// user, but a server's people could still start many at once: the same cap.
// Over it the route answers 429 BUSY with Retry-After. A slot is taken once the archive is about to be
// built and given back when its stream closes: finished, failed, or the
// client gone mid-download. A slot held past PUBLIC_ZIP_MAX_OPEN_MS (a read
// that never returns, a client reading too slowly, a stream nobody consumed)
// is overdue: the route ends that archive, so four stuck downloads can't keep
// every other one refused until a restart (Tenny, #11926).

/** Which route's archives: each pool has its own cap and its own count. */
export type ZipPool = "public" | "web";

/** Archives built at once in a pool when its variable (ARTIFACTS_PUBLIC_ZIP_CONCURRENCY, ARTIFACTS_WEB_ZIP_CONCURRENCY) is unset or not a number. */
export const DEFAULT_PUBLIC_ZIP_CONCURRENCY = 4;
/** The most either variable may allow (each archive holds a file in memory at a time). */
export const MAX_PUBLIC_ZIP_CONCURRENCY = 32;

/** The configured cap: the variable as an integer within 1..MAX, else the default. Read at every take, so a change applies without a restart in tests. */
export function publicZipConcurrency(raw = process.env.ARTIFACTS_PUBLIC_ZIP_CONCURRENCY): number {
  const value = Number(raw?.trim());
  if (!raw?.trim() || !Number.isFinite(value)) return DEFAULT_PUBLIC_ZIP_CONCURRENCY;
  return Math.min(MAX_PUBLIC_ZIP_CONCURRENCY, Math.max(1, Math.floor(value)));
}

/** How long one archive may hold its slot: 100 MB at about 170 KB/s. */
export const PUBLIC_ZIP_MAX_OPEN_MS = 10 * 60_000;
let maxOpenMs = PUBLIC_ZIP_MAX_OPEN_MS;

/** Tests: a shorter limit (null: the real one). */
export function __setPublicZipMaxOpenMsForTests(ms: number | null): void {
  maxOpenMs = ms ?? PUBLIC_ZIP_MAX_OPEN_MS;
}

/** The web pool's cap, ARTIFACTS_WEB_ZIP_CONCURRENCY read as the public one is. */
export function webZipConcurrency(raw = process.env.ARTIFACTS_WEB_ZIP_CONCURRENCY): number {
  return publicZipConcurrency(raw);
}

const inFlight: Record<ZipPool, number> = { public: 0, web: 0 };
const capOf: Record<ZipPool, () => number> = { public: () => publicZipConcurrency(), web: () => webZipConcurrency() };

/** Archives being built now in a pool (tests). */
export const zipsInFlight = (pool: ZipPool): number => inFlight[pool];
export const publicZipsInFlight = (): number => zipsInFlight("public");

/** takeZipSlot in the signed-out route's pool. */
export function takePublicZipSlot(overdue: () => void): { release(): void } | null {
  return takeZipSlot("public", overdue);
}

/**
 * A slot for one archive in `pool`, or null when its cap is reached.
 * `release` gives it back, once however often it is called. `overdue` runs
 * if it is still held after the limit; the slot is given back right after it.
 */
export function takeZipSlot(pool: ZipPool, overdue: () => void): { release(): void } | null {
  if (inFlight[pool] >= capOf[pool]()) return null;
  inFlight[pool] += 1;
  let held = true;
  const release = () => {
    if (!held) return;
    held = false;
    clearTimeout(backstop);
    inFlight[pool] -= 1;
  };
  const backstop = setTimeout(() => {
    if (!held) return;
    try {
      overdue();
    } finally {
      release();
    }
  }, maxOpenMs);
  // Never what keeps the process alive.
  backstop.unref();
  return { release };
}
