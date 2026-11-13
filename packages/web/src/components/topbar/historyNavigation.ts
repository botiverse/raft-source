// In-app Back / Forward for the top bar's ‹ › (task #127, Slack's buttons) and
// the host's history commands (the desktop app's ⌘[ / ⌘], trackpad swipe,
// mouse side buttons).
//
// The history itself is react-router's BrowserRouter over window.history: no
// second stack. WHERE the document sits comes from the standard Navigation
// API (`navigation.entries()`, `navigation.currentEntry`,
// `currententrychange`; Baseline 2026, in every Electron), never from a
// router's private state. Where it is missing the controls hide.
//
// What the API does not say is WHICH entries are places. Back/Forward move
// between PLACES: the conversations and pages a user was at. A transient layer
// (the ⌘K search overlay, which the layout renders over a background location)
// is not a place even though the web pushes it as a history entry, and closing
// it pushes the background again, so the raw history reads
// channel → search → channel. Stepping through that raw history would first
// re-open a palette the user just dismissed, then land where they already are.
// So every committed navigation is recorded against its entry's key as
// {kind, key}: kind from the layout's own "is there a background location"
// test, key = the place it shows. A step goes to the nearest entry that is a
// place with a different key, in one history.go(n) hop (no intermediate
// flash).
//
// Back and Forward stay inside this document. navigation.entries() also lists
// the same-origin entries of earlier documents in the tab (before a full
// reload: a 401 sending the app to "/", a cross-server location.assign) and,
// after a reload mid-stack, the old document's forward entries. Stepping onto
// one reloads the whole app into a dead session's URL. So the tracker notes
// every entry this document becomes current in (currententrychange, which
// fires for this document's own pushes, replaces and traversals, before React
// commits the route), and a step stops at an entry it never noted: a new
// document starts with nothing behind it or ahead of it. An entry of this
// document whose route never committed (a fast Back skips the render) has no
// record and counts as a distinct place.
//
// One tracker (mounted once, inside the router: HostIntegration) feeds a tiny
// external store; any number of consumers read the position through
// useSyncExternalStore.

import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { Location } from "react-router-dom";
import { resolveSearchOverlayBackground } from "../../features/search/searchOverlayLocation";

interface HistoryPosition {
  canGoBack: boolean;
  canGoForward: boolean;
}

type HistoryEntryKind = "place" | "overlay";

export interface HistoryEntry {
  kind: HistoryEntryKind;
  /** The place this entry shows (for an overlay: the place it floats over). */
  key: string;
}

/** The slice of a NavigationHistoryEntry this module reads. */
interface NavigationEntryLike {
  readonly key: string;
  readonly index: number;
}

/** The slice of the Navigation API (`window.navigation`) this module reads. */
interface NavigationLike {
  readonly currentEntry: NavigationEntryLike | null;
  entries(): readonly NavigationEntryLike[];
  addEventListener(type: "currententrychange", listener: () => void): void;
  removeEventListener(type: "currententrychange", listener: () => void): void;
}

/** Where the document sits in its history, and what each observed entry showed. */
export interface HistorySnapshot {
  /** Entry keys in history order (navigation.entries()). */
  keys: readonly string[];
  /** The current entry's position in `keys`. */
  index: number;
  /** What each entry showed, by entry key, where its route committed. */
  records: ReadonlyMap<string, HistoryEntry>;
  /** Keys of the entries this document was current in; any other entry is another document's. Absent = every recorded entry. */
  own?: ReadonlySet<string>;
}

const NO_POSITION: HistoryPosition = Object.freeze({ canGoBack: false, canGoForward: false });

/** The Navigation API, or null where the browser has none (the controls hide there). */
function getNavigation(): NavigationLike | null {
  if (typeof window === "undefined") return null;
  const navigation = (window as { navigation?: NavigationLike }).navigation;
  return navigation && typeof navigation.entries === "function" ? navigation : null;
}

export function isHistoryNavigationSupported(): boolean {
  return getNavigation() !== null;
}

type HistoryLocation = Pick<Location, "pathname" | "search" | "state">;
/** The layout's own test: the location an overlay floats over, or null when the location is a place itself. */
type OverlayBackgroundResolver = (location: HistoryLocation) => Pick<Location, "pathname" | "search"> | null;

/** Classify a committed location: the resolver decides overlay vs place, the key is what is shown underneath. */
export function historyEntryFor(location: HistoryLocation, resolveBackground: OverlayBackgroundResolver): HistoryEntry {
  const background = resolveBackground(location);
  const shown = background ?? location;
  return { kind: background ? "overlay" : "place", key: `${shown.pathname}${shown.search}` };
}

function deltaOf(direction: unknown): -1 | 1 | null {
  if (direction === "back") return -1;
  if (direction === "forward") return 1;
  return null;
}

/**
 * The history.go() distance that reaches the nearest PLACE in the requested
 * direction (skipping overlays and entries showing the same place as now), or
 * null when there is none in this document.
 */
export function resolveHistoryStep(direction: unknown, snapshot: HistorySnapshot | null): number | null {
  const delta = deltaOf(direction);
  if (snapshot === null || delta === null) return null;
  const { keys, index, records, own } = snapshot;
  if (index < 0 || index >= keys.length) return null;
  const current = records.get(keys[index]);
  for (let j = index + delta; j >= 0 && j < keys.length; j += delta) {
    const entry = records.get(keys[j]);
    if (!entry) {
      if (own?.has(keys[j])) return j - index; // ours, its route never committed: a distinct place
      return null; // another document's entry (before a reload): out of bounds
    }
    if (entry.kind === "overlay") continue;
    if (current && entry.key === current.key) continue;
    return j - index;
  }
  return null;
}

export function positionOf(snapshot: HistorySnapshot | null): HistoryPosition {
  if (snapshot === null) return NO_POSITION;
  return {
    canGoBack: resolveHistoryStep("back", snapshot) !== null,
    canGoForward: resolveHistoryStep("forward", snapshot) !== null,
  };
}

// ---- external store -------------------------------------------------------

const listeners = new Set<() => void>();
let records = new Map<string, HistoryEntry>();
let own = new Set<string>();
let position: HistoryPosition = NO_POSITION;

/** The live snapshot: the Navigation API's entries plus this document's records. */
export function readHistorySnapshot(navigation: NavigationLike | null = getNavigation()): HistorySnapshot | null {
  const current = navigation?.currentEntry;
  if (!navigation || !current) return null;
  const keys = navigation.entries().map((entry) => entry.key);
  const index = keys.indexOf(current.key);
  return index === -1 ? null : { keys, index, records, own };
}

/** The current entry is this document's (it is current in it now). Entries no longer in the history are forgotten. */
function noteCurrentEntry(navigation: NavigationLike): string | null {
  const current = navigation.currentEntry;
  if (!current) return null;
  const live = new Set(navigation.entries().map((e) => e.key));
  const nextRecords = new Map<string, HistoryEntry>();
  for (const [key, value] of records) if (live.has(key)) nextRecords.set(key, value);
  records = nextRecords;
  own = new Set([...own].filter((key) => live.has(key)));
  own.add(current.key);
  return current.key;
}

function onCurrentEntryChange(): void {
  const navigation = getNavigation();
  if (navigation) noteCurrentEntry(navigation);
  refresh();
}

function refresh(): void {
  const next = positionOf(readHistorySnapshot());
  // Keep the snapshot's identity stable unless a flag changed (useSyncExternalStore).
  if (next.canGoBack !== position.canGoBack || next.canGoForward !== position.canGoForward) position = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getHistoryPosition(): HistoryPosition {
  return position;
}

/** Test seam: forget everything (a fresh document). */
export function resetHistoryTracking(): void {
  records = new Map();
  own = new Set();
  position = NO_POSITION;
  refresh();
}

/** Record what the current entry shows (a committed navigation). Entries no longer in the history are forgotten. */
export function recordCurrentHistoryEntry(entry: HistoryEntry, navigation: NavigationLike | null = getNavigation()): void {
  if (!navigation) return;
  const key = noteCurrentEntry(navigation);
  if (key === null) return;
  records.set(key, entry);
  refresh();
}

// ---- hooks ---------------------------------------------------------------

// The layout's OWN overlay test (the function MainLayout uses to decide whether
// to float the search palette over a background), so "what is a place" can
// never drift between the layout and the Back/Forward buttons.
const resolveLayoutBackground: OverlayBackgroundResolver = (location) => resolveSearchOverlayBackground(location as Location);

export function useHistoryPosition(): HistoryPosition {
  return useSyncExternalStore(subscribe, getHistoryPosition, getHistoryPosition);
}

/** Step to the nearest place in the requested direction if there is one; returns whether a step was taken. */
export function useHistoryStep(): (direction: unknown) => boolean {
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  return useCallback((direction: unknown) => {
    const step = resolveHistoryStep(direction, readHistorySnapshot());
    if (step === null) return false;
    void navigateRef.current(step);
    return true;
  }, []);
}

/**
 * Mount ONCE inside the router, for the app's whole life: records every
 * committed navigation with the layout's overlay test and follows the
 * Navigation API's current entry. Inert where the API is missing.
 */
export function useHistoryTracker(): void {
  const location = useLocation();
  // Layout effect: the position must be current before the top bar paints its
  // enabled/disabled arrows for this location.
  useLayoutEffect(() => {
    recordCurrentHistoryEntry(historyEntryFor(location, resolveLayoutBackground));
  }, [location]);
  useLayoutEffect(() => {
    const navigation = getNavigation();
    if (!navigation) return;
    navigation.addEventListener("currententrychange", onCurrentEntryChange);
    return () => navigation.removeEventListener("currententrychange", onCurrentEntryChange);
  }, []);
}
