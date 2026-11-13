import { createContext, createElement, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { appLinkBlockCardLayout, messageVisibleLinks, publicPreviewUrl } from "@botiverse/raft-shared/src/appLinkPreview";

import { artifactLinkOf, artifactObjectRefOf, useArtifactLinkSummaries, useArtifactLinkTargets } from "../../apps/artifacts";
import type { ArtifactLink, ArtifactLinkTarget } from "../../apps/artifacts";
import { objectRefKey } from "../../objects/objectSummaryLoader";
import { useAuthStore } from "../../store/authStore";
import { useServerStore } from "../../store/serverStore";
import { useAppLinkPreviews } from "./useAppLinkPreviews";
import type { AppLinkResult } from "./useAppLinkPreviews";

/** A first-party object's link (an Artifact): its object reference's answer from core's summaries. */
export type ObjectLinkCard = { kind: "object"; url: string } & ArtifactLink;

/**
 * One link of a message and what it shows, by kind:
 * - `app`: a third-party App's link (`data`: the link-card read's result,
 *   useAppLinkPreviews; `state` is its kind: card, connect_account, consent,
 *   pending). A link with no App result has no entry: the author's link.
 * - `object`: a first-party object's link (`state`: loading, ok, deleted,
 *   unavailable or error; `data`: the reference and, when ok, its summary).
 *   `ok` is a chip and `deleted` a dimmed one that opens nothing; the others
 *   stay the author's link.
 */
export type MessageLinkCard =
  | { kind: "app"; url: string; state: AppLinkResult["kind"]; data: AppLinkResult }
  | ObjectLinkCard;

/** An App link's result whose card is drawn in the message (a version 3 block card). */
export type AppLinkBlockResult = Extract<AppLinkResult, { kind: "card" }>;

/**
 * The version 3 block cards of a message (RFC 076 §14; DS Navigation › Block
 * cards), by address: the links of its own text whose answer lists a block
 * card, at the places appLinkBlockCardLayout gives (a paragraph or a list
 * item, not the author's quote, a table or a heading; each address once),
 * MESSAGE_BLOCK_CARD_LIMIT at most, in the order of its own text.
 */
export type MessageAppLinkBlocks = ReadonlyMap<string, AppLinkBlockResult>;

type BlockLayout = ReturnType<typeof appLinkBlockCardLayout>;
const layouts = new Map<string, BlockLayout>();
/** appLinkBlockCardLayout of a text, kept for the last 200 texts read: the message's and the one its Markdown draws. */
export function appLinkBlockLayout(text: string): BlockLayout {
  const kept = layouts.get(text);
  if (kept) return kept;
  const layout = appLinkBlockCardLayout(text);
  if (layouts.size >= 200) layouts.delete(layouts.keys().next().value!);
  layouts.set(text, layout);
  return layout;
}

export interface MessageLinkCards {
  /** Per link, by its WHATWG href (`messageLinkKey`). */
  links: ReadonlyMap<string, MessageLinkCard>;
  /**
   * The first-party links, one per object reference, in message order: the
   * cards under the message, drawn from the same answers as the chips.
   */
  objects: readonly ObjectLinkCard[];
  blocks: MessageAppLinkBlocks;
}

const NO_LINKS: readonly { href: string; bare: boolean }[] = [];
const NO_BLOCKS: MessageAppLinkBlocks = new Map();

/** At most this many block cards in a message; later links get none (DS Navigation › Block cards). */
export const MESSAGE_BLOCK_CARD_LIMIT = 3;

/**
 * At most this many first-party object references a message reads, after
 * duplicates are dropped, in message order: ten, as the App link read takes
 * (Tenny, #proj-workspace:fbc76200). The links to any more stay the author's
 * links: no chip, no card, and still not an App's.
 */
export const MESSAGE_OBJECT_LINK_LIMIT = 10;

/** The message's visible links, or none (logged) where reading them throws: a message without cards, not a broken conversation. */
function visibleLinksOrNone(content: string): readonly { href: string; bare: boolean }[] {
  try {
    return messageVisibleLinks(content);
  } catch (error) {
    console.error("[useMessageLinkCards] reading the message's links failed", error);
    return NO_LINKS;
  }
}

/** The key a message link's card is looked up by: its WHATWG href (an App link's is the same as `appLinkResultKey`). */
export function messageLinkKey(href: string): string | null {
  try {
    return new URL(href).href;
  } catch {
    return null;
  }
}

const MessageLinkCardsContext = createContext<ReadonlyMap<string, MessageLinkCard> | null>(null);
/** A message's block cards and the text whose Markdown draws them. */
export type MessageAppLinkBlocksIn = { cards: MessageAppLinkBlocks; text: string };
const MessageAppLinkBlocksContext = createContext<MessageAppLinkBlocksIn | null>(null);
/**
 * The message's link cards (useMessageLinkCards' `links`), for the links its
 * Markdown draws, and its block cards (`blocks`), for the paragraphs and list
 * items (AppLinkBlockHost) of the Markdown of `blocksIn`: the text shown as
 * the message's body (its own, or a translation shown in its place), or, in a
 * bilingual view, its own under the translation, so they are drawn once.
 */
export function MessageLinkCardsProvider({ value, blocks, blocksIn, children }: {
  value: ReadonlyMap<string, MessageLinkCard>; blocks?: MessageAppLinkBlocks; blocksIn?: string; children?: ReactNode;
}) {
  const drawn = useMemo(() => (blocks?.size && blocksIn !== undefined ? { cards: blocks, text: blocksIn } : null), [blocks, blocksIn]);
  return createElement(MessageLinkCardsContext.Provider, { value }, createElement(MessageAppLinkBlocksContext.Provider, { value: drawn }, children));
}

/** The block cards of the message being rendered (MessageLinkCardsProvider) and the text they are drawn in, if any. */
export function useMessageAppLinkBlocks(): MessageAppLinkBlocksIn | null {
  return useContext(MessageAppLinkBlocksContext);
}

/** The card for one link of the message being rendered (MessageLinkCardsProvider), if it has one. */
export function useMessageLinkCard(href: string | undefined): MessageLinkCard | undefined {
  const cards = useContext(MessageLinkCardsContext);
  const key = href && cards?.size ? messageLinkKey(href) : null;
  return key ? cards?.get(key) : undefined;
}

/**
 * Whether `target` has been on screen for `key` (once it has, it stays so for
 * that key): one IntersectionObserver while `watching`, disconnected once it
 * reports. False without IntersectionObserver.
 */
function useSeenOnScreen(target: RefObject<Element | null>, key: string, watching: boolean): boolean {
  const [seenKey, setSeenKey] = useState<string | null>(null);
  const seen = seenKey === key;
  useEffect(() => {
    const element = target.current;
    if (!watching || seen || !element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setSeenKey(key);
      observer.disconnect();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [watching, seen, key, target]);
  return seen;
}

/**
 * The one hook for a message's link cards (#proj-workspace:fbc76200): its
 * links are read once (shared `messageVisibleLinks`: the visible links, each
 * marked bare or not; the App link read counts the bare ones), then split.
 *
 * - First-party objects (an Artifact on Raft's own hosts, behind its flag:
 *   the app's `useArtifactLinkTargets`), bare or with the author's words
 *   (#proj-workspace:#289: the card under the message either way), are read through core's object
 *   summaries (`useArtifactLinkSummaries`: core's `useObjectSummaries` as it
 *   is, so the messages on screen share one request and its cache, retries
 *   and invalidation are the loader's; nothing is added here).
 * - Every other link is the App link read's, unchanged
 *   (`useAppLinkPreviews`: its budgets, retries, slots, caps and caches). A
 *   message whose bare links are all first-party has no App link read.
 *
 * Both start when the message body (`target`) is first on screen: one
 * IntersectionObserver for both. Before that, first-party answers the page
 * already keeps are drawn without asking. Without IntersectionObserver (old
 * WebViews) App links stay plain, as before, and first-party links are read
 * at once, as their cards were.
 *
 * One result per link (`links`), and the first-party ones again as the cards
 * under the message (`objects`): the chip in the text and the card below come
 * from the same answer. A message reads MESSAGE_OBJECT_LINK_LIMIT first-party
 * references at most; links to more stay plain. Unavailable or failed, a first-party link stays the
 * author's link; a failed read is asked again by the loader, not here.
 */
export function useMessageLinkCards({ messageId, content, conversationId, enabled, target }: {
  messageId: string;
  content: string;
  conversationId: string;
  enabled: boolean;
  target: RefObject<Element | null>;
}): MessageLinkCards {
  const viewer = useAuthStore((s) => s.user?.id);
  const server = useServerStore((s) => s.current?.id);
  const hasLinks = enabled && content.includes("://");
  // Reading the links never throws out of a message's render (#triage:#351): if it does, the message has no cards.
  const visible = useMemo(() => (hasLinks ? visibleLinksOrNone(content) : NO_LINKS), [hasLinks, content]);
  const bare = useMemo(() => visible.filter((link) => link.bare).map((link) => link.href), [visible]);
  // Raft's own objects from every visible link, a link the author gave words to included (#proj-workspace:#289):
  // its card goes under the message, and its words stay as written (MessageAppLink).
  const hrefs = useMemo(() => visible.map((link) => link.href), [visible]);
  const objectTargets = useArtifactLinkTargets(hrefs);
  // App links: the bare links that aren't first-party (the read covers public
  // HTTPS links only). With no first-party link, the App link read is as it
  // always was (it decides for itself what to read).
  const appLinks = objectTargets.size === 0 || bare.some((url) => !objectTargets.has(url) && !!publicPreviewUrl(url));

  // One observer for both: the App link read's own scope (viewer, Server,
  // message and content).
  const seen = useSeenOnScreen(target, `${viewer}:${server}:${messageId}:${content}`, hasLinks);
  const appResults = useAppLinkPreviews({ messageId, content, conversationId, enabled: enabled && appLinks, target, seen });

  // The references read: each once, in message order, MESSAGE_OBJECT_LINK_LIMIT at most.
  const asked = useMemo(() => {
    const byRef = new Map<string, ArtifactLinkTarget>();
    for (const linked of objectTargets.values()) {
      if (byRef.size >= MESSAGE_OBJECT_LINK_LIMIT) break;
      const key = objectRefKey(artifactObjectRefOf(linked));
      if (!byRef.has(key)) byRef.set(key, linked);
    }
    return byRef;
  }, [objectTargets]);
  const askedTargets = useMemo(() => [...asked.values()], [asked]);
  const onScreen = seen || typeof IntersectionObserver === "undefined";
  const summaries = useArtifactLinkSummaries(askedTargets, onScreen);

  return useMemo(() => {
    const links = new Map<string, MessageLinkCard>();
    for (const [url, result] of appResults) links.set(url, { kind: "app", url, state: result.kind, data: result });
    // After the App results: a first-party link is never an App's, so an App
    // result for one is replaced (whatever its state: loading, unavailable
    // and failed stay the author's link, never the App's chip).
    const objects: ObjectLinkCard[] = [];
    const listed = new Set<string>();
    for (const [url, linked] of objectTargets) {
      const key = objectRefKey(artifactObjectRefOf(linked));
      // Past the limit: the author's link (an App result for it goes too).
      if (!asked.has(key)) {
        links.delete(url);
        continue;
      }
      const card: ObjectLinkCard = { kind: "object", url, ...artifactLinkOf(linked, summaries?.get(key)) };
      links.set(url, card);
      if (!listed.has(key)) {
        listed.add(key);
        objects.push(card);
      }
    }
    // Block cards, from the same results as the chips, in the order of the
    // message's own text; its places are read only when an answer lists one.
    const blockOf = (url: string) => {
      const link = links.get(url);
      return link?.kind === "app" && link.data.kind === "card" && link.data.drawn?.card === "block" && link.data.cardV2 ? link.data : null;
    };
    let blocks = NO_BLOCKS;
    if ([...links.keys()].some(blockOf)) {
      const chosen = new Map<string, AppLinkBlockResult>();
      for (const { url } of appLinkBlockLayout(content).places) {
        const result = blockOf(url);
        if (result) chosen.set(url, result);
        if (chosen.size >= MESSAGE_BLOCK_CARD_LIMIT) break;
      }
      blocks = chosen;
    }
    return { links, objects, blocks };
  }, [appResults, objectTargets, asked, summaries, content]);
}
