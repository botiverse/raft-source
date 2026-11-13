/**
 * A Raft web page from before the second step at sign-in (#triage:#165).
 * Web 1.21.44 is the first release whose sign-in reads the challenge
 * (secondFactorSignIn.ts in packages/web); an older page that gets one takes
 * it for a sign-in with no session in it and says only "Sign-in failed". A
 * browser can keep running an old page for days (the service worker's kept
 * HTML, docs/frontend/boot-shell.md), so the entry points it calls answer it
 * with what to do instead of a challenge: an older page shows a refusal's
 * `error` as it is.
 *
 * Only a page that names itself (X-Raft-Client-Platform browser, pwa or
 * desktop_app with an X-Raft-Client-Version) is refused: most sign-ins send
 * neither header, and they get the challenge as before.
 */
import { webClientAtLeast } from "../webClientVersion";

export const SECOND_FACTOR_MIN_WEB_VERSION = "1.21.44";
export const WEB_CLIENT_TOO_OLD_CODE = "web_client_too_old";
export const WEB_CLIENT_TOO_OLD_STATUS = 426;

export function isWebClientTooOldForSecondFactor(header: (name: string) => string | undefined): boolean {
  return webClientAtLeast(header, SECOND_FACTOR_MIN_WEB_VERSION) === false;
}

export const webClientTooOldBody = {
  code: WEB_CLIENT_TOO_OLD_CODE,
  error: "This Raft page is out of date and can't finish two-step verification. "
    + "Close every Raft tab and open Raft again (or clear this site's data in your browser), then sign in again.",
  minVersion: SECOND_FACTOR_MIN_WEB_VERSION,
} as const;
