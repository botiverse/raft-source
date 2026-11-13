/**
 * Where the app goes once a pending deletion is cancelled: Settings › Account
 * of the server in the address, or else of the last server the person was in
 * (the location the app resumes, hooks/useLastLocationResume.ts), or else the
 * app's start; keeping the App's embed params. A full load, so the shell
 * starts over with the session it now has; never the current address, which
 * may be the Delete Account page itself. Signing in again from "/" and
 * cancelling there used to land on "/", which resumed the Delete Account page
 * the deletion was requested from.
 *
 * An App's sign-in (`/login/app?request=<id>`, AppLoginPage) is the exception:
 * the person signed in to confirm that App, so cancelling goes back to its
 * confirmation with the same request. Only that fixed path and a request id
 * of the server's shape (a UUID) are carried; anything else is dropped.
 */
import { withEmbedParams } from "../embed";
import { readLastLocationPath } from "../hooks/useLastLocationResume";

/** The full load after Cancel Deletion; replaceable in tests (jsdom can't navigate). */
export const afterCancelRedirect = {
  assign: (url: string) => window.location.assign(url),
};

const SERVER_SLUG = /^\/s\/([^/?#]+)/;
const APP_LOGIN_PATH = "/login/app";
const APP_LOGIN_REQUEST_ID = /^[0-9a-f-]{36}$/i;

/** The App's pending confirmation to resume after cancelling, or null when this isn't an App's sign-in. */
export function appLoginAfterCancel(pathname: string, search: string): string | null {
  if (pathname.replace(/\/+$/, "") !== APP_LOGIN_PATH) return null;
  const request = new URLSearchParams(search).get("request");
  if (!request || !APP_LOGIN_REQUEST_ID.test(request)) return null;
  return `${APP_LOGIN_PATH}?${withEmbedParams(new URLSearchParams({ request })).toString()}`;
}

export function accountSettingsAfterCancel(pathname: string, lastLocation: string | null = readLastLocationPath()): string {
  const slug = SERVER_SLUG.exec(pathname)?.[1] ?? (lastLocation ? SERVER_SLUG.exec(lastLocation)?.[1] : undefined);
  const query = withEmbedParams(new URLSearchParams()).toString();
  return `${slug ? `/s/${slug}/settings/account` : "/"}${query ? `?${query}` : ""}`;
}
