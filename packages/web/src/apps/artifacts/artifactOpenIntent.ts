import { useMemo } from "react";
import type { FocusEvent, PointerEvent } from "react";
import { currentTimeMs, isArtifactFramedKind } from "@botiverse/raft-shared";
import type { ArtifactCard, ArtifactId } from "@botiverse/raft-shared";

import { objectRefKey, peekObjectSummaries } from "../../objects/objectSummaryLoader";
import { artifactObjectRefOf } from "./apiArtifactSource";
import { artifactReaderScope } from "./artifactReaderScope";
import type { ArtifactLinkTarget } from "./artifactLinks";
import { artifactContentOrigin } from "./artifactContentDomain";
import { prefetchArtifactViewer } from "./artifactSource";
import { preloadArtifactViewerCode } from "./artifactViewerChunk";

/**
 * What can start before an Artifact's viewer has its data, once the reader
 * shows they are about to open one (docs/development/workspace-artifacts.md,
 * "Opening an Artifact quickly").
 *
 * The content origin's name: every Artifact has its own content origin
 * (`w-<uuid>.<content domain>`, ArtifactFrame), so a first open looks it up
 * only after the frame route answered. It is resolved as soon as the id is
 * known on intent (pressing a card, hovering it a moment, focusing it) and
 * when a viewer opens, never for every card on screen.
 *
 * The viewer read: a mouse or pen press on an opener starts GET
 * /api/artifacts/:id (prefetchArtifactViewer, artifactSource.ts) before the
 * click that opens it, and the viewer uses that read.
 *
 * The card: the opener already shows the Artifact's card (its title,
 * version, where it lives), so the viewer draws its header from it while its
 * own data loads (artifactCardSeed), instead of a bare "Loading Artifact".
 */

/** At most this many content origins keep a hint in the page; the oldest go first. */
const DNS_PREFETCH_MAX = 6;

const prefetched = new Map<string, HTMLLinkElement>();

/**
 * Resolves this Artifact's content origin ahead of its frame: one
 * `dns-prefetch` per origin, at most DNS_PREFETCH_MAX origins. No
 * `preconnect`: the frame's document is a cross-site subframe navigation, in
 * another network partition than this page, so a socket opened from here was
 * never the one it used (staging, 2026-10-28: the content connect cost the
 * same with or without it). The resolved name is cached below the partition.
 * Nothing without a content domain (artifactContentDomain's artifactContentOrigin).
 */
export function prefetchArtifactContentDns(id: ArtifactId): void {
  if (typeof document === "undefined") return;
  const origin = artifactContentOrigin(id);
  if (!origin || prefetched.has(origin)) return;
  const link = document.createElement("link");
  link.rel = "dns-prefetch";
  link.href = origin;
  document.head.appendChild(link);
  prefetched.set(origin, link);
  for (const [oldest, hint] of prefetched) {
    if (prefetched.size <= DNS_PREFETCH_MAX) break;
    hint.remove();
    prefetched.delete(oldest);
  }
}

/** At most this many cards are kept for the viewers they open; the oldest go first. */
const CARD_SEEDS_MAX = 50;
/**
 * A remembered card is used by a viewer that opens within this long, in the
 * server it was seen in: it stands in for the header while the viewer loads,
 * so it must be what this reader just saw, not what a card said a while ago
 * (or in another server, or to another person: artifactReaderScope).
 */
const CARD_SEED_TTL_MS = 60_000;

const cardSeeds = new Map<string, { card: ArtifactCard; scope: string | null; at: number }>();

function seedKey(id: ArtifactId, version: number | null): string {
  return `${id}@${version ?? "latest"}`;
}

function keepSeed(key: string, card: ArtifactCard): void {
  cardSeeds.delete(key);
  cardSeeds.set(key, { card, scope: artifactReaderScope(), at: currentTimeMs() });
}

/**
 * The card an opener showed for the Artifact it opens (a message's card, a
 * Files or Activity row): the viewer's header until the viewer's own data is
 * in. Kept by the version it shows, and as the latest when it is.
 */
export function rememberArtifactCard(card: ArtifactCard): void {
  keepSeed(seedKey(card.id, card.version), card);
  if (card.version === card.latestVersion) keepSeed(seedKey(card.id, null), card);
  for (const oldest of cardSeeds.keys()) {
    if (cardSeeds.size <= CARD_SEEDS_MAX) break;
    cardSeeds.delete(oldest);
  }
}

/**
 * The card the page already has for `target`, at the version it opens: one
 * an opener remembered, else the message link's answer core's object
 * summaries loader keeps (a chip in a message's text). Never asks anything.
 */
export function artifactCardSeed(target: ArtifactLinkTarget): ArtifactCard | null {
  const remembered = cardSeeds.get(seedKey(target.id, target.version));
  const scope = artifactReaderScope();
  if (remembered && scope !== null && remembered.scope === scope && currentTimeMs() - remembered.at < CARD_SEED_TTL_MS) return remembered.card;
  const ref = artifactObjectRefOf(target);
  const kept = peekObjectSummaries(null, "artifact", [ref])?.get(objectRefKey(ref));
  return kept?.status === "ok" ? kept.summary : null;
}

/** Tests only: forget what was prefetched and remembered, and take the hints out of the page. */
export function resetArtifactOpenIntentForTests(): void {
  for (const link of prefetched.values()) link.remove();
  prefetched.clear();
  cardSeeds.clear();
  clearHoverTimer();
}

/** A hover is intent only after this long: passing over a card on the way elsewhere warms nothing. */
const HOVER_INTENT_MS = 100;

// One pointer hovers one card at a time, so one timer serves every card.
let hoverTimer: ReturnType<typeof setTimeout> | null = null;

function clearHoverTimer(): void {
  if (hoverTimer !== null) clearTimeout(hoverTimer);
  hoverTimer = null;
}

export interface ArtifactOpenIntentHandlers {
  onPointerEnter: (event: PointerEvent<HTMLElement>) => void;
  onPointerLeave: () => void;
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onFocus: (event: FocusEvent<HTMLElement>) => void;
}

/**
 * The handlers an opener of an Artifact (a card, a Files or Activity row)
 * spreads on the element that opens it:
 * - pressing it (any pointer), hovering it with a mouse for HOVER_INTENT_MS,
 *   or focusing it loads the viewer's code and warms the content connection;
 * - a plain primary press with a mouse or pen also starts the viewer read
 *   (prefetchArtifactViewer): the click follows it. Not a touch, which is as
 *   often the start of a scroll, and the read moves the read position.
 * `card`, where the opener has it, says the kind: one that isn't framed (an
 * image, csv, text) loads nothing from the content origin. Null `target`:
 * no handlers do anything.
 */
export function useArtifactOpenIntent(target: ArtifactLinkTarget | null, card: ArtifactCard | null = null): ArtifactOpenIntentHandlers {
  const id = target?.id ?? null;
  const version = target?.version ?? null;
  const framed = card === null || isArtifactFramedKind(card.kind);
  return useMemo(() => {
    const warm = () => {
      if (id === null) return;
      preloadArtifactViewerCode(framed);
      if (framed) prefetchArtifactContentDns(id);
    };
    return {
      onPointerEnter: (event) => {
        if (event.pointerType !== "mouse") return;
        clearHoverTimer();
        // A timer, not the event: only a pointer that stays a moment is intent.
        hoverTimer = setTimeout(() => {
          hoverTimer = null;
          warm();
        }, HOVER_INTENT_MS);
      },
      onPointerLeave: clearHoverTimer,
      onPointerDown: (event) => {
        clearHoverTimer();
        warm();
        const plain = event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
        if (id !== null && plain && (event.pointerType === "mouse" || event.pointerType === "pen")) prefetchArtifactViewer({ id, version });
      },
      onFocus: warm,
    };
  }, [id, version, framed]);
}
