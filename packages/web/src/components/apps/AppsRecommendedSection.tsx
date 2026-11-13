import { useCallback, useId, useMemo } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { connectedAppsCollectionClassName } from "../../features/apps/connected-apps/connectedAppsViewMode";
import { mapClientToMarketplaceApp } from "../../features/apps/connected-apps/connectedAppMapping";
import type { ConnectedAppListing, ConnectedAppsViewMode } from "../../features/apps/connected-apps/connectedAppTypes";
import type { MarketplaceOAuthClientRecord } from "../../features/apps/connected-apps/oauthClientRecords";
import { AppsSectionHeading } from "./AppsListParts";
import { MarketplaceListingRow } from "./MarketplaceListingsTab";
import type { MarketplaceCardListing } from "./MarketplaceListingsTab";
import type { AppRecommendation } from "./appsRecommendations";

type RecommendedListing = Extract<MarketplaceCardListing, { kind: "app" }>;

/** A recommended App's record as the Marketplace card draws it (not installed here, by definition). */
function recommendedListing(record: MarketplaceOAuthClientRecord): RecommendedListing {
  return {
    kind: "app",
    name: record.name,
    description: record.description,
    logoUrl: record.logoUrl,
    category: record.category,
    installBucket: null,
    publishedAt: null,
    installed: false,
    publisherName: record.publisherServerName ?? record.publisherName,
    app: record,
  };
}

/**
 * "Recommended for you" at the top of the Apps page's Installed tab: each recommended App
 * this Server hasn't installed, as its Marketplace card with the line that
 * says why. The card does what the Marketplace's does: it opens the App's
 * detail, where owners and admins install it; members see Available. The
 * installed list (`children`, which then carries its own Installed heading)
 * follows it a section gap below; with nothing to recommend, it is alone.
 */
export function AppsRecommendedSection({ recommendations, viewMode, canManage, onOpenApp, children }: {
  recommendations: AppRecommendation[];
  viewMode: ConnectedAppsViewMode;
  canManage: boolean;
  onOpenApp: (listing: ConnectedAppListing) => void;
  children: ReactNode;
}) {
  const { formatMessage } = useIntl();
  const headingId = useId();
  const cards = useMemo(
    () => recommendations.map(({ record, summaryId }) => ({ listing: recommendedListing(record), summaryId })),
    [recommendations],
  );
  const handleOpen = useCallback((listing: RecommendedListing) => {
    onOpenApp(mapClientToMarketplaceApp(listing.app, formatMessage));
  }, [formatMessage, onOpenApp]);
  if (cards.length === 0) return children;
  return (
    <div className="stack-y-4">
      <section className="stack-y-2" aria-labelledby={headingId} data-testid="apps-recommended">
        <AppsSectionHeading id={headingId}>{formatMessage({ id: "apps.recommended.title" })}</AppsSectionHeading>
        <div className={viewMode === "grid" ? connectedAppsCollectionClassName("grid") : "flex flex-col"} data-view={viewMode}>
          {cards.map(({ listing, summaryId }) => (
            <MarketplaceListingRow
              key={listing.app.id}
              listing={listing}
              testId={`apps-recommended-${listing.app.clientId}`}
              viewMode={viewMode}
              canManage={canManage}
              installing={false}
              botHint={null}
              summary={formatMessage({ id: summaryId })}
              onOpen={handleOpen}
            />
          ))}
        </div>
      </section>
      {children}
    </div>
  );
}
