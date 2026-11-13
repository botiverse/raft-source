import { Fragment, useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { CodeBlock, CodeBlockBody, CodeBlockHeader, CodeBlockPre, CodeBlockTitle, MessageItemSearchMatch, TextLink } from "@botiverse/raft-ui";

import { AgentContextViewMarkdown } from "./AgentContextViewMarkdown";
import { useAgentContextViewFold } from "./useAgentContextViewFold";
import { splitAgentContextViewHits, splitAgentContextViewSliceHits } from "./agentContextViewMessageFilter";
import type { AgentContextViewTextPiece } from "./agentContextViewMessageFilter";

/**
 * The context view's text pieces (AgentContextViewContent): a long text
 * folded to its first lines (as Markdown or as code), a code card, a muted
 * hint, and search's marks.
 */

/** The search's pattern, and which of this part's matches is the current one (null: none here). */
export type PartSearch = { pattern: RegExp; hit: number | null };

function keep(text: string): string {
  return text;
}

function Pieces({ pieces, search, show }: { pieces: AgentContextViewTextPiece[]; search: PartSearch | null | undefined; show: (text: string) => string }) {
  return pieces.map((piece) => (piece.hit === null
    ? <Fragment key={piece.start}>{show(piece.text)}</Fragment>
    : (
      <MessageItemSearchMatch
        key={piece.start}
        className={piece.hit === search?.hit ? "outline-2 outline-foreground" : undefined}
        data-agent-context-view-match={piece.hit === search?.hit ? "current" : "other"}
        data-testid="agent-context-view-match"
      >
        {show(piece.text)}
      </MessageItemSearchMatch>
    )));
}

/**
 * Text with the search's matches marked (raft-ui's search hit, a `mark`); the
 * current match is outlined too, so it reads apart from the others. The text
 * may be a prefix of the part's (folded): its matches are the part's first.
 */
export function Highlighted({ text, search, show = keep }: {
  text: string;
  search?: PartSearch | null;
  /** How each piece is drawn, after matching on `text` as it is (a folded result's line flattens line breaks). */
  show?: (text: string) => string;
}) {
  const pattern = search?.pattern ?? null;
  const pieces = useMemo(() => (pattern ? splitAgentContextViewHits(text, pattern) : null), [text, pattern]);
  if (!pieces) return show(text);
  return <Pieces pieces={pieces} search={search} show={show} />;
}

/** `text` from `start` to `end`, its matches numbered as search numbers them in the whole of `text` (a call's argument in its input). */
export function HighlightedSlice({ text, start, end, search }: { text: string; start: number; end: number; search?: PartSearch | null }) {
  const pattern = search?.pattern ?? null;
  const pieces = useMemo(() => (pattern ? splitAgentContextViewSliceHits(text, start, end, pattern) : null), [text, start, end, pattern]);
  if (!pieces) return text.slice(start, end);
  return <Pieces pieces={pieces} search={search} show={keep} />;
}

/** Pieces already cut and sliced (sliceAgentContextViewPieces), drawn with their marks. */
export function HighlightedPieces({ pieces, search }: { pieces: AgentContextViewTextPiece[]; search: PartSearch | null }) {
  return <Pieces pieces={pieces} search={search} show={keep} />;
}

/** Show all N lines / Show less: a quiet text link under the text, not a button bar. */
export function FoldToggle({ open, lines, onToggle }: { open: boolean; lines: number; onToggle: () => void }) {
  const { formatMessage } = useIntl();
  return (
    <TextLink className="mt-1 self-start justify-self-start font-sans text-caption" onClick={onToggle} aria-expanded={open} data-testid="agent-context-view-fold">
      {open ? formatMessage({ id: "agentContextView.showLess" }) : formatMessage({ id: "agentContextView.showAllLines" }, { count: lines })}
    </TextLink>
  );
}

/**
 * A long text folded to its first lines, with Show all. In the Messages list
 * the list holds whether it is open (`open`, `onToggle`), so it survives its
 * row scrolling out and back, and search can open it. `markdown`: drawn as
 * Markdown (AgentContextViewMarkdown); `mono`: as code, wrapped; otherwise
 * plain text.
 */
export function FoldedText({ text, mono, markdown, whole, foldTo, testId, open: openProp, onToggle, search }: {
  text: string;
  mono?: boolean;
  markdown?: boolean;
  /** Fold past this many lines to them (a tool's output), instead of the default. */
  foldTo?: number;
  /** The ringed send call: shown whole (no fold), so the whole command reads. */
  whole?: boolean;
  testId?: string;
  open?: boolean;
  onToggle?: () => void;
  search?: PartSearch | null;
}) {
  const { lines, long, folded } = useAgentContextViewFold(text, whole, foldTo);
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const toggle = useCallback(() => (onToggle ? onToggle() : setOpenState((value) => !value)), [onToggle]);
  const shown = long && !open ? folded : text;
  let body: ReactNode;
  if (markdown) body = <AgentContextViewMarkdown source={shown} search={search ?? null} testId={testId} />;
  else if (mono) {
    body = (
      <CodeBlockPre className="whitespace-pre-wrap wrap-break-word" data-whole={whole ? "true" : undefined} data-testid={testId}>
        <Highlighted text={shown} search={search} />
      </CodeBlockPre>
    );
  } else body = <p className="whitespace-pre-wrap wrap-break-word" data-testid={testId}><Highlighted text={shown} search={search} /></p>;
  return (
    <>
      {body}
      {long ? <FoldToggle open={open} lines={lines} onToggle={toggle} /> : null}
    </>
  );
}

export function CodeCard({ title, text, whole, testId, open, onToggle, search }: {
  title: ReactNode;
  text: string;
  whole?: boolean;
  testId?: string;
  open?: boolean;
  onToggle?: () => void;
  search?: PartSearch | null;
}) {
  return (
    <CodeBlock className="flex min-w-0 max-w-full flex-col" data-testid={testId}>
      <CodeBlockHeader>
        <CodeBlockTitle>{title}</CodeBlockTitle>
      </CodeBlockHeader>
      <CodeBlockBody>
        <FoldedText text={text} mono whole={whole} open={open} onToggle={onToggle} search={search} />
      </CodeBlockBody>
    </CodeBlock>
  );
}

export function Hint({ icon, children, testId }: { icon?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <p className="flex items-center gap-1.5 text-callout text-foreground-muted [&_svg]:size-4 [&_svg]:shrink-0" data-testid={testId}>
      {icon}
      <span>{children}</span>
    </p>
  );
}
