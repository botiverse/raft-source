import { useIntl } from "react-intl";
import type { AgentContextViewSourceKind } from "@botiverse/raft-shared";
import { Badge, Popover, PopoverContent, PopoverDescription, PopoverTrigger } from "@botiverse/raft-ui";

/**
 * The header's Verified tag (the caller puts it in `PanelStatus`, DS Panel:
 * a tag on the name), for a context the daemon rebuilt from the agent's own
 * session and checked against what the model received (`verification:
 * "verified"`). `count_matched` is the body's note instead; absent, nothing.
 * Its sentence is a popover, not a tooltip (as the runtime chips'): hover
 * opens it with a mouse, and a press or tap opens it anywhere, so touch and
 * screen readers reach it too. What was checked depends on the source: a
 * `native` restore against the runtime's own session, a `captured` one (Pi,
 * Built-in) against what Raft recorded when the request was sent.
 */
export function AgentContextViewVerifiedMark({ source }: { source: AgentContextViewSourceKind }) {
  const { formatMessage } = useIntl();
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={200}
        data-testid="agent-context-view-verified"
        render={<Badge render={<button type="button" />} appearance="soft" variant="success" className="inline-flex shrink-0 items-center outline-none focus-visible:shadow-focus" />}
      >
        {formatMessage({ id: "agentContextView.verified" })}
      </PopoverTrigger>
      <PopoverContent className="w-[280px] max-w-[calc(100vw-16px)] p-4" data-testid="agent-context-view-verified-card">
        <PopoverDescription>{formatMessage({ id: source === "captured" ? "agentContextView.verified.tooltip.captured" : "agentContextView.verified.tooltip" })}</PopoverDescription>
      </PopoverContent>
    </Popover>
  );
}
