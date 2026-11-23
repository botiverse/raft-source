import { useCallback, useId, useMemo } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { AppCard } from "../../features/apps/AppCard";
import { raftAppView } from "../../features/apps/appView";
import type { AppView, AppViewContext } from "../../features/apps/appView";
import { CONNECTED_APPS_GRID_CLASS } from "../../features/apps/connected-apps/connectedAppCatalog";
import type { MarketplaceOAuthClientRecord } from "../../features/apps/connected-apps/oauthClientRecords";
import { AppsSectionHeading } from "./AppsListParts";
import type { AppRecommendation } from "./appsRecommendations";

/** One recommended App as Discover's card: Add, since this Server hasn't added it. */
function RecommendedAppCard({ record, view, onOpen, onAdd, addDisabled }: {
  record: MarketplaceOAuthClientRecord;
  view: AppView;
  onOpen: (record: MarketplaceOAuthClientRecord) => void;
  onAdd: (record: MarketplaceOAuthClientRecord) => void;
  addDisabled: boolean;
}) {
  const handleOpen = useCallback(() => onOpen(record), [onOpen, record]);
  const handleAdd = useCallback(() => onAdd(record), [onAdd, record]);
  return <AppCard app={view} variant="discover" onOpen={handleOpen} onAdd={handleAdd} addDisabled={addDisabled} testId={`apps-recommended-${record.clientId}`} />;
}

/**
 * "Recommended for {server}" at the top of Discover (R12, R26): each
 * recommended App this Server hasn't added, as the same card as the list
 * under it, with no line saying why. The card opens the App's details; its
 * Add opens the install confirmation, and waits while a card's Add in the
 * list runs (`addDisabled`). Only the people who add Apps see
 * Discover, so only they see this. The list (`children`) follows a section
 * gap below under its own "All apps" heading (`AppsSectionHeading`, an `h3`
 * under the page title's `h2`); with nothing to recommend, it is alone.
 */
export function AppsRecommendedSection({ recommendations, context, serverName, onOpen, onAdd, addDisabled = false, children }: {
  recommendations: AppRecommendation[];
  context: AppViewContext;
  serverName: string;
  onOpen: (record: MarketplaceOAuthClientRecord) => void;
  onAdd: (record: MarketplaceOAuthClientRecord) => void;
  /** A connected service's Add is running below: this Add waits too. */
  addDisabled?: boolean;
  children: ReactNode;
}) {
  const { formatMessage } = useIntl();
  const headingId = useId();
  const allHeadingId = useId();
  const cards = useMemo(
    () => recommendations.map(({ record }) => ({ record, view: raftAppView(record, context) })),
    [context, recommendations],
  );
  if (cards.length === 0) return children;
  return (
    <div className="stack-y-4">
      <section className="stack-y-2" aria-labelledby={headingId} data-testid="apps-recommended">
        <AppsSectionHeading id={headingId}>{formatMessage({ id: "apps.recommended.title" }, { server: serverName })}</AppsSectionHeading>
        <div className={CONNECTED_APPS_GRID_CLASS}>
          {cards.map(({ record, view }) => (
            <RecommendedAppCard key={record.id} record={record} view={view} onOpen={onOpen} onAdd={onAdd} addDisabled={addDisabled} />
          ))}
        </div>
      </section>
      <section className="stack-y-2" aria-labelledby={allHeadingId}>
        <AppsSectionHeading id={allHeadingId}>{formatMessage({ id: "apps.discover.allHeading" })}</AppsSectionHeading>
        {children}
      </section>
    </div>
  );
}
