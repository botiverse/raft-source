import { useCallback } from "react";
import { useIntl } from "react-intl";
import { Check, Copy } from "lucide-react";
import { Button } from "@botiverse/raft-ui";
import Tooltip from "../ui/Tooltip";

/** One recovery command (onboarding's offline Computer) with its copy button. */
export function RecoveryCommandRow({
  command,
  testId,
  copied,
  onCopy,
}: {
  command: string;
  testId: string;
  copied: string | null;
  onCopy: (command: string) => void;
}) {
  const { formatMessage } = useIntl();
  const handleCopy = useCallback(() => onCopy(command), [command, onCopy]);
  return (
    <div className="flex items-center gap-2">
      <code
        className="min-h-10 min-w-0 flex-1 rounded-control border border-line-hairline bg-layer-code px-3 py-2.5 font-mono text-mono-code text-foreground break-all"
        data-testid={testId}
      >
        {command}
      </code>
      <Tooltip content={formatMessage({ id: "onboarding.computerRuntime.copyCommand" }, { command })}>
        <Button
          type="button"
          onClick={handleCopy}
          size="icon-md"
          variant="outline"
          className="shrink-0"
          aria-label={formatMessage({ id: "onboarding.computerRuntime.copyCommand" }, { command })}
        >
          {copied === command ? <Check size={14} /> : <Copy size={14} />}
        </Button>
      </Tooltip>
    </div>
  );
}
