import type { MessageId } from "../../i18n/messages";
import { isMarketplaceTabClient } from "../../features/apps/connected-apps/connectedAppMapping";
import type { MarketplaceOAuthClientRecord } from "../../features/apps/connected-apps/oauthClientRecords";

/**
 * The Apps the Apps page recommends at its top, in order, each with the line
 * that says why. An App is named by its client ID (the service id `raft
 * integration list` shows) and must be in the official registry, where a
 * client ID is reviewed (RFC 084 §3): another App can't pass for it by name.
 */
export const RECOMMENDED_APPS: readonly { clientId: string; summaryId: MessageId }[] = [
  { clientId: "stamp", summaryId: "apps.recommended.stamp.summary" },
];

export interface AppRecommendation {
  record: MarketplaceOAuthClientRecord;
  summaryId: MessageId;
}

/**
 * The recommendations to show: each one the Marketplace lists for this
 * Server (as its tab does) and this Server hasn't installed.
 */
export function appRecommendations(
  records: readonly MarketplaceOAuthClientRecord[],
  serverId: string | undefined,
): AppRecommendation[] {
  return RECOMMENDED_APPS.flatMap(({ clientId, summaryId }) => {
    const record = records.find((client) => client.clientId === clientId && client.official === true);
    return record && isMarketplaceTabClient(record, serverId) && !record.installedAt ? [{ record, summaryId }] : [];
  });
}
