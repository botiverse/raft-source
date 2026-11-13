import { memo, useId, useMemo } from "react";
import type { ComponentType } from "react";
import { useIntl } from "react-intl";
import { Bot, ChevronDown, ChevronRight, FileText, Globe, LocateFixed, Pencil, Search, SquareTerminal, Wrench } from "lucide-react";
import {
  CodeBlock,
  CodeBlockBody,
  CodeBlockHeader,
  CodeBlockTitle,
  MessageItemSender,
  Status,
  TextLink,
} from "@botiverse/raft-ui";
import type { AgentContextViewPart } from "@botiverse/raft-shared";

import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import AvatarSlot from "../ui/AvatarSlot";
import { AgentContextViewMarkdown } from "./AgentContextViewMarkdown";
import { FoldedText } from "./AgentContextViewText";
import type { PartSearch } from "./AgentContextViewText";
import { ToolCall } from "./AgentContextViewToolCall";
import { agentContextViewToolInput, agentContextViewToolSummary, countHits } from "./agentContextViewMessageFilter";

type ToolUsePart = Extract<AgentContextViewPart, { kind: "tool_use" }>;
type ToolResultPart = Extract<AgentContextViewPart, { kind: "tool_result" }>;

/** A tool's output folds past this many lines to them. */
const OUTPUT_LINES = 12;

const TOOL_ICONS: Array<[RegExp, ComponentType<{ "aria-hidden"?: boolean; className?: string }>]> = [
  [/^(bash|shell|exec|run|terminal)/i, SquareTerminal],
  [/^(read|view|cat)/i, FileText],
  [/(edit|write|patch|update)/i, Pencil],
  [/(grep|glob|search|find)/i, Search],
  [/(web|fetch|url|browser)/i, Globe],
  [/^(agent|task)$/i, Bot],
];

function ToolIcon({ name }: { name: string }) {
  const Icon = TOOL_ICONS.find(([pattern]) => pattern.test(name))?.[1] ?? Wrench;
  return <Icon aria-hidden className="size-4 shrink-0 text-foreground-muted" />;
}

function lineCount(text: string): number {
  let lines = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) lines++;
  return lines;
}

/** A call's result, inside its step: its own message (data-message-index), titled by its size, folded past 12 lines. */
function Output({ result, open, onToggle, search }: { result: { part: ToolResultPart; messageIndex: number }; open: boolean; onToggle: () => void; search: PartSearch | null }) {
  const { formatMessage } = useIntl();
  const { part } = result;
  return (
    <div className="min-w-0" data-message-index={result.messageIndex} data-testid="agent-context-view-tool-output">
      <CodeBlock className="flex min-w-0 max-w-full flex-col" data-testid="agent-context-view-tool-result">
        <CodeBlockHeader>
          <CodeBlockTitle>
            {formatMessage({ id: part.isError ? "agentContextView.part.error" : "agentContextView.step.output" })}
            <span className="ms-2 font-sans text-caption text-foreground-muted">
              {part.output ? formatMessage({ id: "agentContextView.step.lines" }, { count: lineCount(part.output) }) : formatMessage({ id: "agentContextView.step.emptyOutput" })}
            </span>
          </CodeBlockTitle>
        </CodeBlockHeader>
        {part.output ? (
          <CodeBlockBody>
            <FoldedText text={part.output} mono foldTo={OUTPUT_LINES} open={open} onToggle={onToggle} search={search} />
          </CodeBlockBody>
        ) : null}
      </CodeBlock>
    </div>
  );
}

/**
 * A tool call and its result as one step: a line (chevron, step number,
 * tool, what it did; at its right the result's size and a status light,
 * green when it succeeded, orange when it failed) that opens the call's
 * input and the output. A failed step stays folded too: the light says it.
 */
export const AgentContextViewToolStep = memo(function AgentContextViewToolStep({ joinTop = false, joinBottom = false, call, step, result, open, onToggle, inputOpen, onToggleInput, outputOpen, onToggleOutput, callSearch, resultSearch }: {
  /**
   * Consecutive steps read as one card: joined to the step above, no top
   * corners (its top border is the hairline between them); to the step
   * below, no bottom corners and no bottom border.
   */
  joinTop?: boolean;
  joinBottom?: boolean;
  call: ToolUsePart;
  step: number | null;
  /** Its result, when the context has it in this row. */
  result: { part: ToolResultPart; messageIndex: number } | null;
  open: boolean;
  onToggle: () => void;
  inputOpen: boolean;
  onToggleInput: () => void;
  outputOpen: boolean;
  onToggleOutput: () => void;
  callSearch: PartSearch | null;
  resultSearch: PartSearch | null;
}) {
  const { formatMessage, formatNumber } = useIntl();
  const bodyId = useId();
  const summary = useMemo(() => agentContextViewToolSummary(call.input), [call.input]);
  const pattern = callSearch?.pattern ?? resultSearch?.pattern ?? null;
  // Folded, its marks are hidden: say how many matches opening it shows.
  const matches = useMemo(
    () => (open || !pattern ? 0 : countHits(agentContextViewToolInput(call).text, pattern) + (result ? countHits(result.part.output, pattern) : 0)),
    [call, open, pattern, result],
  );
  const failed = result?.part.isError ?? false;
  const size = result
    ? (result.part.output ? formatMessage({ id: "agentContextView.step.lines" }, { count: lineCount(result.part.output) }) : formatMessage({ id: "agentContextView.step.emptyOutput" }))
    : formatMessage({ id: "agentContextView.step.noResult" });
  return (
    <div
      className={`min-w-0 overflow-hidden border border-line-hairline ${joinTop ? "" : "rounded-t-lg"} ${joinBottom ? "border-b-0" : "rounded-b-lg"}`}
      data-testid="agent-context-view-tool-step"
      data-join-top={joinTop ? "true" : undefined}
      data-join-bottom={joinBottom ? "true" : undefined}
      data-status={result ? (failed ? "error" : "ok") : "none"}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={onToggle}
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left outline-none hover:bg-fill-muted focus-visible:inset-ring-2 focus-visible:inset-ring-foreground"
        data-testid="agent-context-view-step-toggle"
      >
        {open ? <ChevronDown aria-hidden className="size-4 shrink-0" /> : <ChevronRight aria-hidden className="size-4 shrink-0" />}
        {step !== null ? <span className="shrink-0 font-mono text-mono-meta tabular-nums text-foreground-hint" data-testid="agent-context-view-step-number">{formatNumber(step)}</span> : null}
        <ToolIcon name={call.toolName} />
        <span className="min-w-0 flex-1 truncate" data-testid="agent-context-view-step-title">
          <span className="font-mono text-mono-meta font-semibold text-foreground">{call.toolName}</span>
          {summary ? <span className="ms-2 text-callout text-foreground-muted" data-testid="agent-context-view-tool-summary">{summary}</span> : null}
        </span>
        {matches > 0 ? (
          <span className="shrink-0 text-caption text-foreground" data-testid="agent-context-view-step-matches">
            {formatMessage({ id: "agentContextView.search.partMatches" }, { count: matches })}
          </span>
        ) : null}
        <span className="flex shrink-0 items-center gap-1.5 font-mono text-mono-meta text-foreground-hint" data-testid="agent-context-view-step-size">
          {result ? (
            <Status
              size="xs"
              variant={failed ? "warning" : "success"}
              aria-label={formatMessage({ id: failed ? "agentContextView.step.failed" : "agentContextView.step.succeeded" })}
              data-testid="agent-context-view-step-status"
            />
          ) : null}
          {size}
        </span>
      </button>
      {open ? (
        <div id={bodyId} className="grid min-w-0 grid-cols-1 gap-2 border-t border-line-hairline px-3 py-2">
          <ToolCall part={call} label={formatMessage({ id: "agentContextView.step.input" })} open={inputOpen} onToggle={onToggleInput} search={callSearch} />
          {result ? <Output result={result} open={outputOpen} onToggle={onToggleOutput} search={resultSearch} /> : null}
        </div>
      ) : null}
    </div>
  );
});

/** The command's name, as code (not copy to translate). */
const SEND_COMMAND = "raft message send";

/** `raft message send`'s target, as the command names it; null when it doesn't. */
function sendTarget(input: unknown): string | null {
  const command = typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>).command : input;
  if (typeof command !== "string") return null;
  const match = /--(?:target|channel)[= ](?:'([^']*)'|"([^"]*)"|(\S+))/.exec(command);
  return match ? (match[1] ?? match[2] ?? match[3] ?? null) : null;
}

/**
 * The call that sent the message, the turn's last step: "Step N · Sent this
 * message" on the info wash, the message as the channel shows it, and the
 * command behind Show Command (shown whole). Without the message's text, the
 * command shows at once.
 */
export const AgentContextViewSendStep = memo(function AgentContextViewSendStep({ call, step, index, sent, agentName, agentAvatarUrl, open, onToggle, inputOpen, onToggleInput, search }: {
  call: ToolUsePart;
  step: number | null;
  /** The message index, at the step's right. */
  index: number;
  sent: { content: string; createdAt: string } | null;
  agentName: string;
  agentAvatarUrl: string | null;
  open: boolean;
  onToggle: () => void;
  inputOpen: boolean;
  onToggleInput: () => void;
  search: PartSearch | null;
}) {
  const { formatMessage } = useIntl();
  const { formatMessageTime } = useTimeFormatter();
  const target = useMemo(() => sendTarget(call.input), [call.input]);
  const commandShown = open || sent === null;
  return (
    <div
      className="grid min-w-0 grid-cols-1 gap-2 rounded-xl bg-info-soft p-2"
      aria-current="true"
      aria-label={formatMessage({ id: "agentContextView.sentByThisCall" })}
      data-testid="agent-context-view-trigger"
    >
      <div className="flex items-center gap-2 px-1">
        <span className="min-w-0 flex-1 font-semibold" data-testid="agent-context-view-trigger-title">
          {step === null ? formatMessage({ id: "agentContextView.step.sentNoStep" }) : formatMessage({ id: "agentContextView.step.sent" }, { step })}
        </span>
        <span className="shrink-0 font-mono text-mono-meta tabular-nums text-foreground-hint">{formatMessage({ id: "agentContextView.messageIndex" }, { index })}</span>
      </div>
      <div className="grid min-w-0 grid-cols-1 overflow-hidden rounded-lg bg-layer-canvas ring-2 ring-foreground">
        <div className="flex min-w-0 items-center gap-2 border-b border-line-hairline px-3 py-2 text-callout" data-testid="agent-context-view-trigger-command">
          <LocateFixed aria-hidden className="size-4 shrink-0 text-foreground-muted" />
          <span className="min-w-0 truncate">
            <span className="font-mono text-mono-meta">{call.toolName === "Bash" || target ? SEND_COMMAND : call.toolName}</span>
            {target ? <span className="ms-1.5 text-foreground-muted">{formatMessage({ id: "agentContextView.step.sendTo" }, { target })}</span> : null}
          </span>
        </div>
        {sent ? (
          <div className="flex min-w-0 gap-3 px-3 py-2" data-testid="agent-context-view-sent-message">
            <AvatarSlot context="message-row" type="agent" agentAvatarUrl={agentAvatarUrl} />
            <div className="grid min-w-0 flex-1 grid-cols-1 gap-1">
              <div className="flex items-baseline gap-1.5">
                <MessageItemSender>{agentName}</MessageItemSender>
                <span className="font-mono text-mono-meta text-foreground-hint">{formatMessageTime(sent.createdAt)}</span>
              </div>
              <AgentContextViewMarkdown source={sent.content} search={null} />
              <TextLink variant="strong" className="justify-self-start font-sans text-caption underline" onClick={onToggle} aria-expanded={open} data-testid="agent-context-view-show-command">
                {formatMessage({ id: open ? "agentContextView.step.hideCommand" : "agentContextView.step.showCommand" })}
              </TextLink>
            </div>
          </div>
        ) : null}
        {commandShown ? (
          <div className="min-w-0 p-2">
            <ToolCall part={call} whole open={inputOpen} onToggle={onToggleInput} search={search} />
          </div>
        ) : null}
      </div>
    </div>
  );
});
