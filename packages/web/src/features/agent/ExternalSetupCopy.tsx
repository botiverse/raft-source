// Copy surfaces shared by the create dialog and the agent page's "How it connects"
// (#wg-external-agent-ux:#2): a value with its copy button at the field's end, and a
// longer block (a prompt, code) with its own copy button under it.
import { useCallback, useId, useState } from "react";
import { useIntl } from "react-intl";
import { Check, Copy } from "lucide-react";
import { Button, TextLink } from "@botiverse/raft-ui";
import { copyTextToClipboard } from "../../utils/selectMarkdown";

/** A value to copy, with its copy button at the field's end (raft-design button.md, "Beside a field"). */
/** `onCopied`: called once the text is on the clipboard (the callers' analytics; never given the text). */
export function CopyField({ text, testId, onCopied }: { text: string; testId: string; onCopied?: () => void }) {
  const { formatMessage } = useIntl();
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(async () => {
    try {
      await copyTextToClipboard(text);
      setCopied(true);
      onCopied?.();
    } catch {
      setCopied(false);
    }
  }, [onCopied, text]);
  const handleCopyClick = useCallback(() => void handleCopy(), [handleCopy]);
  return (
    <div className="flex min-w-0 items-start gap-2">
      <pre className="min-h-11 min-w-0 flex-1 whitespace-pre-wrap break-all rounded-control border border-line bg-layer-sunken px-3 py-2 md:pointer-fine:min-h-[34px] md:pointer-fine:py-1.5 font-mono text-footnote text-foreground" data-testid={testId}>
        {text}
      </pre>
      <Button size="icon-lg" variant="outline" type="button" className="shrink-0" onClick={handleCopyClick} aria-label={formatMessage({ id: "agent.createExternal.copy" })} data-testid={`${testId}-copy`}>
        {copied ? <Check size={20} aria-hidden="true" /> : <Copy size={20} aria-hidden="true" />}
      </Button>
    </div>
  );
}

export function CopyBlock({ text, label, testId, primary = false, collapsed = false, onCopied }: { text: string; label: string; testId: string; primary?: boolean; collapsed?: boolean; onCopied?: () => void }) {
  const { formatMessage } = useIntl();
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(!collapsed);
  const textId = useId();
  const handleCopy = useCallback(async () => {
    try {
      await copyTextToClipboard(text);
      setCopied(true);
      onCopied?.();
    } catch {
      setCopied(false);
    }
  }, [onCopied, text]);
  const handleCopyClick = useCallback(() => void handleCopy(), [handleCopy]);
  const handleToggle = useCallback(() => setOpen((v) => !v), []);
  return (
    <div className="min-w-0 stack-y-2">
      {/* The frame holds the prompt and its toggle, so the toggle reads as part of the prompt. */}
      <div className={`min-w-0 rounded-control border border-line bg-layer-sunken px-3 pt-2 ${collapsed && open ? "pb-3" : "pb-2"}`}>
        {/* Folded, the frame is as tall as the box was before the toggle moved into it (96px: cindyz, 2026-11-14), so
            the text gives up the toggle's line; its last line fades with a mask on the clipped box (raft-design
            spacing.md, "Edges fade"). */}
        <pre
          id={textId}
          className={`min-w-0 whitespace-pre-wrap break-all font-mono text-footnote text-foreground ${open ? "" : "max-h-14 overflow-clip mask-fade-b-edge"}`}
          data-testid={testId}
        >
          {text}
        </pre>
        {collapsed ? (
          <div className={`flex ${open ? "mt-3" : ""}`}>
            {/* To touch, 44px: the ::after reaches above the line and, below it, to the frame's edge and no further, so
                it stays clear of the Copy button's own hit area: 12px each way open, 14px above and 8px below folded.
                The line is 22px at every width (text-callout's own line is 20px by touch), so folded it is 14 + 22 + 8
                and the frame stays 96px. */}
            <TextLink
              className={`relative text-callout leading-[22px] after:absolute after:inset-x-0 ${open ? "after:-inset-y-3" : "after:-top-3.5 after:-bottom-2"}`}
              render={<button type="button" onClick={handleToggle} aria-expanded={open} aria-controls={textId} />}
              data-testid={`${testId}-toggle`}
            >
              {formatMessage({ id: open ? "agent.createExternal.hidePrompt" : "agent.createExternal.showPrompt" })}
            </TextLink>
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button size="md" variant={primary ? "primary" : "outline"} type="button" onClick={handleCopyClick} data-testid={`${testId}-copy`}>
          <Copy aria-hidden="true" />
          {copied ? formatMessage({ id: "agent.createExternal.copied" }) : label}
        </Button>
      </div>
    </div>
  );
}
