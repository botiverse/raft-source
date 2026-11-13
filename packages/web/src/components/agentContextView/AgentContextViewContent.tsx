import { memo, useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  Badge,
  DescriptionDetails,
  DescriptionItem,
  DescriptionList,
  DescriptionTerm,
  PanelSection,
} from "@botiverse/raft-ui";
import type { AgentContextView, AgentContextViewPart, AgentContextViewTool, DiagnosticRedactionKind } from "@botiverse/raft-shared";
import { getRuntimeDisplayName } from "@botiverse/raft-shared";

import type { MessageId } from "../../i18n/messages/en";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { AgentContextViewMessageList } from "./AgentContextViewMessageList";
import { CodeCard, FoldedText, Hint } from "./AgentContextViewText";

/**
 * The restored context of the one model request that sent the message (spec
 * §7, §10; design deliverables/view-context-mock "Panel"): its facts, then
 * three folding sections, System prompt and Tools folded, Messages open, each
 * with its count and characters (the provider's token count is the request's
 * whole; a per-section token count would be a local estimate, left out of v0).
 * System prompt and Tools read as before: Markdown blocks, and each tool with
 * its description and input schema.
 *
 * Messages read as a timeline of turns (#wg-ax, qizhi-wang chose B,
 * 2026-11-06; design deliverables/vc-render B.html, B-expanded.html):
 * consecutive messages of one side are one turn on a vertical rail, marked by
 * who it is: the user (an icon, "User", and "from Raft" when Raft wrote the
 * text), the agent (its avatar and name, "N steps", its tool calls), or the
 * system; the turn's message range ("#1–#7") sits at its right.
 * - Raft's notices: a user's text that Raft wrote (inbox notices, task
 *   notices, message headers `[target=… msg=…] @sender: body`; read by
 *   raftDeliveryParse in @botiverse/raft-shared from the daemon's own formats) is a card,
 *   several notices under "Raft delivered N notices". Each notice is one line
 *   (an inbox's conversation, who it's new from and how many unread; a task
 *   and its status; who wrote a message where, and when, the message's body
 *   always shown under it) that opens its parsed fields and the original
 *   text (mono, copyable). A bracketed `[Raft …]` notice this build can't
 *   read is a generic "Raft notice" card that opens to its original text;
 *   text without Raft's marks is Markdown as before
 *   (AgentContextViewRaftNotice).
 * - Steps: a tool call and its result are one folded line (chevron, step
 *   number, the tool's icon and name, what it did, the result's size and a
 *   light, green when it succeeded, orange when it failed; a failed step is
 *   not opened for you), opening to the input's arguments and the output,
 *   its first 12 lines then Show all (AgentContextViewToolStep). The result's
 *   message is folded into its call's row but keeps its own index (its
 *   output is `data-message-index` of its own) and its own search matches.
 * - The send step: the `raft message send` call (`trigger`) is the turn's
 *   last step, "Step N · Sent this message" on the info wash, the message as
 *   the channel shows it, the command behind Show Command. The panel opens
 *   there. Without a trigger (the call isn't in this request, e.g. a
 *   sub-agent sent it) it opens at the last message, nothing marked; the
 *   sentence saying so is the panel's notice (AgentContextViewBody).
 * Text (assistant text, thinking) is Markdown at the transcript's size from a
 * short allowlist that loads nothing (AgentContextViewMarkdown); code wraps
 * on the code surface; hidden thinking is a small badge. Every column between
 * the content and the panel is min-w-0 / minmax(0,1fr), long paths break
 * after a `/`, and the facts' long values break, so nothing widens the
 * panel's content past its viewport.
 *
 * A context can hold thousands of messages: the Messages list is virtual
 * (only the rows near the panel's viewport are mounted, in the panel's own
 * scroller). The virtual unit stays the message, not the turn (a turn can
 * hold hundreds of steps): a turn's first row draws its mark and header,
 * every row draws the rail, so the turn reads as one. Only a message of tool
 * results joins the row of the call it answers. The whole view is memoized
 * on the context, so Viewed by or a status refresh arriving later re-renders
 * none of it.
 *
 * The Messages list has a toolbar, sticky at the top of the panel's scroller
 * (AgentContextViewToolbar; it wraps where the panel is narrow):
 * - Search over what the filter shows: text, thinking, tool inputs (as the
 *   arguments shown), tool results, compaction summaries, and Raft notices
 *   (their original text, so every parsed field is found): case-insensitive,
 *   "3 of 17", Previous / Next (Enter / Shift+Enter, wrapping), Esc clears.
 *   Going to a match scrolls the virtual list to its row and opens what hides
 *   it (the notice, the step, Show all); matches are marked (raft-ui's search
 *   hit), the current one outlined; a folded step or notice says how many it
 *   holds.
 * - Filter, which is also search's type scope: All, Conversation (the user's
 *   and the agent's text, Raft's notice cards included), Raft notices, or
 *   Tool calls (the steps), each segment with how many messages it shows.
 *   The section's meta keeps the whole request's count and characters: it
 *   describes the request, the filter only the view of it.
 * - Jumps: to the send step (when there is one; from a filter that hides
 *   it, back to All), to the top, to the last message.
 * Which folds are open is kept by the list, so it outlives a row scrolled out.
 */


const REDACTION_COPY: Record<DiagnosticRedactionKind, MessageId> = {
  private_key: "agentContextView.redaction.privateKey",
  raft_key: "agentContextView.redaction.raftKey",
  bearer: "agentContextView.redaction.bearer",
  authorization: "agentContextView.redaction.authorization",
  vendor_key: "agentContextView.redaction.vendorKey",
  github_token: "agentContextView.redaction.githubToken",
  aws_key: "agentContextView.redaction.awsKey",
  google_api_key: "agentContextView.redaction.googleApiKey",
  xai_key: "agentContextView.redaction.xaiKey",
  jwt: "agentContextView.redaction.jwt",
  secret_assignment: "agentContextView.redaction.secretAssignment",
  hex_blob: "agentContextView.redaction.hexBlob",
  url_query: "agentContextView.redaction.urlQuery",
  url_credentials: "agentContextView.redaction.urlCredentials",
};

function partChars(part: AgentContextViewPart): number {
  switch (part.kind) {
    case "text": return part.text.length;
    case "thinking": return part.text?.length ?? 0;
    case "tool_use": return JSON.stringify(part.input)?.length ?? 0;
    case "tool_result": return part.output.length;
    case "compaction": return part.text?.length ?? 0;
    default: return 0;
  }
}

function toolChars(tool: AgentContextViewTool): number {
  return tool.name.length + tool.description.length + (tool.inputSchema === null ? 0 : JSON.stringify(tool.inputSchema).length);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** Characters per section (UTF-16 units, as the source text's length). */
function agentContextViewSectionChars(context: AgentContextView) {
  return {
    system: sum(context.system.map((block) => block.text.length)),
    tools: sum(context.tools.map(toolChars)),
    messages: sum(context.messages.map((message) => sum(message.parts.map(partChars)))),
  };
}

function Section({ title, meta, defaultOpen = false, testId, children }: { title: string; meta: string; defaultOpen?: boolean; testId: string; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  const bodyId = `${testId}-body`;
  return (
    <PanelSection className="px-0" data-testid={testId}>
      <h3>
        <button
          type="button"
          className="flex w-full items-center gap-2 px-(--column-margin) py-2 text-left"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={toggle}
          data-testid={`${testId}-toggle`}
        >
          {open ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />}
          <span className="flex-1 font-semibold">{title}</span>
          <span className="font-mono text-xs text-foreground-muted" data-testid={`${testId}-meta`}>{meta}</span>
        </button>
      </h3>
      {open ? <div id={bodyId} className="pt-2">{children}</div> : null}
    </PanelSection>
  );
}

function ToolRow({ tool }: { tool: AgentContextViewTool }) {
  const { formatMessage } = useIntl();
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  const schema = useMemo(() => (open && tool.inputSchema !== null ? JSON.stringify(tool.inputSchema, null, 2) : null), [open, tool.inputSchema]);
  return (
    <li className="grid min-w-0 grid-cols-1 gap-2">
      <button type="button" className="flex items-center gap-2 text-left font-mono text-sm" aria-expanded={open} onClick={toggle}>
        {open ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />}
        {tool.name}
      </button>
      {open ? (
        <div className="grid min-w-0 grid-cols-1 gap-2 pl-6">
          {tool.description ? <FoldedText text={tool.description} markdown /> : null}
          {schema === null
            ? <Hint>{formatMessage({ id: "agentContextView.tools.noSchema" })}</Hint>
            : <CodeCard title={formatMessage({ id: "agentContextView.tools.inputSchema" })} text={schema} />}
        </div>
      ) : null}
    </li>
  );
}

export const AgentContextViewContent = memo(function AgentContextViewContent({ context, computerName, retainedSince, agentName, agentAvatarUrl, sentContent = null, sentAt = null }: {
  context: AgentContextView;
  /** From the status: the Computer it was read from, and the oldest request it keeps. */
  computerName: string | null;
  retainedSince: string | null;
  agentName: string;
  agentAvatarUrl: string | null;
  /** The message this context sent (its text and time), for the send step. */
  sentContent?: string | null;
  sentAt?: string | null;
}) {
  const { formatMessage, formatNumber, formatList } = useIntl();
  const { formatMediumDateTime, formatCompactDate } = useTimeFormatter();
  const chars = useMemo(() => agentContextViewSectionChars(context), [context]);
  const sent = useMemo(() => (sentContent !== null && sentAt !== null ? { content: sentContent, createdAt: sentAt } : null), [sentAt, sentContent]);

  const unknown = formatMessage({ id: "agentContextView.unknown" });
  const redactions = (Object.entries(context.redactions) as Array<[DiagnosticRedactionKind, number | undefined]>)
    .filter((entry): entry is [DiagnosticRedactionKind, number] => (entry[1] ?? 0) > 0);
  const redacted = sum(redactions.map(([, count]) => count));
  const tokens = context.tokens.total === null
    ? unknown
    : context.tokens.cacheRead === null
      ? formatNumber(context.tokens.total)
      : formatMessage({ id: "agentContextView.tokensValue" }, { total: formatNumber(context.tokens.total), cached: formatNumber(context.tokens.cacheRead) });
  const source = context.source.version
    ? formatMessage({ id: "agentContextView.sourceVersion" }, { format: context.source.format, version: context.source.version })
    : context.source.format;
  const readFrom = computerName ? formatMessage({ id: "agentContextView.readFromValue" }, { computer: computerName, source }) : source;
  const charsLabel = (count: number) => formatMessage({ id: "agentContextView.chars" }, { count });
  const sectionMeta = (count: string, characters: number) => formatMessage({ id: "agentContextView.sectionMeta" }, { count, chars: charsLabel(characters) });

  return (
    <div className="min-w-0" data-testid="agent-context-view-content">
      <PanelSection className="border-t-0">
        <DescriptionList direction="horizontal" data-testid="agent-context-view-facts">
          <DescriptionItem>
            <DescriptionTerm>{formatMessage({ id: "agentContextView.fact.runtime" })}</DescriptionTerm>
            <DescriptionDetails className="min-w-0 font-mono [overflow-wrap:anywhere]">{getRuntimeDisplayName(context.runtime)}</DescriptionDetails>
          </DescriptionItem>
          <DescriptionItem>
            <DescriptionTerm>{formatMessage({ id: "agentContextView.fact.model" })}</DescriptionTerm>
            <DescriptionDetails className="min-w-0 font-mono [overflow-wrap:anywhere]">{context.model ?? unknown}</DescriptionDetails>
          </DescriptionItem>
          <DescriptionItem>
            <DescriptionTerm>{formatMessage({ id: "agentContextView.fact.tokens" })}</DescriptionTerm>
            <DescriptionDetails className="min-w-0 font-mono [overflow-wrap:anywhere]">{tokens}</DescriptionDetails>
          </DescriptionItem>
          <DescriptionItem>
            <DescriptionTerm>{formatMessage({ id: "agentContextView.fact.requestAt" })}</DescriptionTerm>
            <DescriptionDetails className="min-w-0 font-mono [overflow-wrap:anywhere]">{context.requestAt ? formatMediumDateTime(context.requestAt) : unknown}</DescriptionDetails>
          </DescriptionItem>
          <DescriptionItem>
            <DescriptionTerm>{formatMessage({ id: "agentContextView.fact.readFrom" })}</DescriptionTerm>
            <DescriptionDetails className="min-w-0 font-mono [overflow-wrap:anywhere]">{readFrom}</DescriptionDetails>
          </DescriptionItem>
          {retainedSince ? (
            <DescriptionItem>
              <DescriptionTerm>{formatMessage({ id: "agentContextView.fact.keptSince" })}</DescriptionTerm>
              <DescriptionDetails className="min-w-0 font-mono [overflow-wrap:anywhere]">{formatCompactDate(retainedSince)}</DescriptionDetails>
            </DescriptionItem>
          ) : null}
          <DescriptionItem>
            <DescriptionTerm>{formatMessage({ id: "agentContextView.fact.contents" })}</DescriptionTerm>
            <DescriptionDetails className="grid min-w-0 justify-items-start gap-1.5 [overflow-wrap:anywhere]">
              <span>{formatMessage({ id: "agentContextView.contentsValue" }, { messages: context.messages.length, blocks: context.system.length, tools: context.tools.length })}</span>
              {context.compaction.happened ? <Badge appearance="soft" variant="information" data-testid="agent-context-view-compacted">{formatMessage({ id: "agentContextView.compacted" })}</Badge> : null}
              {redacted > 0 ? (
                <Badge appearance="soft" variant="muted" data-testid="agent-context-view-redacted">
                  {formatMessage({ id: "agentContextView.redacted" }, {
                    count: redacted,
                    kinds: formatList(redactions.map(([kind, count]) => formatMessage({ id: "agentContextView.redactionItem" }, { count, kind: formatMessage({ id: REDACTION_COPY[kind] }) }))),
                  })}
                </Badge>
              ) : null}
            </DescriptionDetails>
          </DescriptionItem>
        </DescriptionList>
      </PanelSection>
      <Section
        title={formatMessage({ id: "agentContextView.section.system" })}
        meta={sectionMeta(formatMessage({ id: "agentContextView.blocks" }, { count: context.system.length }), chars.system)}
        testId="agent-context-view-system"
      >
        <div className="grid grid-cols-1 gap-3 px-(--column-margin)">
          {context.system.map((block, index) => (
            <div key={index} className="flex min-w-0 flex-col gap-1 border-s-2 border-line-seam ps-3" data-testid="agent-context-view-system-block">
              <p className="font-mono text-mono-meta text-foreground-hint">{formatMessage({ id: "agentContextView.systemBlock" }, { index })}</p>
              <FoldedText text={block.text} markdown />
            </div>
          ))}
        </div>
      </Section>
      <Section
        title={formatMessage({ id: "agentContextView.section.tools" })}
        meta={sectionMeta(formatNumber(context.tools.length), chars.tools)}
        testId="agent-context-view-tools"
      >
        <ul className="grid grid-cols-1 gap-2 px-(--column-margin)">
          {context.tools.map((tool, index) => <ToolRow key={`${tool.name}:${index}`} tool={tool} />)}
        </ul>
      </Section>
      <Section
        title={formatMessage({ id: "agentContextView.section.messages" })}
        meta={sectionMeta(formatNumber(context.messages.length), chars.messages)}
        defaultOpen
        testId="agent-context-view-messages"
      >
        <AgentContextViewMessageList context={context} agentName={agentName} agentAvatarUrl={agentAvatarUrl} sent={sent} />
      </Section>
    </div>
  );
});
