/**
 * A readable access token for `sub` in localStorage, as a signed-in page has:
 * what an Artifact opener holds for the reader's next opening is used only
 * when the reader is known (artifactReaderScope).
 */
export function accessTokenFor(sub: string): string {
  return `h.${btoa(JSON.stringify({ sub, type: "access" })).replace(/=+$/, "")}.s`;
}

export function signInReaderForTests(sub = "reader-1"): void {
  localStorage.setItem("slock_access_token", accessTokenFor(sub));
}

export function signOutReaderForTests(): void {
  localStorage.removeItem("slock_access_token");
}
