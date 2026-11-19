/**
 * The sign-in page's code failed to download where it was to show
 * (SignInPageFrame's SignInChunkFailed). The usual cause is a page from an
 * older release (a tab left open across a deploy, or a page the service
 * worker kept) asking for its own release's sign-in chunk, which the server
 * may no longer have. A signed-out page holds nothing to lose, so it loads
 * again once, in place, onto the current release, instead of showing a chunk
 * error: the same address opens the same page (sign-in, or a private server's
 * link signing in to it; a Public Server page draws itself again, and its
 * Sign in then finds the new chunks). Once per few minutes per tab
 * (sessionStorage), so a sign-in chunk that fails for any other reason shows
 * Try again rather than looping.
 */
export const SIGN_IN_CHUNK_RELOAD_KEY = "raft.signIn.chunkReloadedAt";
const RELOAD_GUARD_MS = 5 * 60_000;

export interface SignInChunkReloadDeps {
  storage: Pick<Storage, "getItem" | "setItem">;
  reload: () => void;
  now: number;
}

let reloading = false;

/** True when the page is loading again (or already is); false once this tab has reloaded for it lately. */
export function reloadOntoSignInOnce(given?: SignInChunkReloadDeps): boolean {
  if (reloading) return true;
  let deps: SignInChunkReloadDeps;
  try {
    deps = given ?? { storage: window.sessionStorage, reload: () => window.location.reload(), now: Date.now() };
    const last = Number(deps.storage.getItem(SIGN_IN_CHUNK_RELOAD_KEY));
    if (last && deps.now - last < RELOAD_GUARD_MS) return false;
    deps.storage.setItem(SIGN_IN_CHUNK_RELOAD_KEY, String(deps.now));
  } catch {
    // No sessionStorage, no guard: Try again instead of a reload that could repeat.
    return false;
  }
  reloading = true;
  deps.reload();
  return true;
}

/** Tests: a fresh page. */
export function __resetSignInChunkReloadForTest(): void {
  reloading = false;
}
