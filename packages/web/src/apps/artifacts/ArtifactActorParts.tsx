import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import { Badge } from "@botiverse/raft-ui";
import type { ArtifactActor, ArtifactCommentAnchor } from "@botiverse/raft-shared";

import AvatarSlot from "../../components/ui/AvatarSlot";
import type { AvatarContext } from "../../components/ui/AvatarSlot";

/**
 * A person's or an agent's avatar through the app's AvatarSlot (raft-ui
 * Avatar): an agent's `pixel:` face or uploaded image, a person's picture
 * (Raft's own profile data), else their initial. `context` is AvatarSlot's,
 * which sets the size.
 */
export function ArtifactActorAvatar({ actor, context, className }: { actor: Pick<ArtifactActor, "type" | "avatarUrl" | "displayName">; context: AvatarContext; className?: string }) {
  if (actor.type === "agent") return <AvatarSlot context={context} type="agent" agentAvatarUrl={actor.avatarUrl} className={className} />;
  if (actor.avatarUrl) return <AvatarSlot context={context} type="human" humanAvatarUrl={actor.avatarUrl} className={className} />;
  return <AvatarSlot context={context} type="human" className={className}>{initialOf(actor.displayName)}</AvatarSlot>;
}

function initialOf(name: string): string {
  return [...name.trim()][0]?.toUpperCase() ?? "";
}

/** The DS `agent` tag after an agent's name (outline badge). */
export function AgentTag() {
  const { formatMessage } = useIntl();
  return (
    <Badge appearance="outline" variant="muted" className="shrink-0" data-testid="artifact-agent-tag">
      {formatMessage({ id: "artifacts.comments.agentTag" })}
    </Badge>
  );
}

/** The page's own words for a place (an annotation's label, a page anchor's label or name), or null for a place Raft names (lines, rows). */
function pagePlace(anchor: ArtifactCommentAnchor): string | null {
  if (anchor.type === "annotation") return anchor.data.label;
  // The page's own words for its place (P108), its name where it gave none: shown as text, never followed.
  if (anchor.type === "page") return anchor.data.label ?? anchor.data.name;
  return null;
}

/** Where an anchor points, in a few words: "Lines 3–5", "Row 4", or the page's own label. */
export function anchorLabel(anchor: ArtifactCommentAnchor, intl: IntlShape): string {
  if (anchor.type === "annotation" || anchor.type === "page") return pagePlace(anchor) ?? "";
  const { start, end } = anchor.data;
  if (anchor.type === "lines") {
    return start === end
      ? intl.formatMessage({ id: "artifacts.comments.anchor.line" }, { line: start })
      : intl.formatMessage({ id: "artifacts.comments.anchor.lines" }, { start, end });
  }
  return start === end
    ? intl.formatMessage({ id: "artifacts.comments.anchor.row" }, { row: start })
    : intl.formatMessage({ id: "artifacts.comments.anchor.rows" }, { start, end });
}

/** The passage an anchor quotes, if it carries one. */
export function anchorQuote(anchor: ArtifactCommentAnchor): string | null {
  if (anchor.type === "annotation") {
    const quote = anchor.data.selectors.find((s) => s.type === "TextQuoteSelector");
    return quote && quote.type === "TextQuoteSelector" ? quote.exact : null;
  }
  return anchor.data.quote ?? null;
}

/** Whether an anchor's quote is the page's own excerpt (P108), not text the person selected: shown as such (Tenny). */
export const quoteIsPagesOwn = (anchor: ArtifactCommentAnchor): boolean => anchor.type === "page";

/**
 * Text from the page in Raft's own UI (an anchor's label or quote): plain text, isolated in
 * `<bdi dir="auto">` (Porthole 0.13, ADOPTING "A page's draft"), so a right-to-left or mixed run
 * in it can't reorder the words Raft puts around it.
 */
export function PageText({ text }: { text: string }) {
  return <bdi dir="auto" data-page-text="">{text}</bdi>;
}

type PlaceMessageId =
  | "artifacts.comments.pageAnchorNotInVersion"
  | "artifacts.comments.anchorLost"
  | "artifacts.comments.anchorWithPageExcerpt"
  | "artifacts.comments.anchorWithQuote"
  | "artifacts.review.quote";

/** A message with a place and maybe a quote: its id (null: the place alone) and its parts. */
interface PlaceMessage {
  id: PlaceMessageId | null;
  anchor: ArtifactCommentAnchor;
  quote: string | null;
}

/**
 * What a thread's anchor line says: the place, with its quote (the page's
 * own excerpt for a page anchor) while it is found. A place a page named that
 * the shown version doesn't have is "not in this version" (a page's names
 * come and go between versions: not an error); any other lost place,
 * "position not found". Those two are spoken only (AnchorMeta draws the place dimmed).
 */
function anchorMetaMessage(anchor: ArtifactCommentAnchor, found: boolean): PlaceMessage {
  if (!found) return { id: anchor.type === "page" ? "artifacts.comments.pageAnchorNotInVersion" : "artifacts.comments.anchorLost", anchor, quote: null };
  const quote = anchorQuote(anchor);
  if (!quote) return { id: null, anchor, quote: null };
  return { id: quoteIsPagesOwn(anchor) ? "artifacts.comments.anchorWithPageExcerpt" : "artifacts.comments.anchorWithQuote", anchor, quote };
}

/**
 * Where a draft is, in a few words: a text selection by its quote (its label is the same words),
 * a picked block by its label, any other anchor as a thread's line says it.
 */
function draftPlaceMessage(anchor: ArtifactCommentAnchor): PlaceMessage {
  if (anchor.type === "annotation" && anchor.data.kind === "text") {
    const quote = anchorQuote(anchor);
    if (quote) return { id: "artifacts.review.quote", anchor, quote };
  }
  return anchorMetaMessage(anchor, true);
}

function messageText({ id, anchor, quote }: PlaceMessage, intl: IntlShape): string {
  const place = anchorLabel(anchor, intl);
  return id === null ? place : intl.formatMessage({ id }, { place, quote: quote ?? "" });
}

/** The same words with the page's own (label, quote) each in a PageText. */
function MessageWithPageText({ id, anchor, quote }: PlaceMessage) {
  const intl = useIntl();
  const own = pagePlace(anchor);
  // Keyed: formatMessage hands the parts back as a list.
  const place = own !== null ? <PageText key="place" text={own} /> : anchorLabel(anchor, intl);
  if (id === null) return <>{place}</>;
  return <>{intl.formatMessage({ id }, { place, quote: quote === null ? "" : <PageText key="quote" text={quote} /> })}</>;
}

/** What a thread's anchor line says (anchorMetaMessage), as text. */
export function anchorMetaText(anchor: ArtifactCommentAnchor, found: boolean, intl: IntlShape): string {
  return messageText(anchorMetaMessage(anchor, found), intl);
}

/**
 * anchorMetaText, drawn: the page's label and quote isolated (PageText). A place no longer found is the place alone,
 * dimmed (DS States › Dimmed), after the caller's MapPinOff (#250: no "position not found" on screen); a screen reader
 * still hears the words.
 */
export function AnchorMeta({ anchor, found }: { anchor: ArtifactCommentAnchor; found: boolean }) {
  if (found) return <MessageWithPageText {...anchorMetaMessage(anchor, true)} />;
  return (
    <>
      <span aria-hidden className="text-foreground-hint" data-anchor-lost="">
        <MessageWithPageText id={null} anchor={anchor} quote={null} />
      </span>
      <span className="sr-only">
        <MessageWithPageText {...anchorMetaMessage(anchor, false)} />
      </span>
    </>
  );
}

/** Where a draft is (draftPlaceMessage), drawn: the page's label and quote isolated (PageText). */
export function DraftPlace({ anchor }: { anchor: ArtifactCommentAnchor }) {
  return <MessageWithPageText {...draftPlaceMessage(anchor)} />;
}
