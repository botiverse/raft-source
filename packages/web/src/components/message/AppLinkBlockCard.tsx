import { useId, useRef } from "react";
import type { ComponentType, ReactNode, RefObject } from "react";
import {
  AppLinkCard,
  AppLinkCardBody,
  AppLinkCardHeader,
  AppLinkCardHost,
  AppLinkCardName,
  AppLinkCardTitle,
  useTruncated,
} from "@botiverse/raft-ui/wip";
import { appLinkDomain, appLinkOpenHref } from "../../utils/appLinkAddress";
import { BASE_MARKDOWN_COMPONENTS } from "../markdown/MarkdownContent";
import Tooltip from "../ui/Tooltip";
import { AppLinkIcon } from "./AppLinkIcon";
import { LinkCardBoundary } from "./LinkCardBoundary";
import { LinkCardActions, LinkCardConfirmDialog } from "./LinkCardActions";
import { LinkCardElements } from "./LinkCardElements";
import { appLinkBlockLayout, messageLinkKey, useMessageAppLinkBlocks } from "./useMessageLinkCards";
import type { AppLinkBlockResult, MessageAppLinkBlocks } from "./useMessageLinkCards";

// Version 3 block cards (RFC 076 §14; DS Navigation › Block cards, raft-ui
// AppLinkCard): an App's card drawn in the message after its link's paragraph,
// or in its list item. The link stays where the author put it (MessageAppLink
// draws it as the answer lists it). Which links get one is the message's
// (useMessageLinkCards' `blocks`); the paragraphs and list items of the
// Markdown the message's body is shown in draw them (appLinkBlockHosts.ts).

/**
 * One block card: Raft's header (the App's stored icon and name, the link's
 * host), the card's title as a link to the item, the card's elements as on
 * the hover card (LinkCardElements), and its buttons (LinkCardActions, the
 * block card's layout: two and ⋯, an Open link in ⋯). Its buttons act through
 * the same message view as the hover card's, and its confirm dialog is its
 * own, focus returning to the title. A `group` labelled by its title.
 */
export function AppLinkBlockCard({ result }: { result: AppLinkBlockResult }) {
  const owner = useId();
  const titleId = useId();
  const titleLink = useRef<HTMLAnchorElement>(null);
  const href = appLinkOpenHref(result.url);
  const domain = appLinkDomain(result.url);
  if (!href || !domain || !result.cardV2) return null;
  return (
    <>
      {/* Per-viewer App data: share screenshots strip it (selectScreenshot.ts). */}
      <AppLinkCard aria-labelledby={titleId} data-app-link-preview="" data-app-link-block={href}>
        <AppLinkCardHeader>
          <AppLinkIcon app={result.app} frame="card" />
          <AppLinkCardName data-app-link-preview-app="">{result.app.name}</AppLinkCardName>
          <AppLinkCardHost data-app-link-preview-host="">{domain}</AppLinkCardHost>
        </AppLinkCardHeader>
        <AppLinkCardBody>
          <AppLinkBlockTitle id={titleId} title={result.title} href={href} linkRef={titleLink} />
          <LinkCardBoundary key={JSON.stringify(result.cardV2)}>
            <LinkCardElements card={result.cardV2} />
          </LinkCardBoundary>
        </AppLinkCardBody>
        <LinkCardActions result={result} owner={owner} placement="block" />
      </AppLinkCard>
      <LinkCardConfirmDialog result={result} owner={owner} finalFocus={titleLink} />
    </>
  );
}

const SELECTABLE_TRIGGER = { className: "select-text" };

/**
 * The card's title, a link to the item in a new tab, as the chip opens it.
 * Clamped to two lines by raft-ui; only when the clamp cuts it does hovering
 * it show the whole title in a Tooltip, as on the hover card.
 */
function AppLinkBlockTitle({ id, title, href, linkRef }: { id: string; title: string; href: string; linkRef: RefObject<HTMLAnchorElement | null> }) {
  const titleRef = useRef<HTMLParagraphElement>(null);
  const truncated = useTruncated(titleRef);
  return (
    <Tooltip content={title} disabled={!truncated} triggerProps={SELECTABLE_TRIGGER}>
      <AppLinkCardTitle ref={titleRef} id={id} data-slot="app-link-card-title" data-link-card-title="">
        <a ref={linkRef} href={href} target="_blank" rel="noopener noreferrer">{title}</a>
      </AppLinkCardTitle>
    </Tooltip>
  );
}

type HastNode = { type: string; tagName?: string; properties?: { href?: unknown }; children?: HastNode[]; position?: { start?: { offset?: number }; end?: { offset?: number } } };
/** Elements whose links are not the host's own: a block of their own, drawn by their own host or never. */
const OTHER_BLOCKS: ReadonlySet<string> = new Set(["p", "ul", "ol", "li", "blockquote", "table", "pre", "div", "h1", "h2", "h3", "h4", "h5", "h6"]);

/**
 * Where a message's block cards go in the text its Markdown draws (`text`):
 * each after its link's place there (`at`, by the link's offset), and the
 * ones whose link that text doesn't have (a translation that dropped it)
 * after its last paragraph (`trailing`, at `end`), so none is lost.
 */
type Placement = { at: ReadonlyMap<number, AppLinkBlockResult>; trailing: readonly AppLinkBlockResult[]; end: number | null };
const placements = new WeakMap<MessageAppLinkBlocks, Map<string, Placement>>();
function placementIn(cards: MessageAppLinkBlocks, text: string): Placement {
  const byText = placements.get(cards) ?? new Map<string, Placement>();
  placements.set(cards, byText);
  const kept = byText.get(text);
  if (kept) return kept;
  const { places, end } = appLinkBlockLayout(text);
  const at = new Map<number, AppLinkBlockResult>();
  for (const { url, offset } of places) {
    const result = cards.get(url);
    if (result) at.set(offset, result);
  }
  const placed = new Set([...at.values()]);
  const placement = { at, trailing: [...cards.values()].filter((result) => !placed.has(result)), end };
  byText.set(text, placement);
  return placement;
}

/** The block cards of the links in `node`'s own text, in their order. */
function blockCardsIn(node: HastNode, at: ReadonlyMap<number, AppLinkBlockResult>): AppLinkBlockResult[] {
  const found: AppLinkBlockResult[] = [];
  const visit = (parent: HastNode) => {
    for (const child of parent.children ?? []) {
      if (child.type !== "element" || !child.tagName || OTHER_BLOCKS.has(child.tagName)) continue;
      const offset = child.position?.start?.offset;
      const result = child.tagName === "a" && offset !== undefined ? at.get(offset) : undefined;
      if (result && typeof child.properties?.href === "string" && messageLinkKey(child.properties.href) === result.url) found.push(result);
      else visit(child);
    }
  };
  visit(node);
  return found;
}

/** The cards `node` draws: its links', then, as the text's last paragraph (a tight list item's included), the trailing ones. */
function hostCards(tag: "p" | "li", node: HastNode, placement: Placement): AppLinkBlockResult[] {
  const own = placement.at.size ? blockCardsIn(node, placement.at) : [];
  const last = placement.trailing.length && placement.end !== null && node.position?.end?.offset === placement.end
    && (tag === "p" || !(node.children ?? []).some((child) => child.tagName === "p"));
  return last ? [...own, ...placement.trailing] : own;
}

const NO_CARDS: readonly AppLinkBlockResult[] = [];
type HostProps = { tag: "p" | "li"; source: string; node?: HastNode; children?: ReactNode } & Record<string, unknown>;

/**
 * A paragraph or a list item of a message's Markdown, as the shared Markdown
 * draws it, then the block cards of its links: after a paragraph, or inside
 * a list item after its text and before a list nested in it. Only in the
 * Markdown of the text the message's cards are drawn in (`source`, the
 * provider's `blocksIn`): its own text, or a translation shown in its place.
 * The same shape with or without cards, so a card that arrives doesn't
 * remount the paragraph (or move focus out of it).
 */
export function AppLinkBlockHost({ tag, source, node, children, ...props }: HostProps) {
  const blocks = useMessageAppLinkBlocks();
  const Base = BASE_MARKDOWN_COMPONENTS[tag] as ComponentType<Record<string, unknown>>;
  const results = node && blocks && blocks.text === source ? hostCards(tag, node, placementIn(blocks.cards, source)) : NO_CARDS;
  const cards = results.map((result) => <AppLinkBlockCard key={result.url} result={result} />);
  if (tag === "p") return <><Base node={node} {...props}>{children}</Base>{cards}</>;
  // A list item's children are its hast children, in order: the cards go before its first nested list.
  const hastChildren = node?.children ?? [];
  const nested = hastChildren.findIndex((child) => child.tagName === "ul" || child.tagName === "ol");
  const own = Array.isArray(children) && nested >= 0 && children.length === hastChildren.length ? children : null;
  return <Base node={node} {...props}>{own ? <>{own.slice(0, nested)}{cards}{own.slice(nested)}</> : <>{children}{cards}</>}</Base>;
}
