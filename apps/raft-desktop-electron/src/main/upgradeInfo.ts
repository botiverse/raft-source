// Cache only successful display metadata. The real upgrade action must still
// fetch its own fresh version; an offline/null result must remain retryable.
export function createUpgradeInfoReader(
  fetchLatest: () => Promise<string | null>,
  now: () => number = Date.now,
  ttlMs = 5 * 60 * 1000,
): () => Promise<{ latestVersion: string | null }> {
  let cached: { latestVersion: string; expiresAt: number } | null = null;
  let pending: Promise<{ latestVersion: string | null }> | null = null;
  return () => {
    if (cached && now() < cached.expiresAt) {
      return Promise.resolve({ latestVersion: cached.latestVersion });
    }
    if (pending) return pending;
    const result = Promise.resolve().then(fetchLatest).then((latestVersion) => {
      if (latestVersion) cached = { latestVersion, expiresAt: now() + ttlMs };
      return { latestVersion };
    }).catch(() => ({ latestVersion: null }));
    pending = result;
    void result.then(() => { if (pending === result) pending = null; });
    return result;
  };
}
