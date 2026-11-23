/**
 * A loopback device login (`/login/device?request=<id>`, RFC 8252) ends by
 * sending the browser back to the program that asked, on this computer:
 * approve and deny answer `redirectUrl`, the program's own
 * `http://127.0.0.1:<port>/callback` (or `[::1]`). Only such an address is
 * followed: the server already allows no other, and the page never sends
 * the browser anywhere else from an answer.
 */
const LOOPBACK_CALLBACK = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}\/callback(?:\?|$)/;

export function isLoopbackCallbackUrl(url: unknown): url is string {
  return typeof url === "string" && LOOPBACK_CALLBACK.test(url);
}

/** Leaving for the program's loopback listener; replaceable in tests. */
export const deviceLoginRedirect = {
  assign: (url: string) => window.location.assign(url),
};
