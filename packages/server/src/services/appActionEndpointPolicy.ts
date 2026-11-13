// Interactive link cards (RFC 076 §4). The rule: every action endpoint in
// force on a published App has been reviewed by a marketplace reviewer.
// Removing one never waits. Publish approval enforces it in
// public.marketplace_decide_publish_review: an endpoint set while the App was
// unpublished goes back to review there.

/** Published to the marketplace: listing edits there are reviewed by Raft. */
export function marketplaceReviewApplies(client: { appType: string; publishStatus: string }): boolean {
  return client.appType === "third_party_global"
    && (client.publishStatus === "published" || client.publishStatus === "unpublish_requested");
}

/**
 * Where the action endpoint stands after a registration. For a published App,
 * adding or changing it waits for review while the approved one stays in
 * force; removing it applies at once, as does any change for an unpublished
 * App. An origin change drops both, because an action endpoint must live on
 * the registered origin.
 */
export function nextActionEndpointState(input: {
  origin: string;
  requested: string | null;
  live: string | null;
  pending: string | null;
  reviewed: boolean;
}): { live: string | null; pending: string | null; requestedReview: boolean } {
  const onOrigin = (value: string | null) => (value && new URL(value).origin === input.origin ? value : null);
  const live = onOrigin(input.live);
  const pending = onOrigin(input.pending);
  if (input.requested === null) return { live: null, pending: null, requestedReview: false };
  if (input.requested === live) return { live, pending: null, requestedReview: false };
  if (!input.reviewed) return { live: input.requested, pending: null, requestedReview: false };
  return { live, pending: input.requested, requestedReview: input.requested !== pending };
}
