import { Fragment } from "react";
import type { ReactNode } from "react";
import {
  Badge, DescriptionDetails, DescriptionItem, DescriptionList, DescriptionTerm, Separator, messageCard,
} from "@botiverse/raft-ui";
import { PreviewCardMeta } from "@botiverse/raft-ui/wip";
import type { MessageCard, MessageCardHeader, MessageCardHeaderTagTone } from "@botiverse/raft-shared";
import { CardBadge, CardColumn, CardDuration, CardRelativeTime, CardRowSeparator, CardText } from "./CardElements";
import { MessageCardMarkdown } from "./MessageCardMarkdown";
import { messageCardDrawsSomething, messageCardIsBlock, messageCardNode as nodeOf } from "./messageCardTree";
import type { MessageCardNode as Node } from "./messageCardTree";

/**
 * A card message's elements (RFC 082), painted with the leaves link cards and
 * action cards share (CardElements.tsx): a column or a row that may wrap, Text,
 * Badge, times. v2.0 (§4.8) adds what link cards don't have: the header
 * (MessageCardHeaderView), Markdown, Fields and Divider. The sender picks only
 * the structure; spacing, faces and colours are the design system's. Every
 * sender string is React text, never HTML; Markdown is drawn by the message
 * renderer restricted to its subset.
 *
 * The shared schema already bounded the tree (16 elements, depth 4, 12
 * children per Stack, one tree); this walks it once from the root. Buttons are
 * drawn in the card's own row (MessageCardBody), so a Stack that holds only
 * buttons draws nothing.
 */
export function MessageCardElements({ card }: { card: MessageCard }) {
  return <MessageCardNode card={card} id={card.root} depth={0} inRow={false} />;
}

function MessageCardNode({ card, id, depth, inRow }: { card: MessageCard; id: string; depth: number; inRow: boolean }): ReactNode {
  const node = nodeOf(card, id);
  if (!node || depth > 4) return null;
  switch (node.type) {
    case "Stack": {
      const ids = (node.children ?? []).filter((child) => messageCardDrawsSomething(card, child, depth + 1));
      if (!ids.length) return null;
      if (node.props.direction !== "row") {
        return (
          <CardColumn data-message-card-stack="column">
            {ids.map((child) => <MessageCardNode key={child} card={card} id={child} depth={depth + 1} inRow={false} />)}
          </CardColumn>
        );
      }
      // A row is the item card's details row (PreviewCardMeta). A Markdown, Fields or Divider in it is a
      // block of its own, as in the card's text agents read: the row's line ends before it and starts again after it.
      const segments: Array<{ block: boolean; ids: string[] }> = [];
      for (const child of ids) {
        const block = messageCardIsBlock(card, child, depth + 1);
        const last = segments[segments.length - 1];
        if (!block && last && !last.block) last.ids.push(child);
        else segments.push({ block, ids: [child] });
      }
      const drawn = segments.map((segment) => (segment.block
        ? <MessageCardNode key={segment.ids[0]} card={card} id={segment.ids[0]!} depth={depth + 1} inRow={false} />
        : <MessageCardRow key={segment.ids[0]} card={card} ids={segment.ids} depth={depth} wrap={node.props.wrap} />));
      return drawn.length === 1 ? drawn[0] : <CardColumn data-message-card-stack="row">{drawn}</CardColumn>;
    }
    case "Text":
      return <CardText tone={node.props.tone} mono={node.props.mono} inRow={inRow} data-message-card-text={node.props.tone}>{node.props.text}</CardText>;
    case "Badge":
      return <CardBadge inRow={inRow} data-message-card-badge={node.props.tone}>{node.props.text}</CardBadge>;
    case "RelativeTime":
      return <CardRelativeTime at={node.props.at} data-message-card-time="" />;
    case "Duration":
      return <CardDuration start={node.props.start} end={node.props.end} data-message-card-duration={node.props.end ? "ended" : "running"} />;
    case "Button":
      return null;
    case "Markdown":
      return <MessageCardMarkdown content={node.props.content} />;
    case "Fields":
      return <MessageCardFields items={node.props.items} />;
    case "Divider":
      return <Separator data-message-card-divider="" />;
    default: {
      const unhandled: never = node;
      void unhandled;
      return null;
    }
  }
}

/** One line of a row: its elements, a "·" between two that aren't the state chip (DS PreviewCard › Item card). */
function MessageCardRow({ card, ids, depth, wrap }: { card: MessageCard; ids: string[]; depth: number; wrap: boolean }) {
  const isBadge = (child: string | undefined) => !!child && nodeOf(card, child)?.type === "Badge";
  return (
    <PreviewCardMeta className={wrap ? undefined : "flex-nowrap"} data-message-card-stack="row">
      {ids.map((child, index) => (
        <Fragment key={child}>
          {index > 0 && !isBadge(ids[index - 1]) && !isBadge(child)
            ? <CardRowSeparator data-message-card-separator="" />
            : null}
          <MessageCardNode card={card} id={child} depth={depth + 1} inRow />
        </Fragment>
      ))}
    </PreviewCardMeta>
  );
}

type FieldsProps = Extract<Node, { type: "Fields" }>["props"];

/**
 * Fields: raft-ui DescriptionList, the label muted on the left and the value
 * on the right; once a value doesn't fit beside its label, every label sits
 * above its value (raft-ui measures it). Values wrap, never truncate: a card has no hover to show the
 * rest. A `mono` value is set in the code face, as ids and times are.
 */
function MessageCardFields({ items }: { items: FieldsProps["items"] }) {
  return (
    <DescriptionList direction="horizontal" data-message-card-fields="">
      {items.map((item, index) => (
        <DescriptionItem key={index}>
          <DescriptionTerm>{item.label}</DescriptionTerm>
          <DescriptionDetails>
            <span className={`min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] ${item.mono ? "font-mono text-sm" : ""}`} data-message-card-field-value={item.mono ? "mono" : "text"}>
              {item.value}
            </span>
          </DescriptionDetails>
        </DescriptionItem>
      ))}
    </DescriptionList>
  );
}

/** A tag's tone as a soft Badge's colour: the status tones only (never pink or yellow, RFC 082 §4.8). */
const TAG_VARIANT: Record<MessageCardHeaderTagTone, "default" | "information" | "success" | "warning" | "danger"> = {
  neutral: "default",
  info: "information",
  success: "success",
  warning: "warning",
  danger: "danger",
};

/**
 * The card's header (RFC 082 §4.8): the card's body and title from raft-ui
 * messageCard, the title every card in a message has (subhead, 700, up to 2
 * lines: the sender's name's own size, so a card never outweighs it; DS Cards
 * in messages › Title), the subtitle muted under it, the tags as soft badges
 * in their tone on a line of their own (they wrap; three long tags at the end
 * of the title row would leave the title no room). The header has no colour
 * of its own: the tags carry the status. Drawn inside the card, under the
 * sender's name, so it never reads as Raft's own header.
 */
export function MessageCardHeaderView({ header }: { header: MessageCardHeader }) {
  const { body, title, meta } = messageCard();
  return (
    <div className={body()} data-message-card-header="">
      <p className={title({ className: "wrap-break-word" })} data-message-card-title="">{header.title}</p>
      {header.subtitle !== undefined ? <p className={meta({ className: "wrap-break-word" })} data-message-card-subtitle="">{header.subtitle}</p> : null}
      {header.tags?.length ? (
        <div className="flex min-w-0 flex-wrap gap-1.5" data-message-card-tags="">
          {header.tags.map((tag, index) => (
            <Badge key={index} appearance="soft" variant={TAG_VARIANT[tag.tone]} className="max-w-full" data-message-card-tag={tag.tone}>
              <span className="min-w-0 break-words">{tag.text}</span>
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
}
