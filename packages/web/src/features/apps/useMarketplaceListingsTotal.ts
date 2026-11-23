import { useEffect, useState } from "react";
import api from "../../api/client";
import { MARKETPLACE_LISTINGS_PATH } from "./discoverListings";

/**
 * How many listings the Marketplace has, unfiltered: the Discover segment's
 * count in the Apps toolbar's scope, as Yours counts its Apps.
 * Read again with the Marketplace (`reloadKey`); null until it answers and if
 * it fails (the segment then shows no count rather than a wrong one).
 *
 * Only on the Apps page (`enabled`): Settings' Applications section mounts
 * with every visit to Settings, and its segment goes without a count rather
 * than adding a listings read there. Discover's own read can't
 * stand in: it is filtered, and it runs only while that tab is open.
 */
export function useMarketplaceListingsTotal(reloadKey: number, enabled: boolean): number | null {
  const [total, setTotal] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let ignore = false;
    api.get<{ total?: number }>(MARKETPLACE_LISTINGS_PATH, { params: { sort: "installs" } })
      .then(({ data }) => {
        if (!ignore) setTotal(typeof data?.total === "number" ? data.total : null);
      })
      .catch(() => {
        if (!ignore) setTotal(null);
      });
    return () => {
      ignore = true;
    };
  }, [enabled, reloadKey]);
  return enabled ? total : null;
}
