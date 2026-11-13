// Marketplace install counts are shown as buckets only, never exact
// (yezizp d7080dad): an App card's install badge and the Marketplace listing
// (`installBucket`) both bucket here, and the web labels the bucket.

/** In ascending order: a later bucket ranks above an earlier one. */
export const MARKETPLACE_INSTALL_BUCKETS = ["10_plus", "100_plus", "1k_plus"] as const;
export type MarketplaceInstallBucket = (typeof MARKETPLACE_INSTALL_BUCKETS)[number];

const BUCKET_MIN_INSTALLS: Record<MarketplaceInstallBucket, number> = {
  "10_plus": 10,
  "100_plus": 100,
  "1k_plus": 1000,
};

export const MARKETPLACE_INSTALL_BUCKET_LABELS: Record<MarketplaceInstallBucket, string> = {
  "10_plus": "10+",
  "100_plus": "100+",
  "1k_plus": "1k+",
};

/** The bucket an install count falls in; null below the first, as small counts are not shown. */
export function marketplaceInstallBucket(installCount: number): MarketplaceInstallBucket | null {
  if (!Number.isInteger(installCount) || installCount < 0) {
    throw new Error("installCount must be a non-negative integer");
  }
  for (let index = MARKETPLACE_INSTALL_BUCKETS.length - 1; index >= 0; index -= 1) {
    const bucket = MARKETPLACE_INSTALL_BUCKETS[index]!;
    if (installCount >= BUCKET_MIN_INSTALLS[bucket]) return bucket;
  }
  return null;
}

/** An App card's install badge (`marketplaceInstallBadge` on `GET /api/integrations/marketplace`). */
export type MarketplaceInstallBadge =
  | { kind: "new" }
  | { kind: "bucket"; bucket: MarketplaceInstallBucket }
  | { kind: "none" };
