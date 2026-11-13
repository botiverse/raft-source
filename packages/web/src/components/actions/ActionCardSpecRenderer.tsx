// The body of a first-party action card described by its spec (`action-card.v1`,
// shared actionCardSpec.ts): a hand-written walk over the tree, painted with
// the element renderers App link cards use (message/CardElements.tsx) and the
// MessageActionCard parts. The frame (ActionCardSpecCard.tsx) owns the header,
// the state and what buttons do; this only lays the tree out.
//
// The shared read parse already bounded the tree (24 elements, depth 4, 12
// children per Stack, one tree) and stripActionCardSpec replaced every button
// this client cannot handle. Every string is React text, never HTML.

import { Fragment, useCallback } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import {
  MessageActionCardActions,
  MessageActionCardHint,
  MessageActionCardHintLabel,
  MessageActionCardNotice,
  MessageActionCardProperties,
  MessageActionCardProperty,
  MessageActionCardPropertyLabel,
  MessageActionCardPropertyValue,
} from "@botiverse/raft-ui";
import { cn } from "@botiverse/raft-ui/cn";
import { ACTION_CARD_SPEC_LIMITS, renderActionCardMsg } from "@botiverse/raft-shared";
import type { ActionCardSpecAction, ActionCardSpecButton, ActionCardSpecEntityRef, ActionCardSpecMsg, ActionCardSpecOpenWebAction, ActionCardSpecTree } from "@botiverse/raft-shared";
import { AppPermissionSetList } from "../integrations/AppPermissionSetList";
import { CLAMP_CLASS, CardBadge, CardDuration, CardRelativeTime, CardText } from "../message/CardElements";
import { ActionCardEntityChip } from "./ActionCardEntityRef";
import { useEntityNameResolver } from "./actionCardEntities";
import { ActionCardScopeNotices } from "./ActionCardScopeNotices";
import { ActionCardScopes } from "./ActionCardScopes";

/** What a button does once strip ran: a supported action, or "Open in web". */
export type ActionCardRenderedAction = ActionCardSpecAction | ActionCardSpecOpenWebAction;
/** A tree as this client renders it: the body, the result, or a confirm's body. */
export type ActionCardRenderedTree = ActionCardSpecTree<ActionCardRenderedAction>;
export type ActionCardRenderedButton = ActionCardSpecButton<ActionCardRenderedAction>["props"];
/** Draws one Button; null: the tree shows no buttons (a done card's body, a confirm's body). */
export type ActionCardButtonRenderer = ((id: string, button: ActionCardRenderedButton) => ReactNode) | null;

/**
 * A spec tree's elements. The root column's children go straight into the
 * caller's container (MessageActionCardContent spaces them); runs of Fields
 * become one property list, an `actions` Stack the actions row and a `reason`
 * Stack the hint (quoted note, under its label). Cards stored before Stack
 * roles get the same from their shape.
 */
export function ActionCardSpecRenderer({ tree, renderButton, fitLabels = false }: {
  tree: ActionCardRenderedTree;
  renderButton: ActionCardButtonRenderer;
  /** Property labels take only their width, not the DS list's lined-up column (FITTED_LABELS). */
  fitLabels?: boolean;
}) {
  return <SpecNode tree={tree} id={tree.root} depth={0} inRow={false} inProperties={false} renderButton={renderButton} fitLabels={fitLabels} />;
}

interface NodeProps {
  tree: ActionCardRenderedTree;
  id: string;
  depth: number;
  inRow: boolean;
  /** Inside a MessageActionCardProperties list (a Field is a row of it). */
  inProperties: boolean;
  renderButton: ActionCardButtonRenderer;
  fitLabels: boolean;
}

function SpecNode({ tree, id, depth, inRow, inProperties, renderButton, fitLabels }: NodeProps): ReactNode {
  const node = Object.hasOwn(tree.elements, id) ? tree.elements[id] : undefined;
  if (!node || depth > ACTION_CARD_SPEC_LIMITS.maxDepth) return null;
  const child = (childId: string, options: { inRow: boolean; inProperties: boolean }) => (
    <SpecNode key={childId} tree={tree} id={childId} depth={depth + 1} renderButton={renderButton} fitLabels={fitLabels} {...options} />
  );
  switch (node.type) {
    case "Stack": {
      const childIds = node.children ?? [];
      const { role } = node.props;
      const buttons = () => childIds.map((childId) => child(childId, { inRow: true, inProperties: false }));
      // A Stack's `role` (schemaVersion 6) says what it is: the card's actions
      // row, or the agent's reason, drawn as the DS hint. A reason that is not
      // one or two Texts is drawn as the column it is.
      if (role === "actions") {
        return renderButton ? <MessageActionCardActions data-action-card-stack="actions">{buttons()}</MessageActionCardActions> : null;
      }
      const hint = role === "reason" ? reasonHint(tree, childIds) : role === undefined ? storedReasonHint(tree, childIds, depth) : null;
      if (hint) return hint;
      if (node.props.direction === "row") {
        // Without a role, a row of only Buttons is the actions row: a card
        // stored before schemaVersion 6 (cards are kept as sent, not rebuilt).
        const buttonsOnly = role === undefined && childIds.length > 0 && childIds.every((childId) => tree.elements[childId]?.type === "Button");
        if (buttonsOnly && !renderButton) return null;
        if (buttonsOnly) return <MessageActionCardActions data-action-card-stack="actions">{buttons()}</MessageActionCardActions>;
        return (
          <div className={cn("flex min-w-0 items-center gap-x-2 gap-y-1", node.props.wrap ? "flex-wrap" : "flex-nowrap")} data-action-card-stack="row">
            {buttons()}
          </div>
        );
      }
      // Runs of Fields become one property list. A run of Buttons straight in
      // a column is one actions row: a card stored before its buttons sat in
      // an `actions` Stack.
      const runs: { type: string | undefined; ids: string[] }[] = [];
      for (const childId of childIds) {
        const type = tree.elements[childId]?.type;
        const last = runs.at(-1);
        if (last && last.type === type && (type === "Field" || type === "Button")) last.ids.push(childId);
        else runs.push({ type, ids: [childId] });
      }
      const groups = runs.map(({ type, ids }): ReactNode => {
        if (type === "Field") {
          return <MessageActionCardProperties key={ids[0]} className={fitLabels ? FITTED_LABELS : undefined}>{ids.map((fieldId) => child(fieldId, { inRow: false, inProperties: true }))}</MessageActionCardProperties>;
        }
        if (type === "Button") {
          return renderButton
            ? <MessageActionCardActions key={ids[0]} data-action-card-stack="actions">{ids.map((buttonId) => child(buttonId, { inRow: true, inProperties: false }))}</MessageActionCardActions>
            : null;
        }
        return child(ids[0]!, { inRow: false, inProperties: false });
      });
      if (depth === 0) return <>{groups}</>;
      return <div className="flex min-w-0 flex-col gap-2" data-action-card-stack="column">{groups}</div>;
    }
    case "Text":
      return (
        <CardText tone={node.props.tone} mono={node.props.mono} inRow={inRow} clamp={node.props.clamp} data-action-card-text={node.props.tone}>
          <ActionCardRichText value={node.props.text} />
        </CardText>
      );
    case "Badge":
      return <CardBadge inRow={inRow} data-action-card-badge={node.props.tone}><ActionCardPlainText value={node.props.text} /></CardBadge>;
    case "RelativeTime":
      return <CardRelativeTime at={node.props.at} data-action-card-time="" />;
    case "Duration":
      return <CardDuration start={node.props.start} end={node.props.end} data-action-card-duration={node.props.end ? "ended" : "running"} />;
    case "Field": {
      const { label, value, clamp } = node.props;
      const refs = Array.isArray(value);
      // The spec's clamp is a line count (1-6).
      // Names are never machine text: `mono` and `breakAll` are for text values
      // (IDs, keys, URLs), not for references (typography.md). A reference chip
      // that starts the value is pulled back by its 6px side, so its text lines
      // up with the plain values above and below (ENTITY_CHIP_ALIGN).
      const valueClassName = cn(
        fieldValueClassName({ muted: node.props.muted, mono: !refs && node.props.mono, breakAll: !refs && node.props.breakAll }),
        clamp ? `${CLAMP_CLASS[clamp]} whitespace-pre-wrap break-words` : undefined,
        refs ? ENTITY_CHIP_ALIGN : undefined,
      );
      const property = (
        <MessageActionCardProperty data-action-card-field="">
          <MessageActionCardPropertyLabel><ActionCardPlainText value={label} /></MessageActionCardPropertyLabel>
          <MessageActionCardPropertyValue className={valueClassName}>
            {Array.isArray(value)
              ? value.map((ref, index) => (
                <Fragment key={`${index}:${ref.kind}:${ref.id}`}>
                  {index > 0 ? ", " : null}
                  <ActionCardEntityChip entityRef={ref} />
                </Fragment>
              ))
              : <ActionCardRichText value={value} />}
          </MessageActionCardPropertyValue>
        </MessageActionCardProperty>
      );
      return inProperties ? property : <MessageActionCardProperties className={fitLabels ? FITTED_LABELS : undefined}>{property}</MessageActionCardProperties>;
    }
    case "EntityRef":
      return <ActionCardEntityChip entityRef={node.props} />;
    case "ScopeList":
      // Raft's notes on where an agent-inbound app may send, then the list.
      // With permission groups (an install's whole set), the
      // set as the install dialog shows it: scopes and data access.
      return (
        <>
          <ActionCardScopeNotices scopes={node.props.scopes} agentName={node.props.agentName} />
          {node.props.groups
            ? <AppPermissionSetList scopes={node.props.scopes} groups={node.props.groups} />
            : <ActionCardScopes scopes={node.props.scopes} />}
        </>
      );
    case "Notice":
      // DS MessageActionCard: a notice stays neutral, never in a warning color; the tone stays on the element.
      return <MessageActionCardNotice data-action-card-notice={node.props.tone}><ActionCardRichText value={node.props.text} /></MessageActionCardNotice>;
    case "Button":
      return renderButton ? <Fragment key={id}>{renderButton(id, node.props)}</Fragment> : null;
  }
}

/**
 * A property list whose label column fits its labels (`fitLabels`). The DS
 * list gives the column at least 88px so labels line up, with each other and
 * with the lists of the card's other sections. A question card answered
 * inline keeps only its For row above the form, with nothing to line up
 * with, and its one-word label ("For", "问") sat a wide blank away from the
 * person. Only that body fits its labels: an answered question card's For
 * row lines up with its answers below, and every other card keeps the DS
 * column. The narrow card's one-column layout is unchanged.
 */
const FITTED_LABELS = "grid-cols-[max-content_minmax(0,1fr)]";

/**
 * A Field value's style: a placeholder ("No description prefilled.") muted, not
 * data; machine values (keys, handles, URLs) Space Mono, long ones (URLs,
 * keys) breaking anywhere.
 */
function fieldValueClassName({ muted, mono, breakAll }: { muted?: boolean; mono?: boolean; breakAll?: boolean }): string | undefined {
  if (muted) return "text-foreground-hint";
  if (breakAll) return "break-all font-mono text-mono-meta";
  if (mono) return "font-mono text-mono-meta";
  return undefined;
}

/**
 * A chip's text sits 6px in from its fill (the inline chip's sides, raft-ui
 * lib/inline-chip.ts); at the start of a property value that put it 6px right
 * of the plain values in the same column.
 */
const ENTITY_CHIP_ALIGN = "[&>[data-action-card-chip]:first-child]:-ml-1.5";

/** What the folded done header names after its arrow: the result section's first item (resultHeadline). */
export type ActionCardResultHeadline = ActionCardRenderedTree["elements"][string];

/**
 * The result's first item on one header line: a reference as bold link text
 * (never a chip, so the line keeps its height), any other text plain. A name
 * never breaks inside itself (a reference, or a name a Msg carries as a
 * param): the line wraps between words only.
 */
export function ActionCardResultHeadlineText({ item }: { item: ActionCardResultHeadline }) {
  const refs = (list: readonly ActionCardSpecEntityRef[]) => list.map((ref, index) => (
    <Fragment key={`${index}:${ref.kind}:${ref.id}`}>
      {index > 0 ? ", " : null}
      <span className="whitespace-nowrap" data-action-card-headline-name=""><ActionCardEntityChip entityRef={ref} inline /></span>
    </Fragment>
  ));
  switch (item.type) {
    case "Text":
      return <ActionCardInlineText value={item.props.text} />;
    case "Field":
      return Array.isArray(item.props.value) ? <>{refs(item.props.value)}</> : <ActionCardInlineText value={item.props.value} />;
    case "EntityRef":
      return <>{refs([item.props])}</>;
    default:
      return null;
  }
}

/** Card copy on one header line: as ActionCardRichText, with each name (reference or param) kept whole. */
function ActionCardInlineText({ value }: { value: string | ActionCardSpecMsg }) {
  const { locale } = useIntl();
  if (typeof value === "string") return <>{value}</>;
  return (
    <>
      {renderActionCardMsg(value, locale, { keepParams: true }).map((segment, index) => "ref" in segment
        ? <span key={index} className="whitespace-nowrap" data-action-card-headline-name=""><ActionCardEntityChip entityRef={segment.ref} inline /></span>
        : segment.param
          ? <span key={index} className="whitespace-nowrap" data-action-card-headline-name="">{segment.text}</span>
          : <Fragment key={index}>{segment.text}</Fragment>)}
    </>
  );
}

/** A `reason` Stack as the DS hint: its one or two Texts, the first of two as the label. Null: not that shape. */
function reasonHint(tree: ActionCardRenderedTree, childIds: readonly string[]): ReactNode {
  const texts = childIds.map((childId) => tree.elements[childId]);
  if (texts.length < 1 || texts.length > 2 || !texts.every((text) => text?.type === "Text")) return null;
  const [label, note] = texts.length === 2 ? texts : [undefined, texts[0]];
  if (note?.type !== "Text") return null;
  return (
    <>
      {label?.type === "Text" ? <MessageActionCardHintLabel data-action-card-hint-label=""><ActionCardPlainText value={label.props.text} /></MessageActionCardHintLabel> : null}
      <MessageActionCardHint data-action-card-hint="" className={note.props.clamp ? CLAMP_CLASS[note.props.clamp] : undefined}>
        <ActionCardRichText value={note.props.text} />
      </MessageActionCardHint>
    </>
  );
}

/**
 * The reason group of a card stored before schemaVersion 6, which has no
 * `role` (cards are kept as sent, not rebuilt): a nested column of a Text, or
 * of a muted Text over a Text. Only for those cards; a card built since says
 * `role: "reason"`.
 */
function storedReasonHint(tree: ActionCardRenderedTree, childIds: readonly string[], depth: number): ReactNode {
  if (depth === 0) return null;
  const texts = childIds.map((childId) => tree.elements[childId]);
  const note = texts.at(-1);
  const label = texts.length === 2 ? texts[0] : undefined;
  const shaped = (texts.length === 1 || (label?.type === "Text" && label.props.tone === "muted")) && texts.length <= 2
    && note?.type === "Text" && note.props.tone === "default";
  return shaped ? reasonHint(tree, childIds) : null;
}

/** Card copy where rich content is allowed: entity params become mention and channel chips. */
export function ActionCardRichText({ value }: { value: string | ActionCardSpecMsg }) {
  const { locale } = useIntl();
  if (typeof value === "string") return <>{value}</>;
  return (
    <>
      {renderActionCardMsg(value, locale).map((segment, index) => "text" in segment
        ? <Fragment key={index}>{segment.text}</Fragment>
        : <ActionCardEntityChip key={index} entityRef={segment.ref} />)}
    </>
  );
}

/** Card copy where only text fits: entity params as plain names. */
export function useActionCardMsgText(value: string | ActionCardSpecMsg): string {
  return useActionCardMsgTextResolver()(value);
}

/** useActionCardMsgText for a list of messages (a select's options). */
export function useActionCardMsgTextResolver(): (value: string | ActionCardSpecMsg) => string {
  const { locale } = useIntl();
  const nameOf = useEntityNameResolver();
  return useCallback((value: string | ActionCardSpecMsg) => {
    if (typeof value === "string") return value;
    return renderActionCardMsg(value, locale).map((segment) => "text" in segment ? segment.text : nameOf(segment.ref)).join("");
  }, [locale, nameOf]);
}

/** Card copy where only text fits (badges, labels, notes). */
export function ActionCardPlainText({ value }: { value: string | ActionCardSpecMsg }) {
  return <>{useActionCardMsgText(value)}</>;
}
