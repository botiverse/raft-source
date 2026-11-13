import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { isServerSelectionRequested } from "../utils/serverSelectionRequest";

const STORAGE_KEY = "slock:last-location";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Capture the entry URL before React Router or any other code rewrites it.
// A cold PWA resume always lands on `start_url` ("/"); if that's where we
// started, we want to redirect back to the last deep location.
const entryPathname = typeof window !== "undefined" ? window.location.pathname : "";
const entrySearch = typeof window !== "undefined" ? window.location.search : "";
const entryHash = typeof window !== "undefined" ? window.location.hash : "";

type Saved = { path: string; ts: number };

/** The server slug of an in-app `/s/<slug>/...` path, or null. */
function serverSlugOf(path: string): string | null {
  const match = path.match(/^\/s\/([^/?#]+)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
}

/**
 * Only a server the user has joined is a place to come back to. A public
 * server they are only reading (`/s/<slug>` for a nonmember renders the public
 * page) is not: resuming into it from `/` dropped people on someone else's
 * server instead of their own (task #134).
 */
function isResumable(path: string, isJoinedServerSlug: (slug: string) => boolean): boolean {
  const slug = serverSlugOf(path);
  return slug !== null && isJoinedServerSlug(slug);
}

function readSaved(): Saved | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Saved;
    if (typeof parsed?.path !== "string" || typeof parsed?.ts !== "number") return null;
    if (Date.now() - parsed.ts > MAX_AGE_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Settings › Account › Delete Account is never a place to come back to: once a
 * deletion is cancelled (pages/accountDeletionReturn.ts) a resume there showed
 * the page stuck loading instead of the app.
 */
function isDeleteAccountPath(path: string): boolean {
  return /^\/s\/[^/?#]+\/settings\/account\/delete(?:[/?#]|$)/.test(path);
}

/** The last in-app location saved (within a day), or null. */
export function readLastLocationPath(): string | null {
  return readSaved()?.path ?? null;
}

/**
 * Persist the current in-app location and, on a cold PWA resume that lands on
 * `/` (the manifest start_url), redirect back to the last deep location.
 *
 * Android Chrome aggressively evicts backgrounded PWAs; on resume the OS
 * re-launches from `start_url`, which drops the user on the default channel
 * instead of where they left off.
 */
export function useLastLocationResume(enabled: boolean, isJoinedServerSlug: (slug: string) => boolean) {
  const location = useLocation();
  const navigate = useNavigate();
  // A deliberate Server Picker navigation owns this whole page load. Capture
  // the intent before the route resolver consumes its one-shot storage flag,
  // so cold-location resume cannot bounce the user back into a server later.
  const restoredRef = useRef(isServerSelectionRequested());

  useEffect(() => {
    if (!enabled) return;
    if (restoredRef.current) return;
    if (isServerSelectionRequested()) {
      restoredRef.current = true;
      return;
    }
    if (entryPathname !== "/" || entrySearch || entryHash) {
      restoredRef.current = true;
      return;
    }
    restoredRef.current = true;
    const saved = readSaved();
    if (!saved || !isResumable(saved.path, isJoinedServerSlug) || isDeleteAccountPath(saved.path)) return;
    navigate(saved.path, { replace: true });
  }, [enabled, isJoinedServerSlug, navigate]);

  useEffect(() => {
    if (!enabled) return;
    const path = location.pathname + location.search + location.hash;
    if (!isResumable(path, isJoinedServerSlug) || isDeleteAccountPath(path)) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ path, ts: Date.now() }));
    } catch {
      // ignore quota / privacy-mode failures
    }
  }, [enabled, isJoinedServerSlug, location.pathname, location.search, location.hash]);
}
