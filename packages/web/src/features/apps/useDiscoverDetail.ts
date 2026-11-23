import { useCallback, useRef, useState } from "react";
import type { MarketplaceMcpListing, McpAppListItem } from "@botiverse/raft-shared";
import type { ConnectedAppListing } from "./connected-apps/connectedAppTypes";
import type { MarketplaceOAuthClientRecord } from "./connected-apps/oauthClientRecords";
import type { DiscoverListing } from "./discoverListings";

/** What a Raft App's listing opens as: its details, or the install confirmation a card's Add opens. */
export type ListingDialogKind = "detail" | "confirm";

/**
 * A connected service's Add: running, or failed with the server's words.
 * `from` is where it was pressed, which is where its failure shows: under
 * the card's Add, or in the details' banner.
 */
type ServiceAdd =
  | { status: "adding"; listingId: string; from: "card" | "detail" }
  | { status: "failed"; listingId: string; from: "card" | "detail"; message: string };

/**
 * What Discover's cards open and add (R41). A card opens the App's details:
 *
 * - a Raft App: its Marketplace detail (as the Marketplace's card did), with
 *   Add at the top right for the people who add Apps while this Server
 *   hasn't added it, and its Danger zone once it has. Its publisher's review
 *   of its agent text is there too, so an added App opens it as well;
 * - a connected service this Server has: its editor, for the people who
 *   manage Apps (as its Yours card); otherwise, and for anyone else, what
 *   Raft's listing says (`DiscoverServiceDetail`), with Add while it isn't
 *   added.
 *
 * The card's own Add adds it without the details: a connected service is
 * made from Raft's listing in one step (its editor then opens on its
 * accounts, where its account is picked); a Raft App opens its install
 * confirmation (`MarketplaceInstallConfirm`: what installing approves, its
 * bot, then Add), the set the details' Add sends (`openListing(…, "confirm")`).
 * Recommended cards are Raft Apps by record (`openRecord`, `addRecord`).
 *
 * One connected service is added at a time (`addingId`): its card's Add and
 * its details' Add say Adding…, and every Add waits. A failure shows where
 * its Add was pressed (`cardError` under the card, `detailError` in the
 * details), never in the page's banner.
 */
export function useDiscoverDetail({
  canManage,
  serviceItems,
  toListing,
  openListing,
  openService,
  addService,
}: {
  canManage: boolean;
  /** This Server's connected services (`GET /mcp/apps`), by the listing's template. */
  serviceItems: readonly McpAppListItem[];
  toListing: (record: MarketplaceOAuthClientRecord) => ConnectedAppListing;
  openListing: (listing: ConnectedAppListing, kind: ListingDialogKind) => void;
  /** A connected service's editor (App managers only). */
  openService: (app: McpAppListItem) => void;
  /** Makes the connected service from the listing: null once it is made, else what failed. */
  addService: (listing: MarketplaceMcpListing) => Promise<string | null>;
}) {
  // The connected service whose listing is open.
  const [service, setService] = useState<MarketplaceMcpListing | null>(null);
  const [serviceAdd, setServiceAdd] = useState<ServiceAdd | null>(null);
  // The add in flight, read at the press: a second press before the render waits too.
  const addingRef = useRef(false);

  const openRecord = useCallback((record: MarketplaceOAuthClientRecord) => {
    openListing(toListing(record), "detail");
  }, [openListing, toListing]);
  const addRecord = useCallback((record: MarketplaceOAuthClientRecord) => {
    openListing(toListing(record), "confirm");
  }, [openListing, toListing]);

  const open = useCallback((listing: DiscoverListing) => {
    if (listing.kind === "app") {
      openRecord(listing.app);
      return;
    }
    const added = listing.installed && canManage ? serviceItems.find((app) => app.source.templateKey === listing.templateKey) : undefined;
    if (added) openService(added);
    else setService(listing);
  }, [canManage, openRecord, openService, serviceItems]);

  // Adds the service; true once it is made.
  const runAdd = useCallback(async (listing: MarketplaceMcpListing, from: "card" | "detail") => {
    if (addingRef.current) return false;
    addingRef.current = true;
    setServiceAdd({ status: "adding", listingId: listing.id, from });
    try {
      const message = await addService(listing);
      setServiceAdd(message === null ? null : { status: "failed", listingId: listing.id, from, message });
      return message === null;
    } finally {
      addingRef.current = false;
    }
  }, [addService]);

  const add = useCallback((listing: DiscoverListing) => {
    if (listing.kind === "app") {
      addRecord(listing.app);
      return;
    }
    void runAdd(listing, "card");
  }, [addRecord, runAdd]);

  // The open listing's Add: it closes once the service is made (its editor opens); a failure stays, with its error.
  const addOpenService = useCallback(async () => {
    if (!service) return;
    if (await runAdd(service, "detail")) setService(null);
  }, [runAdd, service]);
  const closeService = useCallback(() => {
    setService(null);
    // Its failure goes with it; one running keeps its Adding….
    setServiceAdd((current) => (current?.status === "failed" && current.from === "detail" ? null : current));
  }, []);

  const addingId = serviceAdd?.status === "adding" ? serviceAdd.listingId : null;
  const cardError = serviceAdd?.status === "failed" && serviceAdd.from === "card" ? { listingId: serviceAdd.listingId, message: serviceAdd.message } : null;
  const detailError = serviceAdd?.status === "failed" && serviceAdd.from === "detail" && serviceAdd.listingId === service?.id ? serviceAdd.message : "";

  return { open, add, openRecord, addRecord, service, addOpenService, closeService, addingId, cardError, detailError };
}
