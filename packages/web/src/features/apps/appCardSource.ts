import type { IntlShape } from "react-intl";
import type { MarketplaceInstallBucket } from "@botiverse/raft-shared";
import type { MessageId } from "../../i18n/messages/en";
import type { AppView } from "./appView";

const REACH_ID: Record<MarketplaceInstallBucket, MessageId> = {
  "10_plus": "apps.card.reachTenPlus",
  "100_plus": "apps.card.reachHundredPlus",
  "1k_plus": "apps.card.reachThousandPlus",
};

/**
 * The source line's parts, in order: where it came from (internal, shared,
 * or its publisher, else Raft's listing), then how widely it is used. Empty
 * when nothing is known.
 */
export function appCardSourceParts(app: AppView, creatorName: string | null | undefined, formatMessage: IntlShape["formatMessage"]): string[] {
  const parts: string[] = [];
  if (app.origin === "internal") {
    parts.push(creatorName
      ? formatMessage({ id: "apps.card.sourceInternalMadeBy" }, { name: creatorName })
      : formatMessage({ id: "apps.card.sourceInternal" }));
  } else {
    if (app.origin === "shared") parts.push(formatMessage({ id: "apps.card.sourceShared" }));
    // "Listed by Raft" stands in for a publisher only: one of Raft's listings
    // whose maker is not known yet. With a publisher, the line names it alone.
    if (app.publisherName) parts.push(formatMessage({ id: "apps.card.sourceBy" }, { publisher: app.publisherName }));
    else if (app.listedByRaft) parts.push(formatMessage({ id: "apps.card.sourceListedByRaft" }));
  }
  if (app.reach) parts.push(formatMessage({ id: REACH_ID[app.reach] }));
  return parts;
}
