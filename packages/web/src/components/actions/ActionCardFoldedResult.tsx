// The end of a done card's folded header: an arrow and what came of it, the
// result section's first item (handoffs-and-approvals.md, Done), only when
// that says something the card's title doesn't (ActionCardSpecCard). Its own
// component: the title check reads the viewer's stores to name references,
// and only this line re-renders when they change, not the card.

import { useCallback, useMemo, useRef } from "react";
import { useIntl } from "react-intl";
import { cn } from "@botiverse/raft-ui/cn";
import { useTruncated } from "@botiverse/raft-ui/wip";
import { renderActionCardMsg } from "@botiverse/raft-shared";
import type { ActionCardSpecEntityRef, ActionCardSpecMsg } from "@botiverse/raft-shared";
import { useEntityLookupFor } from "./actionCardEntities";
import { ActionCardResultHeadlineText } from "./ActionCardSpecRenderer";
import type { ActionCardResultHeadline } from "./ActionCardSpecRenderer";
import Tooltip from "../ui/Tooltip";

// Before the result: punctuation, not copy. The no-break space keeps the arrow
// on its first word's line; the line may wrap before the arrow.
const RESULT_ARROW = "→\u00a0";

/**
 * " → <the result's first item>" after who did it, or nothing when the title
 * says it already (a warning always shows). One line at most, as the header
 * keeps its height: cut at the line's end with an ellipsis, and the whole of
 * it in a tooltip, as a cut button label is (nowrap, so a name never breaks
 * inside itself either; the line may still wrap before the arrow). A warning
 * stays a warning: the result's own tone, warning-strong text, as the body
 * draws that line and as the DS writes text about a failure (color.md); a
 * failure folded under a green Done must not read as a plain outcome.
 */
export function ActionCardFoldedResult({ item, title }: { item: ActionCardResultHeadline; title: string | ActionCardSpecMsg }) {
  const { isNew, text } = useFoldedResult(item, title);
  const lineRef = useRef<HTMLSpanElement>(null);
  const truncated = useTruncated(lineRef);
  if (!isNew) return null;
  const warning = item.type === "Text" && item.props.tone === "warning";
  return (
    <>
      {" "}
      <Tooltip content={text} disabled={!truncated}>
        <span className="inline-block max-w-full align-bottom" data-action-card-result-line="">
          <span
            ref={lineRef}
            className={cn("block truncate", warning && "text-warning-strong")}
            data-action-card-result-headline=""
            data-action-card-result-tone={warning ? "warning" : undefined}
          >
            {RESULT_ARROW}<ActionCardResultHeadlineText item={item} />
          </span>
        </span>
      </Tooltip>
    </>
  );
}

/**
 * Whether the folded header's target says more than the card's title (and
 * its text, for the tooltip): `isNew` false
 * when everything it names is in the title already ("Create private channel
 * #launch-week" → #launch-week), so the header doesn't repeat it. A warning
 * is always new: its words may repeat the title, but not that it went wrong.
 * What it names: each reference (its id, its name, its fallback), each param
 * of its Msg, or, for text without params, the text itself; the title's: its params
 * (references by id and name) and its text. Names compare without case and
 * without a leading # or @.
 */
function useFoldedResult(item: ActionCardResultHeadline, title: string | ActionCardSpecMsg): { isNew: boolean; text: string } {
  const { locale } = useIntl();
  // Names only the references the line and the title hold (by id): another entity changing re-renders nothing.
  const refs = useMemo(() => [...msgRefs(title), ...headlineRefs(item)], [item, title]);
  const lookup = useEntityLookupFor(refs);
  const nameOf = useCallback((ref: ActionCardSpecEntityRef) => lookup(ref)?.name ?? ref.fallback, [lookup]);
  return useMemo(() => {
    const word = (value: string) => value.trim().toLocaleLowerCase().replace(/^[#@]/, "");
    const textOf = (value: string | ActionCardSpecMsg) => (typeof value === "string" ? value : renderActionCardMsg(value, locale)
      .map((segment) => ("text" in segment ? segment.text : nameOf(segment.ref))).join(""));
    const titleIds = new Set<string>();
    const titleWords = new Set<string>();
    if (typeof title !== "string") {
      for (const value of Object.values(title.params ?? {})) {
        if (typeof value === "string" || typeof value === "number") titleWords.add(word(String(value)));
        else {
          titleIds.add(value.id.toLowerCase());
          titleWords.add(word(nameOf(value)));
          titleWords.add(word(value.fallback));
        }
      }
    }
    const titleText = textOf(title).toLocaleLowerCase();
    const refKnown = (ref: ActionCardSpecEntityRef) => titleIds.has(ref.id.toLowerCase()) || titleWords.has(word(nameOf(ref))) || titleWords.has(word(ref.fallback));
    const textKnown = (value: string | ActionCardSpecMsg) => {
      if (typeof value !== "string" && value.params && Object.keys(value.params).length > 0) {
        return Object.values(value.params).every((param) => (typeof param === "string" || typeof param === "number" ? titleWords.has(word(String(param))) : refKnown(param)));
      }
      const text = textOf(value).trim().toLocaleLowerCase();
      return text.length > 0 && (titleWords.has(word(text)) || titleText.includes(text));
    };
    switch (item.type) {
      case "Text":
        // A warning always shows, even in the title's words: it says the action didn't go as the title reads.
        return { isNew: item.props.tone === "warning" || !textKnown(item.props.text), text: textOf(item.props.text) };
      case "Field":
        return Array.isArray(item.props.value)
          ? { isNew: !item.props.value.every(refKnown), text: item.props.value.map(nameOf).join(", ") }
          : { isNew: !textKnown(item.props.value), text: textOf(item.props.value) };
      case "EntityRef":
        return { isNew: !refKnown(item.props), text: nameOf(item.props) };
      default:
        return { isNew: false, text: "" };
    }
  }, [item, locale, nameOf, title]);
}

/** The references a Msg's params hold. */
function msgRefs(value: string | ActionCardSpecMsg): ActionCardSpecEntityRef[] {
  if (typeof value === "string") return [];
  return Object.values(value.params ?? {}).filter((param): param is ActionCardSpecEntityRef => typeof param === "object");
}

/** The references the result's first item names. */
function headlineRefs(item: ActionCardResultHeadline): ActionCardSpecEntityRef[] {
  switch (item.type) {
    case "Text":
      return msgRefs(item.props.text);
    case "Field":
      return Array.isArray(item.props.value) ? item.props.value : msgRefs(item.props.value);
    case "EntityRef":
      return [item.props];
    default:
      return [];
  }
}
