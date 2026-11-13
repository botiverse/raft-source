import { useEffect, useLayoutEffect, useState } from "react";
import { objectWebPaths } from "@botiverse/raft-shared";
import type { ArtifactCard, ObjectFileId } from "@botiverse/raft-shared";

import api from "../../api/client";
import { artifactReaderScope } from "./artifactReaderScope";

/**
 * The publish check's screenshot of the version a card shows, for the home
 * page's tile (#proj-workspace:#133, design D4, D13) and the message card
 * (#proj-workspace:#172; both through artifactCardPicture.ts
 * useArtifactCardPicture), in the shape Remy specified for the screenshot
 * service: like a cover image, no address in the data, only core object files
 * of the Artifact.
 *
 * Without a screenshot the kind stays `excerpt`, `image` or `none`.
 */
export interface ArtifactScreenshotPreview {
  kind: "screenshot";
  desktop: ObjectFileId;
  phone: ObjectFileId | null;
}

/** The image types core keeps an object file as (webObjectsContract `objectWebPaths.file`). */
const SCREENSHOT_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** Which screenshot a card shows: on a phone its phone shot when there is one, else the desktop one; null without any. */
export function artifactScreenshotFile(card: ArtifactCard, phone: boolean): ObjectFileId | null {
  const preview = card.preview as ArtifactCard["preview"] | ArtifactScreenshotPreview;
  if (preview.kind !== "screenshot" || typeof preview.desktop !== "string" || preview.desktop === "") return null;
  return phone && typeof preview.phone === "string" && preview.phone !== "" ? preview.phone : preview.desktop;
}

/** The API route of that file (the client's base already ends in `/api`). */
export function artifactScreenshotRoute(card: ArtifactCard, fileId: ObjectFileId): string {
  return objectWebPaths.file("artifact", card.id, fileId).replace(/^\/api(?=\/)/, "");
}

// The screenshots read, by reader and file route (#proj-workspace:#182; Kirby on #12998: a card read its ~300 KiB
// shot on every mount, N cards of one Artifact made N reads): one read per file however many cards ask at a time,
// its `blob:` URL shared by every card that shows it and kept for the page's life, the newest MAX_KEPT (at most
// MAX_KEPT_BYTES together) besides those a mounted card holds, as comment images keep theirs (artifactCommentImageUrls.ts). An
// older one's URL is revoked once no card shows it. A read that fails (or isn't an image type) is not kept: it is
// remembered FAILED_MS, so cards mounting meanwhile don't ask again, then read again by the next card that asks.
const MAX_KEPT = 64;
const MAX_KEPT_BYTES = 32 * 1024 * 1024;
const FAILED_MS = 30_000;

type Kept = { url: string; size: number };

const kept = new Map<string, Kept>();
let keptBytes = 0;
/** How many mounted cards show each screenshot: never revoked while one does. */
const held = new Map<string, number>();
const reading = new Map<string, Promise<Kept | null>>();
/** When a read of each failed (FAILED_MS). */
const failedAt = new Map<string, number>();

const keyOf = (route: string) => `${artifactReaderScope() ?? "-"}|${route}`;

const canMakeUrls = () => typeof URL !== "undefined" && typeof URL.createObjectURL === "function";

const retain = (key: string) => held.set(key, (held.get(key) ?? 0) + 1);
function release(key: string) {
  const left = (held.get(key) ?? 1) - 1;
  if (left > 0) held.set(key, left);
  else held.delete(key);
}

/** The kept screenshot is the newest again (`kept` order: the newest last). */
function touch(key: string) {
  const value = kept.get(key);
  if (!value) return;
  kept.delete(key);
  kept.set(key, value);
}

function drop(key: string) {
  const value = kept.get(key);
  if (!value) return;
  kept.delete(key);
  keptBytes -= value.size;
  URL.revokeObjectURL(value.url);
}

function keep(key: string, value: Kept) {
  drop(key);
  kept.set(key, value);
  keptBytes += value.size;
  // The oldest go first, never one a mounted card holds (its picture would break under it).
  for (const oldest of [...kept.keys()]) {
    if (kept.size <= MAX_KEPT && keptBytes <= MAX_KEPT_BYTES) break;
    if (!held.has(oldest)) drop(oldest);
  }
}

function failedLately(key: string): boolean {
  const at = failedAt.get(key);
  if (at === undefined) return false;
  if (Date.now() - at < FAILED_MS) return true;
  failedAt.delete(key);
  return false;
}

/**
 * Reads the screenshot once, however many cards ask at a time (one kept already answers at once); null: the read
 * failed, or wasn't an image type (not kept). The read outlives the card that started it: another may be waiting on
 * it, and a card that is gone drops the answer itself.
 */
function read(key: string, route: string): Promise<Kept | null> {
  const have = kept.get(key);
  if (have) return Promise.resolve(have);
  if (failedLately(key)) return Promise.resolve(null);
  const known = reading.get(key);
  if (known) return known;
  const answer = api.get<Blob>(route, { responseType: "blob" }).then(
    ({ data }): Kept | null => (
      data instanceof Blob && SCREENSHOT_TYPES.has(data.type.split(";")[0]!.trim().toLowerCase()) && canMakeUrls()
        ? { url: URL.createObjectURL(data), size: data.size }
        : null
    ),
    (): null => null,
  ).then((value) => {
    if (value) keep(key, value);
    else failedAt.set(key, Date.now());
    return value;
  }).finally(() => reading.delete(key));
  reading.set(key, answer);
  return answer;
}

/** How far outside its scroller a card's screenshot is read ahead, so it is there as it scrolls in. */
const NEAR_MARGIN = "160px";

/**
 * The nearest ancestor that scrolls `element` vertically (the timeline's scroller, the home page's): the
 * observer's root, so NEAR_MARGIN reaches past its edges (with the viewport as root, the margin grows only the
 * viewport and the scroller still clips at its own edge). Null (the viewport) when none scrolls yet: then all of
 * it is on screen or clipped by the page.
 */
function scrollRootOf(element: Element): Element | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

/**
 * Whether `target` has come within NEAR_MARGIN of the screen for `key` (once it has, it stays so for that key):
 * one IntersectionObserver until it does. Without IntersectionObserver (old WebViews), at once.
 */
function useNearScreen(target: Element | null, key: string | null): boolean {
  const [nearKey, setNearKey] = useState<string | null>(null);
  const near = key !== null && (nearKey === key || typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (key === null || near || !target || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setNearKey(key);
      observer.disconnect();
    }, { root: scrollRootOf(target), rootMargin: NEAR_MARGIN });
    observer.observe(target);
    return () => observer.disconnect();
  }, [key, near, target]);
  return near;
}

/**
 * The screenshot as a `blob:` URL: its bytes read through Raft's API client (the route needs the session and the
 * server, so no plain `<img src>`), only an image type, from the shared cache above. It is read once the card
 * (`target`) comes within NEAR_MARGIN of the screen; one kept already is shown at once, wherever the card is. `src`
 * is null until then, while it loads, without a screenshot, and when it can't be read (D13: a screenshot that fails
 * reads as none; no spinner, no error); `loading` is true from the start until it is read or fails, off screen
 * too: the card data already says there is one, so a card keeps its place for it (a message card growing as it
 * comes into view would move the conversation).
 */
export function useArtifactScreenshotSrc(card: ArtifactCard, phone: boolean, target: Element | null): { src: string | null; loading: boolean } {
  const fileId = artifactScreenshotFile(card, phone);
  const route = fileId ? artifactScreenshotRoute(card, fileId) : null;
  const key = route ? keyOf(route) : null;
  const near = useNearScreen(target, key);
  // What this card's read answered, by key (a new value each time, so the card draws again); a URL is always the cache's.
  const [answered, setAnswered] = useState<{ key: string; ok: boolean } | null>(null);
  // A kept one is already there: the card holds it while mounted, so it isn't revoked under it. Held in a layout
  // effect, before the browser paints the URL: in a passive effect another read finishing between the paint and the
  // hold could evict this one and revoke a URL the card already shows (Kirby, #13046).
  const shown = key ? kept.get(key)?.url ?? null : null;
  useLayoutEffect(() => {
    if (!key) return;
    retain(key);
    touch(key);
    return () => release(key);
  }, [key]);
  useEffect(() => {
    if (!key || !route || !near) return;
    let live = true;
    void read(key, route).then((value) => {
      if (live) setAnswered({ key, ok: value !== null });
    });
    return () => {
      live = false;
    };
  }, [key, route, near]);
  if (shown) return { src: shown, loading: false };
  const failed = answered !== null && answered.key === key && !answered.ok;
  return { src: null, loading: key !== null && !failed };
}

/** For tests: nothing kept, held, read or failed (the cache is module-level: one test's reads would answer the next's). */
export function resetArtifactScreenshotsForTests() {
  for (const value of kept.values()) if (canMakeUrls()) URL.revokeObjectURL(value.url);
  kept.clear();
  keptBytes = 0;
  held.clear();
  reading.clear();
  failedAt.clear();
}
