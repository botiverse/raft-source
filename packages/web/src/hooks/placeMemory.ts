import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { resolveSearchOverlayBackground } from "../features/search/searchOverlayLocation";
import { isRailMode, placeOf, tabAlwaysLandsHome, tabHome } from "../navigation/surfaces";
import type { PlaceContext, RailMode } from "../navigation/surfaces";
import { useServerStore } from "../store/serverStore";
import { LEGACY_LAST_LOCATION_KEY, LEGACY_SERVER_SURFACE_PREFIX, LEGACY_TAB_MEMORY_PREFIX, PLACE_STORAGE_PREFIX } from "./placeMemoryKeys";

// Page-place memory: per server, the last page of each rail tab and which tab
// was last, each kept through the route table (navigation/surfaces.ts) with
// only the page's own params. The rail, a server switch, the phone tab bar and
// the `/` start all land through placeFor. A place never holds a pane (a
// thread, a profile, an open result): a conversation's panes come back through
// its beside memory (useBesideMemory) when it is entered.

interface ServerPlaces {
  tab: RailMode | null;
  places: Partial<Record<RailMode, string>>;
}

const EMPTY: ServerPlaces = { tab: null, places: {} };

function placesKey(serverSlug: string): string {
  return `${PLACE_STORAGE_PREFIX}:${serverSlug}`;
}

/** Only known tabs and string places are kept: storage may be corrupt, or written by a newer build (a rollback). */
function parsePlaces(raw: string | null): ServerPlaces {
  if (!raw) return EMPTY;
  try {
    const parsed = JSON.parse(raw) as { tab?: unknown; places?: unknown } | null;
    const stored = parsed?.places && typeof parsed.places === "object" ? Object.entries(parsed.places) : [];
    const places: ServerPlaces["places"] = {};
    for (const [tab, place] of stored) {
      if (isRailMode(tab) && typeof place === "string") places[tab] = place;
    }
    return { tab: isRailMode(parsed?.tab) ? parsed.tab : null, places };
  } catch {
    return EMPTY;
  }
}

let legacyMigrated = false;

/**
 * The tab memory (`slock:tabMemory:v2:<slug>:<tab>`) and the server's last
 * surface (`slock:serverSurface:v1:<slug>`) kept whole addresses, panes
 * included. Read once through the place allowlist into the place store (not
 * over a place already there), then deleted, with the old `/` start's
 * `slock:last-location`. The viewer's own assistant's DM is not known here:
 * usePlaceMemory drops it from Chat once it is (forgetOwnAssistantDm).
 */
function migrateLegacyPlaces(): void {
  if (legacyMigrated) return;
  legacyMigrated = true;
  try {
    const found = new Map<string, { tabMemory: string[]; surface: string | null }>();
    const legacyKeys: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      const prefix = [LEGACY_TAB_MEMORY_PREFIX, LEGACY_SERVER_SURFACE_PREFIX].find((candidate) => key?.startsWith(`${candidate}:`));
      if (!key || !prefix) continue;
      legacyKeys.push(key);
      const value = localStorage.getItem(key);
      const [slug] = key.slice(prefix.length + 1).split(":");
      if (!slug || !value) continue;
      const entry = found.get(slug) ?? { tabMemory: [], surface: null };
      if (prefix === LEGACY_SERVER_SURFACE_PREFIX) entry.surface = value;
      else entry.tabMemory.push(value);
      found.set(slug, entry);
    }
    for (const [slug, { tabMemory, surface }] of found) {
      if (localStorage.getItem(placesKey(slug)) !== null) continue;
      const migrated: ServerPlaces = { tab: null, places: {} };
      for (const value of tabMemory) {
        const remembered = placeOf(value, slug);
        if (remembered) migrated.places[remembered.tab] = remembered.place;
      }
      // The server's last surface is the latest of all.
      const last = surface ? placeOf(surface, slug) : null;
      if (last) {
        migrated.tab = last.tab;
        migrated.places[last.tab] = last.place;
      }
      if (migrated.tab !== null || Object.keys(migrated.places).length > 0) {
        localStorage.setItem(placesKey(slug), JSON.stringify(migrated));
      }
    }
    for (const key of legacyKeys) localStorage.removeItem(key);
    localStorage.removeItem(LEGACY_LAST_LOCATION_KEY);
  } catch {
    // localStorage may throw in private mode: nothing to migrate.
  }
}

function readPlaces(serverSlug: string): ServerPlaces {
  migrateLegacyPlaces();
  try {
    return parsePlaces(localStorage.getItem(placesKey(serverSlug)));
  } catch {
    return EMPTY;
  }
}

function writePlace(serverSlug: string, tab: RailMode, place: string): void {
  const current = readPlaces(serverSlug);
  if (current.tab === tab && current.places[tab] === place) return;
  try {
    localStorage.setItem(placesKey(serverSlug), JSON.stringify({ tab, places: { ...current.places, [tab]: place } }));
  } catch {
    // localStorage may throw in private mode / quota exhaustion — best-effort.
  }
}

/**
 * A Chat place that is the viewer's own assistant's DM (migrated, or saved
 * before the assistant was known) is dropped, as the place store's table says
 * it is none; Chat then lands on its home until another conversation is shown.
 */
function forgetOwnAssistantDm(serverSlug: string, assistantDmId: string): void {
  const current = readPlaces(serverSlug);
  const chat = current.places.chat;
  if (chat === undefined || placeOf(chat, serverSlug, { assistantDmId }) !== null) return;
  const { chat: _dropped, ...places } = current.places;
  try {
    localStorage.setItem(placesKey(serverSlug), JSON.stringify({ tab: current.tab === "chat" ? null : current.tab, places }));
  } catch {
    // localStorage may throw in private mode / quota exhaustion — best-effort.
  }
}

/** The viewer's role on `serverSlug` as the server store has it (the list, else the current server). */
function isGuestOn(serverSlug: string): boolean {
  const { servers, current } = useServerStore.getState();
  const server = servers.find((candidate) => candidate.slug === serverSlug) ?? (current?.slug === serverSlug ? current : null);
  return server?.role === "guest";
}

export interface PlaceViewer extends PlaceContext {
  guest?: boolean;
  phone?: boolean;
}

/**
 * Where to land on `serverSlug`: in rail tab `tab` (the rail, the phone tab
 * bar), or with no tab in its last tab (a server switch, the `/` start). The
 * remembered page with its page params, else the tab's home (the server's
 * root with nothing remembered at all). A stored place is checked against the
 * route table again as it is read, so one saved by an older build, or the
 * viewer's own assistant's DM once it is known, never comes back.
 * Without `viewer.guest`, the target server's role in the server store says whether the viewer is a guest.
 */
export function placeFor(serverSlug: string, tab?: RailMode, viewer: PlaceViewer = {}): string {
  const stored = readPlaces(serverSlug);
  const target = tab ?? stored.tab;
  if (target === null) return `/s/${serverSlug}`;
  const asViewer = viewer.guest === undefined ? { ...viewer, guest: isGuestOn(serverSlug) } : viewer;
  if (tabAlwaysLandsHome(target, asViewer)) return tabHome(target, serverSlug);
  const raw = stored.places[target];
  const remembered = typeof raw === "string" ? placeOf(raw, serverSlug, viewer) : null;
  return remembered?.tab === target ? remembered.place : tabHome(target, serverSlug);
}

/**
 * Mount once in the server layout: remembers each memorable page shown as
 * its tab's place and the server's last one. `assistantDmId` is the viewer's
 * own assistant's DM (useOwnAssistantDmId): undefined while not known yet.
 */
export function usePlaceMemory(assistantDmId: string | null | undefined): void {
  const location = useLocation();
  const serverSlug = useServerStore((s) => s.current?.slug ?? null);
  const { pathname, search } = location;
  // Not while the ⌘K palette floats over a page, which stays the place; nor
  // a DM shown before the assistant is known, which may be its DM (no place):
  // written once it is known.
  const remembered = serverSlug
    && resolveSearchOverlayBackground(location) === null
    && !(assistantDmId === undefined && pathname.startsWith(`/s/${serverSlug}/dm/`))
    ? placeOf(`${pathname}${search}`, serverSlug, { assistantDmId })
    : null;
  const tab = remembered?.tab ?? null;
  const place = remembered?.place ?? null;

  useEffect(() => {
    if (!serverSlug || !tab || !place) return;
    writePlace(serverSlug, tab, place);
  }, [place, serverSlug, tab]);

  useEffect(() => {
    if (!serverSlug || !assistantDmId) return;
    forgetOwnAssistantDm(serverSlug, assistantDmId);
  }, [assistantDmId, serverSlug]);
}

/** Tests: run the one-time migration of the legacy keys again. */
export function resetPlaceMigrationForTests(): void {
  legacyMigrated = false;
}
