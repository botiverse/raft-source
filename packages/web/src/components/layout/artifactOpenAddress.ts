import { useCallback, useEffect, useMemo, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { NavigateOptions } from "react-router-dom";
import type { ArtifactId, ArtifactReviewId } from "@botiverse/raft-shared";

import {
  ARTIFACT_OPEN_FROM_PARAM,
  artifactOpenTarget,
  withArtifactOpenParams,
  withArtifactOpenVersion,
  withoutArtifactOpenFrom,
  withoutArtifactOpenParams,
} from "../../apps/artifacts";
import type { ArtifactLinkTarget, ArtifactOpenAddress, ArtifactOpenShown } from "../../apps/artifacts";
import { recordSynchronousMobileBackNavigation } from "../../hooks/useAppNavigate";
import { parseSearchOpenParam, parseSearchOpenReview, parseSearchOpenVersion, SEARCH_OPEN_REVIEW_PARAM } from "../../store/searchContentStore";

// "An Artifact is open here" as an address (#proj-workspace:#240; raft-design
// navigation.md, Going back): every opened thing has its own address, Back
// closes it, and a reload, a copied address or a new tab keeps it. One
// convention on every surface that opens an Artifact in place, and this one
// implementation of it:
//
// - The address: `?artifact=<id>` (the short id, artifactLinkId), `&version=<n>`
//   pinned (else the latest), beside the page's own params. Activity's adds
//   `&review=<id>` (the review a review's row is about). `&from=link|other`
//   says what an address opened from (`artifact_opened`'s source) and is
//   replaced away once read. The retired `?open=artifact:<id>` of Activity
//   and Search is read and replaced with the current form.
// - The entry: what opened it and whether the page pushed it (`raftArtifactOpen`
//   in the history entry's state, so a reload and coming Back keep it).
// - The writes: an opening pushes an entry or replaces the one on screen (the
//   surface's rule, below); a version picked replaces `version` in the same
//   entry; the close is Back where the page pushed the entry, else the address
//   without the Artifact in its place, so it never leaves the app nor leaves
//   an entry behind.
//
// Where it is used, and each surface's push rule:
// - the Artifacts home (useArtifactOpenAddress): a row pushes;
// - the viewer store's places (artifactViewerAddress.ts: a conversation's side
//   card, the shell's card, the viewer over a task's dialog): every opening
//   pushes, at every width, over a thread or another Artifact too;
// - Activity's and Search's detail slot (MainLayout's useSearchContentUrlSync):
//   master/detail beside the list replaces, as its every row does; a phone's
//   page over the list pushes.

/** Where the history entry keeps what it knows of the Artifact its address opens. */
const OPEN_ENTRY_STATE = "raftArtifactOpen";

type OpenSource = ArtifactOpenShown["source"];

/**
 * What an entry that opens an Artifact knows beyond its address: what opened
 * it (`artifact_opened`'s source: a reload or a Forward reads it again, and
 * `from` leaves the address once it is read), and whether the page pushed it
 * over the entry it was opened from, so closing it is history back. Kept on
 * the entry, not in memory: a reload keeps it, and coming Back to the entry
 * finds it again.
 */
export interface ArtifactOpenEntry {
  source: OpenSource;
  pushed: boolean;
  /** Which of the viewer store's places it is open in (artifactViewerAddress.ts); none on the home and in Activity's slot. */
  place?: ArtifactAddressPlace;
}

/** A viewer store place an address opens: a conversation's side card, the shell's card, over a task's dialog. */
export type ArtifactAddressPlace = "conversation" | "shell" | "dialog";

const PLACES: readonly ArtifactAddressPlace[] = ["conversation", "shell", "dialog"];

export function artifactOpenEntryOf(state: unknown): ArtifactOpenEntry | null {
  if (!state || typeof state !== "object") return null;
  const entry = (state as Record<string, unknown>)[OPEN_ENTRY_STATE];
  if (!entry || typeof entry !== "object") return null;
  const { source, pushed, place } = entry as Record<string, unknown>;
  if (typeof source !== "string" || typeof pushed !== "boolean") return null;
  const known = PLACES.find((value) => value === place);
  return { source: source as OpenSource, pushed, ...(known ? { place: known } : {}) };
}

/** `state` with the entry's open (null: without it), the rest kept. */
export function withArtifactOpenEntry(state: unknown, entry: ArtifactOpenEntry | null): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(state && typeof state === "object" ? state : {}) };
  if (entry) next[OPEN_ENTRY_STATE] = entry;
  else delete next[OPEN_ENTRY_STATE];
  return next;
}

/** An Artifact an address opens: at a pinned version or the latest, and on Activity the review its row is about. */
export interface ArtifactAddressTarget extends ArtifactLinkTarget {
  review?: ArtifactReviewId;
}

/** An address's Artifact as read: `from` (null: none) and whether it is the retired `?open=artifact:` form. */
export interface ArtifactAddress extends ArtifactAddressTarget {
  from: "link" | "other" | null;
  legacy: boolean;
}

/**
 * The Artifact an address opens: `?artifact=` (artifactOpenTarget), else the
 * retired `?open=artifact:<id>` Activity and Search wrote (`legacy`), each
 * with `&version=` (a malformed one: the latest) and `&review=`.
 */
export function readArtifactAddress(params: URLSearchParams): ArtifactAddress | null {
  const review = parseSearchOpenReview(params.get(SEARCH_OPEN_REVIEW_PARAM));
  const reviewed = review === undefined ? {} : { review };
  const current = artifactOpenTarget(params);
  if (current) return { id: current.id, version: current.version, ...reviewed, from: current.from === "search" ? null : current.from, legacy: false };
  const legacy = parseSearchOpenParam(params.get("open"));
  if (legacy?.kind !== "artifact") return null;
  return { id: legacy.id as ArtifactId, version: parseSearchOpenVersion(params.get("version")) ?? null, ...reviewed, from: null, legacy: true };
}

/** `params` opening `target` (null: none), the page's others kept: any earlier opening's, `from`, `review` and the retired form dropped. */
export function withArtifactAddress(params: URLSearchParams, target: ArtifactAddressTarget | null): URLSearchParams {
  const next = withoutArtifactOpenParams(params);
  next.delete(SEARCH_OPEN_REVIEW_PARAM);
  if (parseSearchOpenParam(next.get("open"))?.kind === "artifact") next.delete("open");
  if (!target) return next;
  const opened = withArtifactOpenParams(next, target);
  if (target.review !== undefined) opened.set(SEARCH_OPEN_REVIEW_PARAM, target.review);
  return opened;
}

/** The entry on screen: its address and its state (BrowserRouter's `usr`, the router's `location.state`). */
export interface ArtifactAddressEntry {
  pathname: string;
  search: string;
  state: unknown;
}

/** A write to the address: history back, or an address in a new entry or in place of the one on screen. */
export type ArtifactAddressWrite =
  | { kind: "back" }
  | { kind: "go"; pathname: string; search: string; replace: boolean; state: Record<string, unknown> };

function paramsOf(entry: ArtifactAddressEntry): URLSearchParams {
  return new URLSearchParams(entry.search);
}

function go(entry: ArtifactAddressEntry, params: URLSearchParams, replace: boolean, state: Record<string, unknown>): ArtifactAddressWrite {
  const search = params.toString();
  return { kind: "go", pathname: entry.pathname, search: search ? `?${search}` : "", replace, state };
}

/**
 * Opening `target` from `entry`: a new entry over it (`push`), marked as the
 * page's, else in its place. In its place it keeps the entry's mark where an
 * Artifact was already open in it (another taking its place: close still goes
 * back), or `pushedBefore` where the surface's own mark says the entry is
 * its (Activity's page pushed for a conversation). `base`: the params to
 * write it in, where the surface changes others in the same write.
 */
export function artifactAddressOpening(entry: ArtifactAddressEntry, target: ArtifactAddressTarget, source: OpenSource, { push, base, pushedBefore, place }: { push: boolean; base?: URLSearchParams; pushedBefore?: boolean; place?: ArtifactAddressPlace }): ArtifactAddressWrite {
  const params = withArtifactAddress(base ?? paramsOf(entry), target);
  const placed = place ? { place } : {};
  if (push) return go(entry, params, false, withArtifactOpenEntry(null, { source, pushed: true, ...placed }));
  const already = readArtifactAddress(paramsOf(entry)) !== null;
  const pushed = pushedBefore ?? (already && (artifactOpenEntryOf(entry.state)?.pushed ?? false));
  return go(entry, params, true, withArtifactOpenEntry(entry.state, { source, pushed, ...placed }));
}

/**
 * The close (raft-design navigation, Going back): Back where the page pushed
 * the entry (`pushed`, else the entry's mark), so what was under it comes
 * back as it was and Forward opens it again; else (a cold link, a reload in a
 * new tab, opened in place of another entry) the address without it in place
 * of this one, so close never leaves the app and leaves no entry behind.
 * `base`: the params to write, where the surface drops others with it.
 */
export function artifactAddressClosing(entry: ArtifactAddressEntry, { pushed, base }: { pushed?: boolean; base?: URLSearchParams } = {}): ArtifactAddressWrite {
  if (pushed ?? artifactOpenEntryOf(entry.state)?.pushed ?? false) return { kind: "back" };
  return go(entry, withArtifactAddress(base ?? paramsOf(entry), null), true, withArtifactOpenEntry(entry.state, null));
}

/** A version picked in the viewer (null: the latest): `version` replaced in the same entry, its mark kept. */
export function artifactAddressVersion(entry: ArtifactAddressEntry, version: number | null): ArtifactAddressWrite {
  return go(entry, withArtifactOpenVersion(paramsOf(entry), version), true, withArtifactOpenEntry(entry.state, artifactOpenEntryOf(entry.state)));
}

/**
 * What the entry's address says opened its Artifact: its mark's source (a
 * reload, coming Back), else `from`, else `fallback`, what an address with
 * neither means on that surface.
 */
export function artifactAddressSource(entry: ArtifactAddressEntry, fallback: OpenSource): OpenSource {
  return artifactOpenEntryOf(entry.state)?.source ?? readArtifactAddress(paramsOf(entry))?.from ?? fallback;
}

/**
 * The address tidied once read, in place: the retired `?open=artifact:` in
 * the current form, and `&from=` dropped with the source it named kept on
 * the entry. Null when there is nothing to tidy.
 */
export function artifactAddressTidying(entry: ArtifactAddressEntry, fallback: OpenSource): ArtifactAddressWrite | null {
  const params = paramsOf(entry);
  const read = readArtifactAddress(params);
  if (!read) return null;
  if (read.legacy) return go(entry, withArtifactAddress(params, read), true, withArtifactOpenEntry(entry.state, artifactOpenEntryOf(entry.state)));
  if (!params.has(ARTIFACT_OPEN_FROM_PARAM)) return null;
  const kept = artifactOpenEntryOf(entry.state);
  return go(entry, withoutArtifactOpenFrom(params), true, withArtifactOpenEntry(entry.state, { ...kept, source: kept?.source ?? read.from ?? fallback, pushed: kept?.pushed ?? false }));
}

/** Does the address already open the slot's Artifact (a cold link, Back/Forward: nothing to add to history)? */
export function artifactSlotInAddress(address: ArtifactAddress | null, slot: { id: string; version?: number; review?: ArtifactReviewId }): boolean {
  return !!address && address.id === slot.id && address.version === (slot.version ?? null) && address.review === slot.review;
}

/**
 * Activity's or Search's Artifact slot (MainLayout's useSearchContentUrlSync)
 * written as the Artifact address: opened (`slot`) or closed (null), in place
 * of a result's `?open=` and `&msg=`. `push`: the slot's master/detail rule (a
 * phone's page over the list); `pushed`: the slot's own mark says the entry is
 * a page it pushed (its close goes back).
 */
export function writeArtifactSlotAddress(navigate: Navigate, entry: ArtifactAddressEntry, slot: { id: string; version?: number; review?: ArtifactReviewId } | null, { source, push, pushed }: { source: OpenSource; push: boolean; pushed: boolean }): void {
  const base = new URLSearchParams(entry.search);
  base.delete("open");
  base.delete("msg");
  const target: ArtifactAddressTarget | null = slot && { id: slot.id as ArtifactId, version: slot.version ?? null, ...(slot.review === undefined ? {} : { review: slot.review }) };
  const write = target ? artifactAddressOpening(entry, target, source, { push, base, pushedBefore: pushed }) : artifactAddressClosing(entry, { pushed, base });
  // flushSync: the result page renders from the store at once, so its entry is committed now too (a quick Back pops it).
  writeArtifactAddress(navigate, write, { flushSync: true, record: write.kind === "go" && !write.replace });
}

/** The browser's entry (BrowserRouter writes it synchronously), for writes from outside a render. */
export function liveArtifactAddressEntry(): ArtifactAddressEntry {
  return {
    pathname: window.location.pathname,
    search: window.location.search,
    state: (window.history.state as { usr?: unknown } | null)?.usr,
  };
}

function historyKey(): string | null {
  const key = (window.history.state as { key?: unknown } | null)?.key;
  return typeof key === "string" ? key : null;
}

type Navigate = ReturnType<typeof useNavigate>;

/**
 * The entry a close has already gone back from: a second close before Back
 * lands (Escape, then a click) would leave the entry under it too. Cleared
 * once the router is on another entry (useArtifactBackSettled), so coming
 * Forward to it again closes as ever.
 */
let backFrom: string | null = null;

export function useArtifactBackSettled(key: string): void {
  useEffect(() => {
    backFrom = null;
  }, [key]);
}

/**
 * Carries out a write. `record`: tell the phone's Back (useAppNavigate) at
 * once, as the right panel's sync does; `flushSync`: commit the router now
 * (a page shown from a store at once). `key`: the entry's, for the second-close guard.
 */
export function writeArtifactAddress(navigate: Navigate, write: ArtifactAddressWrite | null, { record = false, flushSync = false, key = null }: { record?: boolean; flushSync?: boolean; key?: string | null } = {}): void {
  if (!write) return;
  if (write.kind === "back") {
    const from = key ?? historyKey();
    if (from !== null && backFrom === from) return;
    backFrom = from;
    void navigate(-1);
    return;
  }
  const options: NavigateOptions = write.replace ? { replace: true, state: write.state } : { state: write.state, ...(flushSync ? { flushSync: true } : {}) };
  void navigate({ pathname: write.pathname, search: write.search }, options);
  if (record) recordSynchronousMobileBackNavigation(write.replace ? "REPLACE" : "PUSH", `${write.pathname}${write.search}`);
}

/**
 * The entry on screen for a page's writes: the browser's where the router is
 * the browser's (BrowserRouter writes it synchronously, so two writes in one
 * event build on each other), else the router's (MemoryRouter: tests).
 */
function useArtifactAddressEntry(): () => ArtifactAddressEntry {
  const location = useLocation();
  const browserBacked = useRef<boolean | null>(null);
  if (browserBacked.current === null) {
    browserBacked.current = typeof window !== "undefined"
      && window.location.pathname === location.pathname
      && window.location.search === location.search;
  }
  const routed = useRef<ArtifactAddressEntry>(location);
  routed.current = { pathname: location.pathname, search: location.search, state: location.state };
  return useCallback(() => (browserBacked.current ? liveArtifactAddressEntry() : routed.current), []);
}

/**
 * The Artifacts home page's open Artifact as its address (#proj-workspace:#237):
 * `?artifact=<id>`, `&version=<n>` pinned, read with the router.
 *
 * - A row opens one with a new history entry: the address is the viewer, so
 *   Back closes it (the browser's, a phone's), and a reload, a copied address
 *   or a new tab opens it again. The phone's viewer has no entry of its own
 *   (usePhoneHistoryEntry): this one is it.
 * - Its close and a version picked: artifactAddressClosing, artifactAddressVersion.
 * - `&from=` (the canonical link's `link`, `artifact_opened`'s source) is
 *   read once and replaced away, its source kept on the entry; without one
 *   an address is a search hit's (artifactOpenPath).
 */
export function useArtifactOpenAddress(): ArtifactOpenAddress {
  const location = useLocation();
  const navigate = useNavigate();
  const entry = useArtifactAddressEntry();
  const shownEntry: ArtifactAddressEntry = { pathname: location.pathname, search: location.search, state: location.state };
  const asked = readArtifactAddress(new URLSearchParams(location.search));
  const id = asked && !asked.legacy ? asked.id : null;
  const version = asked?.version ?? null;
  const source = artifactAddressSource(shownEntry, "search");
  const shown = useMemo<ArtifactOpenShown | null>(() => (id === null ? null : { id, version, source }), [id, version, source]);
  const pathname = location.pathname;
  useArtifactBackSettled(location.key);

  // A write from a page the browser has left (a close landing after Back) would bring it back.
  const write = useCallback((next: ArtifactAddressWrite | null) => {
    if (entry().pathname !== pathname) return;
    writeArtifactAddress(navigate, next, { key: location.key });
  }, [entry, navigate, pathname, location.key]);
  const writeRef = useRef(write);
  writeRef.current = write;

  const untidy = id !== null && new URLSearchParams(location.search).has(ARTIFACT_OPEN_FROM_PARAM);
  useEffect(() => {
    if (untidy) writeRef.current(artifactAddressTidying(entry(), "search"));
  }, [untidy, entry]);

  const open = useCallback((target: ArtifactLinkTarget, opened: OpenSource) => {
    writeRef.current(artifactAddressOpening(entry(), target, opened, { push: true }));
  }, [entry]);
  const close = useCallback(() => writeRef.current(artifactAddressClosing(entry())), [entry]);
  const showVersion = useCallback((picked: number | null) => writeRef.current(artifactAddressVersion(entry(), picked)), [entry]);

  return useMemo(() => ({ shown, open, close, showVersion }), [shown, open, close, showVersion]);
}
