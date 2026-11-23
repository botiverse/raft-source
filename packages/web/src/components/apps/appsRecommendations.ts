import { isMarketplaceTabClient } from "../../features/apps/connected-apps/connectedAppMapping";
import type { MarketplaceOAuthClientRecord } from "../../features/apps/connected-apps/oauthClientRecords";

/**
 * The Apps Discover recommends at its top, in order, with no line that says
 * why (R26). An App is named by its client ID (the service id `raft
 * integration list` shows) and must be in the official registry, where a
 * client ID is reviewed (RFC 084 §3): another App can't pass for it by name.
 */
export const RECOMMENDED_APPS: readonly { clientId: string }[] = [
  { clientId: "stamp" },
];

export interface AppRecommendation {
  record: MarketplaceOAuthClientRecord;
}

/**
 * The recommendations to show: each one the Marketplace lists for this
 * Server (as its tab does), this Server hasn't installed, and no person on
 * this Server has uninstalled (`uninstalledHereAt`): a Server that removed
 * Stamp said no, and is not asked again. The Marketplace still lists it. An
 * older server sends no `uninstalledHereAt`, which reads as never uninstalled.
 */
export function appRecommendations(
  records: readonly MarketplaceOAuthClientRecord[],
  serverId: string | undefined,
): AppRecommendation[] {
  return RECOMMENDED_APPS.flatMap(({ clientId }) => {
    const record = records.find((client) => client.clientId === clientId && client.official === true);
    return record && isMarketplaceTabClient(record, serverId) && !record.installedAt && !record.uninstalledHereAt ? [{ record }] : [];
  });
}
