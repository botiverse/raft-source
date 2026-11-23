import { useId } from "react";
import { useIntl } from "react-intl";
import { Button, Separator } from "@botiverse/raft-ui";
import type { MarketplaceMcpListing } from "@botiverse/raft-shared";
import { ConnectedAppLogo } from "../../components/settings/ConnectedAppLogo";
import Banner from "../../components/ui/Banner";
import { appCardSourceParts } from "./appCardSource";
import type { AppViewContext } from "./appView";
import { listingView } from "./appView";
import { CONNECTED_APP_CATEGORY_LABEL_ID } from "./connected-apps/connectedAppCatalog";
import { ConnectedAppDetailModal } from "./connected-apps/ConnectedAppDetailModal";
import { ConnectedAppDetailRow } from "./connected-apps/ConnectedAppDetailRow";
import { ConnectedAppDetailSection } from "./connected-apps/ConnectedAppDetailSection";
import { ConnectedAppUrlLink } from "./connected-apps/ConnectedAppUrlLink";
import { getDomainFromUrl } from "./connected-apps/getDomainFromUrl";

/**
 * A connected service's details from Discover, before this Server has it (or
 * for a viewer who can't open its editor): what Raft's listing says (R40).
 * Its head has the name, who makes it ("By Notion", else "Listed by Raft")
 * and, for the people who add Apps while it isn't added, Add at the top
 * right (R41); the body its description and its Information.
 *
 * No Tools: the service lists its tools only once someone signs in, and the
 * listing carries none. No "Try asking" either: the listing has no examples.
 * Nothing here names an App type.
 */
export function DiscoverServiceDetail({
  listing,
  context,
  adding,
  error,
  onAdd,
  onClose,
}: {
  listing: MarketplaceMcpListing;
  context: AppViewContext;
  /** Its Add is running: the button says Adding… and takes no press. */
  adding: boolean;
  /**
   * What this dialog's own Add failed with, shown over the details. Only its
   * own: an error from anywhere else stays in its place, and this one is not
   * repeated in the page's banner behind the dialog.
   */
  error: string;
  /** Leave it out for a viewer who can't add Apps; it isn't drawn once the listing is added. */
  onAdd?: () => void;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  const titleId = useId();
  const addId = useId();
  const view = listingView(listing, context);
  // Who makes it, without how widely it is used (that is the card's).
  const source = appCardSourceParts({ ...view, reach: null }, null, formatMessage).join(" · ");
  const categoryLabel = formatMessage({ id: CONNECTED_APP_CATEGORY_LABEL_ID[listing.category] ?? "settings.connectedApps.categoryOther" });
  const homepageLabel = getDomainFromUrl(listing.homepageUrl) || listing.homepageUrl;
  const add = onAdd && !listing.installed ? (
    // Named by its label and the App, as the card's: "Add Notion".
    <Button id={addId} aria-labelledby={`${addId} ${titleId}`} type="button" variant="accent" size="md" disabled={adding} onClick={onAdd} data-testid="apps-discover-detail-add">
      {formatMessage({ id: adding ? "apps.detail.adding" : "apps.card.add" })}
    </Button>
  ) : null;
  return (
    <ConnectedAppDetailModal
      labelledBy={titleId}
      onClose={onClose}
      closeLabel={formatMessage({ id: "settings.connectedApps.closeAppDetail" })}
      identity={(
        <div className="flex min-w-0 items-start gap-3">
          <ConnectedAppLogo name={listing.name} logoUrl={listing.logoUrl} seed={listing.templateKey} size="lg" />
          <div className="min-w-0">
            <h2 id={titleId} className="break-words text-headline text-foreground">{listing.name}</h2>
            {source ? <div className="mt-0.5 text-footnote text-foreground-muted" data-testid="apps-discover-detail-source">{source}</div> : null}
          </div>
        </div>
      )}
      actions={add}
      footer={(
        <div>
          <Separator className="mb-4" />
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose} size="lg">{formatMessage({ id: "settings.common.close" })}</Button>
          </div>
        </div>
      )}
    >
      <div className="flex flex-col gap-4" data-testid="apps-discover-service-detail">
        {error ? <Banner intent="warning" density="sm" data-testid="apps-discover-detail-error">{error}</Banner> : null}
        {listing.description ? (
          <ConnectedAppDetailSection title={formatMessage({ id: "apps.detail.about" })}>
            <p className="text-callout text-foreground">{listing.description}</p>
          </ConnectedAppDetailSection>
        ) : null}
        <ConnectedAppDetailSection title={formatMessage({ id: "apps.detail.information" })}>
          <div className="text-callout">
            {listing.publisherName ? (
              <>
                <ConnectedAppDetailRow label={formatMessage({ id: "apps.detail.developer" })}>{listing.publisherName}</ConnectedAppDetailRow>
                <Separator />
              </>
            ) : null}
            <ConnectedAppDetailRow label={formatMessage({ id: "apps.detail.listedBy" })}>{formatMessage({ id: "apps.detail.listedByRaft" })}</ConnectedAppDetailRow>
            <Separator />
            {listing.homepageUrl ? (
              <>
                <ConnectedAppDetailRow label={formatMessage({ id: "apps.detail.website" })}>
                  <ConnectedAppUrlLink url={listing.homepageUrl} label={homepageLabel} />
                </ConnectedAppDetailRow>
                <Separator />
              </>
            ) : null}
            <ConnectedAppDetailRow label={formatMessage({ id: "apps.detail.category" })}>{categoryLabel}</ConnectedAppDetailRow>
          </div>
        </ConnectedAppDetailSection>
      </div>
    </ConnectedAppDetailModal>
  );
}
