import { useId, useMemo } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockBody,
  CodeBlockHeader,
  CodeBlockPre,
  CodeBlockTitle,
  DescriptionDetails,
  DescriptionItem,
  DescriptionList,
  DescriptionTerm,
} from "@botiverse/raft-ui";
import type { AgentContextViewPart } from "@botiverse/raft-shared";

import CopyButton from "../ui/CopyButton";
import CopyIconButton from "../ui/CopyIconButton";
import { FoldToggle, FoldedText, Highlighted, HighlightedSlice } from "./AgentContextViewText";
import type { PartSearch } from "./AgentContextViewText";
import { useAgentContextViewFold } from "./useAgentContextViewFold";
import {
  TOOL_RESULT_PREVIEW_CHARS,
  agentContextViewResultPreview,
  agentContextViewToolInput,
  agentContextViewToolSummary,
  countHits,
  flattenAgentContextViewWhitespace,
} from "./agentContextViewMessageFilter";
import type { AgentContextViewInputEntry } from "./agentContextViewMessageFilter";

type ToolUsePart = Extract<AgentContextViewPart, { kind: "tool_use" }>;
type ToolResultPart = Extract<AgentContextViewPart, { kind: "tool_result" }>;

/** A call's title: the tool's name (code), then what it did in a few words (prose). */
function CallTitle({ name, summary }: { name: string; summary: string | null }) {
  return (
    <>
      <span className="text-foreground">{name}</span>
      {summary ? <span className="ms-2 font-sans text-caption text-foreground-muted" data-testid="agent-context-view-tool-summary">{summary}</span> : null}
    </>
  );
}

/** The call's id is no title: it is copied from here, and shown in the button's tooltip. */
function CopyCallId({ id }: { id: string }) {
  const { formatMessage } = useIntl();
  return (
    <CopyButton text={id} resetKey={id}>
      {({ copied, disabled, onClick, onMouseDown }) => (
        <CopyIconButton
          onClick={onClick}
          onMouseDown={onMouseDown}
          disabled={disabled}
          copied={copied}
          copiedLabel={formatMessage({ id: "agentContextView.part.callIdCopied" })}
          copyLabel={formatMessage({ id: "agentContextView.part.copyCallId" }, { id })}
          className="rounded-chip"
          data-testid="agent-context-view-copy-call-id"
        />
      )}
    </CopyButton>
  );
}

/** A flat input's arguments, `end` the shown text's end (a folded input shows its first ones). */
function Arguments({ text, entries, end, search }: { text: string; entries: readonly AgentContextViewInputEntry[]; end: number; search: PartSearch | null }) {
  return (
    <DescriptionList direction="horizontal" className="py-1" data-testid="agent-context-view-tool-arguments">
      {entries.filter((entry) => entry.keyStart < end).map((entry) => (
        <DescriptionItem key={entry.keyStart}>
          <DescriptionTerm>
            <HighlightedSlice text={text} start={entry.keyStart} end={Math.min(entry.keyStart + entry.key.length, end)} search={search} />
          </DescriptionTerm>
          <DescriptionDetails>
            <span className="min-w-0 max-w-full whitespace-pre-wrap wrap-break-word">
              <HighlightedSlice text={text} start={entry.valueStart} end={Math.min(entry.valueStart + entry.value.length, end)} search={search} />
            </span>
          </DescriptionDetails>
        </DescriptionItem>
      ))}
    </DescriptionList>
  );
}

/**
 * A tool call: its name and a summary for a title, the id behind a copy
 * button; a flat input as its arguments (key, value; values wrap), any other
 * as wrapped JSON. Long inputs fold to their first lines unless shown `whole`
 * (the send call). `label`: a title in place of the tool and summary (a
 * step's Input, whose line already names them).
 */
export function ToolCall({ part, whole, label, open, onToggle, search }: {
  part: ToolUsePart;
  whole?: boolean;
  label?: ReactNode;
  open: boolean;
  onToggle: () => void;
  search: PartSearch | null;
}) {
  const input = agentContextViewToolInput(part);
  const summary = useMemo(() => agentContextViewToolSummary(part.input), [part.input]);
  const { lines, long, folded } = useAgentContextViewFold(input.text, whole);
  const shown = long && !open ? folded : input.text;
  return (
    <CodeBlock className="flex min-w-0 max-w-full flex-col" data-testid="agent-context-view-tool-use">
      <CodeBlockHeader>
        <CodeBlockTitle data-testid="agent-context-view-tool-title">
          {label ?? <CallTitle name={part.toolName} summary={summary} />}
        </CodeBlockTitle>
        {part.toolUseId ? (
          <CodeBlockActions>
            <CopyCallId id={part.toolUseId} />
          </CodeBlockActions>
        ) : null}
      </CodeBlockHeader>
      <CodeBlockBody>
        {input.entries
          ? <Arguments text={input.text} entries={input.entries} end={shown.length} search={search} />
          : (
            <CodeBlockPre className="whitespace-pre-wrap wrap-break-word" data-whole={whole ? "true" : undefined}>
              <Highlighted text={shown} search={search} />
            </CodeBlockPre>
          )}
        {long ? <FoldToggle open={open} lines={lines} onToggle={onToggle} /> : null}
      </CodeBlockBody>
    </CodeBlock>
  );
}

/**
 * A tool's result, folded by default to one line: its title, then what its
 * call did (the call's summary) or, without one, the output's first
 * characters. The line is the button that shows the whole output (CodeBlock's
 * header rendered as a button, aria-expanded).
 */
export function ToolResult({ part, call, expanded, onExpand, textOpen, onToggleText, search }: {
  part: ToolResultPart;
  /** The call this result answers, when the context has it. */
  call: ToolUsePart | null;
  expanded: boolean;
  onExpand: () => void;
  textOpen: boolean;
  onToggleText: () => void;
  search: PartSearch | null;
}) {
  const { formatMessage } = useIntl();
  const bodyId = useId();
  const toolName = part.toolName ?? call?.toolName ?? null;
  const title = toolName
    ? formatMessage({ id: part.isError ? "agentContextView.part.errorOf" : "agentContextView.part.resultOf" }, { tool: toolName })
    : formatMessage({ id: part.isError ? "agentContextView.part.error" : "agentContextView.part.result" });
  const summary = useMemo(() => (call ? agentContextViewToolSummary(call.input) : null), [call]);
  const preview = expanded || summary ? "" : agentContextViewResultPreview(part.output);
  // Folded, its marks are hidden: say how many matches opening it shows.
  const pattern = search?.pattern ?? null;
  const matches = useMemo(() => (expanded || !pattern ? 0 : countHits(part.output, pattern)), [expanded, part.output, pattern]);
  return (
    <CodeBlock className="flex min-w-0 max-w-full flex-col" data-testid="agent-context-view-tool-result">
      <CodeBlockHeader
        render={<button type="button" aria-expanded={expanded} aria-controls={expanded ? bodyId : undefined} onClick={onExpand} />}
        className={`w-full text-left outline-none hover:bg-fill-muted focus-visible:inset-ring-2 focus-visible:inset-ring-foreground ${expanded ? "" : "border-b-0"}`}
        data-testid="agent-context-view-result-toggle"
      >
        {expanded ? <ChevronDown aria-hidden className="size-4 shrink-0" /> : <ChevronRight aria-hidden className="size-4 shrink-0" />}
        <CodeBlockTitle>
          {title}
          {summary ? <span className="ms-2 font-sans text-caption text-foreground-muted" data-testid="agent-context-view-tool-summary">{summary}</span> : null}
          {preview ? (
            <span className="ms-2 text-foreground-muted" data-testid="agent-context-view-result-preview">
              <Highlighted text={preview} search={search} show={flattenAgentContextViewWhitespace} />
              {part.output.length > TOOL_RESULT_PREVIEW_CHARS ? "…" : null}
            </span>
          ) : null}
          {matches > 0 ? (
            <span className="ms-2 font-sans text-caption text-foreground" data-testid="agent-context-view-result-matches">
              {formatMessage({ id: "agentContextView.search.partMatches" }, { count: matches })}
            </span>
          ) : null}
        </CodeBlockTitle>
      </CodeBlockHeader>
      {expanded ? (
        <CodeBlockBody id={bodyId}>
          <FoldedText text={part.output} mono open={textOpen} onToggle={onToggleText} search={search} />
        </CodeBlockBody>
      ) : null}
    </CodeBlock>
  );
}
