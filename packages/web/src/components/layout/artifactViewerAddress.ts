import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import { useLocation, useNavigate, useNavigationType } from "react-router-dom";
import type { NavigationType } from "react-router-dom";

import { openArtifactOverDialog, useArtifactViewerStore } from "../../apps/artifacts";
import type { ArtifactAddressedPlaces } from "../../apps/artifacts";
import { parseSearchOpenParam } from "../../store/searchContentStore";
import {
  artifactAddressClosing,
  artifactAddressOpening,
  artifactAddressSource,
  artifactAddressTidying,
  artifactAddressVersion,
  artifactOpenEntryOf,
  liveArtifactAddressEntry,
  readArtifactAddress,
  useArtifactBackSettled,
  withArtifactAddress,
  withArtifactOpenEntry,
  writeArtifactAddress,
} from "./artifactOpenAddress";
import type { ArtifactAddressEntry, ArtifactAddressPlace, ArtifactOpenEntry } from "./artifactOpenAddress";

// The viewer store's Artifact as the page's address (#proj-workspace:#240;
// the convention and its helper: artifactOpenAddress.ts). Wherever the viewer
// store shows an Artifact, it is `?artifact=<id>` (`&version=<n>`) on the
// page it shows on, mirrored with the store as `?thread=` is with the
// thread's (useRightPanelUrlSync):
// - beside a conversation (the side card): on its channel's or DM's page,
//   and on Activity's or Search's when the conversation is its detail
//   (`?open=channel:<id>`);
// - the shell's card, where no channel panel is (a thread opened from
//   Activity or Search, Saved, a legacy Files tab);
// - over a task's dialog (`?task=`: the dialog's own address is the task
//   panel's, written by useRightPanelUrlSync; this is only the viewer's).
// Not on the Artifacts home (its own viewer, useArtifactOpenAddress) nor in
// Activity's or Search's Artifact slot (useSearchContentUrlSync).

type ViewerState = ReturnType<typeof useArtifactViewerStore.getState>;
type OpenArtifact = NonNullable<ViewerState["open"]>;

/**
 * Where the page's address holds the viewer store's Artifact (null: nowhere,
 * the Artifacts home and Activity's or Search's own Artifact slot). On a
 * conversation's page its side card; elsewhere the shell's card; over a
 * task's dialog wherever its `?task=` is, but for a task in Activity's or
 * Search's detail slot, which is a page.
 */
export function addressedPlacesOf(pathname: string, search: string): ArtifactAddressedPlaces | null {
  const match = /^\/s\/[^/]+(\/.*)?$/.exec(pathname);
  if (!match) return null;
  const page = (match[1] ?? "").replace(/\/+$/, "");
  if (page === "/artifacts") return null;
  const params = new URLSearchParams(search);
  const dialog = params.has("task");
  const conversation = /^\/(?:channel|dm)\/([^/]+)$/.exec(page);
  if (conversation) return { conversationId: decodeURIComponent(conversation[1]!), shell: false, dialog };
  if (page === "/activity" || page === "/search") {
    const slot = parseSearchOpenParam(params.get("open"));
    if (!slot || slot.kind === "artifact") return null;
    if (slot.kind === "channel" || slot.kind === "dm") return { conversationId: slot.id, shell: false, dialog };
    // A task there is a page, not a dialog (its `?task=` with it): the shell's card, as for a thread there.
    if (slot.kind === "task") return { conversationId: null, shell: true, dialog: false };
  }
  return { conversationId: null, shell: true, dialog };
}

/** Which place the open Artifact is in, if the page's address holds that place. */
function placeOf(open: OpenArtifact | null, places: ArtifactAddressedPlaces): ArtifactAddressPlace | null {
  if (!open) return null;
  if (open.conversationId !== null) return open.conversationId === places.conversationId ? "conversation" : null;
  if (open.cover) return places.dialog ? "dialog" : null;
  return places.shell ? "shell" : null;
}

function holds(places: ArtifactAddressedPlaces, place: ArtifactAddressPlace): boolean {
  return place === "conversation" ? places.conversationId !== null : place === "shell" ? places.shell : places.dialog;
}

/**
 * The place the entry's address opens its Artifact in: its mark's, else (a
 * cold link) the topmost the page has: over its task's dialog, else beside
 * its conversation, else the shell's.
 */
function addressPlaceOf(entry: ArtifactAddressEntry, places: ArtifactAddressedPlaces): ArtifactAddressPlace {
  const marked = artifactOpenEntryOf(entry.state)?.place;
  if (marked && holds(places, marked)) return marked;
  return places.dialog ? "dialog" : places.conversationId !== null ? "conversation" : "shell";
}

/** The version the viewer shows: its pick, else the one it opened at. */
function shownVersion(state: ViewerState): number | null {
  return state.picked ? state.picked.version : state.open?.version ?? null;
}

interface KeptEntry {
  index: number | null;
  entry: ArtifactOpenEntry | null;
  id: string | null;
  thread: string | null;
}

/**
 * Keeps an entry's Artifact mark through writes that drop the entry's state:
 * - a replace of the same entry (`?msg=` cleared, a panel param re-added),
 *   still opening the same Artifact and with the same thread: the mark goes
 *   back on, so its close still goes back;
 * - another panel pushed over it with the Artifact still in the address (a
 *   thread, a task's dialog): the new entry gets its place, not pushed, so a
 *   reload opens it where it was and its close there replaces.
 */
function keepEntryMark(last: MutableRefObject<KeptEntry | null>, navigationType: NavigationType): void {
  const state = window.history.state as { idx?: unknown; usr?: unknown } | null;
  const index = typeof state?.idx === "number" ? state.idx : null;
  const params = new URLSearchParams(window.location.search);
  const read = readArtifactAddress(params);
  const id = read && !read.legacy ? read.id : null;
  const thread = params.get("thread");
  let entry = artifactOpenEntryOf(state?.usr);
  const previous = last.current;
  if (entry === null && previous?.entry && index !== null && previous.index !== null && id !== null && previous.id === id) {
    if (navigationType === "REPLACE" && previous.index === index && previous.thread === thread) entry = previous.entry;
    else if (navigationType === "PUSH" && index === previous.index + 1) entry = { ...previous.entry, pushed: false };
    if (entry) window.history.replaceState({ ...state, usr: withArtifactOpenEntry(state?.usr, entry) }, "", window.location.href);
  }
  last.current = { index, entry, id, thread };
}

/**
 * The viewer store's Artifact and the page's address, both ways
 * (#proj-workspace:#240, Kirby's rules on #13698):
 *
 * - Store → address: every opening pushes an entry, at every width, over a
 *   thread or another Artifact too, so Back closes it and returns to what was
 *   open before it. A version picked replaces `version`. Closed (its ×, Esc,
 *   a phone's Back) it goes back where it pushed the entry, else (a cold
 *   link, a panel pushed over it) the address without it replaces the entry.
 *   Its dialog closing first drops it in place.
 * - Address → store: a reload, a copied address, a new tab, Back and Forward
 *   open it in its place (the entry's mark says which; a cold link the
 *   topmost the page has), source the entry's, else `link`; an address
 *   without it closes the one open in a place it holds. Over a dialog it
 *   waits for the dialog to be on screen (openArtifactOverDialog).
 * - The store is told which places the address holds, so their phone page
 *   pushes no history entry of its own (the address's is it).
 */
export function useArtifactViewerAddress(): void {
  const location = useLocation();
  const navigate = useNavigate();
  const navigationType = useNavigationType();
  useArtifactBackSettled(location.key);
  const kept = useRef<KeptEntry | null>(null);
  const waiting = useRef<(() => void) | null>(null);

  // Address → store.
  useEffect(() => {
    waiting.current?.();
    waiting.current = null;
    // A stale commit: the browser already left this address (an opening's push landed after it).
    if (location.pathname !== window.location.pathname || location.search !== window.location.search) return;
    keepEntryMark(kept, navigationType);
    const places = addressedPlacesOf(location.pathname, location.search);
    const store = useArtifactViewerStore.getState();
    store.setAddressed(places);
    if (!places) return;
    const entry = liveArtifactAddressEntry();
    const asked = readArtifactAddress(new URLSearchParams(location.search));
    if (asked?.legacy) return;
    writeArtifactAddress(navigate, artifactAddressTidying(entry, "link"));
    const { open } = store;
    // Its dialog's address went first (the dialog closing): the viewer closes with the dialog.
    if (open?.cover && !places.dialog && asked?.id === open.id) return;
    const here = placeOf(open, places);
    if (!asked) {
      if (here) store.close();
      return;
    }
    const place = addressPlaceOf(entry, places);
    if (open && here === place && open.id === asked.id && shownVersion(store) === asked.version) return;
    const target = { id: asked.id, version: asked.version, source: artifactAddressSource(entry, "link") };
    if (place === "conversation") store.openArtifact({ ...target, conversationId: places.conversationId! });
    else if (place === "shell") store.openArtifact({ ...target, conversationId: null, cover: null });
    else waiting.current = openArtifactOverDialog(target);
  }, [location.key, location.pathname, location.search, navigationType, navigate]);

  useEffect(() => () => {
    waiting.current?.();
    useArtifactViewerStore.getState().setAddressed(null);
  }, []);

  // Store → address.
  useEffect(() => useArtifactViewerStore.subscribe((state, prev) => {
    if (state.open === prev.open && state.picked === prev.picked) return;
    const entry = liveArtifactAddressEntry();
    const places = addressedPlacesOf(entry.pathname, entry.search);
    if (!places) return;
    const asked = readArtifactAddress(new URLSearchParams(entry.search));
    const inAddress = asked && !asked.legacy ? asked : null;
    const place = placeOf(state.open, places);
    if (!place || !state.open) {
      if (!inAddress || prev.open?.id !== inAddress.id) return;
      const dialogGone = !!prev.open.cover && !places.dialog;
      writeArtifactAddress(navigate, artifactAddressClosing(entry, dialogGone ? { pushed: false } : {}), { record: true });
      return;
    }
    const version = shownVersion(state);
    if (inAddress && inAddress.id === state.open.id && addressPlaceOf(entry, places) === place) {
      // The address's already (it opened it), or a version picked in it.
      if (inAddress.version !== version) writeArtifactAddress(navigate, artifactAddressVersion(entry, version), { record: true });
      return;
    }
    writeArtifactAddress(navigate, artifactAddressOpening(entry, { id: state.open.id, version }, state.open.source, { push: true, place }), { record: true });
  }), [navigate]);
}

/**
 * What the shell's page is, for closing what it shows on leaving it
 * (useArtifactShell): the address without the Artifact's own params, so
 * opening one (`?artifact=`) or its version is not leaving, and without the
 * message the page was opened at (`msg`): the page drops it by itself a few
 * seconds after showing that message (useRetireJump, Back to Bottom), which is
 * the same page still. With it counted, an Artifact opened from a thread
 * Activity had opened at an unread reply closed by itself when the reply's
 * highlight retired (#proj-workspace:#284).
 */
export function shellPageOf(pathname: string, search: string): string {
  const params = withArtifactAddress(new URLSearchParams(search), null);
  params.delete("msg");
  const rest = params.toString();
  return rest ? `${pathname}?${rest}` : pathname;
}
