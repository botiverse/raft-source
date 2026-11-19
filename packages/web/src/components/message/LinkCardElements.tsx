import { Fragment } from "react";
import type { ReactNode } from "react";
import { PreviewCardMeta } from "@botiverse/raft-ui/wip";
import type { LinkCardV2 } from "@botiverse/raft-shared/src/appLinkPreview";
import { CardBadge, CardColumn, CardDuration, CardRelativeTime, CardRowSeparator, CardText } from "./CardElements";

/**
 * A version 2 card's elements (protocol v3.2.3 §4.4, addendum 3) in the hover
 * card, painted with the element renderers action cards share
 * (CardElements.tsx). The App picks only the structure: a column or a row that
 * may wrap, a text tone, mono, a badge tone. Spacing, faces and colors are the
 * design system's. Every App string is React text, never HTML, and a text in a
 * row or a badge stays on one line, truncated.
 *
 * The shared schema already bounded the tree (16 elements, depth 4, 12
 * children per Stack, one tree); this walks it once from the root. Buttons are
 * not drawn here but in the card's actions row (LinkCardActions.tsx), so a
 * Stack that holds only buttons draws nothing.
 */
export function LinkCardElements({ card, surface }: { card: LinkCardV2; surface: LinkCardSurface }) {
  return <LinkCardNode card={card} id={card.root} depth={0} inRow={false} surface={surface} />;
}

/** Whether an element draws anything here: not a Button, not a missing id, not a Stack of only those (within the depth bound). */
function drawsSomething(card: LinkCardV2, id: string, depth: number): boolean {
  const node = Object.hasOwn(card.elements, id) ? card.elements[id] : undefined;
  if (!node || depth > 4 || node.type === "Button") return false;
  if (node.type !== "Stack") return true;
  return (node.children ?? []).some((child) => drawsSomething(card, child, depth + 1));
}

/**
 * Where the card is drawn: `card`, the block card under a message, or `popover`, the hover card a chip opens. A
 * Badge takes the App's `color` on both (RFC 076 §15, badge.color.v1; DS AppLinkCard › The app's color, PreviewCard
 * › Item card): the surface only says which one the badge's hairline ring is decided against. Until 2026-11-14 only
 * the block card took the colour, and Stamp, which sends hover cards only, showed none (#proj-apps:#51).
 */
export type LinkCardSurface = "card" | "popover";

function LinkCardNode({ card, id, depth, inRow, surface }: { card: LinkCardV2; id: string; depth: number; inRow: boolean; surface: LinkCardSurface }): ReactNode {
  const node = Object.hasOwn(card.elements, id) ? card.elements[id] : undefined;
  if (!node || depth > 4) return null;
  switch (node.type) {
    case "Stack": {
      const row = node.props.direction === "row";
      const typeOf = (child: string) => (Object.hasOwn(card.elements, child) ? card.elements[child]?.type : undefined);
      // Buttons are drawn in the card's actions row (LinkCardActions), not here: a Stack that draws only
      // buttons draws nothing, and takes no place (nor a "·") in its parent.
      const ids = (node.children ?? []).filter((child) => drawsSomething(card, child, depth + 1));
      if (!ids.length) return null;
      // In a row, details read as one line: a "·" between two that aren't the state chip (DS PreviewCard › Item card).
      const isBadge = (child: string | undefined) => !!child && typeOf(child) === "Badge";
      const children = ids.map((child, index) => (
        <Fragment key={child}>
          {row && index > 0 && !isBadge(ids[index - 1]) && !isBadge(child)
            ? <CardRowSeparator data-link-card-separator="" />
            : null}
          <LinkCardNode card={card} id={child} depth={depth + 1} inRow={row} surface={surface} />
        </Fragment>
      ));
      // A row is the item card's details row (PreviewCardMeta), wrapping only when the App asks.
      if (row) return <PreviewCardMeta className={node.props.wrap ? undefined : "flex-nowrap"} data-link-card-stack="row">{children}</PreviewCardMeta>;
      return <CardColumn data-link-card-stack="column">{children}</CardColumn>;
    }
    case "Text":
      return <CardText tone={node.props.tone} mono={node.props.mono} inRow={inRow} data-link-card-text={node.props.tone}>{node.props.text}</CardText>;
    case "Badge":
      return <CardBadge inRow={inRow} fill={node.props.color} surface={surface} data-link-card-badge={node.props.tone}>{node.props.text}</CardBadge>;
    case "RelativeTime":
      return <CardRelativeTime at={node.props.at} data-link-card-time="" />;
    case "Duration":
      return <CardDuration start={node.props.start} end={node.props.end} data-link-card-duration={node.props.end ? "ended" : "running"} />;
    default:
      return null;
  }
}
