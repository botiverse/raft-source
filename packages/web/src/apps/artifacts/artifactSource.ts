import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { currentTimeMs } from "@botiverse/raft-shared";

import { invalidateObjectSummary, invalidateObjectSummaryRef, loadObjectSummaries, objectRefKey, peekObjectSummaries, subscribeObjectSummaryInvalidation } from "../../objects/objectSummaryLoader";
import type { ObjectSummaryInvalidation, ObjectSummaryResult, ObjectSummaryResults } from "../../objects/objectSummaryLoader";
import { useObjectSummaries } from "../../objects/useObjectSummaries";
import { showObjectReadWhereShown } from "../../objects/objectRead";
import { useServerStore } from "../../store/serverStore";
import { apiArtifactSource, artifactObjectRefOf } from "./apiArtifactSource";
import { fakeArtifactSourceSlot } from "./fakeArtifactSourceSlot";
import type { FakeAttachment, FakeAttachmentSavedEvent } from "./fakeArtifactSource";
import type { ArtifactCard, ArtifactId, ArtifactReference, ArtifactVersionSummary, ArtifactViewerData } from "@botiverse/raft-shared";
import type { ArtifactLinkTarget } from "./artifactLinks";
import { artifactReaderScope } from "./artifactReaderScope";
import { clearDashboardPages } from "./artifactDashboardCache";
import { withoutViewerFrame } from "./artifactViewerFrame";
import type { ArtifactFileTarget, ArtifactSource, ArtifactViewerResult } from "./artifactApi";

export type { ArtifactFileTarget, ArtifactSource, ArtifactViewerResult } from "./artifactApi";

/**
 * What the fake data source answers besides an ArtifactSource, for core's
 * stand-ins while it is the source (realtime, anchor status, saved
 * attachments): fakeArtifactSource.ts installs it with the source.
 */
export interface FakeArtifactStandIns {
  savedAsFor: (attachmentId: string) => ArtifactReference | null;
  onAttachmentSaved: (listener: (event: FakeAttachmentSavedEvent) => void) => () => void;
  annotationLost: (commentId: string) => boolean;
  rememberAttachment: (attachment: FakeAttachment) => void;
}

/** The fake data source and its stand-ins (fakeArtifactSource.ts). */
export interface FakeArtifactEntry {
  source: ArtifactSource;
  standIns: FakeArtifactStandIns;
}

/**
 * Raft's web API (apiArtifactSource), only read behind workspace_artifacts_v0.
 * The fake answers instead in tests, and in a dev build with
 * VITE_ARTIFACTS_SOURCE=fake (the web alone, without a server that has the
 * routes; its framed versions come from scripts/fake-artifact-content.ts).
 * No production module imports the fake, so it is not in a production
 * bundle. Tests get it here, when this module first loads, through the
 * fakeArtifactSourceSlot alias (vitest.config.ts; the slot is null
 * everywhere else); the fake dev build installs it from main.tsx before the
 * first render (installFakeArtifactSourceForDev).
 */
let fake: FakeArtifactEntry | null = fakeArtifactSourceSlot;

let source: ArtifactSource = import.meta.env.MODE === "test" && fake ? fake.source : apiArtifactSource;

/**
 * The fake dev build (VITE_ARTIFACTS_SOURCE=fake): loads the fake and makes
 * it the source. main.tsx awaits it before the first render, so boot reads
 * (openArtifactFromDevice) already answer from the fake. Any other build drops
 * the import.
 */
export async function installFakeArtifactSourceForDev(): Promise<void> {
  if (!(import.meta.env.DEV === true && import.meta.env.MODE !== "test" && import.meta.env.VITE_ARTIFACTS_SOURCE === "fake")) return;
  const { fakeArtifactEntry } = await import("./fakeArtifactSource");
  fake = fakeArtifactEntry;
  source = fakeArtifactEntry.source;
  viewerIntents.clear();
}

/** Tests swap the source; null restores the fake. */
export function setArtifactSourceForTests(next: ArtifactSource | null): void {
  source = next ?? fake?.source ?? apiArtifactSource;
  viewerIntents.clear();
  clearDashboardPages();
}

export function artifactSource(): ArtifactSource {
  return source;
}

/**
 * Deletes it, then this page's cards for it read it again, so they turn into
 * the deleted card at once; other people's change on their next read.
 */
export async function deleteArtifactHere(id: ArtifactId): Promise<void> {
  await source.deleteArtifact(id);
  invalidateObjectSummary("artifact", id);
}

/**
 * Gives it a new title (task #147), then this page's cards for it read it
 * again, so they show the new title; other people's on their next read.
 */
export async function renameArtifactHere(id: ArtifactId, title: string): Promise<ArtifactViewerData> {
  const next = await source.setTitle(id, title);
  invalidateObjectSummary("artifact", id);
  return next;
}

/**
 * True only while the fake data source itself is active (not a test double,
 * not the API source), so the fake's stand-ins (realtime, anchor status,
 * saved attachments) never reach a real data source.
 */
export function usingFakeArtifactSource(): boolean {
  return fake !== null && source === fake.source;
}

/** The fake's stand-ins, while it is the source (usingFakeArtifactSource); null otherwise. */
export function fakeArtifactStandIns(): FakeArtifactStandIns | null {
  return fake !== null && source === fake.source ? fake.standIns : null;
}

/** Loads `load()` for `key`; null while it loads (a failed load stays null). */
function useKeyedLoad<T>(key: string | null, load: () => Promise<T>): T | null {
  const [loaded, setLoaded] = useState<{ key: string; value: T } | null>(null);
  // The loader for the current key; the key alone decides when to reload.
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (key === null) return;
    let cancelled = false;
    void loadRef.current().then((value) => {
      if (!cancelled) setLoaded({ key, value });
    }, () => {});
    return () => { cancelled = true; };
  }, [key]);
  return loaded && loaded.key === key ? loaded.value : null;
}

/** A stand-in source's failed answer: each link `error`, as a failed summaries request is. */
const STAND_IN_FAILED: ObjectSummaryResult<"artifact"> = { status: "error", error: { status: null, code: null }, retryAfterMs: null };

/**
 * The answers for the Artifacts a message's links name (`targets`: its
 * visible bare links that are Artifacts, in order, as core's per-message
 * link-card hook found them, components/message/useMessageLinkCards.ts), by
 * `objectRefKey(artifactObjectRefOf(target))`: `ok` with the card,
 * `deleted` (read by artifactLinkOf), `unavailable`, or `error`. Null until every one is answered. The message's
 * one read for them: its chips and the cards under it draw from it.
 *
 * - API source: core's useObjectSummaries as it is (the page's batching, its
 *   cache, invalidation and 429 waits; nothing is added here).
 * - `enabled` false (the row hasn't been on screen yet): nothing is asked.
 *   Answers the page already keeps are drawn (peekObjectSummaries, which
 *   never asks), so a row mounted again in view shows its cards at once.
 * - A source marked `stand-in` (the fake, test doubles) answers through its
 *   own `getMessageArtifactRefs` instead; a failed one is `error` for each
 *   link. An `api` source never does, whatever methods it has.
 */
export function useArtifactLinkSummaries(targets: readonly ArtifactLinkTarget[], enabled: boolean): ObjectSummaryResults<"artifact"> | null {
  // An explicit marker, not the method's presence: an `api` source always goes through the loader.
  const standIn = source.kind === "stand-in" ? source : null;
  const asks = targets.length > 0;
  const refs = useMemo(() => targets.map(artifactObjectRefOf), [targets]);
  const summaries = useObjectSummaries("artifact", refs, { enabled: enabled && asks && !standIn });
  const kept = !standIn && asks && !enabled ? peekObjectSummaries(null, "artifact", refs) : null;

  const key = standIn && enabled && asks ? targets.map((t) => `${t.id}@${t.version ?? "latest"}`).join(",") : null;
  const answered = useKeyedLoadWithError(key ?? "", () => standIn?.getMessageArtifactRefs?.([...targets]) ?? Promise.resolve([]), key !== null);
  const fromStandIn = useMemo(() => {
    if (!standIn || answered === null) return null;
    return new Map(refs.map((ref, index): [string, ObjectSummaryResult<"artifact">] => {
      const reference = answered?.[index];
      if (!reference) return [objectRefKey(ref), answered === undefined ? STAND_IN_FAILED : { status: "unavailable" }];
      if (reference.status === "ok") return [objectRefKey(ref), { status: "ok", summary: reference.card }];
      // Any other status (one this client doesn't know, revoked) is unavailable.
      return [objectRefKey(ref), reference.status === "deleted" ? { status: "deleted", deleted: reference } : { status: "unavailable" }];
    }));
  }, [standIn, answered, refs]);

  if (!asks) return null;
  return standIn ? fromStandIn : summaries ?? kept;
}

/**
 * The viewer's data, as it moves between an Artifact's versions (its version history):
 * - `loading`: nothing in yet;
 * - `unavailable`: the first version it opened at can't be opened (the one "can't open" state);
 * - `ok`: the last version that loaded, with `switching` while `target` loads and `failed`
 *   when `target` couldn't be loaded, so the viewer keeps its frame, comments and focus and
 *   can offer a way back. `attempt` loads `target` again (Retry).
 */
export type ArtifactViewerState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "ok"; data: ArtifactViewerData; switching: boolean; failed: boolean };

/**
 * A viewer read started on intent (a mouse or pen pressing an opener, before
 * its click: artifactOpenIntent) is used by the viewer that opens within this
 * long; older, it is not used (well inside a frame ticket's 60 s, should the
 * viewer data ever carry one).
 */
const VIEWER_INTENT_TTL_MS = 10_000;
/** At most this many viewer reads wait for their viewer; the oldest go first. */
const VIEWER_INTENTS_MAX = 4;

// Each read is the server's answer for the reader asking in it, so it is used only by that reader there (artifactReaderScope).
const viewerIntents = new Map<string, { source: ArtifactSource; scope: string | null; at: number; answer: Promise<ArtifactViewerResult> }>();

/**
 * One viewer read. The answer's frame ticket (`ArtifactViewerData.frame`) is
 * taken out as it arrives and held for that version's first frame
 * (artifactViewerFrame): it never stays in the data a viewer keeps. At the
 * latest version the route moved the reader's read position (opening it is
 * looking at everything up to now), so its Activity row shows read at once,
 * not on the next inbox answer, and this page's cards of it read it again:
 * their `unseen` marks (new version, new comments) were from before (the
 * route tells no other tab: their marks go on their next read).
 */
function readViewer(target: ArtifactLinkTarget): Promise<ArtifactViewerResult> {
  return source.viewer(target).then((result) => {
    if (result.status !== "ok") return result;
    const { card } = result.data;
    if (card.version === card.latestVersion) {
      showObjectReadWhereShown("artifact", card.id);
      if (source.kind === "api") invalidateObjectSummary("artifact", card.id);
    }
    return { status: "ok", data: withoutViewerFrame(result.data) };
  });
}

/** Which read of the viewer an answer is: the Artifact and the version asked for (`latest` for none). */
export const viewerKey = (target: ArtifactLinkTarget) => `${target.id}@${target.version ?? "latest"}`;

/**
 * Viewer data already known for one read (`key`, viewerKey of its target):
 * the canonical link's `open` answer, its frame ticket already taken out.
 * The viewer route's own answer, so the first screen asks nothing again.
 */
export interface ArtifactViewerSeed {
  key: string;
  data: ArtifactViewerData;
}

/** Seeds a viewer has taken: each serves one mount only, so a remount handed the same one reads. */
const takenSeeds = new WeakSet<ArtifactViewerSeed>();

/** `seed`'s data for the viewer mounting at `target` and `attempt`, once per seed: null when it isn't for them or was taken. */
function takeSeed(seed: ArtifactViewerSeed | null, target: ArtifactLinkTarget, attempt: number): ArtifactViewerData | null {
  if (seed === null || attempt !== 0 || seed.key !== viewerKey(target) || takenSeeds.has(seed)) return null;
  takenSeeds.add(seed);
  return seed.data;
}

function freshViewerIntent(key: string) {
  const known = viewerIntents.get(key);
  const scope = artifactReaderScope();
  return known && known.source === source && scope !== null && known.scope === scope && currentTimeMs() - known.at < VIEWER_INTENT_TTL_MS ? known : null;
}

/**
 * Starts the viewer read for `target` ahead of its viewer (pressing a card,
 * before the click opens it), once per id@version while fresh. The viewer
 * that then opens uses this read instead of asking again; an intent that
 * comes to nothing (dragged away, cancelled) leaves an answer nobody uses.
 * The read is the viewer route's own, so it moves the read position as
 * opening does: only a mouse or pen press starts one, never a touch (which
 * is as often the start of a scroll).
 */
export function prefetchArtifactViewer(target: ArtifactLinkTarget): void {
  const key = viewerKey(target);
  if (freshViewerIntent(key)) return;
  const answer = readViewer(target);
  answer.catch(() => {});
  viewerIntents.delete(key);
  viewerIntents.set(key, { source, scope: artifactReaderScope(), at: currentTimeMs(), answer });
  for (const oldest of viewerIntents.keys()) {
    if (viewerIntents.size <= VIEWER_INTENTS_MAX) break;
    viewerIntents.delete(oldest);
  }
}

/**
 * The read a viewer opening uses: the one an intent started for it, else a
 * new one. An intent's read serves this opening only: once it has answered it
 * is forgotten, so a later opening reads again (a remount while it is still
 * on its way, as a strict-mode double mount, shares it).
 */
function viewerReadFor(target: ArtifactLinkTarget): Promise<ArtifactViewerResult> {
  const key = viewerKey(target);
  const known = freshViewerIntent(key);
  if (!known) return readViewer(target);
  const forget = () => {
    if (viewerIntents.get(key) === known) viewerIntents.delete(key);
  };
  known.answer.then(forget, forget);
  return known.answer;
}

/** How long the viewer waits for its read before showing it as failed (with Retry). */
export const VIEWER_READ_TIMEOUT_MS = 15_000;

/**
 * The viewer's data for `target`, read again for each `attempt` (Retry).
 * `seed`: data already known for the target it mounts with (the canonical
 * link's `open`), used once instead of the first read: only at mount, only at
 * attempt 0, only while it shows that target, and by one mount only. A
 * version switch, Retry, a switch back to the seeded version and a remount
 * read the viewer route.
 */
export function useArtifactViewer(target: ArtifactLinkTarget, attempt = 0, seed: ArtifactViewerSeed | null = null): ArtifactViewerState {
  const key = `${viewerKey(target)}#${attempt}`;
  // Decided once, at mount (React keeps the initializer's first answer, strict mode's second call is dropped).
  const [seeded] = useState(() => {
    const data = takeSeed(seed, target, attempt);
    return data ? { key, data } : null;
  });
  const [answers, setAnswers] = useState<{ last: { key: string; ok: boolean } | null; good: ArtifactViewerData | null }>(() => (
    seeded ? { last: { key: seeded.key, ok: true }, good: seeded.data } : { last: null, good: null }
  ));
  // Whether the seeded key is still the one shown since mount; once another shows, it is read like any other.
  const seedShown = useRef(seeded !== null);
  const targetRef = useRef(target);
  targetRef.current = target;
  const showingRef = useRef(answers.good !== null);
  showingRef.current = answers.good !== null;
  useEffect(() => {
    if (seedShown.current && key === seeded?.key) return;
    seedShown.current = false;
    let cancelled = false;
    const answer = (data: ArtifactViewerData | null) => {
      if (cancelled) return;
      setAnswers((prev) => ({ last: { key, ok: data !== null }, good: data ?? prev.good }));
    };
    // Where content is already shown (a version switch, View latest, Retry), a read that hasn't
    // answered in VIEWER_READ_TIMEOUT_MS counts as failed: the shown content stays, with Retry,
    // instead of a loading line nothing ends (a stalled request has no timeout). A first read
    // keeps loading: failing it would say the Artifact can't be opened.
    const timer = showingRef.current ? setTimeout(() => answer(null), VIEWER_READ_TIMEOUT_MS) : undefined;
    const settle = (data: ArtifactViewerData | null) => {
      clearTimeout(timer);
      answer(data);
    };
    // The first attempt takes a read an intent started for it; Retry always reads again.
    (attempt === 0 ? viewerReadFor(targetRef.current) : readViewer(targetRef.current)).then((result) => settle(result.status === "ok" ? result.data : null), () => settle(null));
    return () => { cancelled = true; clearTimeout(timer); };
  }, [key, attempt, seeded]);
  const { last, good } = answers;
  if (!good) return last ? { status: "unavailable" } : { status: "loading" };
  const answered = last?.key === key;
  return { status: "ok", data: good, switching: !answered, failed: answered && !last.ok };
}

/** How often an open Artifact asks whether a newer version is out, while the page is visible. */
export const ARTIFACT_LATEST_POLL_MS = 60_000;

/** A version newer than the one the surface knows as the latest: its number, and who published it (null: not known). */
export interface ArtifactNewerVersion {
  version: number;
  publisher: string | null;
}

/** The card a stand-in answers for `target`; null when it isn't `ok`. A failed read rejects. */
async function standInCard(target: ArtifactLinkTarget): Promise<ArtifactCard | null> {
  const [reference] = await (source.getMessageArtifactRefs?.([target]) ?? Promise.resolve([]));
  return reference?.status === "ok" ? reference.card : null;
}

/** The card the object summaries route answers for `target` (core's loader, its cache and batching); null when it isn't `ok`. A failed request rejects. */
async function summaryCard(target: ArtifactLinkTarget): Promise<ArtifactCard | null> {
  const ref = artifactObjectRefOf(target);
  const answer = (await loadObjectSummaries(null, "artifact", [ref])).get(objectRefKey(ref));
  if (!answer || answer.status === "error") throw new Error("object summaries request failed");
  return answer.status === "ok" ? answer.summary : null;
}

const cardReader = () => (source.kind === "stand-in" ? standInCard : summaryCard);

/**
 * The latest version of `id`, read where nothing moves (never the viewer
 * route, which moves the read position): the Artifact's card as a link to
 * the latest names it. Null when the card isn't answered.
 */
async function readLatestVersion(id: ArtifactId): Promise<number | null> {
  return (await cardReader()({ id, version: null }))?.latestVersion ?? null;
}

/** Who published `version`: that version's own card (a pinned card names its publisher, webCards.ts); null when not known. Rejects when the read failed. */
async function readPublisher(id: ArtifactId, version: number): Promise<string | null> {
  return (await cardReader()({ id, version }))?.author.displayName || null;
}

/** Whether an invalidation of the page's summaries covers this Artifact in the current server. */
function coversArtifact(change: ObjectSummaryInvalidation, id: ArtifactId): boolean {
  if (change.kind !== undefined && change.kind !== "artifact") return false;
  if (change.id !== undefined && change.id !== id) return false;
  const current = useServerStore.getState().current?.id ?? null;
  return change.serverId === undefined || change.serverId === null || change.serverId === current;
}

const pageHidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

/**
 * A version of `card`'s Artifact newer than its `latestVersion` (as the
 * surface loaded it), once one is published; null while there is none. There
 * is no per-Artifact realtime event, so it asks, without side effects:
 * - every ARTIFACT_LATEST_POLL_MS while the page is visible (none while hidden);
 * - when the page becomes visible again (not on window focus: focus comes
 *   back from the content's frame every time the reader clicks out of it);
 * - at once on `activity:changed` for the current server (the socket bridge
 *   invalidates that server's summaries; any invalidation that covers it).
 * Through the API, an ask invalidates only the Artifact's latest card (the
 * bare links' cards on the page read again with it, in the same request;
 * pinned versions' stay kept) and the read follows the invalidation; a
 * stand-in source is read directly. Who published a version is read once per
 * version (kept for the mount), so a poll after the notice is one request.
 */
export function useArtifactNewerVersion(card: Pick<ArtifactCard, "id" | "latestVersion">): ArtifactNewerVersion | null {
  const { id, latestVersion: known } = card;
  const [found, setFound] = useState<{ id: ArtifactId; newer: ArtifactNewerVersion } | null>(null);
  /** Who published each version, by `id@version`, once answered. */
  const publishers = useRef(new Map<string, string | null>());
  useEffect(() => {
    let cancelled = false;
    const read = () => {
      if (pageHidden()) return;
      void readLatestVersion(id).then(async (latest) => {
        if (cancelled || latest === null || latest <= known) return;
        const key = `${id}@${latest}`;
        if (!publishers.current.has(key)) {
          const publisher = await readPublisher(id, latest).catch(() => undefined);
          if (publisher === undefined) {
            // Not answered: the number now, the name on a later ask.
            if (!cancelled) setFound((last) => (last?.id === id && last.newer.version === latest ? last : { id, newer: { version: latest, publisher: null } }));
            return;
          }
          publishers.current.set(key, publisher);
        }
        if (cancelled) return;
        const publisher = publishers.current.get(key) ?? null;
        setFound((last) => (last?.id === id && last.newer.version === latest && last.newer.publisher === publisher ? last : { id, newer: { version: latest, publisher } }));
      }, () => {});
    };
    const ask = () => {
      if (pageHidden()) return;
      if (source.kind === "api") invalidateObjectSummaryRef(null, "artifact", artifactObjectRefOf({ id, version: null }));
      else read();
    };
    const onVisibility = () => {
      if (!pageHidden()) ask();
    };
    const unsubscribe = subscribeObjectSummaryInvalidation((change) => {
      if (coversArtifact(change, id)) read();
    });
    const timer = setInterval(ask, ARTIFACT_LATEST_POLL_MS);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      unsubscribe();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [id, known]);
  return found && found.id === id && found.newer.version > known ? found.newer : null;
}

/** How long the new version strip waits for the version's note before it says the news without one. */
export const VERSION_NOTE_WAIT_MS = 1_000;

/**
 * A version's summary (its note and changed files) the surface's data doesn't list yet: the new
 * version strip's (ArtifactNewVersionNotice), read once per version while it is shown, from the
 * details route (no ticket, no read position moved).
 *
 * `undefined` while the read is out, for at most VERSION_NOTE_WAIT_MS: the strip waits that long so
 * it says its news once, in its final words (a status that changed when the note came in would be
 * read out twice). Then the summary, or null: no summary (the read failed, the source has no
 * `versionSummary`, or it took longer than the wait; an answer after the wait is dropped, so the
 * words never change under the reader).
 */
export function useArtifactVersionSummary(id: ArtifactId, version: number): ArtifactVersionSummary | null | undefined {
  const key = `${id}@${version}`;
  const [answer, setAnswer] = useState<{ key: string; summary: ArtifactVersionSummary | null } | null>(null);
  const offered = source.versionSummary !== undefined;
  useEffect(() => {
    const reading = source.versionSummary?.({ id, version });
    if (!reading) return;
    let settled = false;
    const settle = (summary: ArtifactVersionSummary | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      setAnswer({ key, summary });
    };
    const timer = setTimeout(() => settle(null), VERSION_NOTE_WAIT_MS);
    void reading.then(settle, () => settle(null));
    return () => {
      settled = true;
      clearTimeout(timer);
    };
  }, [id, version, key, offered]);
  if (!offered) return null;
  return answer?.key === key ? answer.summary : undefined;
}

/**
 * Who reads a file's text and bytes for what Raft draws itself (text, a csv, an image): the
 * signed-in source, unless what is around it gives its own. The public page does
 * (PublicArtifactDrawn): a visitor reads the signed-out file route, where the signed-in one
 * answers no one.
 */
export type ArtifactFileReader = Pick<ArtifactSource, "readText" | "readBytes">;
export const ArtifactFileReaderContext = createContext<ArtifactFileReader | null>(null);

export function useArtifactFileText(file: ArtifactFileTarget): string | null | undefined {
  const reader = useContext(ArtifactFileReaderContext);
  return useKeyedLoadWithError(`${file.id}@${file.version}/${file.path}`, () => (reader ?? source).readText(file));
}

/** Like useKeyedLoad, but a failure is `undefined` (null still means loading). */
function useKeyedLoadWithError<T>(key: string, load: () => Promise<T>, enabled = true): T | null | undefined {
  const value = useKeyedLoad<{ ok: true; value: T } | { ok: false }>(enabled ? key : null, () => load().then(
    (v) => ({ ok: true as const, value: v }),
    () => ({ ok: false as const }),
  ));
  if (!value) return null;
  return value.ok ? value.value : undefined;
}

export { useKeyedLoadWithError };
