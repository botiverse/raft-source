// Copy surfaces shared by the create dialog and the agent page's "How it connects"
// (#wg-external-agent-ux:#2): a value with its copy button at the field's end, and a
// longer block (a prompt, code) with its own copy button under it.
import { useCallback, useState } from "react";
import { useIntl } from "react-intl";
import { Check, Copy } from "lucide-react";
import { Button, TextLink } from "@botiverse/raft-ui";
import { copyTextToClipboard } from "../../utils/selectMarkdown";

/** A value to copy, with its copy button at the field's end (raft-design button.md, "Beside a field"). */
export function CopyField({ text, testId }: { text: string; testId: string }) {
  const { formatMessage } = useIntl();
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(async () => {
    try {
      await copyTextToClipboard(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }, [text]);
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

export function CopyBlock({ text, label, testId, primary = false, collapsed = false }: { text: string; label: string; testId: string; primary?: boolean; collapsed?: boolean }) {
  const { formatMessage } = useIntl();
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(!collapsed);
  const handleCopy = useCallback(async () => {
    try {
      await copyTextToClipboard(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }, [text]);
  const handleCopyClick = useCallback(() => void handleCopy(), [handleCopy]);
  const handleToggle = useCallback(() => setOpen((v) => !v), []);
  return (
    <div className="min-w-0 stack-y-2">
      <pre
        className={`min-w-0 whitespace-pre-wrap break-all rounded-control border border-line bg-layer-sunken px-3 py-2 font-mono text-footnote text-foreground ${open ? "" : "max-h-24 overflow-hidden"}`}
        data-testid={testId}
      >
        {text}
      </pre>
      {collapsed ? (
        <div>
          <TextLink className="text-callout" render={<button type="button" onClick={handleToggle} />} data-testid={`${testId}-toggle`}>
            {formatMessage({ id: open ? "agent.createExternal.hidePrompt" : "agent.createExternal.showPrompt" })}
          </TextLink>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button size="md" variant={primary ? "primary" : "outline"} type="button" onClick={handleCopyClick} data-testid={`${testId}-copy`}>
          <Copy aria-hidden="true" />
          {copied ? formatMessage({ id: "agent.createExternal.copied" }) : label}
        </Button>
      </div>
    </div>
  );
}
