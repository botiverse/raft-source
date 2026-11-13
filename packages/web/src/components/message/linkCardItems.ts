import { currentTimeMs } from "@botiverse/raft-shared";
import type { AppLinkPreviewItem, LinkCardReadAnswerItem } from "@botiverse/raft-shared/src/appLinkPreview";
import type { AppLinkApp, AppLinkResult } from "./useAppLinkPreviews";

// A batched read's v2 and v3 items as the per-link results the chips and cards
// draw (useAppLinkPreviews' readLinkCardAnswer). docs/development/app-link-previews.md,
// "Web display".

/**
 * How a version 3 answer draws its link (RFC 076 §14; raft-design Navigation ›
 * What an app's answer lists). The App lists every way and Raft infers none:
 * - `chip`: the link is the App's chip (an `inline` item, or a hover card,
 *   whose chip takes the card's title when there is no `inline`); otherwise
 *   it stays the author's plain link;
 * - `card`: where the one card goes: `hover`, the chip's hover card;
 *   `block`, a card after the link's paragraph (AppLinkBlockCard.tsx), and
 *   then the chip opens no hover card; null, no card.
 * A v1 or v2 result has none: a chip with its hover card, as before.
 */
export type AppLinkDrawn = { chip: boolean; card: "hover" | "block" | null };

type ReadItem = Extract<LinkCardReadAnswerItem, { kind: "v2" | "v3" }>;
type ItemOf<T extends AppLinkPreviewItem["type"]> = Extract<AppLinkPreviewItem, { type: T }>;
const itemOf = <T extends AppLinkPreviewItem["type"]>(items: readonly AppLinkPreviewItem[], type: T) =>
  items.find((item): item is ItemOf<T> => item.type === type);

/**
 * One v2 or v3 item of a batched read as its link's result, or null (the
 * author's link). v2: a `card` with its elements and inline title, or a
 * `connect_account` chip, as before. v3: `connect_account` as v2's; a card
 * item (with its `inline` title, if any) a `card` result with its `drawn`; an
 * `inline` item alone a chip with no card. The badge of `inline` is never
 * drawn, so it is not kept.
 */
export function appLinkResultOfItem(item: ReadItem, url: string, app: AppLinkApp): AppLinkResult | null {
  const handles = { actions: item.actions, readAt: currentTimeMs() };
  if (item.kind === "v2") {
    const { preview } = item;
    if (preview.display === "connect_account") return { kind: "connect_account", url, app, connectUrl: preview.connect_url };
    if (preview.display !== "card") return null;
    return { kind: "card", url, app, title: preview.title, cardV2: preview.card, inlineTitle: preview.inline?.title, businessRevision: preview.business_revision, ...handles };
  }
  const { items } = item.preview;
  const connect = itemOf(items, "connect_account");
  if (connect) return { kind: "connect_account", url, app, connectUrl: connect.connect_url };
  const inline = itemOf(items, "inline");
  const card = itemOf(items, "card");
  if (card) {
    const drawn: AppLinkDrawn = { chip: !!inline || card.placement === "hover", card: card.placement };
    return { kind: "card", url, app, title: card.title, cardV2: card.card, inlineTitle: inline?.title, businessRevision: card.business_revision, drawn, ...handles };
  }
  return inline ? { kind: "card", url, app, title: inline.title, drawn: { chip: true, card: null } } : null;
}
