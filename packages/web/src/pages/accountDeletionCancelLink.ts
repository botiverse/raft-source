/**
 * Reading the emailed cancel link, `/?cancel_account_deletion=<token>`
 * (AccountDeletionCancelLinkPage), before anything renders: App's URL parse
 * calls this once. The token leaves the address bar and history at once
 * (history.replaceState), and the document says `Referrer-Policy:
 * no-referrer` (a meta tag) while the page is up, so nothing the page loads
 * or links to can carry the address it was opened with. The web hosts send
 * that header for every path already (public/_headers, vercel.json,
 * nginx.conf); the tag keeps it true wherever the page is served from.
 *
 * Idempotent: the first call reads and scrubs; later calls (React may run
 * the parse twice in development) answer the same.
 */
import { ACCOUNT_DELETION_CANCEL_PARAM, parseAccountDeletionCancelToken } from "../features/settings/account/accountDeletionApi";
import type { AccountDeletionCancelToken } from "../features/settings/account/accountDeletionApi";

const META_ID = "account-deletion-cancel-link-referrer";

let taken: { token: AccountDeletionCancelToken | null } | null | undefined;

/** The link's token (null when malformed), or null when the address has no cancel link. */
export function takeAccountDeletionCancelLink(): { token: AccountDeletionCancelToken | null } | null {
  if (taken !== undefined) return taken;
  const url = new URL(window.location.href);
  if (!url.searchParams.has(ACCOUNT_DELETION_CANCEL_PARAM)) {
    taken = null;
    return taken;
  }
  taken = { token: parseAccountDeletionCancelToken(url.searchParams.get(ACCOUNT_DELETION_CANCEL_PARAM)) };
  if (!document.getElementById(META_ID)) {
    const meta = document.createElement("meta");
    meta.id = META_ID;
    meta.name = "referrer";
    meta.content = "no-referrer";
    document.head.prepend(meta);
  }
  url.searchParams.delete(ACCOUNT_DELETION_CANCEL_PARAM);
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  return taken;
}

/** The page is left: drop the tag (the site-wide header still applies). */
export function releaseAccountDeletionCancelLinkReferrer(): void {
  document.getElementById(META_ID)?.remove();
}

export function __resetAccountDeletionCancelLinkForTests(): void {
  taken = undefined;
  releaseAccountDeletionCancelLinkReferrer();
}
