import { sanitizeAppLocalReturnPath } from "@botiverse/raft-shared";

/**
 * After verifying an email, Continue goes to the page the verification link
 * named (#88: the Artifact link signed up from) with a full load, so the app
 * starts again verified; with none, it reloads where it is, as before. The
 * path is checked once more here: it is about to become a navigation.
 */
export function continueAfterVerify(landing: string): void {
  const path = sanitizeAppLocalReturnPath(landing);
  if (path === "/") window.location.reload();
  else window.location.assign(path);
}

/**
 * Verified in the app (#88, InNOut QA r97): verifying flips the account to verified at once, and the app moves
 * on (a new account to its setup) without this page's Continue. So the app goes to the page the link named
 * there and then, in place, as social sign-in's callback does: setup, while it is still to do, shows at that
 * address, and the page opens once it is done. Null for none ("/"): the app stays where it is. Checked here
 * once more: it is about to become a navigation.
 */
export function landingAfterVerify(landing: string | null | undefined): string | null {
  const path = sanitizeAppLocalReturnPath(landing);
  return path === "/" ? null : path;
}

/**
 * The email carries a link, not a code, so the manual box takes the whole link (its `verify=` value) as well as
 * a bare token: someone whose mail app opened the link in another browser can paste it here.
 */
export function verificationTokenFromInput(input: string): string {
  const text = input.trim();
  const query = text.includes("?") ? text.slice(text.indexOf("?") + 1).split("#")[0] : "";
  return new URLSearchParams(query).get("verify")?.trim() || text;
}
